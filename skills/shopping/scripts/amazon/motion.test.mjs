import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {RandomMouse} from './motion.mjs';
let browser;
before(async()=>{browser=await chromium.launch({channel:'chrome',headless:true});});
after(async()=>{await browser?.close();});
test('a layout shift may retarget once before the callback, but only one mouse-down is sent',async()=>{
  const p=await browser.newPage();
  try{
    await p.setContent('<button style="position:absolute;left:20px;top:100px;width:80px;height:30px" onclick="window.clicks=(window.clicks||0)+1">削除</button>');
    const logs=[],mouse=new RandomMouse(p,(event,data)=>logs.push({event,...data}));let movements=0,preflights=0;
    mouse.moveTo=async point=>{movements++;await p.mouse.move(point.x,point.y);if(movements===1)await p.locator('button').evaluate(e=>e.style.top='185px');};
    await mouse.click(p.locator('button'),'test',{beforeMouseDown:async()=>{preflights++;}});
    assert.equal(await p.evaluate(()=>window.clicks),1);assert.equal(preflights,1);assert.equal(movements,2);assert.equal(logs.filter(e=>e.event==='mouse-retarget').length,1);
  }finally{await p.close();}
});
test('a covering overlay, repeated shifts or a failed preflight never trigger a retry after mouse-down',async()=>{
  for(const scenario of ['overlay','shifting','preflight']){
    const p=await browser.newPage();
    try{
      await p.setContent('<button style="position:absolute;left:20px;top:100px;width:80px;height:30px" onmousedown="window.downs=(window.downs||0)+1">削除</button>');
      if(scenario==='overlay')await p.locator('body').evaluate(e=>e.insertAdjacentHTML('beforeend','<div style="position:absolute;left:20px;top:100px;width:80px;height:30px;z-index:2"></div>'));
      const mouse=new RandomMouse(p,()=>{});let movements=0,preflights=0;
      mouse.moveTo=async point=>{movements++;await p.mouse.move(point.x,point.y);if(scenario==='shifting')await p.locator('button').evaluate(e=>e.style.top=(parseInt(e.style.top)+85)+'px');};
      await assert.rejects(mouse.click(p.locator('button'),'test',{beforeMouseDown:async()=>{preflights++;if(scenario==='preflight')throw new Error('preflight failed');}}),/covered|preflight failed/);
      assert.equal(await p.evaluate(()=>window.downs||0),0);assert.equal(movements,scenario==='shifting'?2:1);assert.equal(preflights,scenario==='preflight'?1:0);
    }finally{await p.close();}
  }
});
