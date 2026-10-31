// マップ（通行判定・経路探索）
import { MAP_W, MAP_H, FACILITIES, BOARD_POS, TILE } from './data.js';

export const grid = [];      // grid[y][x] = true なら通れる
export const roads = new Set();

export function buildGrid() {
  grid.length = 0;
  for (let y = 0; y < MAP_H; y++) grid.push(new Array(MAP_W).fill(true));
  for (let x = 0; x < MAP_W; x++) { grid[0][x] = false; grid[MAP_H - 1][x] = false; }
  for (let y = 0; y < MAP_H; y++) { grid[y][0] = false; grid[y][MAP_W - 1] = false; }
  for (const f of FACILITIES) {
    for (let y = f.y; y < f.y + f.h; y++)
      for (let x = f.x; x < f.x + f.w; x++) grid[y][x] = false;
  }
  grid[BOARD_POS[1]][BOARD_POS[0]] = false;
  for (const f of FACILITIES) grid[f.door[1]][f.door[0]] = true;

  roads.clear();
  const addRow = (y) => { for (let x = 1; x < MAP_W - 1; x++) roads.add(x + ',' + y); };
  const addCol = (x, y0, y1) => { for (let y = y0; y <= y1; y++) roads.add(x + ',' + y); };
  addRow(10); addRow(11); addRow(21); addRow(22); addRow(30);
  addCol(20, 1, 30); addCol(21, 1, 30);
  for (const f of FACILITIES) {
    const [dx, dy] = f.door;
    for (let y = dy; y <= dy + 3 && y < MAP_H - 1; y++) {
      if (roads.has(dx + ',' + y)) break;
      if (grid[y][dx]) roads.add(dx + ',' + y);
    }
  }
}

export function walkable(x, y) {
  return x >= 0 && y >= 0 && x < MAP_W && y < MAP_H && grid[y][x];
}

export function tileOf(px) { return Math.floor(px / TILE); }

// 幅優先探索。返り値は [x,y] の配列（開始タイルは含まない）
export function findPath(sx, sy, tx, ty) {
  if (!walkable(tx, ty)) {
    const n = nearestWalkable(tx, ty);
    if (!n) return [];
    [tx, ty] = n;
  }
  if (sx === tx && sy === ty) return [];
  const W = MAP_W;
  const prev = new Int32Array(MAP_W * MAP_H).fill(-1);
  const start = sy * W + sx;
  const goal = ty * W + tx;
  prev[start] = start;
  const q = [start];
  let head = 0;
  while (head < q.length) {
    const cur = q[head++];
    if (cur === goal) break;
    const cx = cur % W, cy = (cur / W) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (!walkable(nx, ny)) continue;
      const ni = ny * W + nx;
      if (prev[ni] !== -1) continue;
      prev[ni] = cur;
      q.push(ni);
    }
  }
  if (prev[goal] === -1) return [];
  const path = [];
  let cur = goal;
  while (cur !== start) { path.push([cur % W, (cur / W) | 0]); cur = prev[cur]; }
  return path.reverse();
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function nearestWalkable(x, y) {
  for (let r = 0; r < 6; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (walkable(x + dx, y + dy)) return [x + dx, y + dy];
  return null;
}

export function randomPlazaTile(rand) {
  for (let i = 0; i < 30; i++) {
    const x = 18 + Math.floor(rand() * 9);
    const y = 13 + Math.floor(rand() * 7);
    if (walkable(x, y)) return [x, y];
  }
  return [22, 18];
}
