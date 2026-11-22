import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowNavigation, safeValue, authorizeAdd } from './navigation.mjs';
import { options } from './search.mjs';

test('purchase, cart mutations and offsite navigation stay blocked in every command', () => {
  for (const command of ['search', 'search-results', 'search-next', 'detail', 'orders', 'cart', 'cart-add']) {
    for (const path of ['/gp/buy/spc/handlers/display.html', '/hz/checkout', '/checkout/now', '/cart/delete', '/gp/cart/ajax-update.html']) {
      assert.equal(allowNavigation(new URL(path, 'https://www.amazon.co.jp'), 'GET', command), false, path);
      assert.equal(allowNavigation(new URL(path, 'https://www.amazon.co.jp'), 'POST', command), false, path);
    }
    assert.equal(allowNavigation(new URL('https://example.com/'), 'GET', command), false);
    assert.equal(allowNavigation(new URL('https://www.amazon.co.jp/ap/signin'), 'POST', command), false);
    assert.equal(allowNavigation(new URL('https://www.amazon.co.jp/checkpoint/continue?token=secret'), 'GET', command), true);
  }
  assert.equal(allowNavigation(new URL('https://www.amazon.co.jp/cart'), 'GET', 'detail'), false);
  assert.equal(allowNavigation(new URL('https://www.amazon.co.jp/cart/add-to-cart?ASIN=B012345678'), 'GET', 'cart-add'), false);
});
test('search, product, orders and cart redirects are permitted only for their command', () => {
  for (const path of ['/s?k=test', '/s/ref=nb_sb_noss_1?field-keywords=test']) assert.equal(allowNavigation(new URL(path, 'https://www.amazon.co.jp'), 'GET', 'search'), true);
  for (const path of ['/dp/B012345678', '/product-name/dp/B012345678/ref=test', '/gp/product/B012345678']) assert.equal(allowNavigation(new URL(path, 'https://www.amazon.co.jp'), 'GET', 'detail'), true);
  assert.equal(allowNavigation(new URL('https://www.amazon.co.jp/gp/css/order-history'), 'GET', 'orders'), true);
  for (const path of ['/cart?ref_=sw_gtc', '/gp/cart/view.html', '/cart/add-to-cart/ref=dp_start', '/cart/smart-wagon']) assert.equal(allowNavigation(new URL(path, 'https://www.amazon.co.jp'), 'GET', 'cart-add'), true);
  for (const command of ['cart','cart-add']) {
    assert.equal(allowNavigation(new URL('https://www.amazon.co.jp/cart/ewc/compact'), 'GET', command), true);
    assert.equal(allowNavigation(new URL('https://www.amazon.co.jp/cart/ewc/compact'), 'POST', command), false);
  }
});
test('only the armed ASIN/quantity1 POST is allowed once', () => {
  const url = 'https://www.amazon.co.jp/cart/add-to-cart/ref=one';
  const make = data => ({ url: () => url, method: () => 'POST', headers: () => ({'content-type':'application/x-www-form-urlencoded'}), postData: () => data });
  const attempt = { action: url, armed: true, consumed: false };
  assert.equal(authorizeAdd(make('ASIN=B012345678&quantity=2'), attempt, 'B012345678'), false);
  assert.equal(authorizeAdd(make('ASIN=B099999999&quantity=1'), attempt, 'B012345678'), false);
  assert.equal(authorizeAdd(make('ASIN=B012345678&quantity=1&submit.buy-now=1'), attempt, 'B012345678'), false);
  assert.equal(authorizeAdd(make('ASIN=B012345678&quantity=1&ASIN.1=B012345678'), attempt, 'B012345678'), false);
  assert.equal(authorizeAdd(make('ASIN=B012345678&quantity=1'), attempt, 'B012345678'), true);
  assert.equal(authorizeAdd(make('ASIN=B012345678&quantity=1'), attempt, 'B012345678'), false);
});
test('URLs in nested records and Playwright errors lose credentials, query and hash', () => {
  const safe = safeValue({ error: 'goto https://user:pass@www.amazon.co.jp/checkpoint/continue?token=SECRET#frag', nested: ['https://www.amazon.co.jp/cart?token=SECRET'] });
  assert.equal(JSON.stringify(safe).includes('SECRET'), false);
  assert.equal(JSON.stringify(safe).includes('pass'), false);
  assert.equal(safe.nested[0], 'https://www.amazon.co.jp/cart');
});

test('inactive isBuyNow hidden field permits only the requested single-item add', () => {
  const action = 'https://www.amazon.co.jp/cart/add-to-cart/ref=one';
  const make = body => ({ url: () => action, method: () => 'POST', headers: () => ({'content-type':'application/x-www-form-urlencoded'}), postData: () => body });
  for (const value of ['0', 'false']) {
    const attempt = { action, armed: true, consumed: false };
    assert.equal(authorizeAdd(make(`ASIN=B012345678&quantity=1&isBuyNow=${value}`), attempt, 'B012345678'), true);
    assert.equal(authorizeAdd(make(`ASIN=B012345678&quantity=1&isBuyNow=${value}`), attempt, 'B012345678'), false);
  }
  for (const extra of ['isBuyNow=', 'isBuyNow=1', 'isBuyNow=true', 'isBuyNow=unknown', 'submit.buy-now=', 'checkout=0', 'isBuyNow=0&isBuyNow=1']) {
    const attempt = { action, armed: true, consumed: false };
    assert.equal(authorizeAdd(make(`ASIN=B012345678&quantity=1&${extra}`), attempt, 'B012345678'), false);
    assert.equal(attempt.consumed, false);
  }
});
test('active isBuyNow is allowed only for an explicit add submitter on the dedicated cart endpoint', () => {
  const action='https://www.amazon.co.jp/cart/add-to-cart/ref=one';
  const make=(url,body)=>({url:()=>url,method:()=>'POST',headers:()=>({'content-type':'application/x-www-form-urlencoded'}),postData:()=>body});
  for(const flag of ['1','true']) {
    const body=`ASIN=B012345678&quantity=1&isBuyNow=${flag}&submit.add-to-cart=カートに入れる`;
    assert.equal(authorizeAdd(make(action,body),{action,armed:true},'B012345678'),true);
    const buyBox='https://www.amazon.co.jp/gp/product/handle-buy-box/ref=one';
    assert.equal(authorizeAdd(make(buyBox,body),{action:buyBox,armed:true},'B012345678'),false);
    assert.equal(authorizeAdd(make(action,body+'&submit.buy-now=1'),{action,armed:true},'B012345678'),false);
    assert.equal(authorizeAdd(make(action,body.replace('quantity=1','quantity=2')),{action,armed:true},'B012345678'),false);
  }
});
test('CLI requires an ASIN and stable operation ID; attachment must be explicit and local', () => {
  assert.throws(() => options(['cart-add','--cdp','chrome','--asin','B012345678']), /operation/);
  assert.throws(() => options(['cart-add','--cdp','chrome','--operation','a']), /asin/);
  assert.throws(() => options(['cart-add','--cdp','chrome','--asin','B012345678','--operation','../a']), /operation/);
  assert.throws(() => options(['cart','--cdp','http://example.com:9222']), /ローカル/);
  assert.throws(() => options(['cart','--tab-url','https://www.amazon.co.jp/cart']), /cdp/);
  assert.equal(options(['cart-add','--cdp','chrome','--asin','B012345678','--operation','one']).command, 'cart-add');
});

test('request guard binds nested quantity to the one target item and never defaults a missing quantity',()=>{
  const action=new URL('https://www.amazon.co.jp/cart/add-to-cart');
  const request=body=>({url:()=>action.href,method:()=>'POST',headers:()=>({'content-type':'application/x-www-form-urlencoded'}),postData:()=>body});
  for(const [body,allowed] of [
    ['ASIN=B012345678&quantity=1',true],
    ['ASIN=B012345678&items[0.base][asin]=B012345678&items[0.base][quantity]=1',true],
    ['items[0.base][asin]=B012345678&items[0.base][quantity]=1',true],
    ['ASIN=B012345678',false],
    ['ASIN=B012345678&quantity=2',false],
    ['ASIN=B012345678&items[0.base][quantity]=1',false],
    ['ASIN=B012345678&items[0.base][asin]=B099999999&items[0.base][quantity]=1',false],
    ['ASIN=B012345678&quantity=1&items[0.base][quantity]=2',false],
    ['ASIN=B012345678&quantity=1&items[1.base][asin]=B099999999',false],
    ['ASIN=B012345678&quantity=1&quantity=1',false],
    ['ASIN=B012345678&quantity=1&quantityBox=2',false],
    ['ASIN=B012345678&qty=1',false],
  ]){
    const attempt={action:action.href,armed:true,consumed:false};
    assert.equal(authorizeAdd(request(body),attempt,'B012345678'),allowed,body);
    assert.equal(attempt.consumed,allowed);
  }
});

test('dual quantity schemas authorize only one explicit base-item add with both values equal to one', () => {
  const asin='B012345678';
  const action='https://www.amazon.co.jp/cart/add-to-cart/ref=one';
  const base='ASIN=B012345678&items[0.base][asin]=B012345678&quantity=1&items[0.base][quantity]=1&submit.add-to-cart=Add';
  const cases=[
    [base,true],
    [base+'&isBuyNow=1',true],
    [base.replace('quantity=1&items','quantity=2&items'),false],
    [base.replace('[quantity]=1','[quantity]=2'),false],
    [base.replace('quantity=1','quantity=2').replace('[quantity]=1','[quantity]=2'),false],
    [base+'&quantity=1',false],
    [base+'&items[0.base][quantity]=1',false],
    [base+'&quantityBox=1',false],
    [base.replace('&quantity=1','&quantity.1=1'),false],
    [base.replace('&quantity=1','&qty=1'),false],
    [base.replace('items[0.base][asin]=B012345678','items[0.base][asin]=B099999999'),false],
    [base.replace('ASIN=B012345678','ASIN=B099999999'),false],
    [base.replace('ASIN=B012345678&',''),false],
    [base.replace('items[0.base][asin]=B012345678&',''),false],
    [base+'&ASIN=B012345678',false],
    [base+'&ASIN.1=B012345678',false],
    [base+'&items[0.base][asin]=B012345678',false],
    [base+'&items[1.base][asin]=B012345678',false],
    [base+'&items[1.base][quantity]=1',false],
    [base.replace('&submit.add-to-cart=Add',''),false],
    [base+'&submit.add-to-cart=Add',false],
    [base+'&submit.other=1',false],
    [base+'&submit.buy-now=1',false],
  ];
  for(const [body,allowed] of cases){
    const request={url:()=>action,method:()=>'POST',headers:()=>({'content-type':'application/x-www-form-urlencoded'}),postData:()=>body};
    const attempt={action,armed:true,consumed:false};
    assert.equal(authorizeAdd(request,attempt,asin),allowed,body);
    assert.equal(attempt.consumed,allowed,body);
    if(allowed)assert.equal(authorizeAdd(request,attempt,asin),false,'same pair cannot send twice');
  }
  for(const url of ['https://www.amazon.co.jp/gp/product/handle-buy-box/ref=one','https://www.amazon.co.jp/checkout','https://example.com/cart/add-to-cart']){
    const request={url:()=>url,method:()=>'POST',headers:()=>({'content-type':'application/x-www-form-urlencoded'}),postData:()=>base};
    assert.equal(authorizeAdd(request,{action:url,armed:true},asin),false,url);
  }
});
