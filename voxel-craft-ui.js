/* voxel-craft-ui.js (v1)
 *  ・スマホの操作ボタン：大きさ・位置を設定から変更（ドラッグで動かせる）。小さい画面では自動で小さめに
 *  ・マルチ・設定などの画面が、下までスクロールできない問題を修正
 *  ・道路・線路を、道路モードに入らなくても、狙った場所をタップ／クリックで部分的に削除
 * 読み込み順： … multi → players → ui（最後）
 */
(function () {
'use strict';

const LAYOUT_KEY = 'voxelcraft_touch_layout_v1';
const DEF = {                       // 本体の初期配置（right / bottom の px）
  btnJump: { r: 14, b: 70 }, btnDown: { r: 14, b: 140 }, btnUp: { r: 14, b: 210 }, btnView: { r: 14, b: 280 },
  btnBreak: { r: 84, b: 70 }, btnPlace: { r: 84, b: 140 }, btnDash: { r: 84, b: 210 }
};
const ERASE_R = 3.0;                // 道路・線路を削除する範囲（m）

// ============================================================
// 1. 画面のスクロール修正（本体の「touch-action: none」を打ち消す）
// ============================================================
const scrollStyle = document.createElement('style');
scrollStyle.textContent = `
  #mpPanel, #wsTitle, #settings, #vcLayoutPanel {
    overflow-y: auto !important; -webkit-overflow-scrolling: touch; overscroll-behavior: contain;
    touch-action: pan-y !important; align-items: flex-start !important;
    padding: 12px 0 !important; box-sizing: border-box;
  }
  #mpPanel .box, #wsTitle .card, #vcLayoutPanel .vcBox {
    margin: auto; touch-action: pan-y; max-height: none !important; overflow: visible !important;
  }
  #settings { touch-action: pan-y !important; }
  .vcPanel { position: fixed; inset: 0; z-index: 85; display: none; align-items: flex-start; justify-content: center;
    background: rgba(5,10,16,.8); }
  .vcPanel.show { display: flex; }
  .vcBox { background: #1b2530; color: #fff; border-radius: 12px; padding: 16px; width: min(94vw, 420px);
    box-sizing: border-box; font: 14px sans-serif; }
  .vcBox h2 { margin: 0 0 10px; font-size: 18px; }
  .vcBox button { display: block; width: 100%; background: #2e6a9a; color: #fff; border: none; border-radius: 8px;
    padding: 10px; font-size: 14px; margin-top: 8px; }
  .vcBox button.sub { background: #3a4450; }
  .vcBox .note { font-size: 12px; color: #9fb3c8; line-height: 1.6; margin: 8px 0 0; }
  .vcBox input[type=range] { width: 100%; margin-top: 8px; }
  #vcDoneBtn { position: fixed; top: 8px; left: 50%; transform: translateX(-50%); z-index: 90; display: none;
    background: #2e7d4f; color: #fff; border: none; border-radius: 8px; padding: 10px 18px; font-size: 15px; }
  #vcLayoutToggle { position: fixed; left: 150px; top: 56px; z-index: 60; background: #2e6a9a; color: #fff; border: none;
    border-radius: 8px; padding: 8px 12px; font-size: 13px; opacity: .9; cursor: pointer; font-family: sans-serif; }
  body.touch .tb { touch-action: auto; }
  body.vcEditing .tb { outline: 2px dashed #ffe066; touch-action: none !important; }
`;
document.head.appendChild(scrollStyle);

// ============================================================
// 2. スマホのボタンの大きさ・位置
// ============================================================
function defaultScale() { return window.innerWidth <= 430 ? 0.8 : 1; }
let layout = loadLayout();
function loadLayout() {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
    if (v && typeof v.scale === 'number') return { scale: v.scale, pos: v.pos || {} };
  } catch (e) {}
  return { scale: defaultScale(), pos: {} };
}
function saveLayout() { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch (e) {} }
function applyLayout() {
  for (const id of Object.keys(DEF)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const p = layout.pos[id] || DEF[id];
    el.style.width = el.style.height = Math.round(58 * layout.scale) + 'px';
    el.style.fontSize = Math.max(8, Math.round(11 * layout.scale)) + 'px';
    el.style.right = p.r + 'px';
    el.style.bottom = p.b + 'px';
  }
}

// 配置を動かすモード（ボタンをドラッグで動かす。動かしている間は操作させない）
let editMode = false;
let drag = null;
function setEditMode(on) {
  editMode = on;
  document.body.classList.toggle('vcEditing', on);
  document.getElementById('vcDoneBtn').style.display = on ? 'block' : 'none';
  document.getElementById('vcEditBtn').textContent = '配置を動かす：' + (on ? 'オン' : 'オフ');
  if (on) closeLayoutPanel();
}
function onDown(e) {
  if (!editMode || !e.target.closest) return;
  const el = e.target.closest('.tb');
  if (!el) return;
  e.stopPropagation(); e.preventDefault();
  const rect = el.getBoundingClientRect();
  drag = { el, dx: e.clientX - rect.left, dy: e.clientY - rect.top };
}
function onMove(e) {
  if (!drag) return;
  e.preventDefault();
  const w = drag.el.offsetWidth, h = drag.el.offsetHeight;
  const x = Math.min(Math.max(0, e.clientX - drag.dx), window.innerWidth - w);
  const y = Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - h);
  drag.el.style.right = (window.innerWidth - x - w) + 'px';
  drag.el.style.bottom = (window.innerHeight - y - h) + 'px';
}
function onUp() {
  if (!drag) return;
  layout.pos[drag.el.id] = { r: Math.round(parseFloat(drag.el.style.right)), b: Math.round(parseFloat(drag.el.style.bottom)) };
  saveLayout();
  drag = null;
}
window.addEventListener('pointerdown', onDown, { capture: true, passive: false });
window.addEventListener('pointermove', onMove, { capture: true, passive: false });
window.addEventListener('pointerup', onUp, { capture: true });
window.addEventListener('pointercancel', onUp, { capture: true });
// 配置モード中は、ボタンの本来の操作（破壊・ジャンプなど）を動かさない
window.addEventListener('touchstart', e => {
  if (editMode && e.target.closest && e.target.closest('.tb')) e.stopPropagation();
}, { capture: true, passive: false });
window.addEventListener('mousedown', e => {
  if (editMode && e.target.closest && e.target.closest('.tb')) e.stopPropagation();
}, { capture: true });

// ============================================================
// 3. 設定パネル（大きさ・配置）
// ============================================================
const layoutPanel = document.createElement('div');
layoutPanel.id = 'vcLayoutPanel';
layoutPanel.className = 'vcPanel';
layoutPanel.innerHTML = `<div class="vcBox">
  <h2>ボタンの大きさ・位置</h2>
  <label>大きさ：<span id="vcSizeV"></span></label>
  <input type="range" id="vcSize" min="50" max="150" step="5">
  <button id="vcEditBtn" class="sub">配置を動かす：オフ</button>
  <button id="vcReset" class="sub">初期配置に戻す</button>
  <button id="vcLayoutClose">閉じる</button>
  <p class="note">「配置を動かす」をオンにすると、ボタンを指でドラッグして動かせます。終わったら画面上の「完了」を押してください。ボタンが重なる場合は、大きさを小さくしてください。</p>
</div>`;
document.body.appendChild(layoutPanel);

const doneBtn = document.createElement('button');
doneBtn.id = 'vcDoneBtn';
doneBtn.textContent = '配置を完了';
document.body.appendChild(doneBtn);
doneBtn.addEventListener('click', () => setEditMode(false));

const toggleBtn = document.createElement('button');
toggleBtn.id = 'vcLayoutToggle';
toggleBtn.textContent = '🎮';
document.body.appendChild(toggleBtn);

function openLayoutPanel() {
  const sz = document.getElementById('vcSize');
  sz.value = Math.round(layout.scale * 100);
  document.getElementById('vcSizeV').textContent = sz.value + '%';
  layoutPanel.classList.add('show');
}
function closeLayoutPanel() { layoutPanel.classList.remove('show'); }

toggleBtn.addEventListener('click', e => { e.stopPropagation(); layoutPanel.classList.contains('show') ? closeLayoutPanel() : openLayoutPanel(); });
document.getElementById('vcSize').addEventListener('input', e => {
  layout.scale = Number(e.target.value) / 100;
  document.getElementById('vcSizeV').textContent = e.target.value + '%';
  applyLayout(); saveLayout();
});
document.getElementById('vcEditBtn').addEventListener('click', () => setEditMode(!editMode));
document.getElementById('vcReset').addEventListener('click', () => {
  layout = { scale: defaultScale(), pos: {} };
  saveLayout(); applyLayout(); openLayoutPanel();
});
document.getElementById('vcLayoutClose').addEventListener('click', closeLayoutPanel);
layoutPanel.addEventListener('pointerdown', e => { if (e.target === layoutPanel) closeLayoutPanel(); });

// ============================================================
// 4. 道路・線路の部分削除（道路モードでなくても、狙った場所をタップ／クリックで削除）
// ============================================================
let eraseCooldown = 0;
const prevBreak = window.doBreak;
window.doBreak = function () {
  const roadOn = typeof rs !== 'undefined' && rs.mode;
  if (!roadOn && typeof cursorTarget === 'function' && typeof st !== 'undefined') {
    const t = cursorTarget();
    const pc = t ? nearestGroup(t.p, 1.4) : null;      // 道路・線路の近くなら、道路を消す
    if (pc) {
      const now = performance.now();
      if (now > eraseCooldown) { eraseCooldown = now + 350; eraseNear(pc); }
      return;
    }
  }
  return prevBreak();
};
function eraseNear(pc) {
  const d2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
  const before = st.pieces.length + st.nodes.length;
  st.pieces = st.pieces.filter(p => !(p.g === pc.g && d2(p.x, p.z, pc.x, pc.z) <= ERASE_R));
  st.nodes = st.nodes.filter(n => !(n.g === pc.g && d2(n.p.x, n.p.z, pc.x, pc.z) <= ERASE_R));
  if (st.pieces.length + st.nodes.length === before) return;
  rebuildMain();
  saveAll();
  if (typeof toast === 'function') toast('道路・線路の一部を削除しました');
}

// ============================================================
// 起動
// ============================================================
applyLayout();
window.addEventListener('resize', () => { if (!drag) applyLayout(); });
window.VoxelUI = { openLayout: openLayoutPanel, closeLayout: closeLayoutPanel, setEditMode, resetLayout: () => { layout = { scale: defaultScale(), pos: {} }; saveLayout(); applyLayout(); } };
})();
