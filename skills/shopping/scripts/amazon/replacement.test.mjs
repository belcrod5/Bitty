import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {openOperation,runCartReplacement,cartView} from './cart.mjs';
import {createRouteHandler,authorizeRemoval} from './navigation.mjs';
import {options} from './search.mjs';

const old='B000000001', replacement='B000000002', other='B000000003';
let browser;
before(async()=>{browser=await chromium.launch({channel:'chrome',headless:true,args:['--host-resolver-rules=MAP www.amazon.co.jp ~NOTFOUND']});});
after(async()=>{await browser?.close();});

async function fixture({lostAdd=false,lostRemove=false,alreadyPresent=false,oldQuantity=1,beforeRemoval}={}) {
  const directory=await mkdtemp(join(tmpdir(),'shopping-replace-test-'));
  const context=await browser.newContext({serviceWorkers:'block'}), page=await context.newPage();
  let addCount=0,removeCount=0,added=alreadyPresent,removed=false,oldId='old-item';
  const clicked=[],attempt={armed:false,consumed:false};
  const row=(asin,id,quantity,selected,price)=>`<div class="sc-list-item" data-asin="${asin}" data-itemid="${id}" data-isselected="${selected}"><span class="sc-product-title">Fleece ${asin}</span><input name="quantityBox" value="${quantity}"><span class="sc-product-price">￥${price}</span><li class="sc-product-variation">サイズ: LL</li><input type="submit" data-action="delete-active" data-feature-id="item-delete-button" name="submit.delete-active.${id}" value="削除"></div>`;
  await context.route('**/*',route=>{
    const r=route.request(),u=new URL(r.url());
    if(u.pathname.startsWith('/dp/')) return route.fulfill({contentType:'text/html; charset=utf-8',body:`<h1 id="productTitle">Fleece</h1><div id="variation_color_name"><span class="selection">ワイン</span><li data-defaultasin="${old}"><img alt="黒"></li></div><div id="variation_size_name"><span class="selection">LL</span></div><div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">￥1,648</span></span></div><form action="/cart/add-to-cart" method="post"><input name="ASIN" value="${replacement}"><input name="quantity" value="1"><input type="submit" id="add-to-cart-button" name="submit.add-to-cart" value="カートに入れる"></form><a id="nav-cart" href="/cart">カート</a>`});
    if(u.pathname==='/cart/add-to-cart') {
      if(r.method()==='POST'){addCount++;added=true;}
      return route.fulfill({status:lostAdd?502:200,contentType:'text/html; charset=utf-8',body:lostAdd?'lost':`<div id="sw-atc-details-single-container">カートに入れました<a href="/dp/${replacement}">Fleece</a></div><a id="nav-cart" href="/cart">カート</a>`});
    }
    if(u.pathname==='/cart') {
      if(r.method()==='POST'){
        removeCount++;
        assert.equal(new URLSearchParams(r.postData()).has('submit.delete-active.old-item'),true);
        if(lostRemove)return route.fulfill({status:502,body:'lost'});
        removed=true;
      }
      const sum=(removed?0:1648*oldQuantity)+(added?1648:0);
      return route.fulfill({contentType:'text/html; charset=utf-8',body:`<span id="sc-subtotal-label-buybox">小計（税込）</span><span id="sc-subtotal-amount-buybox">￥${sum.toLocaleString('en-US')}</span><form action="/cart" method="post"><div id="sc-active-cart">${removed?'':row(old,oldId,oldQuantity,1,1648)}${added?row(replacement,'new-item',1,1,1648):''}${row(other,'other-item',2,0,100)}</div></form>`});
    }
    return route.abort();
  });
  await page.route('**/*',createRouteHandler('cart-replace',attempt,replacement,()=>{}));
  await page.goto('https://www.amazon.co.jp/cart');
  const operation=await openOperation(directory,'replace',replacement,{color:'ワイン',size:'LL',maxPrice:1648},old);
  const mouse={click:async(locator,label,{beforeMouseDown}={})=>{clicked.push(label);if(label==='remove replaced cart item')await beforeRemoval?.(page,locator);await beforeMouseDown?.();await locator.click();}};
  const run=()=>runCartReplacement({page,operation,mouse,attempt,identity:'fixture',log:()=>{},timeout:500});
  return {page,operation,clicked,run,setOldId(value){oldId=value},markRemoved(){removed=true},get addCount(){return addCount},get removeCount(){return removeCount},async close(){await operation.release();await context.close();await rm(directory,{recursive:true,force:true});}};
}

test('cart totals distinguish displayed selected subtotal from all active quantities and never guess missing prices',async()=>{
  const f=await fixture();
  try{
    const v=await cartView(f.page);
    assert.equal(v.subtotalYen,1648);assert.equal(v.allItemsSubtotalYen,1848);assert.equal(v.allItemsQuantity,3);
    assert.equal(v.selectedItemsSubtotalYen,1648);assert.equal(v.subtotalMatchesSelectedItems,true);
    await f.page.locator('.sc-product-price').last().evaluate(e=>e.remove());
    assert.equal((await cartView(f.page)).allItemsSubtotalYen,null);
    await f.page.locator('.sc-list-item').last().evaluate(e=>e.style.display='none');
    assert.equal((await cartView(f.page)).items.length,1);
    await f.page.locator('.sc-list-item').last().evaluate(e=>{e.style.display='';e.setAttribute('data-removed','true');e.textContent='商品は削除されました';});
    assert.equal((await cartView(f.page)).items.length,1);
  }finally{await f.close();}
});

test('replacement adds exactly once, removes only the bound original, preserves other quantities, and resumes read-only',async()=>{
  const f=await fixture();
  try{
    const result=await f.run();
    assert.equal(result.replacementConfirmed,true);assert.equal(result.removal,'confirmed');assert.equal(result.addition,'confirmed');
    assert.equal(f.addCount,1);assert.equal(f.removeCount,1);
    assert.deepEqual(result.items.map(i=>[i.asin,i.quantity]),[[replacement,'1'],[other,'2']]);
    assert.equal(result.subtotalYen,1648);assert.equal(result.allItemsSubtotalYen,1848);
    await f.run();assert.equal(f.addCount,1);assert.equal(f.removeCount,1);
  }finally{await f.close();}
});

test('uncertain addition never removes the original or adds again',async()=>{
  const f=await fixture({lostAdd:true});
  try{
    const result=await f.run();assert.equal(result.addition,'unknown');assert.equal(f.removeCount,0);
    await f.page.goto('https://www.amazon.co.jp/cart');await f.run();assert.equal(f.addCount,1);assert.equal(f.removeCount,0);
  }finally{await f.close();}
});

test('uncertain removal refreshes and targets only the same original line, without adding again',async()=>{
  const f=await fixture({lostRemove:true});
  try{
    const result=await f.run();assert.equal(result.removal,'unknown');assert.equal(f.addCount,1);assert.equal(f.removeCount,1);
    await f.page.goto('https://www.amazon.co.jp/cart');const resumed=await f.run();assert.equal(resumed.removal,'unknown');assert.equal(f.removeCount,2);assert.equal(f.addCount,1);
    f.setOldId('different-line');
    // A new server line must never be substituted for the bound original.
    await assert.rejects(f.run(),/行・数量/);assert.equal(f.removeCount,2);
    f.markRemoved();const recovered=await f.run();assert.equal(recovered.replacementConfirmed,true);assert.equal(f.removeCount,2);
  }finally{await f.close();}
});

test('existing replacement or changed original quantity stops before either mutation',async()=>{
  for(const settings of [{alreadyPresent:true},{oldQuantity:2}]){
    const f=await fixture(settings);
    try{await assert.rejects(f.run(),/重複|数量1/);assert.equal(f.addCount,0);assert.equal(f.removeCount,0);}finally{await f.close();}
  }
});

test('source size mismatch stops before adding; effective delete overrides and purchase fields stop before removal',async()=>{
  const mismatch=await fixture();
  try{
    await mismatch.page.locator(`[data-asin="${old}"] .sc-product-variation`).evaluate(e=>e.textContent='サイズ: M');
    await assert.rejects(mismatch.run(),/同じサイズ/);assert.equal(mismatch.addCount,0);assert.equal(mismatch.removeCount,0);
  }finally{await mismatch.close();}
  for(const [key,value] of [['formaction','https://www.amazon.co.jp/checkout'],['formmethod','get'],['formtarget','_blank'],['formenctype','text/plain'],['checkout','1']]){
    const f=await fixture({beforeRemoval:async(page,button)=>button.evaluate((e,{key,value})=>{
      if(key==='checkout'){const hidden=document.createElement('input');hidden.name=key;hidden.value=value;e.form.append(hidden);}else e.setAttribute(key,value);
    },{key,value})});
    try{await assert.rejects(f.run(),/未対応|削除以外/);assert.equal(f.addCount,1);assert.equal(f.removeCount,0);assert.equal(f.operation.data.removal,'not_started');}finally{await f.close();}
  }
});

test('removal authorization binds one delete submitter or AJAX itemId and blocks checkout and unrelated lines',()=>{
  const make=body=>({url:()=> 'https://www.amazon.co.jp/cart/preview/action',method:()=> 'POST',headers:()=>({'content-type':'application/x-www-form-urlencoded'}),postData:()=>body});
  for(const body of ['submit.delete-active.other-item=削除','submit.delete-active.old-item=削除&submit.buy-now=1','pageAction=delete-active&actionPayload=%7B%22itemId%22%3A%22other-item%22%7D'])assert.equal(authorizeRemoval(make(body),{armed:true,itemId:'old-item'}),false);
  for(const body of ['submit.delete-active.old-item=削除','pageAction=delete-active&actionPayload=%7B%22itemId%22%3A%22old-item%22%7D']){
    const attempt={armed:true,itemId:'old-item',action:'https://www.amazon.co.jp/cart/preview/action'};assert.equal(authorizeRemoval(make(body),attempt),true);assert.equal(authorizeRemoval(make(body),attempt),false);
  }
  const reference={url:()=> 'https://www.amazon.co.jp/cart/ref=ox_sc_cart_actions_1',method:()=> 'POST',headers:()=>({'content-type':'application/x-www-form-urlencoded'}),postData:()=> 'pageAction=delete-active&actionPayload=%7B%22itemID%22%3A%22old-item%22%7D'};
  assert.equal(authorizeRemoval(reference,{armed:true,itemId:'old-item',action:'https://www.amazon.co.jp/cart/ref=ord_cart_shr'}),true);
  const action={type:'DELETE_START',payload:{itemId:'old-item',list:'activeItems',relatedItemIds:[],isPrimeAsin:false}};
  for(const [actions,expected] of [[[action],true],[[action,action],false],[[{...action,type:'UPDATE_QUANTITY_START'}],false],[[{...action,payload:{...action.payload,itemId:'other'}}],false],[[{...action,payload:{...action.payload,relatedItemIds:['other']}}],false]]){
    const body=new URLSearchParams({'submit.cart-actions':'1',pageAction:'cart-actions',actionPayload:JSON.stringify(actions)}).toString();
    assert.equal(authorizeRemoval({...reference,postData:()=>body},{armed:true,itemId:'old-item',action:'https://www.amazon.co.jp/cart'}),expected);
  }
});

test('replacement CLI requires a new bound operation, distinct ASINs and explicit selection checks',()=>{
  const args=['cart-replace','--cdp','chrome','--from-asin',old,'--asin',replacement,'--operation','color-change','--color','ワイン','--size','LL','--max-price','1648'];
  assert.equal(options(args).fromAsin,old);
  assert.throws(()=>options(args.slice(0,-2)),/max-price/);
  assert.throws(()=>options(args.map(a=>a===replacement?old:a)),/異なる/);
});
