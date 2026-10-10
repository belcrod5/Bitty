import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Precomposed notification resources: the app never draws these badges at runtime.
// Requires the existing ImageMagick CLI; uses no npm dependencies.
const output = process.argv[3];
if (!output) throw new Error('Usage: node scripts/generate-push-notification-assets.mjs expo/assets/icon.png /path/to/output');
const root = path.resolve(output);
const basePath = process.argv[2];
if (!basePath) throw new Error('Usage: node scripts/generate-push-notification-assets.mjs expo/assets/icon.png /path/to/output');
const logo = fs.readFileSync(basePath).toString('base64');
const purposes = [
  { slug: 'turn-completed', category: 'TURN_COMPLETED', name: 'タスク完了', color: '#3269D8', light: '#DCEBFF', notes: [659.25, 880], symbol: '<path d="M-37-3-11 23 30-23 38-15-10 37-45 5z"/>' },
  { slug: 'voice-completed', category: 'VOICE_COMPLETED', name: '音声返信', color: '#008B96', light: '#D5F3F0', notes: [523.25, 659.25, 783.99], symbol: [-32,-16,0,16,32].map((x,i)=>`<rect x="${x-4}" y="${-[15,26,36,26,15][i]}" width="8" height="${2*[15,26,36,26,15][i]}" rx="4"/>`).join('') },
  { slug: 'approval-request', category: 'APPROVAL_REQUEST', name: '承認依頼', color: '#AE6712', light: '#FFF0C6', notes: [587.33, 783.99, 587.33], symbol: '<path d="M-24-17C-24-47 28-47 28-17C28 1 5 8 5 19H-7C-7-1 15-3 15-17C15-33-12-33-12-17z"/><circle cx="-1" cy="32" r="6"/>' },
  { slug: 'schedule-failed', category: 'SCHEDULE_FAILED', name: 'スケジュール失敗', color: '#CE4650', light: '#FFE1E2', notes: [523.25, 392], symbol: '<path fill-rule="evenodd" d="M-35-27H35V36H-35zM-27-9V28H27V-9z"/><rect x="-20" y="-37" width="8" height="22" rx="4"/><rect x="12" y="-37" width="8" height="22" rx="4"/><path d="M-10-3 0 7 10-3 16 3 6 13 16 23 10 29 0 19-10 29-16 23-6 13-16 3z"/>' },
  { slug: 'codex-usage-limit', category: 'CODEX_USAGE_LIMIT', name: 'Codex利用上限', color: '#7753C0', light: '#EBE2FF', notes: [440, 440], symbol: '<path d="M-35 17A40 40 0 1 1 35 17L25 12A29 29 0 1 0-25 12zM-5-9 24-31 5-1z"/><circle cy="-5" r="7"/><rect x="-23" y="27" width="46" height="9" rx="4"/>' },
];
const variants = [
  { slug: 'simple', name: 'Simple', description: '用途の色と白い記号。まずはこちらを採用。', wave: 'sine', volume: 0.21, toneMs: 125, gapMs: 35 },
  { slug: 'soft', name: 'Soft', description: '淡い色と柔らかい音。控えめな印象。', wave: 'bell', volume: 0.17, toneMs: 190, gapMs: 30 },
  { slug: 'retro', name: 'Retro', description: '角のある記号と短い電子音。既存テーマに近い印象。', wave: 'triangle', volume: 0.16, toneMs: 100, gapMs: 30 },
];
const sampleRate = 44100;
const manifest = [];

function iconSvg(purpose, variant) {
  const soft = variant.slug === 'soft';
  const retro = variant.slug === 'retro';
  const ink = soft ? purpose.color : '#fff';
  const shape = retro
    ? `<path d="M-69-56h13v-13h112v13h13v112H56v13H-56V56h-13z" fill="#fff"/><path d="M-64-52h12v-12h104v12h12v104H52v12H-52V52h-12z" fill="${purpose.color}"/>`
    : `<circle r="75" fill="#fff"/><circle r="71" fill="${soft ? purpose.light : purpose.color}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="512" height="512" viewBox="0 0 512 512">
<image width="512" height="512" xlink:href="data:image/png;base64,${logo}"/>
<g transform="translate(342 371)">${shape}<g fill="${ink}">${purpose.symbol}</g></g>
</svg>`;
}

function sound(purpose, variant) {
  const totalMs = purpose.notes.length * variant.toneMs + (purpose.notes.length - 1) * variant.gapMs + 50;
  const samples = new Float64Array(Math.ceil(totalMs * sampleRate / 1000));
  purpose.notes.forEach((frequency, index) => {
    const start = Math.round(index * (variant.toneMs + variant.gapMs) * sampleRate / 1000);
    const count = Math.round(variant.toneMs * sampleRate / 1000);
    for (let i = 0; i < count; i++) {
      const t = i / sampleRate;
      const u = i / (count - 1);
      const fadeIn = Math.min(1, t / 0.012);
      const fadeOut = Math.min(1, (1 - u) * variant.toneMs / 32);
      const envelope = fadeIn * fadeOut * Math.exp(-2.5 * u);
      const phase = 2 * Math.PI * frequency * t;
      let value = Math.sin(phase);
      if (variant.wave === 'bell') value = (Math.sin(phase) + 0.17 * Math.sin(2 * phase) + 0.06 * Math.sin(3 * phase)) / 1.23;
      if (variant.wave === 'triangle') value = 2 / Math.PI * Math.asin(Math.sin(phase));
      samples[start + i] = value * envelope * variant.volume;
    }
  });
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(samples.length * 2, 40);
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => pcm.writeInt16LE(Math.round(value * 32767), index * 2));
  return Buffer.concat([header, pcm]);
}

for (const variant of variants) {
  const dir = path.join(root, variant.slug);
  for (const subdir of ['icons', 'sounds']) fs.mkdirSync(path.join(dir, subdir), { recursive: true });
  for (const purpose of purposes) {
    const icon = `${variant.slug}/icons/${purpose.slug}.png`;
    const svg = icon.replace(/\.png$/, '.svg');
    const wav = `${variant.slug}/sounds/bitty-${purpose.slug}.wav`;
    fs.writeFileSync(path.join(root, svg), iconSvg(purpose, variant));
    execFileSync('magick', ['-background', 'none', path.join(root, svg), '-strip', '-depth', '8', `PNG24:${path.join(root, icon)}`]);
    fs.writeFileSync(path.join(root, wav), sound(purpose, variant));
    manifest.push({ variant: variant.slug, category: purpose.category, name: purpose.name, icon, sound: wav });
  }
}
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
execFileSync('magick', ['montage', ...manifest.map(item => path.join(root, item.icon)), '-tile', '5x3', '-geometry', '160x160+8+8', '-background', '#EEF3FA', path.join(root, 'contact-sheet.png')], { stdio: 'pipe' });

const rows = variants.map(variant => `<section><div class="heading"><h2>${variant.name}</h2><p>${variant.description}</p></div><div class="grid">${purposes.map(p => `<article><div class="icons"><img src="${variant.slug}/icons/${p.slug}.png" alt="${p.name}"><img class="small" src="${variant.slug}/icons/${p.slug}.png" alt="48pxの見え方"></div><h3>${p.name}</h3><p class="slug">${p.category}</p><audio controls preload="none" src="${variant.slug}/sounds/bitty-${p.slug}.wav"></audio></article>`).join('')}</div></section>`).join('');
fs.writeFileSync(path.join(root, 'index.html'), `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bitty 通知素材の候補</title><style>
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#f2f6fc;color:#162443;margin:0;padding:32px}main{max-width:1200px;margin:auto}h1{font-size:28px;margin:0 0 12px}p{line-height:1.7;color:#53647d}header{margin-bottom:32px}.notice{font-size:14px;max-width:850px}.heading{display:flex;align-items:baseline;gap:24px}h2{font-size:21px}section{margin-bottom:32px}.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:14px}article{background:#fff;border:1px solid #dbe4f1;border-radius:18px;padding:18px 12px;text-align:center}.icons{height:142px;display:flex;align-items:center;justify-content:center;gap:8px}img{width:104px;height:104px;border-radius:50%}.small{width:48px;height:48px}h3{font-size:15px;margin:10px 0 0}.slug{font-size:10px;white-space:nowrap;margin:4px 0 12px}audio{width:100%;height:36px}@media(max-width:950px){.grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:480px){body{padding:18px}.grid{grid-template-columns:1fr}.heading{display:block}header h1{font-size:24px}}
</style><main><header><h1>Bitty 通知素材の候補</h1><p>5用途 × 3パターン。左は拡大、右は48px。音は各カードから試聴できます。</p><p class="notice">これは素材確認用の一覧です。実際のiOS通知画面ではありません。円形表示の確認用に丸く切り抜いています。iOSが追加する小さなアプリアイコンは表示していません。音量は端末の再生音量にも依存します。</p></header>${rows}</main><script>document.querySelectorAll('audio').forEach(player=>player.addEventListener('play',()=>document.querySelectorAll('audio').forEach(other=>{if(other!==player)other.pause()})));</script></html>`);
console.log(`Generated ${manifest.length} PNG icons and ${manifest.length} WAV sounds in ${root}`);
