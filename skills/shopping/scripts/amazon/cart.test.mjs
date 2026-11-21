import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { openOperation, readOperation, runCartAddition, openCart } from './cart.mjs';
import { createRouteHandler, authentication } from './navigation.mjs';

const asin = 'B012345678';
let browser, directory;
before(async () => { directory = await mkdtemp(join(tmpdir(), 'shopping-test-')); browser = await chromium.launch({channel:'chrome',headless:true,args:['--host-resolver-rules=MAP www.amazon.co.jp ~NOTFOUND, MAP m.media-amazon.com ~NOTFOUND']}); });
after(async () => { await browser?.close(); await rm(directory, {recursive:true,force:true}); });

async function fixture({ challenge = false, lost = false, quantity = 1 } = {}) {
  const context = await browser.newContext({serviceWorkers:'block'});
  const page = await context.newPage();
  page.setDefaultTimeout(1500);
  const attempt = { armed:false, consumed:false };
  let posts=0;
  const clicked=[];
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    let html='';
    if (url.pathname.startsWith('/dp/')) html=`<h1 id="productTitle">Test apron</h1><form method="post" action="/cart/add-to-cart/ref=one"><input name="ASIN" value="${asin}"><select id="quantity" name="quantity"><option>${quantity}</option></select><button id="add-to-cart-button">カートに入れる</button></form><a id="nav-cart" href="/cart">カート</a>`;
    else if (url.pathname.startsWith('/cart/add-to-cart')) {
      if (req.method()==='POST') {
        posts++;
        assert.equal((await readOperation(directory, 'current')).addition, 'submitted');
        if (lost) return route.fulfill({status:502,contentType:'text/html',body:'Confirmation response unavailable'});
      }
      html=`<div id="sw-atc-details-single-container">カートに入れました<a href="/dp/${asin}">Test apron</a></div><a href="/cart?ref_=sw_gtc">カートに移動</a>`;
    } else if (url.pathname==='/cart') {
      if (challenge) return route.fulfill({contentType:'text/html',body:'<script>location.replace("/checkpoint/continue?token=SECRET")</script>'});
      html=`<h1>ショッピングカート</h1><div id="sc-active-cart"><div class="sc-list-item" data-asin="${asin}"><span class="sc-product-title">Test apron</span><select name="quantity"><option>1</option></select></div></div>`;
    } else if (url.pathname==='/checkpoint/continue') html='<label><input type="checkbox">私は人間です</label><button>ショッピングを続ける</button>';
    else return route.abort('blockedbyclient');
    return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html><body>${html}</body></html>`});
  });
  await page.route('**/*',createRouteHandler('cart-add',attempt,asin,()=>{}));
  const mouse={click:async (locator,label,{beforeMouseDown}={}) => { clicked.push(label); await beforeMouseDown?.(); await locator.click(); }};
  await page.goto(`https://www.amazon.co.jp/dp/${asin}`);
  return {context,page,attempt,mouse,clicked,get posts(){return posts;}};
}
async function cleanupOperation() { await rm(join(directory,'current.json'),{force:true}); }

test('quantity1 add is confirmed, then cart contents are read; journal precedes POST', async () => {
  await cleanupOperation(); const f=await fixture(); const op=await openOperation(directory,'current',asin);
  try {
    const result=await runCartAddition({...f,operation:op,identity:'fixture',log:()=>{},timeout:1000});
    assert.equal(result.addition,'confirmed'); assert.equal(result.retryAdd,false); assert.equal(result.cart,'visible'); assert.equal(result.items[0].quantity,'1'); assert.equal(f.posts,1);
    assert.deepEqual(f.clicked,['add to cart','cart link']);
  } finally { await op.release(); await f.context.close(); }
});
test('challenge AFTER confirmation preserves addition; rerun never submits again', async () => {
  await cleanupOperation(); const f=await fixture({challenge:true}); let op=await openOperation(directory,'current',asin);
  try {
    const result=await runCartAddition({...f,operation:op,identity:'fixture',log:()=>{},timeout:1000});
    assert.equal(result.addition,'confirmed'); assert.equal(result.cart,'verification_required'); assert.equal(result.retryAdd,false); assert.equal(f.posts,1);
    await op.release(); op=await openOperation(directory,'current',asin);
    await runCartAddition({...f,operation:op,identity:'fixture',log:()=>{},timeout:1000});
    assert.equal(f.posts,1); assert.equal(f.clicked.filter(x=>x==='add to cart').length,1);
    assert.equal((await readFile(join(directory,'current.json'),'utf8')).includes('SECRET'),false);
  } finally { await op.release(); await f.context.close(); }
});
test('lost response is UNKNOWN and restart cannot repeat the add', async () => {
  await cleanupOperation(); const f=await fixture({lost:true}); let op=await openOperation(directory,'current',asin);
  try {
    const result=await runCartAddition({...f,operation:op,identity:'fixture',log:()=>{},timeout:300});
    assert.equal(result.addition,'unknown'); assert.equal(result.retryAdd,false); assert.equal(f.posts,1);
    await op.release(); op=await openOperation(directory,'current',asin);
    await runCartAddition({...f,operation:op,identity:'fixture',log:()=>{},timeout:300}); assert.equal(f.posts,1);
  } finally { await op.release(); await f.context.close(); }
});
test('quantity other than1 never clicks or sends a mutation', async () => {
  await cleanupOperation(); const f=await fixture({quantity:2}); const op=await openOperation(directory,'current',asin);
  try {
    await assert.rejects(runCartAddition({...f,operation:op,identity:'fixture',log:()=>{}}),/数量が1/);
    assert.equal(f.posts,0); assert.equal(f.clicked.length,0); assert.equal(op.data.addition,'not_started');
  } finally { await op.release(); await f.context.close(); }
});
test('concurrency lock and operation ASIN mismatch reject before browser effects', async () => {
  const op=await openOperation(directory,'locked',asin);
  try { await assert.rejects(openOperation(directory,'locked',asin),/OPERATION_LOCKED/); }
  finally { await op.release(); }
  await assert.rejects(openOperation(directory,'locked','B099999999'),/ASIN/);
});
test('persisted submission from a crash is never sent again', async () => {
  const op=await openOperation(directory,'crashed',asin);
  await op.update({addition:'submitted',retryAdd:false}); await op.release();
  const reopened=await openOperation(directory,'crashed',asin);
  try {
    const result=await runCartAddition({operation:reopened,page:null,mouse:null,attempt:{},identity:'fixture',log:()=>{}});
    assert.equal(result.addition,'unknown'); assert.equal(result.retryAdd,false);
  } finally { await reopened.release(); }
});
test('verification DOM is recognized even at an ordinary product URL', async () => {
  const f=await fixture();
  try { await f.page.setContent('<h1>私は人間です</h1>'); assert.equal(await authentication(f.page),'verification_required'); }
  finally { await f.context.close(); }
});

test('CDP inspection keeps existing Chrome/tab alive, cleans routes and redacts auth logs', async () => {
  const { main, options } = await import('./search.mjs');
  const profile = await mkdtemp(join(tmpdir(),'shopping-cdp-'));
  const owned = await chromium.launchPersistentContext(profile,{channel:'chrome',headless:true,args:['--remote-debugging-port=0','--host-resolver-rules=MAP www.amazon.co.jp ~NOTFOUND, MAP m.media-amazon.com ~NOTFOUND']});
  const page=owned.pages()[0];
  await owned.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<div id="sc-active-cart">Empty cart</div>'}));
  await page.goto('https://www.amazon.co.jp/cart');
  const endpoint='http://127.0.0.1:'+(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];
  const output=[]; const originalLog=console.log; const previousExit=process.exitCode;
  try {
    console.log=(...v)=>output.push(v.join(' '));
    await main(options(['cart','--cdp',endpoint]));
    assert.ok(output.some(v=>v.includes('\"success\":true')), output.join('\n'));
    assert.equal(page.isClosed(),false);
    assert.equal(await page.evaluate(()=>document.querySelector('#sc-active-cart')!==null),true);
    // A leaked cart guard would reject this mocked request. No network is used.
    assert.equal(await page.evaluate(async()=> (await fetch('/cart/delete')).ok),true);
    await page.goto('https://www.amazon.co.jp/checkpoint/continue?token=SECRET');
    output.length=0;
    await main(options(['cart','--cdp',endpoint]));
    assert.equal(process.exitCode,2);
    assert.equal(output.join('\n').includes('SECRET'),false);
    const artifacts=output.find(v=>v.startsWith('Artifacts: ')).slice(11);
    const { readdir }=await import('node:fs/promises');
    assert.deepEqual((await readdir(artifacts)).sort(),['events.json','result.json']);
    const result=JSON.parse(await readFile(join(artifacts,'result.json')));
    assert.equal(result.cart,'verification_required');
    assert.equal(page.isClosed(),false);
  } finally { console.log=originalLog; process.exitCode=previousExit; await owned.close(); await rm(profile,{recursive:true,force:true}); }
});

test('full CLI over CDP records confirmed+verification and does not add again on rerun', async () => {
  const { main, options } = await import('./search.mjs');
  const profile = await mkdtemp(join(tmpdir(),'shopping-cli-'));
  const id='test-'+profile.split('/').at(-1);
  const operationFile=new URL(`./.operations/${id}.json`,import.meta.url);
  const owned=await chromium.launchPersistentContext(profile,{channel:'chrome',headless:true,args:['--remote-debugging-port=0','--host-resolver-rules=MAP www.amazon.co.jp ~NOTFOUND']});
  const page=owned.pages()[0]; let posts=0;
  await owned.route('**/*', async route => {
    const req=route.request(), url=new URL(req.url()); let html='';
    if(url.pathname.startsWith('/dp/')) html=`<h1 id="productTitle">Mock apron</h1><form method="post" action="/cart/add-to-cart/ref=test"><input name="ASIN" value="${asin}"><select id="quantity" name="quantity"><option>1</option></select><button id="add-to-cart-button">カートに入れる</button></form>`;
    else if(url.pathname.startsWith('/cart/add-to-cart')) { if(req.method()==='POST') posts++; html=`<div id="sw-atc-details-single-container">カートに入れました<a href="/dp/${asin}">Mock apron</a></div><a href="/cart">カートに移動</a>`; }
    else if(url.pathname==='/cart') html='<script>location.replace("/checkpoint/continue?token=SECRET")</script>';
    else if(url.pathname==='/checkpoint/continue') html='<h1>私は人間です</h1><button>ショッピングを続ける</button>';
    else return route.abort();
    await route.fulfill({contentType:'text/html; charset=utf-8',body:html});
  });
  await page.goto(`https://www.amazon.co.jp/dp/${asin}`);
  const endpoint='http://127.0.0.1:'+(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];
  const output=[], previousLog=console.log, previousExit=process.exitCode;
  try {
    console.log=(...v)=>output.push(v.join(' '));
    const config=options(['cart-add','--asin',asin,'--operation',id,'--cdp',endpoint]);
    await main(config);
    const state=JSON.parse(await readFile(operationFile));
    assert.equal(state.addition,'confirmed',output.join('\n')); assert.equal(state.cart,'verification_required'); assert.equal(state.retryAdd,false); assert.equal(posts,1); assert.equal(process.exitCode,2);
    await main(config);
    assert.equal(posts,1); assert.equal(page.isClosed(),false); assert.equal(output.join('\n').includes('SECRET'),false);
  } finally { console.log=previousLog; process.exitCode=previousExit; await owned.close(); await rm(profile,{recursive:true,force:true}); await rm(operationFile,{force:true}); }
});

test('cart navigation failure keeps confirmed addition and resume only opens cart', async () => {
  await cleanupOperation(); const f=await fixture(); const op=await openOperation(directory,'current',asin);
  const failureMouse={click:async (locator,label,opts) => { if(label==='cart link') throw new Error('lost cart navigation'); return f.mouse.click(locator,label,opts); }};
  try {
    await assert.rejects(runCartAddition({...f,mouse:failureMouse,operation:op,identity:'fixture',log:()=>{},timeout:300}),/lost cart/);
    assert.equal(op.data.addition,'confirmed'); assert.equal(op.data.retryAdd,false); assert.equal(op.data.cart,'unknown');
    await runCartAddition({...f,operation:op,identity:'fixture',log:()=>{},timeout:1000}); assert.equal(f.posts,1); assert.equal(op.data.cart,'visible');
    await f.page.locator('#sc-active-cart').evaluate(e=>e.innerHTML='Empty cart');
    await runCartAddition({...f,operation:op,identity:'fixture',log:()=>{},timeout:1000});
    assert.equal(op.data.addition,'confirmed'); assert.equal(op.data.targetPresent,false); assert.equal(op.data.code,'ITEM_NOT_IN_CART'); assert.equal(f.posts,1);
  } finally { await op.release(); await f.context.close(); }
});
test('verification before add and a mismatched form ASIN both prevent submission', async () => {
  await cleanupOperation(); const f=await fixture(); const op=await openOperation(directory,'current',asin);
  try {
    await f.page.locator('input[name="ASIN"]').evaluate(e=>e.value='B099999999');
    await assert.rejects(runCartAddition({...f,operation:op,identity:'fixture',log:()=>{}}),/ASIN/);
    assert.equal(f.posts,0);
    await f.page.setContent('<h1>私は人間です</h1>');
    const result=await runCartAddition({...f,operation:op,identity:'fixture',log:()=>{}});
    assert.equal(result.addition,'not_started'); assert.equal(result.cart,'verification_required'); assert.equal(f.posts,0);
  } finally { await op.release(); await f.context.close(); }
});
