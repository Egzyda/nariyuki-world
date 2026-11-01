// 画面のボタンやタブに使う線画アイコン（絵文字のかわり）。色は文字色に合わせて変わる。
const P = {
  status: '<circle cx="12" cy="7.5" r="3.8"/><path d="M4.5 20.5c.6-4 3.6-6.3 7.5-6.3s6.9 2.3 7.5 6.3"/>',
  items: '<path d="M5.5 8.5h13l-1 12h-11z"/><path d="M9 8.5V7a3 3 0 0 1 6 0v1.5"/>',
  notes: '<path d="M6 3.5h10.5a2 2 0 0 1 2 2v15H7.5A1.5 1.5 0 0 1 6 19z"/><path d="M6 17.5a1.5 1.5 0 0 1 1.5-1.5h11"/><path d="M10 7.5h5M10 10.5h5"/>',
  people: '<circle cx="9" cy="8" r="3.3"/><path d="M2.8 19.5c.5-3.4 3-5.5 6.2-5.5s5.7 2.1 6.2 5.5"/><circle cx="17" cy="8.8" r="2.5"/><path d="M17.2 13.6c2.3.2 3.8 1.8 4.1 4.4"/>',
  board: '<rect x="3.5" y="4" width="17" height="12.5" rx="1.5"/><path d="M7.5 8.5h9M7.5 12h6"/><path d="M8 16.5l-1.5 4M16 16.5l1.5 4"/>',
  log: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.8" cy="6.5" r="1" fill="currentColor"/><circle cx="4.8" cy="12" r="1" fill="currentColor"/><circle cx="4.8" cy="17.5" r="1" fill="currentColor"/>',
  pause: '<rect x="6.5" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.9" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none"/>',
  play: '<path d="M8 5.2v13.6L19 12z" fill="currentColor" stroke-width="1.5"/>',
  ff: '<path d="M3.5 6.5v11l8-5.5zM12.5 6.5v11l8-5.5z" fill="currentColor" stroke-width="1.2"/>',
  fff: '<path d="M1.5 7.5v9l6-4.5zM9 7.5v9l6-4.5zM16.5 7.5v9l6-4.5z" fill="currentColor" stroke-width="1"/>',
  map: '<path d="M3 6.5l6-2.5 6 2.5 6-2.5v13.5l-6 2.5-6-2.5-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>',
  save: '<path d="M5 3.5h11.5l4 4V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5z"/><path d="M7.5 3.5v5h8v-5"/><rect x="7" y="13" width="10" height="7.5" rx="1"/>',
  home: '<path d="M3.5 11L12 3.8l8.5 7.2"/><path d="M5.8 9.3v11.2h12.4V9.3"/><path d="M10 20.5v-5.5h4v5.5"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z" fill="currentColor"/>',
  bowl: '<path d="M3.5 11.5h17a8.5 7 0 0 1-17 0z" fill="currentColor"/><path d="M9 3.5c-1 1.3 1 2.2 0 3.5M13.5 3.5c-1 1.3 1 2.2 0 3.5"/>',
  coin: '<circle cx="12" cy="12" r="8.5" fill="currentColor"/><path d="M12 7.5v9M14.5 9.3c-.6-.9-1.5-1.3-2.6-1.3-1.5 0-2.5.8-2.5 2s1.2 1.6 2.6 2c1.5.4 2.7.9 2.7 2.2 0 1.2-1.1 2.1-2.7 2.1-1.2 0-2.2-.5-2.8-1.4" stroke="#2a2014" stroke-width="1.6"/>',
  bread: '<path d="M4 11.5c0-3.3 3.6-5.5 8-5.5s8 2.2 8 5.5c0 1.1-.7 1.8-1.5 2V19H5.5v-5.5c-.8-.2-1.5-.9-1.5-2z" fill="currentColor"/>',
  pin: '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  talk: '<path d="M4 5.5h16v10.5H10l-4.5 3.5V16H4z"/>',
  door: '<path d="M6 20.5V4.5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v16"/><path d="M3.5 20.5h17"/><circle cx="14.5" cy="12.5" r="1" fill="currentColor"/>',
  run: '<circle cx="14.5" cy="4.5" r="2"/><path d="M8 21l3-6 3 2.5V21M6 11.5l3.5-3 4 .5 2 3.5 3 1"/><path d="M11 15l1.5-6"/>',
};

export function icon(name, cls = '') {
  const p = P[name];
  if (!p) return '';
  return `<svg class="ic-svg ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

// HTMLの <i data-icon="名前"></i> をアイコンに置き換える
export function fillIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon); el.classList.add('ic'); });
}
