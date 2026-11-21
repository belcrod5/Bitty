import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { pause, RandomMouse } from './motion.mjs';
import { allowNavigation, forbiddenPath, isSearchPath, searchTerm, productAsin, isOrdersPath, isAuthPath } from './navigation.mjs';

const help = `Amazon閲覧専用コマンド（購入操作なし）
  npm start -- "検索語" [--keep-open] [--profile]
  npm run detail -- "検索語" [--index 1] [--keep-open]
  npm run detail -- --asin B012345678 [--keep-open]
  npm run orders -- --keep-open   専用ブラウザのログイン状態で注文履歴を開く
  --headless                     画面を表示せず実行
  --profile                      専用ブラウザのログイン状態を使う
要素が見つからない場合はエラーで停止します。`;

function options() {
  const args = process.argv.slice(2);
  const command = ['search', 'detail', 'orders'].includes(args[0]) ? args.shift() : 'search';
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'keep-open': { type: 'boolean' }, headless: { type: 'boolean' }, profile: { type: 'boolean' },
    asin: { type: 'string' }, index: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) return { help: true };
  if (command === 'orders' && positionals.length) throw new Error(`${command} は検索語を受け取りません`);
  if (values.asin && (command !== 'detail' || !/^[A-Z0-9]{10}$/i.test(values.asin))) throw new Error('--asin はdetail専用の10桁の英数字です');
  if (values.asin && (positionals.length || values.index)) throw new Error('--asin と検索語・--indexは同時指定できません');
  const index = values.index === undefined ? 1 : Number(values.index);
  if (values.index !== undefined && (command !== 'detail' || !/^\d+$/.test(values.index) || !Number.isSafeInteger(index) || index < 1)) throw new Error('--index はdetail専用の1以上の整数です');
  return { command, query: positionals.join(' ').trim() || 'ボールペン', index, asin: values.asin?.toUpperCase(),
    keepOpen: !!values['keep-open'], headless: !!values.headless, persistent: !!values.profile || command === 'orders' };
}

async function main(config) {
  const { command, query, asin, index, keepOpen, headless, persistent } = config;
  const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const artifacts = fileURLToPath(new URL(`./artifacts/${runId}/`, import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const events = [];
  const log = (event, detail = {}) => {
    const entry = { time: new Date().toISOString(), event, ...detail };
    events.push(entry);
    console.log(JSON.stringify(entry));
  };
  let browser, context, page;
  let summary = { success: false, command, artifacts };
  const save = async () => {
    await writeFile(`${artifacts}/events.json`, JSON.stringify(events, null, 2));
    await writeFile(`${artifacts}/result.json`, JSON.stringify(summary, null, 2));
  };

  try {
    const contextOptions = { viewport: { width: 1440, height: 1000 }, locale: 'ja-JP', serviceWorkers: 'block', acceptDownloads: false };
    if (persistent) {
      // Dedicated profile only; never use the user's everyday Chrome profile.
      const profile = fileURLToPath(new URL('./.browser-profile/', import.meta.url));
      await mkdir(profile, { recursive: true, mode: 0o700 });
      context = await chromium.launchPersistentContext(profile, { ...contextOptions, channel: 'chrome', headless });
    } else {
      browser = await chromium.launch({ channel: 'chrome', headless });
      context = await browser.newContext(contextOptions);
    }
    context.setDefaultTimeout(20_000);
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (forbiddenPath(url.pathname)) {
        log('blocked-request', { method: request.method(), path: url.pathname });
        return route.abort('blockedbyclient');
      }
      if (request.isNavigationRequest() && request.frame().parentFrame() === null && !allowNavigation(url, request.method(), command)) {
        // Authentication URLs may contain session tokens; only log the path.
        log('blocked-navigation', { method: request.method(), path: url.pathname });
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    page = context.pages()[0] ?? await context.newPage();
    const mouse = new RandomMouse(page, log);
    log('started', { command, headless, persistent });

    async function search() {
      await page.goto('https://www.amazon.co.jp/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const input = page.locator('#twotabsearchtextbox');
      const submit = page.locator('#nav-search-submit-button');
      await input.waitFor({ state: 'visible' });
      await submit.waitFor({ state: 'visible' });
      await page.screenshot({ path: `${artifacts}/01-home.png` });
      await mouse.click(input, 'search input');
      if (!await input.evaluate(element => document.activeElement === element)) throw new Error('Search input did not receive focus');
      log('focused-search-input');
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      for (const { segment: character } of new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(query)) {
        await pause(log, 'before character');
        if (!await input.evaluate(element => document.activeElement === element)) throw new Error('Search input lost focus');
        await page.keyboard.type(character);
        log('typed-character', { character });
      }
      if (await input.inputValue() !== query) throw new Error('Search input does not match requested query');
      await page.screenshot({ path: `${artifacts}/02-entered-query.png` });
      await mouse.click(submit, 'search button');
      await page.waitForURL(url => url.hostname === 'www.amazon.co.jp' && isSearchPath(url.pathname) && searchTerm(url) === query, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const products = page.locator('[data-component-type="s-search-result"][data-asin]:not([data-asin=""])');
      await products.first().waitFor({ state: 'visible', timeout: 30_000 });
      await page.screenshot({ path: `${artifacts}/03-search-results.png` });
      return products;
    }

    if (command === 'search') {
      const products = await search();
      const titles = await products.locator('h2').allTextContents();
      summary = { ...summary, query, productCount: await products.count(), firstProductTitles: titles.slice(0, 5).map(t => t.trim()) };
    } else if (command === 'detail') {
      let expectedAsin = asin;
      if (asin) {
        await page.goto(`https://www.amazon.co.jp/dp/${asin}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      } else {
        const products = await search();
        const count = await products.count();
        if (index > count) throw new Error(`商品番号 ${index} は表示件数 ${count} を超えています`);
        const product = products.nth(index - 1);
        expectedAsin = await product.getAttribute('data-asin');
        if (!/^[A-Z0-9]{10}$/i.test(expectedAsin ?? '')) throw new Error('選択した商品のASINを取得できません');
        const link = product.locator(`a[href*="/dp/${expectedAsin}"], a[href*="%2Fdp%2F${expectedAsin}"]`).first();
        await link.waitFor({ state: 'visible' });
        const href = await link.getAttribute('href');
        const destination = new URL(href, page.url());
        if (!allowNavigation(destination, 'GET', 'detail')) throw new Error('商品リンクが許可されたAmazonの商品詳細URLではありません');
        // Keep navigation in this tab so the same checks apply.
        await link.evaluate(element => element.removeAttribute('target'));
        await mouse.click(link, 'product detail link');
        await page.waitForURL(url => productAsin(url.pathname) === expectedAsin.toUpperCase(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      }
      const productTitle = page.locator('#productTitle:visible');
      await productTitle.waitFor({ state: 'visible', timeout: 30_000 });
      if (productAsin(new URL(page.url()).pathname) !== expectedAsin.toUpperCase()) throw new Error('商品詳細のASINが一致しません');
      summary = { ...summary, asin: expectedAsin, productTitle: (await productTitle.innerText()).trim(), ...(asin ? {} : { query, index }) };
      await page.screenshot({ path: `${artifacts}/04-product-detail.png` });
    } else {
      await page.goto('https://www.amazon.co.jp/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const ordersLink = page.locator('#nav-orders');
      await ordersLink.waitFor({ state: 'visible' });
      await mouse.click(ordersLink, 'order history link');
      await page.waitForURL(url => isOrdersPath(url.pathname) || isAuthPath(url.pathname), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (isAuthPath(new URL(page.url()).pathname)) {
        const error = new Error('LOGIN_REQUIRED: Amazonが認証画面を表示したため、注文履歴を開けませんでした');
        error.code = 'LOGIN_REQUIRED';
        throw error;
      }
      await page.getByRole('heading', { name: '注文履歴', exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
      await page.screenshot({ path: `${artifacts}/04-order-history.png` });
      summary = { ...summary, authenticated: true };
    }
    summary = { ...summary, success: true, url: page.url(), title: await page.title() };
    log(`${command}-completed`, summary);
    // Save immediately, including when --keep-open leaves the browser running.
    await save();
    if (keepOpen) {
      log('waiting-for-browser-close', { instruction: 'Close the browser window to finish.' });
      await new Promise(resolve => context.once('close', resolve));
    }
  } catch (error) {
    summary.error = error.message;
    summary.code = error.code ?? 'ERROR';
    log('failed', { error: error.message, code: summary.code });
    if (page && !page.isClosed()) {
      const url = new URL(page.url());
      // Never save login-form HTML, screenshots, or authentication query strings.
      if (isAuthPath(url.pathname)) {
        summary.url = `${url.origin}${url.pathname}`;
      } else {
        summary.url = page.url();
        summary.title = await page.title().catch(() => '');
        await page.screenshot({ path: `${artifacts}/error.png` }).catch(() => {});
        await writeFile(`${artifacts}/error.html`, await page.content().catch(() => ''), 'utf8');
      }
    }
    process.exitCode = error.code === 'LOGIN_REQUIRED' ? 2 : 1;
  } finally {
    await save();
    await context?.close();
    await browser?.close();
    console.log(`Artifacts: ${artifacts}`);
  }
}

try {
  const config = options();
  if (config.help) console.log(help);
  else await main(config);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
