import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectExtension, readExtensionConfig, serveExtensionSetup } from './chrome-extension.mjs';

const token = 'test-only-extension-token-123456';
test('local setup accepts one same-origin form, saves a private key without returning it, and closes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shopping-setup-'));
  const path = join(directory, 'config.json');
  const setup = await serveExtensionSetup({ path });
  try {
    const form = await fetch(setup.url);
    assert.equal(form.status, 200);
    assert.equal(form.headers.get('cache-control'), 'no-store');
    assert.equal((await form.text()).includes(token), false);
    const body = new URLSearchParams({ token, profile: 'Profile 2' });
    const rejected = await fetch(setup.url, { method: 'POST', body, headers: { origin: 'https://example.com' } });
    assert.equal(rejected.status, 403);
    assert.equal(await readExtensionConfig(path), null);
    const result = await fetch(setup.url, { method: 'POST', body, headers: { origin: new URL(setup.url).origin } });
    assert.equal(result.status, 200);
    assert.equal((await result.text()).includes(token), false);
    await setup.closed;
    assert.equal(setup.saved, true);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readExtensionConfig(path), { token, profile: 'Profile 2' });
    await chmod(path, 0o644);
    await assert.rejects(readExtensionConfig(path), /0600/);
  } finally { setup.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('extension connects only to its own named local server and uses the token in environment only', async () => {
  const calls = [];
  const browser = {};
  let endpoint;
  const run = async (executable, args, options) => {
    calls.push(args);
    assert.equal(args.join(' ').includes(token), false);
    assert.equal(options.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, token);
    assert.equal(options.env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME, 'Default');
    return { stdout: JSON.stringify(args.includes('list') ? { servers: [
      { title: 'unrelated', workspaceDir: '/tmp/other', endpoint: '/tmp/other.sock' },
      { title: 'shopping-test', endpoint: '/tmp/own.sock' },
    ] } : {}) };
  };
  const result = await connectExtension({ token, profile: 'Default' }, 'shopping-test', {
    cwd: '/tmp/test', run, connect: async value => { endpoint = value; return browser; },
  });
  assert.equal(endpoint, '/tmp/own.sock');
  assert.equal(result.browser, browser);
  await result.disconnect();
  assert.ok(calls.at(-1).includes('detach'));
  assert.ok(calls.every(args => !args.includes('close-all') && !args.includes('kill-all')));
});

test('extension errors redact the key and ambiguous servers fail without a direct Chrome fallback', async () => {
  let connected = false, detached = false;
  await assert.rejects(connectExtension({ token }, 'shopping-test', {
    run: async (_, args) => {
      if (args.includes('detach')) detached = true;
      throw new Error(`connection token=${token}`);
    }, connect: async () => { connected = true; },
  }), error => error.message.includes('[redacted]') && !error.message.includes(token));
  assert.equal(detached, true); assert.equal(connected, false);
  await assert.rejects(connectExtension({ token }, 'shopping-test', {
    cwd: '/tmp/test',
    run: async (_, args) => ({ stdout: JSON.stringify(args.includes('list') ? { servers: [
      { title: 'shopping-test', workspaceDir: '/tmp/test', endpoint: '/tmp/1' },
      { title: 'shopping-test', workspaceDir: '/tmp/test', endpoint: '/tmp/2' },
    ] } : {}) }),
    connect: async () => { connected = true; },
  }), /一意/);
  assert.equal(connected, false);
});
