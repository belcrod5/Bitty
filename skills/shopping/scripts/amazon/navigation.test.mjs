import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowNavigation, safeValue, authorizeAdd } from './navigation.mjs';
import { options } from './search.mjs';

test('purchase, cart mutations and offsite navigation stay blocked in every command', () => {
  for (const command of ['search', 'detail', 'orders', 'cart', 'cart-add']) {
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
  for (const path of ['/cart?ref_=sw_gtc', '/gp/cart/view.html', '/cart/add-to-cart/ref=dp_start']) assert.equal(allowNavigation(new URL(path, 'https://www.amazon.co.jp'), 'GET', 'cart-add'), true);
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
test('CLI requires an ASIN and stable operation ID; attachment must be explicit and local', () => {
  assert.throws(() => options(['cart-add','--asin','B012345678']), /operation/);
  assert.throws(() => options(['cart-add','--operation','a']), /asin/);
  assert.throws(() => options(['cart-add','--asin','B012345678','--operation','../a']), /operation/);
  assert.throws(() => options(['cart','--cdp','http://example.com:9222']), /ローカル/);
  assert.throws(() => options(['cart','--tab-url','https://www.amazon.co.jp/cart']), /cdp/);
  assert.equal(options(['cart-add','--asin','B012345678','--operation','one']).command, 'cart-add');
});
