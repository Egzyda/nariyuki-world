// 起動・入力・UI
import { TILE, FACILITIES, BOARD_POS, JOBS, ITEMS, LAST_DAY, PLAZA } from './data.js';
import { LLM } from './llm.js';
import { walkable, facAt, roofedFacAt } from './world.js';
import { S, day, timeStr, rel, residents, distTiles, isJailed, clamp, toast, log, say } from './state.js';
import * as Sim from './sim.js';
import * as Brain from './brain.js';
import * as Wolf from './wolf.js';
import * as Town from './town.js';
import { draw, view, resetRenderCache } from './render.js';

const $ = (s) => document.querySelector(s);
const cv = $('#cv');
const ctx = cv.getContext('2d');
const keys = new Set();
let menuFor = null;     // {type:'char'|'fac', id}
let chatTarget = null;
let currentTab = 'status';
let lastBoardSeen = 0;
let expanded = null;

const PLAYER_SPEED = 230;   // px/秒（Shiftで1.6倍）

// ---------- タイトル ----------
(async function setupTitle() {
  if (!LLM.hasWebGPU()) {
    document.querySelectorAll('.webgpu').forEach((l) => { l.classList.add('disabled'); l.querySelector('input').disabled = true; });
    $('#gpu-note').textContent = 'このブラウザはWebGPUに対応していないため、ブラウザ内AIは使えません（PC版Chrome推奨）。';
  } else {
    $('#gpu-note').textContent = 'ブラウザ内AIは初回にモデルをダウンロードします（2回目以降はキャッシュ）。';
  }
  const api = await LLM.probeApi();
  const apiInput = $('.api input');
  if (api) apiInput.checked = true;
  else {
    $('.api').classList.add('disabled'); apiInput.disabled = true;
    $('#api-note').textContent = '（未設定：Cloudflare Pages に Workers AI を追加すると使えます。READMEを参照）';
    document.querySelector(LLM.hasWebGPU() ? 'input[value="webllm-large"]' : 'input[value="none"]').checked = true;
  }
})();

// クラウドAIの無料枠が切れたら、ブラウザ内AIに切り替える
LLM.onQuota = () => {
  if (LLM.switching) return;
  toast(LLM.hasWebGPU() ? '☁️ クラウドAIの今日の無料枠を使い切りました。ブラウザ内AIに切り替えます（読み込み中はAIなしで動きます）'
    : '☁️ クラウドAIの今日の無料枠を使い切りました。このブラウザではブラウザ内AIが使えないため、AIなしで続けます');
  LLM.switchToBrowser((p) => { aiLoad = Math.round(p * 100); });
};
LLM.onSwitched = (ok) => { aiLoad = null; toast(ok ? '🧠 ブラウザ内AIに切り替わりました' : 'ブラウザ内AIを読み込めませんでした。AIなしで続けます'); };
let aiLoad = null;

$('#start').onclick = async () => {
  const mode = document.querySelector('input[name=mode]:checked').value;
  $('#start').disabled = true;
  if (mode !== 'none') {
    $('#loading').hidden = false;
    try {
      await LLM.init(mode, (p, text) => {
        $('#load-bar').style.width = Math.round(p * 100) + '%';
        $('#load-text').textContent = text.slice(0, 80);
      });
    } catch (e) {
      console.error(e);
      $('#load-text').textContent = 'AIの読み込みに失敗しました。AIなしで始めます。';
      LLM.mode = 'none';
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  startGame();
};

function startGame() {
  Sim.initGame(Date.now());
  resetRenderCache();
  $('#title').hidden = true;
  $('#result').hidden = true;
  $('#game').hidden = false;
  resize();
  lastBoardSeen = S.postSeq;
  view.camX = S.player.x - cv.width / view.zoom / 2;
  view.camY = S.player.y - cv.height / view.zoom / 2;
  toast('WASD/矢印で移動（Shiftで走る）。人や建物の中で F キー。');
  toast('目の前の🏡があなたの家。タンスにお金をしまえる。');
  if (LLM.available()) toast('住民はAIで話します。自由に話しかけてみよう。');
}

// ---------- ループ ----------
let last = performance.now();
let uiTimer = 0;
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (!$('#game').hidden && S.player) {
    movePlayer(dt);
    Sim.update(dt);
    // 会話でAIの返事を待っている間は描画を止め、GPUをAIに回す
    if (!(chatTarget && chatBusy && LLM.generating())) draw(ctx, cv.width, cv.height, dt);
    uiTimer -= dt;
    if (uiTimer <= 0) { uiTimer = 0.3; updateUI(); }
    updateToasts();
    if (S.over && $('#result').hidden) showResult();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function resize() {
  const r = $('#stage').getBoundingClientRect();
  cv.width = Math.floor(r.width); cv.height = Math.floor(r.height);
  view.zoom = clamp(Math.round((Math.min(cv.width, cv.height * 1.3) / 700) * 4) / 4, 1, 2);
}
window.addEventListener('resize', resize);

// ---------- 入力 ----------
const typing = () => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
window.addEventListener('keydown', (e) => {
  if (typing()) { if (e.key === 'Escape') document.activeElement.blur(); return; }
  if (!chatTarget && $('#picker').hidden) {
    const k = e.key.toLowerCase();
    keys.add(k);
    if (k === 'f') { e.preventDefault(); if (!e.repeat) interactKey(); }
    if (k === ' ') { e.preventDefault(); if (!e.repeat) setSpeed(S.paused ? 1 : 0); }
    if (k === 'escape') closeMenu();
    if (k === 'p') setSpeed(S.paused ? 1 : 0);
    if (k === 'b') switchTab('board');
    if (k === 'n') switchTab('notes');
    if (k === 'i') switchTab('items');
    if (k === 'm') view.showMinimap = !view.showMinimap;
    if (k === '-' ) view.zoom = clamp(view.zoom - 0.25, 0.75, 2.5);
    if (k === '=' || k === '+' || k === ';') view.zoom = clamp(view.zoom + 0.25, 0.75, 2.5);
    if (/^[1-9]$/.test(k) && menuFor) { const b = $('#menu').querySelectorAll('button')[+k - 1]; if (b && !b.disabled) b.click(); }
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
  } else if (e.key === 'Escape') { closeChat(); closePicker(); }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());
cv.addEventListener('wheel', (e) => { e.preventDefault(); view.zoom = clamp(view.zoom + (e.deltaY < 0 ? 0.25 : -0.25), 0.75, 2.5); }, { passive: false });

function movePlayer(dt) {
  const p = S.player;
  p.moving = false;
  if (!p.alive || S.paused || chatTarget || S.over) return;
  if (Sim.playerBusy()) return;
  let vx = 0, vy = 0;
  if (keys.has('w') || keys.has('arrowup')) vy -= 1;
  if (keys.has('s') || keys.has('arrowdown')) vy += 1;
  if (keys.has('a') || keys.has('arrowleft')) vx -= 1;
  if (keys.has('d') || keys.has('arrowright')) vx += 1;
  if (!vx && !vy) return;
  const len = Math.hypot(vx, vy);
  const run = keys.has('shift') ? 1.6 : 1;
  const sp = PLAYER_SPEED * run * (p.hunger < 15 ? 0.6 : 1) * dt;
  const x0 = p.x, y0 = p.y;
  tryMove(p, (vx / len) * sp, 0);
  tryMove(p, 0, (vy / len) * sp);
  p.dir = Math.abs(vx) > Math.abs(vy) ? (vx > 0 ? 'right' : 'left') : (vy > 0 ? 'down' : vy < 0 ? 'up' : p.dir);
  const moved = Math.hypot(p.x - x0, p.y - y0);
  if (moved > 0) { p.moving = true; p.anim += moved * 0.8; p.spot = null; }
  if (p.activity && p.activity !== 'sleep') p.activity = null;
  if (menuFor) {
    const t = menuFor.type === 'char' ? S.chars.find((c) => c.id === menuFor.id) : null;
    const far = t ? distTiles(p, t) > 2.2 : menuFor.type === 'fac' ? currentFacility()?.id !== menuFor.id : false;
    if (far) closeMenu();
  }
}

const R = 8;
function blocked(x, y) {
  for (const [ox, oy] of [[-R, -R + 6], [R, -R + 6], [-R, R], [R, R]]) {
    if (!walkable(Math.floor((x + ox) / TILE), Math.floor((y + oy) / TILE))) return true;
  }
  return false;
}
function tryMove(c, dx, dy) {
  if (!dx && !dy) return;
  const nx = c.x + dx, ny = c.y + dy;
  if (!blocked(nx, ny)) { c.x = nx; c.y = ny; return; }
  // 角に引っかかったら、通路の中心へ少し寄せる（入口を通りやすく）
  if (dy) {
    const cx = Math.floor(c.x / TILE) * TILE + TILE / 2;
    const off = cx - c.x;
    if (Math.abs(off) < 14 && !blocked(cx, ny)) c.x += Math.sign(off) * Math.min(Math.abs(off), Math.abs(dy) + 1);
  } else {
    const cy = Math.floor(c.y / TILE) * TILE + TILE / 2;
    const off = cy - c.y;
    if (Math.abs(off) < 14 && !blocked(nx, cy)) c.y += Math.sign(off) * Math.min(Math.abs(off), Math.abs(dx) + 1);
  }
}

function playerTile() { return [Math.floor(S.player.x / TILE), Math.floor(S.player.y / TILE)]; }
function currentFacility() { const [x, y] = playerTile(); return facAt(x, y); }

function nearestThing() {
  const p = S.player;
  const inGuard = currentFacility()?.id === 'guard';
  const chars = S.chars.filter((c) => c !== p && c.alive && (isJailed(c) ? inGuard && distTiles(p, c) <= 2.7 : distTiles(p, c) <= 1.6) && Sim.canSee(p, c))
    .sort((a, b) => distTiles(p, a) - distTiles(p, b));
  if (chars.length) return { type: 'char', target: chars[0] };
  const m = S.meteor;
  if (m && m.state === 'ground' && Math.hypot(p.x - (m.tx * TILE + 16), p.y - (m.ty * TILE + 16)) / TILE < 1.4) return { type: 'meteor' };
  if (Math.hypot(p.x - (BOARD_POS[0] * TILE + 16), p.y - (BOARD_POS[1] * TILE + 16)) / TILE < 1.6) return { type: 'board' };
  const f = currentFacility();
  if (f) return { type: 'fac', target: f };
  return null;
}

function interactKey() {
  if (!S.player.alive || S.over) return;
  if (S.callout && performance.now() < S.callout.until) {
    const c = S.chars.find((x) => x.id === S.callout.id);
    S.callout = null;
    if (c && c.alive && distTiles(c, S.player) < 4) { closeMenu(); openChat(c); return; }
  }
  if (menuFor) { closeMenu(); return; }
  if (Sim.playerBusy()) { toast('今は手が離せない。'); return; }
  const n = nearestThing();
  if (!n) { toast('近くに話せる人や入れる建物がない。'); return; }
  if (n.type === 'char') openCharMenu(n.target);
  else if (n.type === 'fac') openFacMenu(n.target);
  else if (n.type === 'board') openBoardMenu();
  else if (n.type === 'meteor') {
    const m = S.meteor;
    m.state = 'held'; m.holder = 'player'; S.player.items.push('meteor');
    toast('💎 光る石を拾った！ 研究所で調べられそうだ。');
    log('よそ者が光る石を拾った。', 'event');
  }
}

// ---------- メニュー ----------
function openCharMenu(t) {
  menuFor = { type: 'char', id: t.id };
  S.holdId = t.id;
  const r = rel(t, S.player);
  const acts = Sim.charActions(t);
  const m = $('#menu');
  m.innerHTML = `<h3>${t.name}（${JOBS[t.job].name}）</h3><div class="sub2">好感度 ${Math.round(r.like)} ／ 恐怖 ${Math.round(r.fear)}${S.wanted.has(t.id) ? ' ／ <span class="wanted">手配中</span>' : ''}${t.companion ? ' ／ 🤝同行中' : ''}</div>`;
  acts.forEach((a, i) => {
    const b = document.createElement('button');
    b.innerHTML = `<span class="k">${i + 1}</span>${a.label}`;
    b.disabled = !!a.disabled;
    if (['attack', 'steal', 'threaten'].includes(a.id)) b.className = 'danger';
    b.onclick = () => {
      if (a.id === 'talk') { chatTarget = t; closeMenu(); openChat(t); return; }
      closeMenu();
      Sim.doCharAction(t, a.id);
    };
    m.appendChild(b);
  });
  m.hidden = false;
}

function openFacMenu(f) {
  menuFor = { type: 'fac', id: f.id };
  const acts = Sim.facilityActions(f.id);
  const m = $('#menu');
  m.innerHTML = `<h3>${f.icon} ${f.name}</h3>`;
  if (!acts.length) m.innerHTML += '<div class="sub2">ここでできることはない。</div>';
  acts.forEach((a, i) => {
    const b = document.createElement('button');
    b.innerHTML = `<span class="k">${i + 1}</span>${a.label}`;
    b.disabled = !!a.disabled;
    if (/盗み|爆破/.test(a.label)) b.className = 'danger';
    b.onclick = () => { closeMenu(); if (a.id === 'report') openPicker(); else Sim.doFacility(f.id, a.id); };
    m.appendChild(b);
  });
  m.hidden = false;
}

function openBoardMenu() {
  menuFor = { type: 'board', id: 'board' };
  const m = $('#menu');
  m.innerHTML = '<h3>📋 広場の掲示板</h3>';
  const acts = [
    { label: '掲示板を読む・書き込む', fn: () => switchTab('board') },
    { label: Wolf.meetingActive() ? '話し合いはもう呼びかけられている' : '📣 広場での話し合いを呼びかける（1時間後）', fn: () => Wolf.scheduleMeeting('player', 60, 'player'), disabled: Wolf.meetingActive() },
  ];
  acts.forEach((a, i) => {
    const b = document.createElement('button');
    b.innerHTML = `<span class="k">${i + 1}</span>${a.label}`;
    b.disabled = !!a.disabled;
    b.onclick = () => { closeMenu(); a.fn(); };
    m.appendChild(b);
  });
  m.hidden = false;
}

function closeMenu() {
  menuFor = null; $('#menu').hidden = true;
  if (!chatTarget) S.holdId = null;
}

// ---------- 会話 ----------
const SUGGEST = ['こんにちは', '何してるの？', '何かあった？', '食堂に行こうよ', '酒場で一杯どう？', '食べ物売って', '雇ってください', 'ついてきて'];

function openChat(t) {
  chatTarget = t;
  S.holdId = t.id;
  S.paused = true;
  $('#chat').hidden = false;
  $('#chat-name').textContent = t.name + `（${JOBS[t.job].name}）`;
  $('#chat-log').innerHTML = '';
  for (const h of t.chatLog.slice(-10)) addMsg(h.who === 'player' ? 'me' : 'them', h.text);
  if (!t.chatLog.length) addMsg('sys', `${t.name}に話しかけた。`);
  $('#chat-note').textContent = LLM.available()
    ? 'AIが口調をつけて返事します。誘う・頼む・渡す・売り買い・噂を吹き込む…なんでもどうぞ。'
    : '例：「3Gあげるから一緒に来て」「花束どうぞ」「〇〇ってどんな人？」「研究所はどこ？」「おごるよ」';
  const chips = $('#chat-chips');
  chips.innerHTML = '';
  for (const s of SUGGEST) {
    const b = document.createElement('button');
    b.textContent = s;
    b.onclick = () => { $('#chat-text').value = s; sendChat(); };
    chips.appendChild(b);
  }
  renderTradeBar();
  updateChatRel();
  setTimeout(() => $('#chat-text').focus(), 50);
}

// 会話中に渡せる物
function renderTradeBar() {
  const t = chatTarget;
  const p = S.player;
  const bar = $('#chat-trade');
  bar.innerHTML = '<span class="lbl">渡す：</span>';
  const add = (label, g, disabled) => {
    const b = document.createElement('button');
    b.textContent = label; b.disabled = disabled;
    b.onclick = () => giveInChat(t, g, label);
    bar.appendChild(b);
  };
  add('💰1G', { coins: 1 }, p.coins < 1);
  add('💰3G', { coins: 3 }, p.coins < 3);
  add('💰10G', { coins: 10 }, p.coins < 10);
  add(`🍞食料(${p.food})`, { item: 'food' }, p.food < 1);
  for (const it of [...new Set(p.items)]) if (it !== 'weapon') add(`${ITEMS[it].icon}${ITEMS[it].name}`, { item: it }, false);
}

function giveInChat(t, g, label) {
  if (chatBusy || chatTarget !== t) return;
  const res = Sim.giveToNpc(t, g);
  if (res.react === 'none') return;
  addMsg('sys', `（${t.name}に${res.label}を渡した）`);
  const line = Brain.giftLine(t, res);
  t.chatLog.push({ who: 'player', text: `（${res.label}を渡した）` }, { who: 'them', text: line });
  addMsg('them', line);
  if (res.like >= 3) addMsg('sys', `（${t.name}の好感度が${res.like >= 15 ? 'ぐっと' : ''}上がった）`);
  if (res.react === 'bribe') addMsg('sys', '🚨 手配が取り消された');
  renderTradeBar();
  updateChatRel();
}

function updateChatRel() {
  if (!chatTarget) return;
  const r = rel(chatTarget, S.player);
  $('#chat-rel').textContent = `好感度 ${Math.round(r.like)} ／ 恐怖 ${Math.round(r.fear)} ／ 所持金 ${Math.floor(S.player.coins)}G`;
}

function addMsg(cls, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + cls; d.textContent = text;
  $('#chat-log').appendChild(d);
  $('#chat-log').scrollTop = 1e9;
  return d;
}

let chatBusy = false;
async function sendChat() {
  const t = chatTarget;
  const text = $('#chat-text').value.trim();
  if (!t || !text || chatBusy) return;
  chatBusy = true;
  $('#chat-text').value = '';
  addMsg('me', text);
  const typingEl = addMsg('them typing', '…');
  let r;
  try { r = await Brain.talk(t, text, t.chatLog); } catch (e) { console.error(e); r = { say: '……？', action: 'none', like: 0 }; }
  typingEl.remove();
  if (chatTarget !== t) { chatBusy = false; return; }
  t.chatLog.push({ who: 'player', text }, { who: 'them', text: r.say });
  if (t.chatLog.length > 20) t.chatLog.splice(0, 2);
  addMsg('them', r.say);
  const out = Sim.applyTalkResult(t, r);
  renderTradeBar();
  for (const m of out.msgs) { addMsg('sys', m); toast(m); }
  if (r.like >= 3) addMsg('sys', `（${t.name}の好感度が上がった）`);
  if (r.like <= -5) addMsg('sys', `（${t.name}の好感度が下がった）`);
  if (r.belief) addMsg('sys', `（${t.name}の${r.belief.target}への見方が${r.belief.like < 0 ? '悪く' : '良く'}なったようだ）`);
  updateChatRel();
  chatBusy = false;
  if (out.attack) { addMsg('sys', `${t.name}が殴りかかってきた！`); setTimeout(() => { closeChat(); Sim.interact(t, S.player, 'attack'); }, 900); return; }
  if (out.flee) { addMsg('sys', `${t.name}は立ち去った。`); setTimeout(closeChat, 900); return; }
  if (out.close) setTimeout(() => { if (chatTarget === t) closeChat(); }, 1300);
}

function closeChat() {
  if (chatTarget && chatTarget.chatLog.length) {
    const last = chatTarget.chatLog[chatTarget.chatLog.length - 1];
    if (last.who === 'them') chatTarget.bubble = { text: last.text, until: performance.now() + 2500 };
  }
  chatTarget = null; S.holdId = null; $('#chat').hidden = true; S.paused = $('#speed .on')?.dataset.speed === '0';
}

$('#chat-send').onclick = sendChat;
$('#chat-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendChat(); } });
$('#chat-close').onclick = closeChat;

// ---------- 通報 ----------
function openPicker() {
  $('#picker').hidden = false;
  const list = $('#picker-list');
  list.innerHTML = '';
  for (const c of residents().filter((c) => c.alive && !isJailed(c))) {
    const b = document.createElement('button');
    b.textContent = `${c.name}（${JOBS[c.job].name}）`;
    b.onclick = () => { closePicker(); Sim.reportResident(c); };
    list.appendChild(b);
  }
}
function closePicker() { $('#picker').hidden = true; }
$('#picker-close').onclick = closePicker;

// ---------- サイドバー ----------
// パネルは全部表示されているので、キーで呼ばれたら枠を光らせるだけ
function switchTab(tab) {
  currentTab = tab;
  const el = $('#tab-' + tab)?.closest('.panel');
  if (el) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 900); }
  if (tab === 'board') { boardSig = ''; $('#post-text').focus(); }
  updateUI();
}

document.querySelectorAll('#speed button').forEach((b) => b.onclick = () => setSpeed(+b.dataset.speed));
function setSpeed(v) {
  document.querySelectorAll('#speed button').forEach((b) => b.classList.toggle('on', +b.dataset.speed === v));
  if (v === 0) S.paused = true; else { S.paused = false; S.speed = v; }
}

$('#post-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#post-btn').click(); $('#post-text').blur(); }
});
$('#post-btn').onclick = () => {
  const text = $('#post-text').value.trim();
  if (!text) return;
  Sim.playerPost(text);
  $('#post-text').value = '';
  lastBoardSeen = S.postSeq; boardSig = '';
  updateUI();
};

const meter = (v, max, color) => `<div class="meter"><i style="width:${clamp(v / max * 100, 0, 100)}%;background:${color}"></i></div>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function whereText() {
  const [x, y] = playerTile();
  const f = facAt(x, y);
  if (f) return f.name + (roofedFacAt(x, y) || f.kind === 'field' ? '' : 'の入口');
  if (x >= PLAZA.x && x < PLAZA.x + PLAZA.w && y >= PLAZA.y && y < PLAZA.y + PLAZA.h) return '広場';
  return '町の通り';
}

let boardSig = '';
function updateUI() {
  const p = S.player;
  if (!p) return;
  $('#hud').innerHTML = `<b>${day()}日目</b> ${timeStr()}　残り${Math.max(0, LAST_DAY - day())}日　📍${whereText()}${aiLoad != null ? `　🧠AI切替中 ${aiLoad}%` : ''}${S.paused && !chatTarget ? '　⏸ 一時停止中' : ''}${S.droughtUntilDay >= day() ? '　☀️日照り' : ''}`;

  const n = nearestThing();
  let hint = '';
  if (!menuFor && !Sim.playerBusy() && n) {
    hint = n.type === 'char' ? `F：${n.target.name}と話す・行動` : n.type === 'fac' ? `F：${n.target.name}でできること` : n.type === 'board' ? 'F：掲示板（話し合いの呼びかけ）' : 'F：光る石を拾う';
  }
  const followers = S.chars.filter((c) => c.companion);
  if (followers.length) hint += (hint ? '　' : '') + `🤝 ${followers.map((c) => c.name).join('・')}が同行中`;
  $('#hint').textContent = hint;
  const busyEl = $('#busy');
  if (p.alive && Sim.playerBusy()) {
    busyEl.hidden = false;
    const A = { sleep: '💤 眠っている…', research: '🔬 研究中…', work: '⚒️ 働いている…', train: '💪 鍛えている…', eat: '🍴 食事中…', drink: '🍺 飲んでいる…', heal: '🩹 治療中…' };
    busyEl.textContent = isJailed(p) ? '🔒 牢屋の中…（時間が早く進みます）' : A[p.activity] || '…';
  } else busyEl.hidden = true;


  const bn = $('#banner');
  if (S.banner && performance.now() < S.banner.until) {
    if (bn.hidden || bn._t !== S.banner.title) { bn.innerHTML = `<b>${esc(S.banner.title)}</b><div>${esc(S.banner.text)}</div>`; bn._t = S.banner.title; }
    bn.hidden = false;
  } else bn.hidden = true;
  renderStatus();
  renderItems();
  renderPeople();
  renderBoard();
  renderLog();
  renderNotes();
  updateNearCard(n);
  updateCallout();
  updateMeetingPanel();
  if (chatTarget) updateChatRel();
}

function renderStatus() {
  const p = S.player;
  const inf = Sim.influence('player');
  const items = p.items.map((i) => `<span>${ITEMS[i].icon}${ITEMS[i].name}${i === 'elixir' ? ' <button data-use="elixir">使う</button>' : ''}</span>`).join('') || '<span>なし</span>';
  $('#tab-status').innerHTML = `
    <div class="stat"><div class="lbl"><span>体力</span><span>${Math.round(p.hp)}</span></div>${meter(p.hp, 100, '#e05050')}</div>
    <div class="stat"><div class="lbl"><span>満腹度</span><span>${Math.round(p.hunger)}</span></div>${meter(p.hunger, 100, '#e0a040')}</div>
    <div class="grid2">
      <div>所持金：<b>${Math.floor(p.coins)}G</b></div><div>食料：<b>${p.food}</b></div>
      <div>腕力：<b>${(p.str + (p.items.includes('weapon') ? 8 : 0)).toFixed(1)}</b></div><div>職業：<b>${JOBS[p.job].name}</b></div>
    </div>
    ${S.wanted.has('player') ? '<div class="wanted">🚨 衛兵に手配されている！</div>' : ''}
    <div class="box"><h4>町での立場：${Sim.titleFor(inf)}</h4>
      影響力 ${Math.round(inf.ratio * 100)}%（支持 ${inf.sup}人 ／ 恐怖 ${inf.fear}人 ／ 住民 ${inf.total}人）
      ${meter(inf.ratio * 100, 100, '#c8902a')}
    </div>
    <div class="box"><h4>町の様子</h4>
      食料の蓄え：${Math.floor(S.foodStock)}食分<br>
      住民：${residents().filter((c) => c.alive).length}人（牢屋 ${residents().filter((c) => c.alive && isJailed(c)).length}人）<br>
      事件：${S.stats.crimes}件 ／ 死者：${S.stats.deaths}人 ／ 逮捕：${S.stats.arrests}件
      ${S.meteor ? `<br>光る石：${S.meteor.state === 'ground' ? '地面に落ちている' : S.meteor.state === 'done' ? ITEMS[S.meteor.result].name + 'だった' : '誰かが持っている'}` : ''}
    </div>
    <div class="box"><h4>🏛️ 町の決まり</h4>
      ${Town.rulesText().join('／')}<br>
      町の金庫：${Math.floor(S.treasury)}G${S.bounty ? `　人狼の懸賞金：${S.bounty}G` : ''}
      ${S.taxDebt.player ? `<br><span class="wanted">税金の滞納：${S.taxDebt.player}G（役場で払える）</span>` : ''}
      ${Wolf.meetingActive() ? `<br>📣 ${Math.floor((S.meeting.at % 1440) / 60)}時から広場で話し合い${S.meeting.agenda.length ? `（議題：${S.meeting.agenda.map((a) => Town.describe(a.rule)).join('、')}）` : ''}` : ''}
    </div>
    `;
  const ub = $('#tab-status [data-use]');
  if (ub) ub.onclick = () => Sim.useItem(S.player, ub.dataset.use);
}

function renderItems() {
  const p = S.player;
  const row = (icon, name, desc, btn = '') => `<div class="inv"><div class="ic">${icon}</div><div class="nm"><b>${name}</b><small>${desc}</small></div>${btn}</div>`;
  let html = '<div class="box">';
  html += row('💰', `所持金 ${Math.floor(p.coins)}G`, `家のタンス：${Math.floor(p.bank || 0)}G（家で出し入れ）`);
  html += row('🍞', `食料 ×${p.food}`, '食べると満腹度+30。人に渡すと喜ばれる。', p.food ? '<button data-act="eat">食べる</button>' : '');
  const counts = {};
  for (const it of p.items) counts[it] = (counts[it] || 0) + 1;
  for (const [k, n] of Object.entries(counts)) {
    const it = ITEMS[k];
    html += row(it.icon, `${it.name}${n > 1 ? ' ×' + n : ''}`, it.desc, k === 'elixir' ? '<button data-act="elixir">使う</button>' : '');
  }
  if (!p.items.length) html += '<div class="sub3">アイテムは持っていない。市場で花束・焼き菓子・古い本、酒場で酒瓶が買える。</div>';
  html += '</div><div class="box keys2">住民に話しかけて、会話画面の「渡す」ボタンか「〇〇あげる」と入力すると渡せます。好きな物をもらうと住民はとても喜びます（住民タブで好物がわかる）。</div>';
  if ($('#tab-items')._h !== html) {
    $('#tab-items').innerHTML = html; $('#tab-items')._h = html;
    $('#tab-items').querySelectorAll('[data-act]').forEach((b) => b.onclick = () => {
      if (b.dataset.act === 'eat') Sim.eatOwnFood(); else Sim.useItem(S.player, 'elixir');
      updateUI();
    });
  }
}

function renderPeople() {
  const p = S.player;
  const list = residents().slice().sort((a, b) => (b.alive - a.alive) || (b.key - a.key));
  $('#tab-people').innerHTML = list.map((c) => {
    const r = rel(c, p);
    const st = c.undiscovered ? '' : !c.alive ? (c.killedBy ? '🐺🪦' : '🪦') : isJailed(c) ? `🔒${Sim.jailText(c)}` : S.wanted.has(c.id) ? '🚨' : c.companion ? '🤝' : c.activity === 'sleep' ? '💤' : '';
    const likeW = Math.abs(r.like);
    const detail = expanded === c.id ? `<div class="detail">
      ${c.persona ? esc(c.persona) + '<br>' : ''}
      好きなもの：${esc(c.likes || '')}${c.likesItem ? `（贈り物なら${ITEMS[c.likesItem].icon}${ITEMS[c.likesItem].name}）` : ''}<br>
      いる場所：${c.alive ? esc(Brain.locName(c)) : '―'}<br>
      ${c.intent?.thought ? `今日の心の声：「${esc(c.intent.thought)}」<br>` : ''}
      体力${Math.round(c.hp)} 満腹${Math.round(c.hunger)} 所持金${Math.floor(c.coins)}G
      ${c.items.length ? '<br>持ち物：' + c.items.map((i) => ITEMS[i].name).join('、') : ''}
      <br>記憶：${c.memory.slice(-3).map(esc).join(' / ') || 'なし'}
    </div>` : '';
    return `<div class="person ${c.alive || c.undiscovered ? '' : 'dead'}" data-id="${c.id}">
      <div class="top"><span>${c.name} <small>${JOBS[c.job].icon}${JOBS[c.job].name}</small></span><span>${st}</span></div>
      <div class="relbar">好感<div class="meter"><i style="width:${likeW}%;background:${r.like >= 0 ? '#6ac060' : '#d05050'}"></i></div>${Math.round(r.like)}
      　恐怖<div class="meter"><i style="width:${r.fear}%;background:#a070d0"></i></div>${Math.round(r.fear)}</div>
      ${detail}</div>`;
  }).join('');
  $('#tab-people').querySelectorAll('.person').forEach((el) => el.onclick = () => { expanded = expanded === el.dataset.id ? null : el.dataset.id; renderPeople(); });
}

function renderBoard() {
  const sig = S.board.length + ':' + S.board.reduce((a, p) => a + p.replies.length, 0) + ':' + S.postSeq;
  if (sig === boardSig) return;
  boardSig = sig;
  lastBoardSeen = S.postSeq;
  $('#board-list').innerHTML = S.board.map((p) => `
    <div class="post ${p.authorId === 'town' ? 'town' : p.authorId === 'player' ? 'mine' : ''}">
      <div class="meta"><span class="author">${esc(p.author)}</span><span>${p.day}日目 ${p.time}</span></div>
      <div class="text">${esc(p.text)}</div>
      ${p.replies.map((r) => `<div class="reply"><b>${esc(r.author)}</b>：${esc(r.text)}</div>`).join('')}
    </div>`).join('');
}

// 近くの住民の情報（近づくだけで見える）
function updateNearCard(n) {
  const el = $('#nearcard');
  const p = S.player;
  const c = n?.type === 'char' ? n.target : S.chars.filter((o) => o !== p && o.alive && !isJailed(o) && distTiles(p, o) <= 3 && Sim.canSee(p, o))
    .sort((a, b) => distTiles(p, a) - distTiles(p, b))[0];
  if (!c || chatTarget || $('#meeting').hidden === false) { el.hidden = true; return; }
  const r = rel(c, p);
  const likeCol = r.like >= 0 ? '#6ac060' : '#d05050';
  const feel = r.like >= 50 ? '大好き' : r.like >= 20 ? '好意的' : r.like > -15 ? 'ふつう' : r.like > -45 ? '警戒' : '嫌い';
  const html = `<b>${esc(c.name)}</b> <small>${JOBS[c.job].icon}${JOBS[c.job].name}</small>
    <div class="row"><span>好感</span>${meter(Math.abs(r.like), 100, likeCol)}<span>${Math.round(r.like)}（${feel}）</span></div>
    <div class="row"><span>恐怖</span>${meter(r.fear, 100, '#a070d0')}<span>${Math.round(r.fear)}</span></div>
    <div>いま：${isJailed(c) ? `🔒 牢屋の中（${Sim.jailText(c)}）` : esc(Brain.actText(c))}</div>
    ${c.likesItem ? `<div>好物：${ITEMS[c.likesItem].icon}${ITEMS[c.likesItem].name}</div>` : ''}
    ${c.quest ? `<div>📝 頼まれごと：${esc(c.quest.label)}を届ける</div>` : ''}
    ${c.companion ? '<div>🤝 あなたと同行中</div>' : ''}`;
  if (el._h !== html) { el.innerHTML = html; el._h = html; }
  el.hidden = false;
}

function updateCallout() {
  const el = $('#callout');
  const co = S.callout;
  if (co && performance.now() > co.until) {
    const c = S.chars.find((x) => x.id === co.id);
    if (c && c.alive && !chatTarget) { c.busyUntil = S.t; if (c.activity === 'wait') c.activity = null; say(c, pick2(['……まあ、いいや。', '……忙しそうだね。'])); }
    S.callout = null;
  }
  if (S.callout && !chatTarget) {
    const c = S.chars.find((x) => x.id === S.callout.id);
    const html = `<b>${esc(c?.name || '')}</b>「${esc(S.callout.text)}」<span class="k">F：返事をする</span>`;
    if (el._h !== html) { el.innerHTML = html; el._h = html; }
    el.hidden = false;
  } else el.hidden = true;
}
const pick2 = (a) => a[Math.floor(Math.random() * a.length)];

// ---------- 話し合い ----------
let meetingSig = '';
function updateMeetingPanel() {
  const m = S.meeting;
  const el = $('#meeting');
  const show = m && (m.playerIn && ['talking', 'voting'].includes(m.state) || (m.state === 'done' && m.playerIn && !m.closed));
  if (!show) { el.hidden = true; return; }
  el.hidden = false;
  const sig = m.state + ':' + m.log.length;
  if (sig === meetingSig) return;
  meetingSig = sig;
  const present = m.present.map((id) => S.chars.find((c) => c.id === id)).filter(Boolean);
  $('#meeting-head').textContent = `📣 広場の話し合い（${present.length}人参加）`;
  $('#meeting-log').innerHTML = m.log.map((l) => `<div class="ml ${l.cls}">${l.who ? `<b>${esc(l.who)}</b>` : ''}${esc(l.text)}</div>`).join('');
  $('#meeting-log').scrollTop = 1e9;
  const ctrl = $('#meeting-ctrl');
  if (m.state === 'talking') {
    ctrl.innerHTML = `<div class="row"><input id="meeting-text" placeholder="発言する（例：ゴウが夜中に出歩いてるのを見た／ハルは人狼じゃない）" maxlength="60"><button id="meeting-say">言う</button></div>
      <div class="row"><button id="meeting-vote">投票に進む</button><button id="meeting-leave" class="ghost">その場を離れる</button></div>`;
    const sayIt = () => { const v = $('#meeting-text').value.trim(); if (v) { Wolf.playerSpeak(v); $('#meeting-text').value = ''; meetingSig = ''; } };
    $('#meeting-say').onclick = sayIt;
    $('#meeting-text').onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sayIt(); } };
    $('#meeting-vote').onclick = () => { Wolf.startVoteNow(); meetingSig = ''; };
    $('#meeting-leave').onclick = () => { Wolf.leaveMeeting(); meetingSig = ''; };
  } else if (m.state === 'voting') {
    const cands = Wolf.voteCandidates().filter((c) => !c.isPlayer);
    ctrl.innerHTML = '<div class="sub2">誰を牢屋に入れる？（あなたの一票）</div><div class="votes">' +
      cands.map((c) => `<button data-v="${c.id}">${esc(c.name)}</button>`).join('') + '<button data-v="abstain" class="ghost">棄権</button></div>';
    ctrl.querySelectorAll('[data-v]').forEach((b) => b.onclick = () => { Wolf.vote(b.dataset.v); meetingSig = ''; });
  } else {
    ctrl.innerHTML = '<button id="meeting-close">閉じる</button>';
    $('#meeting-close').onclick = () => { m.closed = true; meetingSig = ''; updateMeetingPanel(); };
  }
}

function renderNotes() {
  const quests = residents().filter((c) => c.alive && c.quest && S.t < c.quest.until);
  const m = S.meeting;
  let html = '';
  if (m && m.state === 'planned') html += `<div class="box"><h4>📣 予定</h4>${Math.floor((m.at % 1440) / 60)}時に広場で話し合い</div>`;
  if (quests.length) html += '<div class="box"><h4>📝 頼まれごと</h4>' + quests.map((c) => `${esc(c.name)}に<b>${esc(c.quest.label)}</b>を届ける（お礼${c.quest.reward}G）`).join('<br>') + '</div>';
  html += '<div class="box"><h4>📓 手帳（見聞きしたこと）</h4>' + (S.notes.length ? S.notes.map((n) => `<div class="logline"><span class="tm">${n.day}日目 ${n.time}</span>${esc(n.text)}</div>`).join('')
    : '<div class="sub3">まだ何も書いていない。住民の証言や現場の手がかりがここにたまっていく。</div>') + '</div>';
  html += '<div class="box keys2">聞き込みのコツ：「昨日の夜どこにいた？」「人狼は誰だと思う？」「〇〇は昨日の夜どこにいた？」「〇〇が人狼だと思う」「話し合おう」</div>';
  if ($('#tab-notes')._h !== html) { $('#tab-notes').innerHTML = html; $('#tab-notes')._h = html; }
}

let logSig = '';
function renderLog() {
  const sig = S.log.length + ':' + (S.log[0]?.text || '');
  if (sig === logSig) return;
  logSig = sig;
  $('#tab-log').innerHTML = S.log.slice(0, 120).map((l) => `<div class="logline ${l.kind}"><span class="tm">${l.day}日目 ${l.time}</span>${esc(l.text)}</div>`).join('');
}

function updateToasts() {
  const now = performance.now();
  S.toasts = S.toasts.filter((t) => t.until > now).slice(-4);
  const el = $('#toasts');
  const html = S.toasts.map((t) => `<div class="toast">${esc(t.text)}</div>`).join('');
  if (el._h !== html) { el.innerHTML = html; el._h = html; }
}

// ---------- 結果 ----------
function showResult() {
  const p = S.player;
  const alive = residents().filter((c) => c.alive).length;
  const total = residents().length;
  const inf = Sim.influence('player');
  const st = S.stats;
  let verdict;
  if (!p.alive) verdict = 'あなたの物語はここで終わった';
  else if (alive <= total * 0.5) verdict = '崩壊した町';
  else if (st.crimes >= 60) verdict = '無法の町';
  else if (st.crimes <= 10 && st.deaths === 0) verdict = '平和な町';
  else if (inf.ratio >= 0.5) verdict = inf.fear > inf.sup ? 'あなたが恐怖で支配する町' : 'あなたを慕う町';
  else verdict = 'ふつうの町';
  if (S.wolf?.confirmed && p.alive) verdict = S.wolf.playerAccused.has(S.wolf.id) ? 'あなたが人狼を暴いた町' : '人狼を退けた町';
  else if (S.wolf && S.wolf.kills.length >= 4) verdict = '人狼に怯え続けた町';
  $('#result-box').innerHTML = `
    <h2>${p.alive ? `${LAST_DAY}日間が過ぎた` : 'ゲームオーバー'}</h2>
    ${S.gameOverReason ? `<p>${esc(S.gameOverReason)}</p>` : ''}
    <div class="big-title">「${verdict}」</div>
    <p>あなたの立場：<b>${Sim.titleFor(inf)}</b>（影響力 ${Math.round(inf.ratio * 100)}%）</p>
    <p class="wolf-reveal">🐺 人狼の正体は <b>${esc(Wolf.wolfChar()?.name || '?')}</b> でした。${S.wolf?.confirmed ? '町は人狼を突き止めた！' : '人狼は最後まで正体を隠し通した……'}（犠牲者 ${S.wolf?.kills.length || 0}人）</p>
    <table>
      <tr><td>生き残った住民</td><td>${alive} / ${total}人</td></tr>
      <tr><td>事件の数</td><td>${st.crimes}件</td></tr>
      <tr><td>うち盗み</td><td>${st.thefts}件</td></tr>
      <tr><td>けんか</td><td>${st.fights}件</td></tr>
      <tr><td>逮捕</td><td>${st.arrests}件</td></tr>
      <tr><td>袖の下</td><td>${st.bribes}件</td></tr>
      <tr><td>亡くなった人</td><td>${st.deaths}人</td></tr>
      <tr><td>あなたの所持金</td><td>${Math.floor(p.coins)}G</td></tr>
    </table>
    <button class="big" id="again">もう一度</button>`;
  $('#result').hidden = false;
  $('#again').onclick = () => { $('#result').hidden = true; S.gameOverReason = null; startGame(); };
}

// デバッグ用
window.NW = { S, Sim, Brain, view };
void FACILITIES;
