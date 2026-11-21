import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { productAsin, safeURL, safeValue, isCartPath, isAuthPath } from './navigation.mjs';

const execute = promisify(execFile);
export function chromeProcesses(text, uid) {
  return text.split('\n').flatMap(line => {
    const row = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!row || Number(row[1]) !== uid || !/\/(?:Google Chrome|Chromium)\.app\/Contents\/MacOS\/(?:Google Chrome|Chromium)$/.test(row[3])) return [];
    return [{ pid: Number(row[2]) }];
  });
}
export function debugArguments(command) {
  const port = command.match(/--remote-debugging-port(?:=|\s+)(\d+)(?=\s|$)/)?.[1];
  const profile = command.match(/--user-data-dir=(.*?)(?= --|$)/)?.[1]?.trim().replace(/^["']|["']$/g, '');
  return { port: Number(port) || null, profile, pipe: command.includes('--remote-debugging-pipe') };
}
export function listenerPorts(text) {
  return [...new Set(text.split('\n').filter(line => line.startsWith('n')).map(line => Number(line.match(/:(\d+)$/)?.[1])).filter(port => port > 0 && port <= 65535))];
}
async function localJSON(endpoint, pathname) {
  const response = await fetch(endpoint + pathname, { signal: AbortSignal.timeout(1000), redirect: 'manual' });
  if (!response.ok) throw new Error('Not a CDP response');
  const reader = response.body.getReader(); let size = 0; let text = ''; const decoder = new TextDecoder();
  try {
    while (true) {
      const {done,value} = await reader.read(); if (done) break;
      size += value.length; if (size > 1_000_000) throw new Error('CDP response too large');
      text += decoder.decode(value,{stream:true});
    }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel().catch(()=>{}); }
}
// Read-only metadata discovery. No browser launch, port scan, tab creation or navigation.
export async function discoverBrowsers({ run = execute, read = readFile, request = localJSON, uid = process.getuid() } = {}) {
  let processes;
  try { processes = chromeProcesses((await run('ps',['-axo','uid=,pid=,comm='])).stdout,uid); }
  catch { return {status:'inspection_unavailable',code:'DISCOVERY_UNAVAILABLE',message:'Chromeのプロセス情報を読み取れません。サンドボックス制限なら読み取りコマンドを通常権限で再実行してください。CDPのURLをユーザーに尋ねる段階ではありません。',browsers:[]}; }
  const candidates = new Map(); let inaccessible=0; let pipes=0;
  for (const process of processes) {
    try {
      const args=debugArguments((await run('ps',['-p',String(process.pid),'-o','command='])).stdout);
      if(args.pipe) pipes++;
      const ports=new Set(args.port ? [args.port] : []);
      if(args.profile) {
        try { const port=Number((await read(join(args.profile,'DevToolsActivePort'),'utf8')).split('\n')[0]); if(port>0 && port<=65535) ports.add(port); } catch {}
      }
      try {
        const listeners=await run('lsof',['-nP','-a','-p',String(process.pid),'-iTCP','-sTCP:LISTEN','-Fn']);
        for(const port of listenerPorts(listeners.stdout)) ports.add(port);
      } catch(e) { if(e.code!==1 || /permission denied|operation not permitted/i.test(e.stderr ?? '')) inaccessible++; }
      for(const port of ports) if(port<=65535) candidates.set(`http://127.0.0.1:${port}`,process.pid);
    } catch { inaccessible++; }
  }
  const results=await Promise.all([...candidates].map(async ([endpoint,pid])=>{
    try {
      const version=await request(endpoint,'/json/version');
      const ws=new URL(version.webSocketDebuggerUrl);
      if(!/Chrome|Chromium/.test(version.Browser??'') || !['127.0.0.1','localhost','[::1]'].includes(ws.hostname) || !ws.pathname.startsWith('/devtools/browser/')) return null;
      const targets=await request(endpoint,'/json/list');
      if(!Array.isArray(targets)) return null;
      const tabs=targets.filter(t=>t.type==='page').flatMap(t=>{
        try { if(new URL(t.url).origin==='https://www.amazon.co.jp') return [{id:t.id,url:safeURL(t.url),title:safeValue(t.title??'')}]; } catch {}
        return [];
      });
      return {endpoint,pid,tabs};
    } catch { return null; }
  }));
  const browsers=results.filter(Boolean);
  if(browsers.length) return {status:'available',browsers};
  const code=inaccessible?'DISCOVERY_UNAVAILABLE':candidates.size?'CDP_UNREACHABLE':processes.length?'CDP_UNAVAILABLE':'CHROME_NOT_RUNNING';
  const message=inaccessible?'Chromeの接続情報の一部を読み取れませんでした。接続先URLを尋ねる前に実行権限を確認してください。':candidates.size?'Chromeの接続先候補を検出しましたが、CDPの応答を確認できませんでした。接続不能の理由を確認してください。':processes.length
    ? '起動中のChromeに利用可能なCDPポートがありません。現在のChromeにはPlaywrightから接続できず、接続先URLを尋ねても解決しません。'
    :'起動中のChromeが見つかりません。';
  return {status:inaccessible?'inspection_unavailable':'unavailable',code,message,pipeConnectionsDetected:pipes>0,checkedEndpoints:[...candidates.keys()],browsers};
}
export function chooseBrowser(report,{command,asin,tabURL}={}) {
  if(report.status!=='available') { const e=new Error(report.message); e.code=report.code; throw e; }
  let matches=report.browsers.flatMap(browser=>browser.tabs.map(tab=>({endpoint:browser.endpoint,tab})));
  if(tabURL) matches=matches.filter(t=>t.tab.url===safeURL(tabURL));
  else if(command==='cart-add' && asin) {
    const products=matches.filter(t=>productAsin(new URL(t.tab.url).pathname)===asin);
    if(products.length) matches=products;
  } else if(command==='cart') {
    const carts=matches.filter(t=>isCartPath(new URL(t.tab.url).pathname)||isAuthPath(new URL(t.tab.url).pathname));
    if(carts.length) matches=carts;
  }
  if(matches.length!==1) {
    const e=new Error(matches.length?'対象のAmazonタブが複数あります。browser-statusのタイトル・商品を確認して対象を特定してください。':'接続可能なChromeに対象のAmazonタブがありません。');
    e.code=matches.length?'BROWSER_AMBIGUOUS':'AMAZON_TAB_NOT_FOUND'; throw e;
  }
  return {endpoint:matches[0].endpoint,tabURL:matches[0].tab.url};
}
