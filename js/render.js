// 描画（素材ファイルなし・すべてコードでドット絵風に描く）
import { TILE, MAP_W, MAP_H, FACILITIES, BOARD_POS, FOUNTAIN, JOBS } from './data.js';
import { T, tileType, furnAt, facAt, roofedFacAt, hash2, LAMPS, SPOTS } from './world.js';
import { S, hour, isJailed, day } from './state.js';
import { sheetFor, faceFor, dirIndex, SPR_W, SPR_H } from './sprites.js';

export const view = { zoom: 1.5, camX: 0, camY: 0, w: 0, h: 0, showMinimap: true };
let mapCache = null, miniCache = null;
const roofCache = {};
const roofAlpha = {};
let lightCv = null;

const px = (g, x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x, y, w, h); };

// ================= 地面 =================
function drawGrass(g, x, y) {
  const X = x * TILE, Y = y * TILE;
  const r = hash2(x, y);
  px(g, X, Y, TILE, TILE, r < 0.5 ? '#6cab4c' : '#68a648');
  for (let i = 0; i < 5; i++) {
    const a = hash2(x * 7 + i, y * 13 - i);
    const b = hash2(x * 3 - i, y * 5 + i * 7);
    px(g, X + Math.floor(a * 28), Y + Math.floor(b * 28), 2, 3, '#5a9840');
  }
  if (r > 0.9) {
    const col = ['#f4f0e0', '#f2d24a', '#e88aa8', '#a8c8f0'][Math.floor(hash2(y, x) * 4)];
    const fx = X + 6 + Math.floor(hash2(x + 1, y) * 18), fy = Y + 6 + Math.floor(hash2(x, y + 1) * 18);
    px(g, fx, fy, 3, 3, col); px(g, fx + 1, fy + 3, 1, 2, '#3f7a30');
  }
}

function drawRoad(g, x, y) {
  const X = x * TILE, Y = y * TILE;
  px(g, X, Y, TILE, TILE, '#d8c193');
  for (let i = 0; i < 4; i++) {
    const a = hash2(x * 5 + i, y * 9 + i), b = hash2(x * 11 - i, y * 3 + i);
    px(g, X + Math.floor(a * 28), Y + Math.floor(b * 28), 3, 2, i % 2 ? '#c6ad7c' : '#e6d2a6');
  }
  const edge = (t) => t === T.GRASS || t === T.TREE;
  if (edge(tileType(x, y - 1))) px(g, X, Y, TILE, 2, '#b89c68');
  if (edge(tileType(x, y + 1))) px(g, X, Y + TILE - 2, TILE, 2, '#b89c68');
  if (edge(tileType(x - 1, y))) px(g, X, Y, 2, TILE, '#b89c68');
  if (edge(tileType(x + 1, y))) px(g, X + TILE - 2, Y, 2, TILE, '#b89c68');
}

function drawPlaza(g, x, y) {
  const X = x * TILE, Y = y * TILE;
  px(g, X, Y, TILE, TILE, '#cfc6b0');
  px(g, X, Y, TILE, 1, '#b5ab94'); px(g, X, Y + 16, TILE, 1, '#b5ab94');
  px(g, X + ((y % 2) ? 8 : 24), Y, 1, 16, '#b5ab94'); px(g, X + ((y % 2) ? 24 : 8), Y + 16, 1, 16, '#b5ab94');
  if (hash2(x, y) > 0.7) px(g, X + 4, Y + 20, 6, 6, '#c4bba4');
}

function drawTree(g, x, y, dense = false) {
  const X = x * TILE, Y = y * TILE;
  if (!dense) drawGrass(g, x, y);
  else px(g, X, Y, TILE, TILE, '#2e5a28');
  px(g, X + 13, Y + 18, 6, 12, '#6a4a2a');
  px(g, X + 13, Y + 18, 2, 12, '#83603a');
  const c1 = dense ? '#244c22' : '#3d7a34', c2 = dense ? '#2f6029' : '#4f9440', c3 = dense ? '#3a7032' : '#68ad52';
  g.fillStyle = c1; g.beginPath(); g.arc(X + 16, Y + 12, 13, 0, 7); g.fill();
  g.fillStyle = c2; g.beginPath(); g.arc(X + 14, Y + 10, 10, 0, 7); g.fill();
  g.fillStyle = c3; g.beginPath(); g.arc(X + 11, Y + 7, 5, 0, 7); g.fill();
}

function drawFloor(g, x, y, kind) {
  const X = x * TILE, Y = y * TILE;
  if (kind === 'wood') {
    px(g, X, Y, TILE, TILE, '#b98852');
    for (let i = 0; i < 4; i++) {
      px(g, X, Y + i * 8 + 7, TILE, 1, '#9a6c3e');
      px(g, X + ((i + x) % 2 ? 10 : 24), Y + i * 8, 1, 8, '#a5764a');
    }
  } else if (kind === 'stone') {
    px(g, X, Y, TILE, TILE, '#a6a29a');
    px(g, X, Y + 15, TILE, 1, '#8a867e'); px(g, X + 15, Y, 1, 15, '#8a867e'); px(g, X + 7, Y + 16, 1, 16, '#8a867e');
    px(g, X + 1, Y + 1, 13, 1, '#b8b4ac');
  } else if (kind === 'tile') {
    px(g, X, Y, TILE, TILE, '#eceef4');
    px(g, X + ((x + y) % 2 ? 0 : 16), Y, 16, 16, '#dde0ea'); px(g, X + ((x + y) % 2 ? 16 : 0), Y + 16, 16, 16, '#dde0ea');
  } else if (kind === 'mat') {
    px(g, X, Y, TILE, TILE, '#c9a463');
    px(g, X, Y, TILE, 1, '#a8854a'); px(g, X, Y, 1, TILE, '#a8854a');
    for (let i = 4; i < TILE; i += 4) px(g, X + 1, Y + i, TILE - 1, 1, '#c09a58');
  }
}

function drawWallTop(g, x, y, f) {
  const X = x * TILE, Y = y * TILE;
  px(g, X, Y, TILE, TILE, '#5b4838');
  px(g, X + 2, Y + 2, TILE - 4, TILE - 4, '#6e5845');
  px(g, X + 2, Y + 2, TILE - 4, 3, '#86705a');
}

function drawFrontWall(g, x, y, f) {
  const X = x * TILE, Y = y * TILE;
  const base = f.wall || '#c8a882';
  px(g, X, Y, TILE, TILE, base);
  for (let i = 0; i < 4; i++) px(g, X, Y + i * 8 + 7, TILE, 1, 'rgba(0,0,0,0.10)');
  px(g, X, Y + TILE - 5, TILE, 5, '#6a5a4a');
  px(g, X, Y, TILE, 2, 'rgba(0,0,0,0.25)');
  // 窓（入口の両隣以外に1つおき）
  const rel = x - f.x;
  if (rel > 0 && rel < f.w - 1 && Math.abs(x - f.door[0]) > 1 && rel % 2 === 1) {
    px(g, X + 8, Y + 7, 16, 13, '#5a4030');
    px(g, X + 10, Y + 9, 12, 9, '#a8d0e8');
    px(g, X + 15, Y + 9, 2, 9, '#5a4030');
    px(g, X + 10, Y + 9, 5, 3, '#d8f0ff');
  }
}

function drawDoor(g, x, y, f) {
  const X = x * TILE, Y = y * TILE;
  if (f.kind === 'field') { drawSoil(g, x, y); px(g, X, Y + 2, 3, 28, '#6a4a2a'); px(g, X + TILE - 3, Y + 2, 3, 28, '#6a4a2a'); return; }
  drawFloor(g, x, y, f.floor || 'wood');
  px(g, X, Y, 5, TILE, f.wall || '#c8a882'); px(g, X + TILE - 5, Y, 5, TILE, f.wall || '#c8a882');
  px(g, X + 5, Y, TILE - 10, 3, '#5a3a20');
  px(g, X + 4, Y, 2, TILE, '#5a3a20'); px(g, X + TILE - 6, Y, 2, TILE, '#5a3a20');
  px(g, X + 8, Y + 24, TILE - 16, 6, '#8a4a3a');
}

function drawSoil(g, x, y) {
  const X = x * TILE, Y = y * TILE;
  px(g, X, Y, TILE, TILE, '#8a6236');
  for (let i = 0; i < 3; i++) px(g, X + 3 + Math.floor(hash2(x + i, y) * 24), Y + 4 + i * 10, 4, 2, '#7a5430');
}

function drawCropBed(g, x, y) {
  const X = x * TILE, Y = y * TILE;
  px(g, X, Y, TILE, TILE, '#7a5430');
  px(g, X, Y + 6, TILE, 4, '#6a4626'); px(g, X, Y + 22, TILE, 4, '#6a4626');
}

function drawFence(g, x, y, f) {
  drawGrass(g, x, y);
  const X = x * TILE, Y = y * TILE;
  const horiz = y === f.y || y === f.y + f.h - 1;
  if (horiz) { px(g, X, Y + 12, TILE, 3, '#8a6034'); px(g, X, Y + 20, TILE, 3, '#8a6034'); }
  else { px(g, X + 12, Y, 3, TILE, '#8a6034'); px(g, X + 19, Y, 3, TILE, '#8a6034'); }
  px(g, X + 12, Y + 8, 8, 18, '#6a4626'); px(g, X + 12, Y + 8, 8, 2, '#a07848');
}

function drawWater(g, x, y) {
  const X = x * TILE, Y = y * TILE;
  px(g, X, Y, TILE, TILE, '#cfc6b0');
}

// ================= 家具 =================
function drawFurn(g, k, x, y, f) {
  const X = x * TILE, Y = y * TILE;
  switch (k) {
    case 'table':
      px(g, X + 3, Y + 26, 3, 5, '#5a3818'); px(g, X + 26, Y + 26, 3, 5, '#5a3818');
      px(g, X + 2, Y + 6, 28, 21, '#6a4220'); px(g, X + 2, Y + 4, 28, 20, '#a8703a'); px(g, X + 2, Y + 4, 28, 2, '#c08a50');
      px(g, X + 10, Y + 9, 12, 9, '#f0ece0'); px(g, X + 12, Y + 11, 8, 5, '#e0d8c8');
      break;
    case 'chair':
      px(g, X + 9, Y + 6, 14, 5, '#7a4c24'); px(g, X + 9, Y + 11, 14, 11, '#9a6634'); px(g, X + 9, Y + 22, 3, 6, '#5a3818'); px(g, X + 20, Y + 22, 3, 6, '#5a3818');
      break;
    case 'stool':
      px(g, X + 13, Y + 18, 6, 10, '#5a3818'); g.fillStyle = '#9a6634'; g.beginPath(); g.ellipse(X + 16, Y + 17, 9, 6, 0, 0, 7); g.fill();
      break;
    case 'bench':
      px(g, X + 2, Y + 12, 28, 4, '#9a6634'); px(g, X + 2, Y + 17, 28, 4, '#9a6634'); px(g, X + 2, Y + 7, 28, 4, '#7a4c24');
      px(g, X + 4, Y + 21, 3, 7, '#4a4a4a'); px(g, X + 25, Y + 21, 3, 7, '#4a4a4a');
      break;
    case 'counter':
      px(g, X, Y + 8, TILE, 22, '#6a3e1e'); px(g, X, Y + 4, TILE, 10, '#9a6234'); px(g, X, Y + 4, TILE, 2, '#b88048');
      px(g, X, Y + 18, TILE, 1, '#5a3418');
      if ((x + y) % 2) { px(g, X + 10, Y + 5, 7, 6, '#e8e0d0'); px(g, X + 11, Y + 6, 5, 3, '#c86a3a'); }
      break;
    case 'stove':
      px(g, X + 2, Y + 4, 28, 26, '#3e3e44'); px(g, X + 2, Y + 4, 28, 3, '#5a5a62');
      px(g, X + 7, Y + 20, 18, 6, '#ff9a3a'); px(g, X + 9, Y + 22, 14, 3, '#ffd06a');
      px(g, X + 8, Y + 6, 16, 10, '#24242a'); px(g, X + 10, Y + 7, 12, 3, '#6a6a72');
      break;
    case 'shelf': case 'bookshelf':
      px(g, X + 1, Y + 2, 30, 28, '#5e3c1e'); px(g, X + 3, Y + 4, 26, 24, '#3e2812');
      for (let r = 0; r < 3; r++) {
        px(g, X + 3, Y + 11 + r * 8, 26, 2, '#7a5028');
        for (let i = 0; i < 6; i++) {
          const col = k === 'bookshelf' ? ['#a83a3a', '#3a6aa8', '#3a8a4a', '#c8a03a', '#7a4aa8'][(i + r + x) % 5]
            : ['#e05a3a', '#e8c040', '#6ab04a', '#c8a070', '#f0e0c0'][(i * 3 + r + y) % 5];
          px(g, X + 4 + i * 4, Y + 5 + r * 8, 3, 6, col);
        }
      }
      break;
    case 'barrel':
      g.fillStyle = '#7a4a22'; g.beginPath(); g.ellipse(X + 16, Y + 17, 11, 13, 0, 0, 7); g.fill();
      px(g, X + 5, Y + 10, 22, 2, '#3a3a3a'); px(g, X + 5, Y + 23, 22, 2, '#3a3a3a');
      g.fillStyle = '#9a6430'; g.beginPath(); g.ellipse(X + 16, Y + 8, 9, 4, 0, 0, 7); g.fill();
      break;
    case 'crate':
      px(g, X + 4, Y + 6, 24, 22, '#a07a46'); px(g, X + 4, Y + 6, 24, 2, '#c09a62');
      px(g, X + 4, Y + 16, 24, 2, '#7a5a30'); px(g, X + 15, Y + 6, 2, 22, '#7a5a30');
      break;
    case 'plant':
      px(g, X + 10, Y + 20, 12, 10, '#b0603a'); px(g, X + 9, Y + 19, 14, 3, '#c87048');
      g.fillStyle = '#3e8a3a'; g.beginPath(); g.arc(X + 16, Y + 13, 8, 0, 7); g.fill();
      g.fillStyle = '#5aaa4a'; g.beginPath(); g.arc(X + 13, Y + 10, 4, 0, 7); g.fill();
      break;
    case 'bed': {
      const blanket = f?.home ? '#5a7ac0' : f?.id === 'clinic' ? '#e8eef8' : f?.id === 'guard' ? '#7a7a6a' : '#a0605a';
      px(g, X + 3, Y + 1, 26, 30, '#6a4420');
      px(g, X + 5, Y + 3, 22, 26, '#f0ece4');
      px(g, X + 7, Y + 4, 18, 7, '#ffffff'); px(g, X + 7, Y + 10, 18, 1, '#d8d4cc');
      px(g, X + 5, Y + 13, 22, 16, blanket); px(g, X + 5, Y + 13, 22, 2, 'rgba(255,255,255,0.25)');
      break;
    }
    case 'forge':
      px(g, X + 1, Y + 2, 30, 28, '#6a625a'); px(g, X + 3, Y + 4, 26, 4, '#8a827a');
      px(g, X + 6, Y + 12, 20, 14, '#2a1a14'); px(g, X + 8, Y + 16, 16, 8, '#ff7a2a'); px(g, X + 11, Y + 18, 10, 4, '#ffd060');
      break;
    case 'anvil':
      px(g, X + 6, Y + 10, 22, 7, '#3a3a44'); px(g, X + 2, Y + 10, 6, 4, '#3a3a44'); px(g, X + 12, Y + 17, 10, 6, '#2e2e36');
      px(g, X + 9, Y + 23, 16, 5, '#5a4030'); px(g, X + 6, Y + 10, 22, 2, '#6a6a78');
      break;
    case 'rack':
      px(g, X + 3, Y + 4, 26, 4, '#7a5028'); px(g, X + 3, Y + 22, 26, 4, '#7a5028');
      for (let i = 0; i < 3; i++) { px(g, X + 7 + i * 8, Y + 2, 3, 26, '#a8acb8'); px(g, X + 6 + i * 8, Y + 20, 5, 3, '#6a4020'); }
      break;
    case 'dummy':
      px(g, X + 15, Y + 10, 3, 20, '#7a5028'); px(g, X + 7, Y + 14, 18, 3, '#7a5028');
      g.fillStyle = '#d8b860'; g.beginPath(); g.ellipse(X + 16, Y + 18, 7, 9, 0, 0, 7); g.fill();
      g.beginPath(); g.arc(X + 16, Y + 7, 5, 0, 7); g.fill();
      px(g, X + 12, Y + 17, 8, 2, '#c84030');
      break;
    case 'weights':
      px(g, X + 4, Y + 15, 24, 3, '#5a5a62');
      px(g, X + 3, Y + 9, 6, 15, '#2a2a30'); px(g, X + 23, Y + 9, 6, 15, '#2a2a30');
      break;
    case 'desk':
      px(g, X + 1, Y + 6, 30, 22, '#7a4c26'); px(g, X + 1, Y + 4, 30, 18, '#9a6634'); px(g, X + 1, Y + 4, 30, 2, '#b8804a');
      px(g, X + 6, Y + 7, 10, 8, '#f4f0e4'); px(g, X + 8, Y + 9, 6, 1, '#888'); px(g, X + 8, Y + 11, 6, 1, '#888');
      px(g, X + 21, Y + 8, 4, 6, '#2a4a7a');
      break;
    case 'bars':
      for (let i = 2; i < TILE; i += 6) px(g, X + i, Y, 2, TILE, '#3a3a44');
      px(g, X, Y + 2, TILE, 2, '#4a4a54'); px(g, X, Y + TILE - 4, TILE, 2, '#4a4a54');
      break;
    case 'labbench':
      px(g, X + 1, Y + 8, 30, 20, '#6a7078'); px(g, X + 1, Y + 6, 30, 14, '#b0b8c4'); px(g, X + 1, Y + 6, 30, 2, '#d0d8e4');
      px(g, X + 6, Y + 2, 5, 10, '#7ad0a0'); px(g, X + 14, Y + 4, 4, 8, '#e07ab0'); px(g, X + 22, Y + 1, 5, 11, '#80b0f0');
      break;
    case 'board': {
      px(g, X + 6, Y + 18, 3, 14, '#5a3a1a'); px(g, X + 23, Y + 18, 3, 14, '#5a3a1a');
      px(g, X + 1, Y + 2, 30, 20, '#7a5228'); px(g, X + 3, Y + 4, 26, 16, '#a8804a');
      px(g, X + 5, Y + 5, 8, 7, '#f4ecd8'); px(g, X + 15, Y + 6, 10, 9, '#fff6e0'); px(g, X + 6, Y + 13, 7, 6, '#f0e4c8');
      px(g, X + 8, Y + 6, 2, 1, '#c03030'); px(g, X + 19, Y + 7, 2, 1, '#c03030');
      break;
    }
    case 'lamp':
      px(g, X + 14, Y + 8, 4, 22, '#3a3a40'); px(g, X + 11, Y + 27, 10, 4, '#3a3a40');
      px(g, X + 10, Y + 1, 12, 9, '#2a2a30'); px(g, X + 12, Y + 3, 8, 5, '#ffe8a0');
      break;
    case 'scarecrow':
      px(g, X + 15, Y + 6, 3, 24, '#7a5028'); px(g, X + 4, Y + 12, 24, 3, '#7a5028');
      px(g, X + 11, Y + 12, 10, 10, '#4a6aa0'); g.fillStyle = '#e8d8a0'; g.beginPath(); g.arc(X + 16, Y + 8, 5, 0, 7); g.fill();
      px(g, X + 9, Y + 2, 14, 3, '#d8b860'); px(g, X + 12, Y, 8, 3, '#d8b860');
      break;
    case 'well':
      g.fillStyle = '#8a8a8a'; g.beginPath(); g.arc(X + 16, Y + 18, 12, 0, 7); g.fill();
      g.fillStyle = '#3a6a9a'; g.beginPath(); g.arc(X + 16, Y + 18, 8, 0, 7); g.fill();
      px(g, X + 4, Y + 2, 3, 16, '#6a4626'); px(g, X + 25, Y + 2, 3, 16, '#6a4626'); px(g, X + 3, Y + 1, 26, 3, '#8a4a2a');
      break;
  }
}

function buildMapCache() {
  const c = document.createElement('canvas');
  c.width = MAP_W * TILE; c.height = MAP_H * TILE;
  const g = c.getContext('2d');
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    const t = tileType(x, y);
    const f = facAt(x, y);
    switch (t) {
      case T.GRASS: drawGrass(g, x, y); break;
      case T.ROAD: drawRoad(g, x, y); break;
      case T.PLAZA: drawPlaza(g, x, y); break;
      case T.TREE: drawTree(g, x, y); break;
      case T.EDGE: drawTree(g, x, y, true); break;
      case T.FLOOR: drawFloor(g, x, y, f?.floor || 'wood'); break;
      case T.WALL: if (y === f.y + f.h - 1) drawFrontWall(g, x, y, f); else drawWallTop(g, x, y, f); break;
      case T.DOOR: drawDoor(g, x, y, f); break;
      case T.WATER: drawWater(g, x, y); break;
      case T.FENCE: drawFence(g, x, y, f); break;
      case T.SOIL: drawSoil(g, x, y); break;
      case T.CROP: drawCropBed(g, x, y); break;
    }
  }
  // 噴水
  const fx = (FOUNTAIN[0] + 1) * TILE, fy = (FOUNTAIN[1] + 1) * TILE;
  g.fillStyle = '#8e8e94'; g.beginPath(); g.arc(fx, fy, 30, 0, 7); g.fill();
  g.fillStyle = '#b4b4ba'; g.beginPath(); g.arc(fx, fy - 2, 28, 0, 7); g.fill();
  g.fillStyle = '#4a90c8'; g.beginPath(); g.arc(fx, fy, 23, 0, 7); g.fill();
  g.fillStyle = '#8e8e94'; g.beginPath(); g.arc(fx, fy, 7, 0, 7); g.fill();
  // 家具
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    const k = furnAt(x, y);
    if (k) drawFurn(g, k, x, y, facAt(x, y));
  }
  mapCache = c;
}

// ================= 屋根 =================
function buildRoof(f) {
  const w = f.w * TILE + 8, h = (f.h - 1) * TILE + 8;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const base = f.roof || '#8a4a3a';
  const mid = h / 2;
  // 奥側（明るい）と手前側（暗い）の切妻屋根
  g.fillStyle = shadeHex(base, 1.15); g.fillRect(0, 0, w, mid);
  g.fillStyle = base; g.fillRect(0, mid, w, h - mid);
  g.fillStyle = 'rgba(0,0,0,0.18)';
  for (let y = 6; y < h; y += 8) {
    g.fillRect(0, y, w, 2);
    for (let x = ((y / 8) % 2) * 8; x < w; x += 16) g.fillRect(x, y - 6, 2, 6);
  }
  g.fillStyle = shadeHex(base, 0.7); g.fillRect(0, mid - 3, w, 6);
  g.fillStyle = shadeHex(base, 1.35); g.fillRect(0, mid - 3, w, 2);
  g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, h - 4, w, 4);
  g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 2; g.strokeRect(1, 1, w - 2, h - 2);
  // 煙突
  if (['diner', 'workshop', 'tavern'].includes(f.id) || f.home) {
    const cx = w - 30;
    g.fillStyle = '#6a5a52'; g.fillRect(cx, 4, 14, 20); g.fillStyle = '#4a3e38'; g.fillRect(cx - 2, 2, 18, 5);
  }
  roofCache[f.id] = c;
}

function shadeHex(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

// ================= ミニマップ =================
const MINI = 3;
function buildMini() {
  const c = document.createElement('canvas');
  c.width = MAP_W * MINI; c.height = MAP_H * MINI;
  const g = c.getContext('2d');
  const col = { [T.GRASS]: '#5f9a46', [T.ROAD]: '#d8c193', [T.PLAZA]: '#cfc6b0', [T.FLOOR]: '#b98852', [T.WALL]: '#5b4838', [T.DOOR]: '#e8d090',
    [T.WATER]: '#4a90c8', [T.TREE]: '#2f6a2a', [T.FENCE]: '#8a6034', [T.CROP]: '#7a9a3a', [T.SOIL]: '#8a6236', [T.EDGE]: '#1f3f1c' };
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) { g.fillStyle = col[tileType(x, y)] || '#000'; g.fillRect(x * MINI, y * MINI, MINI, MINI); }
  for (const f of FACILITIES) if (f.kind !== 'field') {
    g.fillStyle = f.roof; g.fillRect(f.x * MINI, f.y * MINI, f.w * MINI, (f.h - 1) * MINI);
  }
  miniCache = c;
}

export function resetRenderCache() { mapCache = null; miniCache = null; for (const k in roofCache) delete roofCache[k]; }

// ================= メイン描画 =================
function charTile(c) { return [Math.floor(c.x / TILE), Math.floor(c.y / TILE)]; }

export function hiddenUnderRoof(c) {
  const [tx, ty] = charTile(c);
  const f = roofedFacAt(tx, ty);
  return f ? (roofAlpha[f.id] ?? 1) > 0.55 : false;
}

export function draw(ctx, w, h, dt) {
  if (!mapCache) { buildMapCache(); buildMini(); for (const f of FACILITIES) if (f.kind !== 'field') buildRoof(f); }
  const p = S.player;
  const Z = view.zoom;
  view.w = w; view.h = h;
  const vw = w / Z, vh = h / Z;
  // カメラ（なめらかに追従）
  const tx = clampCam(p.x - vw / 2, MAP_W * TILE - vw), ty = clampCam(p.y - vh / 2, MAP_H * TILE - vh);
  const k = Math.min(1, dt * 8);
  view.camX += (tx - view.camX) * k; view.camY += (ty - view.camY) * k;
  if (Math.abs(tx - view.camX) > 400 || Math.abs(ty - view.camY) > 400) { view.camX = tx; view.camY = ty; }
  const camX = MAP_W * TILE < vw ? -(vw - MAP_W * TILE) / 2 : view.camX;
  const camY = MAP_H * TILE < vh ? -(vh - MAP_H * TILE) / 2 : view.camY;

  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#16200f'; ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.scale(Z, Z);
  ctx.translate(-Math.round(camX * Z) / Z, -Math.round(camY * Z) / Z);
  ctx.drawImage(mapCache, 0, 0);

  const now = performance.now();
  drawCrops(ctx);
  drawFountainWater(ctx, now);

  // 屋根の透明度（プレイヤーがいる建物は屋根を外す）
  const [ptx, pty] = charTile(p);
  const pf = facAt(ptx, pty);
  for (const f of FACILITIES) {
    if (f.kind === 'field') continue;
    let target = 1;
    if (pf === f) target = (ptx === f.door[0] && pty === f.door[1]) ? 0.35 : 0;
    const a = roofAlpha[f.id] ?? 1;
    roofAlpha[f.id] = a + (target - a) * Math.min(1, dt * 10);
  }

  // 隕石
  const m = S.meteor;
  if (m && m.state === 'ground') {
    const cx = m.tx * TILE + 16, cy = m.ty * TILE + 18;
    ctx.fillStyle = 'rgba(40,30,30,0.5)'; ctx.beginPath(); ctx.ellipse(cx, cy + 6, 14, 6, 0, 0, 7); ctx.fill();
    const glow = 0.6 + Math.sin(now / 200) * 0.3;
    ctx.fillStyle = `rgba(120,255,220,${glow * 0.45})`; ctx.beginPath(); ctx.arc(cx, cy, 15, 0, 7); ctx.fill();
    ctx.fillStyle = '#6af0d0'; ctx.fillRect(cx - 5, cy - 6, 10, 12); ctx.fillStyle = '#c8fff0'; ctx.fillRect(cx - 3, cy - 4, 4, 4);
    ctx.fillStyle = '#2a8a7a'; ctx.fillRect(cx + 2, cy, 3, 6);
  }

  // 墓
  for (const c of S.chars) if (!c.alive && !c.isPlayer) {
    const gx = c.gx ?? c.x, gy = c.gy ?? c.y;
    ctx.fillStyle = '#8a8a90'; ctx.fillRect(gx - 7, gy - 12, 14, 18); ctx.fillStyle = '#a8a8ae'; ctx.fillRect(gx - 7, gy - 12, 14, 3);
    ctx.fillStyle = '#5a5a60'; ctx.fillRect(gx - 1, gy - 9, 2, 9); ctx.fillRect(gx - 4, gy - 7, 8, 2);
    ctx.fillStyle = '#5a8a3a'; ctx.fillRect(gx - 9, gy + 5, 18, 3);
  }

  // 人物（奥から順に）
  const list = S.chars.filter((c) => c.alive).sort((a, b) => a.y - b.y);
  for (const c of list) drawChar(ctx, c, now);

  // 屋根
  for (const f of FACILITIES) {
    if (f.kind === 'field') continue;
    const a = roofAlpha[f.id] ?? 1;
    if (a < 0.02) continue;
    ctx.globalAlpha = a;
    ctx.drawImage(roofCache[f.id], f.x * TILE - 4, f.y * TILE - 8);
    ctx.globalAlpha = 1;
  }
  // 看板
  for (const f of FACILITIES) {
    const a = f.kind === 'field' ? 1 : Math.max(0.35, roofAlpha[f.id] ?? 1);
    const cx = f.x * TILE + f.w * TILE / 2;
    const cy = f.kind === 'field' ? f.y * TILE - 6 : f.y * TILE + (f.h - 1) * TILE / 2 - 4;
    ctx.globalAlpha = a;
    sign(ctx, `${f.icon} ${f.name}`, cx, cy, f);
    if (f.kind !== 'field' && (roofAlpha[f.id] ?? 1) > 0.5) {
      const n = S.chars.filter((c) => c.alive && !c.isPlayer && roofedFacAt(...charTile(c)) === f).length;
      if (n) label(ctx, `👤${n}`, cx, cy + 16, 9, '#ffe9a0');
    }
    const closed = S.fac[f.id] && S.fac[f.id].closedUntilDay >= day();
    if (closed) label(ctx, '🔥 使用不可', cx, cy + 28, 10, '#ff9a7a');
    ctx.globalAlpha = 1;
  }

  // 名前・吹き出し
  for (const c of list) if (!hiddenUnderRoof(c)) drawCharOverlay(ctx, c, now);
  for (const c of list) if (!hiddenUnderRoof(c)) drawBubble(ctx, c, now);

  // 演出
  for (const e of S.effects) if (e.type === 'hit') {
    ctx.font = '20px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('💥', e.x, e.y - 20 - (0.5 - e.t) * 30);
  }
  ctx.restore();

  drawNight(ctx, w, h, camX, camY, Z);
  if (S.droughtUntilDay >= day()) { ctx.fillStyle = 'rgba(255,170,60,0.07)'; ctx.fillRect(0, 0, w, h); }
  for (const e of S.effects) if (e.type === 'flash') { ctx.fillStyle = `rgba(${e.color || '255,255,255'},${Math.min(1, e.t)})`; ctx.fillRect(0, 0, w, h); }
  if (view.showMinimap) drawMinimap(ctx, w, camX, camY, vw, vh);
}

function clampCam(v, max) { return Math.max(0, Math.min(max, v)); }

function drawCrops(ctx) {
  const farm = FACILITIES.find((f) => f.id === 'farm');
  const dry = S.droughtUntilDay >= day();
  const stage = (day() + 1) % 3;
  for (const [x, y] of SPOTS.farm?.work || []) {
    const X = x * TILE, Y = y * TILE;
    for (let i = 0; i < 2; i++) {
      const cx = X + 8 + i * 16, cy = Y + 14;
      const leaf = dry ? '#b8a840' : '#5aa83a', leaf2 = dry ? '#d0c060' : '#7ac84a';
      ctx.fillStyle = '#3e7a28'; ctx.fillRect(cx - 1, cy - 2 - stage * 2, 2, 8 + stage * 2);
      ctx.fillStyle = leaf; ctx.fillRect(cx - 5, cy - 3 - stage * 2, 5, 3); ctx.fillRect(cx + 1, cy - 5 - stage * 2, 5, 3);
      ctx.fillStyle = leaf2; ctx.fillRect(cx - 3, cy - 7 - stage * 2, 6, 3);
      if (stage === 2 && !dry) { ctx.fillStyle = (x + y + i) % 3 ? '#e8503a' : '#f0c040'; ctx.fillRect(cx - 2, cy + 2, 4, 4); }
    }
  }
  void farm;
}

function drawFountainWater(ctx, now) {
  const fx = (FOUNTAIN[0] + 1) * TILE, fy = (FOUNTAIN[1] + 1) * TILE;
  for (let i = 0; i < 3; i++) {
    const r = ((now / 40 + i * 7) % 20) + 8;
    ctx.strokeStyle = `rgba(220,240,255,${0.5 - r / 50})`; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(fx, fy, r, 0, 7); ctx.stroke();
  }
  ctx.fillStyle = '#bfe4ff'; ctx.fillRect(fx - 2, fy - 12 - Math.sin(now / 150) * 2, 4, 8);
}

function drawChar(ctx, c, now) {
  const sleeping = (c.activity === 'sleep' || c.activity === 'heal') && S.t < c.busyUntil && c.inBed;
  const jailed = isJailed(c);
  if (sleeping || (c.inBed && c.activity === 'sleep')) {
    const f = faceFor(c);
    const bx = Math.floor(c.x / TILE) * TILE, by = Math.floor(c.y / TILE) * TILE;
    ctx.drawImage(f.cv, 0, 0, SPR_W, 12, bx + 4, by - 5, SPR_W * 1.7, 12 * 1.7);
    ctx.fillStyle = f.shirt; ctx.fillRect(bx + 5, by + 13, 22, 16);
    ctx.fillStyle = 'rgba(0,0,0,0.15)'; ctx.fillRect(bx + 5, by + 13, 22, 2);
    if (!hiddenUnderRoof(c)) {
      const zz = Math.floor(now / 500) % 3;
      ctx.font = 'bold 9px sans-serif'; ctx.fillStyle = '#e0e8ff'; ctx.textAlign = 'left';
      ctx.fillText('z'.repeat(zz + 1), bx + 22, by - 2 - zz * 2);
    }
    return;
  }
  const s = sheetFor(c);
  const moving = c.moving;
  const fr = moving ? [1, 0, 2, 0][Math.floor((c.anim || 0) / 9) % 4] : 0;
  const di = dirIndex(c.dir || 'down');
  const SC = 2;
  const dw = SPR_W * SC, dh = SPR_H * SC;
  const bob = moving && fr !== 0 ? -1 : 0;
  // 影
  ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.beginPath(); ctx.ellipse(c.x, c.y + 12, 10, 4, 0, 0, 7); ctx.fill();
  if (jailed) ctx.globalAlpha = 0.85;
  ctx.drawImage(s.cv, fr * SPR_W, di * SPR_H, SPR_W, SPR_H, Math.round(c.x - dw / 2), Math.round(c.y + 14 - dh + bob), dw, dh);
  ctx.globalAlpha = 1;
  if (c.hurtUntil && now < c.hurtUntil) {
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = 'rgba(255,60,60,0.5)'; ctx.fillRect(c.x - dw / 2, c.y + 14 - dh, dw, dh);
    ctx.globalCompositeOperation = 'source-over';
  }
}

const ACT_ICON = { eat: '🍴', drink: '🍺', train: '💪', heal: '🩹', research: '🔬', buyfood: '🛒', forage: '🌱', board: '📋' };

function drawCharOverlay(ctx, c, now) {
  if (c.inBed) return;
  const top = c.y - 30;
  const near = Math.hypot(c.x - S.player.x, c.y - S.player.y) < TILE * 9;
  if (c.isPlayer) {
    const b = Math.sin(now / 180) * 2;
    ctx.fillStyle = '#ffe070'; ctx.beginPath(); ctx.moveTo(c.x - 5, top - 10 + b); ctx.lineTo(c.x + 5, top - 10 + b); ctx.lineTo(c.x, top - 4 + b); ctx.fill();
    ctx.strokeStyle = '#6a4a00'; ctx.lineWidth = 1; ctx.stroke();
  } else if (near || c.key) {
    label(ctx, (c.key ? '★' : '') + c.name, c.x, c.y + 20, 9, c.key ? '#ffe9a0' : '#ffffff');
  }
  let icon = '';
  if (!c.isPlayer && c.activity && S.t < c.busyUntil) icon = c.activity === 'work' ? JOBS[c.job].icon : ACT_ICON[c.activity] || '';
  if (S.wanted.has(c.id)) icon = '🚨' + icon;
  if (c.items.includes('meteor')) icon = '💎' + icon;
  if (c.companion) icon = '🤝' + icon;
  if (icon) { ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(icon, c.x, top - 2); }
  if (c.hp < 40) {
    ctx.fillStyle = '#300'; ctx.fillRect(c.x - 10, c.y + 26, 20, 3);
    ctx.fillStyle = '#e33'; ctx.fillRect(c.x - 10, c.y + 26, 20 * Math.max(0, c.hp) / 100, 3);
  }
  if (isJailed(c)) label(ctx, '🔒', c.x, top - 2, 10);
}

function drawBubble(ctx, c, now) {
  if (!c.bubble || now > c.bubble.until) return;
  ctx.font = '10px sans-serif';
  const lines = wrap(ctx, c.bubble.text, 150);
  const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 10;
  const th = lines.length * 13 + 6;
  const bx = c.x - tw / 2, by = c.y - 36 - th - (c.inBed ? -14 : 0);
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  roundRect(ctx, bx, by, tw, th, 5); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.beginPath(); ctx.moveTo(c.x - 4, by + th); ctx.lineTo(c.x + 4, by + th); ctx.lineTo(c.x, by + th + 5); ctx.fill();
  ctx.fillStyle = '#222'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, c.x, by + 4 + i * 13));
}

function wrap(ctx, text, maxW) {
  const out = [];
  let cur = '';
  for (const ch of text) {
    if (ctx.measureText(cur + ch).width > maxW) { out.push(cur); cur = ch; if (out.length >= 2) break; }
    else cur += ch;
  }
  if (out.length < 3 && cur) out.push(cur);
  if (out.length === 3) out[2] = out[2].slice(0, -1) + '…';
  return out.slice(0, 3);
}

function sign(ctx, text, x, y) {
  ctx.font = 'bold 10px sans-serif';
  const tw = ctx.measureText(text).width + 12;
  ctx.fillStyle = '#4a2e16'; ctx.fillRect(x - tw / 2 - 1, y - 9, tw + 2, 18);
  ctx.fillStyle = '#a87a44'; ctx.fillRect(x - tw / 2, y - 8, tw, 16);
  ctx.fillStyle = '#c8985a'; ctx.fillRect(x - tw / 2, y - 8, tw, 2);
  ctx.fillStyle = '#2a1a0a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 1);
}

function label(ctx, text, x, y, size, color = '#fff') {
  ctx.font = `bold ${size}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.strokeText(text, x, y);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// ================= 夜 =================
function drawNight(ctx, w, h, camX, camY, Z) {
  const hr = hour() + (S.t % 60) / 60;
  let dark = 0;
  if (hr >= 18) dark = Math.min(0.62, (hr - 18) * 0.2);
  else if (hr < 5) dark = 0.62;
  else if (hr < 7) dark = 0.62 * (7 - hr) / 2;
  if (dark <= 0.01) return;
  if (!lightCv) lightCv = document.createElement('canvas');
  if (lightCv.width !== w || lightCv.height !== h) { lightCv.width = w; lightCv.height = h; }
  const g = lightCv.getContext('2d');
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, w, h);
  g.fillStyle = `rgba(12,16,48,${dark})`; g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'destination-out';
  const lights = [...LAMPS];
  // 屋根を外した建物の中は明るく
  for (const f of FACILITIES) if (f.kind !== 'field' && (roofAlpha[f.id] ?? 1) < 0.5)
    lights.push([(f.x + f.w / 2) * TILE, (f.y + f.h / 2) * TILE, Math.max(f.w, f.h) * TILE * 0.75]);
  lights.push([S.player.x, S.player.y, 90]);
  for (const [lx, ly, r] of lights) {
    const sx = (lx - camX) * Z, sy = (ly - camY) * Z, sr = r * Z;
    if (sx < -sr || sy < -sr || sx > w + sr || sy > h + sr) continue;
    const grd = g.createRadialGradient(sx, sy, 0, sx, sy, sr);
    grd.addColorStop(0, 'rgba(0,0,0,0.85)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
  }
  ctx.drawImage(lightCv, 0, 0);
  // 暖色の明かり
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const [lx, ly, r] of LAMPS) {
    const sx = (lx - camX) * Z, sy = (ly - camY) * Z, sr = r * 0.6 * Z;
    if (sx < -sr || sy < -sr || sx > w + sr || sy > h + sr) continue;
    const grd = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
    grd.addColorStop(0, `rgba(255,190,90,${0.22 * dark})`); grd.addColorStop(1, 'rgba(255,190,90,0)');
    ctx.fillStyle = grd; ctx.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
  }
  ctx.restore();
}

// ================= ミニマップ =================
function drawMinimap(ctx, w, camX, camY, vw, vh) {
  const mw = miniCache.width, mh = miniCache.height;
  const x0 = w - mw - 10, y0 = 10;
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x0 - 3, y0 - 3, mw + 6, mh + 6);
  ctx.drawImage(miniCache, x0, y0);
  ctx.globalAlpha = 1;
  const sc = MINI / TILE;
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1;
  ctx.strokeRect(x0 + camX * sc, y0 + camY * sc, vw * sc, vh * sc);
  for (const c of S.chars) {
    if (!c.alive || c.isPlayer) continue;
    ctx.fillStyle = c.key ? '#ffe070' : '#ffffff';
    if (S.wanted.has(c.id)) ctx.fillStyle = '#ff5050';
    ctx.fillRect(x0 + c.x * sc - 1, y0 + c.y * sc - 1, 2, 2);
  }
  const p = S.player;
  ctx.fillStyle = '#ff4a6a'; ctx.fillRect(x0 + p.x * sc - 2, y0 + p.y * sc - 2, 4, 4);
  ctx.strokeStyle = '#fff'; ctx.strokeRect(x0 + p.x * sc - 2.5, y0 + p.y * sc - 2.5, 5, 5);
}
