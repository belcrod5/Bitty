import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { openOperation, readOperation, runCartAddition, openCart, cartView } from './cart.mjs';
import { createRouteHandler, authentication } from './navigation.mjs';

const asin = 'B012345678';
let browser, directory;
before(async () => { directory = await mkdtemp(join(tmpdir(), 'shopping-test-')); browser = await chromium.launch({channel:'chrome',headless:true,args:['--host-resolver-rules=MAP www.amazon.co.jp ~NOTFOUND, MAP m.media-amazon.com ~NOTFOUND']}); });
after(async () => { await browser?.close(); await rm(directory, {recursive:true,force:true}); });

async function fixture({ challenge = false, lost = false, quantity = 1, buyBox = false, opaqueAdd = false, smartWagon = false } = {}) {
  const context = await browser.newContext({serviceWorkers:'block'});
  const page = await context.newPage();
  page.setDefaultTimeout(1500);
  const attempt = { armed:false, consumed:false };
  let posts=0;
  const clicked=[];
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    let html='';
    if (url.pathname.startsWith('/dp/')) html=`<h1 id="productTitle">Test apron</h1><form method="post" action="${buyBox ? '/gp/product/handle-buy-box/ref=one' : '/cart/add-to-cart/ref=one'}"><input name="ASIN" value="${asin}"><select id="quantity" name="quantity"><option>${quantity}</option></select>${buyBox ? '<input type="hidden" name="isBuyNow" value="1"><button name="submit.buy-now" value="1">今すぐ買う</button>' : ''}<button id="add-to-cart-button" name="submit.add-to-cart" formaction="/cart/add-to-cart/ref=one">カートに入れる</button></form><div id="sns-atc-container" hidden><button id="add-to-cart-button">定期おトク便をカートに追加</button></div><a id="nav-cart" href="/cart">カート</a>`;
    else if (url.pathname.startsWith('/cart/add-to-cart')) {
      if (req.method()==='POST') {
        posts++;
        assert.equal((await readOperation(directory, 'current')).addition, 'submitted');
        if (lost) return route.fulfill({status:502,contentType:'text/html',body:'Confirmation response unavailable'});
      }
      if(smartWagon) return route.fulfill({contentType:'text/html',body:'<script>location.replace("/cart/smart-wagon")</script>'});
      html=`<div id="sw-atc-details-single-container">カートに入れました<a href="/dp/${asin}">Test apron</a></div><a href="/cart?ref_=sw_gtc">カートに移動</a>`;
    } else if(url.pathname==='/cart/smart-wagon') {
      html=`<div id="sw-atc-details-single-container"><h1>カートに入れました</h1><a href="/gp/product/${asin}/ref=sw_img_1">Test apron</a></div><a href="/cart">カートに移動</a>`;
    } else if (url.pathname==='/cart') {
      if (challenge) return route.fulfill({contentType:'text/html',body:'<script>location.replace("/checkpoint/continue?token=SECRET")</script>'});
      html=`<h1>ショッピングカート</h1><div id="sc-active-cart"><div class="sc-list-item" data-asin="${asin}"><span class="sc-product-title">Test apron</span><select name="quantity"><option>1</option></select></div></div>`;
    } else if (url.pathname==='/checkpoint/continue') html='<label><input type="checkbox">私は人間です</label><button>ショッピングを続ける</button>';
    else return route.abort('blockedbyclient');
    return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html><body>${html}</body></html>`});
  });
  const guard = createRouteHandler('cart-add',attempt,asin,()=>{});
  // Model a POST that the Service Worker hides from page.route, without
  // requiring a worker or an external Amazon request in this fixture.
  await page.route('**/*', route => opaqueAdd && (route.request().method() === 'POST' || new URL(route.request().url()).pathname === '/cart/smart-wagon') ? route.fallback() : guard(route));
  const mouse={click:async (locator,label,{beforeMouseDown}={}) => { clicked.push(label); await beforeMouseDown?.(); await locator.click(); }};
  await page.goto(`https://www.amazon.co.jp/dp/${asin}`);
  return {context,page,attempt,mouse,clicked,get posts(){return posts;}};
}
async function cleanupOperation() { await rm(join(directory,'current.json'),{force:true}); }

async function clothing(page) {
  await page.locator('body').evaluate(body => body.insertAdjacentHTML('beforeend', `<div id="inline-twister-row-color_name"><span class="inline-twister-dim-title-value">ブラック</span></div><div id="variation_size_name"><span class="selection">L</span></div><div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">￥1,648</span></span></div>`));
}

test('AI-selected color, size and arbitrary type are added in-place without navigation or specific flags', async () => {
  await cleanupOperation(); const f = await fixture();
  let op = await openOperation(directory,'current',asin,{maxPrice:1648});
  try {
    await clothing(f.page);
    await f.page.locator('body').evaluate(body => body.insertAdjacentHTML('beforeend', '<div id="variation_style_name"><span class="selection">ジップ式</span></div>'));
    const result=await runCartAddition({...f,operation:op,identity:'fixture',log:()=>{},timeout:1000});
    assert.equal(result.addition,'confirmed'); assert.equal(f.posts,1);
    assert.deepEqual(result.selection.options,[{dimension:'color_name',selected:'ブラック'},{dimension:'size_name',selected:'L'},{dimension:'style_name',selected:'ジップ式'}]);
    await op.release();
    await assert.rejects(openOperation(directory,'current',asin,{maxPrice:2000}), /条件を変更/);
    op=await openOperation(directory,'current',asin);
    const resumed=await runCartAddition({...f,operation:op,identity:'fixture',log:()=>{},timeout:1000});
    assert.equal(resumed.addition,'confirmed'); assert.equal(f.posts,1); assert.equal(resumed.constraints.maxPrice,1648);
  } finally { await op.release(); await f.context.close(); }
});

test('price ceiling and any changed or newly appeared selection stop before submission', async () => {
  for (const scenario of ['price','size','new-type','beyond-six']) {
    await cleanupOperation(); const f=await fixture(); const op=await openOperation(directory,'current',asin,{maxPrice:scenario==='price'?1647:1648});
    try {
      await clothing(f.page);
      if(scenario==='beyond-six') await f.page.locator('body').evaluate(body => body.insertAdjacentHTML('beforeend', Array.from({length:6},(_,i)=>`<div id="variation_custom_${i}"><span class="selection">A</span></div>`).join('')));
      const mouse={click:async (locator,label,{beforeMouseDown})=>{
        if(scenario==='size') await f.page.locator('#variation_size_name .selection').evaluate(e=>e.textContent='M');
        if(scenario==='new-type') await f.page.locator('body').evaluate(body=>body.insertAdjacentHTML('beforeend','<div id="variation_style_name"><span class="selection">タイプB</span></div>'));
        if(scenario==='beyond-six') await f.page.locator('#variation_custom_5 .selection').evaluate(e=>e.textContent='B');
        await beforeMouseDown(); await locator.click();
      }};
      await assert.rejects(runCartAddition({...f,mouse,operation:op,identity:'fixture',log:()=>{}}), /価格|変わりました/);
      assert.equal(f.posts,0); assert.equal(op.data.addition,'not_started');
    } finally {await op.release(); await f.context.close();}
  }
});

test('cart reads the current price and clean title, and prefers the header over a covered success-panel link', async () => {
  const f=await fixture();
  try {
    await f.page.setContent(`<h1>カートに入れました</h1><a id="nav-cart" href="/cart">カート</a><a style="display:none" href="/cart">カートに移動</a>`);
    const clicked=[];
    await openCart(f.page,{click:async locator=>{clicked.push(await locator.getAttribute('id')); await locator.click();}},()=>{});
    assert.deepEqual(clicked,['nav-cart']); assert.equal(f.posts,0);
    await f.page.locator('.sc-list-item').evaluate(item=>{
      item.setAttribute('data-producttitle','Black fleece LL');
      item.insertAdjacentHTML('beforeend','<span data-feature-id="sc-item-price"><span class="a-price a-text-price"><span class="a-offscreen">￥9,999</span></span><span class="apex-price-to-pay-value"><span class="a-offscreen">￥1,648</span></span></span><li class="sc-product-variation">サイズ: LL</li><li class="sc-product-variation">色: 黒</li>');
    });
    const view=await cartView(f.page);
    assert.equal(view.items[0].priceText,'￥1,648'); assert.equal(view.items[0].title,'Black fleece LL');
    assert.deepEqual(view.items[0].variantText,['サイズ: LL','色: 黒']);
  } finally { await f.context.close(); }
});

test('quantity1 add is confirmed, then cart contents are read; journal precedes POST', async () => {
  await cleanupOperation(); const f=await fixture(); const op=await openOperation(directory,'current',asin);
  try {
    const result=await runCartAddition({...f,operation:op,identity:'fixture',log:()=>{},timeout:1000});
    assert.equal(result.addition,'confirmed'); assert.equal(result.retryAdd,false); assert.equal(result.cart,'visible'); assert.equal(result.items[0].quantity,'1'); assert.equal(f.posts,1);
    assert.deepEqual(f.clicked,['add to cart','cart link']);
  } finally { await op.release(); await f.context.close(); }
});
test('ordinary form with isBuyNow=1 selects the visible add button and not the hidden subscription button', async () => {
  await cleanupOperation(); const f=await fixture({buyBox:true}); const op=await openOperation(directory,'current',asin);
  try {
    const result=await runCartAddition({...f,operation:op,identity:'fixture',log:()=>{},timeout:1000});
    assert.equal(result.addition,'confirmed'); assert.equal(result.cart,'visible'); assert.equal(f.posts,1);
    assert.deepEqual(f.clicked,['add to cart','cart link']);
  } finally { await op.release(); await f.context.close(); }
});
test('success confirmation does not depend on seeing a Service Worker POST, and retry cannot click again', async () => {
  await cleanupOperation(); const f=await fixture({buyBox:true,opaqueAdd:true}); const op=await openOperation(directory,'current',asin);
  try {
    const result=await runCartAddition({...f,operation:op,identity:'fixture',log:()=>{},timeout:1000});
    assert.equal(f.attempt.consumed,false); assert.equal(result.addition,'confirmed');
    assert.equal(result.cart,'visible'); assert.equal(f.posts,1);
    await runCartAddition({...f,operation:op,identity:'fixture',log:()=>{},timeout:1000});
    assert.equal(f.posts,1); assert.equal(f.clicked.filter(x=>x==='add to cart').length,1);
  } finally { await op.release(); await f.context.close(); }
});
test('smart-wagon success with a gp/product link confirms the target without depending on page routing', async () => {
  await cleanupOperation(); const f=await fixture({buyBox:true,opaqueAdd:true,smartWagon:true}); const op=await openOperation(directory,'current',asin);
  try {
    const result=await runCartAddition({...f,operation:op,identity:'fixture',log:()=>{},timeout:1000});
    assert.equal(result.addition,'confirmed'); assert.equal(result.cart,'visible'); assert.equal(f.posts,1);
    // Recreate the observed unknown journal while leaving the target's success
    // display in place. Recovery must read it without another add click.
    await f.page.goto('https://www.amazon.co.jp/cart/smart-wagon');
    await op.update({addition:'unknown',retryAdd:false,code:'ADDITION_UNKNOWN'});
    const clicks=f.clicked.filter(x=>x==='add to cart').length;
    const recovered=await runCartAddition({...f,operation:op,identity:'fixture',log:()=>{},timeout:1000});
    assert.equal(recovered.addition,'confirmed'); assert.equal(recovered.cart,'visible');
    assert.equal(f.posts,1); assert.equal(f.clicked.filter(x=>x==='add to cart').length,clicks);
    await op.update({addition:'unknown',retryAdd:false});
    const unproven=await runCartAddition({...f,operation:op,identity:'fixture',log:()=>{},timeout:1000});
    assert.equal(unproven.addition,'unknown'); assert.equal(f.posts,1);
  } finally { await op.release(); await f.context.close(); }
});
test('changed quantity during mouse movement and a buy-now submitter are rejected before submission', async () => {
  await cleanupOperation(); const f=await fixture({buyBox:true}); const op=await openOperation(directory,'current',asin);
  try {
    await f.page.locator('#add-to-cart-button:visible').evaluate(e=>e.name='submit.buy-now');
    await assert.rejects(runCartAddition({...f,operation:op,identity:'fixture',log:()=>{}}),/purchase_control/);
    assert.equal(f.posts,0); assert.equal(op.data.addition,'not_started');
    await f.page.locator('#add-to-cart-button:visible').evaluate(e=>e.name='submit.add-to-cart');
    const changingMouse={click:async (locator,label,{beforeMouseDown})=>{
      await f.page.locator('#quantity').evaluate(e=>e.add(new Option('2','2',true,true)));
      await beforeMouseDown();
      await locator.click();
    }};
    await assert.rejects(runCartAddition({...f,mouse:changingMouse,operation:op,identity:'fixture',log:()=>{}}),/数量が1/);
    assert.equal(f.posts,0); assert.equal(op.data.addition,'not_started');
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

test('CDP inspection keeps existing Chrome/tab alive, cleans routes and redacts auth logs', async t => {
  const { main, options } = await import('./search.mjs');
  const profile = await mkdtemp(join(tmpdir(),'shopping-cdp-'));
  const owned = await chromium.launchPersistentContext(profile,{channel:'chrome',headless:true,args:['--remote-debugging-port=0','--host-resolver-rules=MAP www.amazon.co.jp ~NOTFOUND, MAP m.media-amazon.com ~NOTFOUND']});
  const page=owned.pages()[0];
  await owned.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<div id="sc-active-cart">Empty cart</div>'}));
  await page.goto('https://www.amazon.co.jp/cart');
  const endpoint='http://127.0.0.1:'+(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];
  const { discoverBrowsers } = await import('./browser.mjs');
  assert.ok((await discoverBrowsers()).browsers.some(b=>b.endpoint===endpoint));
  const output=[]; const originalLog=console.log; const previousExit=process.exitCode;
  try {
    console.log=(...v)=>output.push(v.join(' '));
    await main(options(['cart','--cdp','auto']));
    assert.ok(output.some(v=>v.includes('\"success\":true')), output.join('\n'));
    assert.equal(page.isClosed(),false);
    assert.equal(await page.evaluate(()=>document.querySelector('#sc-active-cart')!==null),true);
    // A leaked cart guard would reject this mocked request. No network is used.
    assert.equal(await page.evaluate(async()=> (await fetch('/cart/delete')).ok),true);
    // Resolve only the test's chrome channel to its isolated browser. Never
    // discover or request permission from the user's real default profile.
    const connect = chromium.connectOverCDP.bind(chromium);
    const channel = t.mock.method(chromium,'connectOverCDP',async (name,config) => {
      assert.equal(name,'chrome'); assert.equal(config.noDefaults,true);
      return connect(endpoint,config);
    });
    try {
      const previousURL=page.url();
      output.length=0;
      await main(options(['browser-status','--cdp','chrome']));
      assert.equal(channel.mock.callCount(),1);
      assert.equal(page.url(),previousURL); assert.equal(page.isClosed(),false);
      assert.ok(output.some(line=>line.includes('"success":true') && line.includes('"tabs":')));
    } finally { channel.mock.restore(); }
    await page.goto('https://www.amazon.co.jp/checkpoint/continue?token=SECRET');
    output.length=0;
    await main(options(['cart','--cdp','auto']));
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

for (const extensionConnection of [false,true]) test(`full CLI ${extensionConnection?'extension':'direct'} records confirmed+verification and does not add again on rerun`, async () => {
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
    const config={...options(['cart-add','--asin',asin,'--operation',id,'--cdp',endpoint]),extensionConnection};
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

test('quantity comes from the selected submitter form, including hidden, indexed and item-scoped fields', async () => {
  for (const scenario of ['hidden-with-foreign-two', 'id-wrapper', 'indexed', 'item-scoped', 'form-attribute']) {
    await cleanupOperation(); const f=await fixture(); const op=await openOperation(directory,'current',asin);
    const events=[];
    try {
      await f.page.locator('#add-to-cart-button:visible').evaluate((button,scenario)=>{
        const form=button.form, quantity=form.elements.namedItem('quantity');
        form.id='target';quantity.removeAttribute('id');
        if(scenario==='hidden-with-foreign-two'){
          quantity.outerHTML='<input type="hidden" name="quantity" value="1">';
          form.insertAdjacentHTML('beforebegin','<form><input id="quantity" name="quantity" value="2"></form>');
        }
        if(scenario==='id-wrapper')quantity.insertAdjacentHTML('beforebegin','<span id="quantity">数量</span>');
        if(scenario==='indexed')quantity.name='quantity.1';
        if(scenario==='item-scoped'){
          quantity.name='items[0.base][quantity]';
          form.insertAdjacentHTML('beforeend','<input name="items[0.base][asin]" value="B012345678">');
        }
        if(scenario==='form-attribute'){
          quantity.remove();form.insertAdjacentHTML('afterend','<input form="target" name="quantity" value="1">');
        }
      },scenario);
      const result=await runCartAddition({...f,operation:op,identity:'fixture',log:(event,data)=>events.push({event,...data}),timeout:1000});
      assert.equal(result.addition,'confirmed',scenario);assert.equal(f.posts,1);
      const checks=events.filter(e=>e.event==='cart-add-form-check');
      assert.deepEqual(checks.map(e=>e.stage),['initial','before_mouse_down']);
      assert.ok(checks.every(e=>e.quantity.quantity===1&&e.quantity.source==='submitter_form_data'));
      if(scenario==='hidden-with-foreign-two')assert.equal(checks[0].pageQuantity[0].belongsToForm,false);
    }finally{await op.release();await f.context.close();}
  }
});

test('missing, two, unknown, disabled, duplicate and foreign quantities stop before any add click and log only relevant values', async () => {
  for(const scenario of ['missing','two','empty','disabled','duplicate','unknown-name','buy-now-only','nested-two','nested-wrong-asin','other-item']){
    await cleanupOperation();const f=await fixture();const op=await openOperation(directory,'current',asin);const events=[];
    try{
      await f.page.locator('#add-to-cart-button:visible').evaluate((button,scenario)=>{
        const form=button.form,q=form.elements.namedItem('quantity');q.id='own-quantity';
        form.insertAdjacentHTML('beforebegin','<form id="unrelated"><input id="quantity" name="quantity" value="1"></form>');
        form.insertAdjacentHTML('beforeend','<input name="anti-csrftoken-a2z" value="SECRET_CSRF_VALUE"><input name="session-id" value="SECRET_SESSION_VALUE">');
        if(['missing','buy-now-only'].includes(scenario))q.remove();
        if(scenario==='two')q.innerHTML='<option value="2">2</option>';
        if(scenario==='empty')q.innerHTML='<option value="">不明</option>';
        if(scenario==='disabled')q.disabled=true;
        if(scenario==='duplicate')form.insertAdjacentHTML('beforeend','<input name="quantity" value="1">');
        if(scenario==='unknown-name')q.name='quantityBox';
        if(scenario==='buy-now-only')form.insertAdjacentHTML('beforeend','<div id="buyNow"><script type="a-state" data-a-state=\'{"key":"turbo-checkout-product-state"}\'>{"lineItemInputs":[{"asin":"B012345678","quantity":"1"}]}</script></div>');
        if(scenario.startsWith('nested-')||scenario==='other-item'){
          q.name=scenario==='other-item'?'items[1.base][quantity]':'items[0.base][quantity]';
          if(scenario==='nested-two')q.innerHTML='<option value="2">2</option>';
          form.insertAdjacentHTML('beforeend',`<input name="items[0.base][asin]" value="${scenario==='nested-wrong-asin'?'B099999999':'B012345678'}">`);
        }
      },scenario);
      await assert.rejects(runCartAddition({...f,operation:op,identity:'fixture',log:(event,data)=>events.push({event,...data})}),e=>e.code==='QUANTITY_UNVERIFIED',scenario);
      assert.equal(f.posts,0);assert.deepEqual(f.clicked,[]);assert.equal(op.data.addition,'not_started');
      const diagnostic=events.find(e=>e.event==='cart-add-form-check');assert.ok(diagnostic.quantity.reason);
      assert.equal(diagnostic.pageQuantity[0].belongsToForm,false);
      assert.equal(JSON.stringify(events).includes('SECRET_CSRF_VALUE'),false);assert.equal(JSON.stringify(events).includes('SECRET_SESSION_VALUE'),false);
      if(scenario==='missing'){
        assert.equal(diagnostic.quantity.reason,'missing');assert.equal(diagnostic.quantityControlCount,0);assert.deepEqual(diagnostic.quantity.fields,[]);
      }
    }finally{await op.release();await f.context.close();}
  }
});

test('a quantity change immediately before mouse-down is diagnosed and remains unsubmitted',async()=>{
  await cleanupOperation();const f=await fixture();const op=await openOperation(directory,'current',asin);const events=[];
  try{
    const mouse={click:async(locator,label,{beforeMouseDown})=>{
      await locator.evaluate(button=>{button.form.elements.namedItem('quantity').innerHTML='<option value="2">2</option>';});
      await beforeMouseDown();throw new Error('Must not reach mouse-down');
    }};
    await assert.rejects(runCartAddition({...f,mouse,operation:op,identity:'fixture',log:(event,data)=>events.push({event,...data})}),e=>e.code==='QUANTITY_UNVERIFIED');
    const checks=events.filter(e=>e.event==='cart-add-form-check');
    assert.equal(checks[0].quantity.quantity,1);assert.equal(checks[1].stage,'before_mouse_down');assert.equal(checks[1].quantity.reason,'not_one');
    assert.equal(f.posts,0);assert.equal(op.data.addition,'not_started');
  }finally{await op.release();await f.context.close();}
});
