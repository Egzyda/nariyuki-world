// マップ（地形・建物の内部・通行判定・経路探索）
import { MAP_W, MAP_H, FACILITIES, BOARD_POS, PLAZA, ROADS, FOUNTAIN, PLAZA_DECOR, TILE } from './data.js';

// 地形の種類
export const T = {
  GRASS: 0, ROAD: 1, PLAZA: 2, FLOOR: 3, WALL: 4, DOOR: 5, WATER: 6, TREE: 7, FENCE: 8, CROP: 9, SOIL: 10, EDGE: 11,
};

// 歩ける家具と、その上を通るときのコスト（経路が家具の上を通りにくくする）
const FURN_WALK = { chair: 5, stool: 5, bed: 8, bench: 4 };
const SEAT_FURN = new Set(['chair', 'stool', 'bench']);

export const ttype = new Uint8Array(MAP_W * MAP_H);
export const furn = new Array(MAP_W * MAP_H).fill(null);
export const facIdx = new Int8Array(MAP_W * MAP_H).fill(-1);   // 建物の敷地（壁込み）
export const FAC = {};          // id -> facility
export const SPOTS = {};        // id -> { interior, seat, bed, work, customer, train, cell }
export const LAMPS = [];        // 夜に光る場所 [px, py, 半径]

const I = (x, y) => y * MAP_W + x;
const inMap = (x, y) => x >= 0 && y >= 0 && x < MAP_W && y < MAP_H;

// 位置から決まる疑似乱数（地図の見た目を毎回同じにする）
export function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function buildWorld() {
  ttype.fill(T.GRASS); furn.fill(null); facIdx.fill(-1);
  LAMPS.length = 0;
  for (let x = 0; x < MAP_W; x++) { ttype[I(x, 0)] = T.EDGE; ttype[I(x, MAP_H - 1)] = T.EDGE; }
  for (let y = 0; y < MAP_H; y++) { ttype[I(0, y)] = T.EDGE; ttype[I(MAP_W - 1, y)] = T.EDGE; }

  // 道
  for (const [x0, y0, x1, y1] of ROADS)
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inMap(x, y) && ttype[I(x, y)] !== T.EDGE) ttype[I(x, y)] = T.ROAD;

  // 広場
  for (let y = PLAZA.y; y < PLAZA.y + PLAZA.h; y++) for (let x = PLAZA.x; x < PLAZA.x + PLAZA.w; x++) ttype[I(x, y)] = T.PLAZA;
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) ttype[I(FOUNTAIN[0] + dx, FOUNTAIN[1] + dy)] = T.WATER;
  furn[I(BOARD_POS[0], BOARD_POS[1])] = 'board';
  for (const [x, y, k] of PLAZA_DECOR) {
    furn[I(x, y)] = k;
    if (k === 'lamp') LAMPS.push([x * TILE + 16, y * TILE + 6, 110]);
  }

  // 建物
  FACILITIES.forEach((f, fi) => {
    FAC[f.id] = f;
    const sp = SPOTS[f.id] = { interior: [], seat: [], bed: [], work: [], customer: [], train: [], cell: [] };
    for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + f.w; x++) {
      facIdx[I(x, y)] = fi;
      const border = x === f.x || y === f.y || x === f.x + f.w - 1 || y === f.y + f.h - 1;
      if (f.kind === 'field') ttype[I(x, y)] = border ? T.FENCE : T.SOIL;
      else ttype[I(x, y)] = border ? T.WALL : T.FLOOR;
    }
    const [dx, dy] = f.door;
    ttype[I(dx, dy)] = T.DOOR;
    // 入口から道までの小道
    for (let y = dy + 1; y < MAP_H - 1; y++) {
      if (ttype[I(dx, y)] === T.ROAD) break;
      if (ttype[I(dx, y)] === T.GRASS) ttype[I(dx, y)] = T.ROAD;
    }
    if (f.kind === 'field') {
      // 畑：作物の列と通路
      for (let ry = 1; ry < f.h - 1; ry++) for (let rx = 1; rx < f.w - 1; rx++) {
        const isPath = ry === 3 || ry === 6 || rx === 6;
        if (!isPath) { ttype[I(f.x + rx, f.y + ry)] = T.CROP; sp.work.push([f.x + rx, f.y + ry]); }
      }
      furn[I(f.x + 3, f.y + 3)] = 'scarecrow';
      furn[I(f.x + 10, f.y + 6)] = 'well';
    } else {
      for (const [rx, ry, k] of f.furn || []) furn[I(f.x + rx, f.y + ry)] = k;
      // 窓明かり・入口の明かり
      LAMPS.push([dx * TILE + 16, dy * TILE + 20, 70]);
    }
    for (const [key, list] of Object.entries(f.spots || {}))
      for (const [rx, ry] of list) sp[key].push([f.x + rx, f.y + ry]);
    const inCell = (x, y) => sp.cell.some(([cx, cy]) => cx === x && cy === y) || (f.id === 'guard' && x > f.x + 5 && y < f.y + 3);
    for (let y = f.y + 1; y < f.y + f.h - 1; y++) for (let x = f.x + 1; x < f.x + f.w - 1; x++) {
      if (inCell(x, y)) continue;
      const k = furn[I(x, y)];
      if (SEAT_FURN.has(k)) sp.seat.push([x, y]);
      if (k === 'bed') sp.bed.push([x, y]);
      if (walkable(x, y) && !k) sp.interior.push([x, y]);
    }
  });

  // 木（道・建物・広場から少し離れた草地にだけ生やす）
  for (let y = 1; y < MAP_H - 1; y++) for (let x = 1; x < MAP_W - 1; x++) {
    if (ttype[I(x, y)] !== T.GRASS) continue;
    let near = false;
    for (let oy = -1; oy <= 1 && !near; oy++) for (let ox = -1; ox <= 1; ox++) {
      const t = ttype[I(x + ox, y + oy)];
      if (t !== T.GRASS && t !== T.EDGE && t !== T.TREE) { near = true; break; }
    }
    if (!near && hash2(x, y) < 0.22) ttype[I(x, y)] = T.TREE;
  }
}

export function tileType(x, y) { return inMap(x, y) ? ttype[I(x, y)] : T.EDGE; }
export function furnAt(x, y) { return inMap(x, y) ? furn[I(x, y)] : null; }

export function walkable(x, y) {
  if (!inMap(x, y)) return false;
  const t = ttype[I(x, y)];
  if (t === T.WALL || t === T.WATER || t === T.TREE || t === T.FENCE || t === T.EDGE) return false;
  const k = furn[I(x, y)];
  return !k || k in FURN_WALK;
}

function cost(x, y) {
  const i = I(x, y);
  const k = furn[i];
  if (k) return FURN_WALK[k] * 10;
  const t = ttype[i];
  if (t === T.ROAD || t === T.PLAZA || t === T.FLOOR || t === T.DOOR) return 10;
  if (t === T.SOIL) return 11;
  if (t === T.CROP) return 16;
  return 15;
}

// 建物の敷地にいるならその施設、外なら null（入口タイルも施設に含む）
export function facAt(x, y) {
  if (!inMap(x, y)) return null;
  const i = facIdx[I(x, y)];
  return i >= 0 ? FACILITIES[i] : null;
}
// 屋根の下（入口以外の室内）にいるか
export function roofedFacAt(x, y) {
  const f = facAt(x, y);
  if (!f || f.kind === 'field') return null;
  if (x === f.door[0] && y === f.door[1]) return null;
  return f;
}

export function tileOf(px) { return Math.floor(px / TILE); }

// ---- 経路探索（ダイクストラ・4方向） ----
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const distArr = new Float64Array(MAP_W * MAP_H);
const prevArr = new Int32Array(MAP_W * MAP_H);

export function findPath(sx, sy, tx, ty) {
  if (!walkable(tx, ty)) {
    const n = nearestWalkable(tx, ty);
    if (!n) return [];
    [tx, ty] = n;
  }
  if (!walkable(sx, sy)) {
    const n = nearestWalkable(sx, sy);
    if (!n) return [];
    [sx, sy] = n;
  }
  if (sx === tx && sy === ty) return [];
  distArr.fill(Infinity); prevArr.fill(-1);
  const start = I(sx, sy), goal = I(tx, ty);
  distArr[start] = 0;
  const heap = [[0, start]];
  while (heap.length) {
    const [d, cur] = heapPop(heap);
    if (cur === goal) break;
    if (d > distArr[cur]) continue;
    const cx = cur % MAP_W, cy = (cur / MAP_W) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (!walkable(nx, ny)) continue;
      const ni = I(nx, ny);
      const nd = d + (ni === goal ? 10 : cost(nx, ny));
      if (nd < distArr[ni]) { distArr[ni] = nd; prevArr[ni] = cur; heapPush(heap, [nd, ni]); }
    }
  }
  if (prevArr[goal] === -1) return [];
  const path = [];
  let cur = goal;
  while (cur !== start) { path.push([cur % MAP_W, (cur / MAP_W) | 0]); cur = prevArr[cur]; }
  return path.reverse();
}

function heapPush(h, v) {
  h.push(v);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h[p][0] <= h[i][0]) break;
    [h[p], h[i]] = [h[i], h[p]]; i = p;
  }
}
function heapPop(h) {
  const top = h[0];
  const last = h.pop();
  if (h.length) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < h.length && h[l][0] < h[m][0]) m = l;
      if (r < h.length && h[r][0] < h[m][0]) m = r;
      if (m === i) break;
      [h[m], h[i]] = [h[i], h[m]]; i = m;
    }
  }
  return top;
}

export function nearestWalkable(x, y) {
  for (let r = 0; r < 8; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === r && walkable(x + dx, y + dy)) return [x + dx, y + dy];
  return null;
}

export function isOutdoor(x, y) { return walkable(x, y) && !facAt(x, y) && !furnAt(x, y); }

export function randomPlazaTile(rand) {
  for (let i = 0; i < 40; i++) {
    const x = PLAZA.x + Math.floor(rand() * PLAZA.w);
    const y = PLAZA.y + Math.floor(rand() * PLAZA.h);
    if (walkable(x, y) && !furnAt(x, y)) return [x, y];
  }
  return [PLAZA.x + 2, PLAZA.y + 4];
}

export function randomOutdoorTile(rand, x0 = 2, y0 = 10, x1 = MAP_W - 3, y1 = 25) {
  for (let i = 0; i < 80; i++) {
    const x = x0 + Math.floor(rand() * (x1 - x0));
    const y = y0 + Math.floor(rand() * (y1 - y0));
    if (isOutdoor(x, y)) return [x, y];
  }
  return randomPlazaTile(rand);
}
