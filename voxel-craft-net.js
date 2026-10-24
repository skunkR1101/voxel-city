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
      if (!s.haveSnap || now - (s.lastNeed || 0) > RESYNC_MS) {
        s.lastNeed = now;
        safeSend(L.conn, { t: 'need' });       // 全体をもらう（初めて入った人・再接続した人）
      }
    }
    return;
  }
  if (!L.ok) return;                           // 合言葉を確かめる前の相手の情報は使わない
  stats.recv++;
  switch (m.t) {
    case 'sum': checkSum(s, L, m); break;
    case 'need': sendSnapshot(s, L); break;
    case 'snap': applySnapshot(s, m); break;
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

function sendSnapshot(s, L) {
  const parts = packBy([...s.kv.entries()], MSG_MAX);
  if (!parts.length) { safeSend(L.conn, { t: 'snap', i: 0, last: true, e: [] }); return; }
  parts.forEach((p, i) => safeSend(L.conn, { t: 'snap', i, last: i === parts.length - 1, e: p }));
}

function applySnapshot(s, m) {
  if (Array.isArray(m.e)) {
    for (const [key, val] of m.e) {
      if (!val || typeof key !== 'string') continue;
      if (applyEntry(s, key, val)) s.hooks.onEntry && s.hooks.onEntry({ key, v: val.v, del: !!val.del, ts: val.ts, peer: val.peer });
    }
    persistSoon(s);
  }
  if (m.last && !s.haveSnap) {
    s.haveSnap = true;
    s.hooks.onSnapDone && s.hooks.onSnapDone();
  }
}

function onOps(s, ops, fromPid) {
  if (!Array.isArray(ops)) return;
  const fwd = [];
  for (const op of ops) {
    if (!op || typeof op.key !== 'string' || typeof op.ts !== 'number') continue;
    const id = op.peer + '|' + op.ts + '|' + op.key + '|' + (op.del ? 1 : 0);
    if (s.seen.has(id)) continue;                // 同じ変更は一度だけ
    rememberSeen(s, id);
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
  let peer = null, slot = -1;
  for (let k = 0; k < MAX_SLOTS; k++) {
    const p = await tryOpen(slotId(opts.roomId, k));
    if (p) { peer = p; slot = k; break; }
  }
  if (!peer) throw new Error('満員です（この部屋は同時に8人まで入れます）');
  const s = {
    roomId: opts.roomId, proof: opts.proof, tag: opts.tag || '', peer, slot,
    links: new Map(), kv: opts.kv || new Map(), seen: new Set(), queue: [],
    flushT: null, retryT: null, saveT: null, sumT: null, haveSnap: !!opts.creator, lastNeed: 0,
    hooks: opts.hooks || {}
  };
  S = s;
  sumCache = null;
  peer.on('connection', c => { if (S === s) attach(s, c); });
  peer.on('disconnected', () => { setTimeout(() => { try { peer.reconnect(); } catch (_) {} }, 3000); });
  peer.on('error', () => {});                  // 相手が見つからないなどは、あとで自動で再試行
  s.retryT = setInterval(() => connectAll(s), RETRY_MS);
  s.sumT = setInterval(() => sendSums(s), SUM_MS);
  connectAll(s);
  notifyLinks(s);
  if (!s.haveSnap) setTimeout(() => { if (S === s && !s.haveSnap) { s.haveSnap = true; s.hooks.onSnapDone && s.hooks.onSnapDone(); } }, 12000);
  return { slot };
}

// 変更を送る。eph=true は記録に残さない一時的な情報（位置など）
function send(key, value, del, eph) {
  const s = S;
  if (!s) return;
  const ts = Date.now();
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
  start, send, stop, linkCount,
  active: () => !!S,
  stats: () => ({ ...stats }),
  kv: () => (S ? S.kv : null),
  slotId,
  MAX_SLOTS,
  version: 2
};
})();
