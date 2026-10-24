/* voxel-craft-ui.js (v1)
 *  ・スマホの操作ボタン：大きさ・位置を設定から変更（ドラッグで動かせる）。小さい画面では自動で小さめに
 *  ・マルチ・設定などの画面が、下までスクロールできない問題を修正
 *  ・道路・線路を、道路モードに入らなくても、狙った場所をタップ／クリックで部分的に削除
 * 読み込み順： … multi → players → ui（最後）
 */
(function () {
'use strict';
// ext.js の内部の名前を、window.VoxelExt から受け取る（ext.js は外から見えないため）
const { pickTarget } = window.VoxelExt;
const VoxelExt = window.VoxelExt;

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
  // 道路を消すのは、「道路が、狙っているブロックより手前にあるとき」だけ。
  // 道路が消えなかったとき・例外が出たときは、普通の破壊をそのまま行う（壊れなくなるのを防ぐ）。
  try {
    const roadOn = typeof rs !== 'undefined' && rs.mode;
    if (!roadOn && typeof cursorTarget === 'function' && typeof st !== 'undefined') {
      const t = cursorTarget();
      const pc = t && t.p ? nearestGroup(t.p, 1.4) : null;
      if (pc) {
        const pt = pickTarget();
        const dRoad = camera.position.distanceTo(t.p);
        const roadFirst = !pt || dRoad < pt.dist - 0.05;
        const now = performance.now();
        if (roadFirst && now > eraseCooldown) {
          eraseCooldown = now + 350;
          if (eraseNear(pc)) return;                    // 道路を消せたときだけ、ここで止める
        }
      }
    }
  } catch (e) {
    reportError(e);
  }
  return prevBreak();
};
function reportError(e) {
  console.error(e);
  if (typeof toast === 'function') toast('エラー：' + (e && e.message || e));
}
window.addEventListener('error', ev => reportError(ev.error || ev.message));
function eraseNear(pc) {
  const d2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
  const before = st.pieces.length + st.nodes.length;
  st.pieces = st.pieces.filter(p => !(p.g === pc.g && d2(p.x, p.z, pc.x, pc.z) <= ERASE_R));
  st.nodes = st.nodes.filter(n => !(n.g === pc.g && d2(n.p.x, n.p.z, pc.x, pc.z) <= ERASE_R));
  if (st.pieces.length + st.nodes.length === before) return false;
  rebuildMain();
  saveAll();
  if (typeof toast === 'function') toast('道路・線路の一部を削除しました');
  return true;
}

// ============================================================
// 起動
// ============================================================
applyLayout();
window.addEventListener('resize', () => { if (!drag) applyLayout(); });
window.VoxelUI = { openLayout: openLayoutPanel, closeLayout: closeLayoutPanel, setEditMode, resetLayout: () => { layout = { scale: defaultScale(), pos: {} }; saveLayout(); applyLayout(); } };
// ============================================================
// 5. ホットバー：スティックで移動中でも、押した瞬間に持ち替える
//    （押した指が移動用のスティックとして取られないよう、先に処理して止める）
// ============================================================
(function () {
  const hb = document.getElementById('hotbar');
  if (!hb) return;
  const slotIndexOf = t => {
    const slot = t && t.closest ? t.closest('.slot') : null;
    if (!slot) return -1;
    return [...hb.children].indexOf(slot);
  };
  const pick = (e) => {
    const i = slotIndexOf(e.target);
    if (i < 0 || typeof selectSlot !== 'function') return false;
    selectSlot(i);
    return true;
  };
  hb.addEventListener('touchstart', e => { if (pick(e)) e.stopPropagation(); }, { capture: true, passive: true });
  hb.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse') pick(e); }, { capture: true });
})();

// ============================================================
// 6. 移動速度（自分だけに効く。0.5〜2.0倍）
//    本体の移動計算の結果に、倍率ぶんの水平移動を足す（壁の中には入らない）
// ============================================================
const SPEED_KEY = 'voxelcraft_speed_v1';
let speedK = 1;
try { speedK = Math.min(2, Math.max(0.5, Number(localStorage.getItem(SPEED_KEY)) || 1)); } catch (e) {}
const origUpdatePhysics = window.updatePhysics;
window.updatePhysics = function (dt, inp) {
  const p = player.pos;
  const x0 = p.x, z0 = p.z;
  origUpdatePhysics(dt, inp);
  const k = speedK - 1;
  if (Math.abs(k) < 1e-6) return;
  const dx = (p.x - x0) * k, dz = (p.z - z0) * k;
  if (dx && !boxCollides(p.x + dx, p.y, p.z)) p.x += dx;
  if (dz && !boxCollides(p.x, p.y, p.z + dz)) p.z += dz;
};
function setSpeed(v) {
  speedK = Math.min(2, Math.max(0.5, Number(v) || 1));
  try { localStorage.setItem(SPEED_KEY, String(speedK)); } catch (e) {}
  const out = document.getElementById('speedVal');
  if (out) out.textContent = speedK.toFixed(1) + '倍';
}
function addSpeedSection() {
  const sbox = document.querySelector('#settings .sbox');
  const closeBtn = document.getElementById('settingsClose');
  if (!sbox || !closeBtn) return;
  const sec = document.createElement('div');
  sec.innerHTML = `
    <h3>移動速度（自分だけ）</h3>
    <label style="display:flex;gap:8px;align-items:center;margin-top:6px">
      <input id="speedRange" type="range" min="0.5" max="2" step="0.1" style="flex:1">
      <span id="speedVal" style="min-width:48px">${speedK.toFixed(1)}倍</span>
    </label>
    <p class="note">歩く・走るの速さを倍率で変えます（他の人の画面には影響しません）。</p>`;
  sbox.insertBefore(sec, closeBtn);
  const r = document.getElementById('speedRange');
  r.value = String(speedK);
  r.addEventListener('input', () => setSpeed(r.value));
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addSpeedSection);
else addSpeedSection();
window.VoxelSpeed = { get: () => speedK, set: setSpeed };

// ============================================================
// 7. 退出した場所・持ち物を覚える（ローカルの世界と、部屋ごとに別々に）
//    位置・視点・ホットバーを、入る前の場所へ戻す。新しく始めた世界は初期状態に戻す。
// ============================================================
(function () {
  const CTX_KEY = 'voxelcraft_ctx_v1';
  const DEFAULT_HOTBAR = HOTBAR.slice();
  let curCtx = null;
  const ctxName = () => { const r = window.VoxelMulti && VoxelMulti.roomId && VoxelMulti.roomId(); return r ? 'room:' + r : 'local'; };
  const readCtx = () => { try { return JSON.parse(localStorage.getItem(CTX_KEY) || '{}') || {}; } catch (e) { return {}; } };
  const writeCtx = m => { try { localStorage.setItem(CTX_KEY, JSON.stringify(m)); } catch (e) {} };
  const nowState = () => ({ pos: [player.pos.x, player.pos.y, player.pos.z], yaw: player.yaw, pitch: player.pitch, hotbar: HOTBAR.slice(), sel: selIdx });
  function saveCtx() {
    if (!curCtx) return;
    const m = readCtx();
    m[curCtx] = nowState();
    const keys = Object.keys(m);
    for (const k of keys.slice(0, Math.max(0, keys.length - 40))) delete m[k];   // 古いものから捨てる（40件まで）
    writeCtx(m);
  }
  function applyCtx(s) {
    if (!s) return;
    if (Array.isArray(s.pos) && s.pos.every(Number.isFinite)) player.pos.set(s.pos[0], s.pos[1], s.pos[2]);
    if (Number.isFinite(s.yaw)) player.yaw = s.yaw;
    if (Number.isFinite(s.pitch)) player.pitch = s.pitch;
    player.vel.set(0, 0, 0);
    if (Array.isArray(s.hotbar)) s.hotbar.forEach((id, i) => { if (i < HOTBAR.length && Number.isInteger(id)) HOTBAR[i] = id; });
    if (Number.isInteger(s.sel) && s.sel >= 0 && s.sel < HOTBAR.length) selectSlot(s.sel);
    VoxelExt.refreshHotbarVisuals && VoxelExt.refreshHotbarVisuals();
  }
  // 新しく始めた（部屋ではない）世界は、初期の位置・持ち物に戻す
  window.addEventListener('voxelworld:fresh', e => {
    if (e.detail && e.detail.room) return;
    const m = readCtx(); delete m.local; writeCtx(m);
    player.pos.set(0, 100, 0); player.yaw = 0; player.pitch = 0; player.vel.set(0, 0, 0);
    HOTBAR.forEach((_, i) => { HOTBAR[i] = DEFAULT_HOTBAR[i]; });
    if (curCtx === 'local') { selectSlot(0); VoxelExt.refreshHotbarVisuals && VoxelExt.refreshHotbarVisuals(); }
  });
  setInterval(() => {
    const name = ctxName();
    if (name !== curCtx) {
      saveCtx();                     // 前の場所（旧）の状態を保存してから切り替える
      curCtx = name;
      applyCtx(readCtx()[name]);
    } else saveCtx();
  }, 1000);
  window.addEventListener('pagehide', saveCtx);
})();

// ============================================================
// 8. 別のWi-Fi・回線で遊ぶための中継（TURN）の設定（任意）
//    直接つながらないときだけ使われる。自分で用意した TURN サーバーの情報を入れる。
// ============================================================
(function () {
  const TURN_KEY = 'voxelcraft_turn_v1';
  const read = () => { try { return JSON.parse(localStorage.getItem(TURN_KEY) || 'null') || {}; } catch (e) { return {}; } };
  const write = v => { try { localStorage.setItem(TURN_KEY, JSON.stringify(v)); } catch (e) {} };
  function addTurnSection() {
    const sbox = document.querySelector('#settings .sbox');
    const closeBtn = document.getElementById('settingsClose');
    if (!sbox || !closeBtn) return;
    const cur = read();
    const sec = document.createElement('div');
    sec.innerHTML = `
      <h3>別のWi-Fi・回線で遊ぶ（中継サーバー）</h3>
      <label style="display:block;margin-top:6px">TURNのURL<input id="turnUrl" class="ext-input" style="width:100%" placeholder="turn:example.com:3478" value=""></label>
      <label style="display:block;margin-top:6px">ユーザー名<input id="turnUser" class="ext-input" style="width:100%" value=""></label>
      <label style="display:block;margin-top:6px">パスワード<input id="turnPass" class="ext-input" type="password" style="width:100%" value=""></label>
      <p class="note">Wi-Fiが違う・スマホの回線などで直接つながらないときは、中継サーバー（TURN）が必要です。ふつうは入れなくてOK。入れた内容はこの端末だけに保存されます。変更したら、いったん退出して入り直してください。</p>`;
    sbox.insertBefore(sec, closeBtn);
    const url = document.getElementById('turnUrl'), user = document.getElementById('turnUser'), pass = document.getElementById('turnPass');
    url.value = cur.url || ''; user.value = cur.user || ''; pass.value = cur.pass || '';
    const save = () => write({ url: url.value.trim(), user: user.value.trim(), pass: pass.value });
    [url, user, pass].forEach(el => el.addEventListener('change', save));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addTurnSection);
  else addTurnSection();
})();

})();
