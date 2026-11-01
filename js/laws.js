// 組み立て式の法律：「何を」×「誰が」×「どんな罰で」。
// 住民（とあなた）が組み合わせて提案し、広場の話し合いで決める。無法の町では、めちゃくちゃな法律も通る。
import { S, chance, rel, addLike, addFear, memo, say, log, toast, clamp } from './state.js';

// ---- 部品 ----
export const ACTS = {
  theft: { name: '盗み', verb: '盗みをしたら' },
  violence: { name: '暴力', verb: '人を殴ったり脅したりしたら' },
  night: { name: '夜の外出', verb: '夜（21時〜5時）に外を出歩いたら' },
  weapon: { name: '武器', verb: '武器を持ち歩いたら' },
  drink: { name: 'お酒', verb: '酒場でお酒を飲んだら' },
  fortune: { name: '占い', verb: '占いをしたり頼んだりしたら' },
  duel: { name: '決闘', verb: '決闘をしたら' },
  gossip: { name: '悪口', verb: '掲示板で人の悪口を書いたら' },
};
export const WHO = {
  all: { name: '誰でも', test: () => true },
  stranger: { name: 'よそ者', test: (c) => c.isPlayer },
  notMayor: { name: '村長以外', test: (c) => c.job !== 'mayor' },
  poor: { name: '貧しい人（5G未満）', test: (c) => c.coins < 5 },
  rich: { name: '金持ち（30G以上）', test: (c) => c.coins >= 30 },
};
export const PENALTY = {
  fine: { name: '罰金5G', heavy: false },
  bigFine: { name: '罰金15G', heavy: true },
  jail: { name: '牢屋に1日', heavy: true },
  exile: { name: '町から追放（2日）', heavy: true },
  whip: { name: 'むち打ち（体力-25）', heavy: true },
  confiscate: { name: '持ち金をすべて没収', heavy: true },
  labor: { name: '畑で3時間ただ働き', heavy: false },
};

export const describe = (law) => `${WHO[law.who]?.name === '誰でも' ? '' : WHO[law.who].name + 'が'}${ACTS[law.act].verb}${PENALTY[law.penalty].name}`;
export const lawKey = (law) => `${law.act}:${law.who}:${law.penalty}`;
export const isHeavy = (law) => PENALTY[law.penalty].heavy || law.who !== 'all';
export const laws = () => (S.laws ||= []);

// ---- 会話・発言から法律を読み取る（「よそ者が夜に出歩いたら罰金にしよう」） ----
export function parse(text) {
  const t = text.replace(/\s+/g, '');
  if (!/(禁止|罰|罰金|牢屋|追放|むち|鞭|没収|ただ働き|したら|やったら|法律|条例)/.test(t)) return null;
  const act = /(盗み|泥棒|盗む)/.test(t) ? 'theft' : /(殴|暴力|ケンカ|けんか|喧嘩|脅)/.test(t) ? 'violence' : /(夜|夜中|深夜).*(出歩|外出|うろつ|外に出)/.test(t) ? 'night'
    : /武器/.test(t) ? 'weapon' : /(酒|飲酒|お酒)/.test(t) ? 'drink' : /占い/.test(t) ? 'fortune' : /決闘/.test(t) ? 'duel' : /(悪口|誹謗|中傷)/.test(t) ? 'gossip' : null;
  if (!act) return null;
  const who = /(よそ者|余所者|よそもの|新入り)/.test(t) ? 'stranger' : /村長以外/.test(t) ? 'notMayor' : /(貧乏|貧しい)/.test(t) ? 'poor' : /(金持ち|お金持ち)/.test(t) ? 'rich' : 'all';
  const penalty = /(没収|全財産)/.test(t) ? 'confiscate' : /(むち|鞭|体罰)/.test(t) ? 'whip' : /追放/.test(t) ? 'exile' : /牢屋|投獄/.test(t) ? 'jail'
    : /(ただ働き|強制労働|畑仕事)/.test(t) ? 'labor' : /(罰金.*(15|十五|高|重)|高い罰金)/.test(t) ? 'bigFine' : 'fine';
  const repeal = /(やめ|廃止|なくそ|撤廃|取り消)/.test(t);
  const law = { act, who, penalty };
  if (repeal) {
    const hit = laws().find((l) => l.act === act && (who === 'all' || l.who === who));
    return hit ? { key: 'repeal', value: hit.id } : null;
  }
  if (laws().some((l) => lawKey(l) === lawKey(law))) return null;
  return { key: 'law', value: law };
}

// ---- 住民の賛否（自分が損をする法律には反対、被害にあった人は賛成、差別的な法律は正直な人ほど嫌う） ----
export function support(c, law) {
  const p = c.p, ps = c.psy?.t || {};
  let s = 0.45;
  const hitsMe = WHO[law.who].test(c);
  const tempt = { theft: (1 - p.honesty) + p.greed * 0.5, violence: p.aggression, night: (c.psy?.habit === 'night_owl' ? 0.6 : 0.2) + (c.isWolf ? 0.8 : 0), weapon: p.aggression * 0.6 + (c.items.includes('weapon') ? 0.5 : 0),
    drink: c.psy?.habit === 'drinker' ? 0.8 : p.sociability * 0.4, fortune: c.job === 'seer' ? 1.2 : 0.1, duel: (ps.pride || 0.4) * p.aggression, gossip: (1 - p.honesty) * 0.5 }[law.act] || 0.3;
  const victim = { theft: /盗まれ/, violence: /殴られ|脅され/, night: /夜中|物音/, gossip: /悪口/ }[law.act];
  if (hitsMe) s -= tempt * 0.45;
  if (victim && c.memory.some((m) => victim.test(m))) s += 0.3;
  if (law.act === 'theft' || law.act === 'violence') s += 0.15 + p.honesty * 0.2;   // たいていの人は盗みや暴力をきらう
  if (law.who === 'stranger') s += (-rel(c, 'player').like / 120) - p.honesty * 0.2 + (ps.paranoia || 0.3) * 0.2;
  if (law.who === 'rich' || law.who === 'poor') s -= p.honesty * 0.2;
  if (['whip', 'confiscate', 'exile'].includes(law.penalty)) s -= (ps.empathy ?? 0.5) * 0.3 - (ps.darkness || 0) * 0.3;
  if (law.act === 'fortune' && c.job === 'seer') s -= 0.5;
  if (law.act === 'drink' && c.job === 'barkeep') s -= 0.6;
  return clamp(s, 0, 1);
}

// ---- 住民が自分の悩みから法律を考える（psyche から呼ぶ） ----
export function suggest(c) {
  const ps = c.psy?.t || {};
  const mem = c.memory.join(' ');
  const harsh = (ps.darkness || 0) > 0.45 || (c.psy?.mood?.anger || 0) > 70;
  const opts = [];
  if (/盗まれ/.test(mem)) opts.push({ act: 'theft', who: 'all', penalty: harsh ? (chance(0.5) ? 'whip' : 'exile') : chance(0.5) ? 'jail' : 'bigFine' });
  if (/殴られ|脅され/.test(mem)) opts.push({ act: 'violence', who: 'all', penalty: harsh ? 'whip' : 'jail' });
  if (/夜中|物音|遠吠え/.test(mem) && S.wolfKnown) opts.push({ act: 'night', who: rel(c, 'player').like < -10 ? 'stranger' : 'all', penalty: 'fine' });
  if (rel(c, 'player').like < -30) opts.push({ act: pick2(['night', 'drink', 'weapon']), who: 'stranger', penalty: harsh ? 'confiscate' : 'bigFine' });
  if ((ps.darkness || 0) > 0.5 && c.job === 'mayor') opts.push({ act: 'gossip', who: 'all', penalty: 'jail' });   // 村長への悪口を封じる
  if (c.coins < 5 && (ps.darkness || 0) > 0.4) opts.push({ act: 'theft', who: 'rich', penalty: 'confiscate' });   // 金持ちの盗みだけ重く
  if (/決闘/.test(mem)) opts.push({ act: 'duel', who: 'all', penalty: 'fine' });
  if (/占い/.test(mem) && (ps.paranoia || 0) < 0.3 && c.job !== 'seer') opts.push({ act: 'fortune', who: 'all', penalty: 'fine' });
  const ok = opts.filter((l) => !laws().some((x) => x.act === l.act && x.who === l.who));
  return ok.length ? ok[Math.floor(S.rand() * ok.length)] : null;
}
const pick2 = (a) => a[Math.floor(S.rand() * a.length)];

// 同じ「何を×誰が」の法律があれば、罰だけ新しいものに置きかえる
export function add(law) {
  law.id = 'L' + (S.lawSeq = (S.lawSeq || 0) + 1);
  S.laws = laws().filter((l) => !(l.act === law.act && l.who === law.who));
  S.laws.push(law);
}
export function repeal(id) { S.laws = laws().filter((l) => l.id !== id); }
export const byId = (id) => laws().find((l) => l.id === id);

// ---- 取り締まり：法律にふれる行いを誰かが見ていたら、罰を受ける ----
// 衛兵がいればその場で、いなければ見ていた住民が正直なら町に知らせて罰が決まる
export function enforce(actor, act, witnesses = [], hooks = {}) {
  if (!actor || !actor.alive) return null;
  const law = laws().find((l) => l.act === act && WHO[l.who].test(actor));
  if (!law) return null;
  const enforcer = witnesses.find((w) => w.job === 'guard' && !w.isWolf) || witnesses.find((w) => w.p && w.p.honesty > 0.55 && rel(w, actor.isPlayer ? 'player' : actor.id).like < 40);
  if (!enforcer) return null;
  const nm = actor.isPlayer ? 'よそ者' : actor.name;
  let text = '';
  switch (law.penalty) {
    case 'fine': case 'bigFine': { const n = Math.min(Math.floor(actor.coins), law.penalty === 'fine' ? 5 : 15); actor.coins -= n; S.treasury = (S.treasury || 0) + n; text = `罰金${n}G`; break; }
    case 'jail': hooks.jail?.(actor, 24 * 60); text = '牢屋に1日'; break;
    case 'exile': hooks.jail?.(actor, 2 * 24 * 60); actor.exiled = true; text = '町外れに2日間追放'; break;
    case 'whip': actor.hp = Math.max(5, actor.hp - 25); actor.hurtUntil = performance.now() + 600; text = 'むち打ち（体力-25）'; break;
    case 'confiscate': { const n = Math.floor(actor.coins); actor.coins = 0; S.treasury = (S.treasury || 0) + n; text = `持ち金${n}Gを没収`; break; }
    case 'labor': hooks.labor?.(actor); text = '畑で3時間ただ働き'; break;
  }
  say(enforcer, `${nm}、法律違反だ！ ${text}だ。`, 5);
  log(`⚖️ ${nm}が法律「${describe(law)}」にふれ、${enforcer.name}に見つかった（${text}）。`, 'event');
  if (actor.isPlayer) toast(`⚖️ 法律違反：「${describe(law)}」→ ${text}`);
  else { memo(actor, `法律違反で${text}の罰を受けた`, 'crime'); addLike(actor, enforcer, -15); actor.psy && (actor.psy.mood.anger = clamp(actor.psy.mood.anger + 30, 0, 100)); }
  // 重い罰は、見ていた人の心にも残る
  if (['whip', 'confiscate', 'exile'].includes(law.penalty)) for (const w of witnesses) { addFear(w, enforcer, 5); if (w.psy) w.psy.mood.fear = clamp(w.psy.mood.fear + 10, 0, 100); }
  return { law, text };
}

export const listText = () => laws().map((l) => describe(l));
