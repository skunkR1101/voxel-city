/* voxel-rt-unify.js  ワールド作業データの「統一」（同じ部屋の全員を、いま押した端末のワールドに揃える）
 *  ・統一ボタンを押した端末の、ワールド全体（シード＝地形の種類、ブロックの変更、道路・線路・列車などの作業データ、サウンド）を、
 *    部屋の記録（uni:…）に少しずつ入れる。記録ができたら、部屋にいる全員が、その内容に置き換わる（強制）
 *  ・統一用パスワード：初めて押すときに決める（PBKDF2 でハッシュにして部屋の記録に入れる）。
 *    押すときに、これを合わせないと統一できない。うっかり・気軽な上書きを防ぐためのもので、
 *    部屋の中の人が記録を読めば確かめられるので、完全な秘密ではない。
 *  ・統一の記録が新しくなったとき：入っている端末は強制的に読み込む（この端末の作業は置き換わる）。
 *    後から入った端末は、確認してから読み込む。
 *  ・統一より前のブロックの変更（blk:…）は、統一のあとは無視する（古い地形の変更が戻らないように）
 *  読み込み順：voxel-rt-state.js の後（voxel-rt-world.js より前でも後でもよい）
 */
(function () {
'use strict';

const L = window.VoxelRTLogic;
const KEYS = [
  'voxelcraft_road_v1', 'voxelcraft_dia_v1', 'voxelcraft_station_v1', 'voxelcraft_train_v1',
  'voxelcraft_traffic_v1', 'voxelcraft_crowd_v1', 'voxelcraft_ext_v1', 'voxelcraft_bag_v1',
  'voxelcraft_defdel_v1', 'voxelcraft_tilt_v1'
];
const GEN = 'uni:gen';                 // 統一の記録 {id, n, fp}（最後に入れる）
const PW = 'uni:pw';                   // パスワードの確かめ用 {salt, h}
const PART = 16000;                    // 統一データを分ける大きさ（文字数）
const PACE_MS = 40;                    // 1通ごとの間隔
const POLL_MS = 2000;
const JOIN_WINDOW_MS = 20000;          // 入ってからこの時間内に見つけた統一は「確認してから」読み込む
const PW_MIN = 4, PW_MAX = 64;
const ITER = 100000;
const ADOPT_LS = 'vcrt_uni_adopted_v1';// 端末ごとに、部屋ごとの「読み込み済みの統一」{roomId: {id, ts}}

let rm = null;
let attachedAt = 0;
let obsGen = null, obsForced = false;  // 見つけた統一の印と、入ったあとに出てきたものかどうか
let timers = [];
let pressing = false;
let adopting = false;
const declined = new Set();
let card = null, statusEl = null, unifyBtn = null, recvBtn = null;

function getLocal(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function setLocal(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
function fpOf(text) { return window.VoxelRTState.fpOf(text); }
function kvEntry(room, key) { return room.kv.get(key) || null; }
function kvGet(room, key) {
  const e = kvEntry(room, key);
  return e && !e.del && e.v !== undefined ? e.v : null;
}
function adoptedMap() {
  try { return JSON.parse(localStorage.getItem(ADOPT_LS) || '{}') || {}; } catch (e) { return {}; }
}
function adoptedFor(roomId) { const m = adoptedMap(); return m[roomId] || null; }
function setAdopted(roomId, rec) {
  const m = adoptedMap();
  m[roomId] = rec;
  setLocal(ADOPT_LS, JSON.stringify(m));
}
// 部屋に統一があって、まだこの端末が読み込んでいない（＝ワールド作業の同期は止めておく）
function busy() {
  if (!rm) return false;
  const g = kvGet(rm, GEN);
  if (!g || typeof g.id !== 'string') return false;
  const a = adoptedFor(rm.roomId);
  return !(a && a.id === g.id);
}

// ---------- パスワード ----------
function hex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
function unhex(s) { const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16); return a; }
async function hashPw(pw, saltHex) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations: ITER }, base, 256);
  return hex(new Uint8Array(bits));
}
function newSalt() { return hex(crypto.getRandomValues(new Uint8Array(16))); }
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

// ---------- 送る（少しずつ・部屋が変わったら止める） ----------
function sendAll(room, items) {
  return new Promise(resolve => {
    const list = items.slice();
    const step = () => {
      if (rm !== room) { resolve(false); return; }
      const it = list.shift();
      if (!it) { resolve(true); return; }
      try { if (it.del) room.del(it.key); else room.set(it.key, it.value); } catch (e) { console.error(e); }
      setTimeout(step, PACE_MS);
    };
    step();
  });
}

// ---------- 統一する（押した端末） ----------
async function press() {
  const room = rm;
  if (!room) { say('部屋に入ってから押してください'); return; }
  if (pressing) return;
  if (busy()) { say('部屋に統一データがあります。先に「統一データを受け取る」を押してください'); return; }
  if (!window.crypto || !crypto.subtle) { say('この画面では統一できません（暗号の機能がありません）'); return; }
  const pw = window.prompt('統一用パスワードを入力してください（初めての統一では、新しく決めて入力します）');
  if (pw === null) return;
  if (pw.length < PW_MIN || pw.length > PW_MAX) { say('パスワードは' + PW_MIN + '文字以上' + PW_MAX + '文字以下で入力してください'); return; }
  const v = kvGet(room, PW);
  if (v && typeof v.h === 'string') {
    if ((await hashPw(pw, v.salt)) !== v.h) { say('パスワードが違います'); return; }
  } else {
    const salt = newSalt();
    room.set(PW, { salt, h: await hashPw(pw, salt) });
  }
  if (!window.confirm('この端末のワールドを、同じ部屋の全員に上書きします。' +
    '地形・道路・線路・カスタムブロックなど、全員の今の作業は置き換わります。よろしいですか？')) return;

  pressing = true; updateUi();
  try {
    say('統一データを準備しています…');
    if (window.VoxelRTState && VoxelRTState.pushLocal) {
      VoxelRTState.forgetSent && VoxelRTState.forgetSent();   // 中身（テクスチャなど）も、すべて送り直す
      VoxelRTState.pushLocal(room, true);
    }
    // 作業データの送信が終わるまで待つ（最大1分）
    for (let i = 0; i < 300 && window.VoxelRTState && VoxelRTState.pending() > 0; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (rm !== room) return;
    }
    const save = VoxelWorld.buildSave();
    const ws = {};
    for (const k of KEYS) ws[k] = getLocal(k);
    const payload = JSON.stringify({
      format: 'vcrt-unify-1', seed: save.seed ?? null,
      edits: (save.base && save.base.edits) || [], sounds: save.sounds || [], ws
    });
    const id = newId();
    const n = Math.max(1, Math.ceil(payload.length / PART));
    const items = [];
    for (let i = 0; i < n; i++) items.push({ key: 'uni:' + id + ':p' + i, value: payload.slice(i * PART, (i + 1) * PART) });
    say('統一データを送っています…（' + n + '通）');
    if (!(await sendAll(room, items))) return;
    const prev = kvGet(room, GEN);
    room.set(GEN, { id, n, fp: fpOf(payload) });
    const entry = kvEntry(room, GEN);
    if (!entry || !entry.v || entry.v.id !== id) { say('統一できませんでした（部屋につながっていません）'); return; }
    setAdopted(room.roomId, { id, ts: entry.ts });
    // 前の統一データは片づける
    if (prev && typeof prev.id === 'string' && prev.n) {
      const dels = [];
      for (let i = 0; i < prev.n; i++) dels.push({ key: 'uni:' + prev.id + ':p' + i, del: true });
      sendAll(room, dels);
    }
    say('統一しました。同じ部屋の全員が、この端末のワールドに置き換わります');
  } catch (e) {
    console.error(e);
    say('統一できませんでした：' + ((e && e.message) || 'エラー'));
  } finally {
    pressing = false; updateUi();
  }
}

// ---------- 受け取る（ほかの端末が統一したとき） ----------
function readPayload(room, gen) {
  let s = '';
  for (let i = 0; i < gen.n; i++) {
    const p = kvGet(room, 'uni:' + gen.id + ':p' + i);
    if (typeof p !== 'string') return null;
    s += p;
  }
  return fpOf(s) === gen.fp ? s : null;
}
// 中身がそろっていれば、統一データを返す（まだなら null）
function readyFor(room, gen) {
  const text = readPayload(room, gen);
  if (text === null) return null;
  let data;
  try { data = JSON.parse(text); } catch (e) { return null; }
  if (!data || data.format !== 'vcrt-unify-1' || !data.ws) return null;
  const diffs = {};
  for (const k of KEYS) if (typeof data.ws[k] === 'string') diffs[k] = data.ws[k];
  if (window.VoxelRTState) {
    // 統一の中身は、この端末の同じ名前の中身より優先して書き直す（名前が同じでも別の中身のことがあるため）
    VoxelRTState.assembleBlobs(room, true);
    if (!VoxelRTState.allReady(room, diffs)) return null;
  }
  return data;
}
function putPending(seed, edits) {
  return new Promise((res, rej) => {
    const r = indexedDB.open('voxelcraft', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => {
      const t = r.result.transaction('kv', 'readwrite');
      t.objectStore('kv').put({ seed, edits }, 'pendingWorld');
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    };
    r.onerror = () => rej(r.error);
  });
}
// この端末のワールドを、統一されたものに置き換えて、再読み込みする
async function adopt(room, gen, ts, data) {
  if (adopting) return;
  adopting = true;
  try {
    for (const k of KEYS) { try { localStorage.removeItem(k); } catch (e) {} }
    for (const k of KEYS) {
      const v = data.ws[k];
      if (typeof v !== 'string') continue;
      if (k === 'voxelcraft_ext_v1' && window.VoxelExt && VoxelExt.importExtJson) await VoxelExt.importExtJson(v);
      else if (!setLocal(k, v)) throw new Error('保存できる容量が足りません');
    }
    if (window.VoxelDia && VoxelDia.importSounds) await VoxelDia.importSounds(data.sounds || []);
    await putPending(data.seed ?? null, data.edits || []);
  } catch (e) {
    adopting = false;
    console.error(e);
    say('統一データを読み込めませんでした（保存領域の容量が足りない可能性があります）');
    return;
  }
  setAdopted(room.roomId, { id: gen.id, ts });
  const inv = L.makeInvite(location.href, room.roomId, room.password);
  try { location.hash = inv.slice(inv.indexOf('#')); } catch (e) {}
  location.reload();
}

// 定期的に見る：統一が新しければ、読み込む（入ったばかりは確認してから）
function check(room) {
  if (!room || rm !== room || adopting) return;
  const e = kvEntry(room, GEN);
  if (!e || !e.v || typeof e.v.id !== 'string' || e.del) return;
  const gen = e.v;
  const a = adoptedFor(room.roomId);
  if (a && a.id === gen.id) return;
  if (obsGen !== gen.id) {
    // 初めて見た統一：入ったばかりに見つけたものは「確認してから」、入ったあとに出てきたものは強制
    obsForced = obsGen !== null || Date.now() - attachedAt > JOIN_WINDOW_MS;
    obsGen = gen.id;
  }
  const data = readyFor(room, gen);
  if (!data) { setStatusText('統一されたワールドを受け取っています…（そろうまで少し待ってください）'); return; }
  if (!obsForced) {
    if (declined.has(gen.id)) return;
    if (!window.confirm('この部屋では、ほかの人がワールドを統一しました。この端末のワールドを、統一されたものに置き換えます。' +
      'よろしいですか？（この端末だけの作業は置き換わります）')) { declined.add(gen.id); return; }
  }
  adopt(room, gen, e.ts, data);
}
function manualReceive() {
  const room = rm;
  if (!room) return;
  const e = kvEntry(room, GEN);
  if (!e || !e.v) return;
  const data = readyFor(room, e.v);
  if (!data) { say('まだ受け取り中です。そろってからもう一度押してください'); return; }
  if (!window.confirm('この端末のワールドを、統一されたものに置き換えます。この端末だけの作業は置き換わります。よろしいですか？')) return;
  adopt(room, e.v, e.ts, data);
}

// ---------- 画面 ----------
function say(msg) { setStatusText(msg); }
function setStatusText(msg) { if (statusEl) statusEl.textContent = msg; }
function updateUi() {
  if (!card) return;
  unifyBtn.disabled = !rm || pressing;
  recvBtn.style.display = busy() ? '' : 'none';
  if (!rm) setStatusText('部屋に入ると使えます。押した端末のワールドを、同じ部屋の全員に上書きします（統一用パスワードが必要）');
  else if (busy()) setStatusText('部屋に統一されたワールドがあります。「統一データを受け取る」を押すと、この端末のワールドが置き換わります');
}
function buildCard() {
  const host = document.getElementById('rtCard');
  if (!host) return false;
  card = document.createElement('div');
  card.className = 'card';
  card.style.marginTop = '8px';
  const h = document.createElement('h2'); h.textContent = 'ワールド作業データの統一';
  card.appendChild(h);
  statusEl = document.createElement('p'); statusEl.className = 'm';
  card.appendChild(statusEl);
  unifyBtn = document.createElement('button'); unifyBtn.className = 'go'; unifyBtn.textContent = 'ワールド作業データを統一';
  unifyBtn.addEventListener('click', () => { press(); });
  card.appendChild(unifyBtn);
  recvBtn = document.createElement('button'); recvBtn.className = 'go sub'; recvBtn.textContent = '統一データを受け取る';
  recvBtn.style.display = 'none';
  recvBtn.addEventListener('click', () => manualReceive());
  card.appendChild(recvBtn);
  host.parentNode.insertBefore(card, host.nextSibling);
  updateUi();
  return true;
}

// ---------- 部屋に入った・出た ----------
function attach(room) {
  timers.forEach(t => clearInterval(t)); timers = [];
  rm = room || null;
  attachedAt = Date.now();
  obsGen = null; obsForced = false;
  adopting = false;
  if (!rm) { updateUi(); return; }
  timers.push(setInterval(() => { check(rm); updateUi(); }, POLL_MS));
  updateUi();
}

// ブロックの変更を受け取るとき、統一より前のものは無視する（world.js から呼ぶ）
function skipBlk(key) {
  if (!rm) return false;
  const a = adoptedFor(rm.roomId);
  if (!a) return false;
  const e = kvEntry(rm, key);
  return !!e && typeof e.ts === 'number' && e.ts < a.ts;
}

function startUp() {
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (buildCard() || tries > 60) clearInterval(t);
  }, 200);
  if (window.VoxelRTUI && window.VoxelRTUI.onRoom) window.VoxelRTUI.onRoom(attach);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startUp);
else startUp();

window.VoxelRTUnify = { skipBlk, busy, press, check: () => check(rm), pending: () => pressing };
})();
