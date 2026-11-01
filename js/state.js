// ゲーム全体の状態と小さなヘルパー
import { JOBS, TILE } from './data.js';

export const S = {
  rand: Math.random,
  t: 0,              // 1日目 0:00 からの経過分
  speed: 1,
  paused: false,
  chars: [],
  player: null,
  fac: {},
  foodStock: 0,
  board: [],
  log: [],
  stats: { crimes: 0, deaths: 0, arrests: 0, bribes: 0, fights: 0, thefts: 0 },
  today: { crimes: 0, deaths: 0 },
  wanted: new Set(),
  meteor: null,
  droughtUntilDay: 0,
  meteorHour: -1,
  over: false,
  toasts: [],
  effects: [],       // 画面演出（フラッシュなど）
  postSeq: 1,
};

export const day = () => Math.floor(S.t / 1440) + 1;
export const hour = () => Math.floor((S.t % 1440) / 60);
export const minute = () => Math.floor(S.t % 60);
export const timeStr = () => `${String(hour()).padStart(2, '0')}:${String(minute()).padStart(2, '0')}`;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const pick = (arr) => arr[Math.floor(S.rand() * arr.length)];
export const chance = (p) => S.rand() < p;

export function rel(a, b) {
  const id = typeof b === 'string' ? b : b.id;
  return (a.rel[id] ||= { like: 0, fear: 0 });
}

export function addLike(a, b, v) { const r = rel(a, b); r.like = clamp(r.like + v, -100, 100); }
export function addFear(a, b, v) { const r = rel(a, b); r.fear = clamp(r.fear + v, 0, 100); }

export function byId(id) { return S.chars.find((c) => c.id === id); }
export function byName(name) { return S.chars.find((c) => c.name === name); }
export function alive() { return S.chars.filter((c) => c.alive); }
export function residents() { return S.chars.filter((c) => !c.isPlayer); }

export function tilePos(c) { return [Math.floor(c.x / TILE), Math.floor(c.y / TILE)]; }
export function distTiles(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) / TILE; }

export function jobName(c) { return JOBS[c.job]?.name ?? '?'; }

export function isAwake(c) {
  return c.alive && !isJailed(c) && !(c.activity === 'sleep' && S.t < c.busyUntil);
}
export function isJailed(c) { return c.jailedUntil > S.t; }

// kind: crime(事件) gift(もらった) talk など。recent には時刻つきで残す
export function memo(c, text, kind = 'info') {
  c.memory.push(`${day()}日目 ${text}`);
  if (c.memory.length > 12) c.memory.shift();
  (c.recent ||= []).push({ text, t: S.t, kind });
  if (c.recent.length > 8) c.recent.shift();
}

// 最近（hours時間以内）の出来事
export function recentEvents(c, hours = 8, kinds = null) {
  return (c.recent || []).filter((e) => S.t - e.t <= hours * 60 && (!kinds || kinds.includes(e.kind))).reverse();
}

export function floatText(c, text, color = '#ffe070') {
  S.effects.push({ type: 'float', x: c.x, y: c.y - 30, text, color, t: 1.4 });
}

export function say(c, text, sec = 4) {
  c.bubble = { text, until: performance.now() + sec * 1000 };
}

export function log(text, kind = 'info') {
  S.log.unshift({ day: day(), time: timeStr(), text, kind });
  if (S.log.length > 600) S.log.pop();
}

export function toast(text) {
  S.toasts.push({ text, until: performance.now() + 3500 });
}

export function post(author, text, extra = {}) {
  const p = { id: S.postSeq++, day: day(), time: timeStr(), author, text, replies: [], ...extra };
  S.board.unshift(p);
  if (S.board.length > 120) S.board.pop();
  return p;
}

export function mentionedNames(text) {
  return residents().filter((c) => text.includes(c.name));
}
