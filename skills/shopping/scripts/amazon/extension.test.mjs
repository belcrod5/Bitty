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
