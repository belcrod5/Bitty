import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOrders, readOrders } from './orders.mjs';
import { options, main } from './search.mjs';
import { createRouteHandler, allowNavigation } from './navigation.mjs';

let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--host-resolver-rules=MAP www.amazon.co.jp ~NOTFOUND'] }); });
after(async () => { await browser?.close(); });
const origin = 'https://www.amazon.co.jp';
function html(query = '', start = 0, empty = false) {
  return `<title>注文履歴</title><h1>注文履歴</h1><form action="/your-orders/search" method="get"><input id="searchOrdersInput" name="search" value="${query}"><input type="hidden" name="orderFilter" value="all"><button type="submit">注文を検索</button></form>
  ${empty ? '<div>一致する注文はありません</div>' : Array.from({length:3}, (_, i) => `<div class="order-card"><div class="js-order-card"><a href="/dp/B0000000${start}${i}"><img alt="電池 ${start}-${i}"></a><a href="/dp/B0000000${start}${i}">電池 ${start}-${i}</a><a href="/cart/add-to-cart">再度購入</a></div></div>`).join('')}
  <ul class="a-pagination"><li class="a-last ${start || empty ? 'a-disabled' : ''}">${start || empty ? '次へ' : `<a href="/your-orders/search?search=${encodeURIComponent(query)}&orderFilter=all&startIndex=3">次へ</a>`}</li></ul>`;
}
async function fixture(initial = '/your-orders/orders?orderFilter=all') {
  const directory = await mkdtemp(join(tmpdir(), 'shopping-orders-'));
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  let requests = 0, posts = 0, clicks = 0, requireAuth = false;
  const events = [];
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    requests++;
    if (request.method() !== 'GET') { posts++; return route.abort(); }
    if (requireAuth && url.pathname.startsWith('/your-orders/')) { requireAuth = false; return route.fulfill({ status: 302, headers: { location: '/checkpoint/continue?token=SECRET' } }); }
    if (url.pathname === '/checkpoint/continue') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>私は人間です</h1>' });
    if (url.pathname.startsWith('/your-orders/')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html(url.searchParams.get('search') ?? '', Number(url.searchParams.get('startIndex') ?? 0), url.searchParams.get('search') === 'なし') });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<a id="nav-orders" href="/your-orders/orders?orderFilter=all">注文履歴</a>' });
    return route.abort();
  });
  await page.goto(origin + initial);
  const progressPath = join(directory, 'progress.json');
  const mouse = { click: async (locator, label, { beforeMouseDown } = {}) => { await beforeMouseDown?.(); clicks++; await locator.click(); } };
  const run = async (command, config = {}) => {
    const guard = createRouteHandler(command, {}, null, () => {});
    await page.route('**/*', guard);
    try { return await runOrders({ page, mouse, log: e => events.push(e), config: {command, ...config}, progressPath }); }
    finally { await page.unroute('**/*', guard); }
  };
  return { context, page, run, progressPath, events, auth: () => { requireAuth = true; },
    get requests() { return requests; }, get clicks() { return clicks; }, get posts() { return posts; },
    close: async () => { await context.close(); await rm(directory, {recursive:true,force:true}); } };
}

test('orders results are bounded JSON, deduplicate image/title links and never navigate', async () => {
  const f = await fixture();
  try {
    const first = await f.run('orders-results', {limit:2});
    assert.equal(first.productCount, 3); assert.equal(first.orderCount, 3);
    assert.equal(first.nextOffset, 2); assert.equal(first.hasNextPage, true);
    assert.equal(first.products[0].title, '電池 0-0');
    const rest = await f.run('orders-results', {offset:2});
    assert.equal(rest.products.length, 1); assert.equal(rest.nextOffset, null);
    assert.equal(f.requests, 1); assert.equal(f.clicks, 0); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});

test('search and refinement use the focused form; paging preserves query, last page is a no-op', async () => {
  const f = await fixture();
  try {
    const found = await f.run('orders-search', {query:'電池'});
    assert.equal(found.query, '電池'); assert.equal(f.clicks, 2);
    assert.equal(f.events.filter(e=>e==='pause').length, 2);
    const refined = await f.run('orders-search', {query:'単3'});
    assert.equal(refined.query, '単3');
    const next = await f.run('orders-next');
    assert.equal(next.startIndex, 3); assert.equal(next.pageChanged, true);
    const count = f.requests;
    const end = await f.run('orders-next');
    assert.equal(end.pageChanged, false); assert.equal(f.requests, count);
    assert.equal(f.clicks, 5); assert.equal(f.posts, 0);
  } finally { await f.close(); }
});

test('authentication after search persists intent and resume reads delivered page without submitting twice', async () => {
  const f = await fixture();
  try {
    f.auth();
    await assert.rejects(f.run('orders-search', {query:'電池'}), e=>e.code==='VERIFICATION_REQUIRED');
    const saved = await readFile(f.progressPath,'utf8');
    assert.equal(saved.includes('SECRET'), false); assert.equal(JSON.parse(saved).status, 'authentication_required');
    const clicks = f.clicks, requests = f.requests;
    await assert.rejects(f.run('orders-resume'), e=>e.code==='VERIFICATION_REQUIRED');
    assert.equal(f.clicks, clicks); assert.equal(f.requests, requests);
    await f.page.goto(origin+'/your-orders/search?search=電池&orderFilter=all'); // user finished auth
    const resumed = await f.run('orders-resume');
    assert.equal(resumed.query, '電池'); assert.equal(resumed.navigationRepeated, false); assert.equal(f.clicks, clicks);
    const repeated = await f.run('orders-resume');
    assert.equal(repeated.navigationRepeated, false); assert.equal(f.clicks, clicks);
  } finally { await f.close(); }
});

test('authentication during next page never skips a page on resume; mismatched tab stops', async () => {
  const f = await fixture('/your-orders/search?search=電池&orderFilter=all');
  try {
    f.auth();
    await assert.rejects(f.run('orders-next'), e=>e.code==='VERIFICATION_REQUIRED');
    await assert.rejects(f.run('orders-next'), e=>e.code==='ORDERS_PENDING');
    await f.page.goto(origin+'/your-orders/search?search=電池&orderFilter=all&startIndex=3');
    const result = await f.run('orders-resume');
    assert.equal(result.startIndex, 3); assert.equal(f.clicks, 1);
    await f.page.goto(origin+'/your-orders/search?search=違う&orderFilter=all');
    await assert.rejects(f.run('orders-resume'), e=>e.code==='ORDERS_RESUME_MISMATCH');
    assert.equal(f.clicks, 1);
  } finally { await f.close(); }
});

test('authentication before any click keeps the intended query; resume from source executes once', async () => {
  const f = await fixture('/checkpoint/continue?token=SECRET');
  try {
    await assert.rejects(f.run('orders-search',{query:'単4'}), e=>e.code==='VERIFICATION_REQUIRED');
    assert.equal(f.clicks, 0);
    await f.page.goto(origin+'/your-orders/orders?orderFilter=all');
    const resumed = await f.run('orders-resume');
    assert.equal(resumed.query, '単4'); assert.equal(f.clicks, 2);
  } finally { await f.close(); }
});

test('opening history uses current nav link and orders on an existing history page does not reload', async () => {
  const f = await fixture('/');
  try {
    await f.run('orders'); assert.equal(f.clicks, 1);
    const requests=f.requests;
    await f.run('orders'); assert.equal(f.requests,requests);
  } finally { await f.close(); }
});

test('empty results are distinguished from unsupported layout', async () => {
  const f = await fixture();
  try {
    const empty = await f.run('orders-search',{query:'なし'});
    assert.equal(empty.empty, true); assert.equal(empty.products.length,0);
    await f.page.locator('body').evaluate(body=> { body.innerHTML='<input id="searchOrdersInput"><div>unknown layout</div>'; });
    await assert.rejects(readOrders(f.page), e=>e.code==='ORDERS_LAYOUT_UNKNOWN');
  } finally { await f.close(); }
});

test('untrusted next link and unexpected form cannot navigate or purchase', async () => {
  for (const href of ['/cart', 'https://example.com/your-orders/search?startIndex=3','/your-orders/search?search=wrong&orderFilter=all&startIndex=3','/your-orders/search?orderFilter=all&startIndex=0']) {
    const f=await fixture();
    try { await f.page.locator('.a-last a').evaluate((e,href)=>e.href=href,href); await assert.rejects(f.run('orders-next')); assert.equal(f.clicks,0); }
    finally { await f.close(); }
  }
  const f=await fixture();
  try { await f.page.locator('form').evaluate(e=>e.method='POST'); await assert.rejects(f.run('orders-search',{query:'電池'})); assert.equal(f.clicks,0); assert.equal(f.posts,0); }
  finally { await f.close(); }
});

test('orders CLI rejects missing queries, requires existing continuation connection and allows bounded output', () => {
  for (const args of [['orders-search'],['orders-search','電池'],['orders-next'],['orders-resume','unexpected','--cdp','chrome'],['orders-results','--cdp','chrome','--limit','0']]) assert.throws(()=>options(args));
  assert.equal(options(['orders-search','電池','--cdp','chrome']).query,'電池');
  assert.equal(options(['orders-results','--cdp','chrome','--offset','10']).offset,10);
  assert.equal(allowNavigation(new URL(origin+'/your-orders/search?search=電池'),'GET','orders-search'),true);
  assert.equal(allowNavigation(new URL(origin+'/your-orders/search'),'POST','orders-search'),false);
  assert.equal(allowNavigation(new URL(origin+'/cart'),'GET','orders-search'),false);
});

test('main returns auth exit 2, redacted progress and leaves same tab open', async () => {
  const f=await fixture('/checkpoint/continue?token=SECRET');
  try {
    const result=await main({...options(['orders-search','電池','--cdp','chrome']), extensionConnection:true, ordersProgressPath:f.progressPath}, {contexts:()=>[f.context]});
    assert.equal(result.exitCode,2); assert.equal(result.progress.query,'電池');
    assert.equal(JSON.stringify(result).includes('SECRET'),false); assert.equal(f.page.isClosed(),false); assert.equal(f.clicks,0);
  } finally { await f.close(); }
});

test('main dispatches orders search and results with the existing connection and navigation guard', async () => {
  const f=await fixture();
  try {
    const run=args=>main({...options([...args,'--cdp','chrome']),extensionConnection:true,ordersProgressPath:f.progressPath},{contexts:()=>[f.context]});
    const result=await run(['orders-search','電池','--limit','2']);
    assert.equal(result.success,true,result.error); assert.equal(result.products.length,2); assert.equal(result.query,'電池');
    const before=f.requests;
    const read=await run(['orders-results','--offset','2']);
    assert.equal(read.success,true,read.error); assert.equal(read.products.length,1); assert.equal(f.requests,before);
    assert.equal(f.posts,0);
  } finally { await f.close(); }
});


test('observed Amazon history search layout returns each purchase and ignores hidden chat heading', async () => {
  const f=await fixture('/your-orders/search?search=電池');
  try {
    await f.page.setContent(`<h1 hidden>チャット履歴</h1><div class="hzsearch-content-container"><h1>検索結果</h1><form><input type="search" name="search" value="電池"></form><div class="a-section a-spacing-none a-padding-small">
      <div class="a-section a-spacing-large a-spacing-top-large"><a href="/dp/B08RC7DF53"><img alt="電池"></a><a href="/dp/B08RC7DF53">電池4個</a></div><hr>
      <div class="a-section a-spacing-large a-spacing-top-large"><a href="/dp/B08RC7DF53">電池4個</a></div>
      </div></div><aside><a href="/dp/B000000000">おすすめ商品</a></aside>`);
    const r=await readOrders(f.page);
    assert.equal(r.heading,'検索結果'); assert.equal(r.orderCount,2); assert.equal(r.productCount,2);
    assert.equal(r.products[0].title,'電池4個'); assert.equal(r.products[1].asin,'B08RC7DF53');
  } finally {await f.close();}
});

test('refinement replaces all old text even when extension ControlOrMeta+A has no effect', async () => {
  const f=await fixture('/your-orders/search?search=電池&orderFilter=all');
  const press=f.page.keyboard.press.bind(f.page.keyboard);
  f.page.keyboard.press=key=>key==='ControlOrMeta+A' ? Promise.resolve() : press(key);
  try {
    const result=await f.run('orders-search',{query:'単4'});
    assert.equal(result.query,'単4'); assert.equal(new URL(f.page.url()).searchParams.get('search'),'単4');
  } finally {await f.close();}
});

test('resume from the source after next-page authentication performs only the pending next step', async () => {
  const f=await fixture('/your-orders/search?search=電池&orderFilter=all');
  try {
    f.auth();
    await assert.rejects(f.run('orders-next'), e=>e.code==='VERIFICATION_REQUIRED');
    await f.page.goto(origin+'/your-orders/search?search=電池&orderFilter=all');
    const result=await f.run('orders-resume');
    assert.equal(result.startIndex,3); assert.equal(f.clicks,2);
    await f.run('orders-resume'); assert.equal(f.clicks,2);
  } finally {await f.close();}
});
