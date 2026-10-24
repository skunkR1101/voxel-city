/* voxel-craft-net.js (v1)  サーバーなしの通信（端末どうしを直接つなぐ）
 *
 * 仕組み
 *  ・部屋ごとに「席」を最大8つ用意する。席の番号つきの名前（ID）を、公開の仲介サービス（PeerJS）で取る。
 *    席に座った人どうしが直接つながる（WebRTC）。仲介は最初の接続の手配だけに使い、データは通らない。
 *  ・変更は全員に届く。届かない相手へは、間にいる人が中継する（同じ変更は一度だけ処理する）。
 *  ・同じ場所を同時に変えたら、時刻の新しい方が勝つ。
 *  ・新しく入った人は、つながった人から部屋の全体（変更の記録）をもらう。
 *  ・各自のブラウザが記録を持つので、作った人がいなくても続けられる。
 *
 * 注意
 *  ・直接つながらない回線（一部のスマホ回線など）では、接続できないことがある。
 *  ・同時に入れるのは8人まで。
 */
(function () {
'use strict';

const PEERJS_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
const MAX_SLOTS = 8;
const SNAP_BATCH = 150;          // 全体を渡すときの1回の件数
const FLUSH_MS = 120;            // 変更をまとめて送る間隔
const OPS_BATCH = 200;
const SEEN_MAX = 20000;
const RETRY_MS = 10000;
const SAVE_MS = 3000;

let S = null;                    // 現在の接続（1つだけ）

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

// 席を1つ取る。取れなければ null（その席は使用中）
function tryOpen(id) {
  return new Promise((res, rej) => {
    const p = new window.Peer(id, { debug: 0 });
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

function applyEntry(s, key, val) {
  const cur = s.kv.get(key);
  if (cur && !newer(val, cur)) return false;
  s.kv.set(key, val);
  return true;
}

function notifyLinks(s) {
  let n = 0;
  for (const L of s.links.values()) if (L.ok) n++;
  s.hooks.onLinks && s.hooks.onLinks(n + 1);   // 自分を含む人数
}

function sendHello(s, L) {
  if (!L.conn.open) return;
  L.conn.send({ t: 'hello', proof: s.proof, tag: s.tag });
  L.helloSent = true;
}

function attach(s, conn) {
  const id = conn.peer;
  const old = s.links.get(id);
  if (old && old.conn !== conn) { try { old.conn.close(); } catch (_) {} }
  const L = { conn, ok: false, name: '', helloSent: false, t: Date.now() };
  s.links.set(id, L);
  conn.on('open', () => { if (!L.helloSent) sendHello(s, L); });
  conn.on('data', m => onData(s, L, m));
  const drop = () => {
    if (s.links.get(id) === L) { s.links.delete(id); notifyLinks(s); }
  };
  conn.on('close', drop);
  conn.on('error', drop);
  if (conn.open) sendHello(s, L);
}

function onData(s, L, m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'hello') {
    if (m.proof !== s.proof) {                 // 合言葉が違う相手は切る
      try { L.conn.close(); } catch (_) {}
      if (s.links.get(L.conn.peer) === L) s.links.delete(L.conn.peer);
      return;
    }
    const first = !L.ok;
    L.ok = true;
    L.name = String(m.tag || '').slice(0, 30);
    if (!L.helloSent) sendHello(s, L);
    if (first) {
      notifyLinks(s);
      if (!s.haveSnap) L.conn.send({ t: 'need' });
    }
    return;
  }
  if (!L.ok) return;                           // 合言葉を確かめる前の相手の情報は使わない
  switch (m.t) {
    case 'need': sendSnapshot(s, L); break;
    case 'snap': applySnapshot(s, m); break;
    case 'ops': onOps(s, m.ops, L.conn.peer); break;
  }
}

function sendSnapshot(s, L) {
  const all = [...s.kv.entries()];
  if (!all.length) { L.conn.send({ t: 'snap', i: 0, last: true, e: [] }); return; }
  for (let i = 0, n = 0; i < all.length; i += SNAP_BATCH, n++) {
    L.conn.send({ t: 'snap', i: n, last: i + SNAP_BATCH >= all.length, e: all.slice(i, i + SNAP_BATCH) });
  }
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

function onOps(s, ops, from) {
  if (!Array.isArray(ops)) return;
  const fwd = [];
  for (const op of ops) {
    if (!op || typeof op.key !== 'string' || typeof op.ts !== 'number') continue;
    const id = op.peer + '|' + op.ts + '|' + op.key + '|' + (op.del ? 1 : 0);
    if (s.seen.has(id)) continue;
    rememberSeen(s, id);
    fwd.push(op);
    if (op.eph) { s.hooks.onEph && s.hooks.onEph(op); continue; }
    const val = op.del ? { del: true, ts: op.ts, peer: String(op.peer || '') } : { v: op.v, ts: op.ts, peer: String(op.peer || '') };
    if (applyEntry(s, op.key, val)) {
      s.hooks.onEntry && s.hooks.onEntry({ key: op.key, v: op.v, del: !!op.del, ts: op.ts, peer: op.peer });
      persistSoon(s);
    }
  }
  if (fwd.length) broadcast(s, fwd, from);     // 届いた変更は、ほかの人へ中継する
}
function rememberSeen(s, id) {
  s.seen.add(id);
  if (s.seen.size > SEEN_MAX) s.seen = new Set([...s.seen].slice(SEEN_MAX / 2));
}

function broadcast(s, ops, exceptId) {
  for (let i = 0; i < ops.length; i += OPS_BATCH) {
    const part = ops.slice(i, i + OPS_BATCH);
    for (const [id, L] of s.links) {
      if (!L.ok || id === exceptId || !L.conn.open) continue;
      try { L.conn.send({ t: 'ops', ops: part }); } catch (_) {}
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

function connectAll(s) {
  if (!s || !s.peer) return;
  const now = Date.now();
  for (let k = 0; k < MAX_SLOTS; k++) {
    if (k === s.slot) continue;
    const id = slotId(s.roomId, k);
    const L = s.links.get(id);
    if (L && (L.ok || now - L.t < 8000)) continue;
    if (L) { try { L.conn.close(); } catch (_) {} s.links.delete(id); }
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
    flushT: null, retryT: null, saveT: null, haveSnap: !!opts.creator, hooks: opts.hooks || {}
  };
  S = s;
  peer.on('connection', c => { if (S === s) attach(s, c); });
  peer.on('disconnected', () => { setTimeout(() => { try { peer.reconnect(); } catch (_) {} }, 3000); });
  peer.on('error', () => {});                  // 相手が見つからないなどは、あとで自動で再試行
  s.retryT = setInterval(() => connectAll(s), RETRY_MS);
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
  clearTimeout(s.flushT);
  clearTimeout(s.saveT);
  for (const L of s.links.values()) { try { L.conn.close(); } catch (_) {} }
  s.links.clear();
  try { s.hooks.save && s.hooks.save(s.kv); } catch (_) {}
  try { s.peer.destroy(); } catch (_) {}
}

function linkCount() { if (!S) return 0; let n = 0; for (const L of S.links.values()) if (L.ok) n++; return n + 1; }

window.VoxelNet = {
  start, send, stop, linkCount,
  active: () => !!S,
  kv: () => (S ? S.kv : null),
  slotId,
  MAX_SLOTS
};
})();
