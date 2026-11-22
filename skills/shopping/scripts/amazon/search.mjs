import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { discoverBrowsers, chooseBrowser } from './browser.mjs';
import { openOperation, readOperation, listOperations, runCartAddition, runCartRemoval, openCart } from './cart.mjs';
import { runOrders } from './orders.mjs';
import { typeSearchQuery, RandomMouse, pause, activateTab } from './motion.mjs';
import { searchProductSelector, readSearchResults, nextSearchPage, readProductDetails } from './catalog.mjs';
import { allowNavigation, createRouteHandler, isSearchPath, searchTerm, productAsin, isAuthPath, authentication, safeValue, safeURL } from './navigation.mjs';

const help = `Amazon検索・カート操作コマンド（注文確定・購入操作なし）
  npm start -- "検索語" [--keep-open] [--profile]
  npm run chrome -- search-next   今の検索結果の次ページをクリック（再検索なし）
  npm run chrome -- search-results --offset 10 --limit 10
                                 今のページの続きの商品JSONを取得（再検索なし）
  npm run detail -- "検索語" [--index 1] [--keep-open]
  npm run detail -- --asin B012345678 [--keep-open]
  npm run chrome -- orders       購入履歴を開いて商品JSONを取得
  npm run chrome -- orders-search "検索語"  履歴内を検索・再絞り込み
  npm run chrome -- orders-results --offset 10 --limit 10
  npm run chrome -- orders-next   履歴の次ページ
  npm run chrome -- orders-resume 認証後、保存した続きから再開
  npm run cart                   カート表示／認証状態の確認（追加なし）
  npm run chrome -- cart-add --asin B012345678 --operation request-001
                                 数量1を1回だけ追加し、結果を保存してカートへ移動
  npm run chrome -- detail-current
                                 同じタブの選択済み商品JSONを取得（移動・再読込なし）
  npm run chrome -- cart-remove --asin <ASIN> --item-id <行ID> --quantity <数量> --operation <ID>
                                 指定したカート行を削除し、元の商品情報を保存
  npm run cart-status -- --operation request-001
                                 保存された操作状態を表示（ブラウザ操作なし）
  npm run browser-status         起動中Chromeの接続可否・Amazonタブを自動診断
  --cdp chrome                   Chromeの接続許可を使って直接接続（初期設定が必要）
  --cdp auto                     検出した既存Chromeと対象タブを使用
  --cdp http://127.0.0.1:9222     明示した既存Chromeへ接続（未指定時は専用ブラウザ）
  --tab-url https://www.amazon.co.jp/dp/B012345678
                                 接続先で操作する既存タブを指定
  --limit 10 --offset 0           商品JSONの取得件数（1〜20）・開始位置（0始まり）
  --screenshots                  ページ画像も保存（既定はJSONのみ）
  --max-price <円>                cart-add直前の表示価格上限を検査
  --headless                     画面を表示せず実行
  --profile                      専用ブラウザのログイン状態を使う
要素が見つからない場合はエラーで停止します。`;

export function options(input = process.argv.slice(2)) {
  const args = [...input];
  if (args[0] === 'cart-replace') throw new Error('cart-replaceは廃止しました。cart-remove・AIによる選択・cart-addを使ってください');
  const command = ['search', 'search-next', 'search-results', 'detail', 'detail-current', 'orders', 'orders-search', 'orders-results', 'orders-next', 'orders-resume', 'cart', 'cart-add', 'cart-remove', 'cart-status', 'browser-status'].includes(args[0]) ? args.shift() : 'search';
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    screenshots: { type: 'boolean' }, limit: { type: 'string' }, offset: { type: 'string' },
    'keep-open': { type: 'boolean' }, headless: { type: 'boolean' }, profile: { type: 'boolean' },
    cdp: { type: 'string' }, 'tab-url': { type: 'string' }, operation: { type: 'string' },
    asin: { type: 'string' }, index: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    'max-price': { type: 'string' }, 'item-id': { type: 'string' }, quantity: { type: 'string' },
  } });
  if (values.help) return { help: true };
  if (['search-next', 'search-results', 'detail-current', 'orders', 'orders-results', 'orders-next', 'orders-resume', 'cart', 'cart-add', 'cart-remove', 'cart-status', 'browser-status'].includes(command) && positionals.length) throw new Error(`${command} は検索語を受け取りません`);
  if (command === 'orders-search' && !positionals.join(' ').trim()) throw new Error('orders-search は検索語が必要です');
  if (values.asin !== undefined && (!['detail', 'cart-add', 'cart-remove'].includes(command) || !/^[A-Z0-9]{10}$/i.test(values.asin))) throw new Error('--asin はdetail・cart-add・cart-remove用の10桁の英数字です');
  if (values.asin && (positionals.length || values.index)) throw new Error('--asin と検索語・--indexは同時指定できません');
  const index = values.index === undefined ? 1 : Number(values.index);
  if (values.index !== undefined && (command !== 'detail' || !/^\d+$/.test(values.index) || !Number.isSafeInteger(index) || index < 1)) throw new Error('--index はdetail専用の1以上の整数です');
  if (['cart-add', 'cart-remove'].includes(command) && !values.asin) throw new Error(`${command} は --asin が必要です`);
  if (['cart-add', 'cart-remove', 'detail-current'].includes(command) && !values.cdp) throw new Error('選択済みの既存Chromeで実行してください（npm run chrome -- <コマンド>）');
  let removal;
  if (command === 'cart-remove') {
    const quantity = Number(values.quantity);
    if (!/^[\w-]{1,80}$/.test(values['item-id'] ?? '') || !/^[1-9]\d*$/.test(values.quantity ?? '') || !Number.isSafeInteger(quantity)) throw new Error('cart-remove は --item-id と確認済みの --quantity が必要です');
    removal = { itemId: values['item-id'], quantity };
  } else if (values['item-id'] !== undefined || values.quantity !== undefined) throw new Error('--item-id・--quantity はcart-remove専用です');
  const constraints = {};
  if (values['max-price'] !== undefined) {
    if (command !== 'cart-add' || !/^[1-9]\d*$/.test(values['max-price']) || !Number.isSafeInteger(Number(values['max-price']))) throw new Error('--max-price はcart-add専用の1以上の整数（円）です');
    constraints.maxPrice = Number(values['max-price']);
  }
  if (['cart-add', 'cart-remove'].includes(command) || command === 'cart-status' && values.operation !== undefined) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(values.operation ?? '')) throw new Error('--operation が必要です（英数字・ハイフン・下線、1〜80文字）');
  } else if (values.operation !== undefined) throw new Error('--operation はcart-add・cart-remove・cart-status用です');
  if (values.cdp) {
    const endpoint = ['auto', 'chrome'].includes(values.cdp) ? null : new URL(values.cdp);
    if (endpoint && (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password)) throw new Error('--cdp はローカルChromeの接続先を指定してください');
    if (values.headless || values.profile || values['keep-open']) throw new Error('--cdp は --headless・--profile・--keep-open と併用できません。既存ブラウザは開いたままです');
  }
  const limit = values.limit === undefined ? 10 : Number(values.limit);
  const offset = values.offset === undefined ? 0 : Number(values.offset);
  if (values.limit !== undefined || values.offset !== undefined) {
    if (!['search', 'search-next', 'search-results', 'orders', 'orders-search', 'orders-results', 'orders-next', 'orders-resume'].includes(command)) throw new Error('--limit・--offset は検索結果用です');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 || values.limit !== undefined && !/^\d+$/.test(values.limit)) throw new Error('--limit は1〜20の整数です');
    if (!Number.isSafeInteger(offset) || offset < 0 || values.offset !== undefined && !/^\d+$/.test(values.offset)) throw new Error('--offset は0以上の整数です');
  }
  if (['search-next', 'search-results', 'orders-search', 'orders-results', 'orders-next', 'orders-resume'].includes(command) && !values.cdp) throw new Error('継続操作は既存接続で実行してください（npm run chrome -- <コマンド>）');
  if (values['tab-url']) {
    if (!values.cdp) throw new Error('--tab-url は --cdp と併用してください');
    const tab = new URL(values['tab-url']);
    if (tab.origin !== 'https://www.amazon.co.jp') throw new Error('--tab-url はAmazon.co.jpのタブを指定してください');
  }
  return { command, limit, offset, constraints, removal, screenshots: !!values.screenshots, operationId: values.operation, cdp: values.cdp, tabURL: values['tab-url'], query: positionals.join(' ').trim() || 'ボールペン', index, asin: values.asin?.toUpperCase(),
    keepOpen: !!values['keep-open'], headless: !!values.headless, persistent: !!values.profile || ['orders', 'cart'].includes(command) };
}

export async function main(config, existingBrowser) {
  const { command, query, asin, index, keepOpen, headless, persistent, operationId } = config;
  let { cdp, tabURL } = config;
  if (command === 'browser-status' && cdp !== 'chrome' && !existingBrowser) { console.log(JSON.stringify(safeValue(await discoverBrowsers()), null, 2)); return; }
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
  let browser = existingBrowser, context, page, operation, routeHandler, networkSession;
  let exitCode = 0;
  const attempt = { armed: false, consumed: false, action: null };
  const cartCommand = ['cart', 'cart-add', 'cart-remove'].includes(command);
  let summary = { success: false, command, artifacts, ...(config.extensionConnection ? { transport: 'playwright-extension', serviceWorkerBypass: false } : {}) };
  const save = async () => {
    await writeFile(`${artifacts}/events.json`, JSON.stringify(events, null, 2));
    await writeFile(`${artifacts}/result.json`, JSON.stringify(safeValue(summary), null, 2));
  };

  try {
    if (['cart-add', 'cart-remove'].includes(command)) operation = await openOperation(operations, operationId, asin, config.constraints, config.removal);
    const contextOptions = { viewport: { width: 1440, height: 1000 }, locale: 'ja-JP', serviceWorkers: 'block', acceptDownloads: false };
    if (cdp === 'auto') {
      const report = await discoverBrowsers();
      const selected = chooseBrowser(report, { command, asin, tabURL });
      cdp = selected.endpoint;
      tabURL ??= selected.tabURL;
      log('browser-discovered', selected);
    }
    if (cdp) {
      browser ??= await chromium.connectOverCDP(cdp, { timeout: 20_000, noDefaults: true });
      const amazonPages = browser.contexts().flatMap(c => c.pages()).filter(p => { try { return new URL(p.url()).origin === 'https://www.amazon.co.jp'; } catch { return false; } });
      if (command === 'browser-status') {
        summary = { ...summary, success: true, browser: 'existing-chrome',
          tabState: amazonPages.length ? 'available' : 'missing',
          tabs: await Promise.all(amazonPages.map(async p => {
            let loginState = await authentication(p);
            if (!loginState) {
              const account = await p.locator('#nav-link-accountList').innerText({ timeout: 1500 }).catch(() => '');
              const signOut = await p.locator('#nav-item-signout').count();
              loginState = /ログイン|sign in/i.test(account) ? 'signed_out'
                : signOut || /こんにちは[、,\s]*.+さん|Hello[,\s]+\S+/i.test(account) ? 'signed_in' : 'unknown';
            }
            return { url: safeURL(p.url()), title: await p.title(), loginState };
          })) };
        log('browser-status', summary);
        return { ...summary, exitCode: 0 };
      }
      let candidates = tabURL ? amazonPages.filter(p => p.url() === tabURL) : amazonPages;
      if (tabURL && !candidates.length) candidates = amazonPages.filter(p => safeURL(p.url()) === safeURL(tabURL));
      if (!tabURL && candidates.length > 1 && command === 'cart-add' && operation.data.addition === 'not_started') candidates = candidates.filter(p => productAsin(new URL(p.url()).pathname) === asin);
      // Token-authenticated extension connections own a new blank tab. Only this
      // transport may initialize it; explicit tab selection never falls back.
      if (!tabURL && !candidates.length && config.extensionConnection) candidates = browser.contexts().flatMap(c => c.pages()).filter(p => p.url() === 'about:blank');
      if (candidates.length !== 1) throw new Error('対象のAmazonタブを一意に選択できません。--tab-url で既存タブのURLを指定してください');
      page = candidates[0];
      context = page.context();
      // Keep page routes effective even when Amazon has a Service Worker.
      // This applies only to this CDP session and is removed by detach below.
      if (config.extensionConnection) {
        // Fixed controls, preflight form validation and the durable one-click
        // journal apply on both transports. Page routing is supplementary here.
        log('service-worker-bypass-unavailable', { transport: 'playwright-extension', cartAdditionAllowed: true });
      } else {
        networkSession = await context.newCDPSession(page);
        await networkSession.send('Network.enable');
        await networkSession.send('Network.setBypassServiceWorker', { bypass: true });
        log('service-worker-network-bypass', { scope: 'selected-tab-until-command-end' });
      }
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
    const screenshot = async name => { if (!config.screenshots) return; await assertNoAuth(); await page.screenshot({ path: `${artifacts}/${name}` }); };

    async function search() {
      if (cdp) await assertNoAuth();
      const current = new URL(page.url());
      if (current.origin !== 'https://www.amazon.co.jp' || current.pathname !== '/') {
        await pause(log, 'before opening Amazon home', 1500, 3000);
        await assertNoAuth();
        await page.goto('https://www.amazon.co.jp/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      }
      const input = page.locator('#twotabsearchtextbox');
      const submit = page.locator('#nav-search-submit-button');
      await assertNoAuth();
      await input.waitFor({ state: 'visible' });
      await submit.waitFor({ state: 'visible' });
      await screenshot('01-home.png');
      await mouse.click(input, 'search input');
      if (!await input.evaluate(element => document.activeElement === element)) throw new Error('Search input did not receive focus');
      log('focused-search-input');
      await typeSearchQuery(page, input, query, log);
      await screenshot('02-entered-query.png');
      await mouse.click(submit, 'search button');
      await page.waitForURL(url => isAuthPath(url.pathname) || url.hostname === 'www.amazon.co.jp' && isSearchPath(url.pathname) && searchTerm(url) === query, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await assertNoAuth();
      const products = page.locator(searchProductSelector);
      await products.first().waitFor({ state: 'visible', timeout: 30_000 });
      await screenshot('03-search-results.png');
      return products;
    }

    if (!['search-results', 'detail-current', 'orders-results'].includes(command) && !await authentication(page)) await activateTab(page, log);

    if (cartCommand) {
      if (!cdp) {
        await pause(log, 'before opening Amazon home', 1500, 3000);
        await page.goto('https://www.amazon.co.jp/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      }
      if (['cart-add', 'cart-remove'].includes(command)) {
        const identity = cdp ? safeURL(cdp) : fileURLToPath(new URL('./.browser-profile/', import.meta.url));
        const run = command === 'cart-remove' ? runCartRemoval : runCartAddition;
        const data = await run({ page, mouse, log, operation, attempt, identity });
        summary = { ...summary, ...data, success: data.cart === 'visible' && (command === 'cart-remove' ? data.removal === 'confirmed' && data.targetPresent === false : data.addition === 'confirmed' && data.targetPresent), url: safeURL(page.url()) };
      } else {
        const view = await openCart(page, mouse, log);
        summary = { ...summary, ...view, success: view.cart === 'visible', code: view.cart === 'visible' ? null : 'AUTH_REQUIRED', url: safeURL(page.url()) };
      }
      if (summary.cart === 'visible') await screenshot('04-cart.png');
      if (!summary.success) exitCode = summary.addition === 'unknown' || summary.removal === 'unknown' ? 3 : ['login_required', 'verification_required'].includes(summary.cart) ? 2 : 1;
    } else if (command === 'search') {
      await search();
      summary = { ...summary, ...await readSearchResults(page, config) };
    } else if (['search-next', 'search-results'].includes(command)) {
      await assertNoAuth();
      const data = command === 'search-next' ? await nextSearchPage(page, mouse, assertNoAuth, config) : await readSearchResults(page, config);
      summary = { ...summary, ...data };
      await screenshot('03-search-results.png');
    } else if (command === 'detail-current') {
      await assertNoAuth();
      const currentAsin = productAsin(new URL(page.url()).pathname);
      if (!currentAsin) throw new Error('現在のタブは商品詳細ページではありません');
      summary = { ...summary, ...await readProductDetails(page, currentAsin) };
    } else if (command === 'detail') {
      let expectedAsin = asin;
      if (asin) {
        await assertNoAuth();
        await pause(log, 'before opening product detail', 1500, 3000);
        await assertNoAuth();
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
      summary = { ...summary, ...await readProductDetails(page, expectedAsin.toUpperCase()), ...(asin ? {} : { query, index }) };
      await screenshot('04-product-detail.png');
    } else if (command.startsWith('orders')) {
      summary = { ...summary, ...await runOrders({ page, mouse, log, config,
        progressPath: config.ordersProgressPath ?? fileURLToPath(new URL('./.orders-progress.json', import.meta.url)) }) };
      await screenshot('04-order-history.png');
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
    if (attempt.remove) attempt.remove.armed = false;
    if (operation) {
      if (operation.data.addition === 'submitted') await operation.update({ addition: 'unknown', retryAdd: false, code: 'ADDITION_UNKNOWN' });
      if (operation.data.removal === 'submitted') await operation.update({ removal: 'unknown', code: 'REMOVAL_UNKNOWN' });
      summary = { ...summary, ...operation.data };
    }
    if (error.ordersProgress !== undefined) summary.progress = error.ordersProgress;
    summary.success = false;
    summary.error = safeValue(error.message);
    summary.code = summary.addition === 'unknown' ? 'ADDITION_UNKNOWN' : summary.removal === 'unknown' ? 'REMOVAL_UNKNOWN' : error.code ?? summary.code ?? 'ERROR';
    log('failed', { error: summary.error, code: summary.code });
    if (page && !page.isClosed()) {
      const url = new URL(page.url());
      // DOM, screenshots and HTML may never answer after a navigation timeout.
      // Return the recorded failure without reading the unresponsive document.
      const auth = isAuthPath(url.pathname) ? (url.pathname.startsWith('/ap/') ? 'login_required' : 'verification_required') : null;
      summary.url = safeURL(page.url());
      if (auth) {
        summary.authentication = auth;
        if (summary.addition !== 'unknown') summary.code = auth === 'login_required' ? 'LOGIN_REQUIRED' : 'VERIFICATION_REQUIRED';
        if (cartCommand && operation) {
          await operation.update({ cart: auth });
          summary.cart = operation.data.cart;
        }
      }
    }
    exitCode = summary.addition === 'unknown' || summary.removal === 'unknown' ? 3 : ['LOGIN_REQUIRED', 'VERIFICATION_REQUIRED'].includes(summary.code) ? 2 : 1;
  } finally {
    await save();
    if (page && routeHandler && !page.isClosed()) await page.unroute('**/*', routeHandler).catch(() => {});
    await networkSession?.detach().catch(() => {});
    if (!cdp) await context?.close();
    // connectOverCDP.close disconnects this client; existing tabs/context are not closed.
    if (!existingBrowser) await browser?.close();
    await operation?.release();
    console.log(`Artifacts: ${artifacts}`);
    if (!existingBrowser) process.exitCode = exitCode;
  }
  return { ...safeValue(summary), exitCode };
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
