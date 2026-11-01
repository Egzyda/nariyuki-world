// 住民の心：気分・性格・興味・秘密・長い目標・気づいたこと。そして、それにもとづいて選ぶ「行動の部品」。
// AIがなくても動く（ぜんぶプログラム）。AIがあるときは、ここで決まった気分や目標がAIにも伝わる。
// 狂人だらけにならないように：腹黒い性格は2人だけ、物騒な行動は町全体で1日1回（無法の町は2回）まで。
import { S, day, hour, rel, chance, clamp, residents, byId, isJailed, distTiles, memo, say, log, post, addLike, addFear, toast } from './state.js';
import { JOBS } from './data.js';
import * as Sim from './sim.js';
import * as Wolf from './wolf.js';
import * as Town from './town.js';
import * as Laws from './laws.js';
import * as Seer from './seer.js';

const pick = (a) => a[Math.floor(S.rand() * a.length)];
const nm = (c) => (c.isPlayer ? 'よそ者' : c.name);
const lawless = () => S.settings?.law === 'lawless';
const free = (o) => o && o.alive && !isJailed(o) && !o.undiscovered;

// ================= 性格（住民ごとに固定） =================
// curiosity好奇心 impulsivity衝動性 pride自尊心 empathy思いやり paranoia疑い深さ ambition野心 laziness怠け darkness腹黒さ
const TRAITS = {
  haru: { curiosity: 0.7, impulsivity: 0.5, pride: 0.3, empathy: 0.9, paranoia: 0.3, ambition: 0.2, laziness: 0.2, darkness: 0.05, interests: ['gossip', 'romance', 'food'], habit: 'early_bird', secret: { kind: 'worry', who: 'nagi' }, goal: { kind: 'protect', who: 'nagi' } },
  gou: { curiosity: 0.3, impulsivity: 0.8, pride: 0.9, empathy: 0.4, paranoia: 0.4, ambition: 0.4, laziness: 0.3, darkness: 0.25, interests: ['fight', 'craft', 'drink'], habit: 'drinker', secret: { kind: 'grudge', who: 'kage' }, goal: { kind: 'respect' } },
  mina: { curiosity: 0.5, impulsivity: 0.2, pride: 0.5, empathy: 0.9, paranoia: 0.3, ambition: 0.3, laziness: 0.1, darkness: 0.02, interests: ['mystery', 'health', 'order'], habit: 'early_bird', secret: { kind: 'crush' }, goal: { kind: 'peace' } },
  tsuzumi: { curiosity: 0.6, impulsivity: 0.5, pride: 0.5, empathy: 0.2, paranoia: 0.5, ambition: 0.7, laziness: 0.3, darkness: 0.55, interests: ['money', 'gossip', 'power'], habit: 'night_owl', secret: { kind: 'debt' }, goal: { kind: 'rich' } },
  ban: { curiosity: 0.3, impulsivity: 0.4, pride: 0.6, empathy: 0.3, paranoia: 0.4, ambition: 0.4, laziness: 0.6, darkness: 0.3, interests: ['money', 'drink'], habit: 'drinker', secret: { kind: 'bribes' }, goal: { kind: 'rich' } },
  shion: { curiosity: 1.0, impulsivity: 0.6, pride: 0.6, empathy: 0.3, paranoia: 0.3, ambition: 0.4, laziness: 0.2, darkness: 0.35, interests: ['meteor', 'mystery', 'stranger'], habit: 'night_owl', secret: { kind: 'obsession' }, goal: { kind: 'truth' } },
  yoru: { curiosity: 0.3, impulsivity: 0.3, pride: 0.5, empathy: 0.5, paranoia: 0.5, ambition: 0.2, laziness: 0.2, darkness: 0.3, interests: ['food', 'craft'], habit: 'early_bird', secret: { kind: 'grudge', who: 'tsuzumi' }, goal: { kind: 'revenge', who: 'tsuzumi' } },
  kage: { curiosity: 0.6, impulsivity: 0.7, pride: 0.6, empathy: 0.2, paranoia: 0.3, ambition: 0.9, laziness: 0.8, darkness: 0.6, interests: ['power', 'money', 'gossip'], habit: 'night_owl', secret: { kind: 'covet' }, goal: { kind: 'mayor' } },
  genji: { curiosity: 0.3, impulsivity: 0.1, pride: 0.6, empathy: 0.6, paranoia: 0.3, ambition: 0.6, laziness: 0.2, darkness: 0.1, interests: ['order', 'power'], habit: 'early_bird', secret: { kind: 'fearLoss' }, goal: { kind: 'peace' } },
  nagi: { curiosity: 0.6, impulsivity: 0.3, pride: 0.2, empathy: 0.7, paranoia: 0.6, ambition: 0.1, laziness: 0.3, darkness: 0.1, interests: ['mystery', 'romance'], habit: 'worrier', secret: { kind: 'crush', who: 'kage' }, goal: { kind: 'love', who: 'kage' } },
  taro: { curiosity: 0.5, impulsivity: 0.6, pride: 0.5, empathy: 0.7, paranoia: 0.4, ambition: 0.4, laziness: 0.2, darkness: 0.05, interests: ['fight', 'order'], habit: 'early_bird', secret: { kind: 'expose', who: 'ban' }, goal: { kind: 'wolfhunt' } },
};

const GOAL_TEXT = { protect: (w) => `${w}を守りたい`, respect: () => 'みんなに一目置かれたい', peace: () => '町を平和に保ちたい', rich: () => 'もっと金持ちになりたい', truth: () => '町の謎（光る石・人狼）の正体を突き止めたい',
  revenge: (w) => `${w}に思い知らせたい`, mayor: () => 'いつか村長になって町を仕切りたい', love: (w) => `${w}と結ばれたい`, wolfhunt: () => '人狼を自分の手で捕まえたい', keep: () => '村長の座を守りたい' };
const SECRET_TEXT = { worry: (w) => `${w}のことが心配でたまらない`, grudge: (w) => `${w}をずっと恨んでいる`, crush: (w) => `${w}に片想いしている`, debt: () => '実は借金で首が回らない',
  bribes: () => '袖の下で小遣い稼ぎをしている', obsession: () => '研究のためなら何でもしたい', covet: () => '村長の座を奪いたいと本気で思っている', fearLoss: () => '村長の座を失うのが怖い', expose: (w) => `${w}の不正を暴きたい` };
const HABIT_TEXT = { early_bird: '早起き', night_owl: '夜ふかし', drinker: '酒好き', worrier: '心配性' };
const INTEREST_TEXT = { gossip: '噂話', romance: '恋の話', food: '食べ物', fight: 'けんか', craft: 'ものづくり', drink: 'お酒', mystery: '謎', health: '人の健康', order: '町の秩序', money: 'お金', power: '権力', meteor: '光る石', stranger: 'よそ者' };

export function init(c) {
  if (c.isPlayer || c.psy) return;
  const base = TRAITS[c.id] || { curiosity: 0.5, impulsivity: 0.4, pride: 0.4, empathy: 0.5, paranoia: 0.4, ambition: 0.3, laziness: 0.4, darkness: 0.1, interests: ['gossip'], habit: 'early_bird', secret: { kind: 'worry' }, goal: { kind: 'peace' } };
  const { interests, habit, secret, goal, ...t } = base;
  // 片想いの相手が決まっていなければ、いちばん好きな異性
  const sec = { ...secret };
  if (sec.kind === 'crush' && !sec.who) sec.who = residents().filter((o) => o !== c && o.female !== c.female).sort((a, b) => rel(c, b).like - rel(c, a).like)[0]?.id;
  c.psy = {
    t, interests, habit, secret: sec, goal: { ...goal }, concerns: [], debts: {}, lastAct: -999, acts: {},
    mood: { joy: 50, anger: 15, fear: 15, boredom: 30, fatigue: 20, stress: 20 },
  };
}
export const ensure = () => { for (const c of residents()) init(c); };

// ================= 気分 =================
const M = (c) => c.psy.mood;
function bump(c, k, v) { if (c.psy) M(c)[k] = clamp(M(c)[k] + v, 0, 100); }
export function moodText(c) {
  if (!c.psy) return '';
  const m = M(c);
  const list = [['anger', 'イライラしている'], ['fear', 'おびえている'], ['stress', '思いつめている'], ['boredom', '退屈している'], ['fatigue', '疲れている'], ['joy', '上機嫌']].sort((a, b) => m[b[0]] - m[a[0]]);
  const [k, label] = list[0];
  if (m[k] < 45) return 'ふつう';
  return label;
}
export function goalText(c) { const g = c.psy?.goal; if (!g) return ''; return (GOAL_TEXT[g.kind] || (() => ''))(g.who ? byId(g.who)?.name || '' : ''); }
export function secretText(c) { const s = c.psy?.secret; if (!s) return ''; return (SECRET_TEXT[s.kind] || (() => ''))(s.who ? byId(s.who)?.name || '' : ''); }
export function traitText(c) {
  if (!c.psy) return '';
  const t = c.psy.t;
  const marks = [['curiosity', '好奇心旺盛'], ['impulsivity', '衝動的'], ['pride', 'プライドが高い'], ['empathy', '思いやりがある'], ['paranoia', '疑い深い'], ['ambition', '野心家'], ['laziness', '怠け者'], ['darkness', '腹黒い']]
    .filter(([k]) => t[k] >= 0.6).map(([, l]) => l);
  return [...marks, HABIT_TEXT[c.psy.habit]].filter(Boolean).join('・');
}
export const interestText = (c) => (c.psy?.interests || []).map((i) => INTEREST_TEXT[i]).join('・');
// AIに渡す説明
export function describeFor(c) {
  if (!c.psy) return '';
  const cc = c.psy.concerns.slice(-3).map((x) => x.text).join(' / ');
  return `気分: ${moodText(c)}。性格: ${traitText(c)}。興味: ${interestText(c)}。長い目標: ${goalText(c)}。【人に言わない本音】${secretText(c)}。${cc ? '最近気になっていること: ' + cc : ''}`;
}

// ================= 気づく：出来事が心に残る =================
// kind: theft_victim / attacked / witness / death / gift / law / arrested / insulted / jailed_friend / rumor
export function notice(c, kind, opts = {}) {
  if (!c || c.isPlayer || !c.alive) return;
  init(c);
  const ab = opts.about;
  const E = {
    theft_victim: [['anger', 30], ['fear', 10], ['stress', 15]], attacked: [['anger', 40], ['fear', 20]], witness: [['fear', 8], ['stress', 6]],
    death: [['fear', 25], ['joy', -25], ['stress', 15]], gift: [['joy', 18], ['anger', -10]], law: [['stress', 5]], arrested: [['anger', 40], ['stress', 20], ['joy', -20]],
    insulted: [['anger', 25], ['joy', -10]], praised: [['joy', 20]], party: [['joy', 25], ['boredom', -30]], rejected: [['joy', -30], ['stress', 20]], loved: [['joy', 40], ['stress', -20]],
  }[kind] || [];
  for (const [k, v] of E) bump(c, k, v);
  if (opts.text) {
    c.psy.concerns.push({ kind, about: ab?.id || ab, text: opts.text, t: S.t, w: opts.w || 1 });
    if (c.psy.concerns.length > 8) c.psy.concerns.shift();
  }
  // 恨みは目標を書き換えることがある（とても強く傷つけられたとき）
  if ((kind === 'attacked' || kind === 'arrested') && ab && ab !== c && M(c).anger > 75 && c.psy.t.pride > 0.5 && chance(0.4)) {
    const who = ab.isPlayer ? 'player' : ab.id;
    if (c.psy.goal.kind !== 'revenge') { c.psy.goal = { kind: 'revenge', who }; log(`🧠 ${c.name}は、${nm(ab)}への仕返しを心に決めた`, 'mind'); }
  }
}

// ================= 毎時・毎朝：気分の移り変わり =================
export function hourly(h) {
  ensure();
  for (const c of residents()) {
    if (!c.alive || !c.psy) continue;
    const m = M(c);
    // ゆっくり落ち着く
    for (const k of ['anger', 'fear', 'stress']) m[k] = clamp(m[k] + (15 - m[k]) * 0.06, 0, 100);
    m.joy = clamp(m.joy + (50 - m.joy) * 0.05, 0, 100);
    if (c.hunger < 35) { bump(c, 'anger', 3); bump(c, 'stress', 2); }
    if (c.coins < 2) bump(c, 'stress', 2);
    const awakeLate = (h >= 23 || h < 5) && c.activity !== 'sleep';
    if (awakeLate) bump(c, 'fatigue', 8); else if (c.activity === 'sleep') bump(c, 'fatigue', -12); else bump(c, 'fatigue', c.activity === 'work' ? 3 : 1);
    if (c.activity === 'work' || c.activity === 'rest' || c.activity === 'wander') bump(c, 'boredom', c.psy.t.curiosity * 4); else bump(c, 'boredom', -5);
    if (S.wolfKnown) bump(c, 'fear', c.psy.t.paranoia * 2);
    if (c.psy.habit === 'worrier') bump(c, 'stress', 1);
  }
  // 宴会などの集まり
  for (const ev of S.events || []) if (!ev.done && hour() === ev.hour && day() === ev.day) startEvent(ev);
  S.events = (S.events || []).filter((ev) => !ev.done || day() - ev.day < 2);
}

export function daily() {
  ensure();
  for (const c of residents()) {
    if (!c.alive || !c.psy) continue;
    // 気になることは数日で薄れる
    c.psy.concerns = c.psy.concerns.filter((x) => S.t - x.t < 3 * 1440);
    c.psy.acts = {};
    // 魔が差す日：腹黒い人・衝動的な人ほど、ときどき急によからぬことを思いつく
    c.psy.urge = chance(0.03 + c.psy.t.darkness * 0.25 + c.psy.t.impulsivity * 0.05 + (M(c).anger > 60 ? 0.08 : 0));
    if (c.psy.urge) log(`🧠 ${c.name}は、今日はなぜか胸がざわついている……`, 'mind');
    // 目標の見直し
    const g = c.psy.goal;
    if (g.kind === 'mayor' && c.job === 'mayor') { c.psy.goal = { kind: 'keep' }; log(`🧠 ${c.name}は村長になった。次は、その座を守る番だ`, 'mind'); }
    if (g.kind === 'revenge' && g.who && (g.who === 'player' ? !S.player.alive : !byId(g.who)?.alive)) c.psy.goal = { kind: 'peace' };
    if (g.kind === 'love' && g.who && Sim.bondOf(c, byId(g.who) || c) === 'lover') { c.psy.goal = { kind: 'protect', who: g.who }; }
    if (g.kind === 'wolfhunt' && S.wolf?.confirmed) c.psy.goal = { kind: 'respect' };
    // 借金の返済日
    for (const [id, d] of Object.entries(c.psy.debts)) if (d.due <= day()) { const cr = byId(id); if (cr?.psy) cr.psy.concerns.push({ kind: 'debt', about: c.id, text: `${c.name}に貸した${d.n}Gが返ってこない`, t: S.t, w: 2 }); }
  }
  S.psyDark = { day: day(), n: 0 };
  groupsDaily();
}

// ================= 行動の部品 =================
// score(c, x) が高いものを選ぶ。x は判断に使う材料（その場で計算）。
// dark: 物騒な行動（町全体で1日の回数に上限）。lawless: 無法の町（または暴力が禁止されていない町）でだけ選ばれる
function ctx(c) {
  const others = residents().filter((o) => o !== c && free(o));
  const likeOf = (o) => rel(c, o).like;
  const friend = others.slice().sort((a, b) => likeOf(b) - likeOf(a))[0];
  const enemy = others.slice().sort((a, b) => likeOf(a) - likeOf(b))[0];
  const sec = c.psy.secret, g = c.psy.goal;
  const crush = sec.kind === 'crush' && sec.who ? byId(sec.who) : g.kind === 'love' && g.who ? byId(g.who) : null;
  const grudgeId = g.kind === 'revenge' ? g.who : sec.kind === 'grudge' ? sec.who : null;
  const grudge = grudgeId === 'player' ? S.player : grudgeId ? byId(grudgeId) : null;
  const top = Wolf.topSuspect(c);
  const debtor = Object.entries(c.psy.debts).filter(([, d]) => d.mine === false && d.due <= day()).map(([id]) => byId(id)).find(free);
  const creditor = Object.entries(c.psy.debts).filter(([, d]) => d.mine).map(([id]) => byId(id)).find(free);
  const theftConcern = c.psy.concerns.find((x) => x.kind === 'theft_victim' || x.kind === 'witness');
  const noViolenceLaw = !S.rules?.violenceBan || lawless();
  return { h: hour(), m: M(c), t: c.psy.t, others, friend, enemy, crush, grudge, top, debtor, creditor, theftConcern, noViolenceLaw, likeOf };
}

const go = (c, plan) => { Sim.setPlan(c, plan); return true; };
const meetPlan = (c, t, what, data = {}) => { c.psyAct = { what, data }; return go(c, { targetId: t.isPlayer ? 'player' : t.id, kind: 'psy', giveUpAt: S.t + 120 }); };
const mood = (x, k) => x.m[k] / 100;

const PARTS = [
  // ---- 日々の気分で ----
  { id: 'slack', label: '仕事をサボって休んだ', score: (c, x) => (x.h >= JOBS[c.job].from && x.h < JOBS[c.job].to ? 1 : 0) * (x.t.laziness * 0.8 + mood(x, 'fatigue') * 0.7 + mood(x, 'boredom') * 0.3) - 0.35,
    run: (c) => go(c, chance(0.5) && Sim.facIsOpen('tavern') && c.coins >= 1 ? { place: 'tavern', act: 'drink' } : { place: c.home, act: 'rest' }) },
  { id: 'overtime', label: '稼ぐために遅くまで働いた', score: (c, x) => (c.psy.goal.kind === 'rich' ? 0.6 : 0) + c.p.greed * 0.3 + (c.coins < 5 ? 0.3 : 0) - x.t.laziness * 0.5 - mood(x, 'fatigue') * 0.5 + (x.h >= JOBS[c.job].to && x.h < 21 ? 0.2 : -1),
    run: (c) => { const p = JOBS[c.job]?.place; return p && Sim.facIsOpen(p) ? go(c, { place: p, act: 'work' }) : false; } },
  { id: 'drown', label: 'むしゃくしゃして酒場で飲んだくれた', score: (c, x) => (mood(x, 'stress') + mood(x, 'anger')) * 0.6 + (c.psy.habit === 'drinker' ? 0.3 : 0) - 0.5 + (x.h >= 16 ? 0.2 : -0.3),
    run: (c) => (c.coins >= 1 && Sim.facIsOpen('tavern') ? go(c, { place: 'tavern', act: 'drink' }) : false) },
  { id: 'sulk', label: '家に閉じこもった', score: (c, x) => mood(x, 'fear') * 0.8 + (1 - c.p.sociability) * 0.3 - 0.45, run: (c) => go(c, { place: c.home, act: 'rest' }) },
  { id: 'stroll', label: '気晴らしに散歩した', score: (c, x) => mood(x, 'boredom') * 0.7 + mood(x, 'stress') * 0.3 - 0.3, run: (c) => go(c, { place: 'plaza', tile: Sim.plazaTile(), act: 'wander' }) },
  { id: 'trainHard', label: '悔しさをばねに体を鍛えた', score: (c, x) => (c.psy.concerns.some((k) => k.kind === 'attacked' || k.kind === 'duelLost') ? 0.6 : 0) + x.t.pride * 0.3 + c.p.aggression * 0.2 - 0.3,
    run: (c) => (Sim.facIsOpen('training') ? go(c, { place: 'training', act: 'train' }) : false) },
  { id: 'mourn', max: 1, label: '亡くなった人を思って広場でたたずんだ', score: (c, x) => (c.psy.concerns.some((k) => k.kind === 'death' && S.t - k.t < 1440) ? 0.4 : -1) + x.t.empathy * 0.3 - 0.35,
    run: (c) => { memo(c, '亡くなった人のことを思い出していた', 'info'); return go(c, { place: 'plaza', tile: Sim.plazaTile(), act: 'wander' }); } },

  // ---- 人づきあい ----
  { id: 'seekFriend', label: '親しい人に会いに行った', score: (c, x) => (x.friend && x.likeOf(x.friend) > 25 ? 0.3 : -1) + c.p.sociability * 0.4 + mood(x, 'boredom') * 0.3 + mood(x, 'stress') * 0.2 - 0.2,
    run: (c, x) => go(c, { targetId: x.friend.id, kind: 'chat', giveUpAt: S.t + 90 }) },
  { id: 'inviteMeal', label: '親しい人を食事に誘った', score: (c, x) => (x.friend && x.likeOf(x.friend) > 35 && c.coins >= 6 && ((x.h >= 11 && x.h <= 13) || (x.h >= 18 && x.h <= 20)) ? 0.5 : -1) + c.p.sociability * 0.3,
    run: (c, x) => meetPlan(c, x.friend, 'meal') },
  { id: 'gossip', label: '噂話を広めに行った', score: (c, x) => (c.psy.interests.includes('gossip') ? 0.4 : 0) + c.p.sociability * 0.2 + (c.recent || []).filter((r) => r.kind === 'crime' || r.kind === 'night').length * 0.1 - 0.25,
    run: (c, x) => (x.friend ? go(c, { targetId: x.friend.id, kind: 'chat', giveUpAt: S.t + 90 }) : false) },
  { id: 'apologize', label: '気まずい相手に謝りに行った', score: (c, x) => (x.enemy && x.likeOf(x.enemy) < -20 && x.likeOf(x.enemy) > -60 ? 0.3 : -1) + x.t.empathy * 0.5 - x.t.pride * 0.5 + (c.psy.goal.kind === 'peace' ? 0.2 : 0) - 0.2,
    run: (c, x) => meetPlan(c, x.enemy, 'apology') },
  { id: 'helpNeedy', label: '困っている人を助けに行った', score: (c, x) => { const n = x.others.find((o) => o.hunger < 30 && o.coins < 3); x.needy = n; return (n && (c.food > 0 || c.coins >= 5) ? 0.4 : -1) + x.t.empathy * 0.5 - c.p.greed * 0.3; },
    run: (c, x) => go(c, { targetId: x.needy.id, kind: 'give', giveUpAt: S.t + 90 }) },
  { id: 'askLoan', label: 'お金を借りに行った', score: (c, x) => (c.coins < 3 && x.friend && x.friend.coins >= 8 ? 0.5 : -1) + (c.psy.secret.kind === 'debt' ? 0.3 : 0) - x.t.pride * 0.3,
    run: (c, x) => meetPlan(c, x.friend, 'loan') },
  { id: 'repay', label: '借りたお金を返しに行った', score: (c, x) => (x.creditor && c.coins >= (c.psy.debts[x.creditor.id]?.n || 99) + 2 ? 0.5 : -1) + c.p.honesty * 0.4,
    run: (c, x) => meetPlan(c, x.creditor, 'repay') },
  { id: 'collect', label: '貸したお金を取り立てに行った', score: (c, x) => (x.debtor ? 0.6 : -1) + c.p.greed * 0.3 + c.p.aggression * 0.2, run: (c, x) => meetPlan(c, x.debtor, 'collect') },
  { id: 'giftCrush', label: '想いを寄せる人に贈り物をした', score: (c, x) => (x.crush && free(x.crush) && (c.coins >= 3 || c.food > 0) ? 0.35 : -1) + mood(x, 'joy') * 0.2 + (c.psy.goal.kind === 'love' ? 0.2 : 0),
    run: (c, x) => go(c, { targetId: x.crush.id, kind: 'give', giveUpAt: S.t + 90 }) },
  { id: 'confess', label: '想いを告白しに行った', score: (c, x) => (x.crush && free(x.crush) && x.likeOf(x.crush) > 45 && Sim.bondOf(c, x.crush) !== 'lover' ? 0.3 : -1) + x.t.impulsivity * 0.3 + mood(x, 'joy') * 0.3 - (1 - c.p.sociability) * 0.2,
    run: (c, x) => meetPlan(c, x.crush, 'confess') },
  { id: 'lobby', label: '次の話し合いのために根回しをした', score: (c, x) => (Wolf.meetingActive() && S.meeting.agenda.some((a) => a.proposer === c.id) ? 0.7 : -1) + x.t.ambition * 0.3,
    run: (c, x) => { const t = x.others.filter((o) => x.likeOf(o) > 0 && !(o.leanFor && o.leanFor.id === c.id)).sort(() => S.rand() - 0.5)[0]; return t ? meetPlan(c, t, 'lobby') : false; } },
  { id: 'recruit', max: 1, label: '自分の会に仲間を誘った', score: (c, x) => { const g = (S.groups || []).find((gr) => gr.leader === c.id); x.group = g; return (g && g.members.length < 5 ? 0.4 : -1) + c.p.sociability * 0.3; },
    run: (c, x) => { const t = x.others.find((o) => !x.group.members.includes(o.id) && x.likeOf(o) > 10); return t ? meetPlan(c, t, 'recruit', { gid: x.group.id }) : false; } },
  { id: 'warnStranger', label: 'よそ者に忠告しに行った', score: (c, x) => (x.top && x.top.v >= 45 && rel(c, 'player').like > 20 && S.player.alive ? 0.4 : -1) + x.t.empathy * 0.2,
    run: (c) => Sim.planApproachPlayer(c) },
  { id: 'curiousStranger', label: 'よそ者が気になって話しかけに行った', score: (c, x) => (c.psy.interests.includes('stranger') ? 0.4 : 0) + x.t.curiosity * 0.3 + mood(x, 'boredom') * 0.2 - 0.35,
    run: (c) => Sim.planApproachPlayer(c) },

  // ---- 好奇心・調べもの ----
  { id: 'investigate', label: '気になることを調べに行った', score: (c, x) => x.t.curiosity * 0.5 + (c.psy.interests.includes('mystery') || c.psy.interests.includes('meteor') ? 0.2 : 0) + (S.meteor && S.meteor.state !== 'done' ? 0.15 : 0) + (S.wolf?.kills.length ? 0.1 : 0) - 0.45,
    run: (c) => { const places = ['lab', 'plaza', 'guard', 'tavern'].filter(Sim.facIsOpen); const p = pick(places.length ? places : ['plaza']); return p === 'plaza' ? go(c, { place: 'plaza', tile: Sim.plazaTile(), act: 'wander' }) : go(c, { place: p, act: 'visit' }); } },
  { id: 'consultSeer', max: 1, label: '占い師に相談しに行った', score: (c, x) => (Seer.seer() && Seer.seer() !== c && S.wolfKnown && x.top && c.coins >= 2 ? 0.2 : -1) + x.t.paranoia * 0.3 + mood(x, 'fear') * 0.3 - 0.4,
    run: (c) => { const s = Seer.seer(); return s ? meetPlan(c, s, 'seer') : false; } },
  { id: 'spy', label: '怪しい人の様子をこっそりうかがった', score: (c, x) => (x.top && x.top.v >= 35 ? 0.35 : -1) + x.t.paranoia * 0.3 + x.t.curiosity * 0.2 - 0.15,
    run: (c, x) => (x.top.t.isPlayer ? false : meetPlan(c, x.top.t, 'spy')) },

  // ---- 町のこと（法律・会・催し・選挙） ----
  { id: 'proposeLaw', label: '新しい法律を提案した', score: (c, x) => (!Wolf.meetingActive() ? 0.2 : -1) + (x.theftConcern ? 0.3 : 0) + mood(x, 'anger') * 0.3 + x.t.ambition * 0.2 + (lawless() ? 0.15 : 0) - 0.45,
    run: (c) => { const law = Laws.suggest(c); if (!law) return false; const rule = { key: 'law', value: law }; post(c.name, `町に「${Laws.describe(law)}」という法律が必要だと思う。話し合いで決めよう。`, { authorId: c.id }); Wolf.scheduleMeeting(c.id, 150, 'rule', rule); return true; } },
  { id: 'repealLaw', label: '気に入らない法律の廃止を言い出した', score: (c, x) => { const l = Laws.laws().find((law) => Laws.support(c, law) < 0.25); x.badLaw = l; return (l && !Wolf.meetingActive() ? 0.4 : -1) + mood(x, 'anger') * 0.3; },
    run: (c, x) => { post(c.name, `「${Laws.describe(x.badLaw)}」なんて法律はおかしい。やめるべきだ。`, { authorId: c.id }); Wolf.scheduleMeeting(c.id, 150, 'rule', { key: 'repeal', value: x.badLaw.id }); return true; } },
  { id: 'foundGroup', label: '仲間を集めて会を作った', score: (c, x) => ((S.groups || []).some((g) => g.leader === c.id) ? -1 : 0.1) + ((S.groups || []).length >= 3 ? -1 : 0) + x.t.ambition * 0.3 + c.p.sociability * 0.2 + (x.theftConcern || S.wolfKnown ? 0.2 : 0) - 0.4,
    run: (c, x) => foundGroup(c, x) },
  { id: 'feast', label: '宴会を開くことにした', score: (c, x) => ((S.events || []).some((e) => !e.done) ? -1 : 0) + c.p.sociability * 0.4 + mood(x, 'joy') * 0.3 + (c.job === 'barkeep' || c.job === 'cook' ? 0.2 : 0) + (S.foodStock > 40 ? 0.1 : 0) - 0.5,
    run: (c) => planFeast(c) },
  { id: 'campaign', max: 1, label: '村長になるために選挙運動をした', score: (c, x) => (c.psy.goal.kind === 'mayor' && S.rules?.mayorOffice && c.job !== 'mayor' ? 0.5 : -1) + x.t.ambition * 0.3,
    run: (c, x) => { post(c.name, pick(['俺に任せてくれれば、この町はもっとよくなる。次の村長は俺だ。', '今の町のやり方には不満がある。村長を選び直そう。']), { authorId: c.id }); for (const o of x.others.slice(0, 3)) addLike(o, c, chance(0.5) ? 3 : -2); if (!Wolf.meetingActive() && chance(0.4)) Wolf.scheduleMeeting(c.id, 180, 'election'); return go(c, { place: 'plaza', tile: Sim.plazaTile(), act: 'wander' }); } },
  { id: 'wantMayorOffice', label: '「村長を置こう」と言い出した', score: (c, x) => (!S.rules?.mayorOffice && !Wolf.meetingActive() ? 0.3 : -1) + x.t.ambition * 0.4 - 0.2,
    run: (c) => { Wolf.scheduleMeeting(c.id, 180, 'rule', { key: 'mayorOffice', value: true }); post(c.name, 'この町には、まとめ役の村長が必要だ。話し合おう。', { authorId: c.id }); return true; } },
  { id: 'praiseBoard', label: '掲示板で誰かをほめた', score: (c, x) => (x.friend && x.likeOf(x.friend) > 40 ? 0.2 : -1) + mood(x, 'joy') * 0.4 + x.t.empathy * 0.2 - 0.35,
    run: (c, x) => { post(c.name, `${x.friend.name}にはいつも助けられてる。ありがとう。`, { authorId: c.id }); addLike(x.friend, c, 6); notice(x.friend, 'praised'); return true; } },
  { id: 'ventBoard', label: '掲示板で不満をぶちまけた', score: (c, x) => mood(x, 'anger') * 0.6 + (x.enemy && x.likeOf(x.enemy) < -30 ? 0.2 : 0) - 0.4,
    run: (c, x) => { const t = x.enemy && x.likeOf(x.enemy) < -30 ? x.enemy : null; post(c.name, t ? `${t.name}の態度には、もう我慢ならない。` : pick(['最近の町はどうかしてる。', '誰か何とかしてくれ。']), { authorId: c.id }); if (t) { addLike(t, c, -10); notice(t, 'insulted', { about: c, text: `${c.name}に掲示板で悪口を書かれた` }); Laws.enforce(c, 'gossip', residents().filter((o) => o !== c && o.alive), Sim.lawHooks); } return true; } },
  { id: 'accuse', label: '掲示板で人狼だと名指しした', score: (c, x) => (S.wolfKnown && x.top && x.top.v >= 55 ? 0.4 : -1) + x.t.paranoia * 0.3 + mood(x, 'fear') * 0.3 - 0.15,
    run: (c, x) => { const t = x.top.t; post(c.name, `はっきり言う。${nm(t)}が人狼だと思う。${x.top.why}。`, { authorId: c.id }); for (const o of x.others) Wolf.addSus(o, t.isPlayer ? 'player' : t.id, 10 * Wolf.trust(o, c.id), `${c.name}が掲示板で名指ししていた`); return true; } },

  // ---- 商売・お金 ----
  { id: 'raisePrice', label: '店の値段をつり上げた', score: (c, x) => (['merchant', 'cook', 'barkeep'].includes(c.job) && !(S.priceUp || {})[c.job] ? 0.2 : -1) + c.p.greed * 0.5 + (c.psy.goal.kind === 'rich' ? 0.2 : 0) - 0.45,
    run: (c) => { (S.priceUp ||= {})[c.job] = { until: day() + 1, by: c.id }; post(c.name, `しばらく値上げさせてもらうよ。文句は聞かない。`, { authorId: c.id }); for (const o of residents()) if (o !== c && o.alive && o.coins < 10) addLike(o, c, -4); return true; } },
  { id: 'boycott', label: '嫌いな人の店を使わないと決めた', score: (c, x) => (x.enemy && ['merchant', 'cook', 'barkeep'].includes(x.enemy.job) && x.likeOf(x.enemy) < -35 ? 0.4 : -1) + x.t.pride * 0.2,
    run: (c, x) => { c.avoidId = x.enemy.id; c.avoidDay = day(); post(c.name, `${x.enemy.name}の店には二度と行かない。`, { authorId: c.id }); addLike(x.enemy, c, -8); return true; } },

  // ---- 物騒なこと（dark：1日の回数に上限） ----
  { id: 'impulseSteal', dark: true, label: '衝動的に盗みを働こうとした', score: (c, x) => x.t.impulsivity * 0.3 + (1 - c.p.honesty) * 0.4 + (c.coins < 3 ? 0.3 : 0) + x.t.darkness * 0.3 + mood(x, 'stress') * 0.2 - 0.75,
    run: (c, x) => { const v = x.others.filter((o) => o.coins >= 4).sort((a, b) => x.likeOf(a) - x.likeOf(b))[0]; return v ? go(c, { targetId: v.id, kind: 'steal', giveUpAt: S.t + 90 }) : false; } },
  { id: 'revenge', dark: true, label: '恨みを晴らしに行った', score: (c, x) => (x.grudge && free(x.grudge) ? 0.3 : -1) + mood(x, 'anger') * 0.6 + x.t.pride * 0.2 + c.p.aggression * 0.2 - 0.55,
    run: (c, x) => go(c, { targetId: x.grudge.isPlayer ? 'player' : x.grudge.id, kind: c.p.aggression > 0.55 ? 'attack' : 'threaten', giveUpAt: S.t + 120 }) },
  { id: 'frame', dark: true, label: '嫌いな人を陥れる嘘を吹き込んだ', score: (c, x) => (x.enemy && x.likeOf(x.enemy) < -30 ? 0.3 : -1) + x.t.darkness * 0.6 + (1 - c.p.honesty) * 0.3 - 0.6,
    run: (c, x) => { const ear = x.others.find((o) => o !== x.enemy && x.likeOf(o) > 0); return ear ? meetPlan(c, ear, 'frame', { target: x.enemy.id }) : false; } },
  { id: 'sabotage', dark: true, label: '夜中に町の食料をこっそり捨てた', score: (c, x) => (x.h >= 22 || x.h < 4 ? 0.3 : -1) + x.t.darkness * 0.6 + mood(x, 'anger') * 0.3 - 0.75,
    run: (c) => { const n = Math.min(Math.floor(S.foodStock), 4 + Math.floor(S.rand() * 4)); S.foodStock -= n; memo(c, '夜中に町の食料をこっそり捨てた', 'crime'); log(`🌙 町の食料の蓄えが、いつのまにか${n}食分減っていた……`, 'crime'); return true; } },
  { id: 'duel', dark: true, lawlessOnly: true, label: '決闘を申し込んだ', score: (c, x) => (x.enemy && x.likeOf(x.enemy) < -40 ? 0.3 : -1) + x.t.pride * 0.5 + c.p.aggression * 0.3 + mood(x, 'anger') * 0.3 - 0.6,
    run: (c, x) => meetPlan(c, x.enemy, 'duel') },
  { id: 'extort', dark: true, lawlessOnly: true, label: '店から用心棒代を取り立てに行った', score: (c, x) => { const shop = x.others.find((o) => ['merchant', 'cook', 'barkeep'].includes(o.job) && o.coins >= 6); x.shop = shop; return (shop ? 0.3 : -1) + c.p.aggression * 0.4 + c.p.greed * 0.3 + x.t.darkness * 0.3 - 0.7; },
    run: (c, x) => meetPlan(c, x.shop, 'extort') },
  { id: 'blackMarket', dark: true, lawlessOnly: true, label: '裏で闇市を開いた', score: (c, x) => (c.job === 'merchant' || c.job === 'barkeep' ? 0.3 : -1) + c.p.greed * 0.4 + x.t.darkness * 0.3 - 0.6,
    run: (c) => { c.coins += 4; post(c.name, '夜の酒場の裏で、ちょっと珍しい品を安く分けてる。誰にも言うなよ。', { authorId: c.id }); log(`🌙 ${c.name}が裏で闇市を開いているらしい`, 'crime'); return go(c, { place: 'tavern', act: 'visit' }); } },
  { id: 'lynch', dark: true, lawlessOnly: true, label: '仲間と一緒に疑わしい人を襲いに行った', score: (c, x) => (S.wolfKnown && x.top && x.top.v >= 70 && !x.top.t.isPlayer ? 0.3 : -1) + mood(x, 'fear') * 0.4 + mood(x, 'anger') * 0.3 + c.p.aggression * 0.3 - 0.65,
    run: (c, x) => { const t = x.top.t; const mob = x.others.filter((o) => o !== t && Wolf.sus(o, t.id) >= 40 && o.p.aggression > 0.3).slice(0, 2); for (const o of [c, ...mob]) { Sim.setPlan(o, { targetId: t.id, kind: 'attack', giveUpAt: S.t + 120 }); } log(`⚠️ ${[c, ...mob].map((o) => o.name).join('・')}が、人狼の疑いで${t.name}を取り囲もうとしている！`, 'crime'); return true; } },
  { id: 'powerGrab', dark: true, lawlessOnly: true, label: '力ずくで町の長を名乗った', score: (c, x) => (c.psy.goal.kind === 'mayor' && c.job !== 'mayor' ? 0.3 : -1) + x.t.ambition * 0.4 + x.t.darkness * 0.4 + residents().filter((o) => o !== c && rel(o, c).fear >= 30).length * 0.08 - 0.85,
    run: (c) => { if (!S.rules.mayorOffice) S.rules.mayorOffice = true; Town.setMayor(c.id); log(`⚠️ ${c.name}が力ずくで町の長を名乗った！ 文句のある者は前に出ろ、と。`, 'event'); for (const o of residents()) if (o !== c && o.alive) { addFear(o, c, 10); addLike(o, c, -8); } return true; } },
];
export const PART_COUNT = PARTS.length;

// 住民が自分で考えて動く（sim.decide から呼ぶ）。動いたら true
export function act(c) {
  if (!c.psy || c.isWolf && c.hunt) return false;
  if (S.t - c.psy.lastAct < 50 + c.psy.t.laziness * 40) return false;   // 考え込むのは1時間に1回くらい
  c.psy.lastAct = S.t;
  const x = ctx(c);
  const darkUsed = (S.psyDark?.day === day() ? S.psyDark.n : 0);
  const darkMax = lawless() ? 2 : 1;
  let best = null, bs = 0.05;
  for (const part of PARTS) {
    if ((c.psy.acts[part.id] || 0) >= (part.max || (part.dark ? 1 : 2))) continue;   // 同じことを1日に何度もしない
    if (part.dark && darkUsed >= darkMax) continue;
    if (part.lawlessOnly && !(lawless() || x.noViolenceLaw)) continue;
    let s;
    try { s = part.score(c, x); } catch { continue; }
    // 気まぐれ：衝動的な人ほど、その日の気分で選び方がぶれる
    s += (S.rand() - 0.5) * (0.25 + c.psy.t.impulsivity * 0.35);
    if (part.dark) s += c.psy.urge ? 0.45 : -0.1 * (1 - c.psy.t.darkness);   // 魔が差した日は、物騒なことを思いつきやすい
    if (s > bs) { bs = s; best = part; }
  }
  if (!best) return false;
  let ok = false;
  try { ok = best.run(c, x); } catch (e) { console.warn('psyche part failed', best.id, e); ok = false; }
  if (!ok) return false;
  c.psy.acts[best.id] = (c.psy.acts[best.id] || 0) + 1;
  if (best.dark) { S.psyDark = { day: day(), n: darkUsed + 1 }; c.psy.urge = false; }
  const why = reason(c, best, x);
  log(`🧠 ${c.name}は${best.label}${why ? `（${why}）` : ''}`, best.dark ? 'crime' : 'mind');
  c.psy.lastThought = `${best.label}${why ? '。' + why : ''}`;
  return true;
}

// なぜそうしたか（ログと心の声に出す）
function reason(c, part, x) {
  const m = x.m;
  if (part.id === 'slack') return m.fatigue > 60 ? '疲れがたまっていた' : c.psy.t.laziness > 0.6 ? 'どうにもやる気が出ない' : '気が乗らなかった';
  if (part.id === 'revenge' || part.id === 'duel') return `${x.grudge ? nm(x.grudge) : x.enemy?.name || ''}への怒りがおさまらない`;
  if (part.id === 'proposeLaw') return x.theftConcern ? x.theftConcern.text : '町がこのままではまずい';
  if (part.id === 'confess' || part.id === 'giftCrush') return '胸の内を抑えきれない';
  if (part.id === 'impulseSteal') return c.coins < 3 ? 'お金に困っていた' : 'ふと魔が差した';
  if (part.id === 'frame' || part.id === 'sabotage') return '誰にも言えない思いから';
  const c0 = c.psy.concerns.slice(-1)[0];
  if (m.anger > 60) return 'イライラしていた';
  if (m.fear > 60) return '不安でたまらない';
  if (m.boredom > 60) return '退屈だった';
  if (c0 && S.t - c0.t < 600) return c0.text;
  return '';
}

// ================= 相手のところに着いたとき（kind: 'psy'） =================
export function meet(a, b) {
  const act = a.psyAct; a.psyAct = null;
  if (!act) return;
  const L = (x, y) => (b.tone === 'polite' || a.tone === 'polite' ? y : x);
  const bid = b.isPlayer ? 'player' : b.id;
  switch (act.what) {
    case 'meal': {
      say(a, `${b.name}、一緒にご飯どう？ おごるよ。`);
      if (rel(b, a).like > 10 && !b.isPlayer && S.t >= b.busyUntil) { setTimeout(() => say(b, 'いいね、行こう！'), 1200); Sim.setPlan(a, { place: 'diner', act: 'eat' }); Sim.setPlan(b, { place: 'diner', act: 'eat' }); addLike(a, b, 5); addLike(b, a, 6); log(`🍽️ ${a.name}が${b.name}を食事に誘った`, 'life'); }
      else setTimeout(() => say(b, 'ごめん、今はいいや。'), 1200);
      break;
    }
    case 'apology': {
      say(a, L('……この前は悪かった。', '……先日は申し訳ありませんでした。'));
      const ok = rel(b, a).like > -60 && chance(0.5 + (b.psy?.t.empathy || 0.5) * 0.4);
      setTimeout(() => say(b, ok ? 'まあ……もういいよ。' : '今さら何だよ。'), 1300);
      if (ok) { addLike(b, a, 20); addLike(a, b, 10); log(`🤝 ${a.name}が${b.name}に謝り、わだかまりが少し解けた`, 'life'); } else { addLike(a, b, -5); notice(a, 'rejected'); }
      break;
    }
    case 'loan': {
      say(a, L('悪いんだけど、少しお金を貸してくれないか？', '申し訳ないのですが、少しお金を貸していただけませんか？'));
      if (rel(b, a).like >= 20 && b.coins >= 8 && chance(0.4 + (b.psy?.t.empathy || 0.5) * 0.4)) {
        const n = Math.min(5, Math.floor(b.coins / 2)); b.coins -= n; a.coins += n;
        (a.psy.debts[b.id] = { n, due: day() + 2, mine: true }); if (b.psy) b.psy.debts[a.id] = { n, due: day() + 2, mine: false };
        setTimeout(() => say(b, `${n}Gだけね。ちゃんと返してよ。`), 1300);
        log(`💰 ${a.name}が${b.name}から${n}G借りた（2日後に返す約束）`, 'life');
      } else { setTimeout(() => say(b, '悪いけど、無理だね。'), 1300); notice(a, 'rejected'); addLike(a, b, -4); }
      break;
    }
    case 'repay': {
      const d = a.psy.debts[b.id]; if (!d) break;
      const n = Math.min(d.n, Math.floor(a.coins)); a.coins -= n; b.coins += n;
      delete a.psy.debts[b.id]; if (b.psy) delete b.psy.debts[a.id];
      say(a, `借りてた${n}G、返すよ。ありがとう。`); addLike(b, a, 10);
      log(`💰 ${a.name}が${b.name}に借りていた${n}Gを返した`, 'life');
      break;
    }
    case 'collect': {
      const d = a.psy.debts[b.id]; if (!d) break;
      say(a, `${b.name}、貸した${d.n}G、そろそろ返してもらおうか。`);
      if (b.coins >= d.n && (b.p.honesty > 0.4 || rel(b, a).fear > 30)) {
        b.coins -= d.n; a.coins += d.n; delete a.psy.debts[b.id]; if (b.psy) delete b.psy.debts[a.id];
        setTimeout(() => say(b, 'わ、わかったよ。ほら。'), 1300); log(`💰 ${a.name}が${b.name}から貸した${d.n}Gを取り立てた`, 'life');
      } else {
        setTimeout(() => say(b, '今は無理だって！'), 1300); addLike(a, b, -15); d.due = day() + 1;
        notice(a, 'insulted', { about: b, text: `${b.name}が借金を返さない` }); log(`💢 ${b.name}が${a.name}への借金を踏み倒そうとしている`, 'life');
      }
      break;
    }
    case 'confess': {
      say(a, L(`${b.name}……実は、ずっと前から好きだった。`, `${b.name}さん……実は、ずっとお慕いしていました。`), 5);
      const yes = !b.isPlayer && rel(b, a).like >= 50 && b.female !== a.female;
      setTimeout(() => say(b, yes ? '……うれしい。私も、です。' : 'ごめん……そういうふうには見られない。', 5), 1600);
      if (yes) { (S.bonds ||= {})[[a.id, b.id].sort().join(':')] = 'lover'; notice(a, 'loved'); notice(b, 'loved'); log(`💕 ${a.name}が${b.name}に告白し、ふたりは付き合うことになった！`, 'event'); }
      else { notice(a, 'rejected', { text: `${b.name}にふられた` }); log(`💔 ${a.name}が${b.name}に告白して、ふられた`, 'event'); addLike(b, a, -3); }
      break;
    }
    case 'lobby': {
      const item = S.meeting?.agenda.find((x) => x.proposer === a.id);
      say(a, L(`次の話し合い、${item ? '「' + Town.describe(item.rule).replace(/（.*）/, '') + '」' : 'あの件'}に賛成してくれないか？`, `次の話し合いで、${item ? '「' + Town.describe(item.rule).replace(/（.*）/, '') + '」' : 'あの件'}に賛成していただけませんか？`));
      if (rel(b, a).like >= 10 && !b.isPlayer) { b.leanFor = { id: a.id, until: S.t + 1440 }; setTimeout(() => say(b, 'まあ、考えておくよ。'), 1300); log(`🤫 ${a.name}が${b.name}に根回しをした`, 'mind'); }
      else setTimeout(() => say(b, '自分で決めるよ。'), 1300);
      break;
    }
    case 'recruit': {
      const g = (S.groups || []).find((x) => x.id === act.data.gid); if (!g) break;
      say(a, `「${g.name}」に入らないか？`);
      if (rel(b, a).like >= 15 && !b.isPlayer && chance(0.6)) { g.members.push(b.id); setTimeout(() => say(b, 'いいよ、入る。'), 1200); log(`👥 ${b.name}が「${g.name}」に入った`, 'life'); }
      else setTimeout(() => say(b, 'やめとく。'), 1200);
      break;
    }
    case 'seer': {
      const t = Wolf.topSuspect(a)?.t;
      if (!t || t === b) break;
      say(a, `${b.name}、${nm(t)}のことを占ってくれないか。`);
      const black = Seer.readFor(b, t);
      setTimeout(() => say(b, black ? `……${nm(t)}に、獣の影が見える。` : `${nm(t)}からは、悪い気配はしないよ。`, 5), 1500);
      Wolf.addSus(a, t.isPlayer ? 'player' : t.id, black ? 25 : -20, `占い師の${b.name}が${black ? '黒' : '白'}と占った`);
      a.coins = Math.max(0, a.coins - 2); b.coins += 2;
      log(`🔮 ${a.name}が占い師の${b.name}に${nm(t)}を占ってもらった（${black ? '黒' : '白'}）`, 'mind');
      break;
    }
    case 'spy': {
      memo(a, `${b.name}の様子をこっそりうかがった。${Sim.activityText(b)}`, 'info');
      if (b.isWolf && chance(0.3)) Wolf.addSus(a, b.id, 15, 'こっそり見ていたら、どこか様子がおかしかった');
      if (distTiles(a, b) < 2 && chance(0.3)) { say(b, '……なに見てるの？'); addLike(b, a, -8); }
      break;
    }
    case 'frame': {
      const t = byId(act.data.target); if (!t) break;
      const lie = pick([`${t.name}が夜中にうろついてるのを見た`, `${t.name}がこっそり人の家をのぞいてた`, `${t.name}が金をくすねてるのを見た`]);
      say(a, `ここだけの話……${lie}んだ。`, 5);
      memo(b, `${a.name}によると、${lie}らしい`, 'night'); addLike(b, t, -12); if (S.wolfKnown) Wolf.addSus(b, t.id, 20, `${a.name}から${lie}と聞いた`);
      log(`🤫 ${a.name}が${b.name}に、${t.name}についての嘘を吹き込んだ`, 'crime');
      break;
    }
    case 'duel': {
      say(a, `${b.name}！ 決闘だ。どっちが上か、はっきりさせようじゃないか。`, 5);
      const accept = b.isPlayer ? false : (b.psy?.t.pride || 0.4) + b.p.aggression > 0.8 || chance(0.3);
      if (!accept) { setTimeout(() => say(b, '……くだらない。'), 1300); addLike(b, a, -6); notice(a, 'praised'); log(`⚔️ ${a.name}が${b.name}に決闘を申し込んだが、${b.name}は相手にしなかった`, 'event'); break; }
      setTimeout(() => say(b, '望むところだ！'), 1300);
      const pa = a.str + S.rand() * 12, pb = b.str + S.rand() * 12;
      const [win, lose] = pa >= pb ? [a, b] : [b, a];
      lose.hp = Math.max(5, lose.hp - 20); const n = Math.min(3, Math.floor(lose.coins)); lose.coins -= n; win.coins += n;
      notice(lose, 'attacked', { about: win, text: `${win.name}との決闘に負けた` }); if (lose.psy) lose.psy.concerns.push({ kind: 'duelLost', text: `${win.name}に決闘で負けた`, t: S.t, w: 2 });
      notice(win, 'praised');
      for (const o of residents()) if (o.alive && o !== win && o !== lose) addFear(o, win, 4);
      log(`⚔️ ${a.name}と${b.name}が決闘し、${win.name}が勝った（${lose.name}は体力-20、${n}Gを取られた）`, 'event');
      S.stats.duels = (S.stats.duels || 0) + 1;
      Laws.enforce(a, 'duel', Sim.watchers(a), Sim.lawHooks); Laws.enforce(b, 'duel', Sim.watchers(b), Sim.lawHooks);
      break;
    }
    case 'extort': {
      say(a, `${b.name}、この店を守ってやってるのは誰だと思ってる？ 用心棒代を払ってもらおうか。`, 5);
      const pay = b.p.aggression < 0.5 || rel(b, a).fear > 25;
      if (pay) { const n = Math.min(4, Math.floor(b.coins)); b.coins -= n; a.coins += n; addFear(b, a, 15); addLike(b, a, -20); setTimeout(() => say(b, `……${n}Gだ。持っていけ。`), 1300); log(`💀 ${a.name}が${b.name}から用心棒代${n}Gを取り立てた`, 'crime'); }
      else { setTimeout(() => say(b, 'ふざけるな、出ていけ！'), 1300); addLike(b, a, -25); log(`💀 ${a.name}が${b.name}に用心棒代を要求したが、追い返された`, 'crime'); }
      notice(b, 'insulted', { about: a, text: `${a.name}に用心棒代をせびられた` });
      break;
    }
  }
  void bid;
}

// ================= 会（自警団・商売仲間・反村長派 など） =================
function foundGroup(c, x) {
  S.groups ||= [];
  const kind = S.wolfKnown || x.theftConcern ? 'watch' : c.psy.goal.kind === 'mayor' || (Town.mayor() && rel(c, Town.mayor().id).like < -20) ? 'faction' : c.psy.interests.includes('money') ? 'guild' : 'club';
  const NAMES = { watch: ['夜回りの会', '町を守る会', '自警団'], faction: ['町を変える会', '新しい町の会'], guild: ['商売仲間の会', '金の卵の会'], club: ['酒飲みの会', 'のんびりの会', '噂好きの会'] };
  const used = new Set(S.groups.map((x) => x.name));
  const free2 = NAMES[kind].filter((n) => !used.has(n));
  if (!free2.length) return false;
  const g = { id: 'G' + (S.groupSeq = (S.groupSeq || 0) + 1), name: pick(free2), kind, leader: c.id, members: [c.id], day: day() };
  S.groups.push(g);
  post(c.name, `「${g.name}」を作った。${{ watch: '夜の町を見回る。仲間を募集中。', faction: '今の町のやり方を変えたい者は集まれ。', guild: 'もうけ話を分け合おう。', club: '気軽に集まろう。' }[kind]}`, { authorId: c.id });
  log(`👥 ${c.name}が「${g.name}」を作った`, 'event');
  return true;
}
function groupsDaily() {
  for (const g of S.groups || []) {
    g.members = g.members.filter((id) => byId(id)?.alive);
    if (!g.members.length) g.gone = true;
  }
  S.groups = (S.groups || []).filter((g) => !g.gone);
}
// 夜回りの会のメンバーは、夜に広場を見回る（人狼が出歩いていれば見つけることも）
export function patrols(c) {
  if (!c.psy) return false;
  const h = hour();
  if (!(h >= 21 && h < 23)) return false;
  const g = (S.groups || []).find((gr) => gr.kind === 'watch' && gr.members.includes(c.id));
  if (!g || c.isWolf || chance(0.5)) return false;
  Sim.setPlan(c, { place: 'plaza', tile: Sim.plazaTile(), act: 'patrol' });
  return true;
}
// 反村長派・商売仲間は、話し合いで仲間の提案に乗りやすい（Town.bias で使う）
export const groupOf = (c) => (S.groups || []).find((g) => g.members.includes(c.id));

// ================= 宴会 =================
function planFeast(c) {
  const at = hour() < 15 ? 19 : null;
  const d = at ? day() : day() + 1;
  const ev = { kind: 'feast', host: c.id, day: d, hour: at || 19, place: c.job === 'cook' ? 'diner' : 'tavern', done: false };
  (S.events ||= []).push(ev);
  post(c.name, `${d === day() ? '今夜' : '明日の夜'}${ev.hour}時から${ev.place === 'diner' ? '食堂' : '酒場'}で宴会をやるよ！ みんな来てね。`, { authorId: c.id });
  log(`🎉 ${c.name}が${d === day() ? '今夜' : '明日の夜'}の宴会を企画した`, 'event');
  return true;
}
function startEvent(ev) {
  ev.done = true;
  const host = byId(ev.host);
  const goers = residents().filter((o) => free(o) && o.activity !== 'sleep' && !o.companion && (o === host || chance(0.3 + o.p.sociability * 0.5 - (host ? (rel(o, host).like < -20 ? 0.5 : 0) : 0))));
  for (const o of goers) Sim.setPlan(o, { place: ev.place, act: 'drink' });
  setTimeout(() => {
    for (const a of goers) for (const b of goers) if (a !== b && a.alive && b.alive) addLike(a, b, 3);
    for (const o of goers) notice(o, 'party');
  }, 0);
  log(`🎉 ${host?.name || '誰か'}の宴会に${goers.length}人が集まった`, 'event');
  if (S.player.alive && distTiles(S.player, goers[0] || S.player) < 30) toast(`🎉 ${ev.place === 'diner' ? '食堂' : '酒場'}で宴会が始まった！`);
}
