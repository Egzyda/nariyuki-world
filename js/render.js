// 描画（素材なし・図形だけで描く）
import { TILE, MAP_W, MAP_H, FACILITIES, BOARD_POS, JOBS } from './data.js';
import { roads } from './world.js';
import { S, hour, isJailed } from './state.js';

let mapCache = null;

function buildMapCache() {
  const c = document.createElement('canvas');
  c.width = MAP_W * TILE; c.height = MAP_H * TILE;
  const g = c.getContext('2d');
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    const edge = x === 0 || y === 0 || x === MAP_W - 1 || y === MAP_H - 1;
    g.fillStyle = edge ? '#2f5a2a' : ((x + y) % 2 ? '#5f8f48' : '#5a8a44');
    g.fillRect(x * TILE, y * TILE, TILE, TILE);
    if (!edge && !roads.has(x + ',' + y) && (x * 7 + y * 13) % 17 === 0) {
      g.fillStyle = '#6fa055'; g.fillRect(x * TILE + 8, y * TILE + 12, 3, 6); g.fillRect(x * TILE + 14, y * TILE + 9, 3, 8);
    }
    if (edge && (x + y) % 3 === 0) { g.fillStyle = '#244a20'; g.beginPath(); g.arc(x * TILE + 16, y * TILE + 16, 13, 0, 7); g.fill(); }
  }
  // 広場
  g.fillStyle = '#b9ab8c';
  g.fillRect(18 * TILE, 13 * TILE, 9 * TILE, 7 * TILE);
  g.strokeStyle = '#a89a7a';
  for (let y = 13; y < 20; y++) for (let x = 18; x < 27; x++) g.strokeRect(x * TILE + 0.5, y * TILE + 0.5, TILE - 1, TILE - 1);
  for (const k of roads) {
    const [x, y] = k.split(',').map(Number);
    if (x >= 18 && x < 27 && y >= 13 && y < 20) continue;
    g.fillStyle = '#c9b68c'; g.fillRect(x * TILE, y * TILE, TILE, TILE);
    g.fillStyle = '#bba679'; g.fillRect(x * TILE + 4, y * TILE + 6, 3, 3); g.fillRect(x * TILE + 20, y * TILE + 20, 3, 3);
  }
  // 噴水
  g.fillStyle = '#8a8a8a'; g.beginPath(); g.arc(22.5 * TILE, 18.5 * TILE, 20, 0, 7); g.fill();
  g.fillStyle = '#6aa8d8'; g.beginPath(); g.arc(22.5 * TILE, 18.5 * TILE, 15, 0, 7); g.fill();
  mapCache = c;
}

export function draw(ctx, w, h) {
  if (!mapCache) buildMapCache();
  const p = S.player;
  const camX = Math.max(0, Math.min(MAP_W * TILE - w, p.x - w / 2));
  const camY = Math.max(0, Math.min(MAP_H * TILE - h, p.y - h / 2));
  const ox = MAP_W * TILE < w ? (w - MAP_W * TILE) / 2 : -camX;
  const oy = MAP_H * TILE < h ? (h - MAP_H * TILE) / 2 : -camY;
  ctx.fillStyle = '#1d2a1a'; ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.translate(Math.round(ox), Math.round(oy));
  ctx.drawImage(mapCache, 0, 0);

  // 施設
  for (const f of FACILITIES) drawFacility(ctx, f);
  // 掲示板
  const [bx, by] = BOARD_POS;
  ctx.fillStyle = '#6a4a2a'; ctx.fillRect(bx * TILE + 13, by * TILE + 14, 6, 18);
  ctx.fillStyle = '#8a6a3a'; ctx.fillRect(bx * TILE + 1, by * TILE + 2, 30, 18);
  ctx.fillStyle = '#f4ecd8'; ctx.fillRect(bx * TILE + 4, by * TILE + 4, 10, 7); ctx.fillRect(bx * TILE + 17, by * TILE + 5, 11, 9); ctx.fillRect(bx * TILE + 6, by * TILE + 12, 8, 6);
  label(ctx, '掲示板', bx * TILE + 16, by * TILE - 2, 11);

  // 隕石
  const m = S.meteor;
  if (m && m.state === 'ground') {
    const cx = m.tx * TILE + 16, cy = m.ty * TILE + 16;
    ctx.fillStyle = 'rgba(40,30,30,0.6)'; ctx.beginPath(); ctx.ellipse(cx, cy + 4, 18, 10, 0, 0, 7); ctx.fill();
    const glow = 0.6 + Math.sin(performance.now() / 200) * 0.3;
    ctx.fillStyle = `rgba(120,255,220,${glow * 0.4})`; ctx.beginPath(); ctx.arc(cx, cy, 16, 0, 7); ctx.fill();
    ctx.font = '20px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('💎', cx, cy);
  }

  // 墓
  for (const c of S.chars) if (!c.alive && !c.isPlayer) { ctx.font = '18px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('🪦', c.x, c.y); }

  // キャラ
  const list = S.chars.filter((c) => c.alive).sort((a, b) => a.y - b.y);
  for (const c of list) drawChar(ctx, c);
  for (const c of list) drawBubble(ctx, c);

  // 演出
  for (const e of S.effects) if (e.type === 'hit') {
    ctx.font = '22px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('💥', e.x, e.y - 12 - (0.5 - e.t) * 30);
  }
  ctx.restore();

  // 夜
  const hr = hour() + (S.t % 60) / 60;
  let dark = 0;
  if (hr >= 19) dark = Math.min(0.55, (hr - 19) * 0.18);
  else if (hr < 6) dark = 0.55;
  else if (hr < 7) dark = 0.55 * (7 - hr);
  if (dark > 0) { ctx.fillStyle = `rgba(10,15,45,${dark})`; ctx.fillRect(0, 0, w, h); }
  if (S.droughtUntilDay >= Math.floor(S.t / 1440) + 1) { ctx.fillStyle = 'rgba(255,170,60,0.08)'; ctx.fillRect(0, 0, w, h); }
  for (const e of S.effects) if (e.type === 'flash') { ctx.fillStyle = `rgba(${e.color || '255,255,255'},${Math.min(1, e.t)})`; ctx.fillRect(0, 0, w, h); }
}

function drawFacility(ctx, f) {
  const x = f.x * TILE, y = f.y * TILE, w = f.w * TILE, h = f.h * TILE;
  const closed = S.fac[f.id] && S.fac[f.id].closedUntilDay >= Math.floor(S.t / 1440) + 1;
  if (f.id === 'farm') {
    ctx.fillStyle = '#7a5a30'; ctx.fillRect(x, y, w, h);
    const dry = S.droughtUntilDay >= Math.floor(S.t / 1440) + 1;
    for (let i = 0; i < f.h * 2 - 1; i++) {
      ctx.fillStyle = '#5e4424'; ctx.fillRect(x + 6, y + 6 + i * 16, w - 12, 5);
      for (let j = 0; j < f.w * 2 - 1; j++) { ctx.fillStyle = dry ? '#b0a040' : '#6fae3a'; ctx.fillRect(x + 10 + j * 16, y + 2 + i * 16, 6, 6); }
    }
    ctx.strokeStyle = '#4a3418'; ctx.lineWidth = 3; ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3); ctx.lineWidth = 1;
  } else {
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(x + 4, y + 6, w, h);
    ctx.fillStyle = f.color; ctx.fillRect(x, y + 18, w, h - 18);
    ctx.fillStyle = f.roof; ctx.fillRect(x - 2, y, w + 4, 24);
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(x - 2, y, w + 4, 5);
    // 窓
    ctx.fillStyle = hour() >= 18 || hour() < 6 ? '#ffd970' : '#cfe6f5';
    for (let i = 0; i < f.w - 1; i += 2) ctx.fillRect(x + 10 + i * TILE, y + 34, 14, 12);
  }
  const [dx, dy] = f.door;
  ctx.fillStyle = '#3a2614'; ctx.fillRect(dx * TILE + 8, (dy - 1) * TILE + 12, 16, 20);
  ctx.font = '18px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(f.icon, x + w / 2, y + h / 2 + (f.id === 'farm' ? 0 : 4));
  label(ctx, f.name, x + w / 2, y + (f.id === 'farm' ? 14 : 13), 12);
  if (closed) {
    ctx.fillStyle = 'rgba(30,20,20,0.6)'; ctx.fillRect(x, y, w, h);
    ctx.font = '22px sans-serif'; ctx.fillText('🔥', x + w / 2, y + h / 2);
    label(ctx, '使用不可', x + w / 2, y + h - 8, 11);
  }
}

function label(ctx, text, x, y, size) {
  ctx.font = `bold ${size}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.strokeText(text, x, y);
  ctx.fillStyle = '#fff'; ctx.fillText(text, x, y);
}

function drawChar(ctx, c) {
  const jailed = isJailed(c);
  if (jailed) { ctx.globalAlpha = 0.5; }
  const sleeping = c.activity === 'sleep' && S.t < c.busyUntil;
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(c.x, c.y + 11, 10, 4, 0, 0, 7); ctx.fill();
  const col = c.isPlayer ? '#ff5a7a' : JOBS[c.job].color;
  ctx.fillStyle = col; ctx.beginPath(); ctx.arc(c.x, c.y, 11, 0, 7); ctx.fill();
  ctx.lineWidth = c.isPlayer ? 3 : 2; ctx.strokeStyle = c.isPlayer ? '#fff' : c.key ? '#ffe070' : '#222'; ctx.stroke(); ctx.lineWidth = 1;
  ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(sleeping ? '💤' : c.isPlayer ? '★' : JOBS[c.job].icon, c.x, c.y + 1);
  if (S.wanted.has(c.id)) { ctx.font = '11px sans-serif'; ctx.fillText('🚨', c.x + 11, c.y - 11); }
  if (c.items.includes('meteor')) { ctx.font = '11px sans-serif'; ctx.fillText('💎', c.x - 11, c.y - 11); }
  if (c.hp < 40) { ctx.fillStyle = '#300'; ctx.fillRect(c.x - 10, c.y + 15, 20, 3); ctx.fillStyle = '#e33'; ctx.fillRect(c.x - 10, c.y + 15, 20 * Math.max(0, c.hp) / 100, 3); }
  label(ctx, c.isPlayer ? 'あなた' : c.name, c.x, c.y + 22, 10);
  if (jailed) { ctx.globalAlpha = 1; ctx.strokeStyle = '#222'; ctx.lineWidth = 2; for (let i = -9; i <= 9; i += 6) { ctx.beginPath(); ctx.moveTo(c.x + i, c.y - 12); ctx.lineTo(c.x + i, c.y + 12); ctx.stroke(); } ctx.lineWidth = 1; }
}

function drawBubble(ctx, c) {
  if (!c.bubble || performance.now() > c.bubble.until) return;
  const text = c.bubble.text.length > 22 ? c.bubble.text.slice(0, 21) + '…' : c.bubble.text;
  ctx.font = '12px sans-serif';
  const tw = ctx.measureText(text).width + 12;
  const bx = c.x - tw / 2, by = c.y - 40;
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  roundRect(ctx, bx, by, tw, 20, 6); ctx.fill();
  ctx.beginPath(); ctx.moveTo(c.x - 4, by + 20); ctx.lineTo(c.x + 4, by + 20); ctx.lineTo(c.x, by + 26); ctx.fill();
  ctx.fillStyle = '#222'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, c.x, by + 10);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

