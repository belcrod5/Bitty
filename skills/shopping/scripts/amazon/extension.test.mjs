import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { inspectExistingCart } from './extension.mjs';

test('extension cart helper reads active items without clicks or navigation and redacts authentication URLs', async () => {
  const browser = await chromium.launch({channel:'chrome', headless:true, args:['--host-resolver-rules=MAP www.amazon.co.jp ~NOTFOUND']});
  const context = await browser.newContext({serviceWorkers:'block'});
  const page = await context.newPage();
  const requests=[];
  await context.route('**/*', route => {
    requests.push(route.request().method());
    return route.fulfill({contentType:'text/html; charset=utf-8', body:'<main id="sc-active-cart"><div class="sc-list-item" data-asin="B084QBPLKZ" data-quantity="1"><span class="sc-product-title"><span class="a-truncate-full">Test apron</span><span>Duplicate shortened title</span></span></div></main><aside id="sc-saved-cart"><div class="sc-list-item" data-asin="B000000000">Saved item</div></aside>'});
  });
  const tab={url:()=>page.url(),playwright:page};
  try {
    await page.goto('https://www.amazon.co.jp/cart?token=SECRET#frag');
    const count=requests.length;
    const result=await inspectExistingCart(tab,'B084QBPLKZ');
    assert.equal(result.cart,'visible'); assert.equal(result.targetPresent,true);
    assert.deepEqual(result.items,[{asin:'B084QBPLKZ', title:'Test apron',quantity:'1'}]);
    assert.equal((await inspectExistingCart(tab,'B000000000')).code,'ITEM_NOT_IN_CART');
    assert.equal(JSON.stringify(result).includes('SECRET'),false);
    assert.equal(requests.length,count); assert.ok(requests.every(m=>m==='GET'));
    await page.goto('https://www.amazon.co.jp/checkpoint/continue?token=SECRET');
    const auth=await inspectExistingCart(tab,'B084QBPLKZ');
    assert.equal(auth.cart,'verification_required'); assert.equal(auth.items,undefined);
    assert.equal(JSON.stringify(auth).includes('SECRET'),false);
    await page.goto('https://www.amazon.co.jp/ap/signin?token=SECRET');
    assert.equal((await inspectExistingCart(tab)).cart,'login_required');
    await page.goto('https://www.amazon.co.jp/dp/B084QBPLKZ');
    assert.equal((await inspectExistingCart(tab)).code,'CART_NOT_VISIBLE');
    await page.setContent('<body>私は人間です</body>');
    assert.equal((await inspectExistingCart(tab)).cart,'verification_required');
    await assert.rejects(inspectExistingCart(tab,'invalid'),/ASIN/);
    await assert.rejects(inspectExistingCart({url:()=> 'https://example.com/cart'}),/Amazon/);
  } finally { await browser.close(); }
});

import { before, after } from 'node:test';
import { runExistingChrome } from './extension.mjs';
let actionBrowser;
before(async () => { actionBrowser=await chromium.launch({channel:'chrome',headless:true,args:['--host-resolver-rules=MAP www.amazon.co.jp ~NOTFOUND']}); });
after(async () => { await actionBrowser?.close(); });

async function actionFixture({ordersAuth=false, cartHref='/cart', missingInput=false, empty=false, badForm=false, detailMismatch=false, focusLost=false, cartAuth=false, switchLink=false}={}) {
  const context=await actionBrowser.newContext({serviceWorkers:'block'});
  const page=await context.newPage(); page.setDefaultTimeout(1000);
  const requests=[],delays=[],typed=[];
  let switched=false;
  const header=`<form method="${badForm?'post':'get'}" action="${badForm?'/gp/buy/':'/s/ref=nb_sb_noss'}"><input id="${missingInput?'wrong':'twotabsearchtextbox'}" name="k" ${focusLost?'oninput="this.blur()"':''}><button id="nav-search-submit-button">検索</button></form><a id="nav-orders" href="/gp/css/order-history">注文履歴</a><a id="nav-cart" href="${cartHref}">カート</a>`;
  await context.route('**/*', route=>{
    const request=route.request(),url=new URL(request.url()); requests.push({method:request.method(),path:url.pathname});
    let body=header;
    if(url.pathname.startsWith('/s')) body+=empty?'<div>No results</div>':`<main id="search"><div data-component-type="s-search-result" data-asin="B084QBPLKZ"><a href="/dp/${detailMismatch?'B099999999':'B084QBPLKZ'}"><h2>Apron</h2></a></div><div data-component-type="s-search-result" data-asin="B012345678"><a href="/dp/B012345678"><h2>Pen</h2></a></div></main>`;
    else if(url.pathname.startsWith('/dp/')) body+='<h1 id="productTitle">Test product</h1><button id="buy-now-button">今すぐ買う</button>';
    else if(url.pathname==='/gp/css/order-history') body=ordersAuth?'<script>location.replace("/checkpoint/continue?token=SECRET")</script>':header+'<h1>注文履歴</h1>';
    else if(url.pathname.startsWith('/checkpoint/')) body='<h1>私は人間です</h1>';
    else if(url.pathname.startsWith('/cart/add-to-cart')) body+='<a href="/cart">カートに移動</a><button id="add-to-cart-button">カートに入れる</button>';
    else if(url.pathname==='/cart') body=cartAuth?'<script>location.replace("/checkpoint/continue?token=SECRET")</script>':body+'<main id="sc-active-cart"><div class="sc-list-item" data-asin="B084QBPLKZ" data-quantity="1"><span class="sc-product-title">Apron</span></div></main>';
    return route.fulfill({contentType:'text/html; charset=utf-8',body});
  });
  // Translate only option names, not browser behavior. The test browser performs
  // the actual focus, keyboard events, link clicks and DOM evaluation.
  function locatorAdapter(locator) {
    return new Proxy(locator,{get(target,key){
      const value=target[key];
      if(typeof value!=='function') return value;
      if(!['waitFor','count','isEnabled','click','evaluate','fill','pressSequentially','getAttribute','evaluateAll','first','isVisible','innerText','filter','nth','locator'].includes(key)) throw new Error('Undocumented extension locator API: '+String(key));
      return (...args)=>{
        if(key==='pressSequentially') typed.push(args[0]);
        const converted=args.map(arg=>arg && Object.getPrototypeOf(arg)===Object.prototype && 'timeoutMs' in arg?{...arg,timeout:arg.timeoutMs}:arg);
        const next=value.apply(target,converted);
        return ['locator','filter','first','nth','getByRole','getByText'].includes(key)?locatorAdapter(next):next;
      };
    }});
  }
  const playwright={
    locator:selector=>locatorAdapter(page.locator(selector)),
    getByRole:(...args)=>locatorAdapter(page.getByRole(...args)),
    getByText:(...args)=>locatorAdapter(page.getByText(...args)),
    waitForTimeout:async delay=>{
      delays.push(delay);
      if(switchLink && !switched && delay>=500) { switched=true; await page.locator('#nav-cart').evaluate(e=>e.href='/gp/buy/'); }
      if(delay===200) await page.waitForTimeout(10);
    },
  };
  const tab={url:()=>page.url(),playwright,goto:url=>page.goto(url)};
  await page.goto('https://www.amazon.co.jp/');
  return {tab,page,context,requests,delays,typed};
}

test('existing Chrome search types focused characters individually and clicks the GET search form',async()=>{
  const f=await actionFixture();
  try {
    const result=await runExistingChrome(f.tab,{command:'search',query:'ボールペン'});
    assert.equal(result.success,true); assert.equal(result.count,2); assert.equal(result.bezier,false);
    assert.deepEqual(f.typed,[...'ボールペン']); assert.equal(result.readOnly,false);
    assert.equal(await f.page.locator('#twotabsearchtextbox').inputValue(),''); // new results page
    assert.equal(result.events.filter(e=>e.type==='input').length,5);
    assert.equal(result.events.filter(e=>e.type==='click').length,2);
    assert.ok(result.events.every(e=>e.delayMs>=500 && e.delayMs<=1000));
    assert.equal(result.events.filter(e=>e.type==='input').length,f.typed.length);
    assert.ok(f.requests.every(r=>r.method==='GET'));
    assert.ok(f.requests.some(r=>r.path==='/s/ref=nb_sb_noss'));
  } finally { await f.context.close(); }
});
test('detail clicks requested search result and ASIN detail can navigate directly',async()=>{
  const f=await actionFixture();
  try {
    const found=await runExistingChrome(f.tab,{command:'detail',query:'pen',index:2});
    assert.equal(found.asin,'B012345678'); assert.equal(found.title,'Test product');
    assert.ok(found.events.some(e=>e.target==='product-link'));
    const direct=await runExistingChrome(f.tab,{command:'detail',asin:'B084QBPLKZ'});
    assert.equal(direct.asin,'B084QBPLKZ');
    const before=f.requests.length;
    assert.equal((await runExistingChrome(f.tab,{command:'detail',asin:'B084QBPLKZ'})).success,true);
    assert.equal(f.requests.length,before); // no gratuitous reload
    await assert.rejects(runExistingChrome(f.tab,{command:'detail',query:'pen',index:3}),/PRODUCT_INDEX_OUT_OF_RANGE/);
  } finally { await f.context.close(); }
});
test('orders and cart follow header links and existing cart can be read without another click',async()=>{
  const f=await actionFixture();
  try {
    const orders=await runExistingChrome(f.tab,{command:'orders'});
    assert.equal(orders.status,'orders'); assert.ok(orders.events.some(e=>e.target==='orders-link'));
    const cart=await runExistingChrome(f.tab,{command:'cart',asin:'B084QBPLKZ'});
    assert.equal(cart.cart,'visible'); assert.equal(cart.targetPresent,true); assert.equal(cart.readOnly,false);
    const count=f.requests.length;
    const again=await runExistingChrome(f.tab,{command:'cart',asin:'B084QBPLKZ'});
    assert.equal(again.readOnly,true); assert.equal(again.events.length,0); assert.equal(f.requests.length,count);
  } finally { await f.context.close(); }
});
test('authentication after link navigation is a separate outcome and never proceeds to another action',async()=>{
  const f=await actionFixture({ordersAuth:true});
  try {
    const auth=await runExistingChrome(f.tab,{command:'orders'});
    assert.equal(auth.success,false); assert.equal(auth.status,'verification_required');
    assert.equal(auth.code,'AUTH_REQUIRED'); assert.equal(JSON.stringify(auth).includes('SECRET'),false);
    const before=f.requests.length;
    const stopped=await runExistingChrome(f.tab,{command:'search',query:'pen'});
    assert.equal(stopped.code,'AUTH_REQUIRED'); assert.equal(stopped.events.length,0);
    assert.equal(f.requests.length,before); assert.equal(f.typed.length,0);
  } finally { await f.context.close(); }
});
test('invalid forms, purchase links, missing elements, lost focus, empty results and mismatched details are handled explicitly',async()=>{
  for(const [configuration,options,expected] of [
    [{badForm:true},{command:'search',query:'pen'},/INVALID_SEARCH_FORM/],
    [{cartHref:'/gp/buy/spc/handlers/display.html'},{command:'cart'},/INVALID_LINK/],
    [{switchLink:true},{command:'cart'},/INVALID_LINK/],
    [{missingInput:true},{command:'search',query:'pen',timeoutMs:50},/ELEMENT_NOT_FOUND/],
    [{focusLost:true},{command:'search',query:'pen'},/FOCUS_LOST/],
    [{detailMismatch:true},{command:'detail',query:'pen',timeoutMs:50},/Timeout|ELEMENT_NOT_FOUND/],
  ]) {
    const f=await actionFixture(configuration);
    try {
      await assert.rejects(runExistingChrome(f.tab,options),expected);
      assert.ok(f.requests.every(r=>r.method==='GET'));
      assert.equal(f.requests.some(r=>r.path.startsWith('/gp/buy')),false);
    } finally { await f.context.close(); }
  }
  const f=await actionFixture({empty:true});
  try { const result=await runExistingChrome(f.tab,{command:'search',query:'pen'}); assert.equal(result.success,true); assert.equal(result.count,0); }
  finally { await f.context.close(); }
  await assert.rejects(runExistingChrome({},{command:'cart-add'}),/UNSUPPORTED_COMMAND/);
  await assert.rejects(runExistingChrome({},{command:'buy'}),/UNSUPPORTED_COMMAND/);
});


test('cart resumes from success link, detects verification, and never repeats an addition',async()=>{
  const f=await actionFixture({cartAuth:true,cartHref:'/gp/buy/'});
  try {
    await f.page.goto('https://www.amazon.co.jp/cart/add-to-cart/ref=done');
    const result=await runExistingChrome(f.tab,{command:'cart',asin:'B084QBPLKZ'});
    assert.equal(result.code,'AUTH_REQUIRED'); assert.equal(result.status,'verification_required');
    assert.deepEqual(result.events.map(e=>e.target),['cart-link']);
    const before=f.requests.length;
    const again=await runExistingChrome(f.tab,{command:'cart',asin:'B084QBPLKZ'});
    assert.equal(again.code,'AUTH_REQUIRED'); assert.equal(again.events.length,0);
    assert.equal(f.requests.length,before); assert.ok(f.requests.every(r=>r.method==='GET'));
    assert.equal(f.requests.some(r=>r.path.startsWith('/gp/buy')),false);
  } finally { await f.context.close(); }
});
test('extension errors redact token-bearing URLs rather than forwarding raw API messages',async()=>{
  const tab={url:()=> 'https://www.amazon.co.jp/',playwright:{locator:()=>({innerText:async()=>{throw new Error('Failure https://user:password@www.amazon.co.jp/checkpoint/continue?token=SECRET#frag');}})}};
  await assert.rejects(runExistingChrome(tab,{command:'search'}),error=>!error.message.includes('SECRET') && !error.message.includes('password') && error.message.includes('/checkpoint/continue'));
});
