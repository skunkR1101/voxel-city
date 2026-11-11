/* voxel-craft-keys.js  キーボード操作（パソコン向け）
 *
 *  Esc      設定を開く（開いているときは閉じる。パネルが開いているときは、パネルを閉じる）
 *  E        インベントリ（既存。「＋」ボタンと同じ）
 *  T        チャットを開く（新しいチャット・部屋に入っているとき）
 *  Q        手に持っているアイテム（選んでいるスロット）を空欄にする
 *  F5       視点を切り替える（一人称 → 三人称後方 → 三人称前方）
 *  ホイール  アイテムスロットを持ち替える
 *  [ ]      グリッド（格子 1.0 → 0.5 → 0.25 → フリー）
 *  - =      傾き（0° → 15° → … → 90°）
 *  , .      斜めの角度（0° → 15° → … → 45°）
 *  Tab      マウスカーソルの表示・非表示（表示中は、視点は動かず、クリックで置く・壊すこともしない）
 *
 *  読み込み順：voxel-craft.html の本体のあと、voxel-craft-ext.js の後（どちらが先でも動くように待つ）
 */
(function () {
'use strict';
if (window.__vcKeys) return;               // 二重に読み込まれても一度だけ
window.__vcKeys = true;

let cursorFree = false;                    // Tab で切り替える「カーソル表示」

// ---------- 小さな補助 ----------
function el(id) { return document.getElementById(id); }
function eat(e) { e.preventDefault(); e.stopImmediatePropagation(); }
function isTyping(e) { return !!(e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)); }
function gameStarted() { try { return typeof started !== 'undefined' && !!started; } catch (x) { return false; } }
function settingsOpen() { const s = el('settings'); return !!(s && s.classList.contains('show')); }
function panelOpen() { return !!document.querySelector('.ext-panel.show'); }
function phoneOpen() { return !!(window.VoxelPhone && VoxelPhone.isOpen()); }
function uiOpen() { return settingsOpen() || panelOpen() || phoneOpen(); }
function chatInput() { const box = el('rtChat'); return box ? box.querySelector('input') : null; }
function chatting() { const i = chatInput(); return !!i && document.activeElement === i; }
function playing() { try { return gameStarted() && !uiOpen() && !chatting() && !(typeof menuOpen !== 'undefined' && menuOpen); } catch (x) { return false; } }

let toastEl = null, toastT = 0;
function say(text) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.style.cssText = 'position:fixed;left:50%;top:14%;transform:translateX(-50%);z-index:50;background:rgba(20,28,38,.92);color:#fff;padding:8px 14px;border-radius:8px;font-size:14px;pointer-events:none;opacity:0;transition:opacity .2s';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.style.opacity = '1';
  clearTimeout(toastT);
  toastT = setTimeout(() => { toastEl.style.opacity = '0'; }, 1600);
}

// 選択ボックスを1つ進める（最後の次は最初に戻る）。変更の通知で、画面の表示も合わせる
function stepSelect(sel, dir) {
  if (!sel || !sel.options.length) return;
  const n = sel.options.length;
  sel.selectedIndex = (sel.selectedIndex + dir + n) % n;
  sel.dispatchEvent(new Event('change'));
  return sel.options[sel.selectedIndex].text;
}

// ---------- カーソルの表示・非表示 ----------
// ゲーム側が勝手にカーソルを隠し直さないように、カーソル表示中はポインターロックの要求を断る
(function guardLock() {
  const orig = Element.prototype.requestPointerLock;
  if (!orig) return;
  Element.prototype.requestPointerLock = function () {
    if (cursorFree) return Promise.reject(new Error('カーソル表示中'));
    return orig.apply(this, arguments);
  };
})();

function relock() {
  const cv = document.querySelector('canvas');
  if (cv && cv.requestPointerLock && playing()) {
    const p = cv.requestPointerLock();
    if (p && p.catch) p.catch(() => {});
  }
}
function setCursorFree(v) {
  cursorFree = v;
  document.body.classList.toggle('vc-cursor-free', v);
  if (v) {
    if (document.pointerLockElement) document.exitPointerLock();
    say('カーソル表示：ON（Tabで戻す）');
  } else {
    say('カーソル表示：OFF');
    relock();
  }
}
// カーソルを出している間や、チャット中は、ポインターロックが外れても「一時停止」の画面を出さない
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement) return;
  if (cursorFree || chatting() || settingsOpen() || panelOpen() || phoneOpen()) {
    try { if (typeof paused !== 'undefined') paused = false; } catch (x) {}
    const ov = el('overlay');
    if (ov) ov.style.display = 'none';
  }
});

// ---------- キー ----------
window.addEventListener('keydown', e => {
  if (e.isComposing) return;

  // 入力欄（チャットなど）の中では、Esc だけ扱う。ほかは入力させる
  if (isTyping(e)) {
    if (e.code === 'Escape') {
      e.target.blur();
      if (playing() && !cursorFree) relock();
    }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  switch (e.code) {
    case 'Escape': {
      if (!gameStarted()) return;
      if (phoneOpen()) return;                   // 端末の閉じ方は、端末側の Esc に任せる
      if (settingsOpen()) { eat(e); if (typeof closeSettings === 'function') closeSettings(); return; }
      if (panelOpen()) return;                   // パネルの閉じ方は、既存の Esc に任せる
      eat(e);
      if (typeof openSettings === 'function') openSettings();
      return;
    }
    case 'KeyT': {
      if (!gameStarted() || e.repeat || uiOpen()) return;
      const input = chatInput();
      if (!input) { say('チャットは部屋に参加すると使えます'); eat(e); return; }
      eat(e);
      const box = el('rtChat');
      box.classList.remove('min');
      const hd = box.firstElementChild;
      if (hd) hd.textContent = 'チャット ▾';
      if (document.pointerLockElement) document.exitPointerLock();
      input.focus();
      return;
    }
    case 'Tab': {
      if (!gameStarted() || e.repeat) return;
      eat(e);
      setCursorFree(!cursorFree);
      return;
    }
    case 'KeyQ': {
      if (!playing() || e.repeat) return;
      eat(e);
      if (typeof HOTBAR === 'undefined' || typeof selIdx === 'undefined') return;
      HOTBAR[selIdx] = 0;
      if (window.VoxelExt && VoxelExt.refreshHotbarVisuals) VoxelExt.refreshHotbarVisuals();
      if (typeof selectSlot === 'function') selectSlot(selIdx);
      say('持ち物を空欄にしました');
      return;
    }
    case 'F5': {
      if (!playing()) return;                    // 始める前・パネルの中では、ふつうの再読み込みのまま
      eat(e);
      if (typeof cycleView === 'function') cycleView();
      if (typeof VIEW_NAMES !== 'undefined' && typeof viewMode !== 'undefined') say('視点：' + VIEW_NAMES[viewMode]);
      return;
    }
    case 'BracketLeft':
    case 'BracketRight': {
      if (!playing()) return;
      eat(e);
      const t = stepSelect(el('qkGrid'), e.code === 'BracketRight' ? 1 : -1);
      if (t) say('グリッド：' + t);
      return;
    }
    case 'Minus':
    case 'Equal': {
      if (!playing()) return;
      eat(e);
      const t = stepSelect(el('qkTilt'), e.code === 'Equal' ? 1 : -1);
      if (t) say('傾き：' + t);
      return;
    }
    case 'Comma':
    case 'Period': {
      if (!playing()) return;
      eat(e);
      const t = stepSelect(el('qkDeg'), e.code === 'Period' ? 1 : -1);
      if (t) say('斜め：' + t);
      return;
    }
    default:
      return;
  }
}, true);

// ---------- ホイールで持ち替え ----------
window.addEventListener('wheel', e => {
  if (!e.deltaY || !playing()) return;
  if (e.target && e.target.closest && e.target.closest('#rtChat, #settings, .ext-panel, #extQuick')) return;
  if (typeof HOTBAR === 'undefined' || typeof selIdx === 'undefined' || typeof selectSlot !== 'function') return;
  e.preventDefault();
  const n = HOTBAR.length;
  selectSlot((selIdx + (e.deltaY > 0 ? 1 : n - 1)) % n);
}, { capture: true, passive: false });

// カーソル表示中は、マウスの操作が画面の上で使えるように、カーソルの形を通常にする
const st = document.createElement('style');
st.textContent = 'body.vc-cursor-free, body.vc-cursor-free canvas { cursor: default !important; }';
document.head.appendChild(st);
})();
