import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, chmod, unlink, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { main, options } from './search.mjs';
import { safeURL, safeValue } from './navigation.mjs';

// One private local socket, one Chrome connection, one command at a time.
const commands = ['search', 'detail', 'orders', 'cart', 'cart-add', 'browser-status'];
export async function sessionPaths() {
  const source = await realpath(dirname(fileURLToPath(import.meta.url)));
  const key = createHash('sha256').update(source).digest('hex').slice(0, 12);
  const directory = join(tmpdir(), `shopping-chrome-${key}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await stat(directory);
  if (info.uid !== process.getuid() || info.mode & 0o077) throw new Error('Chrome接続の保存先は所有者専用のディレクトリが必要です');
  return { socket: join(directory, 'session.sock'), log: join(directory, 'session.log') };
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

export async function serveSession(socket, connect = () => chromium.connectOverCDP('chrome', { timeout: 0, noDefaults: true })) {
  let browser, failure, busy = false, state = 'waiting_for_permission', idle, finish;
  const closed = new Promise(resolve => { finish = resolve; });
  const status = async () => ({ success: state === 'connected', state, ...(failure ? { error: failure } : {}),
    ...(browser?.isConnected() ? { tabs: await Promise.all(browser.contexts().flatMap(c => c.pages())
      .filter(p => { try { return new URL(p.url()).origin === 'https://www.amazon.co.jp'; } catch { return false; } })
      .map(async p => ({ url: safeURL(p.url()), title: await p.title().catch(() => '') }))) } : {}) });
  const stop = async () => {
    if (state === 'stopped') return;
    clearTimeout(idle); state = 'stopped';
    await browser?.close().catch(() => {}); // CDP disconnect only; tabs stay open.
    await new Promise(resolve => server.close(resolve));
    await unlink(socket).catch(() => {});
    finish();
  };
  const resetIdle = () => { clearTimeout(idle); idle = setTimeout(stop, 30 * 60_000); };
  const server = net.createServer(client => {
    let data = '', handled = false;
    client.setEncoding('utf8'); client.setTimeout(10_000, () => client.destroy());
    client.on('error', () => {});
    client.on('data', async chunk => {
      data += chunk;
      if (data.length > 16_384) { client.destroy(); return; }
      if (handled || !data.includes('\n')) return;
      handled = true; client.setTimeout(0); resetIdle();
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
        busy = true;
        try { reply(await main(config, browser)); }
        finally { busy = false; resetIdle(); }
      } catch (error) { reply({ success: false, error: error.message, exitCode: 1 }); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  await chmod(socket, 0o600); resetIdle();
  // Listen before requesting permission: status/stop work while Chrome waits.
  connect().then(async connected => {
    if (state === 'stopped') { await connected.close(); return; }
    browser = connected; state = 'connected';
    browser.on('disconnected', () => { if (state !== 'stopped') state = 'disconnected'; });
    console.log(JSON.stringify({ time: new Date().toISOString(), event: 'chrome-connected' }));
  }).catch(error => { if (state !== 'stopped') { state = 'failed'; failure = safeValue(error.message); } });
  return { status, stop, closed };
}

async function cli(args) {
  const paths = await sessionPaths();
  const command = args.shift() ?? 'status';
  if (command === '--worker') {
    const session = await serveSession(paths.socket);
    const shutdown = async () => { await session.stop(); process.exit(0); };
    process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
    await session.closed; process.exit(0);
  }
  if (command === 'start') {
    try { console.log(JSON.stringify(await requestSession(paths.socket, { command: 'status' }), null, 2)); return; }
    catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
      if (error.code === 'ECONNREFUSED') await unlink(paths.socket);
    }
    const log = await open(paths.log, 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker'], { detached: true, stdio: ['ignore', log.fd, log.fd] });
    child.unref(); await log.close();
    console.log(JSON.stringify({ success: true, state: 'starting', log: paths.log, message: 'Chromeの確認で許可してください。接続要求は返答後も保持されます。statusで接続結果を確認できます。' }, null, 2));
    return;
  }
  const request = ['status', 'stop'].includes(command) ? { command } : { command: 'run', args: [command, ...args] };
  const result = await requestSession(paths.socket, request).catch(error => {
    if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw new Error('保持中の接続がありません。npm run chrome -- start を実行してください');
    throw error;
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.exitCode ?? (result.success || result.state === 'waiting_for_permission' ? 0 : 1);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await cli(process.argv.slice(2)); }
  catch (error) { console.error(safeValue(error.message)); process.exitCode = 1; }
}
