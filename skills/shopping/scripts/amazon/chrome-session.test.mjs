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
