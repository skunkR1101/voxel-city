/* voxel-craft-multi.js (v2)  マルチプレイ（共同都市）のブラウザ側
 * 読み込み順：…→ save → multi    本体HTMLは変更しない
 *
 * ★ 作った人が一度だけ書き換える場所：下の DEFAULT_SERVER（Deno Deploy のアドレス）
 *
 * 考え方（完全共同制）：
 *  ・部屋に管理者はいない。部屋ID＋パスワード（または共有リンク）を知っている人は、いつでも参加・編集できる。
 *  ・ブロックの置く・壊すは「b:x,y,z」というキーで同期する。
 *  ・ほかの機能は VoxelMulti.onOp("接頭語", 受け取り関数) と VoxelMulti.send("接頭語:名前", 値) で同期に参加できる。
 *  ・変更の受け取りは2秒ごとの問い合わせ。60秒ごとに全体も取り直して、取りこぼしを防ぐ。
 */
(function () {
'use strict';

// ★★★ 作った人が一度だけ書き換える（例：https://voxel-city-xxxx.deno.dev）★★★
const DEFAULT_SERVER = 'https://YOUR-PROJECT.deno.dev';

const PROTOCOL = 1;
const CFG_KEY = 'voxelcraft_multi';
const SHARE_PREFIX = 'vc1:';
const FLUSH_MS = 150;
const MAX_BATCH = 300;
const POLL_MS = 2000;
const FULL_SYNC_MS = 60000;
const SERVER_IS_SET = !DEFAULT_SERVER.includes('YOUR-PROJECT');

const peer = Math.random().toString(36).slice(2, 10);
const AIR = 0;
let cfg = { server: SERVER_IS_SET ? DEFAULT_SERVER : location.origin };
let conn = null;                 // { id, pw, server, name, seq }
let outbox = [];
let flushT = null;
let pollT = null, syncT = null, pollBusy = false;
let applyingRemote = false;
let joining = false;             // 参加時に部屋の状態を受け取っている最中か
const ROOMS_KEY = 'voxelcraft_rooms_v1';
const handlers = new Map();      // 接頭語 -> 受け取り関数
let panelEl = null, statusEl = null, msgEl = null, msgT = 0;

// ============================================================
// 補助
// ============================================================
function loadCfg() {
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(CFG_KEY) || '{}')); } catch (e) {}
  if (!cfg.server) cfg.server = SERVER_IS_SET ? DEFAULT_SERVER : location.origin;
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
  const t = raw.slice(at);
  let b = t.slice(SHARE_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  try { return JSON.parse(decodeURIComponent(escape(atob(b)))); } catch (e) { return null; }
}
async function api(path, body, method) {
  const base = conn ? conn.server : cfg.server;
  let r;
  try {
    r = await fetch(base + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    throw new Error('サーバーに接続できません。アドレスと通信を確認してください');
  }
  let j = {};
  try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error(j.error || ('サーバーエラー（' + r.status + '）'));
  if (j.protocol !== undefined && j.protocol !== PROTOCOL) throw new Error('サーバーとプロトコルが違います');
  return j;
}

// ============================================================
// 送信（ブロックの置く・壊す、ほかの機能の変更）
// ============================================================
function enqueue(op) {
  outbox.push(op);
  if (!flushT) flushT = setTimeout(flush, FLUSH_MS);
}
async function flush() {
  flushT = null;
  if (!conn || !outbox.length) return;
  const batch = outbox.splice(0, MAX_BATCH);
  try {
    await api(`/api/rooms/${conn.id}/ops`, { password: conn.pw, ops: batch });
  } catch (e) {
    outbox = batch.concat(outbox);        // 失敗したら残して、あとで送り直す
    setStatus('送信できません。つながるまで待っています…');
    flushT = setTimeout(flush, 3000);
    return;
  }
  if (outbox.length) flushT = setTimeout(flush, FLUSH_MS);
}
// 任意の値を部屋に書く（ほかの機能用）。del=true で消す
function send(key, value, del) {
  if (!conn) return;
  enqueue({ key, v: del ? undefined : value, ts: Date.now(), peer, del: !!del });
}

// ブロックの置く・壊すを横取りして送る（ローカルの変更は普通どおり行う）
const origSetBlock = window.setBlock;
window.setBlock = function (x, y, z, t) {
  origSetBlock(x, y, z, t);
  if (conn && !applyingRemote) enqueue({ key: 'b:' + x + ',' + y + ',' + z, v: t, ts: Date.now(), peer });
};

// ============================================================
// 受信
// ============================================================
function applyOp(rec) {
  if (!rec || typeof rec.key !== 'string') return;
  const key = rec.key;
  if (key.startsWith('b:')) {
    const p = key.slice(2).split(',').map(Number);
    if (p.length !== 3 || p.some(n => !Number.isInteger(n))) return;
    const t = rec.del ? AIR : rec.v;
    if (!Number.isInteger(t)) return;
    applyingRemote = true;
    try { origSetBlock(p[0], p[1], p[2], t); } finally { applyingRemote = false; }
    return;
  }
  if (key === 'seed') return;
  const prefix = key.split(':')[0];
  const fn = handlers.get(prefix);
  if (fn) { try { fn(rec); } catch (e) { console.error(e); } }
}

// 2秒ごとに「前回から後の変更」を聞く
async function pollOnce() {
  if (!conn || pollBusy) return;
  pollBusy = true;
  const c = conn;
  try {
    const j = await api(`/api/rooms/${c.id}/poll`, { password: c.pw, since: c.seq });
    if (conn !== c) return;
    if (j.resync) { await fullResync(); return; }
    for (const r of j.ops) {
      applyOp(r);
      if (r.seq > c.seq) c.seq = r.seq;
    }
    setStatus(`接続中：「${c.name}」`);
  } catch (e) {
    setStatus('通信できません。つながるまで待っています…');
  } finally {
    pollBusy = false;
  }
}
// 部屋の状態をすべて受け取る（参加時・定期・取りこぼし時）
async function fullResync() {
  const c = conn;
  if (!c || outbox.length) return;      // 送信待ちがあるときは、送ってから取り直す
  const j = await api(`/api/rooms/${c.id}/join`, { password: c.pw });
  applyingRemote = true;
  try {
    for (const [key, val] of j.kv) {
      if (key === 'seed') continue;
      applyOp({ key, v: val.v, del: val.del });
    }
  } finally { applyingRemote = false; }
  if (conn === c) c.seq = j.seq;
}
function startStream() {
  stopStream();
  pollT = setInterval(pollOnce, POLL_MS);
  syncT = setInterval(() => { fullResync().catch(() => {}); }, FULL_SYNC_MS);
}
function stopStream() {
  clearInterval(pollT); clearInterval(syncT);
  pollT = syncT = null;
}

// ============================================================
// 部屋の作成・参加・退室
// ============================================================
async function createRoom(name, password, tag) {
  if (password.length < 4) throw new Error('パスワードは4文字以上にしてください');
  const seed = window.VoxelWorld ? VoxelWorld.getSeed() : null;
  const j = await api('/api/rooms', { name, password, seed }, 'POST');
  await joinRoom(j.id, password, true, name, tag);
  // 今のワールドを、そのまま部屋に持ち込む
  const local = window.VoxelWorld ? VoxelWorld.buildSave().base.edits : [];
  for (const [cx, cy, cz, list] of local) {
    for (const [i, t] of list) {
      const x = cx * 16 + (i & 15), y = cy * 16 + ((i >> 4) & 15), z = cz * 16 + ((i >> 8) & 15);
      enqueue({ key: 'b:' + x + ',' + y + ',' + z, v: t, ts: Date.now(), peer });
    }
  }
  return j.id;
}
async function joinRoom(id, password, keepLocal, name, tag) {
  disconnect(false);
  const j = await api(`/api/rooms/${id}/join`, { password }, 'POST');
  conn = { id, pw: password, server: cfg.server, seq: 0, name: j.name || name || '', tag: (tag || cfg.tag || '').trim() };
  if (conn.tag) { cfg.tag = conn.tag; }
  if (window.VoxelWorld) VoxelWorld.applySeed(j.seed, !keepLocal);
  joining = true;
  applyingRemote = true;
  try {
    for (const [key, val] of j.kv) {
      if (key === 'seed') continue;
      applyOp({ key, v: val.v, del: val.del });
    }
  } finally { applyingRemote = false; }
  conn.seq = j.seq;
  joining = false;
  startStream();
  setStatus(`接続中：「${conn.name}」`);
  saveCfg();
  saveRoomEntry({ id, name: j.name || name || '', server: cfg.server, pw: password, tag: conn.tag });
  return j;
}

// ============================================================
// 保存した部屋・ゲーマータグの一覧（この端末のブラウザに保存）
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
        cfg.server = r.server || cfg.server; saveCfg();
        await joinRoom(r.id, r.pw, false, r.name, r.tag);
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
function disconnect(notify) {
  if (!conn) return;
  stopStream();
  conn = null;
  outbox = [];
  clearTimeout(flushT); flushT = null;
  setStatus('オフライン（一人で遊べます）');
  if (notify !== false) toast('部屋から退室しました');
}

// ============================================================
// 共有リンク
// ============================================================
// ゲームを開いているアドレス（https で開いている場合のみ。自分の端末の中だけのアドレスは渡せない）
function gameUrl() {
  if (!/^https?:/.test(location.protocol)) return '';
  if (/^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname)) return '';
  return location.origin + location.pathname;
}
function shareUrl() {
  const code = encShare({ s: conn.server, id: conn.id, pw: conn.pw, n: conn.name });
  const g = gameUrl();
  return g ? g + '#vc=' + code : code;
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
    <input id="mpNewPw" placeholder="パスワード（8文字以上を推奨）" type="password" autocomplete="new-password">
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
    <h3>サーバー（通常は変更不要）</h3>
    <input id="mpServer" placeholder="https://…deno.dev">
    <p class="note">共有リンクには部屋IDとパスワードが入っています。信頼できる人だけに渡してください。</p>
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
  $('mpServer').value = cfg.server;
  $('mpTag').value = cfg.tag || '';
  $('mpTag').addEventListener('change', () => { cfg.tag = tagVal(); saveCfg(); });
  $('mpServer').addEventListener('change', () => {
    cfg.server = $('mpServer').value.trim().replace(/\/+$/, '') || (SERVER_IS_SET ? DEFAULT_SERVER : location.origin);
    saveCfg();
  });
  $('mpCreate').addEventListener('click', async () => {
    try {
      if (!tagVal()) { toast('ゲーマータグを入力してください'); return; }
      cfg.tag = tagVal(); saveCfg();
      const id = await createRoom($('mpNewName').value.trim() || '共同都市', $('mpNewPw').value, tagVal());
      $('mpJoinId').value = id; $('mpJoinPw').value = $('mpNewPw').value;
      refreshShare();
      toast('部屋を作りました。共有リンクを友達に渡してください');
      close(); startIfNeeded();
    } catch (e) { toast(e.message); }
  });
  $('mpShare').addEventListener('change', () => {
    const d = decShare($('mpShare').value);
    if (!d) { toast('共有リンクの形式が違います'); return; }
    $('mpServer').value = d.s || cfg.server; $('mpJoinId').value = d.id || ''; $('mpJoinPw').value = d.pw || '';
  });
  $('mpJoin').addEventListener('click', async () => {
    try {
      cfg.server = $('mpServer').value.trim().replace(/\/+$/, '') || cfg.server; saveCfg();
      if (!tagVal()) { toast('ゲーマータグを入力してください'); return; }
      cfg.tag = tagVal(); saveCfg();
      await joinRoom($('mpJoinId').value.trim(), $('mpJoinPw').value, false, '', tagVal());
      refreshShare();
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
function refreshShare() {
  const out = document.getElementById('mpShareOut');
  if (!out) return;
  out.value = conn ? shareUrl() : '';
  setStatus(conn ? `接続中：「${conn.name}」` : 'オフライン（一人で遊べます）');
  const info = document.getElementById('mpInfo');
  if (info) info.innerHTML = conn
    ? `部屋名：${esc(conn.name)}<br>部屋ID：<code>${esc(conn.id)}</code><br>サーバー：${esc(conn.server)}` +
      (gameUrl() ? '' : '<br><b>※このアドレスは友達に渡せません。ゲームをインターネット上のアドレスから開いてください</b>')
    : '部屋には参加していません（一人で遊べます）。';
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
    $('mpServer').value = d.s || cfg.server; $('mpJoinId').value = d.id || ''; $('mpJoinPw').value = d.pw || '';
    $('mpShare').value = '';
    open();
    toast('共有リンクを読み込みました。「参加する」を押してください');
  }, 300);
}

// ============================================================
// 公開する窓口（将来の機能はここに参加する）
// ============================================================
window.VoxelMulti = {
  PROTOCOL,
  peer,
  tag: () => (conn ? conn.tag : cfg.tag) || '',
  isJoining: () => joining,
  open,
  close,
  connected: () => !!conn,
  roomId: () => conn ? conn.id : null,
  // 接頭語（例 "road"）の変更を受け取る。値は rec.v、消えたときは rec.del が true
  onOp: (prefix, fn) => handlers.set(prefix, fn),
  // 任意の値を送る。キーは「接頭語:名前」（例 "road:p123"）
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
