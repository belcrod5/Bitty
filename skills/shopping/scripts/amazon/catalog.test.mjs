import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { readSearchResults, nextSearchPage, readProductDetails } from './catalog.mjs';
import { authentication } from './navigation.mjs';
import { options } from './search.mjs';
import { serveSession, requestSession } from './chrome-session.mjs';

let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--host-resolver-rules=MAP www.amazon.co.jp ~NOTFOUND'] }); });
after(async () => { await browser?.close(); });

function resultsHTML(number = 1) {
  return `<title>検索結果</title>${Array.from({ length: 4 }, (_, index) => `<div data-component-type="s-search-result" data-asin="B0000000${number}${index}">
    <h2>メーカー名</h2><a><h2 aria-label="消しゴム ${number}-${index}">消しゴム ${number}-${index}</h2></a>${index ? '' : '<span class="puis-sponsored-label-text">スポンサー</span>'}
    <span class="a-price a-text-price"><span class="a-offscreen">￥999</span></span>
    ${index === 2 ? '' : '<span class="a-price"><span class="a-offscreen">￥82</span></span>'}
    <span class="a-icon-alt">5つ星のうち4.2</span><a href="/dp/B000000010#customerReviews" aria-label="202 レーティング">(202)</a>
    <img class="s-image" src="https://m.media-amazon.com/images/I/example.jpg?tracking=SECRET"></div>`).join('')}
    <div style="margin-top:1800px"><span class="s-pagination-selected">${number}</span>
    ${number === 1 ? '<a class="s-pagination-next" href="/s?k=%E6%B6%88%E3%81%97%E3%82%B4%E3%83%A0&page=2">次へ</a>' : '<span class="s-pagination-next s-pagination-disabled">次へ</span>'}</div>`;
}
const detailHTML = `<title>商品詳細</title><h1 id="productTitle">MONO 消しゴム</h1>
  <div id="corePriceDisplay_desktop_feature_div"><span class="a-price a-text-price"><span class="a-offscreen">￥999</span></span><span class="a-price"><span class="a-offscreen">￥82</span></span></div>
  <div id="availability">在庫あり。</div><div id="acrPopover"><span class="a-icon-alt">5つ星のうち4.2</span></div><span id="acrCustomerReviewText">202個の評価</span>
  <ul id="feature-bullets"><li><span class="a-list-item">プラスチック消しゴム</span></li><li><span class="a-list-item">${'特徴'.repeat(300)}</span></li></ul>
  <table id="productOverview_feature_div"><tr><td>ブランド</td><td>MONO</td></tr></table><img id="landingImage" src="https://m.media-amazon.com/images/I/product.jpg?tracking=SECRET">
  <aside><span class="a-price"><span class="a-offscreen">￥1</span></span><button>今すぐ買う</button></aside>`;

async function fixture() {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  let requests = 0, posts = 0;
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'POST') { posts++; return route.abort(); }
    if (url.pathname === '/s') { requests++; return route.fulfill({ contentType: 'text/html; charset=utf-8', body: resultsHTML(Number(url.searchParams.get('page') ?? 1)) }); }
    if (url.pathname.startsWith('/dp/')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: detailHTML });
    return route.abort();
  });
  await page.goto('https://www.amazon.co.jp/s?k=消しゴム');
  const assertNoAuth = async () => { if (await authentication(page)) throw new Error('AUTH_REQUIRED'); };
  return { context, page, assertNoAuth, get requests() { return requests; }, get posts() { return posts; } };
}

test('search JSON returns bounded current-page data, preserves ad order and distinguishes unavailable prices', async () => {
  const f = await fixture();
  try {
    const first = await readSearchResults(f.page, { limit: 2 });
    assert.equal(first.query, '消しゴム'); assert.equal(first.page, 1); assert.equal(first.productCount, 4);
    assert.equal(first.hasNextPage, true); assert.equal(first.nextOffset, 2);
    assert.equal(first.products[0].sponsored, true); assert.equal(first.products[1].sponsored, false);
    assert.equal(first.products[0].asin, 'B000000010'); assert.equal(first.products[0].priceText, '￥82');
    assert.equal(first.products[0].title, '消しゴム 1-0');
    assert.equal(first.products[0].ratingCountText, '202 レーティング');
    assert.equal(first.products[0].imageUrl.includes('SECRET'), false);
    const rest = await readSearchResults(f.page, { offset: 2, limit: 2 });
    assert.equal(rest.products[0].index, 3); assert.equal(rest.products[0].priceText, null);
    assert.equal(rest.nextOffset, null); assert.equal(f.requests, 1); assert.equal(f.posts, 0);
  } finally { await f.context.close(); }
});

test('next-page clicks exactly once without repeating search, and the disabled final page is a no-op', async () => {
  const f = await fixture(); let clicks = 0;
  const mouse = { click: async locator => { clicks++; await locator.click(); } };
  try {
    const second = await nextSearchPage(f.page, mouse, f.assertNoAuth, { limit: 2 });
    assert.equal(second.page, 2); assert.equal(second.pageChanged, true); assert.equal(second.hasNextPage, false);
    assert.equal(second.products[0].asin, 'B000000020'); assert.equal(f.requests, 2);
    const end = await nextSearchPage(f.page, mouse, f.assertNoAuth, {});
    assert.equal(end.pageChanged, false); assert.equal(clicks, 1); assert.equal(f.requests, 2); assert.equal(f.posts, 0);
  } finally { await f.context.close(); }
});

test('unexpected next links and authentication stop before another click', async () => {
  const f = await fixture(); let clicks = 0;
  const mouse = { click: async () => { clicks++; } };
  try {
    for (const href of ['https://example.com/s?k=消しゴム&page=2', '/s?k=違う検索&page=2', '/s?k=消しゴム&page=1', '/s?k=消しゴム&page=3', '/cart?k=消しゴム&page=2']) {
      await f.page.locator('a.s-pagination-next').evaluate((element, value) => element.setAttribute('href', value), href);
      await assert.rejects(nextSearchPage(f.page, mouse, f.assertNoAuth, {}), /次ページ/);
    }
    await f.page.setContent('<h1>私は人間です</h1>');
    await assert.rejects(nextSearchPage(f.page, mouse, f.assertNoAuth, {}), /AUTH_REQUIRED/);
    assert.equal(clicks, 0); assert.equal(f.requests, 1); assert.equal(f.posts, 0);
  } finally { await f.context.close(); }
});

test('product JSON scopes price to the buy box, returns bounded text and rejects a different ASIN', async () => {
  const f = await fixture();
  try {
    await f.page.goto('https://www.amazon.co.jp/dp/B000000010');
    const product = await readProductDetails(f.page, 'B000000010');
    assert.equal(product.productTitle, 'MONO 消しゴム'); assert.equal(product.priceText, '￥82');
    assert.equal(product.availabilityText, '在庫あり。'); assert.equal(product.ratingCountText, '202個の評価');
    assert.deepEqual(product.specifications[0], { name: 'ブランド', value: 'MONO' });
    assert.equal(product.features[1].length, 500); assert.equal(product.contentTruncated, true);
    assert.equal(product.imageUrl.includes('SECRET'), false); assert.equal(f.posts, 0);
    await assert.rejects(readProductDetails(f.page, 'B099999999'), /ASIN/);
  } finally { await f.context.close(); }
});

test('CLI bounds result size and requires an existing session for continuation commands', () => {
  assert.equal(options(['search', '消しゴム']).limit, 10);
  for (const args of [['search', '--limit', '0'], ['search', '--limit', '21'], ['search', '--offset', '-1'], ['detail', '--limit', '2'], ['search-next'], ['search-next', '別の検索', '--cdp', 'chrome']]) assert.throws(() => options(args));
});

test('clothing details expose child ASINs, selected labels, preloaded size charts and product facts as bounded JSON', async () => {
  const f = await fixture();
  try {
    await f.page.goto('https://www.amazon.co.jp/dp/B000000010');
    await f.page.locator('body').evaluate(body => body.insertAdjacentHTML('beforeend', `
      <div id="inline-twister-row-color_name"><span class="inline-twister-dim-title-value">０１ブラック</span>
      <li data-asin="B000000010" data-initiallyunavailable="false"><span class="a-button-selected"><input aria-checked="true"><img alt="０１ブラック"></span></li>
      <li data-asin="B000000011" data-initiallyunavailable="true"><img alt="白"></li></div>
      <div id="variation_size_name"><span class="selection">L</span><select><option value="-1">選択</option><option value="0,B000000012">M</option><option selected value="1,B000000010">L</option></select></div>
      <div id="sizeChartV2Data_feature_div" hidden><div id="fit-sizechartv2-0"><h5>JP レギュラー</h5><table><tr><th>サイズ</th><th>身幅(cm)</th></tr><tr><th>L</th><td>54</td></tr></table></div></div>
      <div id="productFactsDesktopExpander"><style>SECRET_CSS</style><script>SECRET_JS</script>素材 100%ポリエステル</div>`));
    const detail = await readProductDetails(f.page, 'B000000010');
    assert.equal(detail.variations[0].selected, '０１ブラック');
    assert.equal(detail.variations[0].options[0].asin, 'B000000010');
    assert.equal(detail.variations[0].options[1].availability, 'unavailable');
    assert.equal(detail.variations[1].selected, 'L');
    assert.equal(detail.variations[1].options[0].asin, 'B000000012');
    assert.deepEqual(detail.sizeCharts[0], { caption: 'JP レギュラー', rows: [['サイズ', '身幅(cm)'], ['L', '54']], truncated: false });
    assert.equal(detail.productFactsText, '素材 100%ポリエステル'); assert.equal(f.posts, 0);
    await f.page.locator('#inline-twister-row-color_name').evaluate(row => row.insertAdjacentHTML('beforeend', Array.from({length:35},(_,i)=>`<li data-asin="B000000011"><img alt="色${i}"></li>`).join('')));
    const bounded = await readProductDetails(f.page, 'B000000010');
    assert.equal(bounded.variations[0].options.length, 30); assert.equal(bounded.contentTruncated, true);
  } finally { await f.context.close(); }
});

test('cart selection arguments are explicit and cannot be used on other commands', () => {
  assert.deepEqual(options(['cart-add','--asin','B000000010','--operation','trial','--color','黒','--size','L','--max-price','1648']).constraints, {color:'黒',size:'L',maxPrice:1648});
  for (const args of [['detail','--color','黒'], ['cart-add','--asin','B000000010','--operation','trial','--size',' '], ['cart-add','--asin','B000000010','--operation','trial','--max-price','1.2']]) assert.throws(()=>options(args));
});

test('held extension session returns JSON, pages with random mouse and opens the chosen ASIN without screenshots by default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shopping-catalog-'));
  const context = await chromium.launchPersistentContext(join(directory, 'profile'), { channel: 'chrome', headless: true, serviceWorkers: 'block', args: ['--remote-debugging-port=0', '--host-resolver-rules=MAP www.amazon.co.jp ~NOTFOUND'] });
  const page = context.pages()[0]; let searches = 0, connections = 0, mutations = 0;
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== 'GET') { mutations++; return route.abort(); }
    if (url.pathname === '/s') { searches++; return route.fulfill({ contentType: 'text/html; charset=utf-8', body: resultsHTML(Number(url.searchParams.get('page') ?? 1)) }); }
    if (url.pathname.startsWith('/dp/')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: detailHTML });
    return route.abort();
  });
  await page.goto('https://www.amazon.co.jp/s?k=消しゴム');
  const port = (await readFile(join(directory, 'profile/DevToolsActivePort'), 'utf8')).split('\n')[0];
  const socket = join(directory, 'session.sock');
  const session = await serveSession(socket, async () => { connections++; return chromium.connectOverCDP(`http://127.0.0.1:${port}`); }, { transport: 'extension' });
  try {
    for (let i = 0; (await session.status()).state !== 'connected' && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
    const run = args => requestSession(socket, { command: 'run', args });
    const first = await run(['search-results', '--limit', '2']);
    assert.equal(first.success, true, first.error); assert.equal(first.products.length, 2);
    assert.deepEqual((await readdir(first.artifacts)).sort(), ['events.json', 'result.json']);
    const rest = await run(['search-results', '--offset', '2']);
    assert.equal(rest.products[0].index, 3); assert.equal(searches, 1);
    const next = await run(['search-next', '--limit', '2']);
    assert.equal(next.success, true, next.error); assert.equal(next.page, 2); assert.equal(searches, 2);
    const events = JSON.parse(await readFile(join(next.artifacts, 'events.json'), 'utf8'));
    assert.equal(events.some(event => event.event === 'mouse-segment'), true);
    assert.equal(events.filter(event => event.event === 'click').length, 1);
    const detail = await run(['detail', '--asin', next.products[0].asin, '--screenshots']);
    assert.equal(detail.success, true, detail.error); assert.equal(detail.asin, next.products[0].asin); assert.equal(detail.priceText, '￥82');
    assert.equal((await readdir(detail.artifacts)).includes('04-product-detail.png'), true);
    assert.equal(connections, 1); assert.equal(mutations, 0);
  } finally { await session.stop(); await context.close(); await rm(directory, { recursive: true, force: true }); }
});
