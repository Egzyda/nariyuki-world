// 住民の頭脳（AI）：1日の予定・住民同士の会話・夜の日記。
// 無料枠を節約するため、裏方の考えごとは安いモデル（tier: 'light'）に、何人分かまとめて頼む。
// AIが使えないときや「控えめ」のときは、これまでどおりルールで動く（Brain.dailyIntent）。
import { LLM, parseJSON } from './llm.js';
import { S, day, hour, rel, pick, chance, clamp, residents, log, memo, say, addLike, isJailed } from './state.js';
import { JOBS } from './data.js';
import * as Dlg from './dialog.js';
import * as Brain from './brain.js';
import * as Sim from './sim.js';

const STANCES = ['peaceful', 'work', 'scheme', 'aggressive'];
const DOS = ['meet', 'eat', 'drink', 'visit', 'gift', 'confront', 'avoid', 'work', 'rest', 'player'];
const PLACES = ['diner', 'tavern', 'plaza', 'market', 'farm', 'lab', 'clinic', 'training', 'workshop', 'guard', 'townhall', 'home'];
const byName = (n) => (n ? S.chars.find((x) => x.name === n && !x.isPlayer) : null);
const nm = (id) => (id === 'player' ? 'よそ者' : S.chars.find((x) => x.id === id)?.name || '?');

// 1日ぶんの使用回数（住民同士のAI会話）
function stats() {
  if (!S.mind || S.mind.day !== day()) S.mind = { day: day(), chats: 0 };
  return S.mind;
}

// 住民ひとりぶんの短い説明（まとめて頼むので、なるべく短く）
function brief(c) {
  const mem = c.memory.slice(-3).map((m) => m.replace(/^\d+日目 /, '')).join(' / ') || 'なし';
  const diary = (c.diary || []).slice(-2).join(' / ') || 'なし';
  const pl = rel(c, 'player');
  return `- ${c.name}（${JOBS[c.job].name}・${c.female ? '女' : '男'}）${Brain.personaOf(c)} 所持金${Math.floor(c.coins)}G${Brain.needs(c) ? '・' + Brain.needs(c) : ''}。` +
    `気持ち：${Brain.relSummary(c)}。よそ者への好感${Math.round(pl.like)}。最近：${mem}。これまでの日記：${diary}`;
}

// ================= 朝：全員の1日の予定 =================
export async function morning() {
  const people = residents().filter((c) => c.alive && !isJailed(c));
  for (const c of people) { c.dayPlan = []; Brain.dailyIntent(c); }   // まずルールで決めておく（AIの答えが来たら上書き）
  if (!LLM.available() || !LLM.dens().plans) return;
  for (let i = 0; i < people.length; i += 5) planBatch(people.slice(i, i + 5));
}

async function planBatch(group) {
  const names = residents().filter((o) => o.alive).map((o) => o.name).join('、');
  const sys = 'あなたは町のシミュレーションで、住民たちが今日一日どう過ごすかを考える係です。それぞれの性格・気持ち・最近の出来事から、人間らしく、ときにドラマが起きるように予定を立ててください。\n' +
    `町の住民：${names}、よそ者（最近来た人。プレイヤー）。場所：diner=食堂 tavern=酒場 plaza=広場 market=市場 farm=畑 lab=研究所 clinic=診療所 training=訓練場 workshop=工房 guard=詰所 townhall=役場 home=自宅\n` +
    'できること(do)：meet=誰かに会って話す eat=食堂で食べる drink=酒場で飲む visit=どこかへ行く gift=誰かに施す confront=誰かに文句を言う・詰め寄る avoid=誰かを避ける work=働く rest=家で休む player=よそ者に話しかける\n' +
    '次のJSONだけを出力（説明は不要）：{"people":[{"name":"名前","stance":"peaceful|work|scheme|aggressive","thought":"今日の心の声(20字以内)","plans":[{"hour":8〜20の数字,"do":"上のどれか","who":"相手の名前またはnull","place":"場所またはnull","why":"理由(15字以内)"}]}]}\n' +
    '予定は1人2〜3個。仕事の時間も考えること。';
  const msgs = [{ role: 'system', content: sys }, { role: 'user', content: `${day()}日目の朝。町の様子：${Brain.situationText()}\n住民：\n${group.map(brief).join('\n')}` }];
  const j = parseJSON(await LLM.complete(msgs, { maxTokens: 120 * group.length, temperature: 0.9, tier: 'light' }));
  if (!j || !Array.isArray(j.people)) return;
  for (const x of j.people) {
    const c = group.find((o) => o.name === x?.name);
    if (!c || !c.alive) continue;
    const stance = STANCES.includes(x.stance) ? x.stance : c.intent?.stance || 'work';
    const thought = clean(x.thought, 24);
    const target = (x.plans || []).map((pl) => byName(pl.who)).find(Boolean);
    c.intent = { stance, target: target?.id || null, thought: thought || c.intent?.thought || '' };
    c.dayPlan = (Array.isArray(x.plans) ? x.plans : []).slice(0, 3).map((pl) => ({
      hour: clamp(Math.round(Number(pl.hour) || 12), 7, 21),
      do: DOS.includes(pl.do) ? pl.do : 'visit',
      who: pl.who === 'よそ者' ? 'player' : byName(pl.who)?.id || null,
      place: PLACES.includes(pl.place) ? pl.place : null,
      why: clean(pl.why, 20),
      done: false,
    })).filter((pl) => !['meet', 'gift', 'confront', 'avoid'].includes(pl.do) || pl.who).sort((a, b) => a.hour - b.hour);
    if (thought) log(`🧠 ${c.name}の今日の心の声：「${thought}」`, 'mind');
    if (c.dayPlan.length) log(`🗓️ ${c.name}の予定：${c.dayPlan.map(planText).join('／')}`, 'mind');
  }
}

const PLACE_JA = (id) => (id === 'home' ? '家' : Dlg.placeName(id));
export function planText(pl) {
  const w = pl.who ? nm(pl.who) : '';
  const t = {
    meet: `${w}に会う`, eat: `${w ? w + 'と' : ''}食堂で食べる`, drink: `${w ? w + 'と' : ''}酒場で飲む`, visit: `${pl.place ? PLACE_JA(pl.place) : 'どこか'}へ行く`,
    gift: `${w}に施す`, confront: `${w}に詰め寄る`, avoid: `${w}を避ける`, work: '働く', rest: '家で休む', player: 'よそ者に話しかける',
  }[pl.do] || pl.do;
  return `${pl.hour}時 ${t}${pl.why ? `（${pl.why}）` : ''}`;
}

function clean(s, max) {
  if (!s || typeof s !== 'string') return '';
  s = s.replace(/[「」"]/g, '').trim();
  if (/[A-Za-z]{6,}/.test(s)) return '';
  return s.slice(0, max);
}

// ================= 昼：予定どおりに動く（Sim.decide から呼ぶ。動いたら true） =================
export function runPlan(c) {
  if (!c.dayPlan?.length) return false;
  const h = hour();
  const pl = c.dayPlan.find((x) => !x.done && h >= x.hour && h < x.hour + 3);
  if (!pl) return false;
  pl.done = true;
  const t = pl.who && pl.who !== 'player' ? S.chars.find((x) => x.id === pl.who) : null;
  if (t && (!t.alive || isJailed(t))) return false;
  const why = pl.why ? `（${pl.why}）` : '';
  const go = (plan, text) => { Sim.setPlan(c, plan); if (text) log(`🗓️ ${c.name}が${text}${why}`, 'life'); return true; };
  switch (pl.do) {
    case 'meet': c.planTalk = { with: t.id, why: pl.why, tone: 'meet' }; return go({ targetId: t.id, kind: 'chat', giveUpAt: S.t + 90 }, `${t.name}に会いに行く`);
    case 'confront':
      if (c.p.aggression > 0.6 && rel(c, t).like < -30 && chance(0.5)) return go({ targetId: t.id, kind: 'threaten', giveUpAt: S.t + 90 }, `${t.name}に詰め寄りに行く`);
      c.planTalk = { with: t.id, why: pl.why, tone: 'confront' };
      return go({ targetId: t.id, kind: 'chat', giveUpAt: S.t + 90 }, `${t.name}に文句を言いに行く`);
    case 'gift': if (c.food > 0 || c.coins >= 3) return go({ targetId: t.id, kind: 'give', giveUpAt: S.t + 90 }, `${t.name}に差し入れに行く`); return false;
    case 'avoid': c.avoidId = t.id; c.avoidDay = day(); log(`🗓️ ${c.name}は今日、${t.name}を避けている${why}`, 'life'); return false;
    case 'eat': if (c.coins >= 3 && Sim.facIsOpen('diner')) return go({ place: 'diner', act: 'eat' }, `食堂へご飯を食べに行く`); return false;
    case 'drink': if (c.coins >= 1 && Sim.facIsOpen('tavern')) return go({ place: 'tavern', act: 'drink' }, `酒場へ飲みに行く`); return false;
    case 'work': { const pj = JOBS[c.job]?.place; if (pj && Sim.facIsOpen(pj)) return go({ place: pj, act: 'work' }, null); return false; }
    case 'rest': return go({ place: c.home, act: 'rest' }, '家で休む');
    case 'visit': {
      const place = pl.place === 'home' ? c.home : pl.place || 'plaza';
      if (place === 'plaza') return go({ place: 'plaza', tile: Sim.plazaTile(), act: 'wander' }, '広場へ出かける');
      if (!Sim.facIsOpen(place)) return false;
      return go({ place, act: 'visit' }, `${PLACE_JA(place)}へ出かける`);
    }
    case 'player': return Sim.planApproachPlayer(c);
  }
  return false;
}

// ================= 住民同士のAI会話 =================
// 予定で会いに行ったとき・気持ちが強い2人が会ったときに、AIが会話を作る（1日の回数に上限あり）
export function wantsAiChat(a, b) {
  if (a.isPlayer || b.isPlayer || !LLM.available()) return false;
  const lim = LLM.dens().chats;
  if (!lim || stats().chats >= lim) return false;
  if (a.planTalk?.with === b.id) return true;
  const strong = Math.abs(rel(a, b).like) >= 45 || Math.abs(rel(b, a).like) >= 45;
  return strong && chance(0.35);
}

export async function aiChat(a, b) {
  stats().chats++;
  const pt = a.planTalk?.with === b.id ? a.planTalk : null;
  a.planTalk = null;
  const sys = '町のシミュレーションで、2人の住民の短い会話を書きます。それぞれの性格・口調・関係・最近の出来事をふまえ、自然で人間らしいやりとりにしてください。\n' +
    '次のJSONだけを出力：{"lines":[["話す人の名前","セリフ(40字以内)"],...3〜4行],"a_to_b":-10〜10の数字(会話のあと' + a.name + 'の' + b.name + 'への気持ちの変化),"b_to_a":-10〜10,"memory_a":"' + a.name + 'が覚えておくこと(25字以内)","memory_b":"' + b.name + 'が覚えておくこと(25字以内)"}';
  const tone = (c) => `${c.name}の口調：${Dlg.toneOf(c).desc}、一人称「${Dlg.firstPerson(c)}」`;
  const user = `${brief(a)}\n${brief(b)}\n${tone(a)}。${tone(b)}。\n${a.name}から${b.name}に話しかける。` +
    (pt ? `${a.name}の目的：${pt.tone === 'confront' ? '文句を言う' : '話をする'}（${pt.why || ''}）` : '') + `\n場所：${Brain.locName(a)}、${day()}日目${hour()}時`;
  const j = parseJSON(await LLM.complete([{ role: 'system', content: sys }, { role: 'user', content: user }], { maxTokens: 260, temperature: 0.9, tier: 'light' }));
  if (!j || !Array.isArray(j.lines) || !a.alive || !b.alive) return false;
  const lines = j.lines.filter((l) => Array.isArray(l) && (l[0] === a.name || l[0] === b.name) && typeof l[1] === 'string').slice(0, 4);
  if (!lines.length) return false;
  lines.forEach(([who, text], i) => setTimeout(() => { const c = who === a.name ? a : b; if (c.alive) say(c, clean(text, 44) || text.slice(0, 44), 4); }, i * 1700));
  log(`💬 ${lines.map(([who, text]) => `${who}「${clean(text, 44)}」`).join(' → ')}`, 'talk');
  const d1 = clamp(Number(j.a_to_b) || 0, -10, 10), d2 = clamp(Number(j.b_to_a) || 0, -10, 10);
  addLike(a, b, d1); addLike(b, a, d2);
  if (clean(j.memory_a, 30)) memo(a, clean(j.memory_a, 30), 'info');
  if (clean(j.memory_b, 30)) memo(b, clean(j.memory_b, 30), 'info');
  return true;
}

// ================= 夜：1日のふり返り（日記）→ 次の日の予定や会話に使う =================
export function evening() {
  if (!LLM.available() || !LLM.dens().diary) return;
  const people = residents().filter((c) => c.alive);
  for (let i = 0; i < people.length; i += 5) diaryBatch(people.slice(i, i + 5));
}

async function diaryBatch(group) {
  const sys = '町の住民たちが、寝る前に今日をふり返って日記を1文書きます。その人の性格と口調で、今日の出来事や人への気持ちを書いてください。\n' +
    '次のJSONだけを出力：{"diary":[{"name":"名前","text":"日記(30字以内)"}]}';
  const today = (c) => (c.recent || []).filter((r) => S.t - r.t < 1440).map((r) => r.text).slice(-5).join(' / ') || '特に何もなかった';
  const user = group.map((c) => `- ${c.name}（${Dlg.toneOf(c).desc}）今日の出来事：${today(c)}。今日の心の声：${c.intent?.thought || 'なし'}`).join('\n');
  const j = parseJSON(await LLM.complete([{ role: 'system', content: sys }, { role: 'user', content: user }], { maxTokens: 70 * group.length, temperature: 0.8, tier: 'light' }));
  if (!j || !Array.isArray(j.diary)) return;
  for (const x of j.diary) {
    const c = group.find((o) => o.name === x?.name);
    const text = clean(x?.text, 36);
    if (!c || !text) continue;
    (c.diary ||= []).push(`${day()}日目：${text}`);
    if (c.diary.length > 4) c.diary.shift();
    log(`📔 ${c.name}の日記：「${text}」`, 'mind');
  }
}
