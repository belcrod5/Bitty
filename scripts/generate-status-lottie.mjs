import fs from "node:fs";
import path from "node:path";

const OUT_DIR = path.resolve("assets/lottie/pixel-status");
const GRID = 8;
const PIXEL = 4;
const WIDTH = GRID * PIXEL;
const HEIGHT = GRID * PIXEL;
const FRAMERATE = 12;
const HOLD = 3;

const COLORS = {
  k: "#0f172a", // outline
  w: "#e2e8f0", // light
  c: "#22d3ee", // cyan
  g: "#22c55e", // green
  y: "#f59e0b", // yellow
  r: "#ef4444", // red
  s: "#64748b", // slate
  b: "#3b82f6", // blue
};

function hexToRgba(hex) {
  const n = hex.replace("#", "");
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  return [r, g, b, 1];
}

function validateFrame(frame, iconName, idx) {
  if (!Array.isArray(frame) || frame.length !== GRID) {
    throw new Error(`${iconName}: frame ${idx} must have ${GRID} rows`);
  }
  frame.forEach((row, r) => {
    if (typeof row !== "string" || row.length !== GRID) {
      throw new Error(`${iconName}: frame ${idx} row ${r} must have ${GRID} chars`);
    }
  });
}

function buildPixelRect(x, y, colorChar, idx) {
  const color = COLORS[colorChar];
  if (!color) {
    throw new Error(`Unknown color token: ${colorChar}`);
  }
  const px = x * PIXEL + PIXEL / 2;
  const py = y * PIXEL + PIXEL / 2;
  return {
    ty: "gr",
    nm: `px_${idx}`,
    np: 3,
    cix: 2,
    bm: 0,
    it: [
      {
        ty: "rc",
        d: 1,
        s: { a: 0, k: [PIXEL, PIXEL] },
        p: { a: 0, k: [px, py] },
        r: { a: 0, k: 0 },
        nm: "rect",
      },
      {
        ty: "fl",
        c: { a: 0, k: hexToRgba(color) },
        o: { a: 0, k: 100 },
        r: 1,
        bm: 0,
        nm: "fill",
      },
      {
        ty: "tr",
        p: { a: 0, k: [0, 0] },
        a: { a: 0, k: [0, 0] },
        s: { a: 0, k: [100, 100] },
        r: { a: 0, k: 0 },
        o: { a: 0, k: 100 },
        sk: { a: 0, k: 0 },
        sa: { a: 0, k: 0 },
      },
    ],
  };
}

function buildFrameLayer(frame, layerIndex, iconName) {
  const shapes = [];
  let idx = 0;
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      const ch = frame[y][x];
      if (ch === ".") continue;
      shapes.push(buildPixelRect(x, y, ch, idx));
      idx += 1;
    }
  }

  const ip = layerIndex * HOLD;
  const op = ip + HOLD;

  return {
    ddd: 0,
    ind: layerIndex + 1,
    ty: 4,
    nm: `${iconName}_f${layerIndex}`,
    sr: 1,
    ks: {
      o: { a: 0, k: 100 },
      r: { a: 0, k: 0 },
      p: { a: 0, k: [0, 0, 0] },
      a: { a: 0, k: [0, 0, 0] },
      s: { a: 0, k: [100, 100, 100] },
    },
    ao: 0,
    shapes,
    ip,
    op,
    st: 0,
    bm: 0,
  };
}

function buildAnimation(iconName, frames) {
  frames.forEach((frame, idx) => validateFrame(frame, iconName, idx));
  return {
    v: "5.9.0",
    fr: FRAMERATE,
    ip: 0,
    op: frames.length * HOLD,
    w: WIDTH,
    h: HEIGHT,
    nm: `pixel_${iconName}`,
    ddd: 0,
    assets: [],
    layers: frames.map((frame, idx) => buildFrameLayer(frame, idx, iconName)),
  };
}

const ICONS = {
  idle: [
    [
      "........",
      ".kkkkkk.",
      ".k....k.",
      ".k.wwwk.",
      ".k....k.",
      ".k..g.k.",
      ".kkkkkk.",
      "........",
    ],
    [
      "........",
      ".kkkkkk.",
      ".k....k.",
      ".k.wwwk.",
      ".k....k.",
      ".k....k.",
      ".kkkkkk.",
      "........",
    ],
  ],
  connecting: [
    [
      "...c....",
      "........",
      "...k....",
      "..kkk...",
      "...k....",
      "..k.k...",
      ".k...k..",
      "........",
    ],
    [
      "..c.c...",
      "...c....",
      "...k....",
      "..kkk...",
      "...k....",
      "..k.k...",
      ".k...k..",
      "........",
    ],
    [
      ".c...c..",
      "..c.c...",
      "...k....",
      "..kkk...",
      "...k....",
      "..k.k...",
      ".k...k..",
      "........",
    ],
  ],
  model_processing: [
    [
      "..kkkk..",
      "..kwwk..",
      "...ky...",
      "....k...",
      "...ky...",
      "..kwwk..",
      "..kkkk..",
      "........",
    ],
    [
      "..kkkk..",
      "..kyyk..",
      "...kw...",
      "....k...",
      "...kw...",
      "..kyyk..",
      "..kkkk..",
      "........",
    ],
  ],
  model_generating: [
    [
      "........",
      ".kkkkkk.",
      ".kwwwwk.",
      ".k....k.",
      ".k.g..k.",
      ".k....k.",
      ".kkkkkk.",
      "........",
    ],
    [
      "........",
      ".kkkkkk.",
      ".kwwwwk.",
      ".k....k.",
      ".k....k.",
      ".k....k.",
      ".kkkkkk.",
      "........",
    ],
    [
      "........",
      ".kkkkkk.",
      ".kwwwwk.",
      ".k....k.",
      ".k..g.k.",
      ".k....k.",
      ".kkkkkk.",
      "........",
    ],
  ],
  tool_waiting_approval: [
    [
      "..kkkk..",
      ".k....k.",
      ".k.kk.k.",
      ".kkkkkk.",
      ".kkyykk.",
      ".kkyykk.",
      ".kkkkkk.",
      "........",
    ],
    [
      "..kkkk..",
      ".k....k.",
      ".k.kk.k.",
      ".kkkkkk.",
      ".kk..kk.",
      ".kk..kk.",
      ".kkkkkk.",
      "........",
    ],
  ],
  tool_running: [
    [
      "...ss...",
      "..swws..",
      ".swssws.",
      ".wssssw.",
      ".swssws.",
      "..swws..",
      "...ss...",
      "........",
    ],
    [
      "..s..s..",
      ".swwwws.",
      "..wssw..",
      ".swssws.",
      "..wssw..",
      ".swwwws.",
      "..s..s..",
      "........",
    ],
  ],
  search_dir: [
    [
      ".yyyy...",
      ".y..yyy.",
      ".yyyyyy.",
      ".yy..yy.",
      ".yyyyyy.",
      "...ww...",
      "..w..w..",
      "...wwc..",
    ],
    [
      ".yyyy...",
      ".y..yyy.",
      ".yyyyyy.",
      ".yy..yy.",
      ".yyyyyy.",
      "....ww..",
      "...w..w.",
      "....wwc.",
    ],
  ],
  find_files: [
    [
      ".wwww...",
      ".w..w...",
      ".wwww...",
      "..wwww..",
      "..w..w..",
      "..wwww..",
      "...cc...",
      "..c..c..",
    ],
    [
      ".wwww...",
      ".w..w...",
      ".wwww...",
      "..wwww..",
      "..w..w..",
      "..wwww..",
      "..c..c..",
      "...cc...",
    ],
  ],
  search_text: [
    [
      ".wwww...",
      ".wssw...",
      ".wssw...",
      ".wwww...",
      "...ww...",
      "..w..w..",
      "...wwc..",
      "........",
    ],
    [
      ".wwww...",
      ".wssw...",
      ".wssw...",
      ".wwww...",
      "....ww..",
      "...w..w.",
      "....wwc.",
      "........",
    ],
  ],
  file_open: [
    [
      "..yyyy..",
      ".yy..yy.",
      ".yyyyyy.",
      ".yy.....",
      ".yyyyy..",
      ".yy..yy.",
      ".yyyyyy.",
      "........",
    ],
    [
      "..yyyy..",
      ".yy..yy.",
      ".yyyyyy.",
      ".yy.yyy.",
      ".yyyyy..",
      ".yy..yy.",
      ".yyyyyy.",
      "........",
    ],
  ],
  file_write: [
    [
      ".wwww...",
      ".w..w...",
      ".w..w...",
      ".wwww...",
      "...yyk..",
      "..yykk..",
      "..krr...",
      "........",
    ],
    [
      ".wwww...",
      ".w..w...",
      ".w..w...",
      ".wwww...",
      "..yyk...",
      ".yykk...",
      "..krr...",
      "........",
    ],
  ],
  file_edit: [
    [
      ".wwww...",
      ".w..w...",
      ".wssw...",
      ".wwww...",
      "...ss...",
      "..swws..",
      "...ss...",
      "........",
    ],
    [
      ".wwww...",
      ".w..w...",
      ".wssw...",
      ".wwww...",
      "..s..s..",
      ".swwwws.",
      "..s..s..",
      "........",
    ],
  ],
  restricted_exec: [
    [
      "........",
      ".kkkkkk.",
      ".kwwwwk.",
      ".k.c..k.",
      ".k..c.k.",
      ".k.gg.k.",
      ".kkkkkk.",
      "........",
    ],
    [
      "........",
      ".kkkkkk.",
      ".kwwwwk.",
      ".k.c..k.",
      ".k..c.k.",
      ".k....k.",
      ".kkkkkk.",
      "........",
    ],
  ],
  completed: [
    [
      "........",
      "...g....",
      "..gg....",
      ".g.g....",
      ".g..g...",
      "..gggg..",
      "........",
      "........",
    ],
    [
      "........",
      "....g...",
      "..gg....",
      ".g.g....",
      ".g..g...",
      "..gggg..",
      "...g....",
      "........",
    ],
  ],
  error: [
    [
      "........",
      ".r....r.",
      "..r..r..",
      "...rr...",
      "...rr...",
      "..r..r..",
      ".r....r.",
      "........",
    ],
    [
      "........",
      ".r....r.",
      "..r..r..",
      "...rr...",
      "..rrrr..",
      "..r..r..",
      ".r....r.",
      "........",
    ],
  ],
};

for (const [name, frames] of Object.entries(ICONS)) {
  const normalizedFrames = frames.map((frame) =>
    frame.map((row) => row.replace(/\n/g, ""))
  );
  const json = buildAnimation(name, normalizedFrames);
  fs.writeFileSync(path.join(OUT_DIR, `${name}.json`), JSON.stringify(json));
}

console.log(`Generated ${Object.keys(ICONS).length} icons into ${OUT_DIR}`);
