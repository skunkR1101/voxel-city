/* voxel-craft-phone.js  マイ端末（道具）と、端末のメニュー
 *
 *  段階1（今回）：
 *    ・マイ端末を持っている間、「端末を開く」ボタンが出る
 *    ・端末のホーム画面（アプリ一覧）
 *    ・設定アプリ：壁紙（カスタム画像・標準に戻す）、アプリアイコン（カスタム画像・標準に戻す）
 *    ・経済・路線図アプリは、枠だけ（次の段階で中身を作る）
 *
 *  保存：壁紙・アイコンは、この端末だけに保存（IndexedDB）。ワールドには入らない。
 *  読み込み順：voxel-craft-ext.js が自動で読み込む（直接の読み込みは不要）
 */
(function () {
'use strict';
if (window.VoxelPhone) return;

// ---------- 準備（voxel-craft-ext.js の読み込みを待つ） ----------
function whenExt(fn) {
  if (window.VoxelExt && window.VoxelExt.T_PHONE) { fn(window.VoxelExt); return; }
  const t = setInterval(() => {
    if (window.VoxelExt && window.VoxelExt.T_PHONE) { clearInterval(t); fn(window.VoxelExt); }
  }, 100);
}

const APPS = [
  { id: 'settings', name: '設定', emoji: '⚙️', ready: true },
  { id: 'economy', name: '経済', emoji: '💴', ready: false },
  { id: 'route', name: '路線図', emoji: '🚉', ready: false }
];
const WALL_KEY = 'phone:wall';
const iconKey = id => 'phone:icon:' + id;
const cache = new Map();          // キー -> データURL（読んだものを覚えておく）
let VX = null, isOpenFlag = false, view = 'home', root = null, frame = null, clockT = 0;

// ---------- 小さな補助 ----------
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
let toastEl = null, toastT = 0;
function say(text) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.style.cssText = 'position:fixed;left:50%;bottom:18%;transform:translateX(-50%);z-index:90;background:rgba(20,28,38,.92);color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;pointer-events:none;opacity:0;transition:opacity .2s;max-width:90vw';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.style.opacity = '1';
  clearTimeout(toastT);
  toastT = setTimeout(() => { toastEl.style.opacity = '0'; }, 1800);
}
function timeText() { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
function holding() { return !!VX && typeof HOTBAR !== 'undefined' && typeof selIdx !== 'undefined' && HOTBAR[selIdx] === VX.T_PHONE; }
function playing() { try { return typeof started !== 'undefined' && !!started && !(typeof menuOpen !== 'undefined' && menuOpen); } catch (e) { return false; } }

// 画像を、端末の保存に収まる大きさに縮める（JPEG）
async function shrink(file, maxW, q) {
  const bmp = await createImageBitmap(file);
  const sc = Math.min(1, maxW / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * sc)); c.height = Math.max(1, Math.round(bmp.height * sc));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', q);
}
async function load(key) {
  if (cache.has(key)) return cache.get(key);
  let v = null;
  try { v = await VX.blobGet(key); } catch (e) {}
  if (typeof v !== 'string') v = null;
  cache.set(key, v);
  return v;
}
async function save(key, dataUrl) {
  cache.set(key, dataUrl);
  try { await VX.blobPut(key, dataUrl); } catch (e) { say('保存できませんでした（容量がいっぱいの可能性があります）'); }
}
async function reset(key) {
  cache.set(key, null);
  try { await VX.blobDel(key); } catch (e) {}
}

// ---------- 画面 ----------
function build() {
  root = document.createElement('div');
  root.id = 'phoneRoot';
  root.style.cssText = 'position:fixed;inset:0;z-index:80;background:rgba(6,10,18,.72);display:none;align-items:center;justify-content:center;padding:12px;box-sizing:border-box';
  frame = document.createElement('div');
  frame.id = 'phoneFrame';
  frame.style.cssText = 'position:relative;width:min(360px,92vw);height:min(660px,88vh);border-radius:34px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.6);border:6px solid #111;color:#fff;font:14px/1.4 system-ui,sans-serif;background:#111';
  root.appendChild(frame);
  document.body.appendChild(root);

  // 入力の受け口（壁紙・アイコン用）
  const fileIn = document.createElement('input');
  fileIn.type = 'file'; fileIn.accept = 'image/*'; fileIn.style.display = 'none';
  fileIn.id = 'phoneFile';
  root.appendChild(fileIn);
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files && fileIn.files[0];
    const target = fileIn.dataset.target;
    fileIn.value = '';
    if (!f || !target) return;
    try {
      const url = await shrink(f, target === WALL_KEY ? 720 : 256, target === WALL_KEY ? 0.8 : 0.85);
      await save(target, url);
      say(target === WALL_KEY ? '壁紙を変えました' : 'アイコンを変えました');
      render();
    } catch (e) { say('画像を読み込めませんでした'); }
  });

  frame.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'open') { view = b.dataset.app; render(); }
    else if (act === 'home') { view = 'home'; render(); }
    else if (act === 'close') closePhone();
    else if (act === 'wall-pick') { fileIn.dataset.target = WALL_KEY; fileIn.click(); }
    else if (act === 'wall-reset') { reset(WALL_KEY).then(() => { say('壁紙を標準に戻しました'); render(); }); }
    else if (act === 'icon-pick') { fileIn.dataset.target = iconKey(b.dataset.app); fileIn.click(); }
    else if (act === 'icon-reset') { reset(iconKey(b.dataset.app)).then(() => { say('アイコンを標準に戻しました'); render(); }); }
  });
}

function wallpaperCss() {
  const u = cache.get(WALL_KEY);
  return u ? `background:#000 url(${JSON.stringify(u).slice(1, -1)}) center/cover no-repeat`
    : 'background:linear-gradient(165deg,#7f9cf5 0%,#c8a2e6 45%,#f7b7c7 100%)';
}
function iconTile(app) {
  const u = cache.get(iconKey(app.id));
  const inner = u ? `<img src="${esc(u)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:16px">`
    : `<span style="font-size:28px">${app.emoji}</span>`;
  return `<div style="width:60px;height:60px;border-radius:16px;background:rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:0 2px 6px rgba(0,0,0,.25)">${inner}</div>`;
}
function statusBar() {
  return `<div style="display:flex;justify-content:space-between;padding:10px 18px 4px;font-size:13px;font-weight:600;text-shadow:0 1px 2px rgba(0,0,0,.35)">
    <span>${timeText()}</span><span>🔋</span></div>`;
}
function homeHtml() {
  const tiles = APPS.map(a => `
    <button data-act="open" data-app="${a.id}" style="background:none;border:0;color:#fff;display:flex;flex-direction:column;align-items:center;gap:4px;cursor:pointer;font:inherit">
      ${iconTile(a)}<span style="font-size:12px;text-shadow:0 1px 2px rgba(0,0,0,.45)">${a.name}${a.ready ? '' : '（準備中）'}</span>
    </button>`).join('');
  return `${statusBar()}
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:18px 8px;padding:24px 18px">${tiles}</div>`;
}
function appChrome(title, body) {
  return `${statusBar()}
    <div style="display:flex;align-items:center;gap:8px;padding:6px 12px 10px;background:rgba(0,0,0,.25)">
      <button data-act="home" style="background:none;border:0;color:#fff;font-size:15px;cursor:pointer">‹ ホーム</button>
      <b style="margin-left:auto;margin-right:auto;padding-right:50px">${esc(title)}</b>
    </div>
    <div style="padding:12px;overflow:auto;height:calc(100% - 110px);background:rgba(20,24,34,.82)">${body}</div>`;
}
function settingsHtml() {
  const row = (app) => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.12)">
      ${iconTile(app).replace('width:60px;height:60px', 'width:44px;height:44px')}
      <span style="flex:1">${app.name}</span>
      <button data-act="icon-pick" data-app="${app.id}" style="${btnCss()}">画像を選ぶ</button>
      <button data-act="icon-reset" data-app="${app.id}" style="${btnCss()}">標準</button>
    </div>`;
  return appChrome('設定', `
    <h4 style="margin:4px 0 8px">壁紙</h4>
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <button data-act="wall-pick" style="${btnCss()}">画像を選ぶ</button>
      <button data-act="wall-reset" style="${btnCss()}">標準の壁紙に戻す</button>
    </div>
    <h4 style="margin:4px 0 4px">アプリアイコン</h4>
    <div style="font-size:11px;opacity:.75;margin-bottom:4px">画像を選ぶと、その画像がアイコンになります。</div>
    ${APPS.map(row).join('')}`);
}
function pendingHtml(app) {
  return appChrome(app.name, `<div style="padding:24px 8px;text-align:center;opacity:.85">
    ${app.name}アプリは、次の段階で中身を追加します。<br><br>今は枠だけの画面です。</div>`);
}
function btnCss() { return 'background:rgba(255,255,255,.16);color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:8px;padding:6px 10px;font:inherit;font-size:12px;cursor:pointer'; }

function render() {
  if (!frame) return;
  const bg = wallpaperCss();
  let inner;
  if (view === 'home') inner = homeHtml();
  else if (view === 'settings') inner = settingsHtml();
  else {
    const a = APPS.find(x => x.id === view);
    if (a && a.mount) inner = appChrome(a.name, '<div id="phoneAppBody"></div>');
    else inner = a ? pendingHtml(a) : homeHtml();
  }
  frame.setAttribute('style', frame.getAttribute('style').replace(/background:[^;]*;?/, '') + ';' + bg);
  frame.innerHTML = `<div style="height:100%;display:flex;flex-direction:column;position:relative">
    <div style="flex:1;overflow:hidden">${inner}</div>
    <div style="height:34px;display:flex;align-items:center;justify-content:center">
      <button data-act="${view === 'home' ? 'close' : 'home'}" style="${btnCss()};border-radius:12px">${view === 'home' ? '閉じる' : 'ホームへ'}</button>
    </div></div>`;
  const a = APPS.find(x => x.id === view);
  if (view !== 'home' && view !== 'settings' && a && a.mount) {
    const body = document.getElementById('phoneAppBody');
    if (body) { try { a.mount(body); } catch (e) { body.textContent = 'エラー：' + (e && e.message); } }
  }
}
function typingNow() { const x = document.activeElement; return !!(frame && frame.contains(x) && /INPUT|TEXTAREA|SELECT/.test(x.tagName)); }

// ---------- 開く・閉じる ----------
async function openPhone() {
  if (!root) build();
  isOpenFlag = true; view = 'home';
  if (document.pointerLockElement) { try { document.exitPointerLock(); } catch (e) {} }
  root.style.display = 'flex';
  for (const a of APPS) await load(iconKey(a.id));
  await load(WALL_KEY);
  render();
  clearInterval(clockT);
  clockT = setInterval(() => { if (isOpenFlag && !typingNow()) render(); }, 30000);
  refreshButton();
}
function closePhone() {
  if (!root) return;
  isOpenFlag = false;
  root.style.display = 'none';
  clearInterval(clockT);
  refreshButton();
  // 閉じたあと、ゲームの視点に戻す（ボタンを押した操作の続きとして、画面を固定する）
  try {
    const cv = document.querySelector('canvas');
    if (cv && playing() && cv.requestPointerLock) { const p = cv.requestPointerLock(); if (p && p.catch) p.catch(() => {}); }
  } catch (e) {}
}

// ---------- 「端末を開く」ボタン ----------
let openBtn = null;
function buildButton() {
  openBtn = document.createElement('button');
  openBtn.id = 'phoneOpen';
  openBtn.textContent = '端末を開く';
  openBtn.style.cssText = 'position:fixed;right:10px;top:96px;z-index:30;display:none;background:rgba(20,28,38,.85);color:#fff;border:1px solid rgba(255,255,255,.35);border-radius:10px;padding:8px 12px;font:600 13px system-ui,sans-serif';
  openBtn.addEventListener('click', e => { e.preventDefault(); openPhone(); });
  document.body.appendChild(openBtn);
}
function refreshButton() {
  if (!openBtn) return;
  openBtn.style.display = (!isOpenFlag && playing() && holding()) ? 'block' : 'none';
}
setInterval(refreshButton, 200);

// Esc で閉じる（ゲームの Esc より先に、端末を閉じる）
window.addEventListener('keydown', e => {
  if (e.code === 'Escape' && isOpenFlag) { e.preventDefault(); closePhone(); }
});

// 他のファイルが、端末にアプリを追加する（mount(要素) で、その中の画面を作る）
function registerApp(app) {
  const a = APPS.find(x => x.id === app.id);
  if (a) { a.name = app.name; a.emoji = app.emoji; a.mount = app.mount; a.ready = true; }
  else APPS.push({ id: app.id, name: app.name, emoji: app.emoji, mount: app.mount, ready: true });
  if (isOpenFlag) render();
}
window.VoxelPhone = {
  registerApp,
  isOpen: () => isOpenFlag,
  open: () => openPhone(),
  close: () => closePhone()
};

whenExt(ext => {
  VX = ext;
  build();
  buildButton();
});
})();
