// ナリユキワールド — 町のデータ定義
// 施設・職業・住民・イベントはここに追加していけば町が広がる設計。

export const TILE = 32;
export const MAP_W = 54;
export const MAP_H = 36;

export const START_HOUR = 6;          // 1日目 06:00 開始
export const GAME_MIN_PER_SEC = 6;    // 実時間1秒 = ゲーム内6分
export const LAST_DAY = 15;           // 15日目の終わりで結果発表

export const MEAL_COST = 2;
export const HEAL_COST = 3;
export const WEAPON_COST = 6;
export const DRINK_COST = 1;

// ---- 職業 ----
// shirt: 服の色 hat: 頭の装備（sprites.js）
export const JOBS = {
  farmer:     { name: '農家',   icon: '🌾', color: '#7fb04a', shirt: '#6f9a3a', hat: 'straw',  place: 'farm',     wage: 1,   from: 8,  to: 17 },
  cook:       { name: '料理人', icon: '🍳', color: '#e0904a', shirt: '#f0f0f0', hat: 'chef',   place: 'diner',    wage: 1,   from: 9,  to: 19 },
  smith:      { name: '鍛冶屋', icon: '🔨', color: '#9a7a6a', shirt: '#7a5a46', hat: 'bandana', place: 'workshop', wage: 1.2, from: 8,  to: 17 },
  doctor:     { name: '医者',   icon: '🩺', color: '#e8e8f0', shirt: '#e8eef6', hat: null,     place: 'clinic',   wage: 1.5, from: 8,  to: 18 },
  guard:      { name: '衛兵',   icon: '🛡️', color: '#5a78c8', shirt: '#3e5ca8', hat: 'helmet', place: 'guard',    wage: 1.2, from: 8,  to: 20 },
  researcher: { name: '研究者', icon: '🔬', color: '#a070d0', shirt: '#8a5cc0', hat: 'glasses', place: 'lab',     wage: 1.2, from: 9,  to: 18 },
  merchant:   { name: '商人',   icon: '💰', color: '#d8c040', shirt: '#c8a030', hat: 'cap',    place: 'market',   wage: 1.5, from: 8,  to: 18 },
  none:       { name: 'よそ者', icon: '🎒', color: '#ffffff', shirt: '#d9485a', hat: null,     place: null,       wage: 0,   from: 0,  to: 0 },
};

// ---- 施設 ----
// x,y,w,h はタイル単位（外壁込み）。door は入口タイル（下の壁の上）。
// furn: 室内の家具 [室内での相対x, 相対y, 種類]（相対座標は建物の左上=0,0）
// spots: 住民が立つ場所 work=働く場所 customer=客が立つ場所 train=鍛える場所 cell=牢屋
const HOUSE_FURN = [
  [1, 1, 'bed'], [1, 2, 'bed'], [4, 1, 'bed'], [4, 2, 'bed'],
  [2, 2, 'table'], [3, 2, 'table'], [2, 3, 'chair'], [3, 3, 'chair'],
  [2, 1, 'shelf'], [3, 1, 'plant'],
];
const house = (id, name, x, roof) => ({
  id, name, icon: '🏠', x, y: 27, w: 6, h: 6, door: [x + 2, 32], home: true,
  roof, wall: '#c8a882', floor: 'wood', furn: HOUSE_FURN, spots: {},
});

export const FACILITIES = [
  { id: 'farm', name: '畑', icon: '🌾', x: 2, y: 2, w: 13, h: 9, door: [8, 10], kind: 'field', spots: {} },
  { id: 'diner', name: '食堂', icon: '🍲', x: 18, y: 3, w: 9, h: 7, door: [22, 9],
    roof: '#b4492f', wall: '#d8b48a', floor: 'wood',
    furn: [[1, 1, 'stove'], [1, 2, 'counter'], [2, 2, 'counter'], [3, 2, 'counter'],
      [6, 2, 'table'], [5, 2, 'chair'], [7, 2, 'chair'], [6, 4, 'table'], [5, 4, 'chair'], [7, 4, 'chair'],
      [2, 4, 'table'], [1, 4, 'chair'], [3, 4, 'chair'], [7, 1, 'plant'], [7, 5, 'barrel']],
    spots: { work: [[2, 1], [3, 1]] } },
  { id: 'market', name: '市場', icon: '🏪', x: 29, y: 3, w: 9, h: 7, door: [33, 9],
    roof: '#c89a2a', wall: '#e0c890', floor: 'wood',
    furn: [[1, 1, 'shelf'], [2, 1, 'shelf'], [3, 1, 'shelf'], [5, 1, 'shelf'], [6, 1, 'shelf'], [7, 1, 'shelf'],
      [2, 3, 'counter'], [3, 3, 'counter'], [5, 3, 'counter'], [6, 3, 'counter'], [1, 5, 'crate'], [7, 5, 'crate']],
    spots: { work: [[2, 2], [3, 2], [5, 2], [6, 2]], customer: [[2, 4], [3, 4], [5, 4], [6, 4]] } },
  { id: 'tavern', name: '酒場', icon: '🍺', x: 40, y: 3, w: 10, h: 7, door: [44, 9],
    roof: '#6a3a7a', wall: '#b08a6a', floor: 'wood',
    furn: [[1, 1, 'barrel'], [2, 1, 'barrel'], [3, 1, 'barrel'], [1, 2, 'counter'], [2, 2, 'counter'], [3, 2, 'counter'],
      [1, 3, 'stool'], [2, 3, 'stool'], [3, 3, 'stool'],
      [6, 2, 'table'], [5, 2, 'chair'], [7, 2, 'chair'], [6, 4, 'table'], [5, 4, 'chair'], [7, 4, 'chair'],
      [8, 1, 'bed'], [8, 5, 'bed']],
    spots: {} },
  { id: 'workshop', name: '工房', icon: '⚒️', x: 2, y: 15, w: 8, h: 7, door: [5, 21],
    roof: '#4a4a52', wall: '#a09080', floor: 'stone',
    furn: [[1, 1, 'forge'], [2, 1, 'forge'], [5, 1, 'rack'], [6, 1, 'rack'], [2, 3, 'anvil'], [5, 3, 'anvil'],
      [1, 5, 'crate'], [6, 5, 'barrel']],
    spots: { work: [[2, 2], [5, 2], [3, 3], [4, 3]], customer: [[4, 4]] } },
  { id: 'clinic', name: '診療所', icon: '🏥', x: 11, y: 15, w: 8, h: 7, door: [14, 21],
    roof: '#5a7ab8', wall: '#eeeef4', floor: 'tile',
    furn: [[1, 1, 'bed'], [1, 3, 'bed'], [1, 5, 'bed'], [5, 2, 'desk'], [5, 1, 'shelf'], [6, 1, 'shelf'], [6, 5, 'plant']],
    spots: { work: [[4, 2], [6, 2]], customer: [[4, 4]] } },
  { id: 'training', name: '訓練場', icon: '💪', x: 34, y: 15, w: 8, h: 7, door: [37, 21],
    roof: '#9a5a30', wall: '#c09a70', floor: 'mat',
    furn: [[2, 1, 'dummy'], [5, 1, 'dummy'], [1, 4, 'weights'], [6, 4, 'weights'], [6, 5, 'barrel']],
    spots: { train: [[2, 2], [5, 2], [2, 4], [5, 4], [3, 3], [4, 3]] } },
  { id: 'guard', name: '詰所', icon: '🛡️', x: 43, y: 15, w: 9, h: 7, door: [47, 21],
    roof: '#2a3a6a', wall: '#9aa0b0', floor: 'stone',
    furn: [[2, 2, 'desk'], [1, 5, 'rack'], [5, 1, 'bars'], [5, 2, 'bars'], [5, 3, 'bars'], [6, 3, 'bars'], [7, 3, 'bars'],
      [7, 1, 'bed'], [1, 1, 'shelf']],
    spots: { work: [[2, 1], [3, 2], [4, 4], [2, 4]], cell: [[6, 1], [6, 2], [7, 2]] } },
  { id: 'lab', name: '研究所', icon: '🔬', x: 2, y: 26, w: 8, h: 7, door: [5, 32],
    roof: '#4a3a6a', wall: '#c8c0d8', floor: 'tile',
    furn: [[1, 1, 'labbench'], [2, 1, 'labbench'], [3, 1, 'labbench'], [5, 1, 'bookshelf'], [6, 1, 'bookshelf'],
      [4, 3, 'labbench'], [5, 3, 'labbench'], [6, 5, 'plant']],
    spots: { work: [[2, 2], [4, 2], [5, 4], [1, 2]] } },
  house('house1', '東の家', 11, '#9a5a3a'),
  house('house2', '柳の家', 18, '#5a7a40'),
  house('house3', '丘の家', 25, '#8a4040'),
  house('house4', '井戸の家', 32, '#405a7a'),
  house('house5', '石の家', 39, '#6a6a6a'),
  { ...house('house6', '空き家', 46, '#5a4a3a'), icon: '🏚️' },
];

export const PLAZA = { x: 21, y: 14, w: 11, h: 8 };
export const BOARD_POS = [28, 15];          // 広場の掲示板
export const FOUNTAIN = [25, 17];          // 2x2
export const PLAZA_DECOR = [
  [22, 15, 'bench'], [22, 20, 'bench'], [30, 20, 'bench'],
  [21, 14, 'lamp'], [31, 14, 'lamp'], [21, 21, 'lamp'], [31, 21, 'lamp'],
];

// 道（[x0,y0,x1,y1] の長方形）
export const ROADS = [
  [1, 11, 52, 12], [1, 23, 52, 24], [1, 33, 52, 34],
  [16, 1, 17, 12], [38, 1, 39, 12],
  [10, 12, 10, 34], [19, 12, 20, 24], [32, 12, 33, 24], [42, 12, 42, 24], [52, 11, 52, 34],
];

// ---- 住民 ----
// key: true の住民はLLMで掲示板・方針決定を行う主要住民（会話は全員可能）
// p: aggression(攻撃性) honesty(誠実さ) sociability(社交性) greed(欲深さ) 0〜1
// tone: 口調（dialog.js）  hair: 髪型  likes: 好きなもの
export const KEY_RESIDENTS = [
  { id: 'haru',   name: 'ハル',   job: 'farmer',     home: 'house1', key: true, tone: 'cheerful', hair: 'long', female: true,
    likes: '噂話と、採れたての野菜',
    persona: '陽気で世話焼きな農家の女性。噂話が大好きで、困っている人を放っておけない。',
    p: { aggression: 0.1, honesty: 0.8, sociability: 0.95, greed: 0.25 } },
  { id: 'gou',    name: 'ゴウ',   job: 'smith',      home: 'house2', key: true, tone: 'rough', hair: 'spiky',
    likes: '強い酒と、いい鉄',
    persona: '短気で腕っぷしの強い鍛冶屋の男。義理堅いが、なめられるのが大嫌い。',
    p: { aggression: 0.8, honesty: 0.65, sociability: 0.4, greed: 0.4 } },
  { id: 'mina',   name: 'ミナ',   job: 'doctor',     home: 'house1', key: true, tone: 'polite', hair: 'long', female: true,
    likes: '静かな朝と、温かいお茶',
    persona: '冷静で正義感の強い町医者の女性。暴力を憎み、町の秩序を何より大事にする。',
    p: { aggression: 0.05, honesty: 0.95, sociability: 0.6, greed: 0.15 } },
  { id: 'tsuzumi', name: 'ツヅミ', job: 'merchant',  home: 'house3', key: true, tone: 'sly', hair: 'short',
    likes: 'もうけ話と、金貨の音',
    persona: '計算高い商人の男。にこやかだが嘘も方便と考えていて、得になるなら平気で話を盛る。',
    p: { aggression: 0.3, honesty: 0.2, sociability: 0.8, greed: 0.9 } },
  { id: 'ban',    name: 'バン',   job: 'guard',      home: 'house4', key: true, tone: 'stern', hair: 'short',
    likes: '規律と……まあ、ちょっとした心づけ',
    persona: '規律を口にする衛兵の男。ただし金にはめっぽう弱く、袖の下には目をつぶりがち。',
    p: { aggression: 0.5, honesty: 0.4, sociability: 0.5, greed: 0.75 } },
  { id: 'shion',  name: 'シオン', job: 'researcher', home: 'house5', key: true, tone: 'curious', hair: 'long', female: true,
    likes: '未知のものと、分厚い本',
    persona: '好奇心のかたまりの研究者の女性。未知のものを調べるためなら倫理は二の次。',
    p: { aggression: 0.35, honesty: 0.5, sociability: 0.35, greed: 0.45 } },
  { id: 'yoru',   name: 'ヨル',   job: 'cook',       home: 'house3', key: true, tone: 'quiet', hair: 'short',
    likes: '煮込み料理と、静かな夜',
    persona: '物静かな食堂の料理人の男。口数は少ないが、受けた恩も恨みも決して忘れない。',
    p: { aggression: 0.5, honesty: 0.75, sociability: 0.3, greed: 0.3 } },
  { id: 'kage',   name: 'カゲ',   job: 'farmer',     home: 'house5', key: true, tone: 'lazy', hair: 'spiky',
    likes: '昼寝と、楽なもうけ話',
    persona: '怠け者でずる賢い若者。働くより楽して稼ぐ方法ばかり考えている。いつか町を牛耳りたい。',
    p: { aggression: 0.6, honesty: 0.1, sociability: 0.6, greed: 0.85 } },
];

// [名前, 職業, 家, 口調, 髪型, 女性か]
const BG = [
  ['トキ', 'farmer', 'house1', 'polite', 'short', false], ['ナギ', 'farmer', 'house2', 'cheerful', 'long', true],
  ['ソラ', 'farmer', 'house2', 'lazy', 'spiky', false], ['イオ', 'farmer', 'house4', 'quiet', 'long', true],
  ['リク', 'farmer', 'house4', 'rough', 'short', false], ['ユメ', 'cook', 'house3', 'cheerful', 'long', true],
  ['ケン', 'smith', 'house2', 'rough', 'spiky', false], ['モモ', 'merchant', 'house5', 'cheerful', 'long', true],
  ['タロ', 'guard', 'house4', 'polite', 'short', false], ['ハナ', 'merchant', 'house1', 'polite', 'long', true],
  ['ジン', 'farmer', 'house3', 'quiet', 'short', false], ['サエ', 'cook', 'house5', 'curious', 'long', true],
];

const BG_LIKES = ['甘いもの', '散歩', '昼寝', '星を見ること', '釣り', '歌うこと', '料理', '花', '猫', 'うまい酒'];

export function makeBackgroundResidents(rand) {
  return BG.map(([name, job, home, tone, hair, female], i) => ({
    id: 'bg' + i, name, job, home, key: false, tone, hair, female,
    likes: BG_LIKES[Math.floor(rand() * BG_LIKES.length)],
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
