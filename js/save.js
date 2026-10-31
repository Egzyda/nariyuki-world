// セーブ・ロード（ブラウザの localStorage に保存。自分のPCの中だけ）
import { S, day, timeStr } from './state.js';
import * as Sim from './sim.js';
import { VERSION } from './version.js';

const KEY = 'nariyuki-save-';
export const SLOTS = ['manual', 'auto'];
export const SLOT_NAME = { manual: 'セーブ', auto: 'オートセーブ（毎朝）' };

const SKIP = new Set(['player', 'rand', 'toasts', 'effects', 'callout', 'banner', 'holdId', 'meetingPause']);
function replacer(k, v) {
  if (v instanceof Set) return { __set: [...v] };
  if (typeof v === 'function') return undefined;
  return v;
}
function reviver(k, v) { return v && typeof v === 'object' && Array.isArray(v.__set) ? new Set(v.__set) : v; }

export function save(slot = 'manual') {
  const st = {};
  for (const [k, v] of Object.entries(S)) if (!SKIP.has(k)) st[k] = v;
  const data = { v: VERSION, at: Date.now(), day: day(), time: timeStr(), S: st };
  try {
    localStorage.setItem(KEY + slot, JSON.stringify(data, replacer));
    return true;
  } catch (e) { console.warn('save failed', e); return false; }
}

export function info(slot) {
  try {
    const raw = localStorage.getItem(KEY + slot);
    if (!raw) return null;
    const head = JSON.parse(raw, (k, v) => (k === 'S' ? undefined : v));
    return head;
  } catch { return null; }
}

export function load(slot) {
  const raw = localStorage.getItem(KEY + slot);
  if (!raw) return false;
  const data = JSON.parse(raw, reviver);
  for (const k of Object.keys(S)) if (!SKIP.has(k) && !(k in data.S)) delete S[k];
  Object.assign(S, data.S);
  S.player = S.chars.find((c) => c.isPlayer);
  Sim.prepareLoaded();
  return true;
}

export function remove(slot) { localStorage.removeItem(KEY + slot); }
