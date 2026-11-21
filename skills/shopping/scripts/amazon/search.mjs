import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { discoverBrowsers, chooseBrowser } from './browser.mjs';
import { openOperation, readOperation, listOperations, runCartAddition, openCart } from './cart.mjs';
import { pause, RandomMouse } from './motion.mjs';
import { allowNavigation, createRouteHandler, isSearchPath, searchTerm, productAsin, isOrdersPath, isAuthPath, authentication, safeValue, safeURL } from './navigation.mjs';

const help = `Amazon検索・カート操作コマンド（注文確定・購入操作なし）
  npm start -- "検索語" [--keep-open] [--profile]
  npm run detail -- "検索語" [--index 1] [--keep-open]
  npm run detail -- --asin B012345678 [--keep-open]
  npm run orders -- --keep-open   専用ブラウザのログイン状態で注文履歴を開く
  npm run cart                   カート表示／認証状態の確認（追加なし）
  npm run cart-add -- --asin B012345678 --operation request-001
                                 数量1を1回だけ追加し、結果を保存してカートへ移動
  npm run cart-status -- --operation request-001
                                 保存された操作状態を表示（ブラウザ操作なし）
  npm run browser-status         起動中Chromeの接続可否・Amazonタブを自動診断
  --cdp chrome                   Chromeの接続許可を使って直接接続（初期設定が必要）
  --cdp auto                     検出した既存Chromeと対象タブを使用
  --cdp http://127.0.0.1:9222     明示した既存Chromeへ接続（未指定時は専用ブラウザ）
  --tab-url https://www.amazon.co.jp/dp/B012345678
                                 接続先で操作する既存タブを指定
  --headless                     画面を表示せず実行
  --profile                      専用ブラウザのログイン状態を使う
要素が見つからない場合はエラーで停止します。`;

export function options(input = process.argv.slice(2)) {
  const args = [...input];
  const command = ['search', 'detail', 'orders', 'cart', 'cart-add', 'cart-status', 'browser-status'].includes(args[0]) ? args.shift() : 'search';
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'keep-open': { type: 'boolean' }, headless: { type: 'boolean' }, profile: { type: 'boolean' },
    cdp: { type: 'string' }, 'tab-url': { type: 'string' }, operation: { type: 'string' },
    asin: { type: 'string' }, index: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) return { help: true };
  if (['orders', 'cart', 'cart-add', 'cart-status', 'browser-status'].includes(command) && positionals.length) throw new Error(`${command} は検索語を受け取りません`);
  if (values.asin !== undefined && (!['detail', 'cart-add'].includes(command) || !/^[A-Z0-9]{10}$/i.test(values.asin))) throw new Error('--asin はdetail・cart-add用の10桁の英数字です');
  if (values.asin && (positionals.length || values.index)) throw new Error('--asin と検索語・--indexは同時指定できません');
  const index = values.index === undefined ? 1 : Number(values.index);
  if (values.index !== undefined && (command !== 'detail' || !/^\d+$/.test(values.index) || !Number.isSafeInteger(index) || index < 1)) throw new Error('--index はdetail専用の1以上の整数です');
  if (command === 'cart-add' && !values.asin) throw new Error('cart-add は --asin が必要です');
  if (command === 'cart-add' || command === 'cart-status' && values.operation !== undefined) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(values.operation ?? '')) throw new Error('--operation が必要です（英数字・ハイフン・下線、1〜80文字）');
  } else if (values.operation !== undefined) throw new Error('--operation はcart-add・cart-status用です');
  if (values.cdp) {
    const endpoint = ['auto', 'chrome'].includes(values.cdp) ? null : new URL(values.cdp);
    if (endpoint && (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password)) throw new Error('--cdp はローカルChromeの接続先を指定してください');
    if (values.headless || values.profile || values['keep-open']) throw new Error('--cdp は --headless・--profile・--keep-open と併用できません。既存ブラウザは開いたままです');
  }
  if (values['tab-url']) {
    if (!values.cdp) throw new Error('--tab-url は --cdp と併用してください');
    const tab = new URL(values['tab-url']);
    if (tab.origin !== 'https://www.amazon.co.jp') throw new Error('--tab-url はAmazon.co.jpのタブを指定してください');
  }
  return { command, operationId: values.operation, cdp: values.cdp, tabURL: values['tab-url'], query: positionals.join(' ').trim() || 'ボールペン', index, asin: values.asin?.toUpperCase(),
    keepOpen: !!values['keep-open'], headless: !!values.headless, persistent: !!values.profile || ['orders', 'cart', 'cart-add'].includes(command) };
}

export async function main(config) {
  const { command, query, asin, index, keepOpen, headless, persistent, operationId } = config;
  let { cdp, tabURL } = config;
  if (command === 'browser-status' && cdp !== 'chrome') { console.log(JSON.stringify(safeValue(await discoverBrowsers()), null, 2)); return; }
  const operations = fileURLToPath(new URL('./.operations/', import.meta.url));
  if (command === 'cart-status') { console.log(JSON.stringify(safeValue(operationId ? await readOperation(operations, operationId) : await listOperations(operations)), null, 2)); return; }
  const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const artifacts = fileURLToPath(new URL(`./artifacts/${runId}/`, import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const events = [];
  const log = (event, detail = {}) => {
    const entry = safeValue({ time: new Date().toISOString(), event, ...detail });
    events.push(entry);
    console.log(JSON.stringify(entry));
  };
  let browser, context, page, operation, routeHandler;
  const attempt = { armed: false, consumed: false, action: null };
  const cartCommand = ['cart', 'cart-add'].includes(command);
  let summary = { success: false, command, artifacts };
  const save = async () => {
    await writeFile(`${artifacts}/events.json`, JSON.stringify(events, null, 2));
    await writeFile(`${artifacts}/result.json`, JSON.stringify(safeValue(summary), null, 2));
  };

  try {
    if (command === 'cart-add') operation = await openOperation(operations, operationId, asin);
    const contextOptions = { viewport: { width: 1440, height: 1000 }, locale: 'ja-JP', serviceWorkers: 'block', acceptDownloads: false };
    if (cdp === 'auto') {
      const report = await discoverBrowsers();
      const selected = chooseBrowser(report, { command, asin, tabURL });
      cdp = selected.endpoint;
      tabURL ??= selected.tabURL;
      log('browser-discovered', selected);
    }
    if (cdp) {
      browser = await chromium.connectOverCDP(cdp, { timeout: 20_000, noDefaults: true });
      const amazonPages = browser.contexts().flatMap(c => c.pages()).filter(p => { try { return new URL(p.url()).origin === 'https://www.amazon.co.jp'; } catch { return false; } });
      if (command === 'browser-status') {
        summary = { ...summary, success: true, browser: 'existing-chrome', tabs: await Promise.all(amazonPages.map(async p => ({ url: safeURL(p.url()), title: await p.title() }))) };
        log('browser-status', summary);
        return;
      }
      let candidates = tabURL ? amazonPages.filter(p => p.url() === tabURL) : amazonPages;
      if (tabURL && !candidates.length) candidates = amazonPages.filter(p => safeURL(p.url()) === safeURL(tabURL));
      if (!tabURL && candidates.length > 1 && command === 'cart-add' && operation.data.addition === 'not_started') candidates = candidates.filter(p => productAsin(new URL(p.url()).pathname) === asin);
      if (candidates.length !== 1) throw new Error('対象のAmazonタブを一意に選択できません。--tab-url で既存タブのURLを指定してください');
      page = candidates[0];
      context = page.context();
      if (await page.evaluate(() => !!navigator.serviceWorker?.controller)) throw new Error('Service Worker制御中のタブには安全な通信制限を適用できません');
    } else if (persistent) {
      // Dedicated profile only; never use the user's everyday Chrome profile.
      const profile = fileURLToPath(new URL('./.browser-profile/', import.meta.url));
      await mkdir(profile, { recursive: true, mode: 0o700 });
      context = await chromium.launchPersistentContext(profile, { ...contextOptions, channel: 'chrome', headless });
    } else {
      browser = await chromium.launch({ channel: 'chrome', headless });
      context = await browser.newContext(contextOptions);
    }
    page ??= context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(20_000);
    routeHandler = createRouteHandler(command, attempt, asin, log);
    await page.route('**/*', routeHandler);
    const mouse = new RandomMouse(page, log);
    log('started', { command, headless, persistent: !cdp && persistent, browser: cdp ? 'existing-chrome' : 'dedicated-browser' });
    const assertNoAuth = async () => {
      const auth = await authentication(page);
      if (auth) { const e = new Error('Amazonが認証画面を表示しました'); e.code = auth === 'login_required' ? 'LOGIN_REQUIRED' : 'VERIFICATION_REQUIRED'; throw e; }
    };
    const screenshot = async name => { await assertNoAuth(); await page.screenshot({ path: `${artifacts}/${name}` }); };

    async function search() {
      await page.goto('https://www.amazon.co.jp/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const input = page.locator('#twotabsearchtextbox');
      const submit = page.locator('#nav-search-submit-button');
      await assertNoAuth();
      await input.waitFor({ state: 'visible' });
      await submit.waitFor({ state: 'visible' });
      await screenshot('01-home.png');
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
      await screenshot('02-entered-query.png');
      await mouse.click(submit, 'search button');
      await page.waitForURL(url => isAuthPath(url.pathname) || url.hostname === 'www.amazon.co.jp' && isSearchPath(url.pathname) && searchTerm(url) === query, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await assertNoAuth();
      const products = page.locator('[data-component-type="s-search-result"][data-asin]:not([data-asin=""])');
      await products.first().waitFor({ state: 'visible', timeout: 30_000 });
      await screenshot('03-search-results.png');
      return products;
    }

    if (cartCommand) {
      if (!cdp) {
        const target = command === 'cart-add' && operation.data.addition === 'not_started' ? `https://www.amazon.co.jp/dp/${asin}` : 'https://www.amazon.co.jp/';
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      }
      if (command === 'cart-add') {
        const identity = cdp ? safeURL(cdp) : fileURLToPath(new URL('./.browser-profile/', import.meta.url));
        const data = await runCartAddition({ page, mouse, log, operation, attempt, identity });
        summary = { ...summary, ...data, success: data.addition === 'confirmed' && data.cart === 'visible' && data.targetPresent, url: safeURL(page.url()) };
      } else {
        const view = await openCart(page, mouse, log);
        summary = { ...summary, ...view, success: view.cart === 'visible', code: view.cart === 'visible' ? null : 'AUTH_REQUIRED', url: safeURL(page.url()) };
      }
      if (summary.cart === 'visible') await screenshot('04-cart.png');
      if (!summary.success) process.exitCode = summary.addition === 'unknown' ? 3 : ['login_required', 'verification_required'].includes(summary.cart) ? 2 : 1;
    } else if (command === 'search') {
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
        await page.waitForURL(url => isAuthPath(url.pathname) || productAsin(url.pathname) === expectedAsin.toUpperCase(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      }
      await assertNoAuth();
      const productTitle = page.locator('#productTitle:visible');
      await productTitle.waitFor({ state: 'visible', timeout: 30_000 });
      if (productAsin(new URL(page.url()).pathname) !== expectedAsin.toUpperCase()) throw new Error('商品詳細のASINが一致しません');
      summary = { ...summary, asin: expectedAsin, productTitle: (await productTitle.innerText()).trim(), ...(asin ? {} : { query, index }) };
      await screenshot('04-product-detail.png');
    } else {
      await page.goto('https://www.amazon.co.jp/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const ordersLink = page.locator('#nav-orders');
      await ordersLink.waitFor({ state: 'visible' });
      await mouse.click(ordersLink, 'order history link');
      await page.waitForURL(url => isOrdersPath(url.pathname) || isAuthPath(url.pathname), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await assertNoAuth();
      await page.getByRole('heading', { name: '注文履歴', exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
      await screenshot('04-order-history.png');
      summary = { ...summary, authenticated: true };
    }
    summary = { ...summary, success: cartCommand ? summary.success : true, url: safeURL(page.url()), title: await page.title() };
    log(`${command}-completed`, summary);
    // Save immediately, including when --keep-open leaves the browser running.
    await save();
    if (keepOpen) {
      log('waiting-for-browser-close', { instruction: 'Close the browser window to finish.' });
      await new Promise(resolve => context.once('close', resolve));
    }
  } catch (error) {
    attempt.armed = false;
    if (operation) {
      if (operation.data.addition === 'submitted') await operation.update({ addition: 'unknown', retryAdd: false, code: 'ADDITION_UNKNOWN' });
      summary = { ...summary, ...operation.data };
    }
    summary.success = false;
    summary.error = safeValue(error.message);
    summary.code = summary.addition === 'unknown' ? 'ADDITION_UNKNOWN' : error.code ?? summary.code ?? 'ERROR';
    log('failed', { error: summary.error, code: summary.code });
    if (page && !page.isClosed()) {
      const url = new URL(page.url());
      // Never save login-form HTML, screenshots, or authentication query strings.
      const auth = await authentication(page).catch(() => null);
      if (auth || isAuthPath(url.pathname)) {
        summary.authentication = auth;
        if (cartCommand && operation) {
          await operation.update({ cart: auth ?? 'verification_required' });
          summary.cart = operation.data.cart;
        }
        summary.url = `${url.origin}${url.pathname}`;
      } else {
        summary.url = safeURL(page.url());
        summary.title = await page.title().catch(() => '');
        await page.screenshot({ path: `${artifacts}/error.png` }).catch(() => {});
        if (!cartCommand) await writeFile(`${artifacts}/error.html`, await page.content().catch(() => ''), 'utf8');
      }
    }
    process.exitCode = summary.addition === 'unknown' ? 3 : ['LOGIN_REQUIRED', 'VERIFICATION_REQUIRED'].includes(error.code) ? 2 : 1;
  } finally {
    await save();
    if (page && routeHandler && !page.isClosed()) await page.unroute('**/*', routeHandler).catch(() => {});
    if (!cdp) await context?.close();
    // connectOverCDP.close disconnects this client; existing tabs/context are not closed.
    await browser?.close();
    await operation?.release();
    console.log(`Artifacts: ${artifacts}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = options();
    if (config.help) console.log(help);
    else await main(config);
  } catch (error) {
    console.error(safeValue(error.message));
    process.exitCode = 1;
  }
}
