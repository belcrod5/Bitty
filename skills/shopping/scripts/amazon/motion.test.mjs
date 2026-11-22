import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {RandomMouse,typeSearchQuery} from './motion.mjs';
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

test('scroll logs distinguish visible targets, document scrolling and nested scrolling, with a wait only when needed',async()=>{
  for(const scenario of ['visible','document','nested']){
    const p=await browser.newPage({viewport:{width:800,height:600}});
    try{
      const button='<button style="width:120px;height:40px" onclick="window.clicks=(window.clicks||0)+1">次へ</button>';
      await p.setContent(scenario==='visible'?button:scenario==='document'
        ?'<div style="height:1800px"></div>'+button
        :'<div id="scroller" style="height:250px;overflow:auto"><div style="height:1800px"></div>'+button+'</div>');
      await p.evaluate(()=>{window.scrollPositions=[];document.addEventListener('scroll',event=>{const target=event.target===document?document.scrollingElement:event.target;window.scrollPositions.push(target.scrollTop);},true);});
      const logs=[],mouse=new RandomMouse(p,(event,data)=>logs.push({event,...data,time:performance.now()}));
      if(scenario!=='document')mouse.moveTo=point=>p.mouse.move(point.x,point.y);
      await mouse.click(p.locator('button'),'test');
      assert.equal(await p.evaluate(()=>window.clicks),1);
      const scroll=logs.find(e=>e.event==='scroll');
      const preparation=logs.find(e=>e.event==='pause'&&e.reason==='before preparing test');
      assert.ok(preparation.milliseconds>=1000&&preparation.milliseconds<=2000);
      assert.ok(scroll.time-preparation.time>=preparation.milliseconds-10);
      assert.equal(scroll.needed,scenario!=='visible');
      assert.equal(scroll.scrolled,scenario!=='visible');
      assert.ok(scroll.durationMs>=0);
      const wait=logs.find(e=>e.event==='pause'&&e.reason==='after scrolling test');
      const movement=logs.find(e=>e.event==='mouse-move-complete');
      const complete=logs.find(e=>e.event==='click-complete');
      assert.ok(complete.durationMs>=movement.durationMs);
      if(scenario==='visible'){
        assert.equal(wait,undefined);assert.deepEqual(scroll.deltas,[]);
      }else{
        assert.ok(scroll.deltas.some(d=>d.y>0));
        assert.equal(scroll.behavior,'smooth');
        const positions=await p.evaluate(()=>window.scrollPositions);
        assert.ok(positions.some(y=>y>0&&y<Math.max(...positions)),JSON.stringify({scenario,positions,scroll}));
        assert.ok(scroll.durationMs>=200);
        assert.ok(wait.milliseconds>=1000&&wait.milliseconds<=2000);
        assert.ok(movement.time-wait.time>=wait.milliseconds-10);
        if(scenario==='nested'){
          assert.equal(await p.evaluate(()=>scrollY),0);
          assert.ok(await p.locator('#scroller').evaluate(e=>e.scrollTop)>0);
        }else assert.ok(movement.durationMs>0);
      }
    }finally{await p.close();}
  }
});

test('scrolling that does not settle stops before mouse-down',async()=>{
  const p=await browser.newPage({viewport:{width:800,height:600}});
  try{
    await p.setContent('<div style="height:1800px"></div><button onmousedown="window.downs=(window.downs||0)+1">次へ</button><div style="height:2000px"></div>');
    await p.locator('button').evaluate(e=>{e.scrollIntoView=()=>{let y=0;setInterval(()=>{y=y===100?200:100;window.scrollTo(0,y);},40);};});
    const mouse=new RandomMouse(p,()=>{});
    await assert.rejects(mouse.click(p.locator('button'),'test'),/scroll did not settle/);
    assert.equal(await p.evaluate(()=>window.downs||0),0);
  }finally{await p.close();}
});

test('input pacing rechecks focus after waits and never clears a newly focused unrelated input',async()=>{
  for(const reason of ['before editing search input','after entering search query']){
    const p=await browser.newPage();
    try{
      await p.setContent('<input id="search" value="previous"><input id="other" value="untouched">');
      const input=p.locator('#search');await input.focus();let changed;
      await assert.rejects(typeSearchQuery(p,input,'A',(event,data)=>{
        if(event==='pause'&&data.reason===reason)changed=p.locator('#other').focus();
      }),/focus/i);
      await changed;
      assert.equal(await p.locator('#other').inputValue(),'untouched');
      assert.equal(await input.inputValue(),reason==='before editing search input'?'previous':'A');
    }finally{await p.close();}
  }
});
