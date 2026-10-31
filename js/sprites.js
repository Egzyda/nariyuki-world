// ドット絵の人物スプライトを、型紙（文字の絵）から色を塗って作る。
// 1人ぶん = 4方向 × 3コマ（立ち・歩き1・歩き2）。12x18ドット＋輪郭1ドット。
import { JOBS } from './data.js';

export const SPR_W = 14, SPR_H = 20;   // 輪郭込み
const W = 12, H = 18;

// ---- 頭（行2〜9に置く 8行） ----
// H=髪 S=肌 E=目 M=口
const HEADS = {
  short: {
    down: ['....HHHH....', '..HHHHHHHH..', '.HHHHHHHHHH.', '.HHSSSSSSHH.', '.HSSSSSSSSH.', '.HSESSSSESH.', '..SSSSSSSS..', '...SSMMSS...'],
    up:   ['....HHHH....', '..HHHHHHHH..', '.HHHHHHHHHH.', '.HHHHHHHHHH.', '.HHHHHHHHHH.', '.HHHHHHHHHH.', '..HHHHHHHH..', '...SSSSSS...'],
    left: ['....HHHH....', '..HHHHHHHH..', '.HHHHHHHHHH.', '.HSSSSHHHHH.', '.SSSSSSHHHH.', '.SESSSSSHHH.', '.SSSSSSSSH..', '..SMSSSSS...'],
  },
  long: {
    down: ['....HHHH....', '..HHHHHHHH..', '.HHHHHHHHHH.', '.HHSSSSSSHH.', '.HHSSSSSSHH.', '.HHESSSSEHH.', '.HHSSSSSSHH.', '.HHHSMMSHHH.'],
    up:   ['....HHHH....', '..HHHHHHHH..', '.HHHHHHHHHH.', '.HHHHHHHHHH.', '.HHHHHHHHHH.', '.HHHHHHHHHH.', '.HHHHHHHHHH.', '.HHHHHHHHHH.'],
    left: ['....HHHH....', '..HHHHHHHH..', '.HHHHHHHHHH.', '.HSSSSHHHHH.', '.SSSSSSHHHH.', '.SESSSSSHHH.', '.SSSSSSSHHH.', '..SMSSSHHHH.'],
  },
  spiky: {
    down: ['.H.H.HH.H.H.', '..HHHHHHHH..', '.HHHHHHHHHH.', '.HHSSSSSSHH.', '.HSSSSSSSSH.', '.HSESSSSESH.', '..SSSSSSSS..', '...SSMMSS...'],
    up:   ['.H.H.HH.H.H.', '..HHHHHHHH..', '.HHHHHHHHHH.', '.HHHHHHHHHH.', '.HHHHHHHHHH.', '.HHHHHHHHHH.', '..HHHHHHHH..', '...SSSSSS...'],
    left: ['..H.HH.H.H..', '..HHHHHHHHH.', '.HHHHHHHHHH.', '.HSSSSHHHHH.', '.SSSSSSHHHH.', '.SESSSSSHHH.', '.SSSSSSSSH..', '..SMSSSSS...'],
  },
};
// 長い髪は肩まで（体の行10〜11に重ねる）
const LONG_EXTRA = {
  down: ['.H........H.', '.H........H.'],
  up:   ['..HHHHHHHH..', '...HHHHHH...'],
  left: ['.......HHH..', '........HH..'],
};

// ---- 体（行10〜17 8行） C=服 A=袖 K=手 P=ズボン B=靴 ----
const BODY = {
  down: [
    ['...CCCCCC...', '..ACCCCCCA..', '..ACCCCCCA..', '..KCCCCCCK..', '...PPPPPP...', '...PP..PP...', '...PP..PP...', '...BB..BB...'],
    ['...CCCCCC...', '..ACCCCCCA..', '..ACCCCCCK..', '..KCCCCCC...', '...PPPPPP...', '...PP..PP...', '...BB..PP...', '.......BB...'],
    ['...CCCCCC...', '..ACCCCCCA..', '..KCCCCCCA..', '...CCCCCCK..', '...PPPPPP...', '...PP..PP...', '...PP..BB...', '...BB.......'],
  ],
  left: [
    ['....CCCC....', '...CCCCCC...', '...CAACCC...', '...CKCCCC...', '....PPPP....', '....PPPP....', '....PPPP....', '...BBBB.....'],
    ['....CCCC....', '...CCCCCC...', '..KAACCCC...', '....CCCC....', '....PPPP....', '...PP..PP...', '..PP....PP..', '.BB......BB.'],
    ['....CCCC....', '...CCCCCC...', '...CCAACK...', '....CCCC....', '....PPPP....', '...PP..PP...', '..PP....PP..', '.BB......BB.'],
  ],
};
BODY.up = BODY.down;

// ---- 帽子など（上から重ねる） 行番号: 型紙 ----
const HATS = {
  straw: { all: { 2: '...YYYYYY...', 3: '..YYYYYYYY..', 4: '..yyyyyyyy..', 5: 'YYYYYYYYYYYY' } },
  chef: { all: { 0: '...WWWWWW...', 1: '..WWWWWWWW..', 2: '..WWWWWWWW..', 3: '...WWWWWW...', 4: '..wwwwwwww..' } },
  helmet: { all: { 1: '.....gg.....', 2: '...GGGGGG...', 3: '..GGGGGGGG..', 4: '.GGGGGGGGGG.', 5: '.GG......GG.' } },
  bandana: { all: { 4: '..RRRRRRRR..', 5: '.RRRRRRRRRR.' }, left: { 4: '..RRRRRRRR..', 5: '.RRRRRRRRRRR', 6: '..........RR' } },
  cap: {
    down: { 3: '...NNNNNN...', 4: '..NNNNNNNN..', 5: '.nnnnnnnnnn.' },
    up:   { 3: '...NNNNNN...', 4: '..NNNNNNNN..', 5: '.NNNNNNNNNN.' },
    left: { 3: '...NNNNNN...', 4: '..NNNNNNNN..', 5: 'nnnnNNNNNNN.' },
  },
  glasses: { down: { 7: '..GEGGGGEG..' }, left: { 7: '.GEG........' }, up: {} , glassColor: true },
};

const SKINS = ['#f7d7b8', '#f0c39c', '#e2ab82', '#c98d62', '#a86f48'];
const HAIRS = ['#2a1c14', '#4a2e1c', '#6e4424', '#9a6430', '#c8973c', '#3a3248', '#7a2c24', '#d8d2c8', '#1e2430'];
const PANTS = ['#3a4a6a', '#4a3a2a', '#2e2e36', '#55553f', '#5a4050', '#344a40'];

function hashStr(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.max(0, Math.min(255, Math.round(r * f))); g = Math.max(0, Math.min(255, Math.round(g * f))); b = Math.max(0, Math.min(255, Math.round(b * f)));
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

export function lookFor(c) {
  const h = hashStr(c.id + c.name);
  if (c.isPlayer) return { skin: SKINS[1], hair: '#3a2418', shirt: JOBS.none.shirt, pants: '#2e3a5a', hairStyle: 'spiky', hat: null, scarf: true };
  const job = JOBS[c.job] || JOBS.none;
  const shirt = shade(job.shirt, 0.88 + ((h >>> 3) % 25) / 100);
  return {
    skin: SKINS[h % SKINS.length],
    hair: HAIRS[(h >>> 5) % HAIRS.length],
    shirt,
    pants: PANTS[(h >>> 9) % PANTS.length],
    hairStyle: c.hair || 'short',
    hat: job.hat,
  };
}

function palette(look) {
  return {
    H: look.hair, S: look.skin, E: '#2a1a1a', M: shade(look.skin, 0.72), K: look.skin,
    C: look.shirt, A: shade(look.shirt, 0.82), P: look.pants, B: '#3a2618',
    Y: '#e8c860', y: '#b04030', W: '#fafafa', w: '#cfd2dc', G: '#8a9ab8', g: '#d03a3a',
    R: '#c8402e', N: '#3a7a4a', n: '#285a36',
  };
}

function compose(look, dir, frame) {
  const g = Array.from({ length: H }, () => new Array(W).fill('.'));
  const put = (row, str, onlyEmpty = false) => {
    if (row < 0 || row >= H) return;
    for (let x = 0; x < W; x++) { const ch = str[x]; if (ch && ch !== '.' && (!onlyEmpty || g[row][x] === '.')) g[row][x] = ch; }
  };
  const d = dir === 'right' ? 'left' : dir;
  const head = HEADS[look.hairStyle] || HEADS.short;
  BODY[d][frame].forEach((r, i) => put(10 + i, r));
  if (look.hairStyle === 'long') LONG_EXTRA[d].forEach((r, i) => put(10 + i, r));
  head[d].forEach((r, i) => put(2 + i, r));
  if (look.scarf) {
    // 主人公の赤いマフラー
    if (d === 'down') put(10, '...gggggg...');
    if (d === 'up') { put(10, '...gggggg...'); put(11, '.....gg.....'); }
    if (d === 'left') { put(10, '....gggg....'); put(11, '.......gg...'); }
  }
  const hat = look.hat && HATS[look.hat];
  if (hat) {
    const rows = hat[d] || hat.all || {};
    for (const [row, str] of Object.entries(rows)) put(+row, str);
  }
  return g;
}

function renderFrame(ctx, ox, oy, grid, pal, mirror, glasses) {
  const filled = (x, y) => x >= 0 && y >= 0 && x < W && y < H && grid[y][x] !== '.';
  const px = (x) => mirror ? W - 1 - x : x;
  ctx.fillStyle = '#1b1410';
  for (let y = -1; y <= H; y++) for (let x = -1; x <= W; x++) {
    if (filled(x, y)) continue;
    if (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)) ctx.fillRect(ox + 1 + px(x), oy + 1 + y, 1, 1);
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ch = grid[y][x];
    if (ch === '.') continue;
    let col = pal[ch] || '#f0f';
    if (ch === 'G' && glasses) col = '#2a2a3a';
    // 右端を少し暗くして立体感（左向きの反転時は左端）
    const edge = !filled(x + 1, y);
    if (edge && !'EMg'.includes(ch)) col = shade(col, 0.8);
    if (y > 0 && !filled(x, y - 1) && 'HCYWGN'.includes(ch)) col = shade(col, 1.12);
    ctx.fillStyle = col;
    ctx.fillRect(ox + 1 + px(x), oy + 1 + y, 1, 1);
  }
}

const cache = new Map();
const DIRS = ['down', 'up', 'left', 'right'];

// 1人ぶんのスプライトシート（列=コマ 行=方向）
export function sheetFor(c) {
  const key = c.id + ':' + c.job + ':' + (c.isPlayer ? 'p' : '');
  let s = cache.get(key);
  if (s) return s;
  const look = lookFor(c);
  const pal = palette(look);
  const cv = document.createElement('canvas');
  cv.width = SPR_W * 3; cv.height = SPR_H * 4;
  const ctx = cv.getContext('2d');
  DIRS.forEach((dir, di) => {
    for (let f = 0; f < 3; f++) {
      const grid = compose(look, dir, f);
      renderFrame(ctx, f * SPR_W, di * SPR_H, grid, pal, dir === 'right', look.hat === 'glasses');
    }
  });
  s = { cv, look, pal };
  cache.set(key, s);
  return s;
}

export function dirIndex(dir) { return Math.max(0, DIRS.indexOf(dir)); }

// 寝ているときの顔だけ（ベッド用）
const faceCache = new Map();
export function faceFor(c) {
  const key = c.id + ':' + c.job;
  let f = faceCache.get(key);
  if (f) return f;
  const look = { ...lookFor(c), hat: null };
  const pal = palette(look);
  const grid = compose(look, 'down', 0);
  for (let y = 10; y < H; y++) grid[y].fill('.');
  // 目を閉じる
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (grid[y][x] === 'E') grid[y][x] = 'M';
  const cv = document.createElement('canvas');
  cv.width = SPR_W; cv.height = 12;
  renderFrame(cv.getContext('2d'), 0, 0, grid, pal, false, false);
  f = { cv, shirt: look.shirt };
  faceCache.set(key, f);
  return f;
}

export function clearSpriteCache() { cache.clear(); faceCache.clear(); }
