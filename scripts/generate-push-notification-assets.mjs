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
  { slug: 'turn-completed', category: 'TURN_COMPLETED', name: 'タスク完了', color: '#3269D8', light: '#DCEBFF', symbol: '<path d="M-37-3-11 23 30-23 38-15-10 37-45 5z"/>' },
  { slug: 'voice-completed', category: 'VOICE_COMPLETED', name: '音声返信', color: '#008B96', light: '#D5F3F0', symbol: [-32,-16,0,16,32].map((x,i)=>`<rect x="${x-4}" y="${-[15,26,36,26,15][i]}" width="8" height="${2*[15,26,36,26,15][i]}" rx="4"/>`).join('') },
  { slug: 'approval-request', category: 'APPROVAL_REQUEST', name: '承認依頼', color: '#AE6712', light: '#FFF0C6', symbol: '<path d="M-24-17C-24-47 28-47 28-17C28 1 5 8 5 19H-7C-7-1 15-3 15-17C15-33-12-33-12-17z"/><circle cx="-1" cy="32" r="6"/>' },
  { slug: 'schedule-failed', category: 'SCHEDULE_FAILED', name: 'スケジュール失敗', color: '#CE4650', light: '#FFE1E2', symbol: '<path fill-rule="evenodd" d="M-35-27H35V36H-35zM-27-9V28H27V-9z"/><rect x="-20" y="-37" width="8" height="22" rx="4"/><rect x="12" y="-37" width="8" height="22" rx="4"/><path d="M-10-3 0 7 10-3 16 3 6 13 16 23 10 29 0 19-10 29-16 23-6 13-16 3z"/>' },
  { slug: 'codex-usage-limit', category: 'CODEX_USAGE_LIMIT', name: 'Codex利用上限', color: '#7753C0', light: '#EBE2FF', symbol: '<path d="M-35 17A40 40 0 1 1 35 17L25 12A29 29 0 1 0-25 12zM-5-9 24-31 5-1z"/><circle cy="-5" r="7"/><rect x="-23" y="27" width="46" height="9" rx="4"/>' },
];
const variants = [
  { slug: 'simple', name: 'Simple', description: '用途の色と白い記号。ベル・母音・木・低音・ガラスを使い分ける。' },
  { slug: 'soft', name: 'Soft', description: '淡い色。オルゴール・息声・竹・太鼓・水滴の柔らかい音。' },
  { slug: 'retro', name: 'Retro', description: '角のある記号。FM・ボコーダー・クラベ・ワウ・ソナーの電子音。' },
];
const sampleRate = 44100;
const manifest = [];
// Each purpose has its own material, attack, spectrum and contour, not just a melody.
// Events are [start seconds, frequency Hz, ringing seconds, relative level].
const soundProfiles = {
  simple: [
    { name: '温かいベル', kind: 'bell', events: [[0, 659.25, 0.62, 1]] },
    { name: '丸い母音「ウ」', kind: 'voice', events: [[0, 190, 0.38, 1]] },
    { name: '木の二度ノック', kind: 'wood', events: [[0, 640, 0.13, 1], [0.17, 760, 0.13, 0.85]] },
    { name: '下降する柔らかい低音', kind: 'bass', events: [[0, 190, 0.34, 1]] },
    { name: '透明なガラス', kind: 'glass', events: [[0, 1480, 0.42, 1]] },
  ],
  soft: [
    { name: '小さなオルゴール', kind: 'bell', events: [[0, 783.99, 0.31, 1], [0.16, 1046.5, 0.33, 0.7]] },
    { name: '息の混じる母音「ア」', kind: 'voice', events: [[0, 155, 0.43, 1]] },
    { name: '空洞のある竹', kind: 'wood', events: [[0, 480, 0.23, 1], [0.21, 600, 0.21, 0.65]] },
    { name: '布で抑えた太鼓', kind: 'bass', events: [[0, 260, 0.29, 1]] },
    { name: '二つの水滴', kind: 'glass', events: [[0, 1450, 0.2, 1], [0.18, 1800, 0.19, 0.8]] },
  ],
  retro: [
    { name: 'FMのリワード音', kind: 'bell', events: [[0, 523.25, 0.26, 0.8], [0.14, 1046.5, 0.35, 1]] },
    { name: '短いボコーダー', kind: 'voice', events: [[0, 240, 0.31, 1]] },
    { name: '電子クラベ', kind: 'wood', events: [[0, 1350, 0.095, 1], [0.145, 1620, 0.095, 0.8]] },
    { name: 'アナログのワウ低音', kind: 'bass', events: [[0, 220, 0.36, 1]] },
    { name: '金属的なソナー', kind: 'glass', events: [[0, 920, 0.41, 1]] },
  ],
};

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
  const profile = soundProfiles[variant.slug][purposes.indexOf(purpose)];
  const style = variant.slug;
  const duration = Math.max(...profile.events.map(([start, , ringing]) => start + ringing)) + 0.05;
  const samples = new Float64Array(Math.ceil(duration * sampleRate));
  profile.events.forEach(([offset, frequency, ringing, level]) => {
    const start = Math.round(offset * sampleRate);
    const count = Math.round(ringing * sampleRate);
    // Resonant modes describe [frequency ratio, strength, decay seconds].
    const modes = profile.kind === 'bell'
      ? (style === 'soft' ? [[1, 1, 0.11], [2.76, 0.4, 0.06], [5.4, 0.12, 0.04]] : [[1, 1, 0.23], [2.01, 0.3, 0.15], [2.75, 0.2, 0.1], [4.07, 0.08, 0.07]])
      : profile.kind === 'wood'
        ? (style === 'simple' ? [[1, 1, 0.019], [2.67, 0.7, 0.012], [4.5, 0.3, 0.007]] : style === 'soft' ? [[1, 1, 0.06], [1.63, 0.6, 0.04], [2.82, 0.3, 0.022]] : [[1, 1, 0.015], [1.48, 0.8, 0.012]])
        : [[1, 1, 0.13], [1.51, 0.35, 0.09], [2.11, 0.2, 0.065], [3.1, 0.1, 0.04]];
    for (let i = 0; i < count; i++) {
      const t = i / sampleRate;
      const u = i / (count - 1);
      const phase = 2 * Math.PI * frequency * t;
      let value = 0;
      if (profile.kind === 'voice') {
        // Harmonic excitation through moving vowel formants; no recorded speech.
        const pitchRatio = style === 'simple' ? 1.22 : style === 'soft' ? 1.12 : 1.5;
        const voicedPhase = phase * (1 + (pitchRatio - 1) * u / 2);
        const f0 = frequency * (1 + (pitchRatio - 1) * u);
        const formants = style === 'simple' ? [340 + 130 * u, 760 + 180 * u, 2200] : style === 'soft' ? [700 - 240 * u, 1300 + 200 * u, 2600] : [900 - 400 * u, 1900 - 300 * u, 3200];
        for (let harmonic = 1; harmonic <= 36; harmonic++) {
          const hz = f0 * harmonic;
          const resonance = formants.reduce((sum, center) => sum + Math.exp(-(((hz - center) / (style === 'retro' ? 140 : 220)) ** 2)), 0);
          const strength = (0.05 + resonance) / Math.sqrt(harmonic);
          value += strength * Math.sin(voicedPhase * harmonic);
        }
        if (style === 'soft') value += 0.16 * Math.sin(phase * 13.37) * Math.sin(2 * Math.PI * 37 * t);
        value *= Math.sin(Math.PI * u) ** 1.5;
      } else if (profile.kind === 'bass') {
        // Upper harmonics keep the muted low sound audible on phone speakers.
        const fallingPhase = phase * (1 - 0.32 * u / 2);
        const harmonics = style === 'retro' ? [1, 0.55, 0.38, 0.26, 0.18, 0.1] : style === 'soft' ? [1, 0.38, 0.2] : [1, 0.5, 0.25];
        harmonics.forEach((strength, h) => { value += strength * Math.sin(fallingPhase * (h + 1)) * Math.exp(-h * u * (style === 'retro' ? 5 : 2)); });
        if (style === 'soft') value += 0.3 * Math.sin(phase * 2.31) * Math.exp(-t / 0.055);
        value *= Math.exp(-t / (style === 'retro' ? 0.11 : 0.065));
      } else if (profile.kind === 'glass' && style === 'soft') {
        const fallingPhase = 2 * Math.PI * frequency * (0.58 * t + 0.42 * 0.025 * (1 - Math.exp(-t / 0.025)));
        value = Math.sin(fallingPhase + 0.45 * Math.sin(fallingPhase * 2.03) * Math.exp(-t / 0.03)) * Math.exp(-t / 0.043);
      } else if (style === 'retro' && (profile.kind === 'bell' || profile.kind === 'glass')) {
        const modulation = profile.kind === 'bell' ? 2.2 : 0.65;
        value = Math.sin(phase + modulation * Math.sin(phase * 2.07) * Math.exp(-t / 0.085)) * Math.exp(-t / 0.12);
        if (profile.kind === 'glass') value += 0.45 * Math.sin(phase * 1.007) * Math.exp(-t / 0.15);
      } else {
        for (const [ratio, strength, decay] of modes) value += strength * Math.sin(phase * ratio) * Math.exp(-t / decay);
      }
      const attack = profile.kind === 'wood' ? 0.0015 : profile.kind === 'glass' ? 0.002 : 0.006;
      const envelope = Math.min(1, t / attack) * Math.min(1, (ringing - t) / 0.025);
      samples[start + i] += value * envelope * level;
    }
  });
  // DC blocker and bounded RMS matching: consistent level without peak clipping.
  const alpha = Math.exp(-2 * Math.PI * 20 / sampleRate);
  let previousInput = 0, previousOutput = 0, peak = 0, energy = 0;
  for (let i = 0; i < samples.length; i++) {
    const input = samples[i];
    const filtered = alpha * (previousOutput + input - previousInput);
    previousInput = input; previousOutput = filtered;
    samples[i] = filtered;
    peak = Math.max(peak, Math.abs(filtered)); energy += filtered * filtered;
  }
  if (!peak) throw new Error(`Silent sound: ${purpose.slug}`);
  const targetRms = style === 'soft' ? 0.05 : 0.065;
  const gain = Math.min(targetRms / Math.sqrt(energy / samples.length), 0.32 / peak);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(samples.length * 2, 40);
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => pcm.writeInt16LE(Math.round(value * gain * 32767), index * 2));
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
    manifest.push({ variant: variant.slug, category: purpose.category, name: purpose.name, timbre: soundProfiles[variant.slug][purposes.indexOf(purpose)].name, icon, sound: wav });
  }
}
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
execFileSync('magick', ['montage', ...manifest.map(item => path.join(root, item.icon)), '-tile', '5x3', '-geometry', '160x160+8+8', '-background', '#EEF3FA', path.join(root, 'contact-sheet.png')], { stdio: 'pipe' });

const rows = variants.map(variant => `<section><div class="heading"><h2>${variant.name}</h2><p>${variant.description}</p></div><div class="grid">${purposes.map((p, index) => `<article><div class="icons"><img src="${variant.slug}/icons/${p.slug}.png" alt="${p.name}"><img class="small" src="${variant.slug}/icons/${p.slug}.png" alt="48pxの見え方"></div><h3>${p.name}</h3><p class="slug">${p.category}</p><p class="timbre">${soundProfiles[variant.slug][index].name}</p><audio controls preload="none" src="${variant.slug}/sounds/bitty-${p.slug}.wav"></audio></article>`).join('')}</div></section>`).join('');
fs.writeFileSync(path.join(root, 'index.html'), `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bitty 通知素材の候補</title><style>
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#f2f6fc;color:#162443;margin:0;padding:32px}main{max-width:1200px;margin:auto}h1{font-size:28px;margin:0 0 12px}p{line-height:1.7;color:#53647d}header{margin-bottom:32px}.notice{font-size:14px;max-width:850px}.heading{display:flex;align-items:baseline;gap:24px}h2{font-size:21px}section{margin-bottom:32px}.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:14px}article{background:#fff;border:1px solid #dbe4f1;border-radius:18px;padding:18px 12px;text-align:center}.icons{height:142px;display:flex;align-items:center;justify-content:center;gap:8px}img{width:104px;height:104px;border-radius:50%}.small{width:48px;height:48px}h3{font-size:15px;margin:10px 0 0}.slug{font-size:10px;white-space:nowrap;margin:4px 0 12px}.timbre{font-size:13px;min-height:44px;margin:0 0 8px;color:#3b5274}audio{width:100%;height:36px}@media(max-width:950px){.grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:480px){body{padding:18px}.grid{grid-template-columns:1fr}.heading{display:block}header h1{font-size:24px}}
</style><main><header><h1>Bitty 通知素材の候補</h1><p>5用途 × 3パターン。左は拡大、右は48px。音は各カードから試聴できます。</p><p class="notice">これは素材確認用の一覧です。実際のiOS通知画面ではありません。円形表示の確認用に丸く切り抜いています。iOSが追加する小さなアプリアイコンは表示していません。音量は端末の再生音量にも依存します。</p></header>${rows}</main><script>document.querySelectorAll('audio').forEach(player=>player.addEventListener('play',()=>document.querySelectorAll('audio').forEach(other=>{if(other!==player)other.pause()})));</script></html>`);
console.log(`Generated ${manifest.length} PNG icons and ${manifest.length} WAV sounds in ${root}`);
