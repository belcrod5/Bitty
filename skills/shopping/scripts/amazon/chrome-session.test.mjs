import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { serveSession, requestSession } from './chrome-session.mjs';

test('one approved connection survives commands, auth failure and client exits without reopening Chrome', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shopping-session-'));
  const profile = join(directory, 'profile'), socket = join(directory, 'session.sock');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, args: ['--remote-debugging-port=0', '--host-resolver-rules=MAP www.amazon.co.jp ~NOTFOUND'] });
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<title>Test cart</title><div id="sc-active-cart">Empty cart</div>' }));
  const page = context.pages()[0];
  await page.goto('https://www.amazon.co.jp/cart');
  const port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
  let approve, calls = 0;
  const permission = new Promise(resolve => { approve = resolve; });
  const session = await serveSession(socket, async () => {
    calls++;
    await permission;
    return chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
  });
  try {
    assert.equal((await stat(socket)).mode & 0o777, 0o600);
    assert.equal((await requestSession(socket, { command: 'status' })).state, 'waiting_for_permission');
    assert.equal((await requestSession(socket, { command: 'run', args: ['browser-status'] })).success, false);
    approve();
    for (let i = 0; (await session.status()).state !== 'connected' && i < 100; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal((await session.status()).state, 'connected');
    for (let i = 0; i < 2; i++) {
      const result = await requestSession(socket, { command: 'run', args: ['browser-status'] });
      assert.equal(result.success, true); assert.equal(result.tabs.length, 1);
    }
    await assert.rejects(serveSession(socket, () => { throw new Error('Must not request a second permission'); }), e => e.code === 'EADDRINUSE');
    const rejected = await requestSession(socket, { command: 'run', args: ['cart', '--profile'] });
    assert.equal(rejected.success, false);
    await page.goto('https://www.amazon.co.jp/checkpoint/continue?token=SECRET');
    const result = await requestSession(socket, { command: 'run', args: ['cart'] });
    assert.equal(result.exitCode, 2); assert.equal(result.success, false);
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
    assert.equal((await requestSession(socket, { command: 'status' })).state, 'connected');
    assert.equal(calls, 1); assert.equal(page.isClosed(), false);
    await requestSession(socket, { command: 'stop' });
    await session.closed;
    assert.equal(page.isClosed(), false);
  } finally { await session.stop(); await context.close(); await rm(directory, { recursive: true, force: true }); }
});

test('permission wait can be stopped without accepting or retrying a connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shopping-pending-'));
  let approve, disconnected = false;
  const permission = new Promise(resolve => { approve = resolve; });
  const session = await serveSession(join(directory, 'session.sock'), () => permission);
  await session.stop(); await session.closed;
  approve({ close: async () => { disconnected = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disconnected, true);
  await rm(directory, { recursive: true, force: true });
});

test('client timeout preserves the running command and result retrieval never reruns it or waits for a renderer title',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'shopping-result-'));const socket=join(directory,'session.sock');
  let finish, calls=0, titleCalls=0;
  const result=new Promise(resolve=>{finish=resolve;});
  const browser={isConnected:()=>true,on:()=>{},close:async()=>{},contexts:()=>[{pages:()=>[{
    url:()=> 'https://www.amazon.co.jp/cart?token=SECRET',
    title:()=>{titleCalls++;return new Promise(()=>{});}
  }]}]};
  const session=await serveSession(socket,async()=>browser,{transport:'extension',run:async()=>{calls++;return result;}});
  try{
    await new Promise(r=>setImmediate(r));
    const request={command:'run',requestId:'timeout-test',args:['cart-add','--asin','B012345678','--operation','test-add']};
    const pending=await requestSession(socket,request,{timeoutMs:30});
    assert.equal(pending.code,'COMMAND_PENDING');assert.equal(pending.exitCode,4);assert.equal(pending.requestId,'timeout-test');
    const status=await requestSession(socket,{command:'status'},{timeoutMs:500});
    assert.equal(status.busy,true);assert.equal(status.activeRequest.operation,'test-add');assert.equal(titleCalls,0);
    assert.equal(JSON.stringify(status).includes('SECRET'),false);
    assert.equal((await requestSession(socket,{command:'result',requestId:pending.requestId})).requestState,'running');
    assert.equal((await requestSession(socket,request)).code,'COMMAND_PENDING');assert.equal(calls,1);
    assert.equal((await requestSession(socket,{command:'stop'})).success,false);
    assert.equal((await requestSession(socket,{command:'run',args:['cart']})).success,false);
    finish({success:true,addition:'confirmed',retryAdd:false,exitCode:0});
    for(let i=0;(await session.status()).busy&&i<100;i++)await new Promise(r=>setTimeout(r,5));
    const completed=await requestSession(socket,{command:'result',requestId:pending.requestId});
    assert.equal(completed.addition,'confirmed');assert.equal(completed.requestState,'completed');assert.equal(calls,1);
    assert.equal((await requestSession(socket,request)).addition,'confirmed');assert.equal(calls,1);
    assert.equal((await requestSession(socket,{command:'result'})).addition,'confirmed');
    assert.equal((await requestSession(socket,{command:'result',requestId:'absent'})).code,'RESULT_NOT_FOUND');
    const changed=await requestSession(socket,{...request,args:['cart']});assert.equal(changed.success,false);assert.equal(calls,1);
  }finally{finish({success:false});await session.stop();await rm(directory,{recursive:true,force:true});}
});
