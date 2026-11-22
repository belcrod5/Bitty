import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, chmod, unlink, realpath, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { main, options } from './search.mjs';
import { safeURL, safeValue } from './navigation.mjs';
import { readExtensionConfig, connectExtension, serveExtensionSetup } from './chrome-extension.mjs';

// One private local socket, one Chrome connection, one command at a time.
const commands = ['search', 'search-next', 'search-results', 'detail', 'orders', 'cart', 'cart-add', 'browser-status'];
export async function sessionPaths(direct = false) {
  const source = await realpath(dirname(fileURLToPath(import.meta.url)));
  const key = createHash('sha256').update(source).digest('hex').slice(0, 12);
  const directory = join(tmpdir(), `shopping-chrome-${key}${direct ? '-direct' : ''}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await stat(directory);
  if (info.uid !== process.getuid() || info.mode & 0o077) throw new Error('Chrome接続の保存先は所有者専用のディレクトリが必要です');
  return { socket: join(directory, 'session.sock'), log: join(directory, 'session.log'), setup: join(directory, 'setup.json'), name: `shopping-${key}` };
}

export function requestSession(socket, request) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    client.setEncoding('utf8');
    let data = '';
    client.setTimeout(240_000, () => client.destroy(new Error('操作の応答待ちがタイムアウトしました。結果を確認し、自動再実行しないでください')));
    client.once('connect', () => client.write(JSON.stringify(request) + '\n'));
    client.on('data', chunk => {
      data += chunk;
      if (!data.includes('\n')) return;
      try { const result = JSON.parse(data.slice(0, data.indexOf('\n'))); client.end(); resolve(result); }
      catch (error) { client.destroy(error); }
    });
    client.once('error', reject);
    client.once('end', () => { if (!data.includes('\n')) reject(new Error('接続が終了しました。追加操作は結果を確認してから判断してください')); });
  });
}

export async function serveSession(socket, connect = () => chromium.connectOverCDP('chrome', { timeout: 0, noDefaults: true }), { transport = 'direct', onStop = async () => {} } = {}) {
  let browser, failure, busy = false, state = transport === 'extension' ? 'connecting' : 'waiting_for_permission', finish;
  const closed = new Promise(resolve => { finish = resolve; });
  const status = async () => ({ success: state === 'connected', state, transport, ...(failure ? { error: failure } : {}),
    ...(browser?.isConnected() ? { tabs: await Promise.all(browser.contexts().flatMap(c => c.pages())
      .filter(p => { try { return new URL(p.url()).origin === 'https://www.amazon.co.jp'; } catch { return false; } })
      .map(async p => ({ url: safeURL(p.url()), title: await p.title().catch(() => '') }))) } : {}) });
  const stop = async () => {
    if (state === 'stopped') return;
    state = 'stopped';
    await browser?.close().catch(() => {}); // Disconnect only; tabs stay open.
    await onStop().catch(() => {});
    await new Promise(resolve => server.close(resolve));
    await unlink(socket).catch(() => {});
    finish();
  };
  const server = net.createServer(client => {
    let data = '', handled = false;
    client.setEncoding('utf8'); client.setTimeout(10_000, () => client.destroy());
    client.on('error', () => {});
    client.on('data', async chunk => {
      data += chunk;
      if (data.length > 16_384) { client.destroy(); return; }
      if (handled || !data.includes('\n')) return;
      handled = true; client.setTimeout(0);
      const reply = result => client.end(JSON.stringify(safeValue(result)) + '\n');
      try {
        const request = JSON.parse(data.slice(0, data.indexOf('\n')));
        if (request.command === 'status') return reply(await status());
        if (request.command === 'stop') {
          if (busy) throw new Error('操作中のため停止できません。結果を待ってください');
          reply({ success: true, state: 'stopping' });
          await stop(); return;
        }
        if (request.command !== 'run' || !Array.isArray(request.args) || !request.args.every(a => typeof a === 'string') || !commands.includes(request.args[0])) throw new Error('未対応のコマンドです');
        if (state !== 'connected') throw new Error('Chromeへの接続が完了していません。statusで確認してください');
        if (busy) throw new Error('別の操作を実行中です。自動再実行せず結果を待ってください');
        if (request.args.some(a => /^--(?:cdp|profile|headless|keep-open)(?:=|$)/.test(a))) throw new Error('保持中の既存Chromeを使うため、接続先・プロファイルの変更は指定できません');
        const config = options([...request.args, '--cdp', 'chrome']);
        config.extensionConnection = transport === 'extension';
        busy = true;
        try { reply(await main(config, browser)); }
        finally { busy = false; }
      } catch (error) { reply({ success: false, error: error.message, exitCode: 1 }); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  await chmod(socket, 0o600);
  // Listen before requesting permission: status/stop work while Chrome waits.
  connect().then(async connected => {
    if (state === 'stopped') { await connected.close(); await onStop(); return; }
    browser = connected; state = 'connected';
    browser.on('disconnected', () => { if (state !== 'stopped') state = 'disconnected'; });
    console.log(JSON.stringify({ time: new Date().toISOString(), event: 'chrome-connected', transport }));
  }).catch(error => { if (state !== 'stopped') { state = 'failed'; failure = safeValue(error.message); } });
  return { status, stop, closed };
}

async function cli(args) {
  const direct = args[0] === '--direct';
  if (direct) args.shift();
  const paths = await sessionPaths(direct);
  const command = args.shift() ?? 'status';
  if (command === '--setup-worker') {
    const setup = await serveExtensionSetup();
    await writeFile(paths.setup, JSON.stringify({ url: setup.url }), { mode: 0o600 });
    process.on('SIGTERM', setup.stop); process.on('SIGINT', setup.stop);
    await setup.closed; await unlink(paths.setup).catch(() => {}); return;
  }
  if (command === 'setup-extension') {
    try {
      const setup = JSON.parse(await readFile(paths.setup, 'utf8'));
      if ((await fetch(setup.url, { signal: AbortSignal.timeout(1000) })).ok) { console.log(JSON.stringify(setup)); return; }
    } catch {}
    const log = await open(paths.log, 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--setup-worker'], { detached: true, stdio: ['ignore', log.fd, log.fd] });
    child.unref(); await log.close();
    for (let i = 0; i < 50; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      try {
        const setup = JSON.parse(await readFile(paths.setup, 'utf8'));
        if ((await fetch(setup.url, { signal: AbortSignal.timeout(500) })).ok) { console.log(JSON.stringify(setup)); return; }
      } catch {}
    }
    throw new Error('初回設定画面を起動できませんでした');
  }
  if (command === '--worker') {
    const config = direct ? null : await readExtensionConfig();
    if (!direct && !config) throw new Error('公式拡張が未設定です。setup-extensionで初回設定してください。直接接続には切り替えません');
    let extension;
    const connect = config ? async () => { extension = await connectExtension(config, paths.name); return extension.browser; } : undefined;
    const session = await serveSession(paths.socket, connect, { transport: config ? 'extension' : 'direct', onStop: async () => { await extension?.disconnect(); } });
    const shutdown = async () => { await session.stop(); process.exit(0); };
    process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
    await session.closed; process.exit(0);
  }
  if (command === 'start') {
    const config = direct ? null : await readExtensionConfig();
    if (!direct && !config) throw new Error('公式拡張が未設定です。setup-extensionで初回設定してください。直接接続には切り替えません');
    try {
      const status = await requestSession(paths.socket, { command: 'status' });
      if (!direct && status.transport !== 'extension') throw new Error('旧方式の接続が残っています。stop後にstartで公式拡張へ接続してください');
      console.log(JSON.stringify(status, null, 2)); return;
    }
    catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
      if (error.code === 'ECONNREFUSED') await unlink(paths.socket);
    }
    const log = await open(paths.log, 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...direct ? ['--direct'] : [], '--worker'], { detached: true, stdio: ['ignore', log.fd, log.fd] });
    child.unref(); await log.close();
    console.log(JSON.stringify({ success: true, state: 'starting', log: paths.log, transport: config ? 'extension' : 'direct', message: config ? '登録済みの公式拡張に接続します。statusで結果を確認してください。' : 'Chromeの確認で許可してください。毎回の確認を省くには setup-extension で公式拡張を初回設定できます。' }, null, 2));
    return;
  }
  const request = ['status', 'stop'].includes(command) ? { command } : { command: 'run', args: [command, ...args] };
  const result = await requestSession(paths.socket, request).catch(async error => {
    if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) {
      if (command === 'status') return { success: false, state: 'stopped', extensionConfigured: !direct && !!(await readExtensionConfig()) };
      throw new Error('保持中の接続がありません。npm run chrome -- start を実行してください');
    }
    throw error;
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.exitCode ?? (result.success || result.state === 'waiting_for_permission' ? 0 : 1);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await cli(process.argv.slice(2)); }
  catch (error) { console.error(safeValue(error.message)); process.exitCode = 1; }
}
