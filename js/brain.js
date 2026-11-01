// 住民の「頭の中」。
// 会話は「意味の読み取り(dialog.js) → ゲームとしての判断 → セリフ」の順で作る。
// AIが使えるときは、判断した内容をAIにキャラクターの口調で言い換えてもらう（判断はブレない）。
import { LLM } from './llm.js';
import { S, day, hour, timeStr, rel, pick, chance, jobName, post, clamp, residents, recentEvents } from './state.js';
import { ITEMS, JOBS, TILE, PLAZA, MEAL_COST, DRINK_COST } from './data.js';
import { facAt } from './world.js';
import * as Dlg from './dialog.js';
import * as Wolf from './wolf.js';
import * as Town from './town.js';

const STANCES = ['peaceful', 'work', 'scheme', 'aggressive'];
const rnd = Math.random;

// ================= 状況の言葉 =================
export function locName(c) {
  const tx = Math.floor(c.x / TILE), ty = Math.floor(c.y / TILE);
  const f = facAt(tx, ty);
  if (f) return f.name;
  if (tx >= PLAZA.x && tx < PLAZA.x + PLAZA.w && ty >= PLAZA.y && ty < PLAZA.y + PLAZA.h) return '広場';
  return '町の通り';
}

const ACT_TEXT = {
  work: (c) => `${jobName(c)}の仕事をしている`, eat: () => 'ご飯を食べている', drink: () => '一杯やっている',
  sleep: () => '寝ている', train: () => '体を鍛えている', heal: () => '治療を受けている', rest: () => '家でくつろいでいる',
  wander: () => 'ぶらぶらしている', board: () => '掲示板を見ている', buyfood: () => '買い物をしている',
  research: () => '研究をしている', forage: () => '畑で食べ物を探している', visit: () => 'ひと休みしている', sit: () => 'ひと休みしている',
};

export function actText(c) {
  if (c.companion) return 'あんたと一緒に歩いている';
  if (c.activity && S.t < c.busyUntil && ACT_TEXT[c.activity]) return ACT_TEXT[c.activity](c);
  if (c.plan?.place && c.plan.place !== 'plaza' && c.plan.place !== 'meteor') return `${Dlg.placeName(c.plan.place)}に向かっている`;
  return 'ぶらぶらしている';
}

function nextText(c) {
  const h = hour();
  const job = JOBS[c.job];
  if (h >= 21 || h < 6) return '家に帰って寝る';
  if (c.hunger < 50) return '何か食べに行く';
  if (job?.place && h < job.to && !(c.activity === 'work' && S.t < c.busyUntil)) return `${Dlg.placeName(job.place)}で働く`;
  if (h >= 17) return '酒場か家でのんびりする';
  return 'ぶらぶらする';
}

function feeling(r) {
  let s = r.like >= 50 ? '大好きで信頼している' : r.like >= 20 ? '好意を持っている' : r.like > -15 ? 'まだよく知らない' : r.like > -45 ? '警戒している' : '嫌っている';
  if (r.fear >= 40) s += '（そして怖がっている）';
  return s;
}

function holderName() {
  const h = S.chars.find((c) => c.items.includes('meteor'));
  return h ? (h.isPlayer ? 'よそ者' : h.name) : '誰か';
}

function situation() {
  const parts = [`町の食料の蓄えは${Math.floor(S.foodStock)}食分`];
  if (S.droughtUntilDay >= day()) parts.push('日照りで畑の実りが悪い');
  if (S.meteor) {
    const m = S.meteor;
    if (m.state === 'ground') parts.push('空から落ちた光る石が地面に転がっている');
    else if (m.state === 'done') parts.push(`光る石の正体は「${ITEMS[m.result].name}」だった`);
    else parts.push(`光る石は${holderName()}が持っている`);
  }
  const recent = S.log.filter((l) => l.kind === 'crime' || l.kind === 'death').slice(0, 2);
  if (recent.length) parts.push('最近の事件: ' + recent.map((l) => l.text).join(' / '));
  return parts.join('。');
}

function needs(c) {
  const n = [];
  if (c.hunger < 35) n.push('お腹がとても空いている');
  if (c.hp < 50) n.push('けがをしている');
  if (c.coins < 2) n.push('お金がほとんどない');
  return n.join('、');
}

function personaOf(c) {
  return c.persona || `${jobName(c)}をしている町の住民の${c.female ? '女性' : '男性'}。`;
}

function relSummary(c) {
  const arr = Object.entries(c.rel)
    .filter(([id]) => id !== 'player')
    .map(([id, r]) => ({ n: S.chars.find((x) => x.id === id)?.name, ...r }))
    .filter((x) => x.n && (Math.abs(x.like) >= 30 || x.fear >= 30))
    .sort((a, b) => Math.abs(b.like) - Math.abs(a.like))
    .slice(0, 4);
  if (!arr.length) return '特に強い感情はない';
  return arr.map((x) => `${x.n}を${x.like >= 30 ? '好き' : x.like <= -30 ? '嫌い' : ''}${x.fear >= 30 ? '・怖い' : ''}`).join('、');
}

function selfDesc(c) {
  const t = Dlg.toneOf(c);
  return `あなたは町「ナリユキワールド」の住民、${c.name}（${jobName(c)}・${c.female ? '女性' : '男性'}）。${personaOf(c)}\n` +
    `口調: ${t.desc}。一人称は「${Dlg.firstPerson(c)}」。口調の例:「${t.samples.join('」「')}」\n` +
    `いま: ${day()}日目 ${timeStr()}、${locName(c)}で${actText(c)}。所持金${Math.floor(c.coins)}G。${needs(c)}\n` +
    `好きなもの: ${c.likes || '特になし'}。ほかの住民への気持ち: ${relSummary(c)}\n` +
    `最近の記憶: ${c.memory.slice(-4).join(' / ') || '特になし'}\n` +
    `町の様子: ${situation()}` + wolfDesc(c);
}

function wolfDesc(c) {
  if (!S.wolf) return '';
  let t = '';
  if (S.wolfKnown) {
    t += `\n町では人狼に${S.wolf.kills.length}人が殺されている。みんな怯えている。`;
    const top = Wolf.suspectLine(c);
    if (top && !c.isWolf) t += `あなたが一番疑っているのは${top.t.name}（${top.why}から）。`;
  }
  if (c.isWolf) t += `\n【秘密】あなたの正体は人狼。絶対に自分から明かさない。疑われてもとぼけて、${S.wolf.frame ? byName(S.wolf.frame) + 'が怪しいと' : '他の人に'}話をそらす。`;
  return t;
}
const byName = (id) => S.chars.find((x) => x.id === id)?.name || '誰か';

// ================= プレイヤーとの会話 =================
export async function talk(c, text, history) {
  const it = Dlg.parseIntent(text, residents(), c);
  const res = respond(c, it, text);
  // 小さいAIは日本語が崩れやすいので、内容が決まっている返事（誘い・頼みごと等）は
  // 手書きのセリフをそのまま使い、AIには「決まった答えのない雑談」だけを任せる
  const useAI = LLM.available() && res.say && (res.mode === 'free' || LLM.strong());
  // via: 'ai' = AIが返事した／'rule' = AIなしの返事（無料枠切れ・AIの返事が使えなかったときも）
  res.via = 'rule';
  if (useAI) {
    const out = await llmPhrase(c, text, history, res);
    if (out) { res.say = out; res.via = 'ai'; }
  } else {
    await new Promise((r) => setTimeout(r, 350 + rnd() * 450));
  }
  return res;
}

function gainLike(c, v) {
  // 同じ日に会話だけで上がる好感度には上限（同じ言葉の連打対策）
  if (v <= 0) return v;
  if (c.talkGainDay !== day()) { c.talkGainDay = day(); c.talkGain = 0; }
  const ok = Math.max(0, Math.min(v, 12 - c.talkGain));
  c.talkGain += ok;
  return ok;
}

function memoryAbout(c, target) {
  const m = c.memory.slice().reverse().find((x) => x.includes(target.name) && /(見た|された|殴|盗|助け)/.test(x));
  return m ? m.replace(/^\d+日目 /, '') : null;
}

// 賄賂が通じるか（手配中のプレイヤーが衛兵にお金を渡したとき）
export function bribeWorks(t, n) {
  if (t.job !== 'guard' || !S.wanted.has('player')) return false;
  const like = rel(t, 'player').like;
  if (t.p.greed > 0.6) return n >= 4 || (n >= 2 && like > 20);
  return t.p.honesty < 0.7 && n >= 15;
}

// 渡したときの反応（giveToNpc の結果から）
export function giftLine(c, g) {
  const ln = (k, v) => Dlg.line(c, k, v, rnd);
  const item = g.label;
  switch (g.react) {
    case 'love': return ln('giftLove', { item });
    case 'hungry': return ln('giftHungry');
    case 'big': return ln('giftBig', { item });
    case 'bribe': return ln('giftBribe');
    case 'suspicious': return ln('giftSuspicious');
    case 'cursed': return ln('giftCursed');
    case 'none': return ln('giftNone');
    case 'quest': return Dlg.lineN(c, ['わあ、持ってきてくれたんだ！ ありがとう、約束のお礼だよ。', 'まあ、本当に持ってきてくださったんですね！ 約束のお礼です。']);
    default: return ln('giftGood', { item });
  }
}

// 渡す前に反応を予想する（会話の返事を先に作るため）
function previewGift(c, g) {
  const p = S.player;
  if (g.coins) {
    const n = Math.min(g.coins, Math.floor(p.coins));
    if (n <= 0) return { react: 'none' };
    if (bribeWorks(c, n)) return { react: 'bribe', label: `${n}G` };
    if (rel(c, p).like < -20) return { react: 'suspicious', label: `${n}G` };
    return { react: n >= 5 ? 'big' : 'good', label: `${n}G` };
  }
  if (g.item === 'food') {
    if (p.food < 1) return { react: 'none' };
    if (c.quest && c.quest.item === 'food') return { react: 'quest', label: '食べ物' };
    return { react: c.hunger < 40 ? 'hungry' : rel(c, p).like < -20 ? 'suspicious' : 'good', label: '食べ物' };
  }
  if (!p.items.includes(g.item)) return { react: 'none' };
  const label = ITEMS[g.item].name;
  if (c.quest && c.quest.item === g.item) return { react: 'quest', label };
  if (g.item === c.likesItem) return { react: 'love', label };
  if (g.item === 'cursed') return { react: 'cursed', label };
  return { react: rel(c, p).like < -20 ? 'suspicious' : 'good', label };
}

// 「何があったの？」に答えるための、最近の出来事の言い換え
function tellEvent(c) {
  const ev = recentEvents(c, 10, ['crime'])[0] || recentEvents(c, 10, ['gift'])[0];
  if (!ev) return null;
  const t = ev.text;
  const m = t.match(/^(.+?)に(盗まれた|殴られた|脅された|捕まった)$/);
  if (m) return { key: m[1] === 'よそ者' ? 'whVictimPlayer' : 'whVictim', vars: { actor: m[1], what: m[2] } };
  if (/^よそ者が.+のを見た$/.test(t)) return { key: 'whSawPlayer', vars: { event: t.replace(/^よそ者が/, '').replace(/のを見た$/, '') } };
  if (/のを見た$/.test(t)) return { key: 'whWitness', vars: { event: t } };
  return { key: 'whOther', vars: { event: t.replace(/^よそ者から/, 'あんたから') } };
}

// 頼みごとまわり
function nameToChar(n) { return n === 'よそ者' ? S.player : S.chars.find((x) => x.name === n) || null; }

// この住民が知っている「悪いことをした人」
function culpritFromMemory(c) {
  for (const e of recentEvents(c, 30, ['crime'])) {
    let m = e.text.match(/^(.+?)が(.+?)に(.+)のを見た$/);
    if (m) return { who: nameToChar(m[1]), text: e.text };
    m = e.text.match(/^(.+?)に(盗まれた|殴られた|脅された)$/);
    if (m) return { who: nameToChar(m[1]), text: e.text };
  }
  return null;
}

function spreadWhat(c, t) {
  const k = culpritFromMemory(c);
  if (k && k.who === t) return k.text.replace(/のを見た$/, '').replace(/^.+?が/, '') + 'のを見た人がいる';
  if (S.wolfKnown) return '人狼かもしれない';
  return 'よからぬことを企んでいる';
}

function taskWilling(c, type, t, known) {
  const like = rel(c, 'player').like + (c.favor || 0) * 8;
  if (!t.isPlayer && rel(c, t).like >= 50 && type !== 'watch') return 'friend';
  const knows = known?.who === t || Wolf.sus(c, t.id) >= 40;
  switch (type) {
    case 'report': return knows ? like >= -10 : like >= 35;
    case 'spread': return (knows && like >= 0) || (like >= 30 && c.p.honesty < 0.85);
    case 'watch': return like >= 30 || (c.job === 'guard' && S.wolfKnown && like >= 0) || (knows && like >= 10);
    case 'attack':
      if (c.p.aggression < 0.45 || c.p.honesty > 0.85) return 'violence';
      return like >= 45 || (!t.isPlayer && rel(c, t).like <= -30 && like >= 10);
  }
  return false;
}

function taskAcceptLine(c, task) {
  const t = task.targetId === 'player' ? null : S.chars.find((x) => x.id === task.targetId);
  const tn = t ? t.name : 'あんた';
  const L = (a, b) => Dlg.lineN(c, [a, b]);
  if (task.type === 'report') return c.job === 'guard' ? L(`わかった。${tn}のことは${Dlg.firstPerson(c)}が手配する。`, `わかりました。${tn}さんのことは私が手配します。`)
    : L(`わかった。{I}が詰所に行って、${tn}のことを伝えてくるよ。`, `わかりました。私が詰所に行って、${tn}さんのことを伝えてきます。`);
  if (task.type === 'spread') return L(`任せて。${tn}のこと、それとなくみんなに話しておくよ。`, `わかりました。${tn}さんのこと、それとなく皆さんに伝えておきます。`);
  if (task.type === 'watch') return L(`わかった。今夜、${tn}の家をこっそり見張ってみるよ。朝になったら教えるね。`, `わかりました。今夜、${tn}さんの家を見張ってみます。朝になったらお伝えしますね。`);
  return L(`へっ、任せとけ。${tn}にはちょうどムカついてたんだ。`, `……わかりました。${tn}さんに話をつけてきます。`);
}

// 頼みごとの結果の報告セリフ
export function taskLine(c, kind, t, extra = '') {
  const tn = t ? (t.isPlayer ? 'あんた' : t.name) : '';
  const L = (a, b) => Dlg.lineN(c, [a, b]);
  switch (kind) {
    case 'report': return L(`頼まれてた件、詰所に伝えておいたよ。${tn}は手配されたって。`, `お願いされた件、詰所に伝えておきました。${tn}さんは手配されたそうです。`);
    case 'reportFail': return L('詰所に行ったけど、まともに取り合ってもらえなかったよ……。', '詰所に行ったのですが、取り合ってもらえませんでした……。');
    case 'spread': return L(`${tn}のこと、何人かに話しておいたよ。`, `${tn}さんのこと、何人かにお伝えしておきました。`);
    case 'attack': return L(`${tn}のやつ、少し懲らしめてやったぜ。`, `${tn}さんとは話をつけてきました。`);
    case 'watchSaw': return L(`見張ってたら……${extra}んだ！ 間違いないよ。`, `見張っていたら……${extra}んです！ 間違いありません。`);
    case 'watchNone': return L(`一晩じゅう見張ってたけど、${tn}は家から一歩も出てこなかったよ。`, `一晩じゅう見張っていましたが、${tn}さんは家から出てきませんでした。`);
    case 'stoodUp': return L(`……${extra}でずっと待ってたのに、来なかったね。`, `……${extra}でお待ちしていたのですが、いらっしゃいませんでしたね。`);
    case 'gone': return L('頼まれてた件だけど……もうどうしようもなくなっちゃった。', 'お願いされた件ですが……もうどうしようもなくなりました。');
  }
  return '';
}

// 頼まれたことの結果を話す（1回だけ）
export function takeTaskReport(c) {
  const d = c.taskDone;
  if (!d) return null;
  c.taskDone = null;
  return d.text;
}

// 一緒に過ごしているときのおしゃべり
export function togetherLine(c, dest) {
  const L = (a, b) => Dlg.lineN(c, [a, b]);
  const opts = dest === 'tavern' ? ['乾杯！', 'ぷはー、うまい！', 'こうやって飲むのもいいね。', 'もう一杯いっちゃう？']
    : dest === 'diner' ? ['おいしいね。', 'ここの料理、好きなんだ。', 'ヨルの料理は町一番だよ。'] : ['いい時間だね。', 'のんびりできるね。'];
  if (S.wolfKnown && chance(0.3)) { const top = Wolf.suspectLine(c); if (top) return L(`……ここだけの話、${top.name}が怪しいと思ってるんだ。`, `……ここだけの話ですが、${top.name}が気になっています。`); }
  if (chance(0.25)) { const ev = recentEvents(c, 12, ['crime'])[0]; if (ev && !ev.text.includes('よそ者')) return L(`そういえば、${ev.text}んだよ。`, `そういえば、${ev.text}んです。`); }
  return pick(opts);
}

// 住民が持ち物を売るときの値段（欲深さ・好感度・物の価値で決まる）
const VALUE = { meteor: 30, elixir: 25, bomb: 20, silver: 30, weapon: 12, cursed: 2, flower: 4, sweets: 4, book: 8, sake: 5 };
function tradeTerms(c, item) {
  let v = VALUE[item] ?? 5;
  if (item === 'meteor' && c.job === 'researcher') v *= 1.8;
  if (item === 'silver' && S.wolfKnown) v *= 1.3;
  if (item === c.likesItem) v *= 1.5;
  const like = rel(c, 'player').like;
  const mood = like >= 40 ? 0.8 : like <= -20 ? 1.4 : 1;
  return { ask: Math.max(1, Math.round(v * (0.9 + c.p.greed * 0.7) * mood)), min: Math.max(1, Math.round(v * (0.55 + c.p.greed * 0.45) * mood)) };
}

export function inviteDecision(c, place, treat) {
  const r = rel(c, 'player');
  const h = hour();
  if (c.jailedUntil > S.t) return 'jailed';
  if (h >= 22 || h < 6) return 'late';
  if (c.companion) return 'already';
  if (r.fear >= 55) return 'fear';
  if (r.like <= -20) return 'cold';
  const job = JOBS[c.job];
  const working = c.activity === 'work' && S.t < c.busyUntil;
  let score = 0.15 + r.like / 90 + c.p.sociability * 0.35;
  if (c.metPlayer) score += 0.08;
  score += Math.min(0.4, (c.favor || 0) * 0.08);
  if (place === 'diner') {
    if (c.hunger > 85 && !treat) return 'full';
    if (c.hunger < 65) score += 0.35;
    if (!treat && c.coins < MEAL_COST) return 'nomoney';
  }
  if (place === 'tavern') { score += c.p.sociability * 0.2 + (h >= 17 ? 0.25 : 0); if (!treat && c.coins < DRINK_COST) return 'nomoney'; }
  if (place === 'training') score += c.p.aggression * 0.35;
  if (place === 'guard' && rel(c, 'player') && S.wanted.has(c.id)) return 'cold';
  if (treat) score += 0.35 + c.p.greed * 0.25;
  if (working) score -= 0.4 - (r.like >= 60 ? 0.3 : 0);
  if (score >= 0.45) return 'ok';
  if (working && h < job.to) return 'busy';
  return 'cold';
}

function respond(c, it, raw) {
  const r = rel(c, 'player');
  const like = r.like;
  const res = { say: '', action: 'none', amount: 1, like: 0, fear: 0, belief: null, follow: null, guide: null, dismiss: false, close: false, mode: 'phrase', kind: it.kind };
  const ln = (k, v) => Dlg.line(c, k, v, rnd);
  const pend = c.pending && S.t - c.pending.t < 180 ? c.pending : null;
  c.pending = null;
  // 「お願いするよ」「頼んだ」なども、持ちかけ中の話への「はい」とみなす
  if (pend && it.yesish && ['unknown', 'question', 'thanks', 'reqReport'].includes(it.kind)) it = { ...it, kind: 'yes' };
  // 値段の交渉中に「〇G払う」と言ったら、それは提示額
  if (pend?.type === 'trade' && it.kind === 'gift' && it.coins) it = { ...it, kind: 'offer' };
  // 「話し合い？ 何について？」と聞かれたあとに、人の名前を出したら議題になる
  if (pend?.type === 'meetingWhy' && it.target && !['gift', 'askItem', 'offer'].includes(it.kind)) it = { ...it, kind: 'meeting', trial: true };
  if (pend?.type === 'trade' && it.kind === 'askItem' && it.item === pend.item && it.price != null) it = { ...it, kind: 'offer', coins: it.price };
  const sub = (v) => ({ sub: v });

  const doInvite = (place, treat) => {
    const d = inviteDecision(c, place, treat);
    const pn = place ? Dlg.placeName(place) : '';
    switch (d) {
      case 'ok': case 'fear':
        res.follow = { dest: place, treat: !!treat };
        res.like = gainLike(c, d === 'fear' ? 0 : 3);
        res.say = d === 'fear' ? ln('fear_yield') : treat ? ln('invite_ok_treat') : place === 'diner' && c.hunger < 65 ? ln('invite_ok_food')
          : place ? ln('invite_ok', { place: pn }) : ln('follow_ok');
        break;
      case 'already':
        if (place) c.companion.dest = place;
        if (treat) c.companion.treat = true;
        res.say = ln('already'); break;
      case 'late': res.say = ln('sleepy'); break;
      case 'jailed': res.say = Dlg.lineN(c, ['見ての通り、牢屋の中なんだ……行けるわけないよ。', 'ご覧のとおり牢屋の中です……行けません。']); break;
      case 'full': res.say = ln('invite_full'); break;
      case 'busy': res.say = ln('invite_busy', { until: JOBS[c.job].to }); break;
      case 'nomoney': res.say = ln('invite_nomoney'); c.pending = { type: 'invite', place, t: S.t }; break;
      default: res.say = ln('invite_cold'); res.like = -1;
    }
  };

  switch (it.kind) {
    case 'greet': {
      const key = like >= 30 ? 'greet_hi' : like <= -20 ? 'greet_cold' : 'greet';
      res.say = ln(key);
      if (!c.metPlayer && key !== 'greet_cold') { res.say += ln('intro', { job: jobName(c) }); c.metPlayer = true; }
      res.like = gainLike(c, 1);
      const done = takeTaskReport(c);
      if (done) { res.say += done; res.note = `${c.name}の報告：${done}`; }
      else if (c.lastGift && S.t - c.lastGift.t < 8 * 60 && key !== 'greet_cold') res.say += ln('thanksGift', { gift: c.lastGift.label });
      else {
        const ev = recentEvents(c, 3, ['crime'])[0];
        if (ev && !ev.text.includes('よそ者')) res.say += ln('news', { event: 'さっき' + ev.text });
      }
      if (c.hunger < 35 && like >= -10 && !c.pending) {
        res.say += ln('askFoodPlayer');
        c.pending = { type: 'wantFood', t: S.t };
      }
      const h = hour();
      if (!c.pending && like >= 15 && c.hunger < 60 && c.coins >= MEAL_COST && !c.companion && ((h >= 11 && h <= 13) || (h >= 18 && h <= 20))) {
        res.say += ln('npcInvite', { place: '食堂' });
        c.pending = { type: 'npcInvite', place: 'diner', t: S.t };
      }
      break;
    }
    case 'intro': res.say = ln('intro', { job: jobName(c) }); c.metPlayer = true; res.like = gainLike(c, 1); break;
    case 'bye': res.say = ln('bye'); res.close = true; break;
    case 'love':
      if (like >= 60) { res.say = ln('loveYes'); res.like = gainLike(c, 6); } else { res.say = ln('loveNo'); res.like = like < 0 ? -3 : 0; }
      break;
    case 'threat':
      res.like = -12;
      if (c.p.aggression > 0.6 && r.fear < 40) { res.say = ln('insult'); res.action = 'attack'; }
      else {
        res.say = ln('threatFear'); res.fear = 15;
        if (r.fear + 15 >= 50 && c.coins >= 1) { res.action = 'give_coin'; res.amount = Math.min(3, Math.floor(c.coins)); }
      }
      break;
    case 'insult':
      res.like = -10; res.say = ln('insult');
      if (c.p.aggression > 0.55 && chance(c.p.aggression)) res.action = 'attack';
      else if (chance(0.3)) res.action = 'flee';
      break;
    case 'apology':
      if (like < -30) { res.say = ln('apologyCold'); res.like = gainLike(c, 2); } else { res.say = ln('apology'); res.like = gainLike(c, 4); }
      break;
    case 'yes':
      if (pend?.type === 'invite') { doInvite(pend.place, true); break; }
      if (pend?.type === 'trade') {
        if (S.player.coins < pend.price) { res.say = Dlg.lineN(c, [`${pend.price}Gだぞ？ 金が足りないじゃないか。`, `${pend.price}Gですよ？ お金が足りないようですが。`]); c.pending = { ...pend, t: S.t }; break; }
        res.trade = { item: pend.item, price: pend.price };
        res.say = Dlg.lineN(c, [`毎度。ほら、${ITEMS[pend.item].name}だ。大事にしなよ。`, `ありがとうございます。どうぞ、${ITEMS[pend.item].name}です。`]);
        break;
      }
      if (pend?.type === 'deal') {
        res.deal = pend.deal;
        res.say = Dlg.lineN(c, ['頼んだぞ……！ 保釈金を払うか、隙を見て鍵を開けてくれ。', 'お願いします……！ 保釈金を払うか、鍵を開けてください。']);
        break;
      }
      if (pend?.type === 'task') {
        res.task = pend.task;
        res.say = taskAcceptLine(c, pend.task);
        break;
      }
      if (pend?.type === 'quest') {
        res.say = Dlg.lineN(c, ['ほんと！？ ありがとう、待ってるね！', '本当ですか！ ありがとうございます、お待ちしています。']);
        res.quest = pend.label; res.like = gainLike(c, 2);
        break;
      }
      if (pend?.type === 'meeting') {
        res.say = Dlg.lineN(c, ['よかった、待ってるよ。', 'よかった。お待ちしていますね。']);
        break;
      }
      if (pend?.type === 'wantFood') {
        const g = previewGift(c, { item: 'food' });
        res.say = giftLine(c, g);
        if (g.react !== 'none') res.gift = { item: 'food' };
        break;
      }
      if (pend?.type === 'npcInvite' || pend?.type === 'guide') {
        res.guide = { place: pend.place };
        res.say = pend.type === 'guide' ? ln('guideGo') : ln('invite_ok', { place: Dlg.placeName(pend.place) });
        res.like = gainLike(c, 2);
        break;
      }
      if (Dlg.RE.TREAT_GIVE.test(it.text)) { doInvite('diner', true); break; }
      if (/(行こう|いこう)/.test(it.text)) { doInvite(null, false); break; }
      res.say = ln('noPending'); res.mode = 'free';
      break;
    case 'no':
      if (pend?.type === 'quest') { c.quest = null; res.say = ln('pendingNo'); break; }
      if (pend) { res.say = ln('pendingNo'); } else { res.say = ln('ack'); res.mode = 'free'; }
      break;
    case 'dismiss':
      if (c.companion) { res.say = ln('dismiss'); res.dismiss = true; } else { res.say = ln('dismissNone'); }
      break;
    case 'thanks': res.say = ln('thanks'); res.like = gainLike(c, 2); break;
    case 'gift': {
      const g = { coins: it.coins, item: it.item };
      const pv = previewGift(c, g);
      res.say = giftLine(c, pv);
      if (pv.react !== 'none') {
        res.gift = g;
        // 「〇Gあげるから一緒に来て」のような頼みごと
        if (it.then) {
          const before = c.favor || 0;
          c.favor = before + 2.5;
          const sub = respond(c, it.then, raw);
          c.favor = before;
          res.say += sub.say;
          for (const k of ['follow', 'guide', 'action', 'amount', 'belief', 'hire']) if (sub[k] && sub[k] !== 'none') res[k] = sub[k];
        }
      }
      break;
    }
    case 'reqReport': case 'reqWatch': case 'reqSpread': case 'reqAttack': {
      const type = { reqReport: 'report', reqWatch: 'watch', reqSpread: 'spread', reqAttack: 'attack' }[it.kind];
      const known = culpritFromMemory(c);
      const target = it.target || (it.self ? c : null) || known?.who || null;
      if (!target) { res.say = Dlg.lineN(c, ['え、誰のこと？', 'ええと、どなたのことでしょう？']); break; }
      if (target === c) { res.say = Dlg.lineN(c, ['……{I}のこと？ 冗談でしょ。', '……私のことですか？ ご冗談を。']); res.like = -4; break; }
      const task = { type, targetId: target.id, what: spreadWhat(c, target) };
      const tn = target.isPlayer ? (Dlg.toneOf(c).pol ? 'あなた' : 'あんた') : target.name;
      if (it.ask && type === 'report') {
        if (known?.who === target || Wolf.sus(c, target.id) >= 40) {
          res.say = Dlg.lineN(c, [`そうだね、${tn}のことは詰所に知らせたほうがいいと思う。{I}が行ってこようか？`, `そうですね、${tn}さんのことは詰所に知らせたほうがいいと思います。私が行ってきましょうか？`]);
          c.pending = { type: 'task', task, t: S.t };
        } else res.say = Dlg.lineN(c, [`${tn}を？ うーん、はっきりした証拠がないとね……。`, `${tn}さんを？ はっきりした証拠がないと……。`]);
        break;
      }
      const ok = taskWilling(c, type, target, known);
      if (ok === 'friend') { res.say = Dlg.lineN(c, [`${tn}を売るようなことはできないよ。`, `${tn}さんにそんなことはできません。`]); res.like = -2; break; }
      if (ok === 'violence') { res.say = Dlg.lineN(c, ['暴力はごめんだよ。', '暴力はいけません。']); break; }
      if (!ok) { res.say = Dlg.lineN(c, ['うーん……あんたのためにそこまでする義理はないかな。', 'ごめんなさい、それはお引き受けできません。']); break; }
      res.task = task;
      res.say = taskAcceptLine(c, task);
      break;
    }
    case 'appoint': {
      const h = it.hour;
      const pn = Dlg.placeName(it.place);
      if (h >= 22 || h < 6) { res.say = ln('sleepy'); break; }
      if (like < 0 && (c.favor || 0) < 1) { res.say = ln('invite_cold'); break; }
      let at = Math.floor(S.t / 1440) * 1440 + h * 60;
      if (at < S.t + 20) at += 1440;
      const tomorrow = at >= (Math.floor(S.t / 1440) + 1) * 1440;
      res.appointment = { place: it.place, at };
      res.say = Dlg.lineN(c, [`いいよ、${tomorrow ? '明日の' : ''}${h}時に${pn}ね。待ってる！`, `わかりました。${tomorrow ? '明日の' : ''}${h}時に${pn}で。お待ちしています。`]);
      res.like = gainLike(c, 2);
      break;
    }
    case 'waitThere': {
      // 時間を決めない待ち合わせ：その場所で2時間ほど待つ（来てくれたら一緒に過ごす）
      if (hour() >= 21 || hour() < 6) { res.say = ln('sleepy'); break; }
      if (like < -10 && (c.favor || 0) < 1) { res.say = Dlg.lineN(c, ['なんで{I}があんたを待たなきゃいけないの。', 'すみません、お待ちするのはちょっと……。']); break; }
      const place = it.place || 'here';
      const pn = place === 'here' ? 'ここ' : Dlg.placeName(place);
      res.appointment = { place, at: S.t + 40, loose: true };
      res.say = Dlg.lineN(c, [`わかった、${pn}で待ってるね。あんまり遅くならないでよ。`, `わかりました。${pn}でお待ちしていますね。`]);
      res.like = gainLike(c, 1);
      break;
    }
    case 'hairAsk': {
      const t = it.target;
      let color = Wolf.hairName(t);
      // 人狼は自分の髪の色をごまかす
      if (t === c && c.isWolf && S.wolfKnown) color = pick(['茶', '黒', '明るい茶', 'こげ茶'].filter((x) => x !== color));
      if (t === c) res.say = Dlg.lineN(c, [`{I}の髪？ ${color}色だけど……なんで？`, `私の髪ですか？ ${color}色ですが……どうしてです？`]);
      else res.say = Dlg.lineN(c, [`${t.name}の髪？ たしか${color}色だよ。`, `${t.name}さんの髪は、たしか${color}色ですよ。`]);
      res.note = `${c.name}によると、${t === c ? c.name + '自身' : t.name}の髪は${color}色`;
      break;
    }
    case 'askItem': case 'offer': {
      const item = it.kind === 'offer' ? pend?.item : it.item;
      if (!item) { res.say = Dlg.lineN(c, ['え、何の値段の話？', 'ええと、何のお値段のお話でしょう？']); break; }
      const name = ITEMS[item].name;
      if (!c.items.includes(item)) {
        if (c.job === 'merchant' && ITEMS[item]?.gift) return respond(c, { ...it, kind: 'buyItem', item }, raw);
        const holder = S.chars.find((x) => x.alive && x.items.includes(item));
        res.say = item === 'meteor' && holder && !holder.isPlayer ? Dlg.lineN(c, [`光る石？ {I}は持ってないよ。${holder.name}が持ってるって話だけど。`, `光る石は持っていません。${holder.name}さんが持っているそうですよ。`])
          : Dlg.lineN(c, [`${name}？ そんなもの持ってないよ。`, `${name}は持っていません。`]);
        break;
      }
      // 盗んだ物を「返して」と言われたら
      if (it.ret && c.loot?.item === item) {
        const r0 = rel(c, 'player');
        if (r0.fear >= 40 || c.p.honesty > 0.6) {
          res.say = Dlg.lineN(c, ['……わかったよ、返す。悪かった。', '……お返しします。申し訳ありませんでした。']);
          res.trade = { item, price: 0 }; res.like = 2; break;
        }
        res.say = Dlg.lineN(c, ['返す？ なんのことだか。……まあ、金を払うなら譲ってやってもいいがな。', '何のことでしょう。……お代をいただけるなら、お譲りしますが。']);
      }
      if (like <= -40) { res.say = Dlg.lineN(c, ['あんたに売る物なんかない。', 'あなたにお売りする物はありません。']); break; }
      const { ask, min } = tradeTerms(c, item);
      const offer = it.kind === 'offer' ? it.coins : it.price;
      const askPrice = it.kind === 'offer' ? pend.price : ask;
      const minPrice = it.kind === 'offer' ? pend.min : min;
      const prefix = res.say;
      if (offer == null) {
        res.say = prefix + Dlg.lineN(c, [`${name}か……${askPrice}Gでどうだ？`, `${name}ですか……${askPrice}Gでいかがでしょう？`]);
        c.pending = { type: 'trade', item, price: askPrice, min: minPrice, t: S.t };
      } else if (offer >= minPrice) {
        if (S.player.coins < offer) { res.say = Dlg.lineN(c, [`${offer}Gで手を打ってもいいが……金が足りないみたいだな。`, `${offer}Gでもかまいませんが……お金が足りないようですね。`]); c.pending = { type: 'trade', item, price: offer, min: minPrice, t: S.t }; break; }
        res.trade = { item, price: offer };
        res.say = Dlg.lineN(c, [`……${offer}Gか。いいだろう、持っていけ。`, `……${offer}Gですね。わかりました、お譲りします。`]);
      } else if (offer < minPrice * 0.5) {
        res.say = Dlg.lineN(c, [`${offer}G？ 話にならないね。${askPrice}Gなら考えてやる。`, `${offer}Gでは無理です。${askPrice}Gでしたら。`]);
        c.pending = { type: 'trade', item, price: askPrice, min: minPrice, t: S.t };
      } else {
        const counter = Math.max(minPrice, Math.round((offer + askPrice) / 2));
        res.say = Dlg.lineN(c, [`うーん……${counter}Gなら譲ってもいい。`, `そうですね……${counter}Gでしたらお譲りします。`]);
        c.pending = { type: 'trade', item, price: counter, min: minPrice, t: S.t };
      }
      break;
    }
    case 'returnMoney': {
      if (!c.loot?.coins) { res.say = Dlg.lineN(c, ['え？ 借りた覚えはないけど。', 'お金をお借りした覚えはありませんが……。']); break; }
      const r0 = rel(c, 'player');
      if (r0.fear >= 40 || c.p.honesty > 0.6) { res.say = Dlg.lineN(c, ['……わかったよ。ほら、返す。', '……申し訳ありません。お返しします。']); res.returnCoins = Math.min(c.loot.coins, Math.floor(c.coins)); }
      else res.say = Dlg.lineN(c, ['何の話だ？ 証拠でもあるのか。', '何のお話でしょう？']);
      break;
    }
    case 'releaseReq': {
      const t = it.target;
      if (!(t.jailedUntil > S.t)) { res.say = Dlg.lineN(c, [`${t.name}なら牢屋には入ってないよ。`, `${t.name}さんは牢屋には入っていませんよ。`]); break; }
      if (!['guard', 'mayor'].includes(c.job)) { res.say = Dlg.lineN(c, ['{I}にそんな権限はないよ。衛兵か村長に頼んでみたら？', '私には何もできません。衛兵か村長に頼んでみてください。']); break; }
      if (!t.jailedAsWolf) { res.say = Dlg.lineN(c, ['保釈金を払えば出してやれるぞ。牢屋の前で払ってくれ。', '保釈金を払えば出られます。牢屋の前でお支払いください。']); break; }
      const v = Wolf.sus(c, t.id);
      if (!c.isWolf && v < 35 + (like < 0 ? 15 : 0)) {
        res.say = Dlg.lineN(c, [`……確かに、${t.name}が人狼だという決め手はない。わかった、釈放しよう。`, `……そうですね、決め手はありません。${t.name}さんを釈放しましょう。`]);
        res.release = t.id;
      } else res.say = Dlg.lineN(c, [`まだ疑いは晴れていない。${t.name}を出すわけにはいかないな。`, `まだ疑いが晴れていません。お出しするわけにはいきません。`]);
      break;
    }
    case 'rescue': {
      if (!(c.jailedUntil > S.t)) { res.say = Dlg.lineN(c, ['助ける？ 何から？', '助ける……ですか？ 何からでしょう？']); break; }
      if (like < -30) { res.say = Dlg.lineN(c, ['あんたの助けなんかいらない。', 'あなたの助けは結構です。']); break; }
      const coins = Math.min(Math.floor(c.coins), 12);
      let info;
      if (c.isWolf) { const f = S.chars.find((x) => x.id === S.wolf.frame); info = f ? `${f.name}が夜中に出歩いているのを見たことがある` : '何も知らない'; }
      else {
        const night = Wolf.nightTestimony(c);
        const top = Wolf.suspectLine(c);
        const known = culpritFromMemory(c);
        info = night ? night.text : top ? `${top.t.isPlayer ? 'あんた' : top.t.name}が怪しいと思っている。${top.why}から` : known ? known.text : pick([
          'バンは4Gも渡せば、手配されていても見逃してくれる',
          '市場の奥の棚は見張りが手薄で、品物をくすねやすい',
          `役場の金庫には${Math.floor(S.treasury)}Gも貯まっている`,
          'ツヅミは裏で帳簿をごまかしているらしい',
        ]);
      }
      res.say = Dlg.lineN(c, [`本当か！？ ここから出してくれたら、${coins ? coins + 'Gやる。それに' : 'お金はないけど'}……誰にも言ってないことを教えるよ。`,
        `本当ですか！？ 出していただけたら、${coins ? coins + 'Gお支払いします。それと' : 'お金はありませんが'}……誰にも話していないことをお教えします。`]);
      c.pending = { type: 'deal', deal: { coins, info }, t: S.t };
      res.note = `${c.name}（牢屋）：出してくれたら${coins}Gと秘密の情報を渡すと言っている`;
      break;
    }
    case 'rule': {
      const rule = Town.parseRule(raw);
      if (!rule) { res.say = Dlg.lineN(c, ['それならもう決まってるよ。', 'それはもう決まっていますよ。']); break; }
      const d = Town.describe(rule);
      if (c.job === 'mayor') {
        res.say = Dlg.lineN(c, [`「${d}」か……わかった、次の話し合いでみんなに諮ろう。`, `「${d}」ですか……わかりました。次の話し合いで皆さんに諮りましょう。`]);
        res.rule = rule;
      } else {
        const sp = Town.support(c, rule, 'player');
        res.say = Dlg.lineN(c, [`「${d}」？ ${sp >= 0.5 ? '{I}は賛成だな。' : '{I}は反対だな。'}決まりを変えたいなら、村長のゲンジさんに話すか、広場の話し合いで提案してみたら？`,
          `「${d}」ですか。${sp >= 0.5 ? '私は賛成です。' : '私は反対です。'}決まりを変えるなら、村長のゲンジさんに相談するか、話し合いで提案してみてください。`]);
      }
      break;
    }
    case 'wolfWho': {
      if (!S.wolfKnown) { res.say = Dlg.lineN(c, ['人狼？ そんなのおとぎ話でしょ。', '人狼、ですか？ おとぎ話のようなものですよ。']); break; }
      const top = Wolf.suspectLine(c);
      if (top) {
        res.say = Dlg.lineN(c, [`{I}は${top.name}が怪しいと思う。${top.why}から。`, `私は${top.name}が怪しいと思います。${top.why}からです。`]);
        res.note = `${c.name}は${top.t.isPlayer ? 'あなた' : top.t.name}を疑っている（${top.why}）`;
      } else res.say = Dlg.lineN(c, ['正直、まだわからない。でも、この町の誰かなんだよね……怖いよ。', 'まだわかりません。でも、この町の誰かだなんて……。']);
      break;
    }
    case 'susAbout': {
      const t = it.target;
      if (t === c) { res.say = Dlg.lineN(c, ['え、{I}のこと疑ってるの……？', 'まさか、私を疑っているんですか……？']); res.like = -3; break; }
      const v = Wolf.sus(c, t.id);
      const why = c.sus?.[t.id]?.why;
      if (c.isWolf && t.id === S.wolf.frame) res.say = Dlg.lineN(c, [`${t.name}？ 正直、怪しいと思ってる。夜中に出歩いてるのを見た気がするんだ。`, `${t.name}さんは……少し怪しいと思っています。`]);
      else if (v >= 40) { res.say = Dlg.lineN(c, [`${t.name}？ 正直、怪しいと思ってる。${why}から。`, `${t.name}さんは怪しいと思います。${why}からです。`]); res.note = `${c.name}は${t.name}を疑っている（${why}）`; }
      else if (v >= 15) res.say = Dlg.lineN(c, [`${t.name}か……少し気になってはいる。`, `${t.name}さんは……少し気になっています。`]);
      else res.say = Dlg.lineN(c, [`${t.name}は違うと思うよ。`, `${t.name}さんではないと思います。`]);
      break;
    }
    case 'accuse': {
      const t = it.target;
      const tr = Wolf.trust(c, 'player');
      if (t === c) {
        if (c.isWolf) {
          const f = S.wolf.frame && S.chars.find((x) => x.id === S.wolf.frame);
          res.say = Dlg.lineN(c, [`{I}が？ まさか。それより${f ? f.name : '他の誰か'}を疑ったほうがいいよ。`, `私が？ まさか。${f ? f.name + 'さん' : '他の方'}の方が怪しいと思いますよ。`]);
          S.wolf.playerThreat += 15; res.like = -4;
        } else { res.say = Dlg.lineN(c, ['{I}が人狼だって！？ ふざけないでよ！', '私が人狼だなんて……ひどいです。']); res.like = -10; }
        res.accused = c.id;
        break;
      }
      if (!S.wolfKnown && !it.evidence) { res.say = Dlg.lineN(c, ['人狼？ 何の話？', '人狼……ですか？ 何のお話でしょう。']); break; }
      res.accused = t.id;
      if (t.isWolf) S.wolf.playerThreat += it.evidence ? 20 : 10;
      if (c.isWolf) { res.say = Dlg.lineN(c, [`やっぱり！ {I}も${t.name}が怪しいと思ってたんだ。`, `やはり……私も${t.name}さんが怪しいと思っていました。`]); break; }
      const ev = Wolf.playerEvidence(t);
      Wolf.addSus(c, t.id, (ev.score >= 2 ? 45 : ev.score ? 32 : it.evidence ? 26 : 16) * (ev.score >= 2 ? Math.max(tr, 0.9) : tr),
        ev.score ? `よそ者が証拠を見せた（${ev.why[0]}）` : it.evidence ? 'よそ者がはっきり見たと言っていた' : 'よそ者が怪しいと言っていた');
      const v = Wolf.sus(c, t.id);
      if (ev.score >= 2) { res.say = Dlg.lineN(c, [`……${ev.why[0]}だって？ それは……${t.name}で決まりかもしれない。`, `……${ev.why[0]}ですか。それは見過ごせません。`]); break; }
      if (rel(c, t).like >= 50 && v < 50) res.say = Dlg.lineN(c, [`${t.name}がそんなことするわけない！`, `${t.name}さんに限って、そんなことはありません。`]);
      else if (v >= 45) res.say = Dlg.lineN(c, [`……やっぱり、${t.name}なのかな。{I}も気をつけておく。`, `……${t.name}さん、なのでしょうか。気をつけておきます。`]);
      else res.say = Dlg.lineN(c, [`${t.name}が？ うーん、それだけじゃ信じられないな。`, `${t.name}さんが？ それだけでは何とも……。`]);
      break;
    }
    case 'defend': {
      const t = it.target;
      Wolf.addSus(c, t.id, -15 * Wolf.trust(c, 'player'));
      res.say = Wolf.sus(c, t.id) < 30 ? Dlg.lineN(c, [`そうだね、${t.name}は違う気がする。`, `そうですね、${t.name}さんは違うと思います。`])
        : Dlg.lineN(c, [`そうかな……{I}はまだ${t.name}を疑ってるけど。`, `そうでしょうか……私はまだ少し疑っています。`]);
      break;
    }
    case 'alibi': {
      const t = it.target && it.target !== c ? it.target : null;
      if (t) {
        const heard = (c.recent || []).find((e) => e.kind === 'night' && e.text.includes(t.name) && S.t - e.t < 30 * 60);
        if (heard) { res.say = Dlg.lineN(c, [`……実は、${heard.text}んだ。`, `……実は、${heard.text}んです。`]); res.note = `${c.name}の証言：${heard.text}`; }
        else if (t.home === c.home) res.say = Dlg.lineN(c, [`${t.name}なら、同じ家で寝てたと思うけど……夜中のことまではわからないな。`, `${t.name}さんは同じ家で寝ていたと思います。夜中のことまではわかりませんが。`]);
        else res.say = Dlg.lineN(c, [`${t.name}の夜のことなんて知らないよ。同じ家の人に聞いてみたら？`, `${t.name}さんのことはわかりません。同じ家の方に聞いてみては？`]);
        break;
      }
      if (c.isWolf) { res.say = Dlg.lineN(c, ['昨日の夜？ ずっと家で寝てたよ。', '昨晩ですか？ ずっと家で寝ていましたよ。']); break; }
      const night = Wolf.nightTestimony(c);
      const base = c.patrolNight === day() - 1 ? ['見回りをしてたよ。', '見回りをしていました。'] : ['家で寝てたよ。', '家で寝ていました。'];
      if (night) { res.say = Dlg.lineN(c, [`${base[0]}……そういえば、${night.text}んだ。`, `${base[1]}……そういえば、${night.text}んです。`]); res.note = `${c.name}の証言：${night.text}`; }
      else res.say = Dlg.lineN(c, [`${base[0]}特に変わったことはなかったと思う。`, `${base[1]}特に変わったことはありませんでした。`]);
      break;
    }
    case 'meeting': {
      // 誰かの悪いことについて：自分で見ていたり、町で知られていたりすれば、好感度が低くても乗ってくれる
      const t = it.target && it.target !== c ? it.target : null;
      if (t && t.alive) {
        const tn = Dlg.toneOf(c).pol ? `${t.name}さん` : t.name;
        const saw = Wolf.crimesOf(c, t).length > 0;
        const known = Wolf.knownCrimes(t).length > 0;
        const close = rel(c, t).like >= 40;
        if (Wolf.meetingActive()) {
          res.say = Dlg.lineN(c, [`${Math.floor((S.meeting.at % 1440) / 60)}時の話し合いで、${tn}のことも話そう。`, `${Math.floor((S.meeting.at % 1440) / 60)}時の話し合いで、${tn}のことも話しましょう。`]);
          res.trial = t.id; break;
        }
        if (close && !saw) { res.say = Dlg.lineN(c, [`${tn}を吊るし上げるようなことはしたくないな。`, `${tn}を皆で責めるようなことは、したくありません。`]); break; }
        if (saw || (known && like >= -10) || like >= 20) {
          res.say = Dlg.lineN(c, [`${saw ? '{I}も見たしね。' : ''}わかった、${tn}のことをみんなで決めよう。1時間後に広場の噴水の前に声をかけておくよ。`,
            `${saw ? '私も見ましたし……。' : ''}わかりました。${tn}のこと、みんなで決めましょう。1時間後に広場の噴水の前に集まるよう、声をかけておきます。`]);
          res.trial = t.id; res.like = gainLike(c, 1);
          break;
        }
        res.say = Dlg.lineN(c, [`${tn}が何かしたの？ よく知らないことで集まるのはちょっとね。`, `${tn}が何か……？ よく知らないことで集まるのは、ちょっと。`]);
        break;
      }
      if (Wolf.meetingActive()) {
        const at = S.meeting.at;
        res.say = Dlg.lineN(c, [`もう${Math.floor((at % 1440) / 60)}時に広場で話し合うことになってるよ。`, `${Math.floor((at % 1440) / 60)}時に広場で話し合うことになっていますよ。`]);
        break;
      }
      if (S.wolfKnown || like >= 20) { res.say = Dlg.lineN(c, ['わかった、みんなに声をかけるよ。1時間後に広場の噴水の前ね。', 'わかりました。みんなに声をかけます。1時間後に広場の噴水の前で。']); res.meeting = true; }
      else { res.say = Dlg.lineN(c, ['話し合い？ 何について？ 誰かが何かしたの？', '話し合い……ですか？ 何について、誰のことでしょう。']); c.pending = { type: 'meetingWhy', t: S.t }; }
      break;
    }
    case 'whatHappened': {
      const e = tellEvent(c);
      if (e) { res.say = ln(e.key, e.vars); if (e.key === 'whVictimPlayer') res.like = -2; }
      else if (S.wolfKnown && S.wolf.kills.length) {
        const v = S.chars.find((x) => x.id === S.wolf.kills[S.wolf.kills.length - 1].id);
        res.say = Dlg.lineN(c, [`知らないの？ ${v.name}が人狼に殺されたんだよ……。`, `ご存じないんですか？ ${v.name}さんが人狼に襲われたんです……。`]);
      } else res.say = ln('whNothing');
      break;
    }
    case 'buyFood': {
      const price = c.job === 'merchant' ? 3 : 2;
      if (c.food < 1) { res.say = ln('sellNoFood'); break; }
      if (like < -15) { res.say = ln('refuse'); break; }
      if (S.player.coins < price) { res.say = ln('sellNoMoney', { price }); break; }
      res.say = ln('sellOk', { price }); res.sell = { item: 'food', price };
      break;
    }
    case 'buyItem': {
      const item = ITEMS[it.item];
      if (c.job !== 'merchant' || !item?.gift) { res.say = ln('sellItemNo', { item: item?.name || 'それ' }); break; }
      const price = item.price + 1;
      if (S.player.coins < price) { res.say = ln('sellNoMoney', { price }); break; }
      res.say = ln('sellItemOk', { item: item.name, price }); res.sell = { item: it.item, price };
      break;
    }
    case 'hireMe': {
      const p = S.player;
      const job = JOBS[c.job];
      if (p.job === c.job) { res.say = ln('hireAlready', { job: job.name }); break; }
      if (!job?.place || c.job === 'mayor') { res.say = ln('hireNo'); break; }
      if (like < -10) { res.say = ln('hireCold'); break; }
      res.say = ln('hireOk', { job: job.name, place: Dlg.placeName(job.place) }); res.hire = true;
      break;
    }
    case 'invite': doInvite(it.place, it.treat); break;
    case 'secret':
      if (c.job === 'guard' && c.p.greed > 0.6) res.say = ln('secretBribe');
      else res.say = c.p.honesty > 0.7 ? ln('secretNo') : ln('secretMaybe');
      break;
    case 'askMoney': case 'askFood': {
      const kind = c.p.sociability * (1 - c.p.greed);
      const ok = like >= 45 || (like >= 15 && chance(kind + 0.2)) || r.fear >= 50;
      if (it.kind === 'askFood') {
        if (ok && c.food > 0) { res.action = 'give_food'; res.say = r.fear >= 50 ? ln('giveFear') : ln('giveFood'); }
        else if (ok) res.say = ln('noFood');
        else { res.say = ln('refuse'); res.like = -2; }
      } else if (ok && c.coins >= 2) {
        res.action = 'give_coin'; res.amount = like >= 60 ? 2 : 1;
        res.say = r.fear >= 50 ? ln('giveFear') : ln('giveMoney', { n: res.amount });
      } else { res.say = ln('refuse'); res.like = -2; }
      break;
    }
    case 'whereIs': {
      const t = it.target;
      if (!t.alive) res.say = ln('whereDead', { target: t.name });
      else if (t.jailedUntil > S.t) res.say = ln('whereJail', { target: t.name });
      else res.say = ln('whereIs', { target: t.name, loc: locName(t) });
      break;
    }
    case 'gossip': {
      const o = it.target;
      const cred = clamp((like + 40) / 100, 0.1, 1) * (1 - c.p.honesty * 0.3);
      const myView = rel(c, o).like;
      if (it.neg && myView > 50) { res.say = ln('gossipDeny', { target: o.name }); res.like = -4; break; }
      if (it.neg && cred < 0.3) { res.say = ln('gossipNegDoubt'); res.belief = { target: o.name, like: -2 }; break; }
      res.belief = { target: o.name, like: Math.round((it.neg ? -12 : 10) * cred) };
      res.say = it.neg ? ln('gossipNeg', { target: o.name }) : ln('gossipPos', { target: o.name });
      break;
    }
    case 'opinion': {
      if (it.self && !it.target) { res.say = ln('opinionSelf'); break; }
      const t = it.target;
      const v = rel(c, t).like;
      const idx = v >= 50 ? 0 : v >= 15 ? 1 : v > -15 ? 2 : v > -45 ? 3 : 4;
      res.say = ln('opinion', { sub: idx, target: t.name });
      const m = memoryAbout(c, t);
      if (m && idx >= 2) res.say += `${m}${Dlg.toneOf(c).pol ? 'んです。' : 'からね。'}`;
      if (!t.alive) res.say = ln('whereDead', { target: t.name });
      break;
    }
    case 'opinionMe': {
      const idx = like >= 50 ? 0 : like >= 15 ? 1 : like > -15 ? 2 : like > -45 ? 3 : 4;
      res.say = ln('opinionMe', { sub: idx });
      break;
    }
    case 'whereIsPlace': {
      const pn = Dlg.placeName(it.place);
      const here = locName(c) === pn;
      if (here) { res.say = ln('guideAlready', { place: pn }); break; }
      const canGuide = like >= 5 && !(c.activity === 'work' && S.t < c.busyUntil) && hour() < 21;
      res.say = ln(canGuide ? 'wherePlaceGuide' : 'wherePlace', { place: pn, dir: Dlg.PLACE_DIR[it.place] || 'あっちのほう' });
      if (canGuide) c.pending = { type: 'guide', place: it.place, t: S.t };
      break;
    }
    case 'meteor': {
      const m = S.meteor;
      res.say = !m ? ln('meteorNone') : m.state === 'ground' ? ln('meteorGround') : m.state === 'done' ? ln('meteorDone', { item: ITEMS[m.result].name }) : ln('meteorHeld', { holder: holderName() });
      if (!m) res.mode = 'free';
      break;
    }
    case 'job': {
      const p = S.player;
      const myPlace = JOBS[c.job]?.place;
      if (p.job !== 'none') res.say = ln('jobHave', { job: JOBS[p.job].name });
      else if (myPlace && like >= 0) res.say = ln('jobMine', { place: Dlg.placeName(myPlace) });
      else res.say = ln('job', { place: pick(['畑', '食堂', '工房', '市場']) });
      break;
    }
    case 'doing': {
      const act = actText(c), next = nextText(c);
      res.say = ln(act === 'ぶらぶらしている' ? 'doing' : 'doingNext', { act, next });
      break;
    }
    case 'howareyou': {
      const h = hour();
      const st = c.hunger < 35 ? 'hungry' : c.hp < 50 ? 'hurt' : c.coins < 2 ? 'broke' : (h >= 22 || h < 6) ? 'tired' : (c.hp > 80 && c.hunger > 60 && chance(0.5)) ? 'good' : 'normal';
      res.say = ln(st);
      break;
    }
    case 'likes': res.say = ln('likes', { likes: c.likes || 'のんびりすること' }); break;
    case 'rumor': {
      const mem = c.memory.filter((m) => !m.includes('よそ者') && /(見た|された|盗まれた|殴られた|脅された|亡くな|捕ま|拾った)/.test(m));
      if (mem.length) res.say = ln('rumor', { memory: pick(mem).replace(/^\d+日目 /, '') });
      else if (S.foodStock < 15) res.say = ln('rumorFood');
      else res.say = ln('rumorNone');
      break;
    }
    case 'town': res.say = ln('town'); break;
    case 'weather': {
      const h = hour();
      res.say = S.droughtUntilDay >= day() ? ln('weatherDry') : (h >= 19 || h < 5) ? ln('weatherNight') : ln('weatherGood');
      break;
    }
    case 'help': {
      const enemy = Object.entries(c.rel).filter(([id, v]) => id !== 'player' && v.like < -40).map(([id]) => S.chars.find((x) => x.id === id)).find((x) => x?.alive);
      const need = c.hunger < 40 ? (Dlg.toneOf(c).pol ? 'お腹が空いていて' : '腹ペコでさ') : c.coins < 2 ? (Dlg.toneOf(c).pol ? 'お金に困っていて' : '金に困ってて')
        : c.hp < 50 ? (Dlg.toneOf(c).pol ? 'けがをしていて' : 'けがしちゃってて') : enemy ? `${enemy.name}とうまくいってなくて` : null;
      res.say = need ? ln('helpNeed', { need }) : ln('helpNone');
      res.like = gainLike(c, 2);
      break;
    }
    case 'compliment': res.say = ln('compliment'); res.like = gainLike(c, 3); break;
    case 'question': res.say = ln('confused'); res.mode = 'free'; break;
    default: res.say = ln('ack'); res.mode = 'free';
  }
  return res;
}

// 決まったセリフを、その住民らしい言い回しに整える（高性能AIのときだけ）
export async function rephrase(c, text, situation = '（よそ者に、あなたから話しかける）') {
  if (!LLM.strong() || !LLM.idle()) return null;
  return llmPhrase(c, situation, [], { mode: 'phrase', say: text, kind: 'polish' });
}

// ---- AIに口調をつけてもらう ----
const BAD = /(AI|ＡＩ|アシスタント|プレイヤー|ロールプレイ|JSON|キャラクター|ゲーム|システム|申し訳ありませんが)/;

function cleanSay(text) {
  if (!text) return null;
  let s = text.trim().replace(/^[「『"']|[」』"']$/g, '');
  s = s.split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';
  s = s.replace(/^[^「」\s]{1,8}[:：]\s*/, '').replace(/^[「『"]|[」』"]$/g, '').trim();
  if (s.length < 2 || s.length > 110) return null;
  if (!/[ぁ-んァ-ヶ一-龠]/.test(s)) return null;
  if (/[A-Za-z]{6,}/.test(s) || BAD.test(s) || /[{}<>]/.test(s)) return null;
  // 中国語が混ざった・崩れた文（小さいモデルにありがち）は使わない
  if (/[这们吗呢么说话为对还进过时给让认识觉现们样么]|，|。。|！！！/.test(s)) return null;
  if ((s.match(/[ぁ-ん]/g) || []).length < s.length * 0.15) return null;
  return s;
}

async function llmPhrase(c, text, history, res) {
  const r = rel(c, 'player');
  let task;
  if (res.mode === 'free') {
    task = '相手の言葉に、あなたらしく自然に返事してください。知らないことは知らないと言い、話をそらさないこと。' +
      'この町に町長・役場・警察はない（あるのは衛兵の詰所）。相手に何か頼まれても「やっておく」などの約束はしないこと。';
  } else {
    task = `あなたの返事の内容はすでに決まっています:「${res.say}」\n` +
      'この内容（事実・誘いを受けるか断るか・数字・人や場所の名前）は絶対に変えずに、あなたの口調で自然な話し言葉に言い直してください。相手の言葉に少し反応してもよい。';
  }
  const sys = selfDesc(c) + '\n' +
    `話し相手: 最近町に来たよそ者。あなたはこの人を${feeling(r)}。\n` +
    'ルール: 日本語の話し言葉で、短く1〜2文。セリフだけを書く（名前・かぎかっこ・説明は付けない）。AIやゲームの話はしない。\n' + task;
  const msgs = [{ role: 'system', content: sys }];
  for (const h of history.slice(-6)) msgs.push({ role: h.who === 'player' ? 'user' : 'assistant', content: h.text });
  msgs.push({ role: 'user', content: text });
  const out = cleanSay(await LLM.complete(msgs, { maxTokens: 90, temperature: res.mode === 'free' ? 0.8 : 0.6 }));
  if (!out) return null;
  // 判断と逆のことを言っていたら採用しない
  if (res.follow && /(無理|やめとく|遠慮|行けない|行かない|断る|パス)/.test(out)) return null;
  if (/(町長|村長|役場|警察|市長)/.test(out)) return null;
  if (res.mode === 'free' && /(報告しよう|連絡しよう|連絡する|伝えておく|伝えてくる|行ってくる|やっておく|任せて|引き受け)/.test(out)) return null;
  if (res.task && /(無理|できない|お断り|ごめん)/.test(out)) return null;
  if (res.kind === 'invite' && !res.follow && /(行こう|喜んで|いいよ|行きましょう|ついてく)/.test(out)) return null;
  return out;
}

// ================= 住民同士の会話 =================
// [話しかける側, 返す側の候補]
const TALKS = {
  hungry: [['腹減ったなあ……', '腹減ったね……'], ['食堂行こうぜ。', 'わかる、何か食べたいね。', '俺もだ。']],
  work: [['仕事どう？', '最近忙しい？'], ['ぼちぼちだよ。', 'まあなんとかね。', 'くたくただよ。']],
  morning: [['おはよう。', '今日もいい天気だね。'], ['おはよう！', 'ほんとだね。', '今日もがんばろう。']],
  evening: [['今日もおつかれ。', 'そろそろ一杯どう？'], ['おつかれさま！', 'いいね、酒場行こう。', 'また明日ね。']],
  food: [['食料の蓄え、減ってるらしいよ。', '食堂の食料、大丈夫かな。'], ['まずいな……', '畑をがんばらないとね。', '心配だね。']],
  drought: [['この日照り、いつまで続くんだろ。'], ['畑が心配だよ。', '雨が降ればいいのに。']],
  meteor: [['あの光る石、なんだと思う？', '光る石の話、聞いた？'], ['宝石だったりして。', '気味が悪いよ。', '研究所で調べるんだって。']],
  stranger: [['あのよそ者、どう思う？', 'よそ者、見かけた？'], null],
  friend: [['{b}、今日も元気？', '{b}、また今度ご飯行こうよ。'], ['おかげさまでね！', 'いいね、行こう！']],
  enemy: [['……ちっ。', 'なんだよ。'], ['……ふん。', 'こっち見んな。']],
};

export function npcDialogue(a, b, rumor) {
  if (rumor) return [pick([`${rumor}って知ってる？`, `聞いた？ ${rumor}らしいよ。`]), pick(['マジかよ……', 'へえ、知らなかった。', '気をつけないとね。'])];
  const like = rel(a, b).like;
  const h = hour();
  const topics = [];
  if (like < -30) topics.push('enemy', 'enemy');
  else {
    if (like > 40) topics.push('friend');
    if (a.hunger < 45) topics.push('hungry', 'hungry');
    if (h < 10) topics.push('morning');
    if (h >= 17) topics.push('evening');
    if (S.foodStock < 15) topics.push('food');
    if (S.droughtUntilDay >= day()) topics.push('drought');
    if (S.meteor && S.meteor.state !== 'done') topics.push('meteor');
    if (chance(0.3)) topics.push('stranger');
    topics.push('work');
  }
  const k = pick(topics);
  const [open, resp] = TALKS[k];
  const lineA = pick(open).replace('{b}', b.name);
  let lineB;
  if (k === 'stranger') {
    const v = rel(b, 'player').like;
    lineB = v >= 30 ? 'いい人だよ。' : v <= -20 ? '信用できないね。' : 'まだよく分からないな。';
  } else lineB = pick(resp);
  return [lineA, lineB];
}

// プレイヤーに声をかけるとき
export function greetPlayer(c) {
  const r = rel(c, 'player');
  if (r.like >= 30) return Dlg.line(c, 'greet_hi', {}, rnd);
  return Dlg.line(c, 'greet', {}, rnd);
}

// 住民の方から話しかけるときの話題
export function approachTopic(c) {
  const like = rel(c, 'player').like;
  const L = (a, b) => Dlg.lineN(c, [a, b]);
  const opts = [];
  const add = (w, f) => { if (w > 0) opts.push([w, f]); };
  if (c.taskDone) { const line = takeTaskReport(c); return { line, note: `${c.name}の報告：${line}` }; }
  const m = S.meeting;
  if (m && m.state === 'planned' && like >= -10) {
    const hh = Math.floor((m.at % 1440) / 60);
    add(3, () => ({ line: L(`ねえ、${hh}時から広場で話し合いがあるの。あなたも来てくれない？`, `${hh}時から広場で話し合いがあります。あなたもいらしてください。`), pending: { type: 'meeting' } }));
  }
  const top = Wolf.suspectLine(c);
  if (S.wolfKnown && top && like >= -10 && !top.t.isPlayer) add(2, () => ({ line: L(`ねえ……${top.name}のこと、どう思う？ ${top.why}らしいんだ。`, `あの……${top.name}のこと、どう思われますか？ ${top.why}そうなんです。`), note: `${c.name}は${top.t.name}を疑っている（${top.why}）` }));
  if (S.wolfKnown && top && top.t.isPlayer && like < 10) add(2.5, () => ({ line: L('……あんた、まさか人狼じゃないよね？ 昨日の夜はどこにいたの？', '……失礼ですが、昨日の夜はどちらにいらっしゃいましたか？') }));
  const night = Wolf.nightTestimony(c);
  if (night && like >= 0) add(2.5, () => ({ line: L(`ちょっと聞いて。${night.text}んだ……。誰にも言えなくて。`, `少しよろしいですか。${night.text}んです……。`), note: `${c.name}の証言：${night.text}` }));
  if (c.hunger < 35 && like >= -10) add(2, () => ({ line: Dlg.line(c, 'askFoodPlayer', {}, rnd).replace(/^……ところで、/, ''), pending: { type: 'wantFood' } }));
  if (!c.quest && like >= 10 && chance(0.6)) {
    const item = c.likesItem && chance(0.6) ? c.likesItem : 'food';
    const label = item === 'food' ? '食べ物' : ITEMS[item].name;
    const reward = item === 'food' ? 4 : ITEMS[item].price + 3;
    add(1.2, () => { c.quest = { item, reward, until: S.t + 1440, label }; return { line: L(`ちょっとお願いがあるんだけど……${label}を持ってきてくれない？ お礼に${reward}G払うから。`, `お願いがあるのですが……${label}を持ってきていただけませんか？ お礼に${reward}Gお支払いします。`), pending: { type: 'quest', label } }; });
  }
  if (c.lastGift && S.t - c.lastGift.t < 6 * 60) add(1, () => ({ line: Dlg.line(c, 'thanksGift', { gift: c.lastGift.label }, rnd) }));
  const ev = recentEvents(c, 3, ['crime'])[0];
  if (ev && !ev.text.includes('よそ者')) add(1.5, () => ({ line: Dlg.line(c, 'news', { event: 'さっき' + ev.text }, rnd) }));
  if (like <= -35 && c.p.aggression > 0.4) add(1.5, () => ({ line: L('おい、よそ者。この町で何を企んでるんだ？', '……あなた、この町で何をなさるおつもりですか？') }));
  if (S.wolfKnown && hour() >= 17) add(1, () => ({ line: L('暗くなったら外を出歩かないほうがいいよ。人狼がいるんだから……。', '暗くなったら出歩かないでくださいね。人狼がいるんですから……。') }));
  const h = hour();
  if (like >= 25 && c.coins >= MEAL_COST && ((h >= 11 && h <= 13) || (h >= 18 && h <= 19))) add(1, () => ({ line: Dlg.line(c, 'npcInvite', { place: '食堂' }, rnd), pending: { type: 'npcInvite', place: 'diner' } }));
  if (like >= 20) add(0.6, () => ({ line: greetPlayer(c) }));
  if (!opts.length) return null;
  let r = rnd() * opts.reduce((a, o) => a + o[0], 0);
  for (const [w, f] of opts) { r -= w; if (r <= 0) return f(); }
  return opts[0][1]();
}

// すれ違いざまのひとこと
export function remarkLine(c) {
  const like = rel(c, 'player').like;
  const h = hour();
  const L = (a, b) => Dlg.lineN(c, [a, b]);
  if (like <= -30) return pick(['……チッ。', '……。', 'じろじろ見るな。']);
  if (S.wolfKnown && (h >= 19 || h < 6)) return L('夜道に気をつけて……。', '夜道にはお気をつけて……。');
  if (c.activity === 'work' && S.t < c.busyUntil) return L(pick(['今仕事中なんだ。', 'よいしょっと。', 'ふう、忙しい忙しい。']), 'お仕事中です、すみません。');
  if (c.hunger < 30) return L('はあ、お腹すいた……。', 'お腹が空きました……。');
  if (like >= 30) return L(pick([`やあ、${Dlg.toneOf(c).you}！`, 'お、また会ったね。', '今日も元気？']), 'こんにちは。');
  if (like >= 5) return L('やあ。', 'どうも。');
  return null;
}

export function arriveLine(c, place) { return Dlg.line(c, 'arrive', { sub: place }, rnd); }
export function dismissLine(c) { return Dlg.line(c, 'dismiss', {}, rnd); }

// ================= 掲示板 =================
const POST_TEMPLATES = {
  morning: (c) => pick([`今日も${jobName(c)}がんばるぞ。`, 'おはよう。今日は何事もないといいな。', '朝から腹が減ったな。', `${c.intent?.thought || '今日はどうするかな。'}`]),
  victim: (c, t) => pick([`${t.actor}に${t.what}。絶対に許さない。`, `誰か聞いてくれ、${t.actor}にやられた。`, `${t.actor}には近づかないほうがいい。`]),
  witness: (c, t) => pick([`さっき${t.actor}が${t.victim}に${t.what2}のを見た。`, `${t.actor}、何やってんだよ……`, `物騒になったな。${t.actor}には気をつけろ。`]),
  hungry: () => pick(['誰か食べ物を分けてくれないか……', '腹が減って倒れそうだ。', '食堂に行く金もない。']),
  meteor: () => pick(['空が光ったと思ったら何か落ちてきた！', 'あの光る石、なんなんだ？', '石を拾った奴は名乗り出ろ。']),
  meteorDone: (c, t) => pick([`あの石、${t.result}だったらしい。`, `${t.result}だって？ 誰が持ってるんだ。`]),
  death: (c, t) => pick([`${t.name}が……信じられない。`, `${t.name}のこと、忘れないよ。`]),
  reply: () => pick(['本当か？', 'それは聞き捨てならないな。', 'へえ、そうなんだ。', '証拠はあるのか？', '同感だ。']),
};

const TOPIC_TEXT = {
  morning: (c) => `朝。あなたの今日の方針は「${c.intent?.thought || '普段どおり'}」。今の気持ちを一言。`,
  victim: (c, t) => `さっき${t.actor}に${t.what}。`,
  witness: (c, t) => `さっき${t.actor}が${t.victim}に${t.what2}のを目撃した。`,
  hungry: () => 'お腹が空いているのに食べ物もお金もない。',
  meteor: () => '空から光る石が町に落ちてきた。',
  meteorDone: (c, t) => `光る石の正体が「${t.result}」だと判明した。`,
  death: (c, t) => `町の住民の${t.name}が亡くなった。`,
};

// 裏方のAI生成は1日に数回まで（GPUを会話のために空けておく）
const bg = { day: 0, n: 0 };
function bgBudget(cost = 1) {
  if (bg.day !== day()) { bg.day = day(); bg.n = 0; }
  if (bg.n + cost > (LLM.mode === 'api' ? 30 : 6)) return false;
  bg.n += cost;
  return true;
}

export async function postAbout(c, topic, t = {}) {
  if (!c.alive) return;
  c.postsToday = (c.postsToday || 0) + 1;
  let text = null;
  if (c.key && LLM.strong() && LLM.idle() && bgBudget()) {
    const msgs = [
      { role: 'system', content: selfDesc(c) + '\nあなたは町の掲示板に短く書き込みます。あなたの口調で、40文字以内の日本語。本文だけを出力し、かぎかっこや名前は付けない。' },
      { role: 'user', content: `きっかけ: ${TOPIC_TEXT[topic](c, t)}` },
    ];
    text = cleanSay(await LLM.complete(msgs, { maxTokens: 80, temperature: 0.85 }));
  }
  if (!text) text = POST_TEMPLATES[topic](c, t);
  post(c.name, text, { authorId: c.id });
}

export async function replyTo(c, p) {
  if (!c.alive) return;
  let text = null;
  if (c.key && LLM.strong() && LLM.idle() && bgBudget()) {
    const msgs = [
      { role: 'system', content: selfDesc(c) + '\n町の掲示板の書き込みに返信します。あなたの口調で、40文字以内の日本語。本文だけを出力する。書き込みの内容を鵜呑みにする必要はない。' },
      { role: 'user', content: `${p.author}の書き込み: 「${p.text}」` },
    ];
    text = cleanSay(await LLM.complete(msgs, { maxTokens: 80, temperature: 0.85 }));
  }
  if (!text) {
    const r = rel(c, 'player');
    text = p.authorId === 'player'
      ? (r.like < -20 ? pick(['よそ者の言うことなんて信じられるか。', '黙ってろ。']) : POST_TEMPLATES.reply())
      : POST_TEMPLATES.reply();
  }
  p.replies.push({ author: c.name, text, time: timeStr() });
}

// ================= 1日の方針 =================
export async function dailyIntent(c) {
  if (c.key && LLM.strong() && LLM.idle() && bgBudget(2)) {
    const msgs = [
      { role: 'system', content: selfDesc(c) + '\n今日一日の方針を決めます。次のJSONだけを出力:\n{"stance":"peaceful|work|scheme|aggressive","target":"気になる住民の名前 または null","thought":"今日の心の声(20文字以内)"}\npeaceful=仲良く助け合う work=真面目に働く scheme=ずる賢く立ち回る aggressive=力で押し通す' },
      { role: 'user', content: '今日はどうする？' },
    ];
    const j = await LLM.completeJSON(msgs, { maxTokens: 100, temperature: 0.9 });
    if (j && STANCES.includes(j.stance)) {
      c.intent = { stance: j.stance, target: S.chars.find((x) => x.name === j.target && x.id !== c.id)?.id || null, thought: cleanSay(j.thought) || '' };
      return;
    }
  }
  c.intent = templateIntent(c);
}

function templateIntent(c) {
  const p = c.p;
  let stance = 'work';
  const enemies = Object.entries(c.rel).filter(([, r]) => r.like < -35).sort((a, b) => a[1].like - b[1].like);
  if (enemies.length && p.aggression > 0.45 && chance(p.aggression)) stance = 'aggressive';
  else if ((c.coins < 3 || p.greed > 0.7) && p.honesty < 0.4 && chance(0.6)) stance = 'scheme';
  else if (p.sociability > 0.6 && chance(0.5)) stance = 'peaceful';
  const target = enemies[0]?.[0] || null;
  const tName = target ? (target === 'player' ? 'よそ者' : S.chars.find((x) => x.id === target)?.name) : null;
  const thoughts = {
    peaceful: ['みんなと仲良くやろう', '誰か困ってないかな'],
    work: ['今日もしっかり働くか', '稼がないとな'],
    scheme: ['楽して稼ぐ方法はないかな', 'うまく立ち回ってやる'],
    aggressive: [tName ? `${tName}には借りを返す` : 'なめられてたまるか', 'もう我慢の限界だ'],
  };
  return { stance, target, thought: pick(thoughts[stance]) };
}
