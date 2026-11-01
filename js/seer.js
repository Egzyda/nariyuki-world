// 占い師：人狼の気配を掲示板で知らせる。信用があるので、町の人はその言葉で疑いはじめる。
// 占いは当たるとは限らない（正直さは「普通くらい」）。当たれば信用が上がり、外れると下がる。
// 占い師自身が人狼のこともある（そのときは罪のない人をわざと名指しする）。
import { S, day, chance, pick, rel, addLike, byId, residents, isJailed, memo, log, post, toast } from './state.js';
import * as Wolf from './wolf.js';

export const seer = () => residents().find((c) => c.job === 'seer' && c.alive) || null;
const st = () => (S.seer ||= { announced: false, named: [], cred: 0.6, lastSay: 0 });
const pol = (c) => c.tone === 'polite';
export const credText = () => { const c = st().cred; return c >= 0.8 ? '町の人にとても信用されている' : c >= 0.55 ? 'まあまあ信用されている' : c >= 0.35 ? '半信半疑で見られている' : 'ほとんど信用されていない'; };

// 占いの結果（t は人狼か？）。正直な占い師はだいたい当たる。人狼の占い師は仲間をかばい、ほかの人を黒と言う
export function readFor(s, t) {
  if (s.isWolf) return t.isWolf ? false : chance(0.45);
  const acc = 0.55 + s.p.honesty * 0.3;   // 普通くらいの正直さで、およそ7〜8割当たる
  return chance(acc) ? !!t.isWolf : !t.isWolf && chance(0.5);
}

// 町の人が占い師の言葉で疑う（信用と、占い師への好感しだい）
function spreadSuspicion(s, t, why) {
  for (const o of residents()) {
    if (!o.alive || o === s || o === t) continue;
    const trust = st().cred * (0.6 + Wolf.trust(o, s.id) * 0.4);
    Wolf.addSus(o, t.id, 35 * trust, why);
  }
}

// 毎朝：占い師が何か感じたら掲示板に書く
export function morning() {
  const s = seer();
  if (!s || isJailed(s) || day() < 2) return;
  const sd = st();
  const live = Wolf.wolves().filter((w) => w.alive && !w.wolfRevealed && w !== s);
  if (!sd.announced) {
    // 1回目：人狼がいる気配。人狼がいなくても、不安なときは「嫌な気配がする」と言ってしまう
    const p = s.isWolf ? 0.7 : live.length ? (day() === 2 ? 0.55 : 0.85) : day() <= 4 ? 0.3 : 0.05;
    if (!chance(p)) return;
    sd.announced = true; sd.lastSay = day();
    const text = live.length || s.isWolf
      ? (pol(s) ? '占いに、はっきりと獣の影が出ました。この町に人狼がまぎれています。どうか気をつけてください。' : '占いに獣の影が出た。この町に人狼がいる。気をつけて。')
      : (pol(s) ? '占いに、何か不吉な影が見えました……人狼の言い伝えのような。考えすぎならいいのですが。' : '占いに不吉な影が見えた……人狼の言い伝えみたいな。考えすぎならいいけど。');
    post(s.name, `🔮 ${text}`, { authorId: s.id });
    S.wolfKnown = true;   // 町が人狼を意識しはじめる（本当にいるかどうかは別）
    S.banner = { title: `🔮 占い師の${s.name}が告げた`, text: `「${text}」\n町の人たちは、互いを疑いはじめた……`, until: performance.now() + 10000 };
    log(`占い師の${s.name}が「人狼がいる」と掲示板に書いた。`, 'event');
    for (const o of residents()) if (o.alive && o !== s) memo(o, `占い師の${s.name}が、人狼がいると占いに出たと言っていた`, 'info');
    Wolf.addNote(`占い師の${s.name}：「${text}」`);
    return;
  }
  // 2回目以降：ときどき、誰かの名前を出す
  if (day() - sd.lastSay < 2 || !chance(0.6)) return;
  const cands = residents().filter((o) => o.alive && o !== s && !isJailed(o) && !sd.named.includes(o.id));
  if (!cands.length) return;
  let t;
  if (s.isWolf) t = byId(S.wolf.frame) && cands.includes(byId(S.wolf.frame)) ? byId(S.wolf.frame) : pick(cands.filter((o) => !o.isWolf));
  else {
    const hit = live.length && chance(0.45 + s.p.honesty * 0.3);
    t = hit ? pick(live.filter((w) => cands.includes(w))) : pick(cands.filter((o) => rel(s, o).like < 30));
  }
  if (!t) return;
  sd.lastSay = day(); sd.named.push(t.id);
  const text = pol(s) ? `昨夜の占いで、${t.name}さんのまわりに黒い影が見えました。……ただの占いですが、気になります。` : `昨夜の占いで、${t.name}のまわりに黒い影が見えた。……ただの占いだけど。`;
  post(s.name, `🔮 ${text}`, { authorId: s.id });
  spreadSuspicion(s, t, `占い師の${s.name}が「${t.name}に黒い影が見えた」と言っていた`);
  log(`占い師の${s.name}が、${t.name}に黒い影が見えたと書いた。`, 'event');
  Wolf.addNote(`占い師の${s.name}：${t.name}のまわりに黒い影が見えた`);
  addLike(t, s, -20);
}

// あなたが占いを頼む（お金を払う）
export function askReading(t) {
  const s = seer();
  const p = S.player;
  if (!s) return toast('占い師がいない。');
  if (p.coins < 5) return toast('占ってもらうには5G必要だ。');
  p.coins -= 5; s.coins += 5;
  const black = readFor(s, t);
  const say = black
    ? (pol(s) ? `……${t.name}さんに、獣の影が重なって見えます。` : `……${t.name}に、獣の影が重なって見える。`)
    : (pol(s) ? `${t.name}さんからは、悪い気配は感じません。` : `${t.name}からは、悪い気配は感じないな。`);
  const r = `🔮 ${s.name}の占い：「${say}」（当たるとは限らない）`;
  toast(r);
  Wolf.addNote(`${s.name}に${t.name}を占ってもらった：${black ? '黒（人狼の影）' : '白（悪い気配なし）'}`);
  log(`よそ者が占い師の${s.name}に${t.name}を占ってもらった。`, 'info');
  addLike(s, p, 3);
  return r;
}

// 正体がわかったとき：占い師の当たり外れで信用が変わる
export function onReveal(w) {
  const sd = st();
  const s = seer();
  if (sd.named.includes(w.id)) {
    sd.cred = Math.min(1, sd.cred + 0.25);
    if (s) { for (const o of residents()) if (o.alive && o !== s) addLike(o, s, 8); log(`占い師の${s.name}の占いが当たった！ 町の人の信用が上がった。`, 'event'); }
  }
}

// 名指しした人が人狼に襲われた・無実とわかったとき：信用が下がる
export function onInnocent(o) {
  const sd = st();
  if (!sd.named.includes(o.id)) return;
  sd.cred = Math.max(0.1, sd.cred - 0.2);
  const s = seer();
  if (s) log(`占い師の${s.name}が名指しした${o.name}は人狼ではなかった。占いの信用が下がった。`, 'event');
}
