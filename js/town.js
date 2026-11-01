// 町の決まり・税金・金庫。決まりは話し合いで提案され、参加者の賛否で決まる。
import {
  S, day, hour, clamp, chance, rel, addLike, byId, residents, tilePos, distTiles, isJailed, memo, say, log, toast, post,
} from './state.js';
import { facAt } from './world.js';
import * as Sim from './sim.js';
import * as Wolf from './wolf.js';
import * as Laws from './laws.js';

// ---- 法律 ----
// 普通の町：盗み・暴力は禁止、牢屋・村長・衛兵あり、決め方は「決まりの重さで必要な賛成を変える」
// 無法の町：何もない。決め方（method）も決まっていない。最初の話し合いで、まず決め方から決める
const NORMAL = { tax: 4, curfew: false, patrol: false, ration: false, weaponBan: false, theftBan: true, violenceBan: true, jail: true, mayorOffice: true, guardOffice: true, method: 'standard' };
const LAWLESS = { tax: 0, curfew: false, patrol: false, ration: false, weaponBan: false, theftBan: false, violenceBan: false, jail: false, mayorOffice: false, guardOffice: false, method: null };

export function initTown(setup = { law: 'normal' }) {
  const lawless = setup.law === 'lawless';
  S.rules = { ...(lawless ? LAWLESS : NORMAL) };
  S.treasury = lawless ? 0 : 30;
  S.taxDebt = {};
  S.bounty = 0;
  if (lawless) {
    // 役職のない町：村長も衛兵もいない。元の役職の人は、ただの町の人として暮らす
    for (const c of residents()) {
      if (c.job === 'mayor' || c.job === 'guard') {
        c.formerJob = c.job; c.job = 'none';
        c.persona = c.persona.replace('この町の村長をつとめる', '町の長老の').replace(/村長/g, '長老').replace(/衛兵/g, '腕っぷし自慢');
      }
    }
  }
}
// 古いセーブにない決まりを補う
export function normalize() { S.rules = { ...NORMAL, ...(S.rules || {}) }; }
export const lawless = () => S.settings?.law === 'lawless';

// 悪いことが「法律違反」かどうか（違反のときだけ手配される。個人の怒りは法律と関係なく残る）
export function illegal(type) {
  const r = S.rules || NORMAL;
  if (!r.guardOffice) return false;   // 取り締まる人がいない
  if (type === 'theft') return r.theftBan;
  if (type === 'violence') return r.violenceBan;
  return r.theftBan || r.violenceBan;
}

// ---- 法律の重さと、必要な賛成の割合 ----
const WEIGHT = { tax: 'light', ration: 'light', patrol: 'heavy', curfew: 'heavy', weaponBan: 'heavy', theftBan: 'heavy', violenceBan: 'heavy', jail: 'heavy', mayorOffice: 'heavy', guardOffice: 'heavy', method: 'very' };
const METHOD = {
  majority: { light: 0.5, heavy: 0.5, very: 2 / 3, label: '何でも過半数で決める' },
  standard: { light: 0.5, heavy: 2 / 3, very: 3 / 4, label: '決まりの重さで変える（軽い:過半数／重い:3分の2／とても重い:4分の3）' },
  strict: { light: 2 / 3, heavy: 3 / 4, very: 4 / 5, label: '慎重に決める（軽い:3分の2／重い:4分の3／とても重い:5分の4）' },
};
export function threshold(rule) {
  const m = METHOD[S.rules.method];
  if (!m) return 3 / 4;   // 決め方が決まっていない町では、最初は4分の3の賛成が必要
  if (rule.key === 'law') return m[Laws.isHeavy(rule.value) ? 'heavy' : 'light'];
  if (rule.key === 'repeal') return m.heavy;
  return m[WEIGHT[rule.key] || 'heavy'];
}
export const ratioText = (r) => (r <= 0.5 ? '過半数' : Math.abs(r - 2 / 3) < 0.01 ? '3分の2以上' : Math.abs(r - 3 / 4) < 0.01 ? '4分の3以上' : '5分の4以上');
export const methodLabel = () => METHOD[S.rules.method]?.label || 'まだ決まっていない（まず決め方から決める）';
// 話し合いに必要な人数：住民の半分以上
export const quorum = () => Math.ceil(residents().filter((c) => c.alive && !isJailed(c)).length / 2);

// 村長（あなたが村長のこともある）
export const mayor = () => (S.player?.job === 'mayor' && S.player.alive ? S.player : residents().find((c) => c.job === 'mayor' && c.alive) || null);
const mayorWorking = () => { const m = mayor(); return m && !isJailed(m); };

// ---- 決まりの説明 ----
export function describe(rule) {
  const { key, value } = rule;
  if (key === 'tax') return value === 0 ? '税金をなくす' : `税金を1日${value}Gにする`;
  if (key === 'law') return `${Laws.describe(value)}という法律を作る`;
  if (key === 'repeal') { const l = Laws.byId(value); return `法律「${l ? Laws.describe(l) : '？'}」をやめる`; }
  if (key === 'method') return `法律の決め方を「${METHOD[value]?.label || value}」にする`;
  const on = {
    theftBan: '盗みの禁止（見つかれば手配され、衛兵に捕まる）', violenceBan: '暴力・脅しの禁止（見つかれば手配され、衛兵に捕まる）',
    jail: '牢屋を使う（悪いことをした人を閉じ込められる）', mayorOffice: '村長を置く（選挙で選ぶ）', guardOffice: '衛兵を置く（町の見張り役。法律を取り締まる）',
    curfew: '夜間外出禁止（夜9時〜朝5時は外に出ない）', patrol: '夜の見回り強化（衛兵が毎晩見回る）',
    ration: '食料の配給（貧しい人に毎朝、金庫から食料を配る）', weaponBan: '武器の持ち歩き禁止（見つかれば没収・罰金）',
  }[key];
  return value ? on : `「${on.replace(/（.*）/, '')}」をやめる`;
}

export function rulesText() {
  const r = S.rules;
  const list = [r.tax ? `税金 1日${r.tax}G` : '税金なし'];
  list.push(r.theftBan ? '盗みは禁止' : '盗みを禁じる法律はない');
  list.push(r.violenceBan ? '暴力は禁止' : '暴力を禁じる法律はない');
  if (!r.jail) list.push('牢屋は使わない');
  if (!r.mayorOffice) list.push('村長なし');
  if (!r.guardOffice) list.push('衛兵なし');
  for (const t of Laws.listText()) list.push(`法律：${t}`);
  if (r.curfew) list.push('夜間外出禁止');
  if (r.patrol) list.push('夜の見回り強化');
  if (r.ration) list.push('食料の配給');
  if (r.weaponBan) list.push('武器の持ち歩き禁止');
  return list;
}

// ---- 会話や発言から「決まりの提案」を読み取る ----
export function parseRule(text) {
  const t = text.replace(/\s+/g, '');
  const stop = /(やめ|解除|なくそ|廃止|取り消|撤廃)/.test(t);
  const r = S.rules;
  let rule = null;
  if (/税/.test(t)) {
    if (/(上げ|あげ|増や|高く)/.test(t)) rule = { key: 'tax', value: Math.min(12, r.tax + 3) };
    else if (/(なくそ|廃止|ゼロ|0G|なしに)/.test(t)) rule = { key: 'tax', value: 0 };
    else if (/(下げ|さげ|減ら|安く)/.test(t)) rule = { key: 'tax', value: Math.max(0, r.tax - 2) };
  } else if (/(夜間外出|外出禁止|夜(は|に)?出歩(くの|く)?(を|は)?禁止)/.test(t)) rule = { key: 'curfew', value: !stop };
  else if (/(見回り|パトロール|夜警)/.test(t) && /(増や|強化|しよう|始め|やろう|して|やめ)/.test(t)) rule = { key: 'patrol', value: !stop };
  else if (/(配給|食料を配|食べ物を配)/.test(t)) rule = { key: 'ration', value: !stop };
  else if (/武器/.test(t) && /禁止/.test(t)) rule = { key: 'weaponBan', value: !stop };
  else if (/(盗み|泥棒|窃盗|盗む)/.test(t) && /(禁止|ダメ|だめ|罰|法律|取り締ま|許さない|いけない)/.test(t)) rule = { key: 'theftBan', value: !(stop || /(禁止をやめ|許そう|自由に)/.test(t)) };
  else if (/(暴力|殴る|ケンカ|けんか|喧嘩|脅し)/.test(t) && /(禁止|ダメ|だめ|罰|法律|取り締ま|許さない|いけない)/.test(t)) rule = { key: 'violenceBan', value: !stop };
  else if (/牢屋/.test(t) && /(使|作|置|閉じ込め|入れられる)/.test(t)) rule = { key: 'jail', value: !stop };
  else if (/村長/.test(t) && /(置こう|置く|作ろう|決めよう|選ぼう|いらない|なくそ|廃止)/.test(t) && !/選挙/.test(t)) rule = { key: 'mayorOffice', value: !(stop || /いらない/.test(t)) };
  else if (/衛兵/.test(t) && /(置こう|置く|作ろう|いらない|なくそ|廃止)/.test(t)) rule = { key: 'guardOffice', value: !(stop || /いらない/.test(t)) };
  else if (/(決め方|多数決|過半数|3分の2|三分の二|4分の3|四分の三|全員一致)/.test(t) && /(決め|しよう|にする|変え)/.test(t)) {
    rule = { key: 'method', value: /過半数|多数決/.test(t) ? 'majority' : /(4分の3|四分の三|慎重|全員)/.test(t) ? 'strict' : 'standard' };
  }
  // 「誰が」「どんな罰で」まで言っていれば、組み立て式の法律として読む
  const explicit = /(罰金|牢屋|追放|むち|鞭|没収|ただ働き|強制労働|よそ者|余所者|村長以外|貧乏|貧しい|金持ち|夜|酒|占い|決闘|悪口)/.test(t);
  if (!rule || explicit) { const lr = Laws.parse(text); if (lr) return lr; }
  if (!rule || r[rule.key] === rule.value) return null;
  return rule;
}

// ---- 住民の賛否 ----
export function support(c, rule, proposer) {
  const fear = S.wolfKnown ? 0.35 : 0;
  const poor = c.coins < 8;
  const { key, value } = rule;
  let s;
  if (key === 'law' || key === 'repeal') {
    const law = key === 'law' ? value : Laws.byId(value);
    s = law ? Laws.support(c, law) : 0.5;
    if (key === 'repeal') s = 1 - s;
    return clamp(s + bias(c, proposer), 0, 1);
  }
  switch (key) {
    case 'curfew': s = 0.25 + fear + c.p.honesty * 0.2 - c.p.sociability * 0.15 - (c.isWolf ? 0.6 : 0); break;
    case 'patrol': s = 0.3 + fear + c.p.honesty * 0.15 - (c.job === 'guard' ? 0.15 : 0) - (c.isWolf ? 0.5 : 0); break;
    case 'ration': s = 0.35 + c.p.sociability * 0.25 - c.p.greed * 0.35 + (poor ? 0.3 : 0); break;
    case 'theftBan': s = 0.45 + c.p.honesty * 0.4 - c.p.greed * 0.25 + (c.memory.some((m) => /盗まれ/.test(m)) ? 0.25 : 0); break;
    case 'violenceBan': s = 0.45 + c.p.honesty * 0.3 - c.p.aggression * 0.4 + (c.memory.some((m) => /殴られ|脅され/.test(m)) ? 0.25 : 0); break;
    case 'jail': s = 0.4 + c.p.honesty * 0.3 - c.p.aggression * 0.15 + fear; break;
    case 'mayorOffice': s = 0.45 + c.p.sociability * 0.2 + c.p.honesty * 0.1 + (ambition(c) > 0.7 ? 0.2 : 0); break;
    case 'guardOffice': s = 0.4 + c.p.honesty * 0.3 + fear - (1 - c.p.honesty) * 0.2 + (c.formerJob === 'guard' ? 0.3 : 0); break;
    case 'method': s = S.rules.method ? (value === 'majority' ? 0.4 + (1 - c.p.honesty) * 0.3 : value === 'strict' ? 0.35 + c.p.honesty * 0.3 : 0.5) : 0.75 + c.p.honesty * 0.15; break;
    case 'weaponBan': s = 0.4 + c.p.honesty * 0.25 - c.p.aggression * 0.45 - (c.items.includes('weapon') ? 0.3 : 0); break;
    case 'tax':
      s = value > S.rules.tax
        ? 0.45 - c.p.greed * 0.5 - (poor ? 0.25 : 0) + (c.job === 'mayor' ? 0.4 : 0) + (S.treasury < 20 ? 0.1 : 0)
        : 0.4 + c.p.greed * 0.4 + (poor ? 0.25 : 0) - (c.job === 'mayor' ? 0.35 : 0);
      break;
    default: s = 0.5;
  }
  if (key !== 'tax' && key !== 'method' && !value) s = 1 - s;
  return clamp(s + bias(c, proposer), 0, 1);
}

// 誰の提案か：信頼・好き嫌い・根回し（leanFor）・同じ会の仲間
function bias(c, proposer) {
  let b = 0;
  if (proposer === 'player') b += (Wolf.trust(c, 'player') - 0.6) * 0.35;
  else if (proposer && proposer !== c.id) b += rel(c, proposer).like / 300;
  if (c.leanFor && S.t < c.leanFor.until && c.leanFor.id === proposer) b += 0.25;
  if (proposer && (S.groups || []).some((g) => g.members.includes(c.id) && g.members.includes(proposer))) b += 0.12;
  return b;
}

// 町をまとめたい気持ちの強さ（村長になりたがる人）
export function ambition(c) { return c.p.sociability * 0.4 + c.p.greed * 0.3 + c.p.aggression * 0.2 + (c.formerJob === 'mayor' || c.job === 'mayor' ? 0.3 : 0) + (/牛耳/.test(c.persona || '') ? 0.3 : 0); }

export function applyRule(rule) {
  const d = describe(rule);   // 変える前に説明を作る（廃止した法律の名前が消えないように）
  if (rule.key === 'law') Laws.add(rule.value);
  else if (rule.key === 'repeal') Laws.repeal(rule.value);
  else S.rules[rule.key] = rule.value;
  sideEffects(rule);
  for (const c of residents()) if (c.alive && c.psy) c.psy.mood.stress = Math.min(100, c.psy.mood.stress + 3);
  post('町役場', `【町の決まり】話し合いの結果、「${d}」が決まりました。`, { authorId: 'town' });
  log(`町の決まりが変わった：${d}`, 'event');
  Wolf.addNote(`町の決まり：${d}`);
  S.banner = { title: '📜 町の決まりが変わった', text: d, until: performance.now() + 7000 };
  for (const c of residents()) if (c.alive) memo(c, `話し合いで「${d}」が決まった`, 'meeting');
}

// 決まりが変わったときに町で起きること（衛兵を任命する・村長を選ぶ・牢屋を開ける など）
function sideEffects(rule) {
  const { key, value } = rule;
  if (key === 'guardOffice') {
    if (value) {
      const cands = residents().filter((c) => c.alive && !isJailed(c) && (c.job === 'none' || c.formerJob === 'guard') && c.job !== 'mayor')
        .sort((a, b) => (b.formerJob === 'guard') - (a.formerJob === 'guard') || (b.p.aggression + b.p.honesty) - (a.p.aggression + a.p.honesty)).slice(0, 2);
      for (const c of cands) { c.formerJob = c.job === 'guard' ? c.formerJob : c.job; c.job = 'guard'; memo(c, '町の衛兵に任命された', 'info'); }
      if (cands.length) { log(`${cands.map((c) => c.name).join('と')}が町の衛兵になった。`, 'event'); toast(`🛡️ ${cands.map((c) => c.name).join('と')}が衛兵になった`); }
    } else {
      for (const c of S.chars) if (c.job === 'guard') { c.job = c.isPlayer ? 'none' : (c.formerJob && c.formerJob !== 'guard' ? c.formerJob : 'none'); }
      S.wanted.clear();
    }
  }
  if (key === 'mayorOffice') {
    if (value) S.electionDue = true;   // 村長を選ぶ（話し合いのなかで選挙をする）
    else for (const c of S.chars) if (c.job === 'mayor') c.job = c.isPlayer ? 'none' : 'none';
  }
  if (key === 'jail' && !value) {
    for (const c of S.chars) if (c.jailedUntil > S.t && !c.jailedAsWolf) { c.jailedUntil = S.t; if (c.isPlayer) toast('牢屋が使われなくなったので、外に出された。'); }
  }
  if ((key === 'theftBan' || key === 'violenceBan') && !value) S.wanted.clear();
}

// ---- 村長を決める（選挙の結果） ----
export function setMayor(id) {
  const old = mayor();
  const w = id === 'player' ? S.player : byId(id);
  if (!w) return;
  if (old && old !== w) { old.job = old.isPlayer ? 'none' : (old.formerJob && old.formerJob !== 'mayor' ? old.formerJob : 'none'); memo(old, '選挙で村長の座を降りた', 'info'); }
  if (old !== w) { if (!w.isPlayer && w.job !== 'mayor') w.formerJob = w.job; w.job = 'mayor'; }
  const nm = w.isPlayer ? 'よそ者（あなた）' : w.name;
  post('町役場', `【選挙】${nm}が新しい村長に選ばれました。`, { authorId: 'town' });
  log(`${nm}が村長に選ばれた。`, 'event');
  S.banner = { title: '🏛️ 新しい村長', text: `${nm}が村長に選ばれた。${w.isPlayer ? '役場で話し合いを開いたり、税金の使い道を決めたりできる。' : ''}`, until: performance.now() + 9000 };
  for (const c of residents()) if (c.alive) memo(c, `${w.isPlayer ? 'よそ者' : w.name}が村長に選ばれた`, 'meeting');
  if (w.isPlayer) toast('🏛️ あなたが村長になった！');
}

// ---- 町の人が自分たちで決まりを作ろうとする（無法の町で特に）。人気のない村長には選挙を求める ----
function civic() {
  if (Wolf.meetingActive() || day() < 2 || !chance(0.5)) return;
  const r = S.rules;
  const live = residents().filter((c) => c.alive && !isJailed(c));
  const by = (fn) => live.slice().sort((a, b) => fn(b) - fn(a))[0];
  const st = S.stats;
  let rule = null, who = null;
  if (!r.theftBan && st.thefts >= 2) { rule = { key: 'theftBan', value: true }; who = by((c) => c.p.honesty + (c.memory.some((m) => /盗まれ/.test(m)) ? 1 : 0)); }
  else if (!r.violenceBan && st.fights >= 2) { rule = { key: 'violenceBan', value: true }; who = by((c) => c.p.honesty - c.p.aggression + (c.memory.some((m) => /殴られ/.test(m)) ? 1 : 0)); }
  else if (!r.mayorOffice && day() >= 3) { rule = { key: 'mayorOffice', value: true }; who = by(ambition); }
  else if ((r.theftBan || r.violenceBan) && !r.guardOffice && st.crimes >= 3) { rule = { key: 'guardOffice', value: true }; who = by((c) => c.p.honesty + c.p.aggression); }
  else if (r.guardOffice && !r.jail && st.crimes >= 5) { rule = { key: 'jail', value: true }; who = by((c) => c.p.honesty); }
  if (rule && who) {
    post(who.name, `町に「${describe(rule).replace(/（.*）/, '')}」の決まりが必要だと思う。みんなで話し合いたい。`, { authorId: who.id });
    Wolf.scheduleMeeting(who.id, 180, 'rule', rule);
    return;
  }
  // 不信任：村長がみんなに嫌われていたら、選挙を求める声が上がる
  const m = mayor();
  if (m && r.mayorOffice) {
    const avg = live.filter((c) => c !== m).reduce((a, c) => a + rel(c, m.id).like, 0) / Math.max(1, live.length - 1);
    if (avg < -15) {
      const rival = live.filter((c) => c !== m).sort((a, b) => ambition(b) - ambition(a))[0];
      if (rival) {
        post(rival.name, `今の村長${m.isPlayer ? '（よそ者）' : 'の' + m.name}にはついていけない。選挙でやり直そう。`, { authorId: rival.id });
        log(`${rival.name}が村長の選び直しを呼びかけた（不信任）。`, 'event');
        Wolf.scheduleMeeting(rival.id, 180, 'election');
      }
    }
  }
}

// ---- 毎朝：税金・配給 ----
export function daily() {
  civic();
  const p = S.player;
  const tax = S.rules.tax;
  if (!mayorWorking()) {
    if (p.alive) toast('村長が不在のため、今日は税金の取り立てがなかった。');
  } else if (tax > 0) {
    for (const c of S.chars) {
      if (!c.alive || isJailed(c)) continue;
      const debt = S.taxDebt[c.id] || 0;
      const pay = Math.min(Math.floor(c.coins), tax + debt);
      c.coins -= pay; S.treasury += pay;
      const left = tax + debt - pay;
      S.taxDebt[c.id] = left;
      if (c.isPlayer) {
        if (left <= 0) toast(`税金${tax}Gを払った${debt ? `（滞納分${debt}Gも）` : ''}。`);
        else toast(`💸 税金を払えなかった。滞納 ${left}G（役場で払える）。${left >= tax * 2 ? '滞納がたまったので手配された！' : 'もう1日たまると手配される。'}`);
      }
      if (left >= tax * 2) {
        if (!S.wanted.has(c.id)) {
          S.wanted.add(c.id);
          log(`${c.isPlayer ? 'よそ者' : c.name}が税金を滞納して手配された（滞納${left}G）。`, 'crime');
          if (!c.isPlayer) memo(c, '税金を滞納して手配された', 'crime');
        }
      }
    }
  }
  // 村長は金庫のお金で町の食料を買い足し、困っている人が多ければ救済策を提案する
  const m = mayor();
  if (m && !isJailed(m)) {
    if (S.treasury > 40 && S.foodStock < 60) {
      const spend = Math.floor(S.treasury * 0.4);
      S.treasury -= spend; S.foodStock += spend / 2;
      log(`村長の${m.name}が町の金庫から${spend}Gで食料を買い足した。`, 'event');
    }
    const debtors = residents().filter((c) => c.alive && (S.taxDebt[c.id] || 0) > 0).length;
    if (debtors >= 3 && !Wolf.meetingActive()) {
      const rule = !S.rules.ration ? { key: 'ration', value: true } : S.rules.tax > 2 ? { key: 'tax', value: S.rules.tax - 2 } : null;
      if (rule) Wolf.scheduleMeeting(m.id, 180, 'rule', rule);
    } else if (S.treasury > 120 && S.rules.tax > 1 && !Wolf.meetingActive()) {
      Wolf.scheduleMeeting(m.id, 180, 'rule', { key: 'tax', value: Math.max(1, S.rules.tax - 2) });
    }
  }
  if (S.rules.ration) {
    for (const c of S.chars) {
      if (!c.alive || isJailed(c) || c.coins >= tax + 3 || S.treasury < 3) continue;
      S.treasury -= 3; c.food++;
      if (c.isPlayer) toast('🍞 配給で食料を1つもらった。');
    }
  }
}

export function payDebt() {
  const p = S.player;
  const debt = S.taxDebt.player || 0;
  if (!debt) return toast('滞納はない。');
  const pay = Math.min(debt, Math.floor(p.coins));
  if (!pay) return toast('お金が足りない。');
  p.coins -= pay; S.treasury += pay; S.taxDebt.player = debt - pay;
  toast(`滞納分を${pay}G払った。${S.taxDebt.player ? `残り${S.taxDebt.player}G` : '滞納はなくなった。'}`);
  if (!S.taxDebt.player && S.wanted.has('player')) { S.wanted.delete('player'); toast('手配が取り消された。'); }
}

// ---- 毎時：決まりを衛兵が見張る ----
export function hourly(h) {
  const night = h >= 21 || h < 5;
  for (const g of residents()) {
    if (!g.alive || g.job !== 'guard' || isJailed(g) || g.inBed || (g.activity === 'sleep' && S.t < g.busyUntil)) continue;
    for (const o of S.chars) {
      if (!o.alive || o === g || o.job === 'guard' || isJailed(o) || distTiles(g, o) > 6 || !Sim.canSee(g, o)) continue;
      if (S.rules.weaponBan && o.items.includes('weapon')) {
        const i = o.items.indexOf('weapon'); o.items.splice(i, 1);
        const fine = Math.min(5, Math.floor(o.coins)); o.coins -= fine; S.treasury += fine;
        say(g, '武器の持ち歩きは禁止だ。没収する！', 5);
        if (o.isPlayer) toast(`🛡️ ${g.name}に武器を没収され、罰金${fine}Gを取られた。`);
        log(`${g.name}が${o.isPlayer ? 'よそ者' : o.name}の武器を没収した。`, 'event');
      }
      const [x, y] = tilePos(o);
      // 組み立て式の法律（夜の外出・武器）
      if (night && !facAt(x, y) && !o.hunt) Laws.enforce(o, 'night', [g], Sim.lawHooks);
      if (o.items.includes('weapon')) Laws.enforce(o, 'weapon', [g], Sim.lawHooks);
      if (S.rules.curfew && night && !facAt(x, y) && !o.hunt && !(o.task?.type === 'watch')) {
        if (S.wanted.has(o.id)) continue;
        say(g, `${o.isPlayer ? 'よそ者' : o.name}、夜間外出禁止だぞ！`, 5);
        S.wanted.add(o.id);
        log(`${o.isPlayer ? 'よそ者' : o.name}が夜間外出禁止を破って手配された。`, 'crime');
        if (o.isPlayer) toast('🚨 夜間外出禁止を破ったところを衛兵に見られた！ 手配された。');
        else Wolf.addSus(g, o.id, 15, '夜間外出禁止なのに出歩いていた');
      }
    }
  }
}

// 人狼騒ぎが起きたら、村長が懸賞金を出す
export function onWolfKnown() {
  const m = mayor();
  if (!m || S.bounty) return;
  S.bounty = 20;
  post(m.name, `【村長より】人狼の正体を突き止めた者には、町の金庫から${S.bounty}Gの懸賞金を出す。どうか力を貸してほしい。`, { authorId: m.id });
  Wolf.addNote(`村長が人狼に${S.bounty}Gの懸賞金をかけた`);
}

export function payBounty() {
  if (!S.bounty) return;
  const n = S.bounty;
  S.bounty = 0;
  S.player.coins += n;
  S.treasury = Math.max(0, S.treasury - n);
  toast(`💰 人狼を突き止めた懸賞金として${n}Gを受け取った！`);
  addLike(mayor() || S.player, S.player, 10);
}

void day; void hour; void chance; void byId;
