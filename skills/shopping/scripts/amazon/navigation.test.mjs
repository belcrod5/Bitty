import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowNavigation, forbiddenPath } from './navigation.mjs';

test('all commands reject purchase and offsite navigation', () => {
  for (const command of ['search', 'detail', 'orders']) {
    for (const path of ['/gp/buy/spc/handlers/display.html', '/gp/cart/view.html', '/cart/add-to-cart', '/hz/checkout', '/gp/product/handle-buy-box', '/checkout/now']) {
      assert.equal(forbiddenPath(path), true, path);
      assert.equal(allowNavigation(new URL(path, 'https://www.amazon.co.jp'), 'GET', command), false);
      assert.equal(allowNavigation(new URL(path, 'https://www.amazon.co.jp'), 'POST', command), false);
    }
    assert.equal(allowNavigation(new URL('https://example.com/'), 'GET', command), false);
    assert.equal(allowNavigation(new URL('https://www.amazon.co.jp/'), 'POST', command), false);
  }
});

test('all commands reject authentication POST navigation', () => {
  for (const command of ['search', 'detail', 'orders']) {
    assert.equal(allowNavigation(new URL('https://www.amazon.co.jp/ap/signin'), 'POST', command), false);
  }
});

test('commands allow the intended destination and redirects', () => {
  for (const path of ['/s?k=test', '/s/ref=nb_sb_noss_1?field-keywords=test']) {
    assert.equal(allowNavigation(new URL(path, 'https://www.amazon.co.jp'), 'GET', 'search'), true);
  }
  for (const path of ['/dp/B012345678', '/product-name/dp/B012345678/ref=test', '/gp/product/B012345678']) {
    assert.equal(allowNavigation(new URL(path, 'https://www.amazon.co.jp'), 'GET', 'detail'), true);
    assert.equal(allowNavigation(new URL(path, 'https://www.amazon.co.jp'), 'GET', 'orders'), false);
  }
  for (const path of ['/gp/css/order-history', '/gp/your-account/order-history', '/your-orders/orders', '/ap/signin']) {
    assert.equal(allowNavigation(new URL(path, 'https://www.amazon.co.jp'), 'GET', 'orders'), true);
  }
});
