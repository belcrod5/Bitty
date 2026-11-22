import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {RandomMouse,typeSearchQuery,activateTab} from './motion.mjs';
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


test('an inactive tab is activated automatically without changing the focused input',async()=>{
  const p=await browser.newPage();
  try{
    await p.setContent('<input id="query" value="keep"><button onclick="window.clicks=(window.clicks||0)+1">test</button>');
    await p.locator('#query').focus();
    await p.evaluate(()=>Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'}));
    const original=p.bringToFront.bind(p);let activations=0;
    p.bringToFront=async()=>{activations++;await p.evaluate(()=>delete document.visibilityState);await original();};
    const logs=[];await activateTab(p,(event,data)=>logs.push({event,...data}));
    assert.equal(activations,1);assert.equal(await p.locator('#query').inputValue(),'keep');
    assert.equal(await p.locator('#query').evaluate(e=>e===document.activeElement),true);
    assert.equal(logs.find(e=>e.event==='tab-activation')?.success,true);
    await activateTab(p,()=>{});assert.equal(activations,1);
  }finally{await p.close();}
});

test('activation failure initially or after movement stops before the mutation callback and mouse-down',async()=>{
  for(const stage of ['initial','after-movement']){
    const p=await browser.newPage();
    try{
      await p.setContent('<button onmousedown="window.downs=(window.downs||0)+1">test</button>');
      const hide=()=>p.evaluate(()=>Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'}));
      if(stage==='initial')await hide();
      let activations=0,preflights=0,movements=0;
      p.bringToFront=async()=>{activations++;};
      const mouse=new RandomMouse(p,()=>{});
      mouse.moveTo=async()=>{movements++;await hide();};
      await assert.rejects(mouse.click(p.locator('button'),'test',{beforeMouseDown:async()=>{preflights++;}}),e=>e.code==='TAB_ACTIVATION_FAILED');
      assert.equal(activations,1);assert.equal(movements,stage==='initial'?0:1);
      assert.equal(preflights,0);assert.equal(await p.evaluate(()=>window.downs||0),0);
    }finally{await p.close();}
  }
});

test('paced moves do not wait for each acknowledgement and drain the last one before returning',async()=>{
  const sent=[],acks=[];let release,finished=false;
  const page={viewportSize:()=>({width:800,height:600}),mouse:{move:(x,y)=>{
    release?.();sent.push({x,y,time:performance.now()});
    return new Promise(resolve=>{release=()=>{acks.push({x,y});resolve();};});
  }}};
  const mouse=new RandomMouse(page,()=>{});
  const moving=mouse.moveTo({x:300,y:200}).then(()=>{finished=true;});
  // Each next move releases the previous one, modelling the live Chrome delay.
  const deadline=Date.now()+15000;
  while(sent.at(-1)?.x!==300 || sent.at(-1)?.y!==200){
    assert.ok(Date.now()<deadline,'moves stalled waiting for an acknowledgement');
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(finished,false);assert.equal(acks.length,sent.length-1);
  release();await moving;
  assert.deepEqual(acks,sent.map(({x,y})=>({x,y})));
  assert.ok(sent.length>=45);assert.ok(sent.slice(1).every((p,i)=>p.time-sent[i].time>=5));
});

test('a failed movement acknowledgement prevents the mutation callback and mouse-down',async()=>{
  const p=await browser.newPage();
  try{
    await p.setContent('<button onmousedown="window.downs=(window.downs||0)+1">test</button>');
    const mouse=new RandomMouse(p,()=>{});let preflights=0,moves=0;
    p.mouse.move=async()=>{if(++moves===4)throw new Error('movement delivery failed');};
    await assert.rejects(mouse.click(p.locator('button'),'test',{beforeMouseDown:async()=>{preflights++;}}),/movement delivery failed/);
    assert.equal(preflights,0);assert.equal(await p.evaluate(()=>window.downs||0),0);
    assert.equal(moves,4);
  }finally{await p.close();}
});
