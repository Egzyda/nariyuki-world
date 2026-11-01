// 人狼：町の住民のひとりが本物の人狼。決まった進行はない。
// 夜中に本当に家を抜け出して誰かを襲い、朝に見つかって初めて事件になる。
// 住民はそれぞれ「誰を疑っているか」を頭の中に持ち、噂で疑いが広がる。
// 話し合いは住民かプレイヤーが言い出したときにだけ開かれる。
import { TILE, FACILITIES, PLAZA, FOUNTAIN, JOBS } from './data.js';
import {
  S, day, hour, timeStr, clamp, pick, chance, rel, addLike, addFear, byId, residents,
  tilePos, distTiles, isJailed, memo, say, log, toast, post,
} from './state.js';
import { facAt, FAC, walkable, furnAt } from './world.js';
import * as Sim from './sim.js';
import { toneOf, firstPerson, placeName } from './dialog.js';
import * as Town from './town.js';
import { lookFor } from './sprites.js';
import * as Seer from './seer.js';

const LIFE = 60 * 24 * 60;    // 「ずっと」牢屋

// ================= 準備 =================
export function initWolf(setup = { wolves: '1' }) {
  // 人狼の数：0〜2人。「ランダム」のときは人数を秘密にする
  const r = S.rand();
  const n = setup.wolves === 'random' ? (r < 0.25 ? 0 : r < 0.75 ? 1 : 2) : Math.max(0, Math.min(2, Number(setup.wolves) || 0));
  const pool = residents().slice().sort(() => S.rand() - 0.5);
  const ids = pool.slice(0, n).map((c) => { c.isWolf = true; return c.id; });
  S.wolf = { ids, id: ids[0] || null, hidden: setup.wolves === 'random', kills: [], confirmed: false, lieLow: false, frame: null, playerThreat: 0, playerAccused: new Set() };
  S.wolfKnown = false;
  S.meeting = null;
  S.lastMeetingEnd = -9999;
  S.clues = {};
  S.notes = [];
  S.evidence = [];
  S.meetingPause = false;
  for (const c of S.chars) c.sus = {};
}

// 人狼たち（0〜2人）。wolfChar() は、まだ正体がばれていない人狼（いなければ最初の人狼）
export const wolves = () => (S.wolf?.ids || (S.wolf?.id ? [S.wolf.id] : [])).map(byId).filter(Boolean);
export const wolfChar = () => wolves().find((w) => w.alive && !w.wolfRevealed) || wolves()[0] || null;
const allWolvesDone = () => wolves().every((w) => w.wolfRevealed || !w.alive);
const dn = (c) => (c.isPlayer ? 'よそ者' : c.name);
const pol = (c) => toneOf(c).pol;
const nm = (c, t) => (t.isPlayer ? (pol(c) ? 'よそ者の方' : 'よそ者') : pol(c) ? `${t.name}さん` : t.name);
const sleeping = (o) => o.inBed || (o.activity === 'sleep' && S.t < o.busyUntil);

export function addNote(text) {
  if (S.notes.some((n) => n.text === text)) return;
  S.notes.unshift({ day: day(), time: timeStr(), text });
  if (S.notes.length > 60) S.notes.pop();
}

function locLabel(c) {
  const [x, y] = tilePos(c);
  const f = facAt(x, y);
  if (f) return `${f.name}${f.home ? 'のあたり' : ''}`;
  if (x >= PLAZA.x && x < PLAZA.x + PLAZA.w && y >= PLAZA.y && y < PLAZA.y + PLAZA.h) return '広場';
  return y >= 25 ? '家々の並ぶ通り' : '町の通り';
}

// ================= 疑い =================
export function sus(c, tid) { return c.sus?.[tid]?.v || 0; }

export function addSus(c, tid, v, why, force = false) {
  if (!c.sus || c.id === tid || (c.isWolf && !force)) return;
  const e = c.sus[tid] ||= { v: 0, why: '', w: 0 };
  e.v = clamp(e.v + v, 0, 100);
  if (why && v >= e.w) { e.why = why; e.w = v; }
}

export function trust(c, fromId) {
  const like = rel(c, fromId).like;
  let t = clamp((like + 50) / 80, 0.3, 1.3);
  // 人狼を言い当てた実績があるよそ者の話は信じてもらいやすい
  if (fromId === 'player' && wolves().some((w) => w.wolfRevealed && S.wolf.playerAccused.has(w.id))) t += 0.3;
  return t;
}

// プレイヤーが持っている、その人に不利な証拠の強さ（0〜）と説明
export function playerEvidence(t) {
  let score = 0; const why = [];
  for (const e of S.evidence || []) {
    if (e.kind === 'fur' && e.color === hairName(t)) { score += 2; why.push(`現場の${e.color}の毛が${t.name}の髪の色と同じ`); }
    if (e.kind === 'cloth' && e.home === t.home) { score += 1; why.push(`${FAC[e.home].name}で血のついた服が見つかった`); }
  }
  if (S.notes.some((n) => n.text.includes(t.name) && /(夜中|物音|うろつ|出ていく|出ていった|襲われ|顔は)/.test(n.text))) { score += 1; why.push('夜中の目撃・証言がある'); }
  return { score, why };
}

const HAIR_NAMES = { '#2a1c14': '黒', '#4a2e1c': 'こげ茶', '#6e4424': '茶', '#9a6430': '明るい茶', '#c8973c': '金', '#3a3248': '紫がかった黒', '#7a2c24': '赤茶', '#d8d2c8': '白', '#1e2430': '紺がかった黒' };
export function hairName(c) { return HAIR_NAMES[lookFor(c).hair] || '黒'; }

const candidate = (t) => t && t.alive && !t.undiscovered && !t.jailedAsWolf;

export function topSuspect(c) {
  let best = null;
  for (const [id, e] of Object.entries(c.sus || {})) {
    const t = id === 'player' ? S.player : byId(id);
    if (!candidate(t) || t === c) continue;
    if (!best || e.v > best.v) best = { t, v: e.v, why: e.why };
  }
  return best;
}

// 犯罪を見た人は、その人を少し疑う（人狼騒ぎのあと）
export function onCrime(actor, witnesses) {
  if (!S.wolfKnown) return;
  for (const w of witnesses) addSus(w, actor.id, 10, '人に乱暴していた');
}

// ================= 夜の狩り =================
export function hourly(h) {
  if (!S.wolf) return;
  if (h === 3) strangeNight();
  if (h === 1) startHunt();
  if (h === 21) for (const g of residents()) if (g.alive && g.job === 'guard') g.patrolNight = S.rules?.patrol || (S.wolfKnown && chance(0.6)) ? day() : -1;
  if (h === 0) revealIfJailed();
  if (h === 2) tryJailbreak();
  if (h >= 9 && h <= 18) { proposeIfSuspicious(); guardsAct(); }
}

export function patrolling(c) {
  if (c.job !== 'guard' || c.patrolNight == null || c.patrolNight < 0 || isJailed(c)) return false;
  const tod = S.t % 1440;
  return (c.patrolNight === day() && tod >= 21 * 60) || (c.patrolNight === day() - 1 && tod < 2 * 60);
}

function chooseVictim(w) {
  if (S.wolf.playerThreat >= 40 && S.player.alive && !isJailed(S.player) && chance(0.45)) return S.player;
  const cands = residents().filter((o) => o.alive && !o.isWolf && !isJailed(o) && !o.undiscovered);
  if (!cands.length) return null;
  let best = null, bs = -1e9;
  for (const o of cands) {
    // 占い師は邪魔なので狙われやすい（自分を言い当てられていたらなおさら）
    const seerBonus = o.job === 'seer' && S.seer?.announced ? 40 + (S.seer.named || []).filter((id) => byId(id)?.isWolf).length * 40 : 0;
    const s = -rel(w, o).like + sus(o, w.id) * 1.5 + (o.home === w.home ? -40 : 0) + seerBonus + S.rand() * 40;
    if (s > bs) { bs = s; best = o; }
  }
  return best;
}

function startHunt() {
  // 自由に動ける人狼のうち、ひとりが今夜の狩りに出る
  const free = wolves().filter((x) => x.alive && !isJailed(x) && !x.hunt && S.holdId !== x.id);
  const w = free.length ? free[Math.floor(S.rand() * free.length)] : null;
  if (!w || day() < 2) return;
  const p = S.wolf.kills.length ? (S.wolf.lieLow ? 0.2 : 0.55) : day() === 2 ? 0.45 : 0.9;
  S.wolf.lieLow = false;
  if (!chance(p)) return;
  // 家の前に見張りがいると、半分くらいは気づいて今夜は諦める
  const wd = FAC[w.home].door;
  const watcher = S.chars.some((o) => o.alive && o !== w && o.activity === 'watch' && Math.abs(Math.floor(o.x / TILE) - wd[0]) + Math.abs(Math.floor(o.y / TILE) - wd[1]) <= 4);
  if (watcher && chance(0.5)) return;
  const v = chooseVictim(w);
  if (!v) return;
  if (w.companion) Sim.endCompanion(w, false, true);
  Sim.leaveSpot(w);
  w.plan = null; w.path = []; w.activity = 'prowl'; w.busyUntil = S.t + 300;
  w.hunt = { victimId: v.id, stage: 'go', start: S.t, repath: 0, seen: new Set() };
  // 同じ家の人が物音に気づくことがある
  for (const o of residents()) {
    if (o === w || !o.alive || o.home !== w.home || !sleeping(o)) continue;
    if (chance(0.45)) {
      memo(o, `夜中に${w.name}がこっそり家を出ていく物音を聞いた`, 'night');
      addSus(o, w.id, 35, '夜中にこっそり家を出ていった');
    }
  }
}

// ---- まぎらわしい夜：人狼がいてもいなくても起きる（本物か勘違いか、最初は区別できない） ----
function strangeNight() {
  const first = !S.wolf.omen;
  if (!first && !chance(0.22)) return;
  if (first) { if (day() < 2) return; omen(); return; }
  const kind = pick(['howl', 'noise', 'farm']);
  const ears = residents().filter((o) => o.alive && !isJailed(o)).sort(() => S.rand() - 0.5).slice(0, 2);
  const text = { howl: '夜中に獣の遠吠えのような声を聞いた', noise: '夜中に外で何かが動く物音を聞いた', farm: '朝、畑の作物が何かに荒らされていた' }[kind];
  for (const o of ears) memo(o, text, 'night');
  if (kind === 'farm') post('町役場', '畑の作物が何者かに荒らされていました。野良犬でしょうか……？', { authorId: 'town' });
  log(`🌙 ${text.replace(/^夜中に|^朝、/, '')}（${ears.map((o) => o.name).join('・')}）`, 'info');
  // 疑い深い人は、夜に起きていた人や嫌いな人を疑いはじめる
  if (S.wolfKnown) for (const o of ears) {
    if (o.p.aggression + (1 - o.p.honesty) < 0.8) continue;
    const t = residents().filter((x) => x !== o && x.alive && !isJailed(x)).sort((a, b) => rel(o, a).like - rel(o, b).like)[0];
    if (t) addSus(o, t.id, 15, `${text.replace(/を聞いた|ていた$/, '')}ときに、なんとなく${t.name}の顔が浮かんだ`);
  }
}

// 最初の夜：遠吠えの前触れ（人狼がいなくても聞こえる）
function omen() {
  S.wolf.omen = true;
  const p = S.player;
  if (p.alive && !(p.activity === 'sleep' && p.inBed)) toast('🌙 遠くで、獣の遠吠えのような声が聞こえた……');
  const ears = residents().filter((o) => o.alive).sort(() => S.rand() - 0.5).slice(0, 2);
  for (const o of ears) memo(o, '夜中に獣の遠吠えのような声を聞いた', 'night');
  setTimeout(() => post('町役場', '昨夜、獣の遠吠えのような声を聞いたという話が寄せられています。念のため戸締まりを。', { authorId: 'town' }), 500);
}

function goHome(w) {
  w.hunt.stage = 'back';
  Sim.goTo(w, w.bed[0], w.bed[1]);
}

// sim.updateChar から呼ばれる（狩りの最中だけ）
export function step(w, speed) {
  const h = w.hunt;
  watchers(w);
  if (!w.hunt) return;
  if (S.t - h.start > 240 || (hour() >= 5 && hour() < 6)) { finishHunt(w, true); return; }
  if (h.stage === 'go') {
    const v = h.victimId === 'player' ? S.player : byId(h.victimId);
    if (!v || !v.alive || isJailed(v)) { goHome(w); return; }
    if (distTiles(w, v) <= 1.4) { strike(w, v); return; }
    if (!w.path.length || S.t >= h.repath) {
      h.repath = S.t + 5;
      const [tx, ty] = tilePos(v);
      Sim.goTo(w, tx, ty);
      if (w.path.length > 1) w.path.pop();
      if (!w.path.length && distTiles(w, v) > 1.4) { goHome(w); return; }
    }
    Sim.move(w, speed * 1.35);
  } else {
    if (w.path.length) Sim.move(w, speed * 1.35);
    else finishHunt(w, false);
  }
}

function finishHunt(w, teleport) {
  if (teleport || !(Math.floor(w.x / TILE) === w.bed[0] && Math.floor(w.y / TILE) === w.bed[1])) {
    w.x = w.bed[0] * TILE + 16; w.y = w.bed[1] * TILE + 16;
  }
  w.path = []; w.hunt = null;
  w.inBed = true; w.spot = w.bed; w.activity = 'sleep';
  const d = Math.floor(S.t / 1440); const m = d * 1440 + 6 * 60;
  w.busyUntil = (S.t < m ? m : m + 1440) + Math.floor(S.rand() * 40);
}

function strike(w, v) {
  if (v.isPlayer) {
    const asleep = v.activity === 'sleep' && v.inBed;
    v.hp -= asleep ? 55 : 35;
    v.hurtUntil = performance.now() + 600;
    S.effects.push({ type: 'hit', x: v.x, y: v.y, t: 0.6 });
    if (asleep) { v.activity = null; v.busyUntil = S.t; Sim.getOutOfBed(v); }
    S.banner = { title: '🐺 何者かに襲われた！', text: `暗闇の中、獣のような息づかい……一瞬見えたその顔は、${w.name}だった！ 傷は深いが、なんとか追い払った。`, until: performance.now() + 9000 };
    addNote(`夜中に襲われた。暗闇で見えた顔は${w.name}だった！`);
    log('夜中に何者かに襲われた……', 'crime');
    S.wolf.playerSaw = true;
    if (v.hp <= 0) Sim.die(v, '人狼');
    goHome(w);
    return;
  }
  Sim.die(v, '人狼', { silent: true });
  v.undiscovered = true; v.killedBy = w.id;
  S.wolf.kills.push({ id: v.id, t: S.t });
  for (const o of residents()) {
    if (o === w || !o.alive || o.home !== v.home || !sleeping(o)) continue;
    if (chance(0.4)) memo(o, '夜中に物音がして、誰かの黒い影が出ていくのを見た気がする', 'night');
  }
  goHome(w);
}

// 夜中に起きている人が、うろつく人狼を見かける
function watchers(w) {
  const h = w.hunt;
  for (const o of S.chars) {
    if (!o.alive || o === w || isJailed(o) || sleeping(o) || h.seen.has(o.id)) continue;
    const d = distTiles(o, w);
    if (d > 6 || !Sim.canSee(o, w)) continue;
    h.seen.add(o.id);
    const where = locLabel(w);
    if (o.isPlayer) {
      addNote(`${timeStr()}ごろ、夜中なのに${w.name}が${where}を歩いていた`);
      toast(`🌙 こんな夜中に${w.name}が歩いている……`);
      if (d <= 3 && h.stage === 'go') { say(w, '……！'); goHome(w); }
      continue;
    }
    memo(o, `夜中に${w.name}が${where}をうろついているのを見た`, 'night');
    addSus(o, w.id, 45, '夜中にうろついているのを見た');
    if (o.job === 'guard' && d <= 3) {
      say(o, `おい${w.name}、こんな夜中に何をしている！`);
      setTimeout(() => say(w, 'ちょ、ちょっと眠れなくて……'), 900);
      addSus(o, w.id, 20, '夜中に出歩いているところを問いただした');
      if (h.stage === 'go') goHome(w);
    }
  }
}

// ================= 発見・手がかり =================
export function update() {
  if (!S.wolf) return;
  for (const v of S.chars) {
    if (v.alive || !v.undiscovered) continue;
    let finder = null;
    for (const o of S.chars) {
      if (!o.alive || o === v || isJailed(o) || sleeping(o) || o.hunt) continue;
      if (distTiles(o, v) <= 5 && Sim.canSee(o, v)) { finder = o; break; }
    }
    const h = hour();
    if (!finder && !(h >= 9 && h < 22)) continue;
    discoverBody(v, finder);
  }
  meetingTick();
}

function makeClue(v, w) {
  const [vx, vy] = tilePos(v);
  const f = facAt(vx, vy);
  if (!f || !f.home) return null;
  const wh = FAC[w.home];
  const fur = hairName(w);
  if (wh === f) return { fac: f.id, fur, text: `${f.name}の戸口に、外から押し入った跡がない……。家の中にいた誰かの仕業かもしれない。` };
  const n = Math.round(Math.abs(wh.x - f.x) / 7);
  const dir = wh.x > f.x ? '東' : '西';
  return { fac: f.id, text: `${f.name}の前から、泥まじりの大きな足あとが${dir}へ続いている。${n <= 1 ? 'すぐ隣の家' : `${n}軒${dir}の家`}（${wh.name}）の前で途切れていた。`, home: wh.id, fur };
}

function discoverBody(v, finder) {
  v.undiscovered = false;
  S.wolfKnown = true;
  const [vx, vy] = tilePos(v);
  const f = facAt(vx, vy);
  const w = byId(v.killedBy) || wolfChar();
  if (finder) {
    if (finder.isPlayer) toast(`☠ ${v.name}が倒れている……！`);
    else say(finder, `${pick(['きゃああ！', 'う、うそだろ……！', 'ひっ……！'])} ${v.name}が……！`, 6);
  }
  const first = S.wolf.kills.length <= 1;
  Town.onWolfKnown();
  log(`${v.name}が${f ? f.name : '町'}で無残な姿で見つかった。獣の爪のような傷がある……`, 'death');
  post('町役場', `【訃報】${v.name}さんが${f ? f.name : '町'}で亡くなっているのが見つかりました。獣に引き裂かれたような傷があります。${first ? '町では「人狼」のしわざだという噂が広がっています。' : '人狼の犠牲者は' + S.wolf.kills.length + '人になりました。'}`, { authorId: 'town' });
  S.banner = first
    ? { title: '☠ この町に人狼がいる……！', text: `${v.name}が${f ? f.name : '町'}で無残な姿で見つかった。住民の誰かが人狼かもしれない。現場を調べたり（建物の中でF）、聞き込みをしたり、話し合いを呼びかけて人狼を突き止めよう。`, until: performance.now() + 11000 }
    : { title: `☠ また犠牲者が……`, text: `${v.name}が襲われた。人狼はまだ町の中にいる。`, until: performance.now() + 8000 };
  addNote(`${v.name}が${f ? f.name : '町'}で死んでいるのが見つかった（${S.wolf.kills.length}人目）`);
  Seer.onInnocent(v);
  for (const o of residents()) {
    if (!o.alive) continue;
    memo(o, `${v.name}が人狼に殺された`, 'crime');
    if (o !== w) for (const x of residents()) if (x.alive && x !== o) addFear(o, x, 3);
  }
  const clue = makeClue(v, w);
  if (clue) S.clues[clue.fac] = clue;
  // 罪をなすりつける相手を決める
  if (!S.wolf.frame || !candidate(byId(S.wolf.frame))) {
    const cands = residents().filter((o) => o.alive && !o.isWolf && o.home !== w.home && !o.jailedAsWolf);
    cands.sort((a, b) => rel(w, a).like - rel(w, b).like);
    if (cands[0]) { S.wolf.frame = cands[0].id; addSus(w, cands[0].id, 50, '夜中に出歩いているのを見た気がする', true); }
  }
  // 牢屋に閉じ込めていた人は無実だった
  for (const o of residents()) {
    if (o.jailedAsWolf && !o.isWolf) {
      o.jailedAsWolf = false; o.jailedUntil = S.t; Seer.onInnocent(o);
      for (const x of residents()) if (x.sus?.[o.id]) x.sus[o.id].v = 0;
      post('町役場', `牢屋に閉じ込められていた${o.name}さんは人狼ではありませんでした。釈放されます。`, { authorId: 'town' });
      log(`牢屋にいたのに事件が起きた。${o.name}は無実だった……`, 'event');
      addNote(`${o.name}は牢屋にいたのに事件が起きた → ${o.name}は人狼ではない`);
    }
  }
  if (S.player.jailedAsWolf) {
    S.player.jailedAsWolf = false; S.player.jailedUntil = S.t;
    for (const x of residents()) if (x.sus?.player) x.sus.player.v = 0;
    toast('あなたの無実が証明され、牢屋から出された。');
  }
  // 衛兵は現場を調べる
  for (const g of residents()) {
    if (!g.alive || g.job !== 'guard' || isJailed(g) || !clue) continue;
    if (!g.isWolf && clue.home && chance(0.65)) {
      for (const o of residents()) if (o.alive && o.home === clue.home && o !== g) addSus(g, o.id, 25, `足あとが${FAC[clue.home].name}の前で途切れていた`);
      memo(g, `現場の足あとが${FAC[clue.home].name}の前で途切れていた`, 'night');
    }
  }
  const alive = residents().filter((o) => o.alive).length;
  if (alive <= 3) { S.over = true; S.gameOverReason = '町の住民はほとんど人狼に襲われてしまった……'; return; }
  // 誰かが話し合いを言い出す
  const leaders = residents().filter((o) => o.alive && !isJailed(o)).sort((a, b) => leaderScore(b) - leaderScore(a));
  if (leaders[0]) scheduleMeeting(leaders[0].id, 120, 'death');
}

function leaderScore(o) { return o.p.sociability + o.p.honesty * 0.6 + (o.job === 'guard' ? 0.4 : 0) + (o.job === 'mayor' ? 1.5 : 0) + S.rand() * 0.3; }

export function investigate(fid) {
  const c = S.clues[fid];
  if (!c) return null;
  addNote(`現場の手がかり：${c.text}`);
  let text = c.text;
  if (c.fur && !S.evidence.some((e) => e.kind === 'fur' && e.fac === fid)) {
    S.evidence.push({ kind: 'fur', color: c.fur, fac: fid, label: `獣の毛（${c.fur}色・${FAC[fid].name}で発見）` });
    addNote(`現場に${c.fur}色の獣の毛が落ちていた。人狼の髪の色と同じはず……`);
    text += `　さらに、寝床のそばに${c.fur}色の獣の毛が落ちていた（証拠として拾った）。`;
  }
  return text;
}

// 家の中を調べる（人狼の家なら血のついた服が見つかる）
export function searchHouse(fid) {
  const w = wolves().find((x) => x.home === fid);
  if (w && w.home === fid && S.wolf.kills.length && !S.evidence.some((e) => e.kind === 'cloth')) {
    S.evidence.push({ kind: 'cloth', home: fid, label: `血のついた服（${FAC[fid].name}で発見）` });
    addNote(`${FAC[fid].name}の物入れの奥に、血のついた服が隠してあった！ この家の誰かが……`);
    return `物入れの奥に、血のついた服が隠してあった！（証拠として持ち出した）`;
  }
  return '怪しいものは見つからなかった。';
}

// 人狼は普通の攻撃では死なない。銀のナイフだけが効く
export function adjustDamage(a, b, dmg) {
  if (!b.isWolf) return dmg;
  if (a.items.includes('silver')) return dmg * 3;
  return Math.min(dmg, Math.max(0, b.hp - 5));
}

// 正体がばれた人狼は、夜に牢屋を破ることがある
function tryJailbreak() {
  const w = wolves().find((x) => x.alive && x.wolfRevealed && isJailed(x));
  if (!w) return;
  if (!chance(S.rules?.patrol ? 0.06 : 0.2)) return;
  w.jailedUntil = S.t; w.jailedAsWolf = false;
  S.wanted.add(w.id);
  S.banner = { title: '🐺 牢屋が破られた！', text: `鉄格子がねじ曲げられ、${w.name}の姿が消えていた……。人狼はまだ生きている。銀のナイフでなければ倒せない。`, until: performance.now() + 10000 };
  post('町役場', `【緊急】牢屋が破られ、人狼の${w.name}が逃げ出しました。見かけたらすぐに知らせてください。`, { authorId: 'town' });
  log(`人狼の${w.name}が牢屋を破って逃げ出した！`, 'crime');
  addNote(`人狼の${w.name}が牢屋を破って逃げた。倒すには銀のナイフ（工房）がいる`);
}

function revealIfJailed() {
  for (const w of wolves()) if (w.alive && !w.wolfRevealed && isJailed(w) && w.jailedAsWolf) reveal('jail', w);
}

export function reveal(how, w = wolfChar()) {
  if (!w || w.wolfRevealed) return;
  w.wolfRevealed = true;
  S.wolf.confirmed = allWolvesDone();
  Seer.onReveal(w);
  const text = how === 'jail' ? `真夜中、牢屋から獣の遠吠えが響いた。牢の中の${w.name}は、毛むくじゃらの獣の姿に変わっていた……！`
    : `倒れた${w.name}の体が、みるみる獣の姿に変わっていった……！`;
  const more = !S.wolf.confirmed || S.wolf.hidden;
  S.banner = { title: `🐺 ${w.name}の正体は人狼だった！`, text: text + (more ? ' ……でも、人狼はひとりとは限らない。' : ' 町に平和が戻りそうだ。'), until: performance.now() + 12000 };
  post('町役場', `【号外】${w.name}の正体は人狼でした。${text}`, { authorId: 'town' });
  log(`${w.name}の正体は人狼だった！`, 'event');
  addNote(`${w.name}の正体は人狼だった！`);
  for (const o of residents()) {
    if (!o.alive || o === w) continue;
    memo(o, `${w.name}の正体は人狼だった`, 'crime');
    addLike(o, w, -100);
    if (S.wolf.playerAccused.has(w.id)) addLike(o, S.player, 20);
  }
  if (S.wolf.playerAccused.has(w.id)) Town.payBounty();
  w.jailedUntil = S.t + LIFE;
  // 疑われて牢屋にいた人は釈放
  for (const o of [...residents(), S.player]) {
    if (o !== w && o.jailedAsWolf) { o.jailedAsWolf = false; o.jailedUntil = S.t; addNote(`${dn(o)}は無実だったので釈放された`); }
  }
}

// ================= 衛兵・疑いが強い住民の行動 =================
function guardsAct() {
  for (const g of residents()) {
    if (!g.alive || g.job !== 'guard' || isJailed(g) || g.hunt || g.plan?.kind === 'wolfArrest') continue;
    if (!S.wolfKnown || S.t - (g.lastWolfArrest || -9999) < 8 * 60) continue;
    const top = topSuspect(g);
    if (!top || top.v < (g.isWolf ? 45 : 75) || isJailed(top.t)) continue;
    g.lastWolfArrest = S.t;
    say(g, `${dn(top.t)}、人狼の件で話がある。来てもらおう`);
    Sim.setPlan(g, { targetId: top.t.id, kind: 'wolfArrest', giveUpAt: S.t + 150 });
    g.activity = 'follow'; g.busyUntil = S.t + 150;
  }
}

export function arrestSuspect(g, t) {
  if (!t.alive || isJailed(t)) return;
  Sim.jail(t, LIFE);
  t.jailedAsWolf = true;
  say(g, '人狼の疑いで、牢屋に入ってもらう！', 5);
  say(t, t.isWolf ? 'ちっ……' : 'ち、違う！ 俺じゃない！', 5);
  log(`衛兵の${g.name}が、人狼の疑いで${dn(t)}を牢屋に入れた。`, 'event');
  post(g.name, `人狼の疑いで${dn(t)}を牢屋に入れた。しばらく様子を見る。`, { authorId: g.id });
  addNote(`衛兵の${g.name}が、人狼の疑いで${dn(t)}を牢屋に入れた`);
  if (t.isPlayer) toast('人狼の疑いで牢屋に入れられた！ 無実が証明されるまで出られない……');
  if (!t.isWolf) S.wolf.lieLow = true;
}

function proposeIfSuspicious() {
  if (!S.wolfKnown || (S.meeting && S.meeting.state !== 'done') || S.t - S.lastMeetingEnd < 6 * 60) return;
  for (const c of residents()) {
    if (!c.alive || isJailed(c) || sleeping(c)) continue;
    const top = topSuspect(c);
    if (top && top.v >= 60 && chance(0.35)) { scheduleMeeting(c.id, 90, 'suspect'); return; }
  }
}

// ================= 住民どうしの噂 =================
export function chatLines(a, b) {
  if (!S.wolfKnown || chance(0.35)) return null;
  const top = topSuspect(a);
  if (!top || top.v < 30) return [pick(['人狼、ほんとにいるのかな……', '夜が怖いよ。', '次は誰が狙われるんだろう。']), pick(['戸締まりはしっかりしないとね。', '怖いね……', '早く捕まってほしいよ。'])];
  const t = top.t;
  addSus(b, t.id, top.v * 0.25 * trust(b, a.id), `${a.name}が「${top.why}」と言っていた`);
  const la = `${nm(a, t)}が怪しいと思うんだ。${top.why}から。`;
  let lb;
  if (t === b) { lb = '……え、私を疑ってるの！？'; addLike(b, a, -10); }
  else if (b.isWolf) lb = pick(['そうかもしれないね……', 'やっぱりそうだよね。']);
  else lb = sus(b, t.id) >= 40 ? 'やっぱり……私もそう思ってた。' : 'うーん、そうなのかな……';
  return [la, lb];
}

// ================= 話し合い（自由に呼びかけられる） =================
const RING = [[24, 16], [25, 16], [26, 16], [27, 16], [23, 17], [28, 17], [23, 18], [28, 18], [24, 19], [25, 19], [26, 19], [27, 19], [23, 16], [28, 16], [23, 19], [28, 19]];

export function meetingActive() { return S.meeting && S.meeting.state !== 'done'; }

// 選挙で、o が候補 id をどれだけ推すか（好感度・信頼・町をまとめる力）
function score(o, id) {
  const t = id === 'player' ? S.player : byId(id);
  return rel(o, id).like + trust(o, id) * 20 + (t.isPlayer ? 0 : Town.ambition(t) * 15) + (t.job === 'mayor' ? 5 : 0) + S.rand() * 10;
}

// よそ者の側につくと約束した住民（投票をよそ者に合わせる）
const isAlly = (o) => o.ally && S.t < o.ally.until;

// ================= 処遇の話し合い（悪いことをした住民をどうするか） =================
const CRIME_WORDS = /(盗|殴|襲|忍び込|乱暴|脅|くすね|無実の)/;
// 「〜を働く」→「〜を働いた」のように、した事の言い方にそろえる
const past = (s) => s.replace(/働く$/, '働いた').replace(/入る$/, '入った').replace(/殴る$/, '殴った').replace(/かかる$/, 'かかった').replace(/脅す$/, '脅した').replace(/くすねる$/, 'くすねた');
// o が覚えている、t がした悪いこと（見た／自分がやられた）。{ text: 「ハルに盗みを働いた」, victim }
export function crimesOf(o, t) {
  if (!o || !t || o === t) return [];
  const out = [];
  const tn = t.isPlayer ? 'よそ者' : t.name;   // 住民の記憶では、あなたは「よそ者」
  for (const raw of o.memory) {
    const m = raw.replace(/^\d+日目 /, '');
    if (m.includes('人狼') || !CRIME_WORDS.test(m)) continue;
    if (m.startsWith(`${tn}が`)) out.push({ text: past(m.slice(tn.length + 1).replace(/のを見た$/, '')), victim: false });
    else if (m.startsWith(`${tn}に`) && /(盗まれ|殴られ|襲われ|脅され|無実の罪)/.test(m)) out.push({ text: `${o.name}に${/盗/.test(m) ? '盗みを働いた' : /脅/.test(m) ? '脅しをかけた' : '乱暴した'}`, victim: true });
  }
  return out;
}
// 町のだれかが知っている、t の悪いこと
export function knownCrimes(t) {
  const set = new Set();
  for (const o of residents()) if (o.alive) for (const x of crimesOf(o, t)) set.add(x.text);
  return [...set];
}
const TRIAL_NAME = { jail: '牢屋に1日入れる', fine: '罰金5Gを町の金庫へ', forgive: '今回は許す' };
export const trialTitle = (tr) => `${byId(tr.targetId)?.name || 'よそ者'}の処遇`;

function addTrial(m, trial) {
  if (!trial || m.trials.some((x) => x.targetId === trial.targetId)) return;
  m.trials.push(trial);
}

export function scheduleMeeting(orgId, delayMin, reason, rule = null, trial = null) {
  if (meetingActive()) {
    if (rule && !S.meeting.agenda.some((a) => a.rule.key === rule.key)) {
      S.meeting.agenda.push({ rule, proposer: orgId });
      addNote(`次の話し合いの議題に「${Town.describe(rule)}」が加わった`);
    }
    if (trial && !S.meeting.trials.some((x) => x.targetId === trial.targetId)) {
      addTrial(S.meeting, trial);
      addNote(`次の話し合いの議題に「${trialTitle(trial)}」が加わった`);
    }
    return S.meeting;
  }
  let at = S.t + delayMin;
  const tod = at % 1440;
  if (tod < 8 * 60) at += 8 * 60 - tod;
  else if (tod > 20 * 60) at += 24 * 60 - tod + 8 * 60;
  const org = orgId === 'player' ? S.player : byId(orgId);
  S.meeting = { at, org: orgId, reason, state: 'planned', present: [], queue: [], log: [], nextReal: 0, playerIn: false, votes: null, result: null, agenda: [], trials: [] };
  if (rule) S.meeting.agenda.push({ rule, proposer: orgId });
  if (trial) addTrial(S.meeting, trial);
  if (reason === 'election') S.electionDue = true;
  // 人狼の事件のあと、村長は夜間外出禁止を議題にする
  const may = Town.mayor();
  if (reason === 'death' && may && !S.rules.curfew) S.meeting.agenda.push({ rule: { key: 'curfew', value: true }, proposer: may.id });
  else if (reason === 'death' && may && !S.rules.patrol && S.wolf.kills.length >= 2) S.meeting.agenda.push({ rule: { key: 'patrol', value: true }, proposer: may.id });
  const hh = Math.floor((at % 1440) / 60);
  const dayWord = Math.floor(at / 1440) + 1 === day() ? '今日' : '明日';
  const why = (reason === 'death' ? '人狼のことを話し合いたい。' : reason === 'suspect' ? '人狼が誰なのか、みんなで話し合おう。'
    : trial ? `${byId(trial.targetId)?.name || 'よそ者'}のしたことについて、どうするかみんなで決めたい。` : reason === 'election' ? '村長を選ぶ選挙をしたい。' : '話し合いたいことがある。')
    + (S.meeting.agenda.length ? `議題：${S.meeting.agenda.map((a) => Town.describe(a.rule)).join('、')}` : '');
  post(org.isPlayer ? 'あなた' : org.name, `【呼びかけ】${dayWord}${hh}時、広場の噴水の前に集まってほしい。${why}`, { authorId: orgId });
  log(`${dn(org)}が${dayWord}${hh}時に広場での話し合いを呼びかけた。`, 'event');
  toast(`📣 ${org.isPlayer ? 'あなた' : org.name}の呼びかけで、${dayWord}${hh}時に広場で話し合いが開かれる`);
  addNote(`${dayWord}${hh}時に広場で話し合い（${dn(org)}の呼びかけ）`);
  for (const c of residents()) if (c.alive) { c.meetingGo = null; memo(c, `${dn(org)}が${hh}時に広場での話し合いを呼びかけた`, 'meeting'); }
  return S.meeting;
}

function wantsToGo(c, m) {
  if (c.meetingGo != null) return c.meetingGo;
  if (c.id === m.org) return (c.meetingGo = true);
  // 悪いことを見た人は、処遇の話し合いにかならず来る。それ以外も、事件があれば集まりやすい
  if ((m.trials || []).some((tr) => crimesOf(c, byId(tr.targetId)).length)) return (c.meetingGo = true);
  const base = (S.wolfKnown ? 0.55 : 0.2) + ((m.trials || []).length ? 0.3 : 0) + c.p.sociability * 0.35 + (c.isWolf ? 0.4 : 0) + (m.org === 'player' ? (rel(c, 'player').like / 200) : 0);
  return (c.meetingGo = chance(base));
}

function meetingTick() {
  const m = S.meeting;
  if (!m || m.state === 'done') return;
  if (m.state === 'planned' && S.t >= m.at - 40) {
    m.state = 'gathering';
    toast('📣 広場に人が集まりはじめた。話し合いに参加するなら噴水の前へ！');
    let i = 0;
    for (const c of residents()) {
      if (!c.alive || isJailed(c) || c.hunt || c.companion || sleeping(c) || !wantsToGo(c, m)) continue;
      const t = RING[i++ % RING.length];
      Sim.setPlan(c, { place: 'plaza', tile: t, act: 'meeting' });
    }
  }
  if (m.state === 'gathering' && S.t >= m.at) {
    const inPlaza = (c) => { const [x, y] = tilePos(c); return x >= PLAZA.x - 1 && x <= PLAZA.x + PLAZA.w && y >= PLAZA.y - 1 && y <= PLAZA.y + PLAZA.h; };
    const present = residents().filter((c) => c.alive && !isJailed(c) && inPlaza(c));
    if (present.length < 3) {
      if (S.t < m.at + 40) return;
      endMeeting('人が集まらず、話し合いは流れた。');
      return;
    }
    m.present = present.map((c) => c.id);
    m.playerIn = inPlaza(S.player) && S.player.alive && !isJailed(S.player);
    m.state = 'talking';
    buildQueue(m, present);
    if (!m.playerIn) { while (m.queue.length) speakNext(m); finishTalk(m); }
    else { S.meetingPause = true; m.nextReal = performance.now() + 800; }
  }
  if (m.state === 'talking' && m.playerIn && m.ruleWait) {
    if (performance.now() < m.ruleWait.deadline) return;
    m.ruleWait.item.playerVote = 'abstain';
    m.ruleWait = null;
  }
  if (m.state === 'talking' && m.playerIn && performance.now() >= m.nextReal) {
    if (['ruleVote', 'trialVote', 'electionVote'].includes(m.queue[0]?.type) && !m.queue[0].playerVote) {
      m.ruleWait = { item: m.queue[0], deadline: performance.now() + 25000 };
      return;
    }
    if (m.queue.length) { const line = speakNext(m); m.nextReal = performance.now() + 1600 + (line?.length || 10) * 45; }
    else if (!S.wolfKnown) finishTalk(m);
    else {
      m.state = 'voting';
      const org = presentChars(m)[0];
      addLine(m, org, pol(org) ? 'そろそろ決めましょう。誰を牢屋に入れるか、投票です。' : 'そろそろ決めよう。誰を牢屋に入れるか、投票だ。');
    }
  }
}

function finishTalk(m) {
  if (S.wolfKnown) vote(null);
  else endMeeting('話し合いが終わった。');
}

function presentChars(m) {
  const org = m.org === 'player' ? null : byId(m.org);
  const list = m.present.map(byId).filter((c) => c && c.alive);
  if (org && list.includes(org)) return [org, ...list.filter((c) => c !== org)];
  return list;
}

let polisher = null;
export function setPolisher(fn) { polisher = fn; }

function addLine(m, c, text, cls = '') {
  const entry = { who: c ? c.name : '', text, cls, id: c?.id };
  m.log.push(entry);
  if (c) say(c, text, 5);
  // 高性能AIがあれば、その人らしい言い回しに整える
  if (c && polisher && m.playerIn) polisher(c, text).then((t) => { if (t) { entry.text = t; m.rev = (m.rev || 0) + 1; say(c, t, 5); } }).catch(() => {});
}

function buildQueue(m, present) {
  const list = presentChars(m);
  const opener = list[0];
  const victims = S.wolf.kills.map((k) => byId(k.id)?.name).filter(Boolean);
  m.queue.push({ type: 'open', c: opener, victims });
  // 法律の決め方がまだない町では、ほかの決まりより先に「決め方」を決める
  if (!S.rules.method && m.agenda.length && !m.agenda.some((a) => a.rule.key === 'method')) m.agenda.unshift({ rule: { key: 'method', value: 'standard' }, proposer: m.agenda[0].proposer });
  for (const a of m.agenda) m.queue.push({ type: 'rule', rule: a.rule, proposer: a.proposer, c: byId(a.proposer) && list.includes(byId(a.proposer)) ? byId(a.proposer) : opener });
  if (S.electionDue && S.rules.mayorOffice) m.queue.push({ type: 'election', c: opener });
  for (const tr of m.trials || []) m.queue.push({ type: 'trial', targetId: tr.targetId, proposer: tr.proposer, c: byId(tr.proposer) && list.includes(byId(tr.proposer)) ? byId(tr.proposer) : opener });
  if (!S.wolfKnown) return;
  const order = list.slice(1).sort(() => S.rand() - 0.5);
  for (const c of [opener, ...order]) m.queue.push({ type: 'say', c });
}

function speakNext(m) {
  const item = m.queue.shift();
  if (!item) return null;
  const c = item.c;
  if (!c || !c.alive) return '';
  let text = '';
  if (item.type === 'open') {
    if ((m.trials || []).length && !item.victims.length) text = pol(c) ? `集まってくれてありがとうございます。今日は${m.trials.map((tr) => nm(c, byId(tr.targetId) || S.player)).join('、')}のしたことについて、どうするか決めたいと思います。`
      : `集まってくれてありがとう。今日は${m.trials.map((tr) => nm(c, byId(tr.targetId) || S.player)).join('、')}のしたことについて、どうするか決めたい。`;
    else if (m.org === 'player') text = pol(c) ? 'よそ者の方の呼びかけで集まりました。何か話があるそうです。' : 'よそ者の呼びかけで集まった。話があるらしいな。';
    else if (item.victims.length) text = pol(c) ? `集まってくれてありがとうございます。${item.victims.join('さん、')}さんを襲った人狼が、この中にいるかもしれません。みんなの考えを聞かせてください。`
      : `集まってくれてありがとう。${item.victims.join('、')}を襲った人狼が、この中にいるかもしれない。みんなの考えを聞かせてくれ。`;
    else text = pol(c) ? '集まってくれてありがとうございます。みんなで話し合いましょう。' : 'みんな、集まってくれてありがとう。話し合おう。';
  } else if (item.type === 'say') {
    const top = topSuspect(c);
    const night = nightTestimony(c);
    if (night && !c.isWolf && !(m.told ||= new Set()).has(c.id)) {
      // 見たこと・聞いたことをみんなに話す
      m.told.add(c.id);
      text = pol(c) ? `実は……${night.text}んです。` : `実は……${night.text}んだ。`;
      const named = residents().find((o) => night.text.includes(o.name) && o !== c);
      if (named) {
        for (const id of m.present) { const o = byId(id); if (o && o !== c && o !== named) addSus(o, named.id, 22 * trust(o, c.id), `${c.name}が「${night.text}」と話していた`); }
        if (m.present.includes(named.id) && !m.replied?.has(named.id)) { (m.replied ||= new Set()).add(named.id); m.queue.unshift({ type: 'defend', c: named, by: c }); }
      }
    } else if (top && top.v >= 25) {
      text = pol(c) ? `私は${nm(c, top.t)}が怪しいと思います。${top.why}からです。` : `${firstPerson(c)}は${nm(c, top.t)}が怪しいと思う。${top.why}から。`;
      for (const id of m.present) { const o = byId(id); if (o && o !== c) addSus(o, top.t.id, top.v * 0.2 * trust(o, c.id), `話し合いで${c.name}が「${top.why}」と言っていた`); }
      if (top.t.isPlayer) S.wolf.playerThreat += 0;
      if (m.present.includes(top.t.id) && !m.replied?.has(top.t.id)) {
        (m.replied ||= new Set()).add(top.t.id);
        m.queue.unshift({ type: 'defend', c: top.t, by: c });
      }
    } else {
      text = pick(pol(c) ? ['私には、まだ誰とも言えません……。', 'わかりません。でも、怖いです。'] : ['まだ誰とも言えないな……。', 'わからない。でも、この中にいるなんて信じたくない。']);
    }
  } else if (item.type === 'defend') {
    const by = item.by;
    if (c.isWolf) {
      const f = byId(S.wolf.frame);
      text = f && f !== by && candidate(f) ? `${firstPerson(c)}を疑うの？ それより${nm(c, f)}の方が怪しいよ。夜中に出歩いているのを見た気がするんだ。`
        : `${firstPerson(c)}が？ 冗談はやめてくれ。何の証拠があるんだ。`;
      if (f && candidate(f)) for (const id of m.present) { const o = byId(id); if (o && o !== c && o !== f) addSus(o, f.id, 8 * trust(o, c.id), `${c.name}が「${f.name}が夜中に出歩いていた」と言っていた`); }
    } else text = pick([`ち、違う！ ${firstPerson(c)}は人狼なんかじゃない！`, `${firstPerson(c)}じゃない！ 信じてくれ！`, 'ひどい……私じゃないのに。']);
  } else if (item.type === 'react') {
    text = item.text;
  } else if (item.type === 'rule') {
    const d = Town.describe(item.rule);
    text = item.proposer === 'player' ? `よそ者から「${d}」という提案があった。みんな、どう思う？`
      : pol(c) ? `ひとつ提案があります。「${d}」にしたいと思います。賛成か反対か、聞かせてください。` : `提案がある。「${d}」にしたいと思う。賛成か反対か、聞かせてくれ。`;
    m.queue.unshift({ type: 'ruleVote', rule: item.rule, proposer: item.proposer, c });
  } else if (item.type === 'election') {
    // 村長の選挙：今の村長・立候補したあなた・町をまとめたい住民が候補
    const present = presentChars(m);
    const may = Town.mayor();
    const cands = [];
    if (may && (may.isPlayer ? m.playerIn : present.includes(may))) cands.push(may.id);
    if (S.playerCandidate && m.playerIn && !cands.includes('player')) cands.push('player');
    for (const o of present.filter((o) => !cands.includes(o.id)).sort((a, b) => Town.ambition(b) - Town.ambition(a))) {
      if (cands.length >= 3) break;
      if (Town.ambition(o) >= 0.55 || cands.length < 2) cands.push(o.id);
    }
    const names = cands.map((id) => (id === 'player' ? 'よそ者' : byId(id).name));
    text = pol(c) ? `村長を選ぶ選挙をします。立候補は${names.join('、')}です。` : `村長の選挙をやるぞ。立候補は${names.join('、')}だ。`;
    for (const id of cands) { const o = id === 'player' ? null : byId(id); if (o && o !== c) m.queue.unshift({ type: 'react', c: o, text: pol(o) ? 'この町のために、精一杯つとめます。' : '俺に任せてくれれば、町をよくしてみせる。' }); }
    m.queue.push({ type: 'electionVote', cands, c });
  } else if (item.type === 'electionVote') {
    const cands = item.cands;
    const tally = Object.fromEntries(cands.map((id) => [id, []]));
    for (const id of m.present) {
      const o = byId(id);
      if (!o || !o.alive) continue;
      let pickId;
      if (cands.includes(o.id)) pickId = o.id;
      else if (isAlly(o) && m.playerIn && tally[item.playerVote]) pickId = item.playerVote;
      else pickId = cands.slice().sort((a, b) => score(o, b) - score(o, a))[0];
      tally[pickId].push(o.name);
    }
    if (m.playerIn && tally[item.playerVote]) tally[item.playerVote].push('あなた');
    m.log.push({ who: '', text: cands.map((id) => `${id === 'player' ? 'よそ者' : byId(id).name}：${tally[id].length}票`).join('／'), cls: 'vote' });
    const enough = m.present.length + (m.playerIn ? 1 : 0) >= Town.quorum();
    const best = cands.slice().sort((a, b) => tally[b].length - tally[a].length)[0];
    if (!enough) text = `参加者が住民の半分に足りず、選挙は成立しなかった。`;
    else { Town.setMayor(best); text = `${tally[best].length}票で、${best === 'player' ? 'よそ者（あなた）' : byId(best).name}が村長に選ばれた！`; }
    S.electionDue = false; S.playerCandidate = false;
    m.log.push({ who: '', text, cls: 'result' });
    return text;
  } else if (item.type === 'trial') {
    const t = byId(item.targetId) || S.player;
    const crimes = knownCrimes(t);
    const what = crimes[0] || '悪いことをした';
    if (crimesOf(c, t).length) (m.trialHeard ||= new Set()).add(t.id);   // 見た人が話したので、みんな本当だと思う
    text = item.proposer === 'player' ? (pol(c) ? `よそ者の方から、${nm(c, t)}が${what}という話がありました。どうするか決めましょう。` : `よそ者から、${nm(c, t)}が${what}って話があった。どうするか決めよう。`)
      : pol(c) ? `${nm(c, t)}が${what}ようです。どうするか、みんなで決めましょう。` : `${nm(c, t)}が${what}らしい。どうするか、みんなで決めよう。`;
    // 見た人の証言 → 本人の言い分 → 採決
    const next = [];
    for (const id of m.present) {
      const o = byId(id);
      if (!o || o === c || o === t || !crimesOf(o, t).length) continue;
      next.push({ type: 'trialWit', c: o, targetId: t.id });
      if (next.length >= 3) break;
    }
    if (m.present.includes(t.id)) next.push({ type: 'trialDefend', c: t });
    next.push({ type: 'trialVote', targetId: t.id, proposer: item.proposer, c });
    m.queue.unshift(...next);
  } else if (item.type === 'trialWit') {
    const t = byId(item.targetId) || S.player;
    const cr = crimesOf(c, t)[0] || { text: '', victim: false };
    text = cr.victim ? (pol(c) ? `被害にあったのは私です。${nm(c, t)}に盗られたんです。` : `やられたのは${firstPerson(c)}だよ。${nm(c, t)}にな。`)
      : pol(c) ? `私も見ました。${nm(c, t)}が${cr.text}ところを。` : `${firstPerson(c)}も見たよ。${nm(c, t)}が${cr.text}ところをな。`;
    (m.trialHeard ||= new Set()).add(t.id);
  } else if (item.type === 'trialDefend') {
    text = pick(c.p.honesty > 0.6 ? (pol(c) ? ['……申し訳ありませんでした。もうしません。', '出来心だったんです。許してください。'] : ['……悪かったよ。もうしない。', '出来心だったんだ。許してくれ。'])
      : (pol(c) ? ['そんなこと、していません！', '誤解です。私じゃありません。'] : ['そんなことしてない！', '言いがかりだ。証拠はあるのか？']));
    c.trialHonest = c.p.honesty > 0.6;
  } else if (item.type === 'trialVote') {
    const t = byId(item.targetId) || S.player;
    const tally = { jail: [], fine: [], forgive: [] };
    for (const id of m.present) {
      const o = byId(id);
      if (!o || !o.alive) continue;
      if (o === t) { tally.forgive.push(o.name); continue; }
      if (isAlly(o) && m.playerIn && tally[item.playerVote]) { tally[item.playerVote].push(o.name); continue; }
      const mine = crimesOf(o, t);
      const saw = mine.length > 0;
      if (mine.some((x) => x.victim)) { tally[o.p.aggression > 0.5 || o.p.honesty > 0.5 ? 'jail' : 'fine'].push(o.name); continue; }   // やられた本人
      const heard = m.trialHeard?.has(t.id);
      const sev = saw ? 1 : heard ? 0.7 : 0.35;
      const like = rel(o, t.isPlayer ? 'player' : t.id).like;
      const anger = sev * (0.45 + o.p.honesty * 0.45) + o.p.aggression * 0.2 - like / 140 - (t.trialHonest ? 0.15 : 0) + (m.trialShift || 0) * trust(o, 'player');
      tally[anger > 0.72 && S.rules.jail ? 'jail' : anger > 0.4 ? 'fine' : 'forgive'].push(o.name);
    }
    const pv = item.playerVote;
    if (m.playerIn && tally[pv]) tally[pv].push('あなた');
    m.trialShift = 0;
    m.log.push({ who: '', text: `牢屋：${tally.jail.join('、') || 'なし'}／罰金：${tally.fine.join('、') || 'なし'}／許す：${tally.forgive.join('、') || 'なし'}`, cls: 'vote' });
    // 罰したい人（牢屋＋罰金）が許す人より多ければ罰する。牢屋と罰金が同数なら軽い罰金
    const punish = tally.jail.length + tally.fine.length;
    let best = punish > tally.forgive.length ? (tally.jail.length > tally.fine.length ? 'jail' : 'fine') : 'forgive';
    if (best === 'jail' && !S.rules.jail) best = 'fine';   // 牢屋を使わない町では罰金にする
    const tn = dn(t);
    if (best === 'jail') { Sim.jail(t, 24 * 60); S.wanted.delete(t.id); text = `${tally.jail.length}票で、${tn}を牢屋に1日入れることになった。`; }
    else if (best === 'fine') { const n = Math.min(5, Math.floor(t.coins)); t.coins -= n; S.treasury += n; text = `${tally.fine.length}票で、${tn}は罰金${n}Gを町の金庫に払うことになった。`; }
    else text = `${tally.forgive.length}票で、${tn}は今回は許されることになった。`;
    for (const id of m.present) { const o = byId(id); if (o && o !== t) memo(o, `話し合いで${tn}の処遇が決まった（${TRIAL_NAME[best]}）`, 'meeting'); }
    if (best !== 'forgive' && !t.isPlayer) addLike(t, S.player, item.proposer === 'player' ? -15 : -5);
    if (t.isPlayer && best !== 'forgive') toast(best === 'jail' ? '話し合いの結果、あなたは牢屋に1日入れられた……' : '話し合いの結果、罰金を払わされた……');
    m.log.push({ who: '', text, cls: 'result' });
    log(`話し合いで${tn}の処遇が決まった：${TRIAL_NAME[best]}`, 'event');
    post('町役場', `【話し合いの結果】${text}`, { authorId: 'town' });
    addNote(text);
    m.trials = m.trials.filter((x) => x.targetId !== item.targetId);
    return text;
  } else if (item.type === 'ruleVote') {
    const yes = [], no = [];
    for (const id of m.present) {
      const o = byId(id);
      if (!o || !o.alive) continue;
      const sup = Town.support(o, item.rule, item.proposer) + (m.ruleShift || 0) * trust(o, 'player');
      const pv0 = item.playerVote || (item.proposer === 'player' ? 'yes' : null);
      if (isAlly(o) && m.playerIn && (pv0 === 'yes' || pv0 === 'no')) { (pv0 === 'yes' ? yes : no).push(o.name); continue; }
      (o.id === item.proposer || sup >= 0.5 ? yes : no).push(o.name);
    }
    const pv = item.playerVote || (item.proposer === 'player' ? 'yes' : null);
    if (m.playerIn && pv === 'yes') yes.push('あなた');
    if (m.playerIn && pv === 'no') no.push('あなた');
    m.ruleShift = 0;
    const d = Town.describe(item.rule);
    const need = Town.threshold(item.rule);
    const voters = yes.length + no.length;
    const ratio = voters ? yes.length / voters : 0;
    const enough = m.present.length + (m.playerIn ? 1 : 0) >= Town.quorum();   // あなたも参加者に数える
    m.log.push({ who: '', text: `賛成：${yes.join('、') || 'なし'}／反対：${no.join('、') || 'なし'}（必要：${Town.ratioText(need)}の賛成・参加${Town.quorum()}人以上）`, cls: 'vote' });
    if (!enough) text = `参加者が${m.present.length + (m.playerIn ? 1 : 0)}人で、住民の半分（${Town.quorum()}人）に足りない。「${d}」は決められなかった。`;
    else if (need <= 0.5 ? ratio > 0.5 : ratio >= need - 1e-9) {
      Town.applyRule(item.rule);
      text = `賛成${yes.length}・反対${no.length}（${Math.round(ratio * 100)}%）で、「${d}」に決まった。`;
      if (item.rule.key === 'mayorOffice' && item.rule.value) m.queue.unshift({ type: 'election', c: presentChars(m)[0] });
    } else text = `賛成${yes.length}・反対${no.length}（${Math.round(ratio * 100)}%）。${Town.ratioText(need)}に届かず、「${d}」は見送りになった。`;
    m.log.push({ who: '', text, cls: 'result' });
    m.agenda = m.agenda.filter((a) => a.rule.key !== item.rule.key);
    return text;
  }
  if (text) addLine(m, c, text);
  return text;
}

// プレイヤーの発言（話し合いの最中）
export function playerSpeak(text) {
  const m = S.meeting;
  if (!m || !['talking', 'voting'].includes(m.state)) return;
  m.log.push({ who: 'あなた', text, cls: 'me' });
  const t = text.replace(/\s+/g, '');
  // 処遇の話し合いの最中：厳しくするか、許すか
  const trialCtx = m.ruleWait?.item.type === 'trialVote' || m.queue.some((i) => i.type.startsWith('trial'));
  if (trialCtx && !Town.parseRule(text)) {
    const stance = /(許|かわいそう|反省|見逃|大目に|やりすぎ|軽く)/.test(t) ? -1 : /(牢屋|閉じ込め|厳しく|罰|許せない|ひどい|反省させ|償)/.test(t) ? 1 : 0;
    if (stance) {
      m.trialShift = (m.trialShift || 0) + stance * 0.25;
      const r1 = m.present.map(byId).filter(Boolean).sort((a, b) => trust(b, 'player') - trust(a, 'player'))[0];
      if (r1) addLine(m, r1, trust(r1, 'player') >= 0.7 ? (stance > 0 ? 'そうだな、甘い顔はできない。' : '……たしかに、やりすぎはよくないか。') : 'よそ者に言われてもねえ。');
      m.nextReal = Math.min(m.nextReal, performance.now() + 900);
      return;
    }
  }
  const ruleCtx = m.ruleWait || m.queue.some((i) => i.type === 'rule' || i.type === 'ruleVote');
  const named = [...residents()].some((o) => t.includes(o.name));
  if (ruleCtx && !named && !Town.parseRule(text)) {
    const stance = /(反対|やめ|いらない|ダメ|だめ|困る|おかしい|必要ない|嫌だ)/.test(t) ? -1 : /(賛成|いいね|そうしよう|必要|大事|守れる|安全)/.test(t) ? 1 : 0;
    if (stance) {
      m.ruleShift = (m.ruleShift || 0) + stance * 0.2;
      const r1 = m.present.map(byId).filter(Boolean).sort((a, b) => trust(b, 'player') - trust(a, 'player'))[0];
      if (r1) addLine(m, r1, trust(r1, 'player') >= 0.7 ? (stance > 0 ? 'たしかに、その通りかもしれない。' : '……そう言われると、考え直したくなるな。') : 'よそ者が口を出すことかね。');
    }
    return;
  }
  const rule = Town.parseRule(text);
  if (rule) {
    if (m.state === 'voting') m.state = 'talking';
    m.queue.unshift({ type: 'ruleVote', rule, proposer: 'player', c: presentChars(m)[0] });
    m.nextReal = Math.min(m.nextReal, performance.now() + 900);
    return;
  }
  const target = [...residents(), S.player].find((o) => o !== S.player && t.includes(o.name));
  if (/(投票|決めよう|決めましょう)/.test(t)) { m.queue = keepRuleItems(m.queue); m.nextReal = 0; return; }
  if (!target) {
    const c = byId(m.present[Math.floor(S.rand() * m.present.length)]);
    if (c) m.queue.unshift({ type: 'react', c, text: pol(c) ? 'ええと……誰のことを言っているんですか？' : 'で、誰のことを言ってるんだ？' });
    m.nextReal = Math.min(m.nextReal, performance.now() + 900);
    return;
  }
  const defend = /(じゃない|違う|ちがう|無実|信じ|やってない|白)/.test(t);
  const ev = defend ? { score: 0, why: [] } : playerEvidence(target);
  const evidence = ev.score > 0 || /(見た|聞いた|足あと|足跡|出歩|うろつ|夜中|襲われ|顔|毛|証拠)/.test(t);
  const base = defend ? -18 : ev.score >= 2 ? 45 : ev.score === 1 ? 32 : evidence ? 24 : 16;
  if (ev.score) m.log.push({ who: '', text: `（あなたは証拠を示した：${ev.why.join('、')}）`, cls: 'vote' });
  let agree = 0, total = 0;
  for (const id of m.present) {
    const o = byId(id);
    if (!o || o === target) continue;
    const tr = trust(o, 'player');
    if (o.isWolf) { if (!defend && target !== o) addSus(o, target.id, 0); }
    else addSus(o, target.id, base * (ev.score >= 2 ? Math.max(tr, 0.9) : tr), defend ? '' : ev.score ? `よそ者が証拠を見せた（${ev.why[0]}）` : evidence ? `よそ者が「${text.slice(0, 24)}」と言っていた` : 'よそ者が怪しいと言っていた');
    total++; if (tr >= 0.6) agree++;
  }
  if (!defend) {
    S.wolf.playerAccused.add(target.id);
    if (target.isWolf) S.wolf.playerThreat += 20;
  }
  const responders = m.present.map(byId).filter((o) => o && o !== target);
  const r1 = responders.sort((a, b) => trust(b, 'player') - trust(a, 'player'))[0];
  if (r1) {
    const trusts = trust(r1, 'player') >= 0.6;
    const react = ev.score >= 2 && !r1.isWolf ? `……${ev.why[0]}だって？ それは見過ごせないな。` : defend ? (trusts ? 'あなたがそう言うなら、信じてみようか。' : 'よそ者の言うことなんてあてになるか。')
      : r1.isWolf ? `そうだよ、${target.name}が怪しいと思ってたんだ！` : trusts ? `……${target.name}か。言われてみれば、そうかもしれない。` : 'よそ者の言うことを、そのまま信じるわけにはいかないね。';
    m.queue.unshift({ type: 'react', c: r1, text: react });
  }
  if (!defend && m.present.includes(target.id)) m.queue.unshift({ type: 'defend', c: target, by: S.player });
  m.nextReal = Math.min(m.nextReal, performance.now() + 900);
  void agree; void total;
}

const keepRuleItems = (q) => q.filter((i) => i.type === 'rule' || i.type === 'ruleVote' || i.type.startsWith('trial') || i.type.startsWith('election'));

// 決まりの採決でのプレイヤーの一票
export function playerRuleVote(v) {
  const m = S.meeting;
  if (!m?.ruleWait) return;
  m.ruleWait.item.playerVote = v;
  const VTEXT = { yes: '賛成！', no: '反対だ！', jail: '牢屋に入れるべきだ。', fine: '罰金でいいと思う。', forgive: '今回は許してあげよう。' };
  const cand = v === 'player' ? '自分に一票！' : byId(v) ? `${byId(v).name}に一票。` : null;
  m.log.push({ who: 'あなた', text: VTEXT[v] || cand || '（棄権）', cls: 'me' });
  m.ruleWait = null;
  m.nextReal = performance.now() + 500;
}

export function startVoteNow() {
  const m = S.meeting;
  if (!m || m.state !== 'talking') return;
  // 決まりの採決が残っていれば先に済ませる
  m.queue = keepRuleItems(m.queue);
  if (m.queue.length) { m.nextReal = 0; return; }
  m.state = 'voting';
  const org = presentChars(m)[0];
  if (org) addLine(m, org, pol(org) ? 'では、投票で決めましょう。' : 'よし、投票で決めよう。');
}

// 候補者（牢屋に入れる相手）
export function voteCandidates() {
  return [...residents().filter((o) => candidate(o) && !isJailed(o)), S.player].filter((o) => o.alive);
}

// playerChoice: 投票先のid / 'abstain' / null（不参加）
export function vote(playerChoice) {
  const m = S.meeting;
  if (!m) return;
  const tally = {};
  const lines = [];
  for (const id of m.present) {
    const c = byId(id);
    if (!c || !c.alive) continue;
    let choice = null;
    if (c.isWolf) {
      // 人狼は、すでに疑われている誰かに乗る
      const lead = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
      choice = lead && lead[0] !== c.id && !byId(lead[0])?.isWolf ? lead[0] : S.wolf.frame;
    } else {
      const top = topSuspect(c);
      if (top && top.v >= 40) choice = top.t.id;
      if (isAlly(c) && playerChoice && playerChoice !== 'abstain') choice = playerChoice;   // あなたの側につくと約束した人
    }
    if (choice && (choice === 'player' || candidate(byId(choice)))) { tally[choice] = (tally[choice] || 0) + 1; lines.push([c, choice]); }
    else lines.push([c, null]);
  }
  if (playerChoice && playerChoice !== 'abstain') tally[playerChoice] = (tally[playerChoice] || 0) + 1;
  for (const [c, ch] of lines) m.log.push({ who: c.name, text: ch ? `→ ${ch === 'player' ? 'よそ者' : byId(ch).name}` : '→ 決められない', cls: 'vote' });
  if (playerChoice) m.log.push({ who: 'あなた', text: playerChoice === 'abstain' ? '→ 棄権' : `→ ${byId(playerChoice)?.name || 'よそ者'}`, cls: 'vote me' });
  const voters = lines.length + (playerChoice ? 1 : 0);
  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const [topId, n] = sorted[0] || [null, 0];
  const tie = sorted[1] && sorted[1][1] === n;
  if (topId && !tie && n >= 3 && n >= Math.ceil(voters * 0.4)) {
    const t = topId === 'player' ? S.player : byId(topId);
    Sim.jail(t, LIFE);
    t.jailedAsWolf = true;
    if (t.isPlayer) toast('話し合いの結果、あなたが牢屋に入れられた……！ 無実が証明されるまで出られない。');
    say(t, t.isWolf ? '……ちっ。' : 'そんな……私じゃないのに！', 6);
    const msg = `話し合いの結果、${n}票で${dn(t)}を牢屋に閉じ込めることになった。`;
    endMeeting(msg, t);
    if (!t.isWolf) S.wolf.lieLow = true;
    if (playerChoice === topId) S.wolf.playerAccused.add(topId);
  } else endMeeting(sorted.length ? '票が割れて、結論は出なかった。' : '誰も決められず、話し合いは終わった。');
}

function endMeeting(msg, jailed = null) {
  const m = S.meeting;
  if (!m) return;
  m.state = 'done';
  m.result = msg;
  m.log.push({ who: '', text: msg, cls: 'result' });
  S.meetingPause = false;
  S.lastMeetingEnd = S.t;
  for (const c of residents()) {
    if (c.activity === 'meeting') { c.busyUntil = S.t; c.activity = null; }
    if (c.alive && m.present.includes(c.id)) memo(c, msg, 'meeting');
  }
  log(msg, 'event');
  post('町役場', `【話し合いの結果】${msg}`, { authorId: 'town' });
  addNote(msg);
  if (jailed) S.banner = { title: '⚖️ 話し合いの結果', text: `${dn(jailed)}が牢屋に閉じ込められた。本当に人狼なら、もう事件は起きないはずだ……。`, until: performance.now() + 8000 };
}

export function leaveMeeting() {
  const m = S.meeting;
  if (!m || !['talking', 'voting'].includes(m.state)) return;
  m.playerIn = false;
  S.meetingPause = false;
  if (m.state === 'talking') while (m.queue.length) speakNext(m);
  finishTalk(m);
}

// ================= 会話用 =================
export function nightTestimony(c) {
  return (c.recent || []).filter((e) => e.kind === 'night' && S.t - e.t < 30 * 60).reverse()[0] || null;
}

export function suspectLine(c) {
  const top = topSuspect(c);
  if (!top || top.v < 35) return null;
  return { t: top.t, why: top.why, name: nm(c, top.t) };
}

export { dn as dispName, nm as nameFor };
void FACILITIES; void FOUNTAIN; void JOBS; void walkable; void furnAt; void placeName;
