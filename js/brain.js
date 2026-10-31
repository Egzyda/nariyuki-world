// 住民の「頭の中」。LLMが使えればLLM、使えなければテンプレで動く。
import { LLM } from './llm.js';
import { S, day, timeStr, rel, pick, chance, jobName, post, mentionedNames, clamp } from './state.js';
import { ITEMS } from './data.js';

const STANCES = ['peaceful', 'work', 'scheme', 'aggressive'];

function situation() {
  const parts = [];
  parts.push(`町の食料の蓄え: ${Math.floor(S.foodStock)}食分`);
  if (S.droughtUntilDay >= day()) parts.push('日照りで畑の実りが悪い');
  if (S.meteor) {
    const m = S.meteor;
    if (m.state === 'ground') parts.push('空から落ちた光る石が地面に転がっている');
    else if (m.state === 'held') parts.push(`光る石は${holderName()}が持っている`);
    else if (m.state === 'done') parts.push(`光る石の正体は「${ITEMS[m.result].name}」だった`);
  }
  const recent = S.log.filter((l) => l.kind === 'crime' || l.kind === 'event' || l.kind === 'death').slice(0, 3);
  if (recent.length) parts.push('最近の出来事: ' + recent.map((l) => l.text).join(' / '));
  return parts.join('。');
}

function holderName() {
  const h = S.chars.find((c) => c.items.includes('meteor'));
  return h ? (h.isPlayer ? 'よそ者' : h.name) : '誰か';
}

function selfDesc(c) {
  return `あなたは町の住民「${c.name}」（${jobName(c)}）。${c.persona}\n` +
    `いまの状態: 体力${Math.round(c.hp)} 満腹度${Math.round(c.hunger)} 所持金${Math.floor(c.coins)}G 食料${c.food}個` +
    (c.items.length ? ` 持ち物:${c.items.map((i) => ITEMS[i].name).join('、')}` : '') + '\n' +
    `${day()}日目 ${timeStr()}。${situation()}\n` +
    `あなたの記憶: ${c.memory.slice(-6).join(' / ') || '特になし'}\n` +
    `他の住民への感情: ${relSummary(c)}`;
}

function relSummary(c) {
  const arr = Object.entries(c.rel)
    .filter(([id]) => id !== 'player')
    .map(([id, r]) => ({ n: S.chars.find((x) => x.id === id)?.name, ...r }))
    .filter((x) => x.n && (Math.abs(x.like) >= 25 || x.fear >= 25))
    .sort((a, b) => Math.abs(b.like) - Math.abs(a.like))
    .slice(0, 5);
  if (!arr.length) return '特に強い感情はない';
  return arr.map((x) => `${x.n}(好感${Math.round(x.like)}${x.fear >= 25 ? ' 恐怖' + Math.round(x.fear) : ''})`).join('、');
}

// ---------- プレイヤーとの会話 ----------
export async function talk(c, text, history, useLLM = true) {
  if (useLLM && LLM.available()) {
    const r = rel(c, 'player');
    const sys = selfDesc(c) + '\n' +
      `話し相手は最近町に来たよそ者（プレイヤー）。相手への好感度:${Math.round(r.like)}（-100〜100） 恐怖:${Math.round(r.fear)}。` +
      'よそ者の持ち物: ' + (S.player.items.map((i) => ITEMS[i].name).join('、') || 'なし') + `、所持金${Math.floor(S.player.coins)}G。\n` +
      'ルール: キャラクターになりきり、1〜2文の短い日本語の話し言葉で返す。ゲームやAIであることには触れない。' +
      '相手の言葉を鵜呑みにせず、自分の性格と利害で判断する（断る・嘘をつく・取引を持ちかける・怒る、も自由）。\n' +
      '次のJSONだけを出力する:\n' +
      '{"say":"セリフ","action":"none|give_coin|give_food|attack|flee|report","amount":0,"like":0,"belief":null}\n' +
      'action: give_coin=相手にお金を渡す(amountに枚数) give_food=食料を渡す attack=殴りかかる flee=立ち去る report=衛兵に通報する。\n' +
      'like: この会話による好感度の変化(-10〜10)。belief: 相手の話で他の住民への見方が変わったら {"target":"住民名","like":-15〜15}、なければnull。';
    const msgs = [{ role: 'system', content: sys }];
    for (const h of history.slice(-6)) msgs.push({ role: h.who === 'player' ? 'user' : 'assistant', content: h.who === 'player' ? h.text : JSON.stringify({ say: h.text }) });
    msgs.push({ role: 'user', content: text });
    const j = await LLM.completeJSON(msgs, { maxTokens: 200, temperature: 0.85 });
    if (j && typeof j.say === 'string' && j.say.trim()) {
      return {
        say: j.say.trim().slice(0, 120),
        action: ['give_coin', 'give_food', 'attack', 'flee', 'report'].includes(j.action) ? j.action : 'none',
        amount: clamp(parseInt(j.amount) || 1, 1, 5),
        like: clamp(Number(j.like) || 0, -10, 10),
        belief: j.belief && typeof j.belief === 'object' && j.belief.target ? { target: String(j.belief.target), like: clamp(Number(j.belief.like) || 0, -15, 15) } : null,
      };
    }
  }
  return templateTalk(c, text);
}

const NEG = ['泥棒', '嘘つき', '犯人', '殴った', '盗んだ', '悪い奴', '悪いやつ', 'クズ', '危ない', '裏切', '怪しい'];
const POS = ['いい人', '優しい', '助けてくれた', '信用できる', '頼りになる'];
const RUDE = ['バカ', 'ばか', '馬鹿', '嫌い', '死ね', 'うざ', 'ブス', 'カス', 'ボケ'];
const NICE = ['ありがとう', '好き', '友達', 'すごい', '素敵', 'よろしく'];

function templateTalk(c, text) {
  const r = rel(c, 'player');
  const p = c.p;
  const res = { say: '', action: 'none', amount: 1, like: 0, belief: null };
  const has = (arr) => arr.some((w) => text.includes(w));

  // 他の住民の話（噂を吹き込む）
  const others = mentionedNames(text).filter((o) => o.id !== c.id);
  if (others.length && (has(NEG) || has(POS))) {
    const o = others[0];
    const cred = clamp((r.like + 40) / 100, 0.1, 1) * (1 - p.honesty * 0.3);
    const neg = has(NEG);
    const myView = rel(c, o).like;
    if (neg && myView > 50) { res.say = `${o.name}がそんなことするわけないだろ。`; res.like = -4; return res; }
    res.belief = { target: o.name, like: Math.round((neg ? -12 : 10) * cred) };
    res.say = neg
      ? pick([`${o.name}が？ ……気をつけておくよ。`, `へえ、${o.name}がねえ。覚えておく。`, `本当か？ まあ、ありえない話じゃないな。`])
      : pick([`${o.name}はそういう人だよな。`, `へえ、${o.name}を見直したよ。`]);
    return res;
  }
  if (has(RUDE)) {
    res.like = -10;
    if (p.aggression > 0.55 && chance(p.aggression)) { res.say = pick(['なんだと、てめえ！', 'もう一回言ってみろ！']); res.action = 'attack'; }
    else res.say = pick(['……なんだよ、それ。', '失礼な奴だな。', 'もう話しかけないでくれ。']);
    if (res.action === 'none' && chance(0.4)) res.action = 'flee';
    return res;
  }
  const askMoney = /(金|コイン|お金|G)/.test(text) && /(くれ|貸|ちょうだい|ください|恵|欲しい|ほしい)/.test(text);
  const askFood = /(食べ物|ご飯|ごはん|食料|パン|飯)/.test(text) && /(くれ|貸|ちょうだい|ください|恵|欲しい|ほしい|分け)/.test(text);
  if (askMoney || askFood) {
    const kind = p.sociability * (1 - p.greed);
    const ok = r.like >= 45 || (r.like >= 15 && chance(kind)) || r.fear >= 50;
    if (askFood && ok && c.food > 0) { res.action = 'give_food'; res.say = r.fear >= 50 ? 'わ、わかったよ……ほら。' : 'しょうがないな、ほら。'; return res; }
    if (askMoney && ok && c.coins >= 2) { res.action = 'give_coin'; res.amount = r.like >= 60 ? 2 : 1; res.say = r.fear >= 50 ? 'これで勘弁してくれ……' : '少しだけだぞ。返せよな。'; return res; }
    res.say = p.greed > 0.6 ? pick(['タダで？ 冗談だろ。何をくれるんだ？', '見返りがあるなら考えてもいい。']) : pick(['悪いけど、こっちも余裕がないんだ。', 'もう少し仲良くなってからだな。']);
    res.like = -2;
    return res;
  }
  if (/(見逃|内緒|黙って|秘密)/.test(text)) {
    if (c.job === 'guard' && p.greed > 0.6) { res.say = 'タダじゃあなあ……分かるだろ？'; return res; }
    res.say = p.honesty > 0.7 ? 'それはできない相談だな。' : 'ふうん。考えておくよ。';
    return res;
  }
  if (/(石|隕石|物質)/.test(text) && S.meteor) {
    const m = S.meteor;
    res.say = m.state === 'ground' ? 'あの光る石、誰か拾ったか？ 気になるよな。'
      : m.state === 'done' ? `あれは結局「${ITEMS[m.result].name}」だったらしいぞ。`
      : `石は${holderName()}が持ってるって噂だ。`;
    return res;
  }
  if (has(NICE)) { res.like = 4; res.say = r.like > 30 ? pick(['こっちこそ。また話そう。', 'へへ、照れるな。']) : pick(['お、おう。よろしくな。', 'ふふ、悪い気はしないね。']); return res; }
  if (/(こんにちは|やあ|はじめまして|おはよう|こんばんは|よう)/.test(text)) {
    res.like = 1;
    res.say = r.like > 30 ? `やあ、元気そうだね。今日も${jobName(c)}の仕事さ。` : r.like < -30 ? '……何の用だ。' : `よそ者か。俺は${c.name}、${jobName(c)}をやってる。`;
    return res;
  }
  // 雑談
  const lines = [];
  if (c.hunger < 30) lines.push('腹が減ってしかたない……', '何か食べるものないかな。');
  if (S.foodStock < 15) lines.push('食堂の蓄えが減ってるらしい。まずいな。');
  if (S.droughtUntilDay >= day()) lines.push('この日照り、いつまで続くんだ。');
  if (c.memory.length) lines.push('最近いろいろあってね。' + c.memory[c.memory.length - 1].replace(/^\d+日目 /, '') + '。');
  lines.push('この町も色々あるよ。', 'ふーん、そうなんだ。', 'なるほどね。', 'まあ、のんびりやろうや。');
  if (p.greed > 0.7) lines.push('儲け話なら聞くよ？');
  if (p.aggression > 0.6) lines.push('で、用件はなんだ？');
  res.say = pick(lines);
  return res;
}

// ---------- 掲示板 ----------
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

export async function postAbout(c, topic, t = {}) {
  if (!c.alive) return;
  c.postsToday = (c.postsToday || 0) + 1;
  let text = null;
  if (c.key && LLM.available() && !LLM.busy()) {
    const msgs = [
      { role: 'system', content: selfDesc(c) + '\nあなたは町の掲示板に短く書き込みます。性格がにじむ口調で、40文字以内の日本語。本文だけを出力し、かぎかっこや名前は付けない。' },
      { role: 'user', content: `きっかけ: ${TOPIC_TEXT[topic](c, t)}` },
    ];
    text = await LLM.complete(msgs, { maxTokens: 80, temperature: 0.9 });
    text = cleanLine(text);
  }
  if (!text) text = POST_TEMPLATES[topic](c, t);
  post(c.name, text, { authorId: c.id });
}

export async function replyTo(c, p) {
  if (!c.alive) return;
  let text = null;
  if (c.key && LLM.available() && !LLM.busy()) {
    const msgs = [
      { role: 'system', content: selfDesc(c) + '\n町の掲示板の書き込みに返信します。性格がにじむ口調で、40文字以内の日本語。本文だけを出力する。書き込みの内容を鵜呑みにする必要はない。' },
      { role: 'user', content: `${p.author}の書き込み: 「${p.text}」` },
    ];
    text = cleanLine(await LLM.complete(msgs, { maxTokens: 80, temperature: 0.9 }));
  }
  if (!text) {
    const r = rel(c, 'player');
    text = p.authorId === 'player'
      ? (r.like < -20 ? pick(['よそ者の言うことなんて信じられるか。', '黙ってろ。']) : POST_TEMPLATES.reply())
      : POST_TEMPLATES.reply();
  }
  p.replies.push({ author: c.name, text, time: timeStr() });
}

function cleanLine(text) {
  if (!text) return null;
  let s = text.trim().split('\n')[0].replace(/^[「『"]|[」』"]$/g, '').replace(/^.{1,6}[:：]/, '').trim();
  if (!s) return null;
  return s.slice(0, 80);
}

// ---------- 1日の方針 ----------
export async function dailyIntent(c) {
  if (c.key && LLM.available()) {
    const msgs = [
      { role: 'system', content: selfDesc(c) + '\n今日一日の方針を決めます。次のJSONだけを出力:\n{"stance":"peaceful|work|scheme|aggressive","target":"気になる住民の名前 または null","thought":"今日の心の声(20文字以内)"}\npeaceful=仲良く助け合う work=真面目に働く scheme=ずる賢く立ち回る aggressive=力で押し通す' },
      { role: 'user', content: '今日はどうする？' },
    ];
    const j = await LLM.completeJSON(msgs, { maxTokens: 100, temperature: 0.9 });
    if (j && STANCES.includes(j.stance)) {
      c.intent = { stance: j.stance, target: S.chars.find((x) => x.name === j.target && x.id !== c.id)?.id || null, thought: cleanLine(j.thought) || '' };
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

// ---------- 住民同士の雑談（テンプレのみ） ----------
export function chatLine(a, b, rumor) {
  if (rumor) return pick([`${rumor}って知ってる？`, `聞いたか？ ${rumor}らしいぞ。`, `ここだけの話、${rumor}んだって。`]);
  const r = rel(a, b).like;
  if (r > 40) return pick([`${b.name}、今日も元気？`, 'また一緒に飯でも行こう。', 'いつも助かってるよ。']);
  if (r < -30) return pick(['……ちっ。', 'なんだよ。', 'こっち見んな。']);
  return pick(['いい天気だな。', '最近どう？', '腹減ったなあ。', 'ぼちぼちだね。', '仕事どう？', '物騒な話は勘弁だよ。']);
}
