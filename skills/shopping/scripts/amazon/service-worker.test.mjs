import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { createRouteHandler } from './navigation.mjs';

test('tab-scoped CDP bypass lets purchase guards intercept requests, restores worker and leaves another tab unchanged', async () => {
  let mutationRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/sw.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(`self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));
        self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
        self.addEventListener('fetch',e=>{
          if(new URL(e.request.url).pathname==='/probe') e.respondWith(new Response('worker'));
        });`);
    } else if (req.url === '/probe') res.end('network');
    else if (req.url === '/cart/delete') { mutationRequests++; res.end('mutation'); }
    else { res.setHeader('Content-Type', 'text/html'); res.end('<title>Local worker fixture</title>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--host-resolver-rules=MAP www.amazon.co.jp ~NOTFOUND'] });
  let session;
  try {
    const context = await browser.newContext();
    const first = await context.newPage(), other = await context.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;
    await first.goto(origin);
    await first.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
    await first.reload(); await other.goto(origin);
    for (const page of [first, other]) assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true);
    const probe = page => page.evaluate(() => fetch('/probe').then(r => r.text()));
    assert.equal(await probe(first), 'worker');
    assert.equal(await probe(other), 'worker');
    session = await context.newCDPSession(first);
    await session.send('Network.enable');
    await session.send('Network.setBypassServiceWorker', { bypass: true });
    const events = [];
    const guard = createRouteHandler('search', {}, undefined, (...args) => events.push(args));
    await first.route('**/*', guard);
    assert.equal(await probe(first), 'network');
    assert.equal(await probe(other), 'worker');
    const blocked = await first.evaluate(() => fetch('/cart/delete', { method: 'POST' }).then(() => false, () => true));
    assert.equal(blocked, true); assert.equal(mutationRequests, 0);
    assert.equal(events.some(([event]) => event === 'blocked-request'), true);
    await first.unroute('**/*', guard);
    await session.detach(); session = null;
    assert.equal(await probe(first), 'worker');
    assert.equal(await probe(other), 'worker');
    assert.equal(await first.evaluate(async () => !!await navigator.serviceWorker.getRegistration()), true);
  } finally {
    await session?.detach().catch(() => {});
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
