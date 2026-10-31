// ナリユキワールド — 町のデータ定義
// 施設・職業・住民・イベントはここに追加していけば町が広がる設計。

export const TILE = 32;
export const MAP_W = 44;
export const MAP_H = 32;

export const START_HOUR = 6;          // 1日目 06:00 開始
export const GAME_MIN_PER_SEC = 6;    // 実時間1秒 = ゲーム内6分
export const LAST_DAY = 15;           // 15日目の終わりで結果発表

export const MEAL_COST = 2;
export const HEAL_COST = 3;
export const WEAPON_COST = 6;
export const DRINK_COST = 1;

// ---- 職業 ----
export const JOBS = {
  farmer:     { name: '農家',   icon: '🌾', color: '#7fb04a', place: 'farm',     wage: 1,   from: 8,  to: 17 },
  cook:       { name: '料理人', icon: '🍳', color: '#e0904a', place: 'diner',    wage: 1,   from: 9,  to: 19 },
  smith:      { name: '鍛冶屋', icon: '🔨', color: '#9a7a6a', place: 'workshop', wage: 1.2, from: 8,  to: 17 },
  doctor:     { name: '医者',   icon: '🩺', color: '#e8e8f0', place: 'clinic',   wage: 1.5, from: 8,  to: 18 },
  guard:      { name: '衛兵',   icon: '🛡️', color: '#5a78c8', place: 'guard',    wage: 1.2, from: 8,  to: 20 },
  researcher: { name: '研究者', icon: '🔬', color: '#a070d0', place: 'lab',      wage: 1.2, from: 9,  to: 18 },
  merchant:   { name: '商人',   icon: '💰', color: '#d8c040', place: 'market',   wage: 1.5, from: 8,  to: 18 },
  none:       { name: 'よそ者', icon: '🎒', color: '#ffffff', place: null,       wage: 0,   from: 0,  to: 0 },
};

// ---- 施設 ---- (x,y,w,h はタイル単位。door は入口タイル)
export const FACILITIES = [
  { id: 'farm',     name: '畑',     icon: '🌾', x: 2,  y: 2,  w: 10, h: 7, color: '#8a6a3a', roof: '#6f8f3a', door: [7, 9] },
  { id: 'diner',    name: '食堂',   icon: '🍲', x: 14, y: 3,  w: 6,  h: 5, color: '#b0583a', roof: '#8c3f2a', door: [17, 8] },
  { id: 'market',   name: '市場',   icon: '🏪', x: 23, y: 3,  w: 6,  h: 5, color: '#c8a040', roof: '#a07a20', door: [26, 8] },
  { id: 'tavern',   name: '酒場',   icon: '🍺', x: 32, y: 3,  w: 7,  h: 5, color: '#7a4a8a', roof: '#5a3070', door: [35, 8] },
  { id: 'workshop', name: '工房',   icon: '⚒️', x: 2,  y: 14, w: 6,  h: 5, color: '#6a6a6a', roof: '#4a4a4a', door: [5, 19] },
  { id: 'clinic',   name: '診療所', icon: '🏥', x: 10, y: 14, w: 6,  h: 5, color: '#d8d8e8', roof: '#a0a0c0', door: [13, 19] },
  { id: 'training', name: '訓練場', icon: '💪', x: 30, y: 14, w: 6,  h: 5, color: '#a06a40', roof: '#7a4a28', door: [33, 19] },
  { id: 'guard',    name: '詰所',   icon: '🛡️', x: 37, y: 14, w: 5,  h: 5, color: '#4a5a8a', roof: '#2a3a6a', door: [39, 19] },
  { id: 'lab',      name: '研究所', icon: '🔬', x: 2,  y: 24, w: 7,  h: 5, color: '#5a4a7a', roof: '#3a2a5a', door: [5, 29] },
  { id: 'house1',   name: '東の家', icon: '🏠', x: 12, y: 25, w: 4,  h: 4, color: '#a08060', roof: '#7a5a40', door: [14, 29], home: true },
  { id: 'house2',   name: '柳の家', icon: '🏠', x: 17, y: 25, w: 4,  h: 4, color: '#a08060', roof: '#5a7a40', door: [19, 29], home: true },
  { id: 'house3',   name: '丘の家', icon: '🏠', x: 22, y: 25, w: 4,  h: 4, color: '#a08060', roof: '#7a4040', door: [24, 29], home: true },
  { id: 'house4',   name: '井戸の家', icon: '🏠', x: 27, y: 25, w: 4,  h: 4, color: '#a08060', roof: '#405a7a', door: [29, 29], home: true },
  { id: 'house5',   name: '石の家', icon: '🏠', x: 32, y: 25, w: 4,  h: 4, color: '#a08060', roof: '#6a6a6a', door: [34, 29], home: true },
  { id: 'house6',   name: '空き家', icon: '🏚️', x: 37, y: 25, w: 4,  h: 4, color: '#8a7a6a', roof: '#5a4a3a', door: [39, 29], home: true },
];

export const BOARD_POS = [22, 16];   // 広場の掲示板
export const PLAZA = { x: 18, y: 14, w: 9, h: 6 };

// ---- 住民 ----
// key: true の住民はLLMで会話・掲示板・方針決定を行う主要住民
// p: aggression(攻撃性) honesty(誠実さ) sociability(社交性) greed(欲深さ) 0〜1
export const KEY_RESIDENTS = [
  { id: 'haru',   name: 'ハル',   job: 'farmer',     home: 'house1', key: true,
    persona: '陽気で世話焼きな農家の女性。噂話が大好きで、困っている人を放っておけない。',
    p: { aggression: 0.1, honesty: 0.8, sociability: 0.95, greed: 0.25 } },
  { id: 'gou',    name: 'ゴウ',   job: 'smith',      home: 'house2', key: true,
    persona: '短気で腕っぷしの強い鍛冶屋の男。義理堅いが、なめられるのが大嫌い。',
    p: { aggression: 0.8, honesty: 0.65, sociability: 0.4, greed: 0.4 } },
  { id: 'mina',   name: 'ミナ',   job: 'doctor',     home: 'house1', key: true,
    persona: '冷静で正義感の強い町医者の女性。暴力を憎み、町の秩序を何より大事にする。',
    p: { aggression: 0.05, honesty: 0.95, sociability: 0.6, greed: 0.15 } },
  { id: 'tsuzumi', name: 'ツヅミ', job: 'merchant',  home: 'house3', key: true,
    persona: '計算高い商人の男。にこやかだが嘘も方便と考えていて、得になるなら平気で話を盛る。',
    p: { aggression: 0.3, honesty: 0.2, sociability: 0.8, greed: 0.9 } },
  { id: 'ban',    name: 'バン',   job: 'guard',      home: 'house4', key: true,
    persona: '規律を口にする衛兵の男。ただし金にはめっぽう弱く、袖の下には目をつぶりがち。',
    p: { aggression: 0.5, honesty: 0.4, sociability: 0.5, greed: 0.75 } },
  { id: 'shion',  name: 'シオン', job: 'researcher', home: 'house5', key: true,
    persona: '好奇心のかたまりの研究者の女性。未知のものを調べるためなら倫理は二の次。',
    p: { aggression: 0.35, honesty: 0.5, sociability: 0.35, greed: 0.45 } },
  { id: 'yoru',   name: 'ヨル',   job: 'cook',       home: 'house3', key: true,
    persona: '物静かな食堂の料理人の男。口数は少ないが、受けた恩も恨みも決して忘れない。',
    p: { aggression: 0.5, honesty: 0.75, sociability: 0.3, greed: 0.3 } },
  { id: 'kage',   name: 'カゲ',   job: 'farmer',     home: 'house5', key: true,
    persona: '怠け者でずる賢い若者。働くより楽して稼ぐ方法ばかり考えている。いつか町を牛耳りたい。',
    p: { aggression: 0.6, honesty: 0.1, sociability: 0.6, greed: 0.85 } },
];

const BG = [
  ['トキ', 'farmer', 'house1'], ['ナギ', 'farmer', 'house2'], ['ソラ', 'farmer', 'house2'],
  ['イオ', 'farmer', 'house4'], ['リク', 'farmer', 'house4'], ['ユメ', 'cook', 'house3'],
  ['ケン', 'smith', 'house2'], ['モモ', 'merchant', 'house5'], ['タロ', 'guard', 'house4'],
  ['ハナ', 'merchant', 'house1'], ['ジン', 'farmer', 'house3'], ['サエ', 'cook', 'house5'],
];

export function makeBackgroundResidents(rand) {
  return BG.map(([name, job, home], i) => ({
    id: 'bg' + i, name, job, home, key: false,
    persona: '',
    p: {
      aggression: +(rand() * 0.6).toFixed(2),
      honesty: +(0.3 + rand() * 0.7).toFixed(2),
      sociability: +(0.2 + rand() * 0.8).toFixed(2),
      greed: +(rand() * 0.7).toFixed(2),
    },
  }));
}

// ---- アイテム ----
export const ITEMS = {
  weapon:   { name: '鉄の棍棒', icon: '🏏', desc: '腕力+8' },
  meteor:   { name: '未知の物質', icon: '💎', desc: '空から落ちてきた光る石。研究所で調べられる。' },
  elixir:   { name: '万能薬', icon: '🧪', desc: '使うと体力が全回復する。' },
  bomb:     { name: '爆薬', icon: '💣', desc: '施設を爆破したり、脅しに使える。' },
  cursed:   { name: '呪いの石', icon: '🌑', desc: '持っていると毎日体力が削られる。誰かに渡せば…' },
};

// ---- イベント ----
export const EVENTS = {
  meteor:  { name: '隕石落下', day: 2 },
  drought: { name: '日照り', chance: 0.15, fromDay: 3, days: 2 },
};
