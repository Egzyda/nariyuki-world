// シミュレーション本体：時間・欲求・ルールAI・行動・事件
import * as D from './data.js';
import { TILE, JOBS, FACILITIES, ITEMS } from './data.js';
import { buildGrid, findPath, walkable, randomPlazaTile, nearestWalkable } from './world.js';
import {
  S, day, hour, timeStr, clamp, pick, chance, rel, addLike, addFear, byId, alive, residents,
  tilePos, distTiles, isAwake, isJailed, memo, say, log, toast, post, mentionedNames,
} from './state.js';
import * as Brain from './brain.js';

const FAC = Object.fromEntries(FACILITIES.map((f) => [f.id, f]));
const MOVE_TILES_PER_MIN = 0.55;

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
    path: [], plan: null, activity: null, busyUntil: 0, jailedUntil: 0,
    hp: 100, hunger: 70 + S.rand() * 25, coins: 4 + Math.floor(S.rand() * 5), food: 1,
    str: 8 + Math.round((def.p?.aggression ?? 0.3) * 10) + (['smith', 'guard'].includes(def.job) ? 4 : 0),
    items: [], alive: true, rel: {}, memory: [], bubble: null, intent: null,
    chatLog: [], postsToday: 0, lastPostAt: -9999, lastChatAt: -9999,
  };
}

export function initGame(seed = Date.now()) {
  S.rand = mulberry32(seed >>> 0);
  buildGrid();
  Object.assign(S, {
    t: D.START_HOUR * 60, speed: 1, paused: false, chars: [], fac: {}, foodStock: 30,
    board: [], log: [], stats: { crimes: 0, deaths: 0, arrests: 0, bribes: 0, fights: 0, thefts: 0 },
    today: { crimes: 0, deaths: 0 }, wanted: new Set(), meteor: null, droughtUntilDay: 0,
    meteorHour: 10 + Math.floor(S.rand() * 5), over: false, toasts: [], effects: [], postSeq: 1,
  });
  for (const f of FACILITIES) S.fac[f.id] = { closedUntilDay: 0 };

  const defs = [...D.KEY_RESIDENTS, ...D.makeBackgroundResidents(S.rand)];
  for (const d of defs) {
    const [dx, dy] = FAC[d.home].door;
    S.chars.push(makeChar(d, dx, dy));
  }
  const player = makeChar({
    id: 'player', name: 'あなた', job: 'none', home: 'house6', key: false, isPlayer: true,
    persona: '', p: { aggression: 0.3, honesty: 0.5, sociability: 0.5, greed: 0.5 },
  }, 22, 18);
  player.coins = 3; player.hunger = 70; player.food = 0; player.str = 10;
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

  for (const c of rs) Brain.dailyIntent(c);
  post('町役場', 'ようこそナリユキワールドへ。この掲示板は誰でも自由に書き込めます。', { authorId: 'town' });
  post('町役場', '本日、町に新しい住人（よそ者）がやってきました。皆さん仲良くしましょう。', { authorId: 'town' });
  log('あなたはナリユキワールドにやってきた。所持金は3G。', 'event');
}

// ================= 時間 =================
export function update(dtReal) {
  if (S.over) return;
  for (const e of S.effects) e.t -= dtReal;
  S.effects = S.effects.filter((e) => e.t > 0);
  if (S.paused) return;
  const p = S.player;
  const fast = p.alive && (p.activity === 'sleep' || isJailed(p)) && (p.busyUntil > S.t || isJailed(p));
  const gdt = Math.min(dtReal, 0.1) * D.GAME_MIN_PER_SEC * S.speed * (fast ? 25 : 1);
  const before = S.t;
  S.t += gdt;
  const h0 = Math.floor(before / 60), h1 = Math.floor(S.t / 60);
  for (let h = h0 + 1; h <= h1; h++) hourly(h % 24, Math.floor(h / 24) + 1);
  if (S.over) return;
  for (const c of S.chars) updateChar(c, gdt);
  if (p.activity === 'sleep' && S.t >= p.busyUntil) { p.activity = null; toast('朝になった。'); }
}

function hourly(h, d) {
  // 欲求と体力
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
  // 仕事の成果
  const workers = S.chars.filter((c) => c.alive && c.activity === 'work' && S.t - 60 < c.busyUntil);
  for (const c of workers) {
    const place = JOBS[c.job]?.place;
    if (!place) continue;
    const co = workers.filter((o) => o !== c && JOBS[o.job]?.place === place).length;
    const bonus = 1 + 0.25 * Math.min(2, co);
    c.coins += JOBS[c.job].wage * bonus * (c.isPlayer ? 1 : 0.6);
    if (c.job === 'farmer') S.foodStock += 0.5 * bonus * (S.droughtUntilDay >= d ? 0.35 : 1);
  }
  // 研究
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
  // 隕石
  if (d === D.EVENTS.meteor.day && h === S.meteorHour && !S.meteor) meteorFall();
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
    log(`日照りが始まった。しばらく畑の実りが悪くなりそうだ。`, 'event');
    post('町役場', '【警報】日照りのため、しばらく畑の収穫が大きく減る見込みです。', { authorId: 'town' });
    toast('☀️ 日照りが始まった！');
  }
  // 生活費と、時間による感情の風化
  for (const c of S.chars) {
    if (!c.alive) continue;
    if (c.coins >= 2) c.coins -= 2; else c.hunger = clamp(c.hunger - 10, 0, 100);
    if (c.isPlayer) continue;
    const forgive = 0.1 + c.p.sociability * 0.1 + c.p.honesty * 0.1 - c.p.aggression * 0.08;
    for (const r of Object.values(c.rel)) {
      if (r.like < 0) r.like *= 1 - forgive;
      r.fear *= 0.85;
    }
  }
  if (S.player.alive) toast('生活費として2G払った。');
  // 呪いの石
  for (const c of S.chars) if (c.alive && c.items.includes('cursed')) {
    c.hp -= 15; memo(c, '呪いの石のせいで体が重い');
    if (c.isPlayer) toast('🌑 呪いの石が体力を奪っていく…');
  }
  // 影響力の発表
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
  const poster = keys.filter(() => chance(0.35)).slice(0, 2);
  setTimeout(() => poster.forEach((c) => Brain.postAbout(c, 'morning')), 1500);
}

// ================= 住民の更新 =================
function updateChar(c, gdt) {
  if (!c.alive) return;
  if (c.jailedUntil) {
    if (S.t < c.jailedUntil) return;
    c.jailedUntil = 0;
    const [dx, dy] = FAC.guard.door;
    c.x = dx * TILE + TILE / 2; c.y = (dy + 1) * TILE + TILE / 2;
    say(c, '……やっと出られた');
    if (c.isPlayer) toast('牢屋から出られた。');
  }
  if (c.path.length) { move(c, gdt * MOVE_TILES_PER_MIN * TILE * (c.hunger < 15 ? 0.6 : 1)); if (!c.path.length) arrive(c); return; }
  if (c.isPlayer) return;
  if (S.t < c.busyUntil) {
    if (c.plan?.targetId && c.activity === 'follow') arrive(c);
    return;
  }
  if (c.plan && c.plan.targetId) { arrive(c); return; }
  c.activity = null;
  decide(c);
}

function move(c, dist) {
  while (dist > 0 && c.path.length) {
    const [tx, ty] = c.path[0];
    const gx = tx * TILE + TILE / 2, gy = ty * TILE + TILE / 2;
    const dx = gx - c.x, dy = gy - c.y;
    const d = Math.hypot(dx, dy);
    if (d <= dist) { c.x = gx; c.y = gy; c.path.shift(); dist -= d; }
    else { c.x += (dx / d) * dist; c.y += (dy / d) * dist; dist = 0; }
  }
}

function goTo(c, tx, ty) {
  const [sx, sy] = tilePos(c);
  c.path = findPath(sx, sy, tx, ty);
}

function setPlan(c, plan) {
  c.plan = plan;
  c.activity = null;
  if (plan.place) {
    const [dx, dy] = plan.place === 'meteor' ? [S.meteor.tx, S.meteor.ty] : plan.place === 'plaza' ? plan.tile : FAC[plan.place].door;
    goTo(c, dx, dy);
    if (!c.path.length) arrive(c);
  } else if (plan.targetId) {
    plan.tries = 0;
    arrive(c);
  }
}

function arrive(c) {
  const plan = c.plan;
  if (!plan) return;
  if (plan.place) { c.plan = null; startActivity(c, plan); return; }
  if (plan.targetId) {
    const t = byId(plan.targetId);
    if (!t || !t.alive || isJailed(t) || plan.tries > 8 || (plan.giveUpAt && S.t > plan.giveUpAt)) { c.plan = null; c.activity = null; c.busyUntil = 0; return; }
    if (distTiles(c, t) <= 1.6) { c.plan = null; c.activity = null; interact(c, t, plan.kind); return; }
    plan.tries++;
    const [tx, ty] = tilePos(t);
    goTo(c, tx, ty);
    if (c.path.length > 3) c.path = c.path.slice(0, Math.max(3, c.path.length - 1));
    if (!c.path.length) { c.plan = null; }
  }
}

const nextMorning = () => { const d = Math.floor(S.t / 1440); const m = d * 1440 + 6 * 60; return S.t < m ? m : m + 1440; };
const facOpen = (id) => S.fac[id].closedUntilDay < day();

// ================= ルールAI =================
function decide(c) {
  const h = hour();
  const p = c.p;
  const st = c.intent?.stance || 'work';
  const job = JOBS[c.job];

  // 夜は寝る
  if (h >= 22 || h < 6) { setPlan(c, { place: c.home, act: 'sleep' }); return; }

  // 万能薬
  if (c.hp < 35 && c.items.includes('elixir')) { useItem(c, 'elixir'); return; }

  // 衛兵：手配者を捕まえる
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

  // 空腹
  if (c.hunger < 45) {
    if (c.food > 0) { c.food--; c.hunger = clamp(c.hunger + 35, 0, 100); say(c, 'もぐもぐ'); c.busyUntil = S.t + 15; return; }
    if (c.coins >= D.MEAL_COST && S.foodStock >= 1 && facOpen('diner')) { setPlan(c, { place: 'diner', act: 'eat' }); return; }
    if (c.coins >= 3 && S.foodStock >= 1 && facOpen('market')) { setPlan(c, { place: 'market', act: 'buyfood' }); return; }
    if (c.hunger < 20 && facOpen('farm') && chance(0.6)) { setPlan(c, { place: 'farm', act: 'forage' }); return; }
    // お金も食べ物もない
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

  // けが
  if (c.hp < 50 && c.coins >= D.HEAL_COST && doctorAvailable() && c.job !== 'doctor' && h < 20) { setPlan(c, { place: 'clinic', act: 'heal' }); return; }

  // 恨み
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

  // 隕石
  const m = S.meteor;
  if (m) {
    if (m.state === 'ground' && chance(0.25 + p.greed * 0.5 + (c.job === 'researcher' ? 0.6 : 0))) { setPlan(c, { place: 'meteor', act: 'pickup' }); return; }
    if (c.items.includes('meteor') && facOpen('lab') && h < 21) { setPlan(c, { place: 'lab', act: 'research' }); return; }
    if (m.state === 'held' && !c.items.includes('meteor') && (p.greed > 0.7 || c.job === 'researcher') && (1 - p.honesty) > 0.4 && chance(0.15)) {
      const h0 = byId(m.holder);
      if (h0 && h0.alive && !isJailed(h0)) { setPlan(c, { targetId: h0.id, kind: 'steal', giveUpAt: S.t + 120 }); return; }
    }
  }
  // 爆薬
  if (c.items.includes('bomb') && p.aggression > 0.55 && chance(0.06)) {
    const f = pick(FACILITIES.filter((f) => !f.home && f.id !== c.job && facOpen(f.id)));
    setPlan(c, { place: f.id, act: 'bomb' }); return;
  }
  // 呪いの石を押しつける
  if (c.items.includes('cursed') && chance(0.3)) {
    const t = pickVictim(c, () => true, true);
    if (t) { setPlan(c, { targetId: t.id, kind: 'giftCursed', giveUpAt: S.t + 120 }); return; }
  }

  // 優しさ：困っている友達に分ける
  if (st === 'peaceful' || chance(p.sociability * (1 - p.greed) * 0.3)) {
    const needy = S.chars.find((o) => o !== c && o.alive && !isJailed(o) && o.hunger < 30 && o.food === 0 && o.coins < 2 && rel(c, o).like > 10);
    if (needy && (c.food > 0 || c.coins >= 4)) { setPlan(c, { targetId: needy.id, kind: 'give', giveUpAt: S.t + 90 }); return; }
  }

  // ずる：スリ
  if (st === 'scheme' && chance(0.12 * (1 - p.honesty) + 0.03)) {
    const v = pickVictim(c, (o) => o.coins >= 4);
    if (v) { setPlan(c, { targetId: v.id, kind: 'steal', giveUpAt: S.t + 90 }); return; }
  }

  // 仕事
  if (job.place && h >= job.from && h < job.to && facOpen(job.place)) {
    const lazy = st === 'scheme' ? 0.35 : st === 'peaceful' ? 0.12 : 0.05;
    if (!chance(lazy)) { setPlan(c, { place: job.place, act: 'work' }); return; }
  }

  // 余暇
  const opts = [
    ['tavern', 'drink', p.sociability * (c.coins >= 1 ? 1 : 0) * (h >= 17 ? 1.5 : 0.4)],
    ['training', 'train', p.aggression * (st === 'aggressive' ? 2 : 0.8)],
    ['plaza', 'wander', 0.6],
    ['board', 'board', c.key ? 0.3 : 0.1],
    ['chat', 'chat', p.sociability],
    [c.home, 'rest', 0.3],
  ].filter((o) => o[2] > 0);
  let sum = opts.reduce((a, o) => a + o[2], 0);
  let r = S.rand() * sum;
  let choice = opts[0];
  for (const o of opts) { r -= o[2]; if (r <= 0) { choice = o; break; } }
  const [where, act] = choice;
  if (act === 'chat') {
    const f = bestFriend(c, () => true) || pickVictim(c, () => true, true);
    if (f) { setPlan(c, { targetId: f.id, kind: 'chat', giveUpAt: S.t + 60 }); return; }
  }
  if (where === 'plaza') { setPlan(c, { place: 'plaza', tile: randomPlazaTile(S.rand), act: 'wander' }); return; }
  if (where === 'board') { setPlan(c, { place: 'plaza', tile: [22, 17], act: 'board' }); return; }
  if (where === 'tavern' && !facOpen('tavern')) { setPlan(c, { place: 'plaza', tile: randomPlazaTile(S.rand), act: 'wander' }); return; }
  setPlan(c, { place: where, act });
}

function nearby(c, maxTiles, filter = () => true) {
  return S.chars.filter((o) => o !== c && o.alive && !isJailed(o) && distTiles(c, o) <= maxTiles && filter(o));
}

function pickVictim(c, filter, anyone = false) {
  const cands = S.chars.filter((o) => o !== c && o.alive && !isJailed(o) && filter(o) && distTiles(c, o) < 20);
  if (!cands.length) return null;
  cands.sort((a, b) => (rel(c, a).like - rel(c, b).like) + (distTiles(c, a) - distTiles(c, b)) * 2);
  return anyone ? pick(cands.slice(0, 5)) : cands[0];
}

function bestFriend(c, filter) {
  const cands = S.chars.filter((o) => o !== c && o.alive && !isJailed(o) && filter(o) && rel(c, o).like > 15 && distTiles(c, o) < 22);
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
  switch (act) {
    case 'sleep': c.busyUntil = nextMorning(); break;
    case 'work': {
      const job = JOBS[c.job];
      const end = Math.floor(S.t / 1440) * 1440 + job.to * 60;
      c.busyUntil = Math.min(S.t + 120, Math.max(end, S.t + 30));
      break;
    }
    case 'eat':
      if (c.coins >= D.MEAL_COST && S.foodStock >= 1 && facOpen('diner')) {
        c.coins -= D.MEAL_COST; S.foodStock -= 1; c.hunger = clamp(c.hunger + 55, 0, 100);
        payCooks(1); c.busyUntil = S.t + 30;
      } else { say(c, '食堂が……'); c.busyUntil = S.t + 10; }
      break;
    case 'heal':
      if (c.coins >= D.HEAL_COST && doctorAvailable()) { c.coins -= D.HEAL_COST; c.hp = clamp(c.hp + 45, 0, 100); payDoctor(2); }
      c.busyUntil = S.t + 40; break;
    case 'train': c.str += 0.7 * (1 - c.str / 45); c.busyUntil = S.t + 60; break;
    case 'drink':
      if (c.coins >= D.DRINK_COST && facOpen('tavern')) {
        c.coins -= D.DRINK_COST;
        for (const o of nearby(c, 3, (o) => o.activity === 'drink')) { addLike(c, o, 3); addLike(o, c, 3); shareRumor(c, o); }
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
    case 'wander': c.busyUntil = S.t + 20 + S.rand() * 30; break;
    case 'rest': c.busyUntil = S.t + 40; break;
    case 'board': {
      c.busyUntil = S.t + 20;
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
      say(a, Brain.chatLine(a, b, rumor));
      setTimeout(() => b.alive && say(b, rumor ? pick(['マジかよ……', 'へえ、知らなかった', '気をつけないとな']) : Brain.chatLine(b, a)), 1200);
      addLike(a, b, 2 + a.p.sociability * 3); addLike(b, a, 2 + b.p.sociability * 2);
      shareRumor(a, b);
      a.busyUntil = S.t + 20; if (!b.isPlayer && S.t >= b.busyUntil) b.busyUntil = S.t + 20;
      break;
    }
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

function giveSomething(a, b) {
  if (!a.alive || !b.alive) return;
  if (a.food > 0) { a.food--; b.food++; say(a, 'ほら、これ食べな'); }
  else if (a.coins >= 2) { const n = a.coins >= 6 ? 2 : 1; a.coins -= n; b.coins += n; say(a, `${n}Gあげるよ`); }
  else return;
  addLike(b, a, 15); memo(b, `${a.isPlayer ? 'よそ者' : a.name}に助けてもらった`);
  for (const w of witnesses(a, [a, b])) addLike(w, a, 3);
  if (b.isPlayer) toast(`${a.name}が施しをくれた！`);
}

function witnesses(at, exclude) {
  return S.chars.filter((o) => !exclude.includes(o) && isAwake(o) && distTiles(at, o) <= 7);
}

function dispName(c) { return c.isPlayer ? 'よそ者' : c.name; }

function crime(actor, victim, type, noticed) {
  S.stats.crimes++; S.today.crimes++;
  const ws = witnesses(actor, [actor, victim]);
  const [vText, wText] = WHAT[type];
  const actorN = dispName(actor);
  if (noticed) {
    addLike(victim, actor, type === 'attack' ? -40 : -30);
    memo(victim, `${actorN}に${vText}`);
  }
  for (const w of ws) {
    addLike(w, actor, type === 'attack' ? -18 : -12);
    if (type === 'attack') addFear(w, actor, 6);
    memo(w, `${actorN}が${dispName(victim)}に${wText}のを見た`);
    if (w.key && w.postsToday < 4 && chance(0.25)) Brain.postAbout(w, 'witness', { actor: actorN, victim: dispName(victim), what2: wText });
  }
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
  const hit = power(a) + S.rand() * 10 > power(b) * 0.7 + S.rand() * 10;
  if (hit) {
    const dmg = 5 + Math.round(power(a) * 0.4 + S.rand() * 6);
    b.hp -= dmg;
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

function doArrest(g, t) {
  if (!S.wanted.has(t.id)) return;
  // 賄賂
  if (!t.isPlayer && t.coins >= 5 && g.p.greed > 0.6 && g.p.honesty < 0.5 && chance(0.5)) {
    t.coins -= 5; g.coins += 5; S.wanted.delete(t.id); S.stats.bribes++;
    say(g, '……今回だけだぞ');
    log('どこかで袖の下が渡されたらしい……', 'crime');
    return;
  }
  const ok = power(g) + S.rand() * 12 > power(t) * 0.8 + S.rand() * 12;
  if (ok) {
    S.wanted.delete(t.id); S.stats.arrests++;
    t.jailedUntil = S.t + 8 * 60; t.plan = null; t.path = []; t.activity = 'jail';
    const [dx, dy] = FAC.guard.door; t.x = dx * TILE + TILE / 2; t.y = dy * TILE + TILE / 2;
    say(g, '御用だ！');
    addLike(t, g, -20);
    memo(t, `${g.name}に捕まった`);
    log(`衛兵の${g.name}が${dispName(t)}を捕まえた。`, 'event');
    if (t.isPlayer) toast('捕まった！ 8時間、牢屋に入れられる…');
  } else {
    say(g, 'くそ、逃げられた！'); say(t, 'へへっ');
    if (t.isPlayer) toast(`${g.name}の手を振りほどいた！`);
  }
}

function pickRumor(a, b) {
  const crimes = a.memory.filter((m) => m.includes('のを見た') || m.includes('された'));
  if (!crimes.length || !chance(0.6)) return null;
  const m = pick(crimes).replace(/^\d+日目 /, '');
  return m.replace(/のを見た$/, '').replace(/に(.+)された$/, 'が$1');
}

function shareRumor(a, b) {
  // a の記憶にある犯罪者の印象を b に伝える
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
function die(c, cause) {
  if (!c.alive) return;
  c.alive = false; c.hp = 0; c.path = []; c.plan = null;
  S.stats.deaths++; S.today.deaths++;
  S.wanted.delete(c.id);
  if (c.items.includes('meteor') && S.meteor) { const [tx, ty] = tilePos(c); const n = nearestWalkable(tx, ty); S.meteor.state = 'ground'; S.meteor.tx = n[0]; S.meteor.ty = n[1]; S.meteor.holder = null; }
  c.items = [];
  log(`${dispName(c)}が亡くなった（${cause}）。`, 'death');
  if (c.isPlayer) { S.over = true; S.gameOverReason = `あなたは${cause}で倒れた。`; return; }
  post('町役場', `【訃報】${c.name}さんが亡くなりました（${cause}）。`, { authorId: 'town' });
  const mourner = residents().filter((o) => o.alive && o.key && rel(o, c).like > 20);
  if (mourner.length) Brain.postAbout(pick(mourner), 'death', { name: c.name });
  for (const o of residents()) if (o.alive) memo(o, `${c.name}が${cause}で亡くなった`);
}

// ================= イベント =================
function meteorFall() {
  let tx, ty;
  for (let i = 0; i < 50; i++) {
    tx = 4 + Math.floor(S.rand() * 36); ty = 10 + Math.floor(S.rand() * 13);
    if (walkable(tx, ty)) break;
  }
  S.meteor = { tx, ty, state: 'ground', holder: null, progress: 0, result: null };
  S.effects.push({ type: 'flash', t: 1.2 });
  log('空から光る石が落ちてきた！', 'event');
  post('町役場', '【速報】町に隕石が落下しました。未知の物質が見つかったとの情報があります。', { authorId: 'town' });
  toast('☄️ 隕石が落ちてきた！ 光る石が転がっている…');
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
  for (const o of S.chars) if (o.alive && o !== c && distTiles(o, { x: f.door[0] * TILE, y: f.door[1] * TILE }) < 3) { o.hp -= 25; if (o.hp <= 0) die(o, '爆発'); }
  const ws = witnesses(c, [c]);
  for (const w of ws) { addLike(w, c, -40); addFear(w, c, 30); memo(w, `${dispName(c)}が${f.name}を爆破したのを見た`); }
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
  if (fid === 'house6') acts.push({ id: 'sleep', label: '朝まで寝る（無料）' });
  if (FAC[fid].home && fid !== 'house6') acts.push({ id: 'burgle', label: '留守の家に忍び込む（盗み）' });
  if (jobHere) {
    const [jid, j] = jobHere;
    if (p.job === jid) acts.push({ id: 'work', label: `${j.name}として働く（1時間）` });
    else acts.push({ id: 'hire:' + jid, label: `${j.name}に転職する` });
  }
  if (p.items.includes('bomb') && !FAC[fid].home) acts.push({ id: 'bomb', label: `💣 ${f.name}を爆破する` });
  return acts;
}

export function doFacility(fid, act) {
  const p = S.player;
  const f = FAC[fid];
  const busy = (min, a = 'busy') => { p.activity = a; p.busyUntil = S.t + min; };
  if (act.startsWith('hire:')) {
    const jid = act.slice(5);
    p.job = jid; toast(`${JOBS[jid].name}になった！ ${f.name}で働けるようになった。`);
    log(`よそ者が${JOBS[jid].name}として働き始めた。`);
    for (const o of residents()) if (o.job === jid) addLike(o, p, 5);
    return;
  }
  switch (act) {
    case 'eat':
      if (S.foodStock < 1) return toast('食堂の食料が尽きている！');
      if (!playerSpend(D.MEAL_COST)) return;
      S.foodStock -= 1; p.hunger = clamp(p.hunger + 55, 0, 100); payCooks(1); busy(30); toast('おいしいご飯を食べた。満腹度+55'); break;
    case 'sneak': {
      if (S.foodStock < 1) return toast('食料がない。');
      const ws = witnesses(p, [p]);
      const caught = ws.length && chance(0.35 + ws.length * 0.1);
      S.foodStock -= 1; p.hunger = clamp(p.hunger + 30, 0, 100); busy(10);
      if (caught) { S.stats.crimes++; S.today.crimes++; for (const w of ws) { addLike(w, p, -10); memo(w, 'よそ者が食堂でつまみ食いしたのを見た'); } S.wanted.add('player'); toast('つまみ食いしたところを見られた！'); log('よそ者が食堂でつまみ食いした。', 'crime'); }
      else toast('こっそりつまみ食いした。満腹度+30');
      break;
    }
    case 'buyfood': if (!playerSpend(3)) return; p.food++; toast('食料を1つ買った。'); break;
    case 'sellfood': p.food--; p.coins += 1; S.foodStock += 1; toast('食料を売った。+1G'); break;
    case 'stealcrop': {
      const ws = witnesses(p, [p]);
      p.food += 2; busy(15);
      if (ws.length && chance(0.5 + ws.length * 0.1)) { S.stats.crimes++; S.today.crimes++; for (const w of ws) { addLike(w, p, -12); memo(w, 'よそ者が畑から作物を盗んだのを見た'); } S.wanted.add('player'); toast('作物泥棒を見られた！'); log('よそ者が畑の作物を盗んだ。', 'crime'); }
      else toast('作物を2つ手に入れた。');
      break;
    }
    case 'drink': {
      if (!playerSpend(D.DRINK_COST)) return;
      busy(30);
      const pool = residents().filter((o) => o.alive).flatMap((o) => o.memory.slice(-4).map((m) => m.replace(/^\d+日目 /, '')));
      const juicy = pool.filter((m) => /見た|された|亡く|捕まった|拾った|助けて/.test(m));
      const rumor = juicy.length ? pick(juicy) : pick(['最近は平和だねえ', 'ツヅミの奴、また話を盛ってたらしい', 'カゲはゴウと仲が悪いんだと', 'バンは金に弱いって噂だ', '研究所のシオンは何でも調べたがる']);
      toast(`🍺 噂：「${rumor}」`);
      log(`酒場で聞いた噂：${rumor}`);
      for (const o of nearby(p, 4)) addLike(o, p, 2);
      break;
    }
    case 'sleep':
      if (fid === 'tavern' && !playerSpend(1)) return;
      p.activity = 'sleep'; p.busyUntil = nextMorning(); toast('おやすみ…（時間が早く進みます）'); break;
    case 'weapon': if (!playerSpend(D.WEAPON_COST)) return; p.items.push('weapon'); toast('鉄の棍棒を手に入れた！ 腕力+8'); for (const o of nearby(p, 6)) addFear(o, p, 5); break;
    case 'heal': if (!playerSpend(D.HEAL_COST)) return; p.hp = clamp(p.hp + 45, 0, 100); payDoctor(2); busy(40); toast('治療を受けた。体力+45'); break;
    case 'train': p.str += 0.9 * (1 - p.str / 45); p.hunger = clamp(p.hunger - 3, 0, 100); busy(60, 'train'); toast(`鍛えた！ 腕力 ${p.str.toFixed(1)}`); break;
    case 'surrender': S.wanted.delete('player'); p.jailedUntil = S.t + 4 * 60; p.activity = 'jail'; toast('自首した。4時間の牢屋…'); for (const o of residents()) if (o.job === 'guard') addLike(o, p, 10); log('よそ者が自首した。', 'event'); break;
    case 'research':
      if (!facOpen('lab')) return;
      S.meteor.state = 'researching'; S.meteor.holder = 'player'; p.activity = 'research'; p.busyUntil = S.t + 120;
      toast('光る石を調べ始めた…'); break;
    case 'work': busy(60, 'work'); toast(`${JOBS[p.job].name}として働く…`); break;
    case 'burgle': {
      const owners = residents().filter((o) => o.alive && o.home === fid);
      const away = owners.filter((o) => distTiles(o, p) > 4);
      const victim = away.length ? pick(away) : null;
      busy(20);
      if (!victim) return toast('人の気配がする…やめておこう。');
      const n = Math.min(Math.floor(victim.coins), 2 + Math.floor(S.rand() * 4));
      victim.coins -= n; p.coins += n; S.stats.thefts++;
      const ws = witnesses(p, [p]);
      S.stats.crimes++; S.today.crimes++;
      if (ws.length) { for (const w of ws) { addLike(w, p, -15); memo(w, `よそ者が${f.name}に忍び込んだのを見た`); } S.wanted.add('player'); log(`よそ者が${f.name}に空き巣に入った。`, 'crime'); toast(`${victim.name}の家から${n}G盗んだ…が、見られていた！`); }
      else { memo(victim, '家のお金が減っている。誰かが忍び込んだ'); addLike(victim, p, 0); toast(`${victim.name}の家から${n}G盗んだ。誰にも見られていない。`); }
      break;
    }
    case 'bomb': bombFacility(p, fid); break;
  }
}

export function reportResident(target) {
  const p = S.player;
  const guards = residents().filter((g) => g.alive && g.job === 'guard');
  const trust = guards.length ? guards.reduce((a, g) => a + rel(g, p).like, 0) / guards.length : 0;
  const deserved = target.memory && S.chars.some((o) => o.memory.some((m) => m.startsWith(`${day()}日目 ${target.name}が`) || m.includes(`${target.name}に`)));
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
    { id: 'talk', label: '話す' },
    { id: 'givecoin', label: '1G渡す', disabled: p.coins < 1 },
    { id: 'givefood', label: '食料を渡す', disabled: p.food < 1 },
  ];
  for (const it of ['meteor', 'elixir', 'cursed', 'bomb']) if (p.items.includes(it)) acts.push({ id: 'give:' + it, label: `${ITEMS[it].icon}${ITEMS[it].name}を渡す` });
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
  if (act === 'givecoin') { p.coins -= 1; t.coins += 1; addLike(t, p, t.p.greed > 0.6 ? 10 : 7); say(t, pick(['お、ありがとな', 'いいのかい？', 'へへ、悪いね'])); if (t.job === 'guard' && S.wanted.has('player') && t.p.greed > 0.6 && rel(t, p).like > 20) { S.wanted.delete('player'); S.stats.bribes++; say(t, '……何も見なかったことにしよう'); toast('衛兵が見逃してくれることになった。'); } return; }
  if (act === 'givefood') { p.food -= 1; t.food += 1; addLike(t, p, t.hunger < 40 ? 18 : 8); memo(t, 'よそ者に食べ物をもらった'); say(t, t.hunger < 40 ? '助かる！ 恩に着るよ' : 'ありがとう'); return; }
  if (act.startsWith('give:')) {
    const it = act.slice(5);
    removeItem(p, it); t.items.push(it);
    if (it === 'meteor') { S.meteor.holder = t.id; S.meteor.state = 'held'; }
    addLike(t, p, it === 'cursed' ? 6 : 12);
    say(t, it === 'cursed' ? 'きれいな石だね、ありがとう' : 'こんな物をくれるのか！');
    toast(`${t.name}に${ITEMS[it].name}を渡した。`);
    return;
  }
  if (act === 'attack') return doAttack(p, t);
  if (act === 'steal') return doSteal(p, t);
  if (act === 'threaten') return doThreaten(p, t);
  if (act === 'arrest') return doArrest(p, t);
}

// 会話の結果を反映
export function applyTalkResult(t, r) {
  const p = S.player;
  addLike(t, p, r.like);
  if (r.belief) {
    const o = S.chars.find((x) => x.name === r.belief.target && x !== t);
    if (o) { addLike(t, o, r.belief.like); if (r.belief.like < 0) memo(t, `よそ者から${o.name}の悪い噂を聞いた`); }
  }
  switch (r.action) {
    case 'give_coin': { const n = Math.min(r.amount, Math.floor(t.coins), 5); if (n > 0) { t.coins -= n; p.coins += n; return `💰 ${t.name}から${n}Gもらった`; } break; }
    case 'give_food': if (t.food > 0) { t.food--; p.food++; return `🍞 ${t.name}から食料をもらった`; } break;
    case 'attack': return { attack: true };
    case 'flee': t.plan = null; t.path = []; setPlan(t, { place: 'plaza', tile: randomPlazaTile(S.rand), act: 'wander' }); return { flee: true };
    case 'report': S.wanted.add('player'); memo(t, 'よそ者のことを衛兵に通報した'); return '🚨 通報された！';
  }
  return null;
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
  // 返信
  const keys = residents().filter((o) => o.alive && o.key);
  const repliers = [...names.filter((n) => n.key && n.alive), ...keys.filter(() => chance(0.3))].slice(0, 2);
  const uniq = [...new Set(repliers)];
  uniq.forEach((c, i) => setTimeout(() => Brain.replyTo(c, po), 2000 + i * 2500));
  return po;
}
