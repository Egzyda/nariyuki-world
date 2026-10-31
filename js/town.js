// 町の決まり・税金・金庫。決まりは話し合いで提案され、参加者の賛否で決まる。
import {
  S, day, hour, clamp, chance, rel, addLike, byId, residents, tilePos, distTiles, isJailed, memo, say, log, toast, post,
} from './state.js';
import { facAt } from './world.js';
import * as Sim from './sim.js';
import * as Wolf from './wolf.js';

export function initTown() {
  S.rules = { tax: 4, curfew: false, patrol: false, ration: false, weaponBan: false };
  S.treasury = 30;
  S.taxDebt = {};
  S.bounty = 0;
}

export const mayor = () => residents().find((c) => c.job === 'mayor' && c.alive) || null;
const mayorWorking = () => { const m = mayor(); return m && !isJailed(m); };

// ---- 決まりの説明 ----
export function describe(rule) {
  const { key, value } = rule;
  if (key === 'tax') return value === 0 ? '税金をなくす' : `税金を1日${value}Gにする`;
  const on = {
    curfew: '夜間外出禁止（夜9時〜朝5時は外に出ない）', patrol: '夜の見回り強化（衛兵が毎晩見回る）',
    ration: '食料の配給（貧しい人に毎朝、金庫から食料を配る）', weaponBan: '武器の持ち歩き禁止（見つかれば没収・罰金）',
  }[key];
  return value ? on : `「${on.replace(/（.*）/, '')}」をやめる`;
}

export function rulesText() {
  const r = S.rules;
  const list = [`税金 1日${r.tax}G`];
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
  if (!rule || r[rule.key] === rule.value) return null;
  return rule;
}

// ---- 住民の賛否 ----
export function support(c, rule, proposer) {
  const fear = S.wolfKnown ? 0.35 : 0;
  const poor = c.coins < 8;
  const { key, value } = rule;
  let s;
  switch (key) {
    case 'curfew': s = 0.25 + fear + c.p.honesty * 0.2 - c.p.sociability * 0.15 - (c.isWolf ? 0.6 : 0); break;
    case 'patrol': s = 0.3 + fear + c.p.honesty * 0.15 - (c.job === 'guard' ? 0.15 : 0) - (c.isWolf ? 0.5 : 0); break;
    case 'ration': s = 0.35 + c.p.sociability * 0.25 - c.p.greed * 0.35 + (poor ? 0.3 : 0); break;
    case 'weaponBan': s = 0.4 + c.p.honesty * 0.25 - c.p.aggression * 0.45 - (c.items.includes('weapon') ? 0.3 : 0); break;
    case 'tax':
      s = value > S.rules.tax
        ? 0.45 - c.p.greed * 0.5 - (poor ? 0.25 : 0) + (c.job === 'mayor' ? 0.4 : 0) + (S.treasury < 20 ? 0.1 : 0)
        : 0.4 + c.p.greed * 0.4 + (poor ? 0.25 : 0) - (c.job === 'mayor' ? 0.35 : 0);
      break;
    default: s = 0.5;
  }
  if (key !== 'tax' && !value) s = 1 - s;
  if (proposer === 'player') s += (Wolf.trust(c, 'player') - 0.6) * 0.35;
  else if (proposer && proposer !== c.id) s += rel(c, proposer).like / 300;
  return clamp(s, 0, 1);
}

export function applyRule(rule) {
  S.rules[rule.key] = rule.value;
  const d = describe(rule);
  post('町役場', `【町の決まり】話し合いの結果、「${d}」が決まりました。`, { authorId: 'town' });
  log(`町の決まりが変わった：${d}`, 'event');
  Wolf.addNote(`町の決まり：${d}`);
  S.banner = { title: '📜 町の決まりが変わった', text: d, until: performance.now() + 7000 };
  for (const c of residents()) if (c.alive) memo(c, `話し合いで「${d}」が決まった`, 'meeting');
}

// ---- 毎朝：税金・配給 ----
export function daily() {
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
