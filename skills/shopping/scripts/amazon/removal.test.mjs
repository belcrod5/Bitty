import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {openOperation,runCartRemoval,cartView,readOperation} from './cart.mjs';
import {createRouteHandler,authorizeRemoval} from './navigation.mjs';
import {options,main} from './search.mjs';

const old='B000000001', other='B000000003';
let browser;
before(async()=>{browser=await chromium.launch({channel:'chrome',headless:true,args:['--host-resolver-rules=MAP www.amazon.co.jp ~NOTFOUND']});});
after(async()=>{await browser?.close();});

async function fixture({lostRemove=false,applied=false,quantity=1,challenge=false,beforeRemoval}={}) {
  const directory=await mkdtemp(join(tmpdir(),'shopping-remove-test-'));
  const context=await browser.newContext({serviceWorkers:'block'}), page=await context.newPage();
  let removeCount=0,removed=false,oldId='old-item',productGets=0;
  const attempt={armed:false,consumed:false};
  const row=(asin,id,qty,selected,price)=>`<div class="sc-list-item" data-asin="${asin}" data-itemid="${id}" data-isselected="${selected}"><span class="sc-product-title">Product ${asin}</span><input name="quantityBox" value="${qty}"><span class="sc-product-price">￥${price}</span><li class="sc-product-variation">タイプ: 詰替用</li><input type="submit" data-action="delete-active" data-feature-id="item-delete-button" name="submit.delete-active.${id}" value="削除"></div>`;
  await context.route('**/*',route=>{
    const r=route.request(),u=new URL(r.url());
    if(u.pathname.startsWith('/dp/')) {productGets++;return route.fulfill({contentType:'text/html; charset=utf-8',body:`<h1 id="productTitle">Test item</h1><div id="variation_style_name"><span class="selection">詰替用</span></div>`});}
    if(u.pathname==='/checkpoint/continue')return route.fulfill({contentType:'text/html; charset=utf-8',body:'私は人間です'});
    if(u.pathname==='/cart') {
      if(r.method()==='POST'){
        removeCount++;
        assert.equal(new URLSearchParams(r.postData()).has('submit.delete-active.old-item'),true);
        if(challenge){removed=true;return route.fulfill({contentType:'text/html',body:'<script>location.replace("/checkpoint/continue")</script>'});}
        if(lostRemove){removed=applied;return route.fulfill({status:502,body:'lost'});}
        removed=true;
      }
      const sum=removed?0:1648*quantity;
      return route.fulfill({contentType:'text/html; charset=utf-8',body:`<span id="sc-subtotal-label-buybox">小計（税込）</span><span id="sc-subtotal-amount-buybox">￥${sum.toLocaleString('en-US')}</span><form action="/cart" method="post"><div id="sc-active-cart">${removed?'':row(old,oldId,quantity,1,1648)}${row(other,'other-item',2,0,100)}</div></form>`});
    }
    return route.abort();
  });
  await page.route('**/*',createRouteHandler('cart-remove',attempt,old,()=>{}));
  await page.goto('https://www.amazon.co.jp/cart');
  const operation=await openOperation(directory,'remove',old,{}, {itemId:'old-item',quantity});
  const mouse={click:async(locator,label,{beforeMouseDown}={})=>{if(label==='remove cart item')await beforeRemoval?.(page,locator);await beforeMouseDown?.();await locator.click();}};
  const run=()=>runCartRemoval({page,operation,mouse,attempt,identity:'fixture',log:()=>{},timeout:400});
  return {page,context,operation,directory,run,setOldId(value){oldId=value},markRemoved(){removed=true},get productGets(){return productGets},get removeCount(){return removeCount},async close(){await operation.release().catch(e=>{if(e.code!=='ENOENT')throw e});await context.close();await rm(directory,{recursive:true,force:true});}};
}

test('cart totals include unselected products and exclude removed placeholders; product links survive deletion',async()=>{
  const f=await fixture();
  try{
    const v=await cartView(f.page);
    assert.equal(v.subtotalYen,1648);assert.equal(v.allItemsSubtotalYen,1848);assert.equal(v.allItemsQuantity,3);
    assert.equal(v.selectedItemsSubtotalYen,1648);assert.equal(v.subtotalMatchesSelectedItems,true);
    assert.equal(v.items[0].productUrl,`https://www.amazon.co.jp/dp/${old}`);
    await f.page.locator('.sc-product-price').last().evaluate(e=>e.remove());
    assert.equal((await cartView(f.page)).allItemsSubtotalYen,null);
    await f.page.locator('.sc-list-item').last().evaluate(e=>{e.setAttribute('data-removed','true');e.textContent='商品は削除されました';});
    assert.equal((await cartView(f.page)).items.length,1);
  }finally{await f.close();}
});

test('generic removal deletes only the bound line at any explicit quantity and preserves its detail link',async()=>{
  const f=await fixture({quantity:3});
  try{
    const result=await f.run();
    assert.equal(result.removal,'confirmed');assert.equal(result.targetPresent,false);assert.equal(f.removeCount,1);
    assert.deepEqual(result.items.map(i=>[i.asin,i.quantity]),[[other,'2']]);
    assert.equal(result.removedItem.quantity,'3');assert.deepEqual(result.removedItem.variantText,['タイプ: 詰替用']);
    const saved=await readOperation(f.directory,'remove');
    assert.equal(saved.removedItem.productUrl,`https://www.amazon.co.jp/dp/${old}`);
    await f.run();assert.equal(f.removeCount,1);
    await f.page.unroute('**/*');
    const detail=await main({...options(['detail','--asin',old,'--cdp','chrome']),extensionConnection:true}, {contexts:()=>[f.context]});
    assert.equal(detail.success,true);assert.equal(f.productGets,1);
    // Mimic AI changing a new type in the existing tab. Reading must not reload it.
    await f.page.locator('.selection').evaluate(e=>e.textContent='本体');
    const current=await main({...options(['detail-current','--cdp','chrome']),extensionConnection:true},{contexts:()=>[f.context]});
    assert.equal(current.success,true);assert.equal(f.productGets,1);assert.equal(current.selectedOptions[0].selected,'本体');
  }finally{await f.close();}
});

test('lost removal refreshes with GET, never deletes a different server line, and confirms absence without resending',async()=>{
  for(const applied of [false,true]){
    const f=await fixture({lostRemove:true,applied});
    try{
      assert.equal((await f.run()).removal,'unknown');assert.equal(f.removeCount,1);
      if(!applied){assert.equal((await f.run()).removal,'unknown');assert.equal(f.removeCount,2);f.setOldId('different-line');}
      const result=await f.run();assert.equal(result.removal,'confirmed');assert.equal(f.removeCount,applied?1:2);
      if(!applied)assert.equal(result.items.find(i=>i.asin===old).itemId,'different-line');
    }finally{await f.close();}
  }
});

test('missing initial row, changed quantity, and mismatched IDs stop without deletion',async()=>{
  for(const mode of ['missing','quantity','asin']){
    const f=await fixture();
    try{
      if(mode==='missing')await f.page.locator('[data-itemid="old-item"]').evaluate(e=>e.remove());
      if(mode==='quantity')await f.page.locator('[data-itemid="old-item"] input[name="quantityBox"]').fill('2');
      if(mode==='asin')await f.page.locator('[data-itemid="old-item"]').evaluate(e=>e.setAttribute('data-asin','B000000099'));
      await assert.rejects(f.run(),/見つかりません|行・数量/);assert.equal(f.removeCount,0);
    }finally{await f.close();}
  }
});

test('effective deletion overrides, checkout fields and changed quantities stop immediately before clicking',async()=>{
  for(const [key,value] of [['formaction','https://www.amazon.co.jp/checkout'],['formmethod','get'],['formtarget','_blank'],['formenctype','text/plain'],['checkout','1'],['quantity','2']]){
    const f=await fixture({beforeRemoval:async(page,button)=>button.evaluate((e,{key,value})=>{
      if(key==='quantity')e.closest('.sc-list-item').querySelector('[name="quantityBox"]').value=value;
      else if(key==='checkout'){const hidden=document.createElement('input');hidden.name=key;hidden.value=value;e.form.append(hidden);}else e.setAttribute(key,value);
    },{key,value})});
    try{await assert.rejects(f.run(),/未対応|削除以外|行・数量/);assert.equal(f.removeCount,0);assert.equal(f.operation.data.removal,'not_started');}finally{await f.close();}
  }
});

test('authentication after delete preserves unknown state and never operates on the challenge',async()=>{
  const f=await fixture({challenge:true});
  try{
    const result=await f.run();assert.equal(result.removal,'unknown');assert.equal(result.cart,'verification_required');
    await f.run();assert.equal(f.removeCount,1);
    await f.page.goto('https://www.amazon.co.jp/cart');assert.equal((await f.run()).removal,'confirmed');assert.equal(f.removeCount,1);
  }finally{await f.close();}
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


test('removal CLI binds item ID and quantity; old specialized commands and flags fail explicitly',()=>{
  const args=['cart-remove','--cdp','chrome','--asin',old,'--operation','remove-one','--item-id','old-item','--quantity','3'];
  assert.deepEqual(options(args).removal,{itemId:'old-item',quantity:3});
  assert.throws(()=>options(args.slice(0,-2)),/quantity/);
  assert.throws(()=>options(['cart-replace']),/廃止/);
  assert.throws(()=>options(['cart-add','--cdp','chrome','--asin',old,'--operation','add','--color','黒']),/Unknown option/);
});

test('operation kind and historical replacement records cannot be repurposed to mutate',async()=>{
  const f=await fixture();
  try{
    await f.operation.release();
    await assert.rejects(openOperation(f.directory,'remove',old),/操作種別/);
    await assert.rejects(openOperation(f.directory,'remove',old,{}, {itemId:'another',quantity:1}),/行ID/);
    await writeFile(join(f.directory,'legacy.json'),JSON.stringify({operation:'legacy',asin:old,fromAsin:other,quantity:1,addition:'confirmed',removal:'confirmed'}));
    await assert.rejects(openOperation(f.directory,'legacy',old),/旧色変更/);
    assert.equal((await readOperation(f.directory,'legacy')).addition,'confirmed');
  }finally{await f.close();}
});

test('cart-remove CLI execution persists a separate operation and resumes without another delete',async()=>{
  const f=await fixture();
  const id=`remove-cli-${Date.now()}`;
  try{
    await f.page.unroute('**/*');
    const config={...options(['cart-remove','--cdp','chrome','--asin',old,'--item-id','old-item','--quantity','1','--operation',id]),extensionConnection:true};
    const connection={contexts:()=>[f.context]};
    const result=await main(config,connection);
    assert.equal(result.success,true,result.error);assert.equal(result.removal,'confirmed');assert.equal(result.exitCode,0);
    assert.equal(result.removedItem.asin,old);assert.equal(f.removeCount,1);
    const resumed=await main(config,connection);assert.equal(resumed.success,true);assert.equal(f.removeCount,1);
  }finally{
    await rm(new URL(`./.operations/${id}.json`,import.meta.url),{force:true});
    await f.close();
  }
});
