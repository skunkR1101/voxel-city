/* voxel-craft-save.js (v1)  最初の画面・シード・ワールドの保存と読み込み
 * 読み込み順：ext → road → train → dia → station → save → multi
 * 本体HTMLは変更しない。
 *
 *  ・最初の画面：シングルプレイ（新しいワールド・シード入力・ファイルから読み込む）／マルチプレイ
 *  ・シード：数値（または文字）を入れると同じ地形になる。空欄はランダム
 *  ・保存：ワールド内のすべての編集（ブロック・ほかの機能の保存データ・音声）を1つのファイルにしてダウンロード
 *  ・読み込み：保存ファイルを選ぶと、そのワールドに戻ります（ページを読み直して反映）
 *
 * 保存ファイルの作り（将来の更新に対応するため）：
 *  ・localStorage の「voxelcraft_」で始まる項目を、すべてそのまま保存する。新しい機能を追加しても、
 *    その機能の保存キーが「voxelcraft_」で始まっていれば自動的に保存・読み込みの対象になる。
 *  ・version を持ち、読み込み側は未知の項目を無視する（古いファイルも新しい版で読める）。
 */
(function () {
'use strict';

const FORMAT = 'voxelcraft-world';
const VERSION = 1;
const SEED_KEY = 'voxelcraft_world_seed';
let autoDirty = false;             // ローカルの世界が変わり、まだ自動保存していない
const IDB_NAME = 'voxelcraft', IDB_STORE = 'kv', PENDING = 'pendingWorld';

// 本体の関数（定義は本体HTML）
const origHash2 = window.hash2;

let seedNum = null;   // null = 既定の地形

// ============================================================
// IndexedDB（読み込み待ちのワールド：大きいので localStorage は使わない）
// ============================================================
let dbP = null;
function openDb() {
  if (!dbP) dbP = new Promise((res, rej) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbP;
}
function idbGet(k) {
  return openDb().then(d => new Promise((res, rej) => {
    const q = d.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(k);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  }));
}
function idbPut(k, v) {
  return openDb().then(d => new Promise((res, rej) => {
    const tx = d.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(v, k);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  }));
}
function idbDel(k) {
  return openDb().then(d => new Promise((res, rej) => {
    const tx = d.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(k);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  }));
}

// ============================================================
// シード（同じ数値なら同じ地形になる）
// ============================================================
function normalizeSeed(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return null;
  if (/^-?\d+$/.test(s)) return Number(s) | 0;
  let h = 2166136261;                       // 文字列は FNV-1a で数値にする
  for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h | 0;
}
// 地形の計算に使うハッシュの入り口をずらす（シードごとに別の地形になる）
function installHash(seed) {
  if (seed === null || !origHash2) { window.hash2 = origHash2; return; }
  const ox = Math.floor(origHash2(seed, 0x5eed, 17) * 2000000) - 1000000;
  const oy = Math.floor(origHash2(seed, 0x51de, 23) * 2000000) - 1000000;
  const mix = Math.imul(seed, 0x9e3779b1) | 0;
  window.hash2 = function (ix, iy, s) { return origHash2(ix + ox, iy + oy, (s ^ mix) | 0); };
}
// チャンクを作り直す（次に見えるとき、新しい地形と保存された編集で作られる）
function regenerate() {
  for (const e of chunks.values()) disposeEntry(e);
  chunks.clear();
  meshQueue.length = 0;
}
// fresh: 編集データも空にする（新しいワールド・参加時）
function applySeed(v, fresh) {
  seedNum = normalizeSeed(v);
  installHash(seedNum);
  try {
    if (seedNum === null) localStorage.removeItem(SEED_KEY);
    else localStorage.setItem(SEED_KEY, String(seedNum));
  } catch (e) {}
  if (fresh) editsByChunk.clear();
  autoDirty = true;
  if (fresh) window.dispatchEvent(new CustomEvent('voxelworld:fresh', { detail: { room: isRoomOn() } }));
  regenerate();
}

// ============================================================
// 座標の変換（チャンクの鍵 → cx,cy,cz）。本体の ckey の逆
// ============================================================
function decodeKey(k) {
  if (!Number.isSafeInteger(k)) return null;
  const cz = (k % 120000) - 60000;
  const rest = Math.floor(k / 120000);
  const cy = (rest % 120000) - 6000;
  const cx = Math.floor(rest / 120000) - 60000;
  return ckey(cx, cy, cz) === k ? { cx, cy, cz } : null;
}

// ============================================================
// 保存・読み込み
// ============================================================
function buildSave() {
  const edits = [];
  for (const [k, ed] of editsByChunk) {
    if (!ed || !ed.size) continue;
    const c = decodeKey(k);
    if (c) edits.push([c.cx, c.cy, c.cz, [...ed.entries()]]);
  }
  const storage = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('voxelcraft_') && k !== SEED_KEY) storage[k] = localStorage.getItem(k);
  }
  return {
    format: FORMAT, version: VERSION, savedAt: new Date().toISOString(),
    seed: seedNum,
    base: { edits },
    storage,
    sounds: window.VoxelDia && VoxelDia.soundsWithData ? VoxelDia.soundsWithData() : []
  };
}
function downloadSave() {
  const data = buildSave();
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date();
  const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
  a.href = URL.createObjectURL(blob);
  a.download = `voxelcraft-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('ワールドを保存しました（ダウンロード）');
}
function pad(n) { return String(n).padStart(2, '0'); }

async function loadFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch (e) { toast('ファイルを読み取れませんでした'); return; }
  if (!data || data.format !== FORMAT) { toast('ワールドの保存ファイルではありません'); return; }
  if (typeof data.version !== 'number' || data.version > VERSION) { toast('このファイルは新しい版で作られています'); return; }
  try {
    // 保存データの項目を入れ替える（ページを読み直すと、各機能がこの内容で動き出す）
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('voxelcraft_')) localStorage.removeItem(k);
    }
    for (const [k, v] of Object.entries(data.storage || {})) {
      if (typeof v === 'string') localStorage.setItem(k, v);
    }
    if (window.VoxelDia && VoxelDia.importSounds) await VoxelDia.importSounds(data.sounds || []);
    await idbPut(PENDING, { seed: data.seed ?? null, edits: (data.base && data.base.edits) || [] });
  } catch (e) {
    toast('読み込みを準備できませんでした（保存領域の容量が足りない可能性があります）');
    return;
  }
  location.reload();
}

// 読み込み待ちのワールドがあれば、その編集とシードを反映する（ページを読み直したあと）
async function restorePending() {
  let pend = null;
  try { pend = await idbGet(PENDING); } catch (e) {}
  if (!pend) return false;
  await idbDel(PENDING).catch(() => {});
  editsByChunk.clear();
  for (const [cx, cy, cz, list] of pend.edits || []) editsByChunk.set(ckey(cx, cy, cz), new Map(list));
  applySeed(pend.seed, false);
  return true;
}

// ============================================================
// 画面
// ============================================================
let titleEl = null, menuEl = null, toastEl = null, toastT = 0, saveBtn = null;
let startAfterLoad = false;
function toast(t) {
  if (!toastEl) return;
  toastEl.textContent = t;
  toastEl.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl.classList.remove('show'), 2600);
}
function startSingle(fresh) {
  const v = document.getElementById('wsSeed').value;
  if (fresh) applySeed(v, true);
  hideTitle();
  startGame();
}
function hideTitle() {
  titleEl.style.display = 'none';
  saveBtn.style.display = 'block';
}
function showTitle() {
  titleEl.style.display = 'flex';
  saveBtn.style.display = 'none';
}
function buildUI(hasPending) {
  const style = document.createElement('style');
  style.textContent = `
  #wsTitle{position:fixed;inset:0;z-index:70;display:none;align-items:center;justify-content:center;
    background:linear-gradient(160deg,#1b2a3a,#0b1118);color:#fff;font-family:sans-serif;padding:16px;box-sizing:border-box}
  #wsTitle .card{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.18);border-radius:12px;
    padding:18px;width:min(92vw,420px);box-sizing:border-box;margin-bottom:14px}
  #wsTitle h1{margin:0 0 14px;font-size:26px;letter-spacing:2px;text-align:center}
  #wsTitle h2{margin:0 0 8px;font-size:16px;color:#cfe3f5}
  #wsTitle .btn{display:block;width:100%;background:#2e6a9a;color:#fff;border:none;border-radius:8px;
    padding:12px;font-size:16px;margin-top:8px;cursor:pointer}
  #wsTitle .btn.sub{background:#3a4450}
  #wsTitle input{width:100%;box-sizing:border-box;background:#1f2b38;color:#fff;border:1px solid rgba(255,255,255,.3);
    border-radius:6px;padding:10px;font-size:15px;margin-top:6px}
  #wsTitle .note{font-size:12px;color:#9fb3c8;line-height:1.6;margin:6px 0 0}
  #wsSaveBtn{position:fixed;left:10px;top:10px;z-index:6;display:none;background:rgba(0,0,0,.5);color:#fff;
    border:1px solid rgba(255,255,255,.4);border-radius:6px;padding:7px 11px;font-size:13px;cursor:pointer}
  #wsToast{position:fixed;left:50%;top:22%;transform:translateX(-50%);background:rgba(0,0,0,.75);color:#fff;
    padding:8px 14px;border-radius:8px;z-index:80;opacity:0;transition:opacity .3s;pointer-events:none;font-size:13px;max-width:90vw}
  #wsToast.show{opacity:1}
  `;
  document.head.appendChild(style);

  titleEl = document.createElement('div');
  titleEl.id = 'wsTitle';
  titleEl.innerHTML = `
    <div style="width:min(92vw,420px)">
      <h1>VOXEL CRAFT</h1>
      <div class="card">
        <h2>シングルプレイ</h2>
        <input id="wsSeed" placeholder="シード（数値や文字。空欄でランダム）" autocomplete="off">
        <p class="note">同じシードを入れると、同じ地形になります。</p>
        <button class="btn" id="wsNew">新しいワールドで開始</button>
        ${hasPending ? '<button class="btn" id="wsResume">読み込んだワールドで開始</button>' : ''}
        <button class="btn sub" id="wsLoad">ファイルから読み込む（保存したワールド）</button>
        <input type="file" id="wsFile" accept=".json,application/json" style="display:none">
      </div>
      <div class="card">
        <h2>マルチプレイ（共同都市）</h2>
        <p class="note">部屋を作るか、部屋IDとパスワード（または共有リンク）で参加します。作った人がいなくても、部屋は続けられます。</p>
        <button class="btn" id="wsMulti">マルチプレイを開く</button>
      </div>
    </div>`;
  document.body.appendChild(titleEl);

  saveBtn = document.createElement('button');
  saveBtn.id = 'wsSaveBtn';
  saveBtn.textContent = '💾 保存';
  document.body.appendChild(saveBtn);
  saveBtn.addEventListener('click', e => { e.stopPropagation(); downloadSave(); });

  toastEl = document.createElement('div');
  toastEl.id = 'wsToast';
  document.body.appendChild(toastEl);

  document.getElementById('wsNew').addEventListener('click', () => startSingle(true));
  const resume = document.getElementById('wsResume');
  if (resume) resume.addEventListener('click', () => { hideTitle(); startGame(); });
  document.getElementById('wsLoad').addEventListener('click', () => document.getElementById('wsFile').click());
  document.getElementById('wsFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) loadFile(f); });
  document.getElementById('wsMulti').addEventListener('click', () => {
    if (window.VoxelMulti) VoxelMulti.open();
    else toast('マルチプレイの機能が読み込まれていません');
  });
}

// 本体の開始処理をずらさずに、最初の画面を出す
function hookStart() {
  // 「タップで開始」の大きな枠は最初の画面で隠す（ゲーム開始はこちらのボタンから）
  if (overlayEl) overlayEl.style.display = 'none';
}

// ============================================================
// ローカルの世界の自動保存（退出して入り直しても、続きから）
//  ・部屋に入っている間は、ローカルの世界は保存しない（部屋の世界は部屋ごとに保存される）
//  ・部屋を出たら、入る前のローカルの世界に戻す
// ============================================================
const AUTO_KEY = 'autosave';
function isRoomOn() { return !!(window.VoxelMulti && VoxelMulti.roomId && VoxelMulti.roomId()); }
(function () {
  const sb = window.setBlock;
  window.setBlock = function (x, y, z, t) { sb(x, y, z, t); if (!isRoomOn()) autoDirty = true; };
})();
let autoSaving = false;
async function autoSaveNow() {
  if (!autoDirty || isRoomOn() || autoSaving) return;
  autoSaving = true;
  try {
    const s = buildSave();
    await idbPut(AUTO_KEY, { seed: seedNum, edits: s.base.edits });
    autoDirty = false;
  } catch (e) {} finally { autoSaving = false; }
}
async function restoreAuto() {
  let a = null;
  try { a = await idbGet(AUTO_KEY); } catch (e) {}
  editsByChunk.clear();
  if (a) for (const [cx, cy, cz, list] of a.edits || []) editsByChunk.set(ckey(cx, cy, cz), new Map(list));
  applySeed(a ? a.seed : localStorage.getItem(SEED_KEY), false);
  autoDirty = false;
}
let wasInRoom = false;
setInterval(() => {
  const now = isRoomOn();
  if (wasInRoom && !now) restoreAuto();     // 部屋を出た → ローカルの世界に戻す
  wasInRoom = now;
  autoSaveNow();
}, 1500);
window.addEventListener('pagehide', () => { autoSaveNow(); });

// ============================================================
// 初期化
// ============================================================
async function init() {
  const hadPending = await restorePending().catch(() => false);
  if (!hadPending) await restoreAuto();
  buildUI(hadPending);
  showTitle();
  hookStart();
}

window.VoxelWorld = {
  applySeed: (v, fresh) => applySeed(v, fresh),
  getSeed: () => seedNum,
  normalizeSeed,
  buildSave,
  decodeKey,
  // 最初の画面を閉じて開始（マルチプレイ参加などから呼ぶ）
  start: () => { hideTitle(); startGame(); },
  toast
};

init();
})();
