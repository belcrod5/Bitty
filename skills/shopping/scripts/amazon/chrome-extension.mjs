import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { safeValue } from './navigation.mjs';

const execute = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
const cli = join(dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')), 'cli.js');
export const extensionConfigPath = join(root, '.chrome-extension.json');
export const extensionStoreURL = 'https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm';

export function validateExtensionConfig(value) {
  const token = typeof value.token === 'string' ? value.token.trim() : '';
  const profile = typeof value.profile === 'string' ? value.profile.trim() : '';
  if (!/^[A-Za-z0-9._~-]{16,512}$/.test(token)) throw new Error('拡張画面の接続キーの値だけを貼り付けてください');
  if (profile && !/^(Default|Profile [1-9][0-9]*)$/.test(profile)) throw new Error('プロファイルは空欄、Default、Profile 1などで指定してください');
  return { token, ...(profile ? { profile } : {}) };
}
export async function readExtensionConfig(path = extensionConfigPath) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077 || info.size > 4096) throw new Error('拡張設定は所有者だけが読める通常ファイル（0600）にしてください');
  return validateExtensionConfig(JSON.parse(await readFile(path, 'utf8')));
}
export async function saveExtensionConfig(value, path = extensionConfigPath) {
  const config = validateExtensionConfig(value);
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(config) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

// Playwright 1.65.1 exposes the extension through its CLI. Use its public
// browser-server listing and BrowserType.connect, without copying relay code.
export async function connectExtension(config, sessionName, { run = execute, connect = endpoint => chromium.connect(endpoint), cwd = root } = {}) {
  const env = { ...process.env, DEBUG: '', PLAYWRIGHT_MCP_EXTENSION_TOKEN: config.token };
  delete env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME;
  if (config.profile) env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME = config.profile;
  const invoke = async args => {
    try {
      const { stdout } = await run(process.execPath, [cli, 'cli', ...args, '--json'], { cwd, env, timeout: 60_000, maxBuffer: 1_000_000 });
      const result = JSON.parse(stdout);
      if (result.isError) throw new Error(result.error || 'Playwright拡張への接続に失敗しました');
      return result;
    } catch (error) {
      throw new Error(safeValue(error.message.replaceAll(config.token, '[redacted]')));
    }
  };
  const disconnect = () => invoke(['detach', `--session=${sessionName}`]);
  try {
    await invoke(['attach', '--extension=chrome', `--session=${sessionName}`]);
    const listing = await invoke(['list', '--all']);
    const matches = (listing.servers ?? []).filter(server => server.title === sessionName);
    if (matches.length !== 1) throw new Error('買い物専用のPlaywright接続先を一意に取得できません');
    const endpoint = matches[0].endpoint ?? matches[0].pipeName;
    if (typeof endpoint !== 'string' || !endpoint.startsWith('/')) throw new Error('Playwrightのローカルソケットが見つかりません');
    return { browser: await connect(endpoint), disconnect };
  } catch (error) {
    await disconnect().catch(() => {});
    throw error;
  }
}

// The setup page only saves local configuration. It never controls Chrome or
// accepts a connection on the user's behalf. Tokens are not echoed or logged.
export async function serveExtensionSetup({ path = extensionConfigPath, lifetime = 30 * 60_000 } = {}) {
  const route = `/setup/${randomBytes(24).toString('hex')}`;
  let url, saved = false, finish;
  const closed = new Promise(resolve => { finish = resolve; });
  const stop = () => { clearTimeout(timer); server.close(() => finish()); server.closeIdleConnections(); };
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(body); };
    if (request.headers.host !== new URL(url).host || request.url !== route) return send(404, 'Not found');
    if (request.method === 'GET') return send(200, `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>買い物のChrome接続</title><style>body{font:18px system-ui;max-width:660px;margin:56px auto;padding:24px;line-height:1.8}input,button{font:inherit;padding:10px;width:95%;margin:8px 0}button{width:auto}label{display:block}small{color:#555}</style><h1>初回だけのChrome接続設定</h1><ol><li>AmazonにログインしているChromeに<a href="${extensionStoreURL}" target="_blank" rel="noreferrer">Playwright公式拡張</a>を追加します。</li><li>拡張アイコンを押し、<b>PLAYWRIGHT_MCP_EXTENSION_TOKEN</b>の値をコピーします。</li><li>下に貼り付けて保存します。</li></ol><form method="post" action="${route}"><label>接続キー<input name="token" type="password" required minlength="16" maxlength="512" autocomplete="off"></label><label>Chromeプロファイル（通常は空欄）<input name="profile" placeholder="自動選択" maxlength="32"></label><small>複数のプロファイルに拡張を入れた場合だけ、Default、Profile 1などを指定します。</small><p><button type="submit">このMacに保存</button></p></form><p>キーはこのMac内だけに保存します。チャットへの貼り付けは不要です。購入操作は行いません。</p></html>`);
    if (request.method !== 'POST') return send(405, 'Method not allowed');
    if (request.headers.origin !== new URL(url).origin || !request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) return send(403, 'Forbidden');
    try {
      let body = '';
      for await (const chunk of request) { body += chunk; if (body.length > 4096) return send(413, 'Too large'); }
      const values = new URLSearchParams(body);
      await saveExtensionConfig({ token: values.get('token'), profile: values.get('profile') }, path);
      saved = true;
      send(200, '<!doctype html><meta charset="utf-8"><title>保存しました</title><h1>保存しました</h1><p>チャットに戻り「保存した」と伝えてください。接続と検索を確認します。</p>');
      stop();
    } catch { send(400, '<meta charset="utf-8"><p>保存できませんでした。キーの値とプロファイル欄を確認し、戻ってやり直してください。</p>'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  url = `http://127.0.0.1:${server.address().port}${route}`;
  const timer = setTimeout(stop, lifetime);
  return { url, closed, stop, get saved() { return saved; } };
}
