// 住民の「頭の中」。
// 会話は「意味の読み取り(dialog.js) → ゲームとしての判断 → セリフ」の順で作る。
// AIが使えるときは、判断した内容をAIにキャラクターの口調で言い換えてもらう（判断はブレない）。
import { LLM } from './llm.js';
import { S, day, hour, timeStr, rel, pick, chance, jobName, post, clamp, residents } from './state.js';
import { ITEMS, JOBS, TILE, PLAZA, MEAL_COST, DRINK_COST } from './data.js';
import { facAt } from './world.js';
import * as Dlg from './dialog.js';

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

function actText(c) {
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
    `町の様子: ${situation()}`;
}

// ================= プレイヤーとの会話 =================
export async function talk(c, text, history) {
  const it = Dlg.parseIntent(text, residents(), c);
  const res = respond(c, it, text);
  if (LLM.available() && res.say) {
    const out = await llmPhrase(c, text, history, res);
    if (out) res.say = out;
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

export function inviteDecision(c, place, treat) {
  const r = rel(c, 'player');
  const h = hour();
  if (h >= 22 || h < 6) return 'late';
  if (c.companion) return 'already';
  if (r.fear >= 55) return 'fear';
  if (r.like <= -20) return 'cold';
  const job = JOBS[c.job];
  const working = c.activity === 'work' && S.t < c.busyUntil;
  let score = 0.15 + r.like / 90 + c.p.sociability * 0.35;
  if (c.metPlayer) score += 0.08;
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
      const h = hour();
      if (like >= 15 && c.hunger < 60 && c.coins >= MEAL_COST && !c.companion && ((h >= 11 && h <= 13) || (h >= 18 && h <= 20))) {
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
      if (pend) { res.say = ln('pendingNo'); } else { res.say = ln('ack'); res.mode = 'free'; }
      break;
    case 'dismiss':
      if (c.companion) { res.say = ln('dismiss'); res.dismiss = true; } else { res.say = ln('dismissNone'); }
      break;
    case 'thanks': res.say = ln('thanks'); res.like = gainLike(c, 2); break;
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
      const mem = c.memory.filter((m) => !m.includes('よそ者') && /(見た|された|亡くな|捕ま|拾った)/.test(m));
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
  return s;
}

async function llmPhrase(c, text, history, res) {
  const r = rel(c, 'player');
  let task;
  if (res.mode === 'free') {
    task = '相手の言葉に、あなたらしく自然に返事してください。知らないことは知らないと言い、話をそらさないこと。';
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

export async function postAbout(c, topic, t = {}) {
  if (!c.alive) return;
  c.postsToday = (c.postsToday || 0) + 1;
  let text = null;
  if (c.key && LLM.available() && !LLM.busy()) {
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
  if (c.key && LLM.available() && !LLM.busy()) {
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
  if (c.key && LLM.available()) {
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
