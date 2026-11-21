import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromeProcesses, debugArguments, listenerPorts, discoverBrowsers, chooseBrowser } from './browser.mjs';
import { options } from './search.mjs';

const processList='501 123 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n501 124 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper\n502 125 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n';
const browser={endpoint:'http://127.0.0.1:4242',tabs:[{id:'p1',title:'Product',url:'https://www.amazon.co.jp/dp/B012345678'}]};

test('discovery reads only the current user browser process and its own metadata', async()=>{
  assert.deepEqual(chromeProcesses(processList,501),[{pid:123}]);
  assert.deepEqual(debugArguments('chrome --remote-debugging-port=0 --user-data-dir=/tmp/profile with spaces --no-first-run'),{port:null,profile:'/tmp/profile with spaces',pipe:false});
  assert.deepEqual(listenerPorts('p123\nn127.0.0.1:4242\nn[::1]:4242'),[4242]);
  const probes=[];
  const report=await discoverBrowsers({uid:501,run:async(command,args)=>{
    if(command==='lsof') { assert.equal(args[3],'123'); return {stdout:'p123\nn127.0.0.1:4242'}; }
    if(args[0]==='-axo') return {stdout:processList};
    return {stdout:'chrome --remote-debugging-port=0 --user-data-dir=/tmp/profile with spaces --other-flag'};
  },read:async path=>{assert.equal(path,'/tmp/profile with spaces/DevToolsActivePort');return '4242\n/devtools/browser/private';},request:async(endpoint,path)=>{
    probes.push(endpoint+path); assert.equal(endpoint,'http://127.0.0.1:4242');
    return path==='/json/version'?{Browser:'Chrome/150',webSocketDebuggerUrl:'ws://127.0.0.1:4242/devtools/browser/test'}:[{id:'p1',type:'page',url:'https://www.amazon.co.jp/checkpoint/continue?token=SECRET#frag',title:'Verification'},{id:'private',type:'page',url:'https://example.com/private',title:'Other page'}];
  }});
  assert.equal(report.status,'available'); assert.equal(report.browsers.length,1); assert.equal(report.browsers[0].tabs.length,1);
  assert.equal(JSON.stringify(report).includes('SECRET'),false); assert.equal(JSON.stringify(report).includes('Other page'),false);
  assert.deepEqual(probes,['http://127.0.0.1:4242/json/version','http://127.0.0.1:4242/json/list']);
});
test('ordinary Chrome with no debugging is reported unavailable, never asks for an address',async()=>{
  const report=await discoverBrowsers({uid:501,run:async(cmd,args)=>{
    if(cmd==='lsof') throw Object.assign(new Error('no sockets'),{code:1});
    return {stdout:args[0]==='-axo'?processList:'chrome'};
  },request:async()=>{throw new Error('Should not probe unknown ports');}});
  assert.equal(report.code,'CDP_UNAVAILABLE'); assert.match(report.message,/尋ねても解決しません/);
  assert.throws(()=>chooseBrowser(report),e=>e.code==='CDP_UNAVAILABLE');
});
test('permission denial is not misreported as debugging disabled; dead candidates stay distinct',async()=>{
  const denied=await discoverBrowsers({uid:501,run:async()=>{throw new Error('denied');}});
  assert.equal(denied.code,'DISCOVERY_UNAVAILABLE');
  const dead=await discoverBrowsers({uid:501,run:async(cmd,args)=>{
    if(cmd==='lsof') throw Object.assign(new Error('no sockets'),{code:1});
    return {stdout:args[0]==='-axo'?processList:'chrome --remote-debugging-port=4242'};
  },request:async()=>{throw new Error('unreachable');}});
  assert.equal(dead.code,'CDP_UNREACHABLE');
});
test('auto chooses a unique product or cart; multiple matching browsers require disambiguation',()=>{
  const report={status:'available',browsers:[browser]};
  assert.deepEqual(chooseBrowser(report,{command:'cart-add',asin:'B012345678'}),{endpoint:browser.endpoint,tabURL:browser.tabs[0].url});
  const two={status:'available',browsers:[browser,{endpoint:'http://127.0.0.1:4243',tabs:browser.tabs}]};
  assert.throws(()=>chooseBrowser(two,{command:'cart-add',asin:'B012345678'}),e=>e.code==='BROWSER_AMBIGUOUS');
  const cart={endpoint:browser.endpoint,tabs:[...browser.tabs,{id:'cart',title:'Cart',url:'https://www.amazon.co.jp/cart'}]};
  assert.equal(chooseBrowser({status:'available',browsers:[cart]},{command:'cart'}).tabURL,'https://www.amazon.co.jp/cart');
  assert.throws(()=>chooseBrowser({status:'available',browsers:[{...browser,tabs:[]}]}),e=>e.code==='AMAZON_TAB_NOT_FOUND');
});
test('auto connection is an explicit CLI choice; browser-status never starts a browser',()=>{
  assert.equal(options(['cart','--cdp','auto']).cdp,'auto');
  assert.equal(options(['browser-status']).command,'browser-status');
  assert.throws(()=>options(['cart','--cdp','auto','--profile']),/併用できません/);
});


test('Chrome channel attachment requires an explicit choice and preserves existing browser options',()=>{
  assert.equal(options(['search','ボールペン','--cdp','chrome']).cdp,'chrome');
  assert.equal(options(['browser-status','--cdp','chrome']).command,'browser-status');
  assert.throws(()=>options(['cart','--cdp','chrome','--headless']),/併用できません/);
  assert.throws(()=>options(['cart','--cdp','chrome','--profile']),/併用できません/);
  assert.throws(()=>options(['cart','--cdp','not-a-channel']));
});
