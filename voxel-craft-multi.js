/* voxel-craft-multi.js (v3)  マルチプレイ（共同都市）：サーバーなし版
 * 読み込み順： … save → net → multi → custom → players → ui   本体HTMLは変更しない
 *
 * 通信は voxel-craft-net.js が担当（端末どうしを直接つなぐ。部屋ごとに最大8人）。
 * このファイルは、部屋の作成・参加・共有リンク・保存した部屋の一覧・ブロックの同期を担当する。
 */
(function () {
'use strict';

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
function sendBlock(x, y, z, t) {
  const v = blockEncoder ? blockEncoder(x, y, z, t) : t;
  send('b:' + x + ',' + y + ',' + z, v, false, false);
}
// ブロックの置く・壊すを横取りして送る（ローカルの変更は普通どおり行う）
// 送るのは、設置の処理（色・向きの設定まで）が終わったあと。そのため、マイクロタスクで送る
window.setBlock = function (x, y, z, t) {
  origSetBlock(x, y, z, t);
  if (conn && !applyingRemote) queueMicrotask(() => { if (conn) sendBlock(x, y, z, t); });
};

// ============================================================
// 受信（届いた変更を、ワールドとほかの機能へ反映）
// ============================================================
function applyOp(rec) {
  if (!rec || typeof rec.key !== 'string') return;
  const key = rec.key;
  if (key.startsWith('b:')) {
    const p = key.slice(2).split(',').map(Number);
    if (p.length !== 3 || p.some(n => !Number.isInteger(n))) return;
    const t = blockResolver ? blockResolver(p[0], p[1], p[2], rec) : (rec.del ? AIR : rec.v);
    if (t === null || t === undefined || !Number.isInteger(t)) return;
    applyingRemote = true;
    try { origSetBlock(p[0], p[1], p[2], t); } finally { applyingRemote = false; }
    return;
  }
  if (key === 'seed') return;
  const prefix = key.split(':')[0];
  const fn = handlers.get(prefix);
  if (fn) { try { fn(rec); } catch (e) { console.error(e); } }
}

// ============================================================
// 部屋の作成・参加・退室
// ============================================================
function netHooks() {
  return {
    onEntry: rec => applyOp(rec),
    onEph: rec => applyOp(rec),
    onSnapDone: () => { joining = false; refreshShare(); toast('部屋の状態を受け取りました'); },
    onLinks: () => refreshShare(),
    save: kv => { if (conn) idbSet('room:' + conn.id, [...kv.entries()]); }
  };
}

async function joinRoom(id, password, keepLocal, name, tag, seed, creator) {
  disconnect(false);
  if (!id || !password) throw new Error('部屋IDとパスワードを入力してください');
  if (!window.VoxelNet) throw new Error('通信部品が読み込めていません');
  const proof = await proofOf(id, password);
  conn = { id, pw: password, name: name || '', tag: (tag || cfg.tag || '').trim(), seed: seed ?? null };
  if (conn.tag) { cfg.tag = conn.tag; saveCfg(); }
  if (window.VoxelWorld && conn.seed != null) VoxelWorld.applySeed(conn.seed, !keepLocal);

  // 前に保存しておいた部屋の記録を、まず自分のワールドへ反映（一人でも続きから遊べる）
  const saved = await idbGet('room:' + id);
  const kv = new Map(Array.isArray(saved) ? saved : []);
  joining = true;
  applyingRemote = true;
  try {
    for (const [key, val] of kv) applyOp({ key, v: val.v, del: val.del, ts: val.ts, peer: val.peer });
  } finally { applyingRemote = false; }

  try {
    await VoxelNet.start({ roomId: id, proof, tag: conn.tag, kv, creator: !!creator, hooks: netHooks() });
  } catch (e) {
    conn = null; joining = false;
    throw e;
  }
  saveRoomEntry({ id, name: conn.name, pw: password, tag: conn.tag, seed: conn.seed });
  refreshShare();
  setStatus(`接続中：「${conn.name || '共同都市'}」`);
  return id;
}

async function createRoom(name, password, tag) {
  if (password.length < 4) throw new Error('パスワードは4文字以上にしてください');
  const id = newRoomId();
  const seed = window.VoxelWorld ? VoxelWorld.getSeed() : null;
  await joinRoom(id, password, true, name, tag, seed, true);
  if (conn) conn.name = name;
  saveRoomEntry({ id, name, pw: password, tag: conn ? conn.tag : tag, seed });
  // 今のワールドを、そのまま部屋に持ち込む
  const local = window.VoxelWorld ? VoxelWorld.buildSave().base.edits : [];
  for (const [cx, cy, cz, list] of local) {
    for (const [i, t] of list) {
      const x = cx * 16 + (i & 15), y = cy * 16 + ((i >> 4) & 15), z = cz * 16 + ((i >> 8) & 15);
      sendBlock(x, y, z, t);
    }
  }
  return id;
}

function disconnect(notify) {
  if (!conn) return;
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
    ? `部屋名：${esc(conn.name || '共同都市')}<br>部屋ID：<code>${esc(conn.id)}</code><br>いま一緒にいる人：${n}人（最大8人）<br><small>通信：送信${st.sent} / 受信${st.recv} / 失敗${st.fail}</small>` +
      (gameUrl() ? '' : '<br><b>※このアドレスは友達に渡せません。ゲームをインターネット上のアドレスから開いてください</b>')
    : '部屋には参加していません（一人で遊べます）。';
}

// ============================================================
// 画面
// ============================================================
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
    <button class="btn" id="mpJoin">参加する（今のワールドは部屋のものに置き換わります）</button>
    <h3>共有</h3>
    <input id="mpShareOut" readonly placeholder="部屋に参加すると、ここに共有リンクが出ます">
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
      await joinRoom($('mpJoinId').value.trim(), $('mpJoinPw').value, false, '', tagVal(), pendingSeed);
      pendingSeed = null;
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
  applyBlock: (x, y, z, t) => {
    applyingRemote = true;
    try { origSetBlock(x, y, z, t); } finally { applyingRemote = false; }
  },
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
