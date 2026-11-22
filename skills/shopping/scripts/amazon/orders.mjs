import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isOrdersPath, isAuthPath, authentication } from './navigation.mjs';
import { typeSearchQuery, pause } from './motion.mjs';

const origin = 'https://www.amazon.co.jp';
const inputSelector = '#searchOrdersInput, input[name="search"][type="search"], input[name="search"][type="text"]';
const nextSelector = '.a-pagination li.a-last:not(.a-disabled) a[href], a.s-pagination-next:not(.s-pagination-disabled)[href]';

// Only search context is persisted; no authentication URLs, order IDs or tokens.
export function ordersLocation(value) {
  const url = new URL(value);
  if (url.origin !== origin || !isOrdersPath(url.pathname)) throw new Error('購入履歴ページではありません');
  const startIndex = Number(url.searchParams.get('startIndex') ?? 0);
  const page = Number(url.searchParams.get('page') ?? 1);
  if (!Number.isSafeInteger(startIndex) || startIndex < 0 || !Number.isSafeInteger(page) || page < 1) throw new Error('履歴のページ番号を取得できません');
  return { query: url.searchParams.get('search') ?? '', filter: url.searchParams.get('orderFilter') ?? '', startIndex, page };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code, message) => Object.assign(new Error(message), { code });
async function noAuth(page) {
  const auth = await authentication(page);
  if (auth) throw fail(auth === 'login_required' ? 'LOGIN_REQUIRED' : 'VERIFICATION_REQUIRED', 'Amazonの認証を同じタブで済ませ、orders-resumeで再開してください');
}

export async function readOrders(page, { offset = 0, limit = 10 } = {}) {
  await noAuth(page);
  const location = ordersLocation(page.url());
  const input = page.locator(inputSelector).filter({ visible: true });
  await input.first().waitFor({ state: 'visible', timeout: 20_000 });
  if (await input.count() !== 1) throw fail('ORDERS_LAYOUT_UNKNOWN', '履歴検索欄を一意に取得できません。AIで同じタブの画面を確認してください');
  const data = await page.evaluate(() => {
    const text = e => e?.textContent?.replace(/\s+/g, ' ').trim() || '';
    const containers = [...document.querySelectorAll('.order-card, .js-order-card, .order, [data-component="orderCard"], .hzsearch-content-container > .a-section.a-spacing-none.a-padding-small > .a-section.a-spacing-large.a-spacing-top-large')];
    const cards = containers.filter(e => !containers.some(parent => parent !== e && parent.contains(e)));
    const products = [];
    for (const [orderIndex, card] of cards.entries()) {
      const found = new Map();
      for (const link of card.querySelectorAll('a[href]')) {
        const url = new URL(link.href, location.href);
        const asin = url.origin === location.origin && url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase();
        if (!asin) continue;
        const title = text(link) || link.querySelector('img')?.alt || '';
        if (/再度購入|再び購入|Buy it again/i.test(title)) continue;
        const prior = found.get(asin);
        if (!prior || title.length > prior.title.length) found.set(asin, { orderIndex: orderIndex + 1, asin, title: title.slice(0, 400), url: `https://www.amazon.co.jp/dp/${asin}` });
      }
      products.push(...found.values());
    }
    const body = document.body.innerText;
    const empty = /一致する注文はありません|該当する注文はありません|注文が見つかりません|注文はありません|注文していません|見つかりませんでした|no orders|did not match any orders/i.test(body);
    const heading = text([...document.querySelectorAll('h1')].find(e => e.getClientRects().length && /注文履歴|検索結果|Your Orders|Search Results/i.test(text(e))));
    return { orderCount: cards.length, products, empty, heading };
  });
  if (!data.products.length && !data.empty) throw fail('ORDERS_LAYOUT_UNKNOWN', '履歴商品も0件の表示も確認できません。0件と推測せず画面を確認してください');
  const next = page.locator(nextSelector).filter({ visible: true });
  if (await next.count() > 1) throw new Error('履歴の次ページリンクが複数あります');
  return { ...location, heading: data.heading, orderCount: data.orderCount, productCount: data.products.length,
    products: data.products.slice(offset, offset + limit), offset, limit,
    nextOffset: offset + limit < data.products.length ? offset + limit : null,
    hasNextPage: await next.count() === 1, empty: data.products.length === 0 };
}

async function searchControls(page, query) {
  const input = page.locator(inputSelector).filter({ visible: true });
  await input.first().waitFor({ state: 'visible', timeout: 20_000 });
  if (await input.count() !== 1) throw fail('ORDERS_LAYOUT_UNKNOWN', '履歴検索欄を一意に取得できません');
  const form = input.locator('xpath=ancestor::form');
  if (await form.count() !== 1) throw new Error('履歴検索フォームがありません');
  const submit = form.locator('input[type="submit"], button[type="submit"], button:not([type])').filter({ visible: true });
  if (await submit.count() !== 1) throw new Error('履歴検索ボタンを一意に取得できません');
  const destination = await submit.evaluate((button, query) => {
    const form = button.form;
    const input = form.querySelector('#searchOrdersInput, input[name="search"]');
    const url = new URL(button.getAttribute('formaction') || form.action, location.href);
    const params = new FormData(form, button);
    if (input?.name !== 'search') throw new Error('未対応の履歴検索フィールドです');
    params.set('search', query);
    url.search = new URLSearchParams(params).toString();
    return { url: url.href, method: (button.getAttribute('formmethod') || form.method).toUpperCase(), target: button.getAttribute('formtarget') || form.target };
  }, query);
  if (destination.method !== 'GET' || destination.target && destination.target !== '_self') throw new Error('履歴検索は同じタブのGETフォームのみ対応します');
  const target = ordersLocation(destination.url);
  if (target.query !== query || target.startIndex !== 0 || target.page !== 1) throw new Error('履歴検索条件が一致しません');
  return { input, submit, target };
}

export async function runOrders({ page, mouse, log, config, progressPath }) {
  let progress = null;
  try { progress = JSON.parse(await readFile(progressPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const save = async patch => {
    progress = { ...progress, ...patch, updatedAt: new Date().toISOString() };
    const temp = `${progressPath}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(progress, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temp, progressPath);
  };
  const describe = () => ({ ...progress, resumeCommand: 'npm run chrome -- orders-resume' });
  const complete = async extra => {
    const result = await readOrders(page, config);
    await save({ status: 'complete', target: ordersLocation(page.url()), lastResult: { query: result.query, startIndex: result.startIndex, page: result.page, productCount: result.productCount } });
    return { ...result, ...extra, progress: describe() };
  };
  let action = config.command;
  try {
    if (action === 'orders-resume') {
      if (!progress) throw fail('NO_ORDERS_PROGRESS', '履歴の保存状態がありません。認証後にorders-resultsで現在のページを確認してください');
      await noAuth(page);
      if (isOrdersPath(new URL(page.url()).pathname)) {
        const current = ordersLocation(page.url());
        if (progress.target && same(current, progress.target)) return await complete({ resumed: true, navigationRepeated: false });
        if (progress.status === 'complete' || progress.source && !same(current, progress.source)) throw fail('ORDERS_RESUME_MISMATCH', '保存した検索・ページと現在のタブが一致しません。orders-resultsで確認してください');
      } else if (progress.action !== 'orders') throw fail('ORDERS_RESUME_MISMATCH', '認証後のタブが履歴ページではありません');
      action = progress.action;
    } else if (action !== 'orders-results') {
      if (progress && progress.status !== 'complete') throw fail('ORDERS_PENDING', '未完了の履歴操作があります。先にorders-resumeで確認してください');
      progress = { version: 1, action, query: action === 'orders-search' ? config.query : null, status: 'pending', source: null, target: null };
      // Save intent even when authentication is already displayed.
      await save({});
    }
    await noAuth(page);
    if (action === 'orders-results') {
      const result = await readOrders(page, config);
      return { ...result, progress: progress ? describe() : null };
    }
    if (action === 'orders') {
      if (isOrdersPath(new URL(page.url()).pathname)) return await complete({ navigationRepeated: false });
      if (page.url() === 'about:blank') {
        await pause(log, 'before opening Amazon home', 1500, 3000);
        await noAuth(page);
        await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      }
      await noAuth(page);
      const link = page.locator('#nav-orders');
      if (await link.count() !== 1) throw new Error('購入履歴リンクがありません');
      const target = ordersLocation(new URL(await link.getAttribute('href'), page.url()).href);
      await save({ target });
      await mouse.click(link, 'order history link', { beforeMouseDown: async () => {
        await noAuth(page);
        if (!same(ordersLocation(new URL(await link.getAttribute('href'), page.url()).href), target)) throw new Error('履歴リンクが変化しました');
      } });
    } else {
      const source = ordersLocation(page.url());
      if (action === 'orders-search') {
        const controls = await searchControls(page, progress.query);
        if (same(source, controls.target)) return await complete({ navigationRepeated: false });
        await save({ source, target: controls.target });
        await mouse.click(controls.input, 'order search input');
        await typeSearchQuery(page, controls.input, progress.query, log);
        await mouse.click(controls.submit, 'order search button', { beforeMouseDown: async () => {
          await noAuth(page);
          const latest = await searchControls(page, progress.query);
          if (!same(latest.target, progress.target) || await latest.input.inputValue() !== progress.query) throw new Error('履歴検索条件が変化しました');
        } });
      } else if (action === 'orders-next') {
        const current = await readOrders(page, config);
        if (!current.hasNextPage) return await complete({ pageChanged: false });
        const link = page.locator(nextSelector).filter({ visible: true });
        const href = await link.getAttribute('href');
        const target = ordersLocation(new URL(href, page.url()).href);
        if (target.query !== source.query || target.filter !== source.filter ||
          !(target.startIndex > source.startIndex && target.page === source.page || target.page === source.page + 1 && target.startIndex === source.startIndex)) throw new Error('次ページの検索条件・ページ番号が不正です');
        await save({ source, target });
        await mouse.click(link, 'next order history page', { beforeMouseDown: async () => {
          await noAuth(page);
          if (await link.getAttribute('href') !== href) throw new Error('履歴の次ページリンクが変化しました');
        } });
      } else throw new Error('未対応の履歴操作です');
    }
    await page.waitForURL(url => isAuthPath(url.pathname) || isOrdersPath(url.pathname) && same(ordersLocation(url.href), progress.target), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await noAuth(page);
    return await complete({ pageChanged: action === 'orders-next' });
  } catch (error) {
    if (progress && config.command !== 'orders-results' && !['ORDERS_PENDING', 'ORDERS_RESUME_MISMATCH'].includes(error.code)) {
      await save({ status: ['LOGIN_REQUIRED', 'VERIFICATION_REQUIRED'].includes(error.code) ? 'authentication_required' : 'interrupted' });
    }
    error.ordersProgress = progress ? describe() : null;
    throw error;
  }
}
