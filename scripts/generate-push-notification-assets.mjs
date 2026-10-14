import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Generate only purpose images. iOS supplies the small Bitty app badge.
// Notification sounds are reviewed assets and must never be regenerated here.
const output = process.argv[2];
if (!output || process.argv.length !== 3) throw new Error('Usage: node scripts/generate-push-notification-assets.mjs /path/to/icon-output');
const root = path.resolve(output);
const purposes = [
  { slug: 'turn-completed', category: 'TURN_COMPLETED', name: 'タスク完了', color: '#3269D8', light: '#DCEBFF', symbol: '<g transform="translate(3.5 -7)"><path d="M-37-3-11 23 30-23 38-15-10 37-45 5z"/></g>' },
  { slug: 'voice-completed', category: 'VOICE_COMPLETED', name: '音声返信', color: '#008B96', light: '#D5F3F0', symbol: [-32,-16,0,16,32].map((x,i)=>`<rect x="${x-4}" y="${-[15,26,36,26,15][i]}" width="8" height="${2*[15,26,36,26,15][i]}" rx="4"/>`).join('') },
  { slug: 'approval-request', category: 'APPROVAL_REQUEST', name: '承認依頼', color: '#AE6712', light: '#FFF0C6', symbol: '<path d="M-24-17C-24-47 28-47 28-17C28 1 5 8 5 19H-7C-7-1 15-3 15-17C15-33-12-33-12-17z"/><circle cx="-1" cy="32" r="6"/>' },
  { slug: 'schedule-failed', category: 'SCHEDULE_FAILED', name: 'スケジュール失敗', color: '#CE4650', light: '#FFE1E2', symbol: '<path fill-rule="evenodd" d="M-35-27H35V36H-35zM-27-9V28H27V-9z"/><rect x="-20" y="-37" width="8" height="22" rx="4"/><rect x="12" y="-37" width="8" height="22" rx="4"/><path d="M-8-3 0 5 8-3 13 2 5 10 13 18 8 23 0 15-8 23-13 18-5 10-13 2z"/>' },
  { slug: 'codex-usage-limit', category: 'CODEX_USAGE_LIMIT', name: 'Codex利用上限', color: '#7753C0', light: '#EBE2FF', symbol: '<path d="M-35 17A40 40 0 1 1 35 17L25 12A29 29 0 1 0-25 12zM-5-9 24-31 5-1z"/><circle cy="-5" r="7"/><rect x="-23" y="27" width="46" height="9" rx="4"/>' },
];
const variants = [
  { slug: 'simple', name: 'Simple', description: '用途の色と白いシンボル。採用中。' },
  { slug: 'soft', name: 'Soft', description: '淡い背景と用途の色のシンボル。比較用。' },
  { slug: 'retro', name: 'Retro', description: '用途の色と輪郭をくっきり描くシンボル。比較用。' },
];
const manifest = [];

function iconSvg(purpose, variant) {
  const soft = variant.slug === 'soft';
  const background = soft ? purpose.light : purpose.color;
  const ink = soft ? purpose.color : '#fff';
  const rendering = variant.slug === 'retro' ? 'crispEdges' : 'geometricPrecision';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<rect width="512" height="512" fill="${background}"/>
<g transform="translate(256 256) scale(3.6)" fill="${ink}" shape-rendering="${rendering}">${purpose.symbol}</g>
</svg>`;
}

for (const variant of variants) {
  fs.mkdirSync(path.join(root, variant.slug, 'icons'), { recursive: true });
  for (const purpose of purposes) {
    const icon = `${variant.slug}/icons/${purpose.slug}.png`;
    const svg = icon.replace(/\.png$/, '.svg');
    fs.writeFileSync(path.join(root, svg), iconSvg(purpose, variant));
    execFileSync('magick', ['-background', 'none', path.join(root, svg), '-strip', '-depth', '8', `PNG24:${path.join(root, icon)}`]);
    manifest.push({ variant: variant.slug, category: purpose.category, name: purpose.name, icon });
  }
}
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
execFileSync('magick', ['montage', ...manifest.map(item => path.join(root, item.icon)), '-tile', '5x3', '-geometry', '160x160+8+8', '-background', '#EEF3FA', path.join(root, 'contact-sheet.png')], { stdio: 'pipe' });

const rows = variants.map(variant => `<section><div class="heading"><h2>${variant.name}</h2><p>${variant.description}</p></div><div class="grid">${purposes.map(p => `<article><div class="icons"><img src="${variant.slug}/icons/${p.slug}.png" alt="${p.name}"><img class="small" src="${variant.slug}/icons/${p.slug}.png" alt="48pxの見え方"></div><h3>${p.name}</h3><p class="slug">${p.category}</p><audio controls preload="none" src="${variant.slug}/sounds/bitty-${p.slug}.wav"></audio></article>`).join('')}</div></section>`).join('');
fs.writeFileSync(path.join(root, 'index.html'), `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bitty 通知アイコンの候補</title><style>
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#f2f6fc;color:#162443;margin:0;padding:32px}main{max-width:1200px;margin:auto}h1{font-size:28px;margin:0 0 12px}p{line-height:1.7;color:#53647d}header{margin-bottom:32px}.notice{font-size:14px;max-width:850px}.heading{display:flex;align-items:baseline;gap:24px}h2{font-size:21px}section{margin-bottom:32px}.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:14px}article{background:#fff;border:1px solid #dbe4f1;border-radius:18px;padding:18px 12px;text-align:center}.icons{height:142px;display:flex;align-items:center;justify-content:center;gap:8px}img{width:104px;height:104px;border-radius:50%}.small{width:48px;height:48px}h3{font-size:15px;margin:10px 0 0}.slug{font-size:10px;white-space:nowrap;margin:4px 0 12px}audio{width:100%;height:36px}@media(max-width:950px){.grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:480px){body{padding:18px}.grid{grid-template-columns:1fr}.heading{display:block}header h1{font-size:24px}}
</style><main><header><h1>Bitty 通知アイコンの候補</h1><p>5用途 × 3パターン。大きな円には用途シンボルだけを表示します。左は拡大、右は48px。</p><p class="notice">これは素材確認用の一覧です。実際のiOS通知画面ではありません。iOSは用途画像を円形に表示し、右下へ小さなBittyアプリアイコンを自動で付けます。この一覧では小アイコンを省略しています。音は既存ファイルを試聴します。アイコン再生成で音は変更しません。</p></header>${rows}</main><script>document.querySelectorAll('audio').forEach(player=>player.addEventListener('play',()=>document.querySelectorAll('audio').forEach(other=>{if(other!==player)other.pause()})));</script></html>`);
console.log(`Generated ${manifest.length} PNG icons in ${root}; notification sounds were not modified.`);
