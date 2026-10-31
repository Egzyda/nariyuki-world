// シミュレーション本体：時間・欲求・ルールAI・行動・事件
import * as D from './data.js';
import { TILE, JOBS, FACILITIES, ITEMS } from './data.js';
import {
  buildWorld, findPath, walkable, randomPlazaTile, randomOutdoorTile, nearestWalkable, facAt, roofedFacAt, furnAt, SPOTS, FAC,
} from './world.js';
import {
  S, day, hour, timeStr, clamp, pick, chance, rel, addLike, addFear, byId, residents,
  tilePos, distTiles, isAwake, isJailed, memo, say, log, toast, post, mentionedNames, floatText,
} from './state.js';
import * as Brain from './brain.js';
import { placeName } from './dialog.js';
import * as Wolf from './wolf.js';

const MOVE_TILES_PER_MIN = 0.75;
const FOUNTAIN_Y = (D.FOUNTAIN[1] + 1) * TILE;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeChar(def, tx, ty) {
  return {
    ...def,
    x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2,
    dir: 'down', moving: false, anim: 0,
    path: [], plan: null, activity: null, busyUntil: 0, jailedUntil: 0,
    spot: null, inBed: false, bed: null, companion: null, guiding: null, pending: null,
    hp: 100, hunger: 70 + S.rand() * 25, coins: 4 + Math.floor(S.rand() * 5), food: 1,
    str: 8 + Math.round((def.p?.aggression ?? 0.3) * 10) + (['smith', 'guard'].includes(def.job) ? 4 : 0),
    items: [], alive: true, rel: {}, memory: [], bubble: null, intent: null,
    chatLog: [], postsToday: 0, lastPostAt: -9999, lastChatAt: -9999, nextFidget: 0, lastGreetDay: 0,
  };
}

export function initGame(seed = Date.now()) {
  S.rand = mulberry32(seed >>> 0);
  buildWorld();
  Object.assign(S, {
    t: D.START_HOUR * 60, speed: 1, paused: false, chars: [], fac: {}, foodStock: 30,
    board: [], log: [], stats: { crimes: 0, deaths: 0, arrests: 0, bribes: 0, fights: 0, thefts: 0 },
    today: { crimes: 0, deaths: 0 }, wanted: new Set(), meteor: null, droughtUntilDay: 0,
    meteorHour: 10 + Math.floor(S.rand() * 5), over: false, toasts: [], effects: [], postSeq: 1, gameOverReason: null, holdId: null, banner: null,
  });
  for (const f of FACILITIES) S.fac[f.id] = { closedUntilDay: 0 };

  const defs = [...D.KEY_RESIDENTS, ...D.makeBackgroundResidents(S.rand)];
  const bedUsed = {};
  for (const d of defs) {
    const beds = SPOTS[d.home].bed;
    const i = bedUsed[d.home] = (bedUsed[d.home] ?? -1) + 1;
    const bed = beds[i % beds.length];
    const c = makeChar(d, bed[0], bed[1]);
    c.bed = bed;
    // 朝6時：少しずつ起きだす
    c.activity = 'sleep'; c.inBed = true; c.spot = bed; c.busyUntil = S.t + 5 + Math.floor(S.rand() * 70);
    S.chars.push(c);
  }
  const player = makeChar({
    id: 'player', name: 'あなた', job: 'none', home: 'house6', key: false, isPlayer: true,
    persona: '', p: { aggression: 0.3, honesty: 0.5, sociability: 0.5, greed: 0.5 },
  }, FAC.house6.door[0], FAC.house6.door[1] + 1);
  player.coins = 3; player.hunger = 70; player.food = 0; player.str = 10; player.dir = 'down'; player.bank = 0;
  player.bed = SPOTS.house6.bed[0];
  S.player = player;
  S.chars.push(player);

  // 初期の人間関係
  const rs = residents();
  for (const a of rs) for (const b of rs) {
    if (a === b) continue;
    rel(a, b).like = Math.round(-10 + S.rand() * 30 + (a.home === b.home ? 20 : 0) + (a.job === b.job ? 10 : 0));
  }
  const setRel = (a, b, v) => { rel(byId(a), byId(b)).like = v; };
  setRel('gou', 'kage', -45); setRel('kage', 'gou', -30);
  setRel('mina', 'haru', 50); setRel('haru', 'mina', 50);
  setRel('tsuzumi', 'ban', 35); setRel('ban', 'tsuzumi', 40);
  setRel('yoru', 'tsuzumi', -30);
  setRel('shion', 'mina', -15);

  Wolf.initWolf();
  S.callout = null; S.nextApproachT = S.t + 60;
  for (const c of rs) Brain.dailyIntent(c);
  post('町役場', 'ようこそナリユキワールドへ。この掲示板は誰でも自由に書き込めます。', { authorId: 'town' });
  post('町役場', '本日、町に新しい住人（よそ者）がやってきました。皆さん仲良くしましょう。', { authorId: 'town' });
  log('あなたはナリユキワールドにやってきた。所持金は3G。町の南東の🏡があなたの家だ。', 'event');
}

// ================= 時間 =================
export function update(dtReal) {
  if (S.over) return;
  for (const e of S.effects) e.t -= dtReal;
  S.effects = S.effects.filter((e) => e.t > 0);
  if (S.paused) return;
  Wolf.update();
  if (S.meetingPause || S.over) return;
  const p = S.player;
  const fast = p.alive && ((p.activity === 'sleep' && p.busyUntil > S.t) || isJailed(p));
  // 働く・鍛えるなどの間は時間を早送り（待たされる感じを減らす）
  const doing = p.alive && !fast && p.busyUntil > S.t && ['work', 'train', 'research', 'heal', 'eat', 'drink'].includes(p.activity);
  const gdt = Math.min(dtReal, 0.1) * D.GAME_MIN_PER_SEC * S.speed * (fast ? 25 : doing ? 4 : 1);
  const before = S.t;
  S.t += gdt;
  const h0 = Math.floor(before / 60), h1 = Math.floor(S.t / 60);
  for (let h = h0 + 1; h <= h1; h++) hourly(h % 24, Math.floor(h / 24) + 1);
  if (S.over) return;
  for (const c of S.chars) updateChar(c, gdt);
  if (p.activity === 'sleep' && S.t >= p.busyUntil) { p.activity = null; getOutOfBed(p); toast('朝になった。'); }
  if (p.activity && p.activity !== 'sleep' && S.t >= p.busyUntil && p.inBed) getOutOfBed(p);
}

function hourly(h, d) {
  for (const c of S.chars) {
    if (!c.alive) continue;
    const sleeping = c.activity === 'sleep' && S.t < c.busyUntil + 1;
    if (isJailed(c)) c.hunger = Math.max(c.hunger, 45);
    c.hunger = clamp(c.hunger - (sleeping ? 2 : 4) - (c.activity === 'train' ? 3 : 0), 0, 100);
    if (c.hunger <= 0) c.hp -= 7;
    else if (c.hunger > 50) c.hp = Math.min(100, c.hp + 2);
    if (c.hp <= 0) { die(c, c.hunger <= 0 ? '飢え' : 'けが'); continue; }
    if (c.isPlayer && c.hunger < 20 && c.hunger + 4 >= 20) toast('お腹が空いて力が出ない…何か食べないと。');
  }
  const workers = S.chars.filter((c) => c.alive && c.activity === 'work' && S.t - 60 < c.busyUntil);
  for (const c of workers) {
    const place = JOBS[c.job]?.place;
    if (!place) continue;
    const co = workers.filter((o) => o !== c && JOBS[o.job]?.place === place).length;
    const bonus = 1 + 0.25 * Math.min(2, co);
    const pay = JOBS[c.job].wage * bonus * (c.isPlayer ? 1 : 0.6);
    c.coins += pay;
    if (c.isPlayer) floatText(c, `+${pay.toFixed(1)}G`);
    if (c.job === 'farmer') S.foodStock += 1.0 * bonus * (S.droughtUntilDay >= d ? 0.35 : 1);
  }
  const m = S.meteor;
  if (m && m.state === 'researching') {
    const h0 = byId(m.holder);
    if (!h0 || !h0.alive || h0.activity !== 'research') m.state = 'held';
    else {
      const researcherHere = S.chars.some((c) => c.alive && c.job === 'researcher' && (c === h0 || (c.activity === 'work' && S.t < c.busyUntil)));
      m.progress += researcherHere ? 34 : 12;
      if (m.progress >= 100) finishResearch(h0);
    }
  }
  if (d === D.EVENTS.meteor.day && h === S.meteorHour && !S.meteor) meteorFall();
  if (h === 22) for (const c of S.chars) if (c.companion) endCompanion(c, true, true);
  Wolf.hourly(h);
  if (h >= 7 && h <= 21 && chance(0.5)) tryApproach();
  if (h === 6) daily(d);
}

function daily(d) {
  if (d > D.LAST_DAY) { S.over = true; return; }
  const y = S.today;
  post('町役場', `【${d}日目の朝刊】昨日の事件${y.crimes}件、亡くなった人${y.deaths}人。食料の蓄え${Math.floor(S.foodStock)}食分。` +
    (S.foodStock < 15 ? '食料が不足しています！' : ''), { authorId: 'town' });
  S.today = { crimes: 0, deaths: 0 };
  for (const c of S.chars) c.postsToday = 0;
  if (d >= D.EVENTS.drought.fromDay && S.droughtUntilDay < d && chance(D.EVENTS.drought.chance)) {
    S.droughtUntilDay = d + D.EVENTS.drought.days - 1;
    log('日照りが始まった。しばらく畑の実りが悪くなりそうだ。', 'event');
    post('町役場', '【警報】日照りのため、しばらく畑の収穫が大きく減る見込みです。', { authorId: 'town' });
    toast('☀️ 日照りが始まった！');
  }
  for (const c of S.chars) {
    if (!c.alive) continue;
    if (c.coins >= 2) c.coins -= 2; else c.hunger = clamp(c.hunger - 10, 0, 100);
    if (c.isPlayer) continue;
    c.favor = (c.favor || 0) * 0.5;
    const forgive = 0.1 + c.p.sociability * 0.1 + c.p.honesty * 0.1 - c.p.aggression * 0.08;
    for (const r of Object.values(c.rel)) {
      if (r.like < 0) r.like *= 1 - forgive;
      r.fear *= 0.85;
    }
  }
  if (S.player.alive) toast('生活費として2G払った。');
  for (const c of S.chars) if (c.alive && c.items.includes('cursed')) {
    c.hp -= 15; memo(c, '呪いの石のせいで体が重い');
    if (c.isPlayer) toast('🌑 呪いの石が体力を奪っていく…');
  }
  for (const c of residents()) {
    if (!c.alive) continue;
    const inf = influence(c.id);
    if (inf.ratio >= 0.5 && !c.announcedRule) {
      c.announcedRule = true;
      const how = inf.fear > inf.sup ? '恐怖' : '人望';
      log(`${c.name}が${how}で町を仕切り始めている（影響力${Math.round(inf.ratio * 100)}%）。`, 'event');
      post('町役場', `最近、${c.name}さんの発言力が強まっているようです。`, { authorId: 'town' });
    }
  }
  const keys = residents().filter((c) => c.alive && c.key);
  for (const c of residents()) if (c.alive) Brain.dailyIntent(c);
  // 起きる時間をばらけさせる
  for (const c of residents()) if (c.alive && c.activity === 'sleep') c.busyUntil = S.t + Math.floor(S.rand() * 75);
  const poster = keys.filter(() => chance(0.35)).slice(0, 2);
  setTimeout(() => poster.forEach((c) => Brain.postAbout(c, 'morning')), 1500);
}

// ================= 住民の更新 =================
function updateChar(c, gdt) {
  if (!c.alive) return;
  c.moving = false;
  if (!c.isPlayer && S.holdId === c.id && !isJailed(c)) {
    // 話しかけられている間は立ち止まってこちらを向く
    if (!c.inBed) faceTo(c, S.player);
    if (c.busyUntil > S.t) c.busyUntil += gdt;
    return;
  }
  if (c.jailedUntil) {
    if (S.t < c.jailedUntil) return;
    c.jailedUntil = 0; c.activity = null; c.spot = null;
    const [dx, dy] = FAC.guard.door;
    c.x = dx * TILE + TILE / 2; c.y = (dy + 1) * TILE + TILE / 2; c.dir = 'down';
    say(c, '……やっと出られた');
    if (c.isPlayer) toast('牢屋から出られた。');
  }
  const speed = gdt * MOVE_TILES_PER_MIN * TILE * (c.hunger < 15 ? 0.6 : 1);
  if (c.hunt) { Wolf.step(c, speed); return; }
  if (!c.isPlayer) maybeRemark(c);
  if (!c.isPlayer && c.companion && !c.companion.arrived) {
    updateCompanion(c);
    if (c.companion && c.path.length) move(c, speed * (c.companion.lead ? 1.15 : 1.9));
    return;
  }
  if (c.path.length) { move(c, speed); if (!c.path.length) reached(c); return; }
  if (c.isPlayer) return;
  if (c.companion?.arrived) {
    if (S.t >= c.busyUntil) { endCompanion(c, true); return; }
    // 一緒にいる間のおしゃべり
    if (S.t >= (c.companion.chatT || 0) && distTiles(c, S.player) < 4) {
      c.companion.chatT = S.t + 8 + S.rand() * 6;
      say(c, Brain.togetherLine(c, c.companion.dest), 4);
    }
    return;
  }
  if (c.activity === 'wait' && c.appointment && S.t < c.busyUntil) {
    const [px, py] = tilePos(S.player);
    if (inDest(px, py, c.appointment.place) && distTiles(c, S.player) < 8) {
      const place = c.appointment.place;
      c.appointment = null;
      say(c, pick(['あ、来てくれた！', '待ってたよ！', 'よかった、来てくれて。']));
      addLike(c, S.player, 5);
      startCompanion(c, place, false);
      return;
    }
  }
  if (S.t < c.busyUntil) {
    if (c.plan?.targetId && c.activity === 'follow') arrive(c);
    else fidget(c);
    return;
  }
  if (c.plan && c.plan.targetId) { arrive(c); return; }
  if (c.guiding) { c.guiding = null; }
  if (c.inBed) getOutOfBed(c);
  c.activity = null;
  decide(c);
}

export function move(c, dist) {
  while (dist > 0 && c.path.length) {
    const [tx, ty] = c.path[0];
    const gx = tx * TILE + TILE / 2, gy = ty * TILE + TILE / 2;
    const dx = gx - c.x, dy = gy - c.y;
    const d = Math.hypot(dx, dy);
    if (d > 0.01) c.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    if (d <= dist) { c.x = gx; c.y = gy; c.path.shift(); dist -= d; c.anim += d; }
    else { c.x += (dx / d) * dist; c.y += (dy / d) * dist; c.anim += dist; dist = 0; }
    c.moving = true;
  }
}

export function goTo(c, tx, ty) {
  const [sx, sy] = tilePos(c);
  c.path = findPath(sx, sy, tx, ty);
}

// 道の途中で目的地に着いたとき
function reached(c) {
  if (c.plan) { arrive(c); return; }
  faceFurniture(c);
}

const BLOCK_DIRS = [['up', 0, -1], ['left', -1, 0], ['right', 1, 0], ['down', 0, 1]];
function faceFurniture(c) {
  const [x, y] = tilePos(c);
  for (const [d, dx, dy] of BLOCK_DIRS) {
    const k = furnAt(x + dx, y + dy);
    if (k && !['chair', 'stool', 'bed', 'bench'].includes(k)) { c.dir = d; return; }
  }
}

export function getOutOfBed(c) {
  if (!c.inBed) return;
  c.inBed = false;
  const [x, y] = tilePos(c);
  for (const [, dx, dy] of [['', 0, 1], ['', 1, 0], ['', -1, 0], ['', 0, -1]]) {
    if (walkable(x + dx, y + dy) && !furnAt(x + dx, y + dy)) { c.x = (x + dx) * TILE + 16; c.y = (y + dy) * TILE + 16; c.dir = 'down'; return; }
  }
}

export function leaveSpot(c) { c.spot = null; if (c.inBed) getOutOfBed(c); }

function spotTaken(t, c) {
  return S.chars.some((o) => o !== c && o.alive && o.spot && o.spot[0] === t[0] && o.spot[1] === t[1]);
}
function freeSpot(c, list) {
  if (!list || !list.length) return null;
  const free = list.filter((t) => !spotTaken(t, c));
  return free.length ? pick(free) : null;
}

function targetTile(c, place, act) {
  const f = FAC[place];
  const sp = SPOTS[place];
  if (!f || !sp) return randomPlazaTile(S.rand);
  let t = null;
  switch (act) {
    case 'sleep': t = place === c.home && c.bed ? c.bed : freeSpot(c, sp.bed); break;
    case 'eat': case 'drink': case 'sit': t = freeSpot(c, sp.seat); break;
    case 'work': case 'research': t = freeSpot(c, sp.work); break;
    case 'heal': t = freeSpot(c, sp.bed); break;
    case 'train': t = freeSpot(c, sp.train); break;
    case 'buyfood': t = freeSpot(c, sp.customer); break;
    case 'forage': t = freeSpot(c, SPOTS.farm.work); break;
    case 'rest': t = freeSpot(c, sp.seat) || (c.bed && place === c.home ? null : null); break;
    case 'bomb': return f.door;
  }
  return t || freeSpot(c, sp.interior) || sp.interior[0] || f.door;
}

export function setPlan(c, plan) {
  leaveSpot(c);
  c.plan = plan;
  c.activity = null;
  if (plan.place) {
    const t = plan.place === 'meteor' ? [S.meteor.tx, S.meteor.ty] : plan.place === 'plaza' ? plan.tile : targetTile(c, plan.place, plan.act);
    plan.tile = t;
    goTo(c, t[0], t[1]);
    if (!c.path.length) arrive(c);
  } else if (plan.targetId) {
    plan.tries = 0;
    arrive(c);
  }
}

function arrive(c) {
  const plan = c.plan;
  if (!plan) return;
  if (plan.place) {
    c.plan = null;
    const [x, y] = tilePos(c);
    if (plan.tile && plan.tile[0] === x && plan.tile[1] === y) {
      if (plan.place !== 'plaza' && plan.place !== 'meteor') c.spot = plan.tile;
      if (furnAt(x, y) === 'bed' && (plan.act === 'sleep' || plan.act === 'heal')) c.inBed = true;
    }
    faceFurniture(c);
    startActivity(c, plan);
    return;
  }
  if (plan.targetId) {
    const t = byId(plan.targetId);
    if (!t || !t.alive || isJailed(t) || plan.tries > 10 || (plan.giveUpAt && S.t > plan.giveUpAt)) { c.plan = null; c.activity = null; c.busyUntil = 0; return; }
    if (distTiles(c, t) <= 1.6 && canSee(c, t)) { c.plan = null; c.activity = null; faceTo(c, t); interact(c, t, plan.kind); return; }
    plan.tries++;
    const [tx, ty] = tilePos(t);
    goTo(c, tx, ty);
    if (c.path.length > 3) c.path = c.path.slice(0, Math.max(3, c.path.length - 1));
    if (!c.path.length) { c.plan = null; }
  }
}

export function faceTo(c, t) {
  const dx = t.x - c.x, dy = t.y - c.y;
  c.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
}

// 作業中に持ち場を少し移動する（畑を歩き回る・台所を行き来する）
function fidget(c) {
  if (c.activity !== 'work' || S.t < c.nextFidget) return;
  c.nextFidget = S.t + (c.job === 'farmer' ? 15 : 30) + S.rand() * 30;
  const place = JOBS[c.job]?.place;
  const list = place && SPOTS[place]?.work;
  if (!list || list.length < 2 || chance(0.35)) return;
  const t = freeSpot(c, list);
  if (!t) return;
  c.spot = t;
  goTo(c, t[0], t[1]);
}

const nextMorning = () => { const d = Math.floor(S.t / 1440); const m = d * 1440 + 6 * 60; return S.t < m ? m : m + 1440; };
const facOpen = (id) => !S.fac[id] || S.fac[id].closedUntilDay < day();

// ---- 見える範囲（建物の中と外はお互い見えない） ----
function zoneOf(c) {
  const [x, y] = tilePos(c);
  return roofedFacAt(x, y)?.id || 'out';
}
export function canSee(a, b) {
  const za = zoneOf(a), zb = zoneOf(b);
  if (za === zb) return true;
  const [ax, ay] = tilePos(a), [bx, by] = tilePos(b);
  if (za === 'out' && facAt(ax, ay)?.id === zb) return true;
  if (zb === 'out' && facAt(bx, by)?.id === za) return true;
  return false;
}

// ================= 一緒に行く =================
export function startCompanion(c, dest, treat) {
  leaveSpot(c);
  c.plan = null; c.path = []; c.activity = null; c.busyUntil = 0; c.guiding = null;
  c.companion = { dest, treat: !!treat, until: S.t + 150, arrived: false, repath: 0 };
  log(`${c.name}があなたについてきている${dest ? `（${placeName(dest)}へ）` : ''}。`);
}

export function endCompanion(c, happy, silent = false) {
  const comp = c.companion;
  if (!comp) return;
  c.companion = null;
  c.busyUntil = S.t + 5;
  if (happy && comp.arrived) {
    addLike(c, S.player, comp.treat ? 9 : 6);
    memo(c, `よそ者と${placeName(comp.dest || 'plaza')}で過ごした`);
    if (!silent) say(c, pick(['楽しかった！ またね。', 'ありがとう、またな。', 'いい時間だったよ。']));
  } else if (!silent) say(c, Brain.dismissLine(c));
}

function updateCompanion(c) {
  const comp = c.companion;
  const p = S.player;
  if (!p.alive || S.t > comp.until || isJailed(p)) { endCompanion(c, false); return; }
  const [px, py] = tilePos(p), [cx, cy] = tilePos(c);
  const pf = roofedFacAt(px, py);
  const dest = comp.dest || (pf && ['diner', 'tavern', 'training'].includes(pf.id) ? pf.id : null);
  if (dest && inDest(px, py, dest) && inDest(cx, cy, dest)) {
    comp.dest = dest;
    comp.arrived = true;
    say(c, Brain.arriveLine(c, dest));
    companionActivity(c, comp);
    return;
  }
  const d = distTiles(c, p);
  if (comp.lead && dest) {
    // 案内役：目的地へ向かうが、離れすぎたら立ち止まって待つ
    if (d > 6) {
      c.path = []; faceTo(c, p);
      if (S.t >= (comp.callT || 0)) { comp.callT = S.t + 20; say(c, pick(['こっちだよ！', 'ほら、早く！', 'ついてきてね。'])); }
      return;
    }
    if (inDest(cx, cy, dest)) { c.path = []; faceTo(c, p); return; }
    if (!c.path.length || S.t >= comp.repath) {
      comp.repath = S.t + 6;
      const t = dest === 'plaza' ? randomPlazaTile(S.rand) : targetTile(c, dest, 'visit');
      goTo(c, t[0], t[1]);
    }
    return;
  }
  if (d > 1.5) {
    if (!c.path.length || S.t >= comp.repath) {
      comp.repath = S.t + 2;
      goTo(c, px, py);
      if (c.path.length) c.path.pop();
    }
  } else {
    c.path = [];
    faceTo(c, p);
  }
}

function inDest(x, y, dest) {
  if (dest === 'plaza') { const P = D.PLAZA; return x >= P.x - 1 && x <= P.x + P.w && y >= P.y - 1 && y <= P.y + P.h; }
  const f = FAC[dest];
  if (!f) return false;
  return f.kind === 'field' ? facAt(x, y) === f : roofedFacAt(x, y) === f;
}

function companionActivity(c, comp) {
  const p = S.player;
  let act = 'visit';
  if (comp.dest === 'diner') {
    act = 'sit';
    if (c.hunger < 85 || comp.treat) {
      if (comp.treat && p.coins >= D.MEAL_COST) { p.coins -= D.MEAL_COST; act = 'eat_free'; toast(`${c.name}に食事をおごった（-${D.MEAL_COST}G）`); }
      else if (c.coins >= D.MEAL_COST) act = 'eat';
      else if (comp.treat) toast('おごるお金が足りなかった……');
    }
  } else if (comp.dest === 'tavern') {
    act = 'sit';
    if (comp.treat && p.coins >= D.DRINK_COST) { p.coins -= D.DRINK_COST; act = 'drink_free'; toast(`${c.name}に一杯おごった（-${D.DRINK_COST}G）`); }
    else if (c.coins >= D.DRINK_COST) act = 'drink';
  } else if (comp.dest === 'training') act = 'train';
  else if (comp.dest === 'plaza') act = 'wander';
  const spotAct = act.replace('_free', '');
  c.plan = null;
  leaveSpot(c);
  if (comp.dest !== 'plaza') {
    // プレイヤーのそばの席を選ぶ
    const seats = ['eat', 'drink', 'sit'].includes(spotAct) ? (SPOTS[comp.dest]?.seat || []).filter((x) => !spotTaken(x, c)) : [];
    const pl = S.player;
    seats.sort((a, b) => Math.hypot(a[0] * TILE - pl.x, a[1] * TILE - pl.y) - Math.hypot(b[0] * TILE - pl.x, b[1] * TILE - pl.y));
    const t = seats[0] || targetTile(c, comp.dest, spotAct);
    c.spot = t; goTo(c, t[0], t[1]);
  }
  c.activity = spotAct;
  if (act === 'eat_free' || act === 'eat') {
    if (S.foodStock >= 1) {
      if (act === 'eat') c.coins -= D.MEAL_COST;
      S.foodStock -= 1; c.hunger = clamp(c.hunger + 55, 0, 100); payCooks(1);
    }
    c.busyUntil = S.t + 45;
  } else if (act === 'drink' || act === 'drink_free') {
    if (act === 'drink') c.coins -= D.DRINK_COST;
    c.busyUntil = S.t + 60;
  } else if (act === 'train') { c.str += 0.7 * (1 - c.str / 45); c.busyUntil = S.t + 60; }
  else c.busyUntil = S.t + 40;
}

// 住民が案内役になってプレイヤーを連れて行く
// 住民が先に立って案内する（プレイヤーが遅れたら待つ）。着いたら一緒に過ごす
export function startGuide(c, place) {
  startCompanion(c, place, false);
  c.companion.lead = true;
}

// ================= ルールAI =================
function decide(c) {
  const h = hour();
  const p = c.p;
  const st = c.intent?.stance || 'work';
  const job = JOBS[c.job];

  const tod = S.t % 1440;
  if (c.task && runTask(c, tod)) return;
  if (c.appointment && keepAppointment(c)) return;
  if (Wolf.patrolling(c)) { setPlan(c, { place: 'plaza', tile: randomOutdoorTile(S.rand, 10, 24, 52, 34), act: 'patrol' }); return; }
  if (tod >= (S.wolfKnown ? 21 : 21.5) * 60 || h < 6) { setPlan(c, { place: c.home, act: 'sleep' }); return; }
  // 人狼だと強く疑う相手に詰め寄る
  if (S.wolfKnown && p.aggression > 0.55 && chance(0.06)) {
    const top = Wolf.topSuspect(c);
    if (top && top.v >= 70 && !top.t.isPlayer && !isJailed(top.t)) {
      say(c, `${top.t.name}！ お前が人狼なんだろ！`);
      setPlan(c, { targetId: top.t.id, kind: chance(p.aggression) ? 'attack' : 'threaten', giveUpAt: S.t + 90 });
      return;
    }
  }
  if (c.hp < 35 && c.items.includes('elixir')) { useItem(c, 'elixir'); return; }

  if (c.job === 'guard' && S.wanted.size && c.hunger >= 35) {
    const targets = [...S.wanted].map(byId).filter((t) => t && t.alive && !isJailed(t) && t !== c);
    if (targets.length) {
      targets.sort((a, b) => distTiles(c, a) - distTiles(c, b));
      say(c, `${targets[0].isPlayer ? 'よそ者' : targets[0].name}、待て！`);
      setPlan(c, { targetId: targets[0].id, kind: 'arrest', giveUpAt: S.t + 180 });
      c.activity = 'follow'; c.busyUntil = S.t + 180;
      return;
    }
  }

  if (c.hunger < 45) {
    if (c.food > 0) { c.food--; c.hunger = clamp(c.hunger + 35, 0, 100); say(c, 'もぐもぐ'); c.busyUntil = S.t + 15; return; }
    if (c.coins >= D.MEAL_COST && S.foodStock >= 1 && facOpen('diner')) { setPlan(c, { place: 'diner', act: 'eat' }); return; }
    if (c.coins >= 3 && S.foodStock >= 1 && facOpen('market')) { setPlan(c, { place: 'market', act: 'buyfood' }); return; }
    if (c.hunger < 20 && facOpen('farm') && chance(0.6)) { setPlan(c, { place: 'farm', act: 'forage' }); return; }
    const crim = p.greed * 0.5 + (1 - p.honesty) * 0.6 + (c.hunger < 20 ? 0.3 : 0) + (st === 'scheme' ? 0.3 : 0);
    if (chance(crim * 0.3)) {
      const victim = pickVictim(c, (o) => o.coins >= 2 || o.food > 0);
      if (victim) { setPlan(c, { targetId: victim.id, kind: 'steal', giveUpAt: S.t + 90 }); return; }
    }
    if (chance(0.5 + p.sociability * 0.4)) {
      const friend = bestFriend(c, (o) => o.coins >= 3 || o.food > 0);
      if (friend) { setPlan(c, { targetId: friend.id, kind: 'beg', giveUpAt: S.t + 90 }); return; }
    }
    if (c.key && c.hunger < 25 && c.postsToday < 3 && chance(0.3)) Brain.postAbout(c, 'hungry');
  }

  if (c.hp < 50 && c.coins >= D.HEAL_COST && doctorAvailable() && c.job !== 'doctor' && h < 20) { setPlan(c, { place: 'clinic', act: 'heal' }); return; }

  const grudge = Object.entries(c.rel)
    .map(([id, r]) => ({ t: byId(id), r }))
    .filter((x) => x.t && x.t.alive && !isJailed(x.t) && x.r.like < -35 && x.r.fear < 60 && (x.t.hp > 35 || p.aggression > 0.75))
    .sort((a, b) => a.r.like - b.r.like)[0];
  const aggrBoost = st === 'aggressive' ? 0.35 : 0;
  if (grudge && chance((p.aggression + aggrBoost) * (-grudge.r.like / 100) * 0.35)) {
    say(c, pick(['おい、ちょっと来い', 'もう我慢できねえ', '覚悟しろ']));
    setPlan(c, { targetId: grudge.t.id, kind: 'attack', giveUpAt: S.t + 120 });
    return;
  }
  if (st === 'aggressive' && c.intent?.target && chance(0.08)) {
    const t = byId(c.intent.target);
    if (t && t.alive && !isJailed(t)) { setPlan(c, { targetId: t.id, kind: 'threaten', giveUpAt: S.t + 120 }); return; }
  }

  const m = S.meteor;
  if (m) {
    if (m.state === 'ground' && chance(0.25 + p.greed * 0.5 + (c.job === 'researcher' ? 0.6 : 0))) { setPlan(c, { place: 'meteor', act: 'pickup' }); return; }
    if (c.items.includes('meteor') && facOpen('lab') && h < 21) { setPlan(c, { place: 'lab', act: 'research' }); return; }
    if (m.state === 'held' && !c.items.includes('meteor') && (p.greed > 0.7 || c.job === 'researcher') && (1 - p.honesty) > 0.4 && chance(0.15)) {
      const h0 = byId(m.holder);
      if (h0 && h0.alive && !isJailed(h0)) { setPlan(c, { targetId: h0.id, kind: 'steal', giveUpAt: S.t + 120 }); return; }
    }
  }
  if (c.items.includes('bomb') && p.aggression > 0.55 && chance(0.06)) {
    const f = pick(FACILITIES.filter((f) => !f.home && f.kind !== 'field' && f.id !== JOBS[c.job]?.place && facOpen(f.id)));
    if (f) { setPlan(c, { place: f.id, act: 'bomb' }); return; }
  }
  if (c.items.includes('cursed') && chance(0.3)) {
    const t = pickVictim(c, () => true, true);
    if (t) { setPlan(c, { targetId: t.id, kind: 'giftCursed', giveUpAt: S.t + 120 }); return; }
  }

  if (st === 'peaceful' || chance(p.sociability * (1 - p.greed) * 0.3)) {
    const needy = S.chars.find((o) => o !== c && o.alive && !isJailed(o) && o.hunger < 30 && o.food === 0 && o.coins < 2 && rel(c, o).like > 10);
    if (needy && (c.food > 0 || c.coins >= 4)) { setPlan(c, { targetId: needy.id, kind: 'give', giveUpAt: S.t + 90 }); return; }
  }

  if (st === 'scheme' && chance(0.12 * (1 - p.honesty) + 0.03)) {
    const v = pickVictim(c, (o) => o.coins >= 4);
    if (v) { setPlan(c, { targetId: v.id, kind: 'steal', giveUpAt: S.t + 90 }); return; }
  }

  if (job.place && h >= job.from && h < job.to && facOpen(job.place)) {
    const lazy = st === 'scheme' ? 0.35 : st === 'peaceful' ? 0.12 : 0.05;
    if (!chance(lazy)) { setPlan(c, { place: job.place, act: 'work' }); return; }
  }

  // 余暇
  const pl = S.player;
  const plike = rel(c, pl).like;
  const greetOk = pl.alive && !isJailed(pl) && plike >= 25 && c.lastGreetDay !== day() && distTiles(c, pl) < 12 && canSee(c, pl);
  const opts = [
    ['tavern', 'drink', p.sociability * (c.coins >= 1 ? 1 : 0) * (h >= 17 ? 1.6 : 0.3)],
    ['training', 'train', p.aggression * (st === 'aggressive' ? 2 : 0.8)],
    ['plaza', 'wander', 0.6],
    ['street', 'wander', 0.35],
    ['board', 'board', c.key ? 0.3 : 0.1],
    ['chat', 'chat', p.sociability],
    ['player', 'greet', greetOk ? 0.6 : 0],
    ['player', 'approach', approachOk(c) ? 1.6 : 0],
    [c.home, 'rest', 0.35],
    ['diner', 'sit', c.hunger < 70 ? 0 : 0.1],
  ].filter((o) => o[2] > 0);
  const sum = opts.reduce((a, o) => a + o[2], 0);
  let r = S.rand() * sum;
  let choice = opts[0];
  for (const o of opts) { r -= o[2]; if (r <= 0) { choice = o; break; } }
  const [where, act] = choice;
  if (act === 'greet') { setPlan(c, { targetId: 'player', kind: 'greet', giveUpAt: S.t + 40 }); return; }
  if (act === 'approach') {
    const topic = Brain.approachTopic(c);
    if (topic) {
      c.approach = topic;
      S.nextApproachT = S.t + 35 + S.rand() * 40;
      setPlan(c, { targetId: 'player', kind: 'approach', giveUpAt: S.t + 60 });
      return;
    }
  }
  if (act === 'chat') {
    const f = bestFriend(c, (o) => !o.isPlayer) || pickVictim(c, (o) => !o.isPlayer, true);
    if (f) { setPlan(c, { targetId: f.id, kind: 'chat', giveUpAt: S.t + 60 }); return; }
  }
  if (where === 'plaza' || (where === 'tavern' && !facOpen('tavern'))) { setPlan(c, { place: 'plaza', tile: randomPlazaTile(S.rand), act: 'wander' }); return; }
  if (where === 'street') { setPlan(c, { place: 'plaza', tile: randomOutdoorTile(S.rand), act: 'wander' }); return; }
  if (where === 'board') {
    const [bx, by] = D.BOARD_POS;
    setPlan(c, { place: 'plaza', tile: [bx, by + 1], act: 'board' }); c.dir = 'up'; return;
  }
  setPlan(c, { place: where, act });
}

// 住民の方から話しかけに来るか
function approachOk(c) {
  const pl = S.player;
  if (!pl.alive || isJailed(pl) || S.t < (S.nextApproachT || 0) || pl.activity === 'sleep') return false;
  if (S.callout || distTiles(c, pl) > 16) return false;
  return true;
}

// ================= 頼みごと（会話で頼まれたことを実行する） =================
const charOf = (id) => (id === 'player' ? S.player : byId(id));

export function assignTask(c, task) {
  c.task = { ...task, since: S.t, told: [] };
  const t = charOf(task.targetId);
  const tn = t ? dispName(t) : '?';
  const until = Math.floor(S.t / 1440) * 1440 + (S.t % 1440 < 6 * 60 ? 6 * 60 : 30 * 60);
  if (task.type === 'watch') c.task.until = until;
  const msg = { report: `${c.name}が詰所へ${tn}のことを伝えに行く`, spread: `${c.name}が${tn}の噂をみんなに広めてくれる`,
    watch: `${c.name}が今夜${tn}の家を見張ってくれる（朝に報告）`, attack: `${c.name}が${tn}を懲らしめに行った` }[task.type];
  Wolf.addNote(msg);
  if (c.companion) endCompanion(c, false, true);
  c.busyUntil = Math.min(c.busyUntil, S.t + 3);
  return msg;
}

function finishTask(c, text) {
  c.task = null;
  pushDone(c, text);
}

function pushDone(c, text) {
  if (!text) return;
  c.taskDone = c.taskDone ? { text: c.taskDone.text + text, t: S.t } : { text, t: S.t };
}

function runTask(c, tod) {
  const task = c.task;
  const t = charOf(task.targetId);
  const night = tod >= 21 * 60 || tod < 6 * 60;
  if (!t || !t.alive) { finishTask(c, Brain.taskLine(c, 'gone', t)); return false; }
  switch (task.type) {
    case 'report':
      if (night) return false;
      if (c.job === 'guard' && !c.isWolf) { doReport(c); return false; }
      setPlan(c, { place: 'guard', act: 'report' });
      return true;
    case 'spread': {
      if (night) return false;
      if (task.told.length >= 3) { finishTask(c, Brain.taskLine(c, 'spread', t)); return false; }
      const others = residents().filter((o) => o.alive && o !== c && o !== t && !isJailed(o) && !task.told.includes(o.id) && !(o.inBed));
      if (!others.length) { finishTask(c, Brain.taskLine(c, 'spread', t)); return false; }
      others.sort((a, b) => distTiles(c, a) - distTiles(c, b));
      setPlan(c, { targetId: others[0].id, kind: 'spread', giveUpAt: S.t + 90 });
      return true;
    }
    case 'attack':
      if (night) return false;
      c.task = null;
      say(c, `${dispName(t)}、ちょっと面貸せ！`);
      setPlan(c, { targetId: t.id, kind: 'attack', giveUpAt: S.t + 120 });
      pushDone(c, Brain.taskLine(c, 'attack', t));
      return true;
    case 'watch': {
      if (S.t >= task.until) { finishWatch(c, t); return false; }
      if (!night) return false;
      if (c.isWolf) return false; // 人狼は見張るふりをするだけ
      const f = FAC[t.home];
      const tile = [f.door[0] + (S.rand() < 0.5 ? -1 : 1), f.door[1] + 2];
      setPlan(c, { place: 'plaza', tile, act: 'watch' });
      return true;
    }
  }
  return false;
}

function doReport(c) {
  const task = c.task;
  const t = charOf(task.targetId);
  c.task = null;
  if (!t || !t.alive) return;
  const guards = residents().filter((g) => g.alive && g.job === 'guard' && !isJailed(g));
  const credible = guards.length && guards.some((g) => rel(g, c).like > -20);
  if (credible) {
    S.wanted.add(t.id);
    log(`${c.name}が${dispName(t)}のことを詰所に通報した。${dispName(t)}は手配された。`, 'event');
    memo(c, `${dispName(t)}のことを詰所に通報した`, 'info');
    if (S.wolfKnown) for (const g of guards) Wolf.addSus(g, t.id, 15, `${c.name}から通報があった`);
    pushDone(c, Brain.taskLine(c, 'report', t));
    if (t.isPlayer) toast('🚨 あなたが通報され、手配された！');
  } else pushDone(c, Brain.taskLine(c, 'reportFail', t));
}

function finishWatch(c, t) {
  const saw = (c.recent || []).find((e) => e.kind === 'night' && e.t >= c.task.since && e.text.includes(t.name));
  if (saw) { finishTask(c, Brain.taskLine(c, 'watchSaw', t, saw.text)); Wolf.addSus(c, t.id, 20, saw.text.replace(/^夜中に/, '夜中に')); }
  else if (c.isWolf) finishTask(c, Brain.taskLine(c, 'watchNone', t));
  else finishTask(c, Brain.taskLine(c, 'watchNone', t));
}

// 待ち合わせ
function keepAppointment(c) {
  const a = c.appointment;
  if (S.t > a.at + 70) {
    c.appointment = null;
    addLike(c, S.player, -8);
    memo(c, `よそ者に${placeName(a.place)}での待ち合わせをすっぽかされた`, 'info');
    pushDone(c, Brain.taskLine(c, 'stoodUp', null, placeName(a.place)));
    return false;
  }
  if (S.t < a.at - 40) return false;
  if (a.place === 'plaza') setPlan(c, { place: 'plaza', tile: randomPlazaTile(S.rand), act: 'wait' });
  else setPlan(c, { place: a.place, act: 'wait' });
  return true;
}

// 近くの住民が、手を止めて話しかけに来る
function tryApproach() {
  const pl = S.player;
  const cands = residents().filter((c) => c.alive && !isJailed(c) && !c.inBed && !c.hunt && !c.companion && c.activity !== 'meeting'
    && c.activity !== 'sleep' && S.holdId !== c.id && distTiles(c, pl) < 22 && approachOk(c));
  if (!cands.length) return;
  const c = cands.find((x) => x.taskDone) || pick(cands);
  const topic = Brain.approachTopic(c);
  if (!topic) return;
  c.approach = topic;
  S.nextApproachT = S.t + 45 + S.rand() * 45;
  leaveSpot(c);
  c.busyUntil = 0; c.activity = null;
  setPlan(c, { targetId: 'player', kind: 'approach', giveUpAt: S.t + 60 });
}

// すれ違いざまのひとこと
function maybeRemark(c) {
  const pl = S.player;
  if (S.t < (c.nextRemarkT || 0) || c.moving && chance(0.5)) return;
  if (!pl.alive || distTiles(c, pl) > 2.4 || c.inBed || isJailed(c) || c.hunt || !canSee(c, pl)) return;
  c.nextRemarkT = S.t + 60 + S.rand() * 60;
  if (!chance(0.55)) return;
  const line = Brain.remarkLine(c);
  if (line) say(c, line, 3.5);
}

function nearby(c, maxTiles, filter = () => true) {
  return S.chars.filter((o) => o !== c && o.alive && !isJailed(o) && distTiles(c, o) <= maxTiles && canSee(c, o) && filter(o));
}

function pickVictim(c, filter, anyone = false) {
  const cands = S.chars.filter((o) => o !== c && o.alive && !isJailed(o) && !o.companion && filter(o) && distTiles(c, o) < 20);
  if (!cands.length) return null;
  cands.sort((a, b) => (rel(c, a).like - rel(c, b).like) + (distTiles(c, a) - distTiles(c, b)) * 2);
  return anyone ? pick(cands.slice(0, 5)) : cands[0];
}

function bestFriend(c, filter) {
  const cands = S.chars.filter((o) => o !== c && o.alive && !isJailed(o) && !o.companion && filter(o) && rel(c, o).like > 15 && distTiles(c, o) < 22);
  if (!cands.length) return null;
  cands.sort((a, b) => rel(c, b).like - rel(c, a).like);
  return pick(cands.slice(0, 3));
}

function doctorAvailable() {
  return facOpen('clinic') && S.chars.some((c) => c.alive && c.job === 'doctor' && !isJailed(c));
}

// ================= 施設での行動 =================
function startActivity(c, plan) {
  const act = plan.act;
  c.activity = act;
  if (c.guiding) {
    say(c, Brain.arriveLine(c, c.guiding.place));
    c.guiding = null;
  }
  switch (act) {
    case 'sleep': c.busyUntil = nextMorning(); break;
    case 'work': {
      const job = JOBS[c.job];
      const end = Math.floor(S.t / 1440) * 1440 + job.to * 60;
      c.busyUntil = Math.min(S.t + 120, Math.max(end, S.t + 30));
      c.nextFidget = S.t + 10 + S.rand() * 20;
      break;
    }
    case 'eat':
      if (c.coins >= D.MEAL_COST && S.foodStock >= 1 && facOpen('diner')) {
        c.coins -= D.MEAL_COST; S.foodStock -= 1; c.hunger = clamp(c.hunger + 55, 0, 100);
        payCooks(1); c.busyUntil = S.t + 35;
      } else { say(c, '食堂が……'); c.busyUntil = S.t + 10; }
      break;
    case 'heal':
      if (c.coins >= D.HEAL_COST && doctorAvailable()) { c.coins -= D.HEAL_COST; c.hp = clamp(c.hp + 45, 0, 100); payDoctor(2); }
      c.busyUntil = S.t + 40; break;
    case 'train': c.str += 0.7 * (1 - c.str / 45); c.busyUntil = S.t + 60; break;
    case 'drink':
      if (c.coins >= D.DRINK_COST && facOpen('tavern')) {
        c.coins -= D.DRINK_COST;
        for (const o of nearby(c, 4, (o) => o.activity === 'drink')) { addLike(c, o, 3); addLike(o, c, 3); shareRumor(c, o); }
        say(c, pick(['ぷはー！', 'もう一杯！', 'うまい！']));
      }
      c.busyUntil = S.t + 60; break;
    case 'buyfood':
      if (c.coins >= 3 && S.foodStock >= 1) { c.coins -= 3; S.foodStock -= 1; c.food++; }
      c.busyUntil = S.t + 15; break;
    case 'forage': {
      c.hunger = clamp(c.hunger + 30, 0, 100);
      S.foodStock = Math.max(0, S.foodStock - 1);
      say(c, '……少しだけ、もらうよ');
      const ws = witnesses(c, [c]).filter((w) => w.job === 'farmer');
      if (ws.length && chance(0.5)) { for (const w of ws) { addLike(w, c, -6); memo(w, `${dispName(c)}が畑の作物をかじっていたのを見た`); } }
      c.busyUntil = S.t + 20; break;
    }
    case 'wander': c.busyUntil = S.t + 15 + S.rand() * 30; break;
    case 'rest': c.busyUntil = S.t + 40 + S.rand() * 30; break;
    case 'sit': case 'visit': c.busyUntil = S.t + 30 + S.rand() * 20; break;
    case 'meeting': c.busyUntil = Math.max(S.t, S.meeting?.at || S.t) + 150; c.dir = c.y > FOUNTAIN_Y ? 'up' : 'down'; break;
    case 'patrol': c.busyUntil = S.t + 15 + S.rand() * 15; break;
    case 'report': doReport(c); c.busyUntil = S.t + 15; break;
    case 'watch': c.busyUntil = S.t + 30; break;
    case 'wait': c.busyUntil = (c.appointment?.at || S.t) + 70; say(c, 'まだかな……'); break;
    case 'board': {
      c.busyUntil = S.t + 20; c.dir = 'up';
      const latest = S.board.find((p) => p.authorId === 'player' && !p.replies.some((r) => r.author === c.name) && S.t - p.postedT < 600);
      if (latest && c.key && chance(0.6)) Brain.replyTo(c, latest);
      break;
    }
    case 'pickup': {
      const m = S.meteor;
      if (m && m.state === 'ground' && distTiles(c, { x: m.tx * TILE + 16, y: m.ty * TILE + 16 }) < 1.5) {
        m.state = 'held'; m.holder = c.id; c.items.push('meteor');
        say(c, '光る石、いただき！');
        log(`${c.name}が光る石を拾った。`, 'event');
        if (c.key && chance(0.5)) Brain.postAbout(c, 'meteor');
      }
      c.busyUntil = S.t + 10; break;
    }
    case 'research': {
      const m = S.meteor;
      if (m && c.items.includes('meteor') && facOpen('lab')) { m.state = 'researching'; m.holder = c.id; c.busyUntil = S.t + 120; }
      else c.busyUntil = S.t + 10;
      break;
    }
    case 'bomb': bombFacility(c, plan.place); c.busyUntil = S.t + 20; break;
    default: c.busyUntil = S.t + 20;
  }
  // 夜の遊びは21時半で切り上げて帰る
  const bed = Math.floor(S.t / 1440) * 1440 + 21.5 * 60;
  if (!['sleep', 'work', 'meeting', 'patrol', 'watch'].includes(act) && !c.companion) c.busyUntil = Math.min(c.busyUntil, Math.max(bed, S.t + 5));
}

function payCooks(n) {
  const cooks = S.chars.filter((o) => o.alive && o.job === 'cook');
  if (cooks.length) pick(cooks).coins += n;
}
function payDoctor(n) {
  const d = S.chars.find((o) => o.alive && o.job === 'doctor');
  if (d) d.coins += n;
}

// ================= 人との行動 =================
const WHAT = {
  attack: ['殴られた', '殴りかかる'],
  steal: ['盗まれた', '盗みを働く'],
  threaten: ['脅された', '脅しをかける'],
};

export function interact(a, b, kind) {
  a.lastChatAt = S.t;
  switch (kind) {
    case 'chat': {
      const rumor = pickRumor(a, b);
      const [la, lb] = Wolf.chatLines(a, b) || Brain.npcDialogue(a, b, rumor);
      say(a, la);
      faceTo(b, a);
      setTimeout(() => b.alive && say(b, lb), 1400);
      addLike(a, b, 2 + a.p.sociability * 3); addLike(b, a, 2 + b.p.sociability * 2);
      shareRumor(a, b);
      a.busyUntil = S.t + 20; if (!b.isPlayer && S.t >= b.busyUntil && !b.companion) b.busyUntil = S.t + 20;
      break;
    }
    case 'wolfArrest': Wolf.arrestSuspect(a, b); a.busyUntil = S.t + 20; break;
    case 'spread': {
      const task = a.task;
      if (!task || task.type !== 'spread') break;
      const t = charOf(task.targetId);
      task.told.push(b.id);
      if (!t) break;
      say(a, `ねえ、${dispName(t)}のこと聞いた？ ${task.what}らしいよ。`, 5);
      const tr = Wolf.trust(b, a.id);
      setTimeout(() => b.alive && say(b, tr >= 0.6 ? 'えっ、本当に……？' : 'ふうん……本当かな。'), 1400);
      addLike(b, t, -10 * tr);
      memo(b, `${a.name}から、${dispName(t)}が${task.what}と聞いた`, 'info');
      if (S.wolfKnown) Wolf.addSus(b, t.id, 15 * tr, `${a.name}から${dispName(t)}が怪しいと聞いた`);
      a.busyUntil = S.t + 15;
      break;
    }
    case 'approach': {
      const tp = a.approach;
      a.approach = null;
      if (!tp || !b.isPlayer) break;
      a.lastGreetDay = day();
      say(a, tp.line, 8);
      a.chatLog.push({ who: 'them', text: tp.line });
      if (tp.pending) a.pending = { ...tp.pending, t: S.t };
      S.callout = { id: a.id, text: tp.line, until: performance.now() + 10000 };
      a.busyUntil = S.t + 25; a.activity = 'wait';
      if (tp.note) Wolf.addNote(tp.note);
      break;
    }
    case 'greet':
      a.lastGreetDay = day();
      say(a, Brain.greetPlayer(a), 5);
      a.busyUntil = S.t + 10;
      break;
    case 'give': giveSomething(a, b); a.busyUntil = S.t + 15; break;
    case 'beg': {
      const r = rel(b, a);
      const kind_ = b.p.sociability * (1 - b.p.greed);
      say(a, pick(['少し分けてくれないか……', '頼む、何か食べ物を…']));
      if (!b.isPlayer && (r.like > 40 || (r.like > 10 && chance(kind_)) || r.fear > 50)) {
        setTimeout(() => giveSomething(b, a), 800);
      } else if (!b.isPlayer) {
        setTimeout(() => say(b, pick(['悪いな、無理だ', '自分でなんとかしな'])), 800);
        addLike(a, b, -3);
      }
      a.busyUntil = S.t + 15; break;
    }
    case 'steal': doSteal(a, b); a.busyUntil = S.t + 15; break;
    case 'attack': doAttack(a, b); a.busyUntil = S.t + 20; break;
    case 'threaten': doThreaten(a, b); a.busyUntil = S.t + 15; break;
    case 'arrest': doArrest(a, b); a.busyUntil = S.t + 20; break;
    case 'giftCursed': {
      removeItem(a, 'cursed'); b.items.push('cursed');
      say(a, 'これ、きれいな石だろ？ あげるよ');
      addLike(b, a, 5);
      if (b.isPlayer) toast(`${a.name}から石をもらった……なんだか嫌な感じがする。`);
      a.busyUntil = S.t + 10; break;
    }
  }
}

// プレイヤーが住民に渡す。g = { coins } | { item: 'food' | アイテム名 }
export function giveToNpc(t, g) {
  const p = S.player;
  const r = rel(t, p);
  let label, react = 'good', like = 0;
  if (g.coins) {
    const n = Math.min(g.coins, Math.floor(p.coins));
    if (n <= 0) return { react: 'none' };
    p.coins -= n; t.coins += n; label = `${n}G`;
    like = Math.min(25, n * (t.p.greed > 0.6 ? 5 : 3.5));
    if (n >= 5) react = 'big';
    if (Brain.bribeWorks(t, n)) { S.wanted.delete('player'); S.stats.bribes++; react = 'bribe'; toast('衛兵が見逃してくれることになった。'); }
  } else if (g.item === 'food') {
    if (p.food < 1) return { react: 'none' };
    p.food--; t.food++; label = '食べ物';
    like = t.hunger < 40 ? 18 : 7;
    if (t.hunger < 40) react = 'hungry';
    if (t.hunger < 60) { t.food--; t.hunger = clamp(t.hunger + 35, 0, 100); }
  } else {
    const it = g.item;
    if (!p.items.includes(it)) return { react: 'none' };
    removeItem(p, it); t.items.push(it); label = ITEMS[it].name;
    if (it === t.likesItem) { like = 22; react = 'love'; }
    else if (it === 'cursed') { like = 5; react = 'cursed'; }
    else if (it === 'meteor') { like = 12; S.meteor.holder = t.id; S.meteor.state = 'held'; }
    else like = ITEMS[it].gift ? 8 : 12;
  }
  if (t.quest && (g.item === t.quest.item) && S.t < t.quest.until) {
    const n = t.quest.reward;
    const pay = Math.min(n, Math.floor(t.coins));
    t.coins -= pay; p.coins += pay;
    like += 10; react = 'quest'; label = `${label}`;
    toast(`✅ 頼まれごと達成！ ${t.name}から${pay}Gもらった`);
    floatText(p, `+${pay}G`);
    Wolf.addNote(`${t.name}の頼みごと（${ITEMS[t.quest.item]?.name || '食べ物'}）を果たした`);
    t.quest = null;
  }
  if (t.giftDay !== day()) { t.giftDay = day(); t.giftCount = 0; }
  like *= Math.pow(0.6, t.giftCount++);
  if (r.like < -20 && !['love', 'bribe', 'hungry'].includes(react)) react = 'suspicious';
  addLike(t, p, like);
  t.favor = (t.favor || 0) + like / 10;
  t.lastGift = { label, t: S.t };
  memo(t, `よそ者から${label}をもらった`, 'gift');
  for (const w of witnesses(p, [p, t])) addLike(w, p, 2);
  floatText(t, '♥'.repeat(like >= 15 ? 3 : like >= 7 ? 2 : 1), '#ff8aa8');
  return { react, label, like };
}

function giveSomething(a, b) {
  if (!a.alive || !b.alive) return;
  if (a.food > 0) { a.food--; b.food++; say(a, 'ほら、これ食べな'); }
  else if (a.coins >= 2) { const n = a.coins >= 6 ? 2 : 1; a.coins -= n; b.coins += n; say(a, `${n}Gあげるよ`); }
  else return;
  addLike(b, a, 15); memo(b, `${a.isPlayer ? 'よそ者' : a.name}に助けてもらった`, 'gift');
  for (const w of witnesses(a, [a, b])) addLike(w, a, 3);
  if (b.isPlayer) toast(`${a.name}が施しをくれた！`);
}

function witnesses(at, exclude) {
  return S.chars.filter((o) => !exclude.includes(o) && isAwake(o) && distTiles(at, o) <= 7 && canSee(at, o));
}

function dispName(c) { return c.isPlayer ? 'よそ者' : c.name; }

function crime(actor, victim, type, noticed) {
  S.stats.crimes++; S.today.crimes++;
  const ws = witnesses(actor, [actor, victim]);
  const [vText, wText] = WHAT[type];
  const actorN = dispName(actor);
  if (noticed) {
    addLike(victim, actor, type === 'attack' ? -40 : -30);
    memo(victim, `${actorN}に${vText}`, 'crime');
  }
  if (victim.companion) endCompanion(victim, false);
  for (const w of ws) {
    addLike(w, actor, type === 'attack' ? -18 : -12);
    if (type === 'attack') addFear(w, actor, 6);
    memo(w, `${actorN}が${dispName(victim)}に${wText}のを見た`, 'crime');
    if (w.key && w.postsToday < 4 && chance(0.25)) Brain.postAbout(w, 'witness', { actor: actorN, victim: dispName(victim), what2: wText });
  }
  Wolf.onCrime(actor, ws);
  const reported = ws.some((w) => w.job === 'guard') || (ws.length > 0 && chance(0.6)) || (noticed && victim.p.honesty > 0.5 && chance(0.5));
  if (reported) S.wanted.add(actor.id);
  if (noticed && victim.key && victim.postsToday < 4 && chance(0.55)) Brain.postAbout(victim, 'victim', { actor: actorN, what: vText });
  const seen = ws.length ? `（目撃者${ws.length}人）` : '';
  if (noticed || ws.length || actor.isPlayer || victim.isPlayer) log(`${actorN}が${dispName(victim)}に${wText}。${seen}`, 'crime');
  return ws;
}

function doSteal(a, b) {
  const sleeping = b.activity === 'sleep';
  const success = chance(sleeping ? 0.85 : 0.55 + (a.isPlayer ? 0.1 : 0));
  let got = '';
  if (success) {
    if (b.items.includes('meteor') && chance(0.6)) { removeItem(b, 'meteor'); a.items.push('meteor'); S.meteor.holder = a.id; S.meteor.state = 'held'; got = '光る石'; }
    else if (b.coins >= 1) { const n = Math.min(Math.floor(b.coins), 3 + Math.floor(S.rand() * 2)); b.coins -= n; a.coins += n; got = `${n}G`; }
    else if (b.food > 0) { b.food--; a.food++; got = '食料'; }
  }
  S.stats.thefts++;
  const noticed = !success || chance(0.4);
  if (a.isPlayer) toast(success ? (got ? `${dispName(b)}から${got}を盗んだ。` : '何も持っていなかった。') : `失敗！ ${b.name}に気づかれた！`);
  if (b.isPlayer && noticed) toast(`${a.name}に${success ? got + 'を盗まれた！' : '財布を狙われた！'}`);
  if (!success && !b.isPlayer) say(b, pick(['泥棒！', 'おい、何してる！']));
  crime(a, b, 'steal', noticed);
}

function power(c) { return c.str + (c.items.includes('weapon') ? 8 : 0) + (c.hp < 40 ? -4 : 0); }

function doAttack(a, b) {
  S.stats.fights++;
  faceTo(a, b);
  const hit = power(a) + S.rand() * 10 > power(b) * 0.7 + S.rand() * 10;
  if (hit) {
    const dmg = 5 + Math.round(power(a) * 0.4 + S.rand() * 6);
    b.hp -= dmg;
    b.hurtUntil = performance.now() + 300;
    say(a, pick(['オラァ！', 'くらえ！', 'これでも食らえ！']));
    setTimeout(() => b.alive && say(b, pick(['ぐはっ', 'いってえ！', 'うっ…'])), 500);
    addFear(b, a, 10 + Math.max(0, power(a) - power(b)));
    S.effects.push({ type: 'hit', x: b.x, y: b.y, t: 0.5 });
  } else {
    say(a, 'ちっ、外した！');
    say(b, 'なにすんだ！');
  }
  if (a.isPlayer) toast(hit ? `${b.name}を殴った！` : `${b.name}にかわされた！`);
  if (b.isPlayer) toast(hit ? `${a.name}に殴られた！` : `${a.name}が殴りかかってきた！`);
  crime(a, b, 'attack', true);
  if (b.hp <= 0) die(b, `${dispName(a)}の暴力`);
  else if (!b.isPlayer && b.p.aggression > 0.5 && chance(b.p.aggression) && isAwake(b)) {
    b.plan = null; b.path = [];
    setTimeout(() => { if (b.alive && a.alive && distTiles(a, b) < 2.5 && !isJailed(b)) doAttack(b, a); }, 900);
  } else if (!b.isPlayer && isAwake(b)) {
    b.busyUntil = 0; b.plan = null;
    setPlan(b, { place: b.home, act: 'rest' });
  }
}

function doThreaten(a, b) {
  const ok = power(a) + (a.items.includes('bomb') ? 30 : 0) + S.rand() * 8 > power(b) * 1.15 + S.rand() * 8;
  faceTo(a, b);
  say(a, pick(['金を出せ。痛い目に遭いたくなければな', '分かってるよな？']));
  if (ok) {
    const n = Math.floor(b.coins / 2);
    b.coins -= n; a.coins += n;
    addFear(b, a, 25);
    setTimeout(() => say(b, n ? `わ、わかった…${n}Gだ` : '何も持ってないんだ…'), 700);
    if (a.isPlayer) toast(n ? `${b.name}から${n}G巻き上げた。` : `${b.name}は無一文だった。`);
    if (b.isPlayer) toast(`${a.name}に脅されて${n}G取られた…`);
  } else {
    setTimeout(() => say(b, 'ふざけるな！'), 700);
    if (a.isPlayer) toast(`${b.name}はひるまなかった。`);
    addLike(b, a, -10);
  }
  crime(a, b, 'threaten', true);
}

export function jail(t, minutes) {
  t.jailedUntil = S.t + minutes; t.plan = null; t.path = []; t.activity = 'jail'; t.inBed = false;
  if (t.companion) endCompanion(t, false, true);
  for (const o of S.chars) if (o.companion && t.isPlayer) endCompanion(o, false, true);
  const cell = freeSpot(t, SPOTS.guard.cell) || SPOTS.guard.cell[0];
  t.spot = cell;
  t.x = cell[0] * TILE + TILE / 2; t.y = cell[1] * TILE + TILE / 2; t.dir = 'down';
}

function doArrest(g, t) {
  if (!S.wanted.has(t.id)) return;
  if (!t.isPlayer && t.coins >= 5 && g.p.greed > 0.6 && g.p.honesty < 0.5 && chance(0.5)) {
    t.coins -= 5; g.coins += 5; S.wanted.delete(t.id); S.stats.bribes++;
    say(g, '……今回だけだぞ');
    log('どこかで袖の下が渡されたらしい……', 'crime');
    return;
  }
  const ok = power(g) + S.rand() * 12 > power(t) * 0.8 + S.rand() * 12;
  if (ok) {
    S.wanted.delete(t.id); S.stats.arrests++;
    jail(t, 8 * 60);
    say(g, '御用だ！');
    addLike(t, g, -20);
    memo(t, `${g.name}に捕まった`, 'crime');
    log(`衛兵の${g.name}が${dispName(t)}を捕まえた。`, 'event');
    if (t.isPlayer) toast('捕まった！ 8時間、牢屋に入れられる…');
  } else {
    say(g, 'くそ、逃げられた！'); say(t, 'へへっ');
    if (t.isPlayer) toast(`${g.name}の手を振りほどいた！`);
  }
}

function pickRumor(a) {
  const crimes = a.memory.filter((m) => m.includes('のを見た') || m.includes('された'));
  if (!crimes.length || !chance(0.6)) return null;
  const m = pick(crimes).replace(/^\d+日目 /, '');
  return m.replace(/のを見た$/, '').replace(/に(.+)された$/, 'が$1');
}

function shareRumor(a, b) {
  for (const m of a.memory) {
    const name = m.match(/^\d+日目 (.+?)(が|に)/)?.[1];
    if (!name) continue;
    const t = name === 'よそ者' ? S.player : S.chars.find((x) => x.name === name);
    if (!t || t === b || t === a) continue;
    if (m.includes('のを見た') || m.includes('された')) addLike(b, t, -3 * clamp((rel(b, a).like + 50) / 100, 0.2, 1));
  }
}

function removeItem(c, item) { const i = c.items.indexOf(item); if (i >= 0) c.items.splice(i, 1); }

// ================= 生死 =================
export function die(c, cause, opts = {}) {
  if (!c.alive) return;
  c.alive = false; c.hp = 0; c.path = []; c.plan = null; c.companion = null;
  S.stats.deaths++; S.today.deaths++;
  S.wanted.delete(c.id);
  const [tx, ty] = tilePos(c);
  const f = facAt(tx, ty);
  if (f && f.kind !== 'field') { c.gx = f.door[0] * TILE + 16; c.gy = (f.door[1] + 1) * TILE + 16; } else { c.gx = c.x; c.gy = c.y; }
  if (c.items.includes('meteor') && S.meteor) {
    const n = nearestWalkable(Math.floor(c.gx / TILE), Math.floor(c.gy / TILE));
    S.meteor.state = 'ground'; S.meteor.tx = n[0]; S.meteor.ty = n[1]; S.meteor.holder = null;
  }
  c.items = [];
  if (c.isWolf) Wolf.reveal('death');
  if (opts.silent) return;
  log(`${dispName(c)}が亡くなった（${cause}）。`, 'death');
  if (c.isPlayer) { S.over = true; S.gameOverReason = `あなたは${cause}で倒れた。`; return; }
  post('町役場', `【訃報】${c.name}さんが亡くなりました（${cause}）。`, { authorId: 'town' });
  const mourner = residents().filter((o) => o.alive && o.key && rel(o, c).like > 20);
  if (mourner.length) Brain.postAbout(pick(mourner), 'death', { name: c.name });
  for (const o of residents()) if (o.alive) memo(o, `${c.name}が${cause}で亡くなった`, 'crime');
}

// ================= イベント =================
function meteorFall() {
  const [tx, ty] = randomOutdoorTile(S.rand, 3, 10, 50, 25);
  S.meteor = { tx, ty, state: 'ground', holder: null, progress: 0, result: null };
  S.effects.push({ type: 'meteor', tx, ty, t: 2.4 });
  S.effects.push({ type: 'flash', t: 2.4, after: 0.9 });
  S.effects.push({ type: 'shake', t: 2.4, after: 1.0 });
  S.banner = { title: '☄️ 隕石が落ちてきた！', text: '町のどこかに「光る石」が転がっている（画面のはしの矢印・地図の点滅を見よう）。拾って研究所で調べると正体がわかる。住民たちも狙っている！', until: performance.now() + 9000 };
  log('空から光る石が落ちてきた！', 'event');
  post('町役場', '【速報】町に隕石が落下しました。未知の物質が見つかったとの情報があります。', { authorId: 'town' });
  toast('☄️ 隕石が落ちてきた！ 光る石が転がっている…（ミニマップ参照）');
  const keys = residents().filter((c) => c.alive && c.key);
  keys.filter(() => chance(0.4)).slice(0, 2).forEach((c, i) => setTimeout(() => Brain.postAbout(c, 'meteor'), 1500 + i * 1000));
}

function finishResearch(c) {
  const m = S.meteor;
  const researcher = S.chars.find((o) => o.alive && o.job === 'researcher') || c;
  const judge = researcher.p;
  const score = (judge.honesty - judge.aggression) * 0.6 + (c.p.honesty - c.p.aggression) * 0.4 + (S.rand() - 0.5) * 0.8;
  m.result = score > 0.2 ? 'elixir' : score < -0.1 ? 'bomb' : 'cursed';
  m.state = 'done';
  removeItem(c, 'meteor');
  c.items.push(m.result);
  c.activity = null; c.busyUntil = S.t;
  const name = ITEMS[m.result].name;
  log(`光る石の研究が終わった。正体は「${name}」だった！（${dispName(c)}が所持）`, 'event');
  post('町役場', `研究所の発表：落下した物質の正体は「${name}」と判明しました。`, { authorId: 'town' });
  if (c.isPlayer) toast(`🔬 研究完了！ 光る石は「${name}」だった！`);
  S.banner = { title: `🔬 光る石の正体は「${name}」！`, text: `${ITEMS[m.result].desc}（いま${dispName(c)}が持っている）`, until: performance.now() + 7000 };
  const keys = residents().filter((o) => o.alive && o.key && o !== c);
  if (keys.length) Brain.postAbout(pick(keys), 'meteorDone', { result: name });
}

function bombFacility(c, fid) {
  if (!c.items.includes('bomb')) return;
  removeItem(c, 'bomb');
  S.fac[fid].closedUntilDay = day() + 2;
  S.effects.push({ type: 'flash', t: 0.8, color: '255,120,40' });
  S.stats.crimes++; S.today.crimes++;
  const f = FAC[fid];
  for (const o of S.chars) {
    if (!o.alive || o === c) continue;
    const [ox, oy] = tilePos(o);
    const inside = facAt(ox, oy) === f;
    if (inside || distTiles(o, { x: f.door[0] * TILE + 16, y: f.door[1] * TILE + 16 }) < 3) { o.hp -= 25; if (o.hp <= 0) die(o, '爆発'); }
  }
  const ws = witnesses(c, [c]);
  for (const w of ws) { addLike(w, c, -40); addFear(w, c, 30); memo(w, `${dispName(c)}が${f.name}を爆破したのを見た`, 'crime'); }
  if (ws.length) S.wanted.add(c.id);
  for (const o of residents()) if (o.alive) addFear(o, c, ws.length ? 10 : 0);
  log(`💥 ${f.name}が爆破された！${ws.length ? `犯人は${dispName(c)}だ！` : '犯人は分からない。'}`, 'crime');
  post('町役場', `【緊急】${f.name}で爆発が発生。しばらく使用できません。`, { authorId: 'town' });
  if (!c.isPlayer) toast(`💥 ${f.name}が爆破された！`);
}

export function useItem(c, item) {
  if (!c.items.includes(item)) return;
  if (item === 'elixir') { removeItem(c, 'elixir'); c.hp = 100; c.hunger = Math.max(c.hunger, 60); say(c, '力がみなぎる！'); if (c.isPlayer) toast('🧪 万能薬を使った。体力が全回復！'); }
}

// ================= 影響力 =================
export function influence(id) {
  const others = S.chars.filter((o) => o.alive && o.id !== id && !o.isPlayer);
  let sup = 0, fear = 0, any = 0;
  for (const o of others) {
    const r = o.rel[id] || { like: 0, fear: 0 };
    const s = r.like >= 50, f = r.fear >= 50;
    if (s) sup++; if (f) fear++; if (s || f) any++;
  }
  return { sup, fear, any, total: others.length, ratio: others.length ? any / others.length : 0 };
}

export function titleFor(inf) {
  if (inf.ratio >= 0.8) return inf.fear > inf.sup ? '恐怖の支配者' : '町の英雄';
  if (inf.ratio >= 0.5) return inf.fear > inf.sup ? '町の顔役（恐）' : '町の顔役';
  if (inf.ratio >= 0.25) return '知られた顔';
  return 'よそ者';
}

// ================= プレイヤーの行動 =================
export function playerBusy() { const p = S.player; return !p.alive || isJailed(p) || S.t < p.busyUntil; }

function playerSpend(n) {
  if (S.player.coins < n) { toast(`お金が足りない（${n}G必要）`); return false; }
  S.player.coins -= n; return true;
}

// プレイヤーを近くの空いている席・ベッドへ
function seatPlayer(list, bed = false) {
  const p = S.player;
  const free = (list || []).filter((t) => !spotTaken(t, p)).sort((a, b) =>
    Math.hypot(a[0] * TILE + 16 - p.x, a[1] * TILE + 16 - p.y) - Math.hypot(b[0] * TILE + 16 - p.x, b[1] * TILE + 16 - p.y));
  const t = free[0];
  if (!t) return false;
  p.x = t[0] * TILE + 16; p.y = t[1] * TILE + 16; p.spot = t;
  if (bed) p.inBed = true; else faceFurniture(p);
  return true;
}

function bossIn(fid, jid) {
  const f = FAC[fid];
  return S.chars.find((o) => o.alive && !o.isPlayer && o.job === jid && isAwake(o) && facAt(...tilePos(o)) === f) || null;
}

function payJob(job, n) { const w = S.chars.filter((o) => o.alive && o.job === job); if (w.length) pick(w).coins += n; }

// 住民に雇ってもらう（会話でもメニューでも）
export function hirePlayer(boss) {
  const p = S.player;
  const r = rel(boss, p);
  const j = JOBS[boss.job];
  if (r.like < -10) { say(boss, 'お前を雇う気はない。'); toast(`${boss.name}に断られた（好感度が低い）`); return false; }
  p.job = boss.job;
  say(boss, `よし、今日から${j.name}の仲間だ！`);
  toast(`${j.icon} ${j.name}になった！ ${placeName(j.place)}で「働く」ができる（${j.from}〜${j.to}時）。`);
  log(`よそ者が${boss.name}のもとで${j.name}として働き始めた。`);
  for (const o of residents()) if (o.job === boss.job) addLike(o, p, 5);
  return true;
}

export function eatOwnFood() {
  const p = S.player;
  if (p.food < 1) return toast('食料を持っていない。');
  p.food--; p.hunger = clamp(p.hunger + 30, 0, 100);
  p.activity = 'eat'; p.busyStart = S.t; p.busyUntil = S.t + 10;
  toast('持っていた食料を食べた。満腹度+30');
}

export function facilityActions(fid) {
  const p = S.player;
  const f = FAC[fid];
  const acts = [];
  const open = facOpen(fid);
  if (!open) { acts.push({ id: 'closed', label: `${f.name}は爆破されて使えない…`, disabled: true }); return acts; }
  const jobHere = Object.entries(JOBS).find(([, j]) => j.place === fid);
  if (fid === 'diner') { acts.push({ id: 'eat', label: `食べる（${D.MEAL_COST}G）蓄え${Math.floor(S.foodStock)}` }); acts.push({ id: 'sneak', label: 'つまみ食いする（盗み）' }); }
  if (fid === 'market') { acts.push({ id: 'buyfood', label: '食料を買う（3G）' }); if (p.food > 0) acts.push({ id: 'sellfood', label: '食料を売る（+1G）' }); }
  if (fid === 'farm') acts.push({ id: 'stealcrop', label: '作物をこっそり持ち帰る（盗み）' });
  if (fid === 'tavern') { acts.push({ id: 'drink', label: `一杯やって噂を聞く（${D.DRINK_COST}G）` }); acts.push({ id: 'sleep', label: '泊まる・朝まで寝る（1G）' }); }
  if (fid === 'workshop') acts.push({ id: 'weapon', label: `武器を買う（${D.WEAPON_COST}G）腕力+8`, disabled: p.items.includes('weapon') });
  if (fid === 'clinic') acts.push({ id: 'heal', label: `治療を受ける（${D.HEAL_COST}G）`, disabled: !doctorAvailable() });
  if (fid === 'training') acts.push({ id: 'train', label: '体を鍛える（1時間）' });
  if (fid === 'guard') {
    acts.push({ id: 'report', label: '誰かを通報する' });
    if (S.wanted.has('player')) acts.push({ id: 'surrender', label: '自首する（4時間の牢屋）' });
  }
  if (fid === 'lab' && p.items.includes('meteor')) acts.push({ id: 'research', label: '光る石を研究する（2時間）' });
  if (S.clues?.[fid]) acts.unshift({ id: 'investigate', label: '🔍 事件の現場を調べる' });
  if (f.mine) acts.push({ id: 'sleep', label: '自分のベッドで朝まで寝る' });
  if (p.food > 0) acts.push({ id: 'eatown', label: `持っている食料を食べる（残り${p.food}）` });
  if (f.home && !f.mine) acts.push({ id: 'burgle', label: '家の中を物色する（盗み）' });
  if (jobHere) {
    const [jid, j] = jobHere;
    if (p.job === jid) acts.push({ id: 'work', label: `${j.name}として働く（1時間・時間が早く進む）` });
    else {
      const boss = bossIn(fid, jid);
      acts.push(boss ? { id: 'hire:' + jid, label: `${boss.name}に頼んで${j.name}として雇ってもらう` }
        : { id: 'nohire', label: `${j.name}として雇ってもらうには、${j.name}がいる時に頼もう`, disabled: true });
    }
  }
  for (const [k, it] of Object.entries(ITEMS)) if (it.shop === fid) acts.push({ id: 'buy:' + k, label: `${it.icon}${it.name}を買う（${it.price}G）贈り物用` });
  if (FAC[fid].mine) {
    acts.push({ id: 'deposit', label: `タンスにお金をしまう（手持ち${Math.floor(p.coins)}G → 盗まれない）`, disabled: p.coins < 1 });
    acts.push({ id: 'withdraw', label: `タンスからお金を出す（${Math.floor(p.bank || 0)}G）`, disabled: !(p.bank >= 1) });
  }
  if (p.items.includes('bomb') && !f.home && f.kind !== 'field') acts.push({ id: 'bomb', label: `💣 ${f.name}を爆破する` });
  return acts;
}

export function doFacility(fid, act) {
  const p = S.player;
  const f = FAC[fid];
  const sp = SPOTS[fid];
  const busy = (min, a = 'busy') => { p.activity = a; p.busyStart = S.t; p.busyUntil = S.t + min; };
  if (act.startsWith('hire:')) {
    const jid = act.slice(5);
    const boss = bossIn(fid, jid);
    if (!boss) return toast('雇ってくれる人がいない。');
    hirePlayer(boss);
    return;
  }
  if (act.startsWith('buy:')) {
    const k = act.slice(4);
    if (!playerSpend(ITEMS[k].price)) return;
    p.items.push(k); toast(`${ITEMS[k].icon}${ITEMS[k].name}を買った。住民に渡すと喜ばれるかも。`);
    if (fid === 'market') payJob('merchant', 1);
    return;
  }
  switch (act) {
    case 'eat':
      if (S.foodStock < 1) return toast('食堂の食料が尽きている！');
      if (!playerSpend(D.MEAL_COST)) return;
      S.foodStock -= 1; p.hunger = clamp(p.hunger + 55, 0, 100); payCooks(1); seatPlayer(sp.seat); busy(30, 'eat'); toast('おいしいご飯を食べた。満腹度+55');
      for (const o of S.chars) if (o.companion?.arrived && o.companion.dest === 'diner') addLike(o, p, 2);
      break;
    case 'sneak': {
      if (S.foodStock < 1) return toast('食料がない。');
      const ws = witnesses(p, [p]);
      const caught = ws.length && chance(0.35 + ws.length * 0.1);
      S.foodStock -= 1; p.hunger = clamp(p.hunger + 30, 0, 100); busy(10);
      if (caught) { S.stats.crimes++; S.today.crimes++; for (const w of ws) { addLike(w, p, -10); memo(w, 'よそ者が食堂でつまみ食いしたのを見た', 'crime'); } S.wanted.add('player'); toast('つまみ食いしたところを見られた！'); log('よそ者が食堂でつまみ食いした。', 'crime'); }
      else toast('こっそりつまみ食いした。満腹度+30');
      break;
    }
    case 'deposit': p.bank = (p.bank || 0) + Math.floor(p.coins); p.coins -= Math.floor(p.coins); toast(`タンスにしまった（${Math.floor(p.bank)}G）`); break;
    case 'withdraw': p.coins += p.bank; toast(`${Math.floor(p.bank)}Gを取り出した`); p.bank = 0; break;
    case 'eatown': eatOwnFood(); break;
    case 'investigate': {
      const text = Wolf.investigate(fid);
      if (text) S.banner = { title: '🔍 現場の手がかり', text: text + '（手帳に書きとめた）', until: performance.now() + 9000 };
      busy(15);
      break;
    }
    case 'buyfood': if (!playerSpend(3)) return; p.food++; toast('食料を1つ買った。'); break;
    case 'sellfood': p.food--; p.coins += 1; S.foodStock += 1; toast('食料を売った。+1G'); break;
    case 'stealcrop': {
      const ws = witnesses(p, [p]);
      p.food += 2; busy(15);
      if (ws.length && chance(0.5 + ws.length * 0.1)) { S.stats.crimes++; S.today.crimes++; for (const w of ws) { addLike(w, p, -12); memo(w, 'よそ者が畑から作物を盗んだのを見た', 'crime'); } S.wanted.add('player'); toast('作物泥棒を見られた！'); log('よそ者が畑の作物を盗んだ。', 'crime'); }
      else toast('作物を2つ手に入れた。');
      break;
    }
    case 'drink': {
      if (!playerSpend(D.DRINK_COST)) return;
      seatPlayer(sp.seat); busy(30, 'drink');
      const pool = residents().filter((o) => o.alive).flatMap((o) => o.memory.slice(-4).map((m) => m.replace(/^\d+日目 /, '')));
      const juicy = pool.filter((m) => /見た|された|亡く|捕まった|拾った|助けて/.test(m));
      const rumor = juicy.length ? pick(juicy) : pick(['最近は平和だねえ', 'ツヅミの奴、また話を盛ってたらしい', 'カゲはゴウと仲が悪いんだと', 'バンは金に弱いって噂だ', '研究所のシオンは何でも調べたがる']);
      toast(`🍺 噂：「${rumor}」`);
      log(`酒場で聞いた噂：${rumor}`);
      for (const o of nearby(p, 5)) addLike(o, p, 2);
      for (const o of S.chars) if (o.companion?.arrived && o.companion.dest === 'tavern') { addLike(o, p, 4); say(o, '乾杯！'); }
      break;
    }
    case 'sleep':
      if (fid === 'tavern' && !playerSpend(1)) return;
      for (const o of S.chars) if (o.companion) endCompanion(o, true);
      seatPlayer(sp.bed, true);
      p.activity = 'sleep'; p.busyStart = S.t; p.busyUntil = nextMorning(); toast('おやすみ…（時間が早く進みます）'); break;
    case 'weapon': if (!playerSpend(D.WEAPON_COST)) return; p.items.push('weapon'); toast('鉄の棍棒を手に入れた！ 腕力+8'); for (const o of nearby(p, 6)) addFear(o, p, 5); break;
    case 'heal': if (!playerSpend(D.HEAL_COST)) return; p.hp = clamp(p.hp + 45, 0, 100); payDoctor(2); seatPlayer(sp.bed, true); busy(40, 'heal'); toast('治療を受けた。体力+45'); break;
    case 'train': seatPlayer(sp.train); p.str += 0.9 * (1 - p.str / 45); p.hunger = clamp(p.hunger - 3, 0, 100); busy(60, 'train'); toast(`鍛えた！ 腕力 ${p.str.toFixed(1)}`); break;
    case 'surrender': S.wanted.delete('player'); jail(p, 4 * 60); toast('自首した。4時間の牢屋…'); for (const o of residents()) if (o.job === 'guard') addLike(o, p, 10); log('よそ者が自首した。', 'event'); break;
    case 'research':
      if (!facOpen('lab')) return;
      S.meteor.state = 'researching'; S.meteor.holder = 'player'; busy(120, 'research');
      toast('光る石を調べ始めた…'); break;
    case 'work': seatPlayer(sp.work); busy(60, 'work'); toast(`${JOBS[p.job].name}として働く…`); break;
    case 'burgle': {
      const owners = residents().filter((o) => o.alive && o.home === fid);
      const home = owners.filter((o) => facAt(...tilePos(o)) === f);
      const away = owners.filter((o) => !home.includes(o));
      busy(20);
      if (home.length) {
        const o = home[0];
        say(o, 'ちょっと！ 人の家で何してるの！');
        addLike(o, p, -15); memo(o, 'よそ者が家に勝手に入ってきた', 'crime');
        return toast(`${o.name}に見つかった！`);
      }
      const victim = away.length ? pick(away) : null;
      if (!victim) return toast('めぼしい物はなかった。');
      const n = Math.min(Math.floor(victim.coins), 2 + Math.floor(S.rand() * 4));
      victim.coins -= n; p.coins += n; S.stats.thefts++;
      S.stats.crimes++; S.today.crimes++;
      const ws = witnesses(p, [p]);
      if (ws.length) { for (const w of ws) { addLike(w, p, -15); memo(w, `よそ者が${f.name}に忍び込んだのを見た`, 'crime'); } S.wanted.add('player'); log(`よそ者が${f.name}に空き巣に入った。`, 'crime'); toast(`${victim.name}の家から${n}G盗んだ…が、見られていた！`); }
      else { memo(victim, '家のお金が減っていた。誰かが忍び込んだ', 'crime'); toast(`${victim.name}の家から${n}G盗んだ。誰にも見られていない。`); }
      break;
    }
    case 'bomb': bombFacility(p, fid); break;
  }
}

export function reportResident(target) {
  const p = S.player;
  const guards = residents().filter((g) => g.alive && g.job === 'guard');
  const trust = guards.length ? guards.reduce((a, g) => a + rel(g, p).like, 0) / guards.length : 0;
  const deserved = S.chars.some((o) => o.memory.some((m) => m.startsWith(`${day()}日目 ${target.name}が`) || m.includes(`${target.name}に`)));
  if (deserved || chance(clamp((trust + 40) / 100, 0.1, 0.9))) {
    S.wanted.add(target.id);
    toast(`衛兵は${target.name}を手配した。`);
    log(`よそ者の通報で${target.name}が手配された。`);
    addLike(target, p, -15);
  } else {
    toast('衛兵は取り合ってくれなかった。');
    for (const g of guards) addLike(g, p, -3);
  }
}

export function charActions(t) {
  const p = S.player;
  const acts = [
    { id: 'talk', label: '話す（自由に会話）' },
    t.companion ? { id: 'dismiss', label: 'ここで別れる' } : { id: 'invite', label: '「一緒に来て」と頼む' },
    { id: 'givecoin', label: '1G渡す', disabled: p.coins < 1 },
    { id: 'givefood', label: '食料を渡す', disabled: p.food < 1 },
  ];
  for (const it of [...new Set(p.items)]) if (it !== 'weapon') acts.push({ id: 'give:' + it, label: `${ITEMS[it].icon}${ITEMS[it].name}を渡す` });
  acts.push({ id: 'attack', label: '殴る' });
  acts.push({ id: 'steal', label: 'こっそり盗む' });
  acts.push({ id: 'threaten', label: '脅して金を出させる' });
  if (p.job === 'guard' && S.wanted.has(t.id)) acts.push({ id: 'arrest', label: '逮捕する' });
  return acts;
}

export function doCharAction(t, act) {
  const p = S.player;
  if (!t.alive) return;
  p.busyUntil = S.t + 5;
  faceTo(t, p);
  if (act === 'invite') {
    const d = Brain.inviteDecision(t, null, false);
    if (d === 'ok' || d === 'fear') { startCompanion(t, null, false); say(t, pick(['いいよ、ついてく！', 'しょうがないな。', 'どこ行くの？'])); toast(`🤝 ${t.name}がついてくる`); }
    else say(t, d === 'busy' ? '今は仕事中なんだ。' : d === 'late' ? 'もう遅いから帰るよ。' : 'うーん、今はやめとく。');
    return;
  }
  if (act === 'dismiss') { endCompanion(t, true); return; }
  const g = act === 'givecoin' ? { coins: 1 } : act === 'givefood' ? { item: 'food' } : act.startsWith('give:') ? { item: act.slice(5) } : null;
  if (g) {
    const res = giveToNpc(t, g);
    if (res.react !== 'none') { say(t, Brain.giftLine(t, res), 5); toast(`${t.name}に${res.label}を渡した。`); }
    return;
  }
  if (act === 'attack') return doAttack(p, t);
  if (act === 'steal') return doSteal(p, t);
  if (act === 'threaten') return doThreaten(p, t);
  if (act === 'arrest') return doArrest(p, t);
}

// 会話の結果を反映。返り値 { msgs: [表示する文], attack, flee, close }
export function applyTalkResult(t, r) {
  const p = S.player;
  const out = { msgs: [], attack: false, flee: false, close: false };
  addLike(t, p, r.like);
  if (r.fear) addFear(t, p, r.fear);
  if (r.belief) {
    const o = S.chars.find((x) => x.name === r.belief.target && x !== t);
    if (o) { addLike(t, o, r.belief.like); if (r.belief.like < 0) memo(t, `よそ者から${o.name}の悪い噂を聞いた`); }
  }
  if (r.follow) {
    startCompanion(t, r.follow.dest, r.follow.treat);
    out.msgs.push(`🤝 ${t.name}がついてくる${r.follow.dest ? `（行き先：${placeName(r.follow.dest)}）` : ''}。歩けばついてきます`);
    out.close = true;
  }
  if (r.guide) {
    startGuide(t, r.guide.place);
    out.msgs.push(`🚶 ${t.name}が${placeName(r.guide.place)}へ案内してくれる。ついていこう`);
    out.close = true;
  }
  if (r.dismiss) { endCompanion(t, true, true); out.close = true; }
  if (r.gift) {
    const g = giveToNpc(t, r.gift);
    if (g.react !== 'none') out.msgs.push(`🎁 ${t.name}に${g.label}を渡した`);
  }
  if (r.sell) {
    const s2 = r.sell;
    if (p.coins >= s2.price) {
      p.coins -= s2.price; t.coins += s2.price;
      if (s2.item === 'food') { t.food--; p.food++; } else p.items.push(s2.item);
      out.msgs.push(`🛒 ${t.name}から${s2.item === 'food' ? '食料' : ITEMS[s2.item].name}を${s2.price}Gで買った`);
    }
  }
  if (r.note) Wolf.addNote(r.note);
  if (r.task) { const m = assignTask(t, r.task); out.msgs.push(`🤝 ${m}`); out.close = r.task.type !== 'watch' ? true : out.close; }
  if (r.appointment) {
    t.appointment = { ...r.appointment, missed: false };
    const hh = Math.floor((r.appointment.at % 1440) / 60);
    const m = `${hh}時に${placeName(r.appointment.place)}で${t.name}と待ち合わせ`;
    Wolf.addNote(m); out.msgs.push(`📅 ${m}`);
  }
  if (r.meeting) { Wolf.scheduleMeeting('player', 60, 'player'); out.msgs.push('📣 1時間後に広場で話し合いが開かれる'); }
  if (r.accused) S.wolf.playerAccused.add(r.accused);
  if (r.quest) out.msgs.push(`📝 頼まれごと：${t.name}に${r.quest}を届ける（持ち物タブで確認）`);
  if (r.hire) { if (hirePlayer(t)) out.msgs.push(`${JOBS[t.job].icon} ${JOBS[t.job].name}になった！`); }
  if (r.close) out.close = true;
  switch (r.action) {
    case 'give_coin': { const n = Math.min(r.amount, Math.floor(t.coins), 5); if (n > 0) { t.coins -= n; p.coins += n; out.msgs.push(`💰 ${t.name}から${n}Gもらった`); } break; }
    case 'give_food': if (t.food > 0) { t.food--; p.food++; out.msgs.push(`🍞 ${t.name}から食料をもらった`); } break;
    case 'attack': out.attack = true; break;
    case 'flee': t.plan = null; t.path = []; setPlan(t, { place: 'plaza', tile: randomPlazaTile(S.rand), act: 'wander' }); out.flee = true; break;
    case 'report': S.wanted.add('player'); memo(t, 'よそ者のことを衛兵に通報した'); out.msgs.push('🚨 通報された！'); break;
  }
  return out;
}

// 掲示板にプレイヤーが書き込む
export function playerPost(text) {
  const p = S.player;
  const po = post('あなた', text, { authorId: 'player', postedT: S.t });
  const names = mentionedNames(text);
  const negWords = ['泥棒', '嘘つき', '犯人', '殴った', '盗んだ', '悪い奴', '危ない', '裏切', '怪しい', 'クズ', '気をつけ'];
  const posWords = ['いい人', '優しい', '助けて', 'ありがとう', '信用', '頼り'];
  const neg = negWords.some((w) => text.includes(w));
  const pos = posWords.some((w) => text.includes(w));
  for (const o of residents()) {
    if (!o.alive || names.includes(o)) continue;
    const cred = clamp((rel(o, p).like + 50) / 100, 0.15, 1.2);
    for (const n of names) addLike(o, n, (neg ? -7 : pos ? 5 : 0) * cred);
  }
  for (const n of names) if (n.alive) addLike(n, p, neg ? -18 : pos ? 8 : 1);
  if (/(話し合|はなしあ|会議|集まって|集会)/.test(text)) Wolf.scheduleMeeting('player', 60, 'player');
  if (S.wolfKnown && /(人狼|狼|犯人)/.test(text) && names.length && !/(じゃない|違う|無実)/.test(text)) {
    for (const o of residents()) if (o.alive && !names.includes(o)) for (const n of names) Wolf.addSus(o, n.id, 12 * Wolf.trust(o, 'player'), '掲示板でよそ者が名指ししていた');
    for (const n of names) { S.wolf.playerAccused.add(n.id); if (n.isWolf) S.wolf.playerThreat += 15; }
  }
  const keys = residents().filter((o) => o.alive && o.key);
  const repliers = [...names.filter((n) => n.key && n.alive), ...keys.filter(() => chance(0.3))].slice(0, 2);
  const uniq = [...new Set(repliers)];
  uniq.forEach((c, i) => setTimeout(() => Brain.replyTo(c, po), 2000 + i * 2500));
  return po;
}

export { timeStr };
