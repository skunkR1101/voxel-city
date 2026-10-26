/* voxel-craft-net.js (v2)  サーバーなしの通信（端末どうしを直接つなぐ）
 *
 * 仕組み
 *  ・部屋ごとに「席」を最大8つ用意する。席の番号つきの名前（ID）を、公開の仲介サービス（PeerJS）で取る。
 *    席に座った人どうしが直接つながる（WebRTC）。仲介は最初の接続の手配だけに使い、データは通らない。
 *  ・相手と複数の接続ができても、開いているすべての接続に送る（どれか1本が切れても届く）。
 *    同じ変更が複数の経路で届いても、一度だけ処理する。
 *  ・変更は全員に届く。届かない相手へは、間にいる人が中継する。
 *  ・同じ場所を同時に変えたら、時刻の新しい方が勝つ。
 *  ・新しく入った人、または再接続した人は、つながった人から部屋の全体をもらう。
 *  ・1通の大きさは上限以下に分けて送る（ブラウザの通信は1通約256KBまで）。
 *  ・20秒ごとに全体の印（件数とハッシュ）を比べ、ずれが続けば全体を取り直す。
 *
 * 注意
 *  ・直接つながらない回線（一部のスマホ回線など）では、接続できないことがある。
 *  ・同時に入れるのは8人まで。
 */
(function () {
'use strict';

const PEERJS_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
const MAX_SLOTS = 8;
const MSG_MAX = 60000;           // 1通の大きさの上限（文字数）
const FLUSH_MS = 120;            // 変更をまとめて送る間隔
const SEEN_MAX = 20000;
const RETRY_MS = 10000;
const SAVE_MS = 3000;
const SUM_MS = 20000;            // 全体の一致を確かめる間隔
const RESYNC_MS = 60000;         // 再接続のとき全体を取り直すまでの最短間隔

const stats = { sent: 0, recv: 0, fail: 0, sumMis: 0 };
let S = null;                    // 現在の接続（1つだけ）
let linkSeq = 0;
let kvVer = 0, sumCache = null;

function newer(a, b) {
  if (!b) return true;
  if (a.ts !== b.ts) return a.ts > b.ts;
  return String(a.peer) > String(b.peer);
}
// 時計ずれ対策：端末の時計が遅れていても、見たことのある一番新しい時刻より後になるように印を付ける
let clk = 0;
function nowTs() { clk = Math.max(Date.now(), clk + 1); return clk; }
function seeTs(ts) { if (typeof ts === 'number' && isFinite(ts) && ts > clk) clk = ts; }
function slotId(roomId, k) { return 'vcx1-' + roomId + '-' + k; }

function loadPeerJs() {
  if (window.Peer) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = PEERJS_URL;
    s.onload = () => (window.Peer ? res() : rej(new Error('通信部品の読み込みに失敗しました')));
    s.onerror = () => rej(new Error('通信部品を読み込めません。インターネットの接続を確認してください'));
    document.head.appendChild(s);
  });
}

// 通信の経路（STUN：直接つなぐ。TURN：直接つながらないときの中継。TURN は設定画面で任意に入れる）
const TURN_KEY = 'voxelcraft_turn_v1';
function iceConfig() {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  try {
    const t = JSON.parse(localStorage.getItem(TURN_KEY) || 'null');
    if (t && t.url) iceServers.push({ urls: t.url, username: t.user || undefined, credential: t.pass || undefined });
  } catch (e) {}
  return { iceServers, iceCandidatePoolSize: 4 };
}
// 席を1つ取る。取れなければ null（その席は使用中）
function tryOpen(id) {
  return new Promise((res, rej) => {
    const p = new window.Peer(id, { debug: 0, config: iceConfig() });
    let done = false;
    p.on('open', () => { if (!done) { done = true; res(p); } });
    p.on('error', e => {
      if (done) return;
      done = true;
      try { p.destroy(); } catch (_) {}
      if (e && e.type === 'unavailable-id') res(null);
      else rej(new Error('通信の準備に失敗しました（' + (e && e.type || '不明') + '）'));
    });
  });
}

function safeSend(conn, msg) {
  try { conn.send(msg); stats.sent++; }
  catch (e) { stats.fail++; console.error('送信できませんでした', e && e.message); }
}

function applyEntry(s, key, val) {
  const cur = s.kv.get(key);
  if (cur && !newer(val, cur)) return false;
  s.kv.set(key, val);
  kvVer++; sumCache = null;
  return true;
}

// 相手ごとに「つながっている人数」を数える（同じ相手の複数の接続は1人と数える）
function peerCount(s) {
  const ids = new Set();
  for (const L of s.links.values()) if (L.ok) ids.add(L.pid);
  return ids.size;
}
function notifyLinks(s) {
  s.hooks.onLinks && s.hooks.onLinks(peerCount(s) + 1);   // 自分を含む人数
}

function sendHello(s, L) {
  if (!L.conn.open) return;
  safeSend(L.conn, { t: 'hello', proof: s.proof, tag: s.tag });
  L.helloSent = true;
}

function attach(s, conn) {
  const L = { id: ++linkSeq, pid: conn.peer, conn, ok: false, name: '', helloSent: false, t: Date.now(), mis: 0 };
  s.links.set(L.id, L);
  conn.on('open', () => { if (!L.helloSent) sendHello(s, L); });
  conn.on('data', m => { try { onData(s, L, m); } catch (e) { console.error(e); } });
  const drop = () => { if (s.links.delete(L.id)) notifyLinks(s); };
  conn.on('close', drop);
  conn.on('error', drop);
  if (conn.open) sendHello(s, L);
}

function onData(s, L, m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'hello') {
    if (m.proof !== s.proof) {                 // 合言葉が違う相手は切る
      try { L.conn.close(); } catch (_) {}
      s.links.delete(L.id);
      return;
    }
    const first = !L.ok;
    L.ok = true;
    L.name = String(m.tag || '').slice(0, 30);
    if (!L.helloSent) sendHello(s, L);
    if (first) {
      notifyLinks(s);
      const now = Date.now();
      if (!s.haveSnap && !s.askFrom) askSnapshot(s, L);     // 全体は1人からもらう（重複を避けて速くする）
      else if (s.haveSnap && now - (s.lastNeed || 0) > RESYNC_MS) {
        s.lastNeed = now;
        safeSend(L.conn, { t: 'need' });       // 再接続したときなど、食い違いを取り直す
      }
    }
    return;
  }
  if (!L.ok) return;                           // 合言葉を確かめる前の相手の情報は使わない
  stats.recv++;
  switch (m.t) {
    case 'sum': checkSum(s, L, m); break;
    case 'need': sendSnapshot(s, L).catch(e => console.error(e)); break;
    case 'snap': onSnapPiece(s, L, m); break;
    case 'ops': onOps(s, m.ops, L.pid); break;
  }
}

// 1通の大きさを上限以下に保って、配列を分ける
function packBy(items, max) {
  const out = []; let cur = [], size = 2;
  for (const it of items) {
    const n = JSON.stringify(it).length + 1;
    if (cur.length && size + n > max) { out.push(cur); cur = []; size = 2; }
    cur.push(it); size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

// 文字列を一定の大きさに分ける
function splitStr(str, size) {
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out;
}
const SNAP_PIECE = 60000;             // 1通の大きさ（文字数）
const HAS_GZ = typeof CompressionStream === 'function' && typeof Response === 'function' && typeof Blob === 'function';
async function gzipStr(str) {
  const bytes = new TextEncoder().encode(str);
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  return new Uint8Array(buf);
}
async function gunzipStr(bytes) {
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}
function bytesToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBytes(b64) {
  const bin = atob(b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// 全体を、圧縮してから分けて送る（容量が大きくても、通信量を小さくする）
async function sendSnapshot(s, L) {
  const json = JSON.stringify([...s.kv.entries()]);
  let z = 0, body = json;
  if (HAS_GZ && json.length > 1000) {
    try { body = bytesToB64(await gzipStr(json)); z = 1; } catch (e) { body = json; z = 0; }
  }
  const pieces = splitStr(body, SNAP_PIECE);
  if (!pieces.length) pieces.push('');
  pieces.forEach((d, i) => safeSend(L.conn, { t: 'snap', i, n: pieces.length, z, d }));
}

// 1人からだけ全体を受け取る。届かなければ、別の人に頼み直す
function askSnapshot(s, L) {
  s.askFrom = L.id;
  s.askAt = Date.now();
  s.lastNeed = Date.now();
  safeSend(L.conn, { t: 'need' });
}
function onSnapPiece(s, L, m) {
  if (!m || typeof m.n !== 'number' || typeof m.i !== 'number') return;
  if (!s.snapIn || s.snapIn.from !== L.id) {
    if (s.snapIn && s.snapIn.from !== L.id) return;          // 別の人からの途中の分は無視
    s.snapIn = { from: L.id, n: m.n, z: m.z, parts: [], got: 0 };
  }
  const sn = s.snapIn;
  if (sn.parts[m.i] === undefined) { sn.parts[m.i] = String(m.d || ''); sn.got++; }
  s.askAt = Date.now();
  s.hooks.onSnapProgress && s.hooks.onSnapProgress(sn.got, sn.n);
  if (sn.got >= sn.n) finishSnap(s);
}
async function finishSnap(s) {
  const sn = s.snapIn;
  if (!sn) return;
  s.snapIn = null;
  let list = [];
  try {
    const body = sn.parts.join('');
    const json = sn.z ? await gunzipStr(b64ToBytes(body)) : body;
    list = JSON.parse(json);
  } catch (e) {
    console.error('全体の受け取りに失敗しました', e);
    s.askFrom = null;                                        // 別の人に頼み直す
    return;
  }
  // 受け取った分を、少しずつ反映する（画面が止まらないように）
  let i = 0;
  const CHUNK = 400;
  await new Promise(resolve => {
    (function step() {
      if (S !== s) return resolve();
      const end = Math.min(list.length, i + CHUNK);
      for (; i < end; i++) {
        const [key, val] = list[i];
        if (!val || typeof key !== 'string') continue;
        seeTs(val.ts);
        if (applyEntry(s, key, val)) s.hooks.onEntry && s.hooks.onEntry({ key, v: val.v, del: !!val.del, ts: val.ts, peer: val.peer });
      }
      if (i < list.length) setTimeout(step, 0); else resolve();
    })();
  });
  persistSoon(s);
  markHaveSnap(s);
}
function markHaveSnap(s) {
  s.haveSnap = true;
  s.askFrom = null;
  if (!s.doneSent) { s.doneSent = true; s.hooks.onSnapDone && s.hooks.onSnapDone(true); }
}

function onOps(s, ops, fromPid) {
  if (!Array.isArray(ops)) return;
  const fwd = [];
  for (const op of ops) {
    if (!op || typeof op.key !== 'string' || typeof op.ts !== 'number') continue;
    const id = op.peer + '|' + op.ts + '|' + op.key + '|' + (op.del ? 1 : 0);
    if (s.seen.has(id)) continue;                // 同じ変更は一度だけ
    rememberSeen(s, id);
    seeTs(op.ts);
    fwd.push(op);
    if (op.eph) { s.hooks.onEph && s.hooks.onEph(op); continue; }
    const val = op.del ? { del: true, ts: op.ts, peer: String(op.peer || '') } : { v: op.v, ts: op.ts, peer: String(op.peer || '') };
    if (applyEntry(s, op.key, val)) {
      s.hooks.onEntry && s.hooks.onEntry({ key: op.key, v: op.v, del: !!op.del, ts: op.ts, peer: op.peer });
      persistSoon(s);
    }
  }
  if (fwd.length) broadcast(s, fwd, fromPid);    // 届いた変更は、ほかの人へ中継する（届いた相手以外へ）
}
function rememberSeen(s, id) {
  s.seen.add(id);
  if (s.seen.size > SEEN_MAX) s.seen = new Set([...s.seen].slice(SEEN_MAX / 2));
}

// 開いているすべての接続へ送る（exceptPid の相手は除く）
function broadcast(s, ops, exceptPid) {
  for (const part of packBy(ops, MSG_MAX)) {
    for (const L of s.links.values()) {
      if (!L.ok || !L.conn.open) continue;
      if (exceptPid && L.pid === exceptPid) continue;
      safeSend(L.conn, { t: 'ops', ops: part });
    }
  }
}

function flush(s) {
  s.flushT = null;
  if (!s.queue.length) return;
  const q = s.queue.splice(0, s.queue.length);
  broadcast(s, q, null);
}

function persistSoon(s) {
  if (s.saveT) return;
  s.saveT = setTimeout(() => {
    s.saveT = null;
    s.hooks.save && s.hooks.save(s.kv);
  }, SAVE_MS);
}
// 画面を閉じる・背景に回すときは、待たずに今の部屋の状態を保存する（直前の変更を失わないように）
function flushSave() {
  const s = S;
  if (!s) return;
  if (s.saveT) { clearTimeout(s.saveT); s.saveT = null; }
  try { s.hooks.save && s.hooks.save(s.kv); } catch (_) {}
}
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('pagehide', flushSave);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
}

// 全体の一致の確認：件数と中身の印（ハッシュ）が違うときだけ、相手から全体を取り直す
function digest(s) {
  if (sumCache && sumCache.v === kvVer) return sumCache;
  const keys = [...s.kv.keys()].sort();
  let h = 0x811c9dc5 >>> 0;
  for (const k of keys) {
    const e = s.kv.get(k);
    const str = k + '|' + e.ts + '|' + (e.del ? 1 : 0) + ';';
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  }
  sumCache = { v: kvVer, n: keys.length, h: h.toString(16) };
  return sumCache;
}
function checkSum(s, L, m) {
  const d = digest(s);
  if (m.n === d.n && m.h === d.h) { L.mis = 0; return; }
  L.mis = (L.mis || 0) + 1;
  if (L.mis >= 2) { L.mis = 0; stats.sumMis++; safeSend(L.conn, { t: 'need' }); }   // 2回続けてずれたら取り直す
}
function sendSums(s) {
  const d = digest(s);
  for (const L of s.links.values()) if (L.ok && L.conn.open) safeSend(L.conn, { t: 'sum', n: d.n, h: d.h });
}

function connectAll(s) {
  if (!s || !s.peer) return;
  const now = Date.now();
  for (let k = 0; k < MAX_SLOTS; k++) {
    if (k === s.slot) continue;
    const id = slotId(s.roomId, k);
    let alive = false;
    for (const L of [...s.links.values()]) {
      if (L.pid !== id) continue;
      if (L.ok || now - L.t < 8000) alive = true;             // つながっている、またはつながり中
      else { try { L.conn.close(); } catch (_) {} s.links.delete(L.id); }   // 古い、つながらなかった接続は捨てる
    }
    if (alive) continue;
    try { attach(s, s.peer.connect(id, { reliable: true })); } catch (_) {}
  }
}

// ============================================================
// 公開する窓口
// ============================================================
/* start({ roomId, proof, tag, kv(Map), creator, hooks{ onEntry, onEph, onSnapDone, onLinks, save } })
 *   部屋に入る。席が取れたら解決する。 */
async function start(opts) {
  stop();
  await loadPeerJs();
  // 席を同時に確かめて、空いている一番若い席を使う（順番に待つより速い）
  const tries = [];
  for (let k = 0; k < MAX_SLOTS; k++) tries.push(tryOpen(slotId(opts.roomId, k)).catch(() => null).then(p => ({ k, p })));
  const got = await Promise.all(tries);
  let peer = null, slot = -1;
  for (const r of got) {
    if (r.p && peer === null) { peer = r.p; slot = r.k; }
    else if (r.p) { try { r.p.destroy(); } catch (_) {} }
  }
  if (!peer) throw new Error('満員です（この部屋は同時に8人まで入れます）');
  const s = {
    roomId: opts.roomId, proof: opts.proof, tag: opts.tag || '', peer, slot,
    links: new Map(), kv: opts.kv || new Map(), seen: new Set(), queue: [],
    flushT: null, retryT: null, saveT: null, sumT: null, haveSnap: !!opts.creator, doneSent: !!opts.creator, lastNeed: 0,
    hooks: opts.hooks || {}
  };
  S = s;
  sumCache = null;
  peer.on('connection', c => { if (S === s) attach(s, c); });
  peer.on('disconnected', () => { setTimeout(() => { try { peer.reconnect(); } catch (_) {} }, 3000); });
  peer.on('error', () => {});                  // 相手が見つからないなどは、あとで自動で再試行
  s.retryT = setInterval(() => connectAll(s), RETRY_MS);
  s.askT = setInterval(() => {
    // 頼んだ人から一定時間届かなければ、別の人に頼み直す
    if (S !== s || s.haveSnap) return;
    if (s.snapIn && Date.now() - (s.askAt || 0) < 8000) return;
    if (s.askFrom && Date.now() - (s.askAt || 0) < 8000) return;
    const ok = [...s.links.values()].filter(L => L.ok && L.conn.open);
    if (!ok.length) return;
    const next = ok.find(L => L.id !== s.askFrom) || ok[0];
    s.snapIn = null;
    askSnapshot(s, next);
  }, 2000);
  // 誰もいない部屋（一人で入った）は、少し待ってから、手元のデータで始める
  setTimeout(() => { if (S === s && !s.doneSent && peerCount(s) === 0) { s.doneSent = true; s.hooks.onSnapDone && s.hooks.onSnapDone(false); } }, 5000);
  setTimeout(() => { if (S === s && !s.doneSent) { s.doneSent = true; s.hooks.onSnapDone && s.hooks.onSnapDone(false); } }, 40000);
  s.sumT = setInterval(() => sendSums(s), SUM_MS);
  connectAll(s);
  notifyLinks(s);
  return { slot, others: got.filter(r => !r.p).length };   // 他の人の席の数（0なら一人の部屋）
}

// 変更を送る。eph=true は記録に残さない一時的な情報（位置など）
function send(key, value, del, eph) {
  const s = S;
  if (!s) return;
  const ts = nowTs();
  const op = { key, ts, peer: s.peer.id, del: !!del, eph: !!eph };
  if (!del) op.v = value;
  if (eph) {
    rememberSeen(s, op.peer + '|' + ts + '|' + key + '|' + (del ? 1 : 0));
    broadcast(s, [op], null);
    return;
  }
  const val = del ? { del: true, ts, peer: op.peer } : { v: value, ts, peer: op.peer };
  applyEntry(s, key, val);
  rememberSeen(s, op.peer + '|' + ts + '|' + key + '|' + (del ? 1 : 0));
  s.queue.push(op);
  if (!s.flushT) s.flushT = setTimeout(() => flush(s), FLUSH_MS);
  persistSoon(s);
}

function stop() {
  const s = S;
  if (!s) return;
  S = null;
  clearInterval(s.retryT);
  clearInterval(s.askT);
  clearInterval(s.sumT);
  clearTimeout(s.flushT);
  clearTimeout(s.saveT);
  for (const L of s.links.values()) { try { L.conn.close(); } catch (_) {} }
  s.links.clear();
  try { s.hooks.save && s.hooks.save(s.kv); } catch (_) {}
  try { s.peer.destroy(); } catch (_) {}
}

function linkCount() { return S ? peerCount(S) + 1 : 0; }

window.VoxelNet = {
  start, gzipStr, gunzipStr, bytesToB64, b64ToBytes, send, stop, linkCount,
  nowTs,                                  // 変更の時刻（時計ずれに強い）。各機能はこれを使う
  seeTs,
  active: () => !!S,
  stats: () => ({ ...stats }),
  kv: () => (S ? S.kv : null),
  slotId,
  MAX_SLOTS,
  version: 2
};
})();
