import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { main, options } from './search.mjs';

test('native search reuses the loaded home, focuses an animated visible input and submits once', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'shopping-search-'));
  const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, serviceWorkers: 'block', args: ['--remote-debugging-port=0', '--host-resolver-rules=MAP www.amazon.co.jp ~NOTFOUND'] });
  const previousExit = process.exitCode;
  let homeRequests = 0, searches = 0;
  try {
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') {
        homeRequests++;
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<title>Test home</title>
          <style>@keyframes shift{from{transform:translateX(0)}to{transform:translateX(2px)}}
          #twotabsearchtextbox{animation:shift .4s linear infinite alternate;width:300px}</style>
          <form action="/s" method="GET"><input id="twotabsearchtextbox" name="k"><button id="nav-search-submit-button">検索</button></form>` });
      }
      if (url.pathname === '/s') searches++;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<title>Test results</title><div data-component-type="s-search-result" data-asin="B012345678"><h2>Test pen</h2></div>' });
    });
    const page = context.pages()[0];
    await page.goto('https://www.amazon.co.jp/#shopping-native-test');
    const port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    const result = await main(options(['search', 'ボールペン', '--cdp', `http://127.0.0.1:${port}`, '--tab-url', page.url()]));
    assert.equal(result.success, true, result.error);
    assert.equal(result.exitCode, 0);
    assert.equal(homeRequests, 1); assert.equal(searches, 1);
    assert.equal(new URL(page.url()).searchParams.get('k'), 'ボールペン');
    assert.equal(page.isClosed(), false);
    const events = JSON.parse(await readFile(join(result.artifacts, 'events.json'), 'utf8'));
    assert.equal(events.filter(e => e.event === 'typed-character').map(e => e.character).join(''), 'ボールペン');
    assert.equal(events.filter(e => e.event === 'click').length, 2);
    assert.equal(events.some(e => e.event === 'mouse-segment'), true);
    for (const event of events.filter(e => e.event === 'pause' && /before character|before clicking/.test(e.reason))) {
      assert.ok(event.milliseconds >= 500 && event.milliseconds <= 1000);
    }
  } finally { process.exitCode = previousExit; await context.close(); await rm(profile, { recursive: true, force: true }); }
});


test('a failed tab returns its error even when DOM and screenshot APIs would never answer', { timeout: 1000 }, async () => {
  const never = () => new Promise(() => {});
  const page = { url: () => 'https://www.amazon.co.jp/', isClosed: () => false,
    context: () => ({ newCDPSession: async () => { throw new Error('Connection setup failed'); } }),
    title: never, locator: () => ({ innerText: never, count: never }), screenshot: never, content: never };
  const browser = { contexts: () => [{ pages: () => [page] }] };
  const result = await main(options(['search', 'test', '--cdp', 'chrome']), browser);
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.error, 'Connection setup failed');
  const saved = JSON.parse(await readFile(join(result.artifacts, 'result.json'), 'utf8'));
  assert.equal(saved.error, result.error);
});
