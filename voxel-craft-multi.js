/* voxel-craft-multi.js (v3)  マルチプレイ（共同都市）：サーバーなし版
 * 読み込み順： … save → net → multi → custom → players → ui   本体HTMLは変更しない
 *
 * 通信は voxel-craft-net.js が担当（端末どうしを直接つなぐ。部屋ごとに最大8人）。
 * このファイルは、部屋の作成・参加・共有リンク・保存した部屋の一覧・ブロックの同期を担当する。
 */
(function () {
'use strict';
// ext.js の内部の名前を、window.VoxelExt から受け取る（ext.js は外から見えないため）
const { CUSTOM_BASE } = window.VoxelExt;

const CFG_KEY = 'voxelcraft_multi';
const ROOMS_KEY = 'voxelcraft_rooms_v1';
const SHARE_PREFIX = 'vc1:';
const FLUSH_MS = 0;
const AIR = 0;
const peer = Math.random().toString(36).slice(2, 10);   // 表示や一時情報の識別（通信の席とは別）

let cfg = { tag: '' };
let conn = null;                 // { id, pw, name, tag, seed }
let joining = false;             // 参加直後、全体を受け取っている最中
let applyingRemote = false;
let pendingSeed = null;          // 共有リンクから来たシード
const handlers = new Map();      // 接頭語 -> 受け取り関数
let blockEncoder = null;         // (x,y,z,種類) -> 送る値（カスタムブロックは定義を添える）
let blockResolver = null;        // (x,y,z,操作) -> 置く種類（まだ定義がなければ null）
let panelEl = null, statusEl = null, msgEl = null, msgT = 0;
const origSetBlock = window.setBlock;

// ============================================================
// 補助
// ============================================================
function loadCfg() {
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(CFG_KEY) || '{}')); } catch (e) {}
}
function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {} }
function toast(t) {
  if (!msgEl) return;
  msgEl.textContent = t;
  msgEl.classList.add('show');
  clearTimeout(msgT);
  msgT = setTimeout(() => msgEl.classList.remove('show'), 2800);
}
function setStatus(t) { if (statusEl) statusEl.textContent = t; }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function encShare(obj) {
  const json = JSON.stringify(obj);
  return SHARE_PREFIX + btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decShare(s) {
  const raw = String(s || '').trim();
  const at = raw.indexOf(SHARE_PREFIX);
  if (at < 0) return null;
  let b = raw.slice(at + SHARE_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  try { return JSON.parse(decodeURIComponent(escape(atob(b)))); } catch (e) { return null; }
}
async function proofOf(roomId, pw) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('vc:' + roomId + ':' + pw));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function newRoomId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const b = crypto.getRandomValues(new Uint8Array(10));
  let s = '';
  for (const x of b) s += chars[x % chars.length];
  return s;
}

// 保存領域（端末のデータベース）。部屋の記録を、再読み込みや退出のあとも残す
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('voxelcraft-net', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) {
  try {
    const db = await idbOpen();
    return await new Promise((res, rej) => {
      const q = db.transaction('kv').objectStore('kv').get(k);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  } catch (e) { return undefined; }
}
async function idbSet(k, v) {
  try {
    const db = await idbOpen();
    await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(v, k);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch (e) {}
}

// ============================================================
// 送信（ブロック・ほかの機能の変更）
// ============================================================
function send(key, value, del, eph) {
  if (!conn || !window.VoxelNet || !VoxelNet.active()) return;
  VoxelNet.send(key, value, del, eph);
}
// ============================================================
// ブロックの同期：1マスずつ送る（同じ場所は、後から変わった値が勝つ）
//  ・ワールドの保存内容（editsByChunk）を一定間隔で見て、変わったマスだけを送る
//    → 設置・破壊の呼ばれ方に左右されず、ローカルの変更を必ず拾える
//  ・受け取った側は、そのマスだけを書き換える（ほかのマスは消えない）
//  ・一定間隔で、受け取った値と実際のワールドを照らし合わせ、ずれていれば直す
// ============================================================
const SCAN_MS = 250;
const FIX_R = 48;                       // 照らし合わせる範囲（プレイヤーからのマス数）
const blockStats = { sent: 0, recv: 0, applied: 0, fixed: 0, waiting: 0 };
let stateGetter = null;                 // (x,y,z) -> カスタムブロックの色・向き（custom.js が渡す）

function connectedNow() { return !!conn && !!window.VoxelNet && VoxelNet.active(); }
function stateStr(x, y, z, t) {
  if (t < CUSTOM_BASE || !stateGetter) return '';
  return JSON.stringify(stateGetter(x, y, z) || null);
}
function sendCell(x, y, z, t) {
  const v = blockEncoder ? blockEncoder(x, y, z, t) : t;   // カスタムブロックは「しるし＋状態」にする
  send('b:' + x + ',' + y + ',' + z, v, false, false);
  blockStats.sent++;
}
// 変わったマスを探して送る
// ============================================================
// ブロックの同期（正は「部屋の記録 kv」。時刻の新しい方が勝つ）
//  ・この端末での変更は、変えた場所を覚えておき、次の処理で今の値を kv へ送る
//  ・受け取った変更は、この端末で変更中の場所には触らない（自分の変更が必ず勝つ）
//  ・画面の値が記録と違っていたら、記録の値へ直す（記録が正）
// ============================================================
const pendingCells = new Map();    // "x,y,z" -> {x,y,z}：この端末で変えて、まだ送っていない場所
let fullSyncWanted = false;        // 部屋を作ったとき（この端末の全体を送る）だけ true
const kvKeyOf = (x, y, z) => 'b:' + x + ',' + y + ',' + z;
function kvBlockOf(x, y, z) {
  const kv = window.VoxelNet && VoxelNet.kv ? VoxelNet.kv() : null;
  return kv ? kv.get(kvKeyOf(x, y, z)) || null : null;
}
// 記録がすでにこの値なら、送らなくてよい
function recordHas(x, y, z, t) {
  const e = kvBlockOf(x, y, z);
  if (!e) return false;
  if (t === AIR) return e.del === true || e.v === AIR;
  return !e.del && e.v === t;
}
// 置く・壊すは必ずここを通る（受け取った変更の書き込みは対象外）
window.setBlock = function (x, y, z, t) {
  origSetBlock(x, y, z, t);
  if (applyingRemote) return;
  if (connectedNow()) pendingCells.set(x + ',' + y + ',' + z, { x, y, z });
};
// 変えた場所を、今のワールドの値で記録へ送る（1回の処理量は上限つき）
function flushCells() {
  if (!pendingCells.size) return;
  if (!connectedNow()) { pendingCells.clear(); return; }
  let n = 0;
  for (const [key, c] of pendingCells) {
    pendingCells.delete(key);
    const t = getBlock(c.x, c.y, c.z);
    if (t < CUSTOM_BASE && recordHas(c.x, c.y, c.z, t)) continue;
    sendCell(c.x, c.y, c.z, t);
    if (++n >= 1500) break;
  }
}
// 部屋を作ったときだけ、この端末の全体を一度送る（記録と違う場所だけ）
function fullSyncOnce() {
  if (!fullSyncWanted || !connectedNow()) return;
  fullSyncWanted = false;
  for (const [ck, ed] of editsByChunk) {
    if (!ed || !ed.size) continue;
    const c = VoxelWorld.decodeKey(ck);
    if (!c) continue;
    for (const [li, t] of ed) {
      const x = c.cx * CS + (li & 15), y = c.cy * CS + ((li >> 4) & 15), z = c.cz * CS + ((li >> 8) & 15);
      if (t < CUSTOM_BASE && recordHas(x, y, z, t)) continue;
      sendCell(x, y, z, t);
    }
  }
}
// 受け取った1マスを、ワールドへ反映する（この端末で変更中の場所は、自分の変更を優先）
function applyCell(x, y, z, t) {
  applyingRemote = true;
  try { origSetBlock(x, y, z, t); } finally { applyingRemote = false; }
  blockStats.applied++;
}
function applyRemoteCell(key, rec) {
  const p = key.slice(2).split(',').map(Number);
  if (p.length !== 3 || p.some(n => !Number.isInteger(n))) return;
  blockStats.recv++;
  if (pendingCells.has(p[0] + ',' + p[1] + ',' + p[2])) return;   // 自分が今変えた場所（すぐ送るので、その値が勝つ）
  let t = null;
  if (rec.del) t = AIR;
  else if (blockResolver) t = blockResolver(p[0], p[1], p[2], rec);
  else if (typeof rec.v === 'number') t = rec.v;
  if (t === null || t === undefined || !Number.isInteger(t)) { blockStats.waiting++; return; }   // 定義が届くまで待つ
  applyCell(p[0], p[1], p[2], t);
}
const posCache = new Map();        // 'b:x,y,z' -> [x,y,z]
// 記録の値と画面が違えば、記録の値へ直す（近くだけ・自分が変更中の場所は除く）
function fixBlocks() {
  if (typeof player === 'undefined' || !player || !window.VoxelNet || !VoxelNet.kv) return;
  const kv = VoxelNet.kv();
  if (!kv) return;
  if (posCache.size > kv.size * 2 + 2000) posCache.clear();   // 消えた記録の位置を捨てる（増え続けないように）
  const pp = player.pos;
  for (const [key, e] of kv) {
    if (!e || key.charCodeAt(0) !== 98 /* b */) continue;
    let p = posCache.get(key);                       // 位置は一度だけ読み取って覚える（毎回の文字列処理を減らす）
    if (p === undefined) {
      const q = key.slice(2).split(',').map(Number);
      p = (q.length === 3 && q.every(n => Number.isInteger(n))) ? q : null;
      posCache.set(key, p);
    }
    if (!p) continue;
    if (Math.abs(p[0] - pp.x) > FIX_R || Math.abs(p[2] - pp.z) > FIX_R || Math.abs(p[1] - pp.y) > FIX_R) continue;
    if (p[1] <= BOTTOM || pendingCells.has(p[0] + ',' + p[1] + ',' + p[2])) continue;
    const want = e.del ? AIR : e.v;
    if (typeof want !== 'number') continue;          // 定義つきのブロックは reconcile が直す
    if (getBlock(p[0], p[1], p[2]) === want) continue;
    applyCell(p[0], p[1], p[2], want);
    blockStats.fixed++;
  }
}
let fixAt = 0;
setInterval(() => {
  if (!connectedNow()) return;           // つながっているときだけ（オフラインの変更は送らない・直さない）
  fullSyncOnce();
  flushCells();
  const t = performance.now();
  if (t - fixAt >= 4000) { fixAt = t; fixBlocks(); }   // 直す作業は4秒に1回（同期済みの全マスを見るため、間隔をあける）
}, SCAN_MS);

// ============================================================
// 受信（届いた変更を、ワールドとほかの機能へ反映）
// ============================================================
function applyOp(rec) {
  if (!rec || typeof rec.key !== 'string') return;
  const key = rec.key;
  if (key.startsWith('b:')) { applyRemoteCell(key, rec); return; }
  if (key === 'seed') return;
  const prefix = key.split(':')[0];
  const fn = handlers.get(prefix);
  if (fn) { try { fn(rec); } catch (e) { console.error(e); } }
}

// ============================================================
// 部屋の作成・参加・退室
// ============================================================
// ============================================================
// 読み込みの進み具合（参加ボタンを押してから、％で表示する）
// ============================================================
let loadBox = null, loadPct = 0, snapResolve = null;
function loadEnsure() {
  if (loadBox) return loadBox;
  const st = document.createElement('style');
  st.textContent = '#mpLoad{position:fixed;inset:0;z-index:96;display:none;align-items:center;justify-content:center;background:rgba(8,16,28,.72);touch-action:none}' +
    '#mpLoad .box{width:min(88vw,380px);background:#14202e;color:#fff;border-radius:12px;padding:18px 18px 16px;font-family:sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5);box-sizing:border-box}' +
    '#mpLoad .lbl{font-size:14px;margin-bottom:12px;line-height:1.5}' +
    '#mpLoad .bar{height:12px;background:rgba(255,255,255,.15);border-radius:6px;overflow:hidden}' +
    '#mpLoad .fill{height:100%;width:0;background:linear-gradient(90deg,#3d9be0,#7fd1ff);transition:width .2s}' +
    '#mpLoad .pct{font-size:13px;margin-top:8px;text-align:right;opacity:.9}';
  document.head.appendChild(st);
  loadBox = document.createElement('div');
  loadBox.id = 'mpLoad';
  const box = document.createElement('div');
  box.className = 'box';
  const lbl = document.createElement('div'); lbl.className = 'lbl';
  const bar = document.createElement('div'); bar.className = 'bar';
  const fill = document.createElement('div'); fill.className = 'fill';
  const pct = document.createElement('div'); pct.className = 'pct';
  bar.appendChild(fill);
  box.appendChild(lbl); box.appendChild(bar); box.appendChild(pct);
  loadBox.appendChild(box);
  document.body.appendChild(loadBox);
  loadBox.refs = { lbl, fill, pct };
  return loadBox;
}
function loadShow(label, pct) {
  const b = loadEnsure();
  b.style.display = 'flex';
  loadPct = Math.max(loadPct, Math.min(100, Math.round(pct)));   // 進みが戻らないように
  const r = b.refs;
  r.lbl.textContent = label;
  r.fill.style.width = loadPct + '%';
  r.pct.textContent = loadPct + '%';
}
function loadHide() {
  if (loadBox) loadBox.style.display = 'none';
  loadPct = 0;
}
const tick = () => new Promise(r => setTimeout(r, 0));

// ============================================================
// 背景で保存する（画面を止めない）
//  ・データを 800件ずつ少しずつ背景の作業役（Worker）へ渡し、そこで IndexedDB に書く
//  ・保存の中身・場所は今までどおり（同じデータベース・同じ鍵）
//  ・画面を閉じる・背景に回す時だけ、確実に書くため同期で書く
// ============================================================
function vcIoWorkerMain() {
  var jobs = new Map(), dbs = new Map();
  function openDb(name, store) {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(name, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(store); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  self.onmessage = async function (e) {
    var m = e.data, id = m.id;
    try {
      if (m.t === 'b') jobs.set(id, { db: m.db, store: m.store, key: m.key, field: m.field, meta: m.meta, items: [] });
      else if (m.t === 'p') { var j0 = jobs.get(id); for (var i = 0; i < m.items.length; i++) j0.items.push(m.items[i]); }
      else if (m.t === 'e') {
        var j = jobs.get(id); jobs.delete(id);
        var val = j.field ? Object.assign({}, j.meta || {}, (function () { var o = {}; o[j.field] = j.items; return o; })()) : j.items;
        var dk = j.db + '|' + j.store;
        if (!dbs.has(dk)) dbs.set(dk, openDb(j.db, j.store));
        var db = await dbs.get(dk);
        await new Promise(function (res, rej) {
          var tx = db.transaction(j.store, 'readwrite');
          tx.objectStore(j.store).put(val, j.key);
          tx.oncomplete = function () { res(); };
          tx.onerror = function () { rej(tx.error); };
        });
        self.postMessage({ t: 'ok', id: id });
      }
    } catch (err) {
      jobs.delete(id);
      self.postMessage({ t: 'err', id: id, msg: String((err && err.message) || err) });
    }
  };
}
const IO_SRC = '(' + vcIoWorkerMain.toString() + ')();';
let ioW = null, ioSeq = 0, ioChain = Promise.resolve();
const ioWaits = new Map();
function ioWorker() {
  if (ioW !== null) return ioW || null;
  try {
    ioW = new Worker(URL.createObjectURL(new Blob([IO_SRC], { type: 'text/javascript' })));
    ioW.onmessage = function (e) {
      const w = ioWaits.get(e.data.id);
      if (!w) return;
      ioWaits.delete(e.data.id);
      if (e.data.t === 'ok') w.res(); else w.rej(new Error(e.data.msg || '保存に失敗しました'));
    };
    ioW.onerror = function () { ioW = false; };
  } catch (e) { ioW = false; }
  return ioW || null;
}
// iter の中身を少しずつ渡して、背景で書く（保存は1つずつ順番に）
function ioStreamPut(db, store, key, field, meta, iter) {
  const job = ioChain.then(() => ioStreamPutNow(db, store, key, field, meta, iter));
  ioChain = job.catch(() => {});
  return job;
}
function ioStreamPutNow(db, store, key, field, meta, iter) {
  const w = ioWorker();
  if (!w) return Promise.reject(new Error('背景保存が使えません'));
  const id = ++ioSeq;
  return new Promise(function (res, rej) {
    ioWaits.set(id, { res: res, rej: rej });
    w.postMessage({ t: 'b', id: id, db: db, store: store, key: key, field: field, meta: meta });
    (async function () {
      let batch = [];
      for (const it of iter) {
        batch.push(it);
        if (batch.length >= 800) { w.postMessage({ t: 'p', id: id, items: batch }); batch = []; await tick(); }
      }
      if (batch.length) w.postMessage({ t: 'p', id: id, items: batch });
      w.postMessage({ t: 'e', id: id });
    })().catch(function (err) { ioWaits.delete(id); rej(err); });
  });
}
window.VoxelIO = { ok: () => !!ioWorker(), streamPut: ioStreamPut };
let unloadingNow = false;   // 画面を閉じる・背景に回す時は、同期で確実に書く
window.addEventListener('pagehide', () => { unloadingNow = true; });
document.addEventListener('visibilitychange', () => { unloadingNow = document.visibilityState === 'hidden'; });
let roomBusy = false, roomAgain = null;
function roomIdbSave(id, kv) {
  if (unloadingNow || !(window.VoxelIO && VoxelIO.ok())) { idbSet('room:' + id, [...kv.entries()]); return; }
  if (roomBusy) { roomAgain = { id, kv }; return; }        // 書いている途中なら、終わってからもう一度（最新を書くため）
  roomBusy = true;
  ioStreamPut('voxelcraft-net', 'kv', 'room:' + id, null, null, kv.entries())
    .catch(() => {})
    .then(() => {
      roomBusy = false;
      if (roomAgain) { const a = roomAgain; roomAgain = null; roomIdbSave(a.id, a.kv); }
    });
}
const GZ_OK = typeof CompressionStream === 'function' && typeof Response === 'function' && typeof Blob === 'function';

function netHooks() {
  return {
    onEntry: rec => applyOp(rec),
    onEph: rec => applyOp(rec),
    onSnapProgress: (g, n) => { if (joining) loadShow('最新の状態を受け取っています（' + g + '/' + n + '）', 50 + 50 * g / n); },
    onSnapDone: received => {
      joining = false; refreshShare();
      if (received) toast('部屋の状態を受け取りました');
      if (snapResolve) { const r = snapResolve; snapResolve = null; r(); }
    },
    onLinks: () => refreshShare(),
    save: kv => { if (conn) { roomIdbSave(conn.id, kv); ghMarkDirty(conn.id, true); } }
  };
}

// ============================================================
// GitHub への保存：部屋の作業データを、リポジトリの rooms/<部屋ID>.json に置く
//  ・設定（リポジトリ名・トークン）はこの端末にだけ保存する（共有リンク・保存コードには入らない）
//  ・誰も部屋にいなくても、入った人は GitHub から最新の作業を受け取れる
// ============================================================
const GH_KEY = 'voxelcraft_gh_v1';
function normRepo(s) {
  return String(s || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
}
function ghCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(GH_KEY) || 'null');
    if (!c || !c.repo || !c.token) return null;
    return { repo: normRepo(c.repo), token: String(c.token).trim() };
  } catch (e) { return null; }
}
function ghErrText(status) {
  const m = {
    401: 'トークンが正しくありません（貼り付けミス・期限切れ）',
    403: '書き込み権限がありません（トークンの Contents を Read and write にしてください）',
    404: 'リポジトリが見つからないか、トークンの対象外です（リポジトリ名と、トークンの Repository access を確認）',
    422: '保存できませんでした（GitHub が内容を受け付けませんでした。リポジトリが空、またはデータが大きすぎる可能性）'
  };
  return m[status] || ('GitHub保存失敗（' + status + '）');
}
// リポジトリに入れるかを確かめる（404 のとき、原因を「権限・名前」として知らせる）
async function ghRepoCheck(c) {
  const r = await fetch('https://api.github.com/repos/' + c.repo, { headers: ghHeaders(c), cache: 'no-store' });
  if (!r.ok) throw new Error(ghErrText(r.status));
}
function ghSaveCfg(c) { try { localStorage.setItem(GH_KEY, JSON.stringify(c)); } catch (e) {} }
function b64Enc(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64Dec(str) {
  const bin = atob(String(str).replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function ghHeaders(c) {
  return { Authorization: 'Bearer ' + c.token, Accept: 'application/vnd.github+json' };
}
// 同じ場所は新しい方を残して、2つの作業データを1つにする
function mergeKv(a, b) {
  const m = new Map(Array.isArray(a) ? a : []);
  for (const [k, v] of (Array.isArray(b) ? b : [])) {
    const old = m.get(k);
    if (!old || (v.ts || 0) > (old.ts || 0)) m.set(k, v);
  }
  return [...m.entries()];
}
// 1つのファイルが大きすぎると GitHub が受け付けないので、部屋のデータは数個のファイルに分けて置く
const GH_PART_MAX = 1000000;  // 1ファイルあたりの上限（圧縮前の文字数の目安。圧縮すると小さくなる）
function ghPathOf(id, k) {
  return 'rooms/' + encodeURIComponent(id) + (k ? '.p' + k : '') + '.json';
}
// 読むときだけ使う。電波が弱い・回線が切り替わる環境（モバイル・フリーWi-Fi）に備えて、時間切れと再試行を入れる
async function ghFetch(url, headers, tries = 4) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(url, { headers, cache: 'no-store', signal: ctl.signal });
      clearTimeout(timer);
      if (res.status !== 429 && res.status < 500) return res;
      lastErr = new Error(ghErrText(res.status));
    } catch (e) {
      clearTimeout(timer);
      lastErr = new Error('GitHubに届きませんでした（通信が不安定です）');
    }
    await new Promise(r => setTimeout(r, 700 * (i + 1)));
  }
  throw lastErr;
}
async function ghGetFile(c, path) {
  const url = 'https://api.github.com/repos/' + c.repo + '/contents/' + path;
  const res = await ghFetch(url, ghHeaders(c));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(ghErrText(res.status));
  const j = await res.json();
  let text;
  if (j.content) text = new TextDecoder().decode(b64Dec(j.content));
  else {   // 1MB を超えるファイルは本文が空で返るので、生データを取り直す
    const raw = await ghFetch(url, { Authorization: 'Bearer ' + c.token, Accept: 'application/vnd.github.raw' });
    if (!raw.ok) throw new Error(ghErrText(raw.status));
    text = await raw.text();
  }
  return { sha: j.sha, o: text ? JSON.parse(text) : {} };
}
// 既にあるファイル（本体・分割ファイル）をすべて読む。本体が無くても、分割ファイルがあれば読む
// ファイルの中身（圧縮版 v3／従来の JSON 版 v1・v2）を、項目の一覧にもどす
async function ghDecodeKv(o) {
  if (!o) return [];
  if (o.v === 3 && o.d) {
    const text = await VoxelNet.gunzipStr(VoxelNet.b64ToBytes(o.d));
    const j = JSON.parse(text);
    return Array.isArray(j.kv) ? j.kv : [];
  }
  return Array.isArray(o.kv) ? o.kv : [];
}
// 既にあるファイルを読む（本体と分割ファイルは同時に取りに行く＝待ち時間を短くする）
async function ghPull(id, onProg, wantSig) {
  const c = ghCfg();
  if (!c) return { shas: {}, kv: [], raw: {} };
  const shas = {};
  const raw = {};
  const mainRes = await ghGetFile(c, ghPathOf(id, 0));
  let kv = [];
  let n = 1;
  if (mainRes) {
    shas[ghPathOf(id, 0)] = mainRes.sha;
    n = Number(mainRes.o.parts) || 1;
    { const a = await ghDecodeKv(mainRes.o); if (wantSig) raw[ghPathOf(id, 0)] = sigOfRemote(a); for (const x of a) kv.push(x); }
    const ks = [];
    for (let k = 1; k < n; k++) ks.push(k);
    let done = 1;
    const got = await Promise.all(ks.map(async k => {
      // 見つからないときは、少し待って取り直す（保存直後の一時的な見えなさを避ける）
      let p = await ghGetFile(c, ghPathOf(id, k));
      for (let r = 0; !p && r < 2; r++) { await new Promise(res => setTimeout(res, 800 * (r + 1))); p = await ghGetFile(c, ghPathOf(id, k)); }
      if (onProg) onProg(++done, n);
      if (!p) throw new Error('分割ファイル（' + (k + 1) + '/' + n + '）が見つかりませんでした。全部読めないため、読み込みと保存を中止しました（データを壊さないため）');
      return p;
    }));
    for (let i = 0; i < got.length; i++) {
      const p = got[i];
      shas[ghPathOf(id, i + 1)] = p.sha;
      { const a = await ghDecodeKv(p.o); if (wantSig) raw[ghPathOf(id, i + 1)] = sigOfRemote(a); for (const x of a) kv.push(x); }
    }
  } else {
    // 本体が無いときは、分割ファイルが残っていないかを順に確かめる
    let k = 1, found = false;
    for (; k < 1000; k++) {
      const p = await ghGetFile(c, ghPathOf(id, k));
      if (!p) break;
      found = true;
      shas[ghPathOf(id, k)] = p.sha;
      { const a = await ghDecodeKv(p.o); if (wantSig) raw[ghPathOf(id, k)] = sigOfRemote(a); for (const x of a) kv.push(x); }
    }
    if (!found) { await ghRepoCheck(c); return { shas: {}, kv: [], raw: {} }; }
  }
  if (onProg) onProg(n, n);
  return { shas, kv: ghAssemble(kv), parts: n, raw };
}
// 大きすぎる1件は、いくつかの断片に切って別々の項目として保存する
const GH_SPLIT_AT = 150000;   // これを超える1件は断片に切る
const GH_PIECE = 100000;      // 断片1つの大きさ（JSON文字数）
const GH_SEP = '\u0001';
function ghSplitEntry(e) {
  const [key, val] = e;
  if (!val || val.v === undefined || JSON.stringify(e).length + 1 <= GH_SPLIT_AT) return [e];
  const s = JSON.stringify(val.v);
  const n = Math.ceil(s.length / GH_PIECE);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push([key + GH_SEP + i, { ts: val.ts, peer: val.peer, del: val.del, pc: [i, n], pv: s.slice(i * GH_PIECE, (i + 1) * GH_PIECE) }]);
  }
  return out;
}
// 断片を元の1件に戻す（同じ版の断片が全部そろっているものだけ）
function ghAssemble(list) {
  const out = [];
  const groups = new Map();   // 項目名 -> Map(時刻 -> { n, peer, del, pieces })
  for (const [k, v] of list) {
    if (!k.includes(GH_SEP) || !v || !v.pc) { out.push([k, v]); continue; }
    const base = k.split(GH_SEP)[0];
    let byTs = groups.get(base);
    if (!byTs) { byTs = new Map(); groups.set(base, byTs); }
    const ts = v.ts || 0;
    let g = byTs.get(ts);
    if (!g) { g = { n: v.pc[1], peer: v.peer, del: v.del, pieces: new Map() }; byTs.set(ts, g); }
    g.pieces.set(v.pc[0], v.pv);
  }
  for (const [base, byTs] of groups) {
    // 新しい版から順に、かけらがそろっているものを使う。
    // 新しい版の一部だけが保存されたときも、前のそろった版を残す（全体を消さない）
    const cands = [...byTs.entries()].sort((x, y) => y[0] - x[0]);
    for (const [ts, g] of cands) {
      if (g.pieces.size !== g.n) continue;
      let val;
      try { val = JSON.parse([...Array(g.n).keys()].map(i => g.pieces.get(i)).join('')); } catch (e) { continue; }
      out.push([base, { v: val, ts, peer: g.peer, del: g.del }]);
      break;
    }
  }
  return out;
}
// 項目ごとの「長さ」と「印（数字）」だけを覚える（文字列そのものは持たない＝メモリを増やさない）
const pairCache = new Map();   // 鍵 -> { v, n, h }
function strHash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
function pairInfo(e) {
  const c = pairCache.get(e[0]);
  if (c && c.v === e[1]) return c;
  const str = JSON.stringify(e);
  const info = { v: e[1], n: str.length, h: strHash32(str) };
  pairCache.set(e[0], info);
  return info;
}
// 1つのファイルの中身の印（変わったかどうかを比べるためだけに使う）
function sigOfLocal(list) {
  let h = 0;
  for (const e of list) h = (Math.imul(h, 31) + pairInfo(e).h) >>> 0;
  return h.toString(16) + ':' + list.length;
}
function sigOfRemote(list) {
  let h = 0;
  for (const e of list) h = (Math.imul(h, 31) + strHash32(JSON.stringify(e))) >>> 0;
  return h.toString(16) + ':' + list.length;
}
// 項目を、1ファイルの上限を超えないように区切る
function ghPack(kv) {
  const parts = [];
  let cur = [], size = 0;
  for (const e of kv) {
    const n = pairInfo(e).n + 1;
    if (cur.length && size + n > GH_PART_MAX) { parts.push(cur); cur = []; size = 0; }
    cur.push(e); size += n;
  }
  parts.push(cur);
  if (pairCache.size > kv.length * 2 + 1000) pairCache.clear();   // 消えた項目の分を捨てる
  return parts;
}
function chunkStr(list) { return '[' + list.map(e => JSON.stringify(e)).join(',') + ']'; }
let ghLastSig = null;
let ghQueue = Promise.resolve();
// 保存は1つずつ順番に行う（同時に書いて失われないように）
function ghPush(id, kv, prog) {
  ghMarkDirty(id, false);                 // この時点の内容を送る。送る前後に変わったものは、また印が付く
  const job = ghQueue.then(() => ghPushOnce(id, kv, prog));
  ghQueue = job.catch(() => {});
  job.catch(() => ghMarkDirty(id, true)); // 送れなかったら、次の機会にまた送る
  return job;
}
// 「GitHubへまだ送れていない変更がある部屋」の一覧（画面を閉じても消えないように端末へ保存）
const GH_DIRTY_KEY = 'voxelcraft_gh_dirty_v1';
function ghDirtyIds() { try { return JSON.parse(localStorage.getItem(GH_DIRTY_KEY) || '[]'); } catch (e) { return []; } }
function ghMarkDirty(id, on) {
  try {
    const set = new Set(ghDirtyIds());
    if (on) set.add(id); else set.delete(id);
    localStorage.setItem(GH_DIRTY_KEY, JSON.stringify([...set]));
  } catch (e) {}
}
// 未送信の部屋を、GitHubへ送る（接続中はその場の最新、そうでなければ端末に保存した最新）
function ghFlushDirty() {
  if (!ghCfg()) return;
  for (const id of ghDirtyIds()) {
    const live = conn && conn.id === id && window.VoxelNet && VoxelNet.active() && VoxelNet.kv();
    const src = live ? Promise.resolve([...VoxelNet.kv().entries()]) : idbGet('room:' + id);
    src.then(kv => { if (Array.isArray(kv) && kv.length) return ghPush(id, kv); else ghMarkDirty(id, false); })
      .catch(e => console.error(e));
  }
}
// ---- 保存の進み具合（作業は止めずに、アイテムスロットの上に〇〇%を出す） ----
let ghProgEl = null, ghProgHideT = 0;
function ghProgEnsure() {
  if (ghProgEl) return ghProgEl;
  ghProgEl = document.createElement('div');
  ghProgEl.id = 'ghProg';
  ghProgEl.style.cssText = 'position:fixed;z-index:95;display:none;pointer-events:none;transform:translate(-50%,0);background:rgba(10,18,28,.88);color:#fff;font:600 12px sans-serif;padding:4px 9px;border-radius:8px;white-space:nowrap;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.4)';
  ghProgEl.innerHTML = '<div class="gp-l"></div><div style="height:4px;width:120px;margin-top:3px;background:rgba(255,255,255,.2);border-radius:2px;overflow:hidden"><div class="gp-f" style="height:100%;width:0;background:#7fd1ff;transition:width .15s"></div></div>';
  document.body.appendChild(ghProgEl);
  return ghProgEl;
}
function ghProgPlace() {
  const hb = document.getElementById('hotbar');
  if (!hb || !ghProgEl) return;
  const r = hb.getBoundingClientRect();
  ghProgEl.style.left = (r.left + r.width / 2) + 'px';
  ghProgEl.style.top = Math.max(4, r.top - 40) + 'px';
}
function ghProgSet(done, total) {
  const el = ghProgEnsure();
  clearTimeout(ghProgHideT);
  const pct = Math.max(0, Math.min(100, Math.floor(done / Math.max(1, total) * 100)));
  el.querySelector('.gp-l').textContent = 'GitHub保存中 ' + pct + '%';
  el.querySelector('.gp-f').style.width = pct + '%';
  el.style.display = 'block';
  ghProgPlace();
}
function ghProgEnd(msg, ok) {
  const el = ghProgEnsure();
  el.querySelector('.gp-l').textContent = msg;
  el.querySelector('.gp-f').style.width = ok ? '100%' : '0';
  el.style.display = 'block';
  ghProgPlace();
  clearTimeout(ghProgHideT);
  ghProgHideT = setTimeout(() => { el.style.display = 'none'; }, ok ? 1500 : 3500);
}
// 1つのファイルを書く（同時に複数書けるように、個別に動く）
async function ghWriteFile(c, id, cur, o, path, step) {
  let sha = cur.shas[path];
  if (!sha) { const ex = await ghGetFile(c, path); sha = ex ? ex.sha : null; }
  const body = {
    message: 'room ' + id + ' ' + new Date().toISOString(),
    content: b64Enc(new TextEncoder().encode(JSON.stringify(o))),
    ...(sha ? { sha } : {})
  };
  let res = null;
  for (let i = 0; i < 3 && !res; i++) {                    // 電波の一時的な失敗は、少し待って再送
    try {
      res = await fetch('https://api.github.com/repos/' + c.repo + '/contents/' + path,
        { method: 'PUT', headers: { ...ghHeaders(c), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status >= 500) res = null;
    } catch (e) { res = null; }
    if (!res) await new Promise(r => setTimeout(r, 600 * (i + 1)));
  }
  if (!res) throw new Error('GitHubに届きませんでした（通信が不安定です）');
  if (res.ok) { if (step) step(); return 'ok'; }
  if (res.status === 409) return 'conflict';
  let msg = '';
  try { msg = (await res.json()).message || ''; } catch (e) {}
  throw new Error(ghErrText(res.status) + (msg ? '［GitHub: ' + msg + '］' : ''));
}
// 保存：他の人の分を取り込み、「中身が変わったファイルだけ」を並列に書く
async function ghPushOnce(id, kv, prog) {
  const c = ghCfg();
  if (!c || !id) return null;
  const P = prog || (() => {});
  let done = 0, total = 1;
  const step = () => { done++; P(done, total); };
  P(0, total);
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await ghPull(id, (g, n) => { total = n; done = g; P(done, total); }, true);
    await tick();
    const pullN = cur.parts || 1;
    if (total < pullN) total = pullN;
    done = Math.max(done, pullN);
    const merged = mergeKv(cur.kv, kv);                     // 他の人の保存も含めて1つにする
    const chunks = ghPack(merged.flatMap(ghSplitEntry));
    await tick();
    const changed = [];
    for (let k = 0; k < chunks.length; k++) {
      const path = ghPathOf(id, k);
      const sig = sigOfLocal(chunks[k]);
      const same = cur.raw && cur.raw[path] === sig && (k !== 0 || pullN === chunks.length);
      if (!same || !cur.shas[path]) changed.push(k);
      if (k % 4 === 3) await tick();
    }
    total = pullN + changed.length;
    P(done, total);
    const now = Date.now();
    const build = async k => {
      if (GZ_OK) {
        const d = VoxelNet.bytesToB64(await VoxelNet.gzipStr('{"kv":' + chunkStr(chunks[k]) + '}'));
        return k === 0 ? { v: 3, r: id, t: now, parts: chunks.length, z: 1, d } : { v: 3, r: id, t: now, z: 1, d };
      }
      return k === 0 ? { v: 2, r: id, t: now, parts: chunks.length, kv: chunks[k] } : { v: 2, r: id, t: now, kv: chunks[k] };
    };
    const writeK = async k => ghWriteFile(c, id, cur, await build(k), ghPathOf(id, k), step);
    const results = await Promise.all(changed.filter(k => k !== 0).map(writeK));
    let conflict = results.includes('conflict');
    if (!conflict && changed.includes(0)) conflict = (await writeK(0)) === 'conflict';
    if (!conflict) {
      await roomLocalSaveSafe(id, merged);
      P(total, total);
      return merged;
    }
  }
  throw new Error('GitHubへの保存が何度も競合しました');
}
// 端末の保存（背景で書く）。失敗しても GitHub 保存は成功にする
function roomLocalSaveSafe(id, merged) {
  if (window.VoxelIO && VoxelIO.ok()) return ioStreamPut('voxelcraft-net', 'kv', 'room:' + id, null, null, merged).catch(() => {});
  return idbSet('room:' + id, merged);
}
// 変更の印がある部屋を、30秒ごとにGitHubへ送る（背景に回って止まっても、次に開いたときに送る）
setInterval(() => { ghFlushDirty(); }, 8000);
// 画面を閉じる・背景に回す・電波が戻ったときにも、未送信分を送る
window.addEventListener('pagehide', () => ghFlushDirty());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') ghFlushDirty(); });
window.addEventListener('online', () => ghFlushDirty());
setTimeout(() => ghFlushDirty(), 3000);   // 起動直後に、前回送れなかった分を送る

async function joinRoom(id, password, keepLocal, name, tag, seed, creator) {
  disconnect(false);
  if (!id || !password) throw new Error('部屋IDとパスワードを入力してください');
  if (!window.VoxelNet) throw new Error('通信部品が読み込めていません');
  loadPct = 0;
  loadShow('参加の準備をしています…', 2);
  try {
    const proof = await proofOf(id, password);
    conn = { id, pw: password, name: name || '', tag: (tag || cfg.tag || '').trim(), seed: seed ?? null };
    if (conn.tag) { cfg.tag = conn.tag; saveCfg(); }
    fullSyncWanted = !!keepLocal;   // 部屋を作る時だけ、この端末の全体を送る
    // 参加するときは、この端末の編集データも空にする（シードが無いときは今のシードを使う）
    if (window.VoxelWorld) VoxelWorld.applySeed(conn.seed != null ? conn.seed : VoxelWorld.getSeed(), !keepLocal);
    // 部屋に入るときは、この端末の道路・駅・ダイヤを、部屋の状態に合わせて入れ替える（作るときは除く）
    if (!keepLocal && window.VoxelSync && VoxelSync.resetLocal) VoxelSync.resetLocal();

    // 手元の記録（端末）と GitHub の記録を同時に読む（待ち時間を短くする）
    loadShow('保存データを読み込んでいます…', 6);
    const [saved, gh] = await Promise.all([
      idbGet('room:' + id),
      ghCfg()
        ? ghPull(id, (g, n) => loadShow('GitHubから読み込んでいます（' + g + '/' + n + '）', 6 + 24 * g / n))
          .then(r => ({ ok: true, r }), e => ({ ok: false, e }))
        : Promise.resolve(null)
    ]);
    const kv = new Map(Array.isArray(saved) ? saved : []);
    if (!gh) {
      toast('この端末にはGitHub設定がないため、最新を読めません');
      // 初めて使う端末では、GitHub設定を入れると最新を読めるので、設定画面を開く（入るのは続けます）
      setTimeout(() => {
        if (confirm('この端末にはGitHub設定がないため、他の端末で保存された最新の作業を読めません。\n\nGitHubの設定（リポジトリ名と、この端末用のトークン）を入れますか？\n（「キャンセル」なら、今いる人からの情報だけで続けます）')) open();
      }, 300);
    } else if (gh.ok) {
      for (const [k, v] of mergeKv([...kv.entries()], gh.r.kv)) kv.set(k, v);
      toast('GitHubから最新の作業を読み込みました（' + gh.r.kv.length + '件）');
      if (conn) ghMarkDirty(id, true);      // 入ったあとに、手元の内容もGitHubへ送る
    } else {
      const why = gh.e && gh.e.message ? gh.e.message : '通信エラー';
      if (!confirm('GitHubから最新の作業を読めませんでした。\n理由：' + why + '\n\n古い可能性がある、この端末の保存で入りますか？\n（「キャンセル」なら入るのをやめます。通信が良い場所でもう一度お試しください）')) {
        conn = null; joining = false;
        throw new Error('GitHubから最新を読めなかったため、部屋への参加をやめました');
      }
      toast('この端末の保存で入ります（古い可能性があります）');
    }

    // 手元の作業を、少しずつ反映する（大きくても画面が止まらないように）
    joining = true;
    const list = [...kv.entries()];
    for (let i = 0; i < list.length; i += 300) {
      applyingRemote = true;
      try {
        for (const [key, val] of list.slice(i, i + 300)) applyOp({ key, v: val.v, del: val.del, ts: val.ts, peer: val.peer });
      } finally { applyingRemote = false; }
      loadShow('手元の作業を反映しています…', 30 + 12 * (i / Math.max(1, list.length)));
      await tick();
    }

    loadShow('部屋に接続しています…', 44);
    const snapDone = new Promise(r => { snapResolve = r; });
    let info = { others: 0 };
    try {
      info = await VoxelNet.start({ roomId: id, proof, tag: conn.tag, kv, creator: !!creator, hooks: netHooks() }) || info;
    } catch (e) {
      snapResolve = null; conn = null; joining = false;
      throw e;
    }
    saveRoomEntry({ id, name: conn.name, pw: password, tag: conn.tag, seed: conn.seed });
    if (ghCfg()) ghFlushDirty();
    refreshShare();
    setStatus(`接続中：「${conn.name || '共同都市'}」`);
    // 他の人がいる部屋では、最新の状態を受け取ってから入る（受け取りが遅いときは12秒で入る。続きは後から反映される）
    if (!creator && info.others > 0) {
      loadShow('最新の状態を受け取っています…', 50);
      await Promise.race([snapDone, new Promise(r => setTimeout(r, 12000))]);
    }
    snapResolve = null;
    joining = false;
    return id;
  } finally {
    loadHide();
  }
}

async function createRoom(name, password, tag) {
  if (password.length < 4) throw new Error('パスワードは4文字以上にしてください');
  const id = newRoomId();
  const seed = window.VoxelWorld ? VoxelWorld.getSeed() : null;
  await joinRoom(id, password, true, name, tag, seed, true);
  if (conn) conn.name = name;
  saveRoomEntry({ id, name, pw: password, tag: conn ? conn.tag : tag, seed });
  // 今のワールドと、道路・駅・ダイヤなどを、そのまま部屋に持ち込む
  if (window.VoxelSync && VoxelSync.announceAll) VoxelSync.announceAll();
  return id;
}

function disconnect(notify) {
  if (!conn) return;
  const kvNow = window.VoxelNet && VoxelNet.kv() ? [...VoxelNet.kv().entries()] : null;
  if (kvNow && ghCfg()) ghPush(conn.id, kvNow).catch(e => console.error(e));
  try { if (window.VoxelNet) VoxelNet.stop(); } catch (e) {}
  conn = null;
  joining = false;
  setStatus('オフライン（一人で遊べます）');
  if (notify !== false) toast('部屋から退室しました');
}

// ============================================================
// 保存した部屋・ゲーマータグの一覧（この端末に保存）
// ============================================================
function loadRooms() {
  try { return JSON.parse(localStorage.getItem(ROOMS_KEY) || '[]'); } catch (e) { return []; }
}
function saveRoomEntry(e) {
  try {
    const list = loadRooms().filter(r => r.id !== e.id);
    list.unshift({ ...e, lastUsed: Date.now() });
    localStorage.setItem(ROOMS_KEY, JSON.stringify(list.slice(0, 30)));
  } catch (err) {}
}
function removeRoomEntry(id) {
  try { localStorage.setItem(ROOMS_KEY, JSON.stringify(loadRooms().filter(r => r.id !== id))); } catch (e) {}
}
function renderRooms() {
  const box = document.getElementById('mpRooms');
  if (!box) return;
  const list = loadRooms();
  if (!list.length) { box.innerHTML = '<p class="note">まだ保存された部屋はありません。</p>'; return; }
  box.innerHTML = '';
  for (const r of list) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;margin:6px 0;flex-wrap:wrap';
    const label = document.createElement('div');
    label.style.cssText = 'flex:1;min-width:120px;font-size:13px';
    label.textContent = (r.name || '部屋') + '（タグ：' + (r.tag || '未設定') + '）';
    const join = document.createElement('button');
    join.className = 'btn'; join.style.width = 'auto'; join.style.marginTop = '0'; join.textContent = '参加';
    join.addEventListener('click', async () => {
      try {
        await joinRoom(r.id, r.pw, false, r.name, r.tag, r.seed);
        refreshShare(); toast('参加しました');
        close(); startIfNeeded();
      } catch (e) { toast(e.message); }
    });
    const del = document.createElement('button');
    del.className = 'btn danger'; del.style.width = 'auto'; del.style.marginTop = '0'; del.textContent = '削除';
    del.addEventListener('click', () => { removeRoomEntry(r.id); renderRooms(); });
    row.append(label, join, del);
    box.appendChild(row);
  }
}
function tagVal() {
  const el = document.getElementById('mpTag');
  return el ? el.value.trim() : (cfg.tag || '');
}

// ============================================================
// 共有リンク（部屋ID・パスワード・シードを含む。端末の住所は含まない）
// ============================================================
function gameUrl() {
  if (!/^https?:/.test(location.protocol)) return '';
  if (/^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname)) return '';
  return location.origin + location.pathname;
}
function shareUrl() {
  const code = encShare({ id: conn.id, pw: conn.pw, n: conn.name, sd: conn.seed });
  const g = gameUrl();
  return g ? g + '#vc=' + code : code;
}
function refreshShare() {
  const out = document.getElementById('mpShareOut');
  if (out) out.value = conn ? shareUrl() : '';
  const n = window.VoxelNet && VoxelNet.active() ? VoxelNet.linkCount() : 0;
  setStatus(conn ? `接続中：「${conn.name || '共同都市'}」（${n}人）` : 'オフライン（一人で遊べます）');
  const st = window.VoxelNet ? VoxelNet.stats() : { sent: 0, recv: 0, fail: 0 };
  const info = document.getElementById('mpInfo');
  if (info) info.innerHTML = conn
    ? `部屋名：${esc(conn.name || '共同都市')}<br>部屋ID：<code>${esc(conn.id)}</code><br>いま一緒にいる人：${n}人（最大8人）<br><small>ブロック：送${blockStats.sent}／受${blockStats.recv}（反映${blockStats.applied}）<br>通信部品 v${VoxelNet.version || 1}／送信${st.sent} / 受信${st.recv} / 失敗${st.fail}</small>` +
      (gameUrl() ? '' : '<br><b>※このアドレスは友達に渡せません。ゲームをインターネット上のアドレスから開いてください</b>')
    : '部屋には参加していません（一人で遊べます）。';
}

// ============================================================
// 画面
// ============================================================
// ============================================================
// 保存コード：部屋の作業をひとまとめにした文字列。別の端末に貼れば、作業を受け取れる
// ============================================================
const SAVE_PREFIX = 'vcs1:';       // 圧縮あり
const SAVE_PREFIX_RAW = 'vcs0:';   // 圧縮なし（この端末が圧縮に対応していないとき）
function b64uEnc(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDec(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function gzipBytes(bytes) {
  const cs = new CompressionStream('gzip');
  const w = cs.writable.getWriter(); w.write(bytes); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
async function gunzipBytes(bytes) {
  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter(); w.write(bytes); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}
async function encodeSave(obj) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if (window.CompressionStream) {
    try { return SAVE_PREFIX + b64uEnc(await gzipBytes(raw)); } catch (e) {}
  }
  return SAVE_PREFIX_RAW + b64uEnc(raw);
}
async function decodeSave(code) {
  code = String(code || '').trim();
  let bytes;
  if (code.startsWith(SAVE_PREFIX)) bytes = await gunzipBytes(b64uDec(code.slice(SAVE_PREFIX.length)));
  else if (code.startsWith(SAVE_PREFIX_RAW)) bytes = b64uDec(code.slice(SAVE_PREFIX_RAW.length));
  else throw new Error('保存コードの形式が違います');
  const o = JSON.parse(new TextDecoder().decode(bytes));
  if (!o || !Array.isArray(o.kv)) throw new Error('保存コードの中身が読めません');
  return o;
}
// 今の部屋の中身：接続中ならその場の最新、そうでなければ保存してあるもの
async function roomKvOf(id) {
  if (conn && conn.id === id && window.VoxelNet && VoxelNet.active() && VoxelNet.kv()) return [...VoxelNet.kv().entries()];
  const saved = await idbGet('room:' + id);
  return Array.isArray(saved) ? saved : [];
}
async function makeSaveCode(id) {
  const r = loadRooms().find(x => x.id === id) || {};
  const isNow = conn && conn.id === id;
  return encodeSave({
    v: 1, r: id,
    n: (isNow ? conn.name : r.name) || '',
    sd: (isNow ? conn.seed : r.seed) ?? null,
    kv: await roomKvOf(id)
  });
}
// 保存コードを読み込み、その部屋の保存データへ足す（同じ場所は新しい方を残す）
async function importSaveCode(code, idHint) {
  const o = await decodeSave(code);
  const id = o.r || idHint;
  if (!id) throw new Error('部屋IDが分かりません。参加欄に部屋IDを入れてください');
  if (idHint && o.r && idHint !== o.r) throw new Error('この保存コードは、入力された部屋IDとは別の部屋のものです');
  const saved = await idbGet('room:' + id);
  const m = new Map(Array.isArray(saved) ? saved : []);
  let added = 0;
  for (const [k, v] of o.kv) {
    const old = m.get(k);
    if (!old || (v.ts || 0) > (old.ts || 0)) { m.set(k, v); added++; }
  }
  await idbSet('room:' + id, [...m.entries()]);
  toast('保存コードを読み込みました（' + added + '件の作業を受け取りました）');
  return { id, seed: o.sd ?? null };
}

// 保存コードの画面（設定メニューの「保存コードを確認」から、いつでも開ける）
function buildSaveUI() {
  const box = document.createElement('div');
  box.id = 'mpSaveModal';
  box.style.cssText = 'position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;padding:16px;box-sizing:border-box';
  box.innerHTML = '<div style="background:#1b2430;color:#fff;border-radius:12px;padding:16px;max-width:460px;width:100%;font-family:sans-serif;box-sizing:border-box">' +
    '<h3 style="margin:0 0 8px">保存コード</h3>' +
    '<p style="font-size:13px;margin:0 0 8px;line-height:1.5">部屋での作業をまとめたコードです。別の端末で部屋に入るとき、参加欄の「保存コード」に貼ると作業を受け取れます。（部屋のパスワードは別に必要です）</p>' +
    '<select id="mpSaveRoom" style="width:100%;margin-bottom:8px"></select>' +
    '<textarea id="mpSaveOut" readonly rows="5" style="width:100%;box-sizing:border-box;font-size:12px"></textarea>' +
    '<p id="mpSaveSize" style="font-size:12px;color:#9fb3c8;margin:4px 0"></p>' +
    '<button class="btn" id="mpSaveCopy" style="width:100%;margin-top:6px">コピー</button>' +
    '<button class="btn sub" id="mpSaveClose" style="width:100%;margin-top:6px">閉じる</button></div>';
  document.body.appendChild(box);
  const $ = id => document.getElementById(id);
  const show = async () => {
    const id = $('mpSaveRoom').value;
    if (!id) return;
    const code = await makeSaveCode(id);
    $('mpSaveOut').value = code;
    $('mpSaveSize').textContent = '長さ：約' + Math.round(code.length / 1000) + '千文字';
  };
  const openSave = async () => {
    const ids = [];
    if (conn) ids.push(conn.id);
    for (const r of loadRooms()) if (!ids.includes(r.id)) ids.push(r.id);
    box.style.display = 'flex';
    if (!ids.length) { $('mpSaveRoom').innerHTML = ''; $('mpSaveOut').value = 'まだ部屋に入ったことがありません。'; $('mpSaveSize').textContent = ''; return; }
    $('mpSaveRoom').innerHTML = ids.map(id => {
      const r = loadRooms().find(x => x.id === id) || {};
      const nm = (conn && conn.id === id ? conn.name : r.name) || '共同都市';
      return '<option value="' + esc(id) + '">' + esc(nm) + '（' + esc(id) + '）</option>';
    }).join('');
    await show();
  };
  $('mpSaveRoom').addEventListener('change', show);
  $('mpSaveCopy').addEventListener('click', () => {
    const v = $('mpSaveOut').value;
    if (v && navigator.clipboard) navigator.clipboard.writeText(v).then(() => toast('コピーしました'), () => toast('コピーできませんでした。長押しして手動でコピーしてください'));
    else toast('長押しして手動でコピーしてください');
  });
  $('mpSaveClose').addEventListener('click', () => { box.style.display = 'none'; });

  // 設定メニューに「保存コードを確認」ボタンを置く
  const sbox = document.querySelector('#settings .sbox');
  if (sbox) {
    const b = document.createElement('button');
    b.id = 'mpSaveOpenBtn';
    b.className = 'btn sub';
    b.textContent = '保存コードを確認';
    b.style.marginTop = '8px';
    b.addEventListener('click', openSave);
    sbox.appendChild(b);
  }
}

function buildUI() {
  const style = document.createElement('style');
  style.textContent = `
  #mpPanel{position:fixed;inset:0;z-index:75;display:none;align-items:center;justify-content:center;
    background:rgba(5,10,16,.8);padding:12px;box-sizing:border-box}
  #mpPanel.show{display:flex}
  #mpPanel .box{background:#1b2530;color:#fff;border-radius:12px;padding:16px;width:min(94vw,460px);max-height:94vh;
    overflow:auto;box-sizing:border-box;font-family:sans-serif;font-size:14px}
  #mpPanel h2{margin:0 0 8px;font-size:18px}
  #mpPanel h3{margin:14px 0 6px;font-size:14px;color:#cfe3f5}
  #mpPanel input{width:100%;box-sizing:border-box;background:#2a3846;color:#fff;border:1px solid rgba(255,255,255,.3);
    border-radius:6px;padding:9px;font-size:14px;margin-top:4px}
  #mpPanel .btn{background:#2e6a9a;color:#fff;border:none;border-radius:8px;padding:10px 14px;font-size:14px;margin-top:8px;cursor:pointer;width:100%}
  #mpPanel .btn.sub{background:#3a4450}
  #mpPanel .btn.danger{background:#7a3030}
  #mpPanel .note{font-size:12px;color:#9fb3c8;line-height:1.6;margin:6px 0}
  #mpStatus{font-size:13px;color:#bff5c9;margin:6px 0}
  #mpToast{position:fixed;left:50%;top:22%;transform:translateX(-50%);background:rgba(0,0,0,.75);color:#fff;
    padding:8px 14px;border-radius:8px;z-index:90;opacity:0;transition:opacity .3s;pointer-events:none;font-size:13px;max-width:90vw}
  #mpToast.show{opacity:1}
  `;
  document.head.appendChild(style);

  panelEl = document.createElement('div');
  panelEl.id = 'mpPanel';
  panelEl.innerHTML = `<div class="box">
    <h2>マルチプレイ（共同都市）</h2>
    <p id="mpStatus"></p>
    <h3>部屋情報</h3>
    <div id="mpInfo" class="note"></div>
    <h3>ゲーマータグ</h3>
    <input id="mpTag" placeholder="例：たろう（何語でもOK）" maxlength="20">
    <p class="note">部屋で使う名前です。ブロックやオブジェクトに重ならないときだけ、頭の上に表示されます。</p>
    <h3>保存した部屋</h3>
    <div id="mpRooms"></div>
    <h3>部屋を作る</h3>
    <input id="mpNewName" placeholder="部屋の名前">
    <input id="mpNewPw" placeholder="パスワード（4文字以上・8文字以上推奨）" type="password" autocomplete="new-password">
    <button class="btn" id="mpCreate">部屋を作ってこのワールドを持ち込む</button>
    <p class="note">作った人がいなくても、部屋IDとパスワードを知っていれば誰でも参加・編集できます。</p>
    <h3>部屋に参加する</h3>
    <input id="mpShare" placeholder="共有リンク（vc1:…）を貼り付け">
    <input id="mpJoinId" placeholder="部屋ID">
    <input id="mpJoinPw" placeholder="パスワード" type="password" autocomplete="off">
    <textarea id="mpSaveIn" rows="2" placeholder="保存コード（あれば貼り付け。部屋の作業を受け取れます）" style="width:100%;box-sizing:border-box;font-size:12px"></textarea>
    <button class="btn" id="mpJoin">参加する（今のワールドは部屋のものに置き換わります）</button>
    <h3>共有</h3>
    <input id="mpShareOut" readonly placeholder="部屋に参加すると、ここに共有リンクが出ます">
    <details style="margin:6px 0;font-size:13px"><summary>GitHub に保存する設定（任意）</summary>
      <input id="mpGhRepo" placeholder="例：yourname/voxel-rooms（保存用のリポジトリ）">
      <input id="mpGhToken" type="password" autocomplete="off" placeholder="トークン（そのリポジトリの Contents の読み書きだけ）">
      <p class="note">トークンはこの端末にだけ保存されます。共有リンク・保存コードには入りません。</p>
      <button class="btn sub" id="mpGhSave">GitHub設定を保存</button>
      <button class="btn sub" id="mpGhSync">今すぐGitHubに保存</button>
    </details>
    <button class="btn sub" id="mpCopy">共有リンクをコピー</button>
    <button class="btn danger" id="mpLeave">退室する（一人で遊ぶ）</button>
    <button class="btn sub" id="mpClose">閉じる</button>
    <p class="note">共有リンクには部屋IDとパスワードが入っています。信頼できる人だけに渡してください。通信は端末どうしの直接接続のため、データ量の上限はありません。</p>
  </div>`;
  document.body.appendChild(panelEl);
  statusEl = document.getElementById('mpStatus');
  msgEl = document.createElement('div');
  msgEl.id = 'mpToast';
  document.body.appendChild(msgEl);

  // いつでも開ける「マルチ」ボタン（左上。位置を変えるなら left / top の数字を書き換える）
  const openBtn = document.createElement('button');
  openBtn.id = 'mpOpenBtn';
  openBtn.textContent = 'マルチ';
  openBtn.style.cssText = 'position:fixed;left:8px;top:56px;z-index:60;background:#2e6a9a;color:#fff;border:none;' +
    'border-radius:8px;padding:8px 12px;font-size:13px;opacity:.9;cursor:pointer;font-family:sans-serif';
  openBtn.addEventListener('click', open);
  document.body.appendChild(openBtn);

  const $ = id => document.getElementById(id);
  $('mpTag').value = cfg.tag || '';
  $('mpTag').addEventListener('change', () => { cfg.tag = tagVal(); saveCfg(); });
  $('mpCreate').addEventListener('click', async () => {
    try {
      if (!tagVal()) { toast('ゲーマータグを入力してください'); return; }
      cfg.tag = tagVal(); saveCfg();
      const id = await createRoom($('mpNewName').value.trim() || '共同都市', $('mpNewPw').value, tagVal());
      $('mpJoinId').value = id; $('mpJoinPw').value = $('mpNewPw').value;
      refreshShare();
      renderRooms();
      toast('部屋を作りました。共有リンクを友達に渡してください');
      close(); startIfNeeded();
    } catch (e) { toast(e.message); }
  });
  $('mpShare').addEventListener('change', () => {
    const d = decShare($('mpShare').value);
    if (!d) { toast('共有リンクの形式が違います'); return; }
    $('mpJoinId').value = d.id || ''; $('mpJoinPw').value = d.pw || '';
    pendingSeed = d.sd ?? null;
  });
  $('mpJoin').addEventListener('click', async () => {
    try {
      if (!tagVal()) { toast('ゲーマータグを入力してください'); return; }
      cfg.tag = tagVal(); saveCfg();
      const saveCode = $('mpSaveIn').value.trim();
      if (saveCode) {
        const r = await importSaveCode(saveCode, $('mpJoinId').value.trim());
        $('mpJoinId').value = r.id;
        if (r.seed != null && pendingSeed == null) pendingSeed = r.seed;
      }
      await joinRoom($('mpJoinId').value.trim(), $('mpJoinPw').value, false, '', tagVal(), pendingSeed);
      pendingSeed = null;
      $('mpSaveIn').value = '';
      refreshShare(); renderRooms();
      toast('参加しました');
      close(); startIfNeeded();
    } catch (e) { toast(e.message); }
  });
  $('mpCopy').addEventListener('click', () => {
    const v = $('mpShareOut').value;
    if (v && navigator.clipboard) navigator.clipboard.writeText(v).then(() => toast('コピーしました'), () => toast('コピーできませんでした'));
    else toast('長押しして手動でコピーしてください');
  });
  $('mpLeave').addEventListener('click', () => { disconnect(); refreshShare(); });
  $('mpClose').addEventListener('click', close);
  const gc = ghCfg() || {};
  $('mpGhRepo').value = gc.repo || '';
  $('mpGhToken').value = gc.token || '';
  $('mpGhSave').addEventListener('click', () => {
    const repo = normRepo($('mpGhRepo').value), token = $('mpGhToken').value.trim();
    if (!repo || !token) { toast('リポジトリ名とトークンを入れてください'); return; }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) { toast('リポジトリ名は「ユーザー名/リポジトリ名」の形で入れてください'); return; }
    ghSaveCfg({ repo, token });
    toast('GitHub設定を保存しました');
  });
  $('mpGhSync').addEventListener('click', async () => {
    if (!conn) { toast('部屋に入ってから押してください'); return; }
    const kv = window.VoxelNet && VoxelNet.kv() ? [...VoxelNet.kv().entries()] : [];
    try {
      await ghPush(conn.id, kv, (d, t) => ghProgSet(d, t));
      ghProgEnd('保存しました ✓', true);
    } catch (e) { ghProgEnd('保存できませんでした', false); toast(e.message); }
  });
  buildSaveUI();
  refreshShare();
}
function open() { refreshShare(); renderRooms(); panelEl.classList.add('show'); }
function close() { panelEl.classList.remove('show'); }
function startIfNeeded() { if (window.VoxelWorld) VoxelWorld.start(); }

// 共有リンクをそのまま開いたときは、参加欄へ入れておく
function prefillFromHash() {
  const h = location.hash.replace(/^#/, '');
  const m = h.match(/vc=([^&]+)/);
  if (!m) return;
  const d = decShare(decodeURIComponent(m[1]));
  if (!d) return;
  setTimeout(() => {
    const $ = id => document.getElementById(id);
    $('mpJoinId').value = d.id || ''; $('mpJoinPw').value = d.pw || '';
    pendingSeed = d.sd ?? null;
    open();
    toast('共有リンクを読み込みました。「参加する」を押してください');
  }, 300);
}

// ============================================================
// 公開する窓口（将来の機能はここに参加する）
// ============================================================
window.VoxelMulti = {
  peer,
  tag: () => (conn ? conn.tag : cfg.tag) || '',
  isJoining: () => joining,
  open,
  close,
  connected: () => !!conn && !!window.VoxelNet && VoxelNet.active(),
  roomId: () => conn ? conn.id : null,
  // カスタムブロックの定義の受け渡し用
  setBlockEncoder: fn => { blockEncoder = fn; },
  setBlockResolver: fn => { blockResolver = fn; },
  applyBlock: (x, y, z, t) => applyCell(x, y, z, t, stateStr(x, y, z, t)),
  setStateGetter: fn => { stateGetter = fn; },
  blockStats: () => ({ ...blockStats }),
  // 接頭語（例 "road"）の変更を受け取る。値は rec.v、消えたときは rec.del が true
  onOp: (prefix, fn) => handlers.set(prefix, fn),
  // 任意の値を送る。キーは「接頭語:名前」（例 "road:p123"）。eph=true は記録に残さない一時的な情報
  send,
  disconnect: () => disconnect()
};

function init() {
  loadCfg();
  buildUI();
  prefillFromHash();
}
init();
})();
