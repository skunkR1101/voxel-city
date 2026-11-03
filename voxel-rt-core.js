/* voxel-rt-core.js  マルチプレイの通信の核（再構築・第1段階）
 *  役割：部屋の「キーと値」の同期だけを担当する。ブロック・道路・列車などの意味は知らない。
 *  ・部屋の状態は kv（キー→{v, ts, peer, del}）。同じキーは「時刻の新しい方」が勝つ（同時刻は peer の文字順）
 *  ・stored：保存して全員に同期する（ブロック・道路など）
 *  ・ephemeral：保存せず、今いる人にだけ送る（位置・チャットなど）
 *  ・後から入った人は、いちばん最初に全体（スナップショット）を1人から受け取る
 *  ・ずれ（件数と印の不一致）を定期的に確かめ、2回続けてずれたら全体を取り直す
 *
 *  transport（通信の差し替え口）：
 *    claimSlot(k) -> Promise<boolean>   部屋の席 k を取る（取れたら自分の通信名になる）
 *    connect(remoteId) -> conn           相手へつなぐ
 *    onConnection(fn)                    相手からつながれたとき fn(conn)
 *    conn: { open, send(msg), on('open'|'data'|'close'|'error', fn), peer }
 */
(function (root) {
'use strict';

const SLOTS = 8;
const PIECE = 60000;          // 1通の大きさの目安（文字数）
const SUM_MS = 20000;         // ずれの確認の間隔
const NEED_COOLDOWN = 60000;  // 全体を取り直してもらう最短間隔
const FLUSH_MS = 50;          // 保存する変更をまとめて送る間隔
const SEEN_MAX = 20000;

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// 合言葉の確認用の印（部屋ID＋パスワードから作る。通信の秘密を守るものではなく、別の部屋の混入を防ぐ）
function proofOf(roomId, password) { return fnv('vc|' + roomId + '|' + password).toString(16) + '-' + fnv(password + '|' + roomId).toString(16); }
function entryHash(key, e) { return fnv(key + '|' + e.ts + '|' + e.peer + '|' + (e.del ? 1 : 0)); }
function newer(a, b) { return a.ts !== b.ts ? a.ts > b.ts : a.peer > b.peer; }

class Room {
  constructor(opts) {
    this.roomId = String(opts.roomId);
    this.password = String(opts.password || '');
    this.proof = proofOf(this.roomId, this.password);
    this.transport = opts.transport;
    this.name = String(opts.name || '').slice(0, 30);
    this.peerId = '';                 // 席を取ったあとの自分の通信名
    this.kv = new Map();
    this.dig = { n: 0, x: 0 };        // 全体の印（件数と、項目の印のXOR）
    this.links = new Map();           // 相手ごとのつながり
    this.seen = new Set();
    this.queue = [];
    this.flushT = null;
    this.clock = 0;
    this.handlers = new Map();        // 接頭語 -> fn(key, value, meta)
    this.listeners = new Set();       // fn(event, data)
    this.haveSnap = false;            // 最初は持っていない。誰ともつながらなかった人だけが、最初の持ち主になる
    this.askFrom = null;
    this.snapIn = null;
    this.timers = [];
    this.lastNeed = 0;
    this.needAt = 0;
    this.active = false;
  }

  // ---------- 外へ知らせる ----------
  on(prefix, fn) { this.handlers.set(prefix, fn); }
  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev, data) { for (const fn of this.listeners) { try { fn(ev, data); } catch (e) { console.error(e); } } }

  // ---------- 時刻（端末の時計がずれていても、新しい変更が勝つように）----------
  nowTs() { const t = Math.max(Date.now(), this.clock + 1); this.clock = t; return t; }
  seeTs(ts) { if (typeof ts === 'number' && isFinite(ts) && ts > this.clock) this.clock = ts; }

  // ---------- 部屋に入る ----------
  async join() {
    let lastErr = '';
    for (let k = 0; k < SLOTS; k++) {
      let ok = false;
      try { ok = await this.transport.claimSlot(k, this.roomId); }
      catch (e) { lastErr = (e && e.message) || 'error'; break; }      // 仲介サービスに届かない：席の数だけ繰り返さない
      if (ok) { this.slot = k; this.peerId = this.roomId + '-' + k; break; }
    }
    if (!this.peerId) throw new Error(lastErr ? '仲介サービスに接続できません（' + lastErr + '）' : '部屋がいっぱいです（8人まで）');

    this.active = true;
    this.transport.onConnection(conn => { if (this.active) this.attach(conn); });
    this.timers.push(setInterval(() => this.connectAll(), 3000));
    this.timers.push(setInterval(() => this.askLinks(), 2000));
    this.timers.push(setInterval(() => this.sendSums(), SUM_MS));
    // 数秒たっても誰ともつながらなければ、一人の部屋。ここで手元の状態が、そのまま最初の持ち主になる
    this.timers.push(setTimeout(() => { if (this.active && !this.haveSnap && this.linkCount() === 0) this.haveSnap = true; }, 4000));
    this.connectAll();
    this.emit('joined', { slot: this.slot });
    return { slot: this.slot };
  }
  leave() {
    this.active = false;
    for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
    this.timers = [];
    for (const L of this.links.values()) { try { L.conn.close(); } catch (e) {} }
    this.links.clear();
    if (this.flushT) clearTimeout(this.flushT);
    this.flushT = null;
    this.emit('left', {});
  }

  connectAll() {
    if (!this.active) return;
    const now = Date.now();
    for (let k = 0; k < SLOTS; k++) {
      if (k === this.slot) continue;
      const id = this.roomId + '-' + k;
      let alive = false;
      for (const L of [...this.links.values()]) {
        if (L.pid !== id) continue;
        if (L.ok || now - L.t < 8000) alive = true;
        else { try { L.conn.close(); } catch (e) {} this.links.delete(L.id); }
      }
      if (!alive) { try { this.attach(this.transport.connect(id)); } catch (e) {} }
    }
  }

  // ---------- つながり（合言葉の確認つき）----------
  attach(conn) {
    const L = { id: Math.random().toString(36).slice(2), pid: conn.peer, conn, ok: false, helloSent: false, t: Date.now(), mis: 0, gz: false, askT: 0 };
    this.links.set(L.id, L);
    const drop = () => { if (this.links.delete(L.id)) this.emit('links', this.linkCount()); };
    conn.on('open', () => { if (!L.helloSent) this.sendHello(L, false); });
    conn.on('data', m => { try { this.onData(L, m); } catch (e) { console.error(e); } });
    conn.on('close', drop);
    conn.on('error', drop);
    if (conn.open) this.sendHello(L, false);
  }
  sendHello(L, ask) {
    if (!L.conn.open) return;
    this.safe(L, { t: 'hello', proof: this.proof, name: this.name, ask: !!ask, gz: false, v: 2 });
    L.helloSent = true;
  }
  askLinks() {
    for (const L of this.links.values()) {
      if (L.ok || !L.conn.open) continue;
      this.safe(L, { t: 'hello', proof: this.proof, name: this.name, ask: true, gz: false, v: 2 });
    }
  }
  linkCount() { let n = 0; for (const L of this.links.values()) if (L.ok) n++; return n; }
  peerNames() { const out = []; for (const L of this.links.values()) if (L.ok) out.push({ peer: L.pid, name: L.name || '' }); return out; }

  safe(L, msg) { try { L.conn.send(msg); } catch (e) { this.emit('sendError', e); } }

  onData(L, m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') {
      if (m.proof !== this.proof) { try { L.conn.close(); } catch (e) {} this.links.delete(L.id); this.emit('rejected', { pid: L.pid }); return; }
      const first = !L.ok;
      L.ok = true;
      L.name = String(m.name || '').slice(0, 30);
      if (!L.helloSent || m.ask) this.sendHello(L, false);
      if (first) {
        this.emit('links', this.linkCount());
        if (!this.haveSnap && !this.askFrom) this.askSnapshot(L);
        else if (this.haveSnap) this.safe(L, { t: 'sum', n: this.dig.n, h: this.dig.x.toString(16) });
      }
      return;
    }
    if (!L.ok) return;                         // 合言葉を確かめる前の相手の情報は使わない
    switch (m.t) {
      case 'ops': this.onOps(m.ops, L); break;
      case 'eph': this.onEph(m.ops, L); break;
      case 'sum': this.checkSum(L, m); break;
      case 'need': this.sendSnapshot(L); break;
      case 'snap': this.onSnapPiece(L, m); break;
    }
  }

  // ---------- 変更（保存する・しない）----------
  set(key, value) { this.write(key, { v: value, ts: this.nowTs(), peer: this.peerId, del: false }, true); }
  del(key) { this.write(key, { ts: this.nowTs(), peer: this.peerId, del: true }, true); }
  // 保存しない一時情報（位置・チャットなど）。今いる人にだけ送る
  ephemeral(key, value) {
    const op = { key, ts: this.nowTs(), peer: this.peerId, v: value };
    this.remember(op.peer + '|' + op.ts + '|' + key);
    this.broadcastEph([op], null);
  }

  write(key, e, send) {
    if (!this.active) return false;
    if (!this.applyEntry(key, e)) return false;
    this.remember(e.peer + '|' + e.ts + '|' + key + '|' + (e.del ? 1 : 0));
    if (send) { this.queue.push({ key, ts: e.ts, peer: e.peer, del: !!e.del, v: e.del ? undefined : e.v }); this.scheduleFlush(); }
    return true;
  }
  scheduleFlush() { if (!this.flushT) this.flushT = setTimeout(() => this.flush(), FLUSH_MS); }
  flush() {
    this.flushT = null;
    if (!this.queue.length) return;
    const ops = this.queue.splice(0, this.queue.length);
    this.broadcast(ops, null);
  }

  // 1項目を、新しい方だけ採用する。採用したら全体の印を直す
  applyEntry(key, e) {
    const cur = this.kv.get(key);
    if (cur && !newer(e, cur)) return false;
    if (cur) this.dig.x = (this.dig.x ^ entryHash(key, cur)) >>> 0; else this.dig.n++;
    this.dig.x = (this.dig.x ^ entryHash(key, e)) >>> 0;
    this.kv.set(key, e);
    this.seeTs(e.ts);
    return true;
  }

  remember(id) {
    this.seen.add(id);
    if (this.seen.size > SEEN_MAX) this.seen = new Set([...this.seen].slice(SEEN_MAX / 2));
  }

  onOps(ops, from) {
    if (!Array.isArray(ops)) return;
    const fwd = [];
    for (const op of ops) {
      if (!op || typeof op.key !== 'string' || typeof op.ts !== 'number') continue;
      const id = op.peer + '|' + op.ts + '|' + op.key + '|' + (op.del ? 1 : 0);
      if (this.seen.has(id)) continue;
      this.remember(id);
      this.seeTs(op.ts);
      const e = op.del ? { ts: op.ts, peer: String(op.peer || ''), del: true } : { v: op.v, ts: op.ts, peer: String(op.peer || ''), del: false };
      if (this.applyEntry(op.key, e)) {
        this.dispatch(op.key, e.del ? undefined : e.v, { del: !!e.del, peer: e.peer, stored: true });
      }
      fwd.push(op);
    }
    if (fwd.length) this.broadcast(fwd, from.id);      // 受け取った変更は、ほかの人へ中継する
  }
  onEph(ops, from) {
    if (!Array.isArray(ops)) return;
    const fwd = [];
    for (const op of ops) {
      if (!op || typeof op.key !== 'string' || typeof op.ts !== 'number') continue;
      const id = op.peer + '|' + op.ts + '|' + op.key;
      if (this.seen.has(id)) continue;
      this.remember(id);
      this.seeTs(op.ts);
      this.dispatch(op.key, op.v, { del: false, peer: op.peer, stored: false });
      fwd.push(op);
    }
    if (fwd.length) this.broadcastEph(fwd, from.id);
  }
  dispatch(key, value, meta) {
    const prefix = key.split(':')[0];
    const fn = this.handlers.get(prefix);
    if (fn) { try { fn(key, value, meta); } catch (e) { console.error(e); } }
    this.emit('change', { key, value, meta });
  }

  broadcast(ops, exceptId) {
    for (const part of this.pack(ops)) {
      for (const L of this.links.values()) {
        if (!L.ok || !L.conn.open || L.id === exceptId) continue;
        this.safe(L, { t: 'ops', ops: part });
      }
    }
  }
  broadcastEph(ops, exceptId) {
    for (const L of this.links.values()) {
      if (!L.ok || !L.conn.open || L.id === exceptId) continue;
      this.safe(L, { t: 'eph', ops });
    }
  }
  pack(items) {
    const out = []; let cur = [], size = 2;
    for (const it of items) {
      const n = JSON.stringify(it).length + 1;
      if (cur.length && size + n > PIECE) { out.push(cur); cur = []; size = 2; }
      cur.push(it); size += n;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  // ---------- 全体の受け渡し（後から入った人のため）----------
  askSnapshot(L) {
    this.askFrom = L.id;
    this.askAt = Date.now();
    this.safe(L, { t: 'need' });
  }
  sendSnapshot(L) {
    const list = [...this.kv.entries()];
    const json = JSON.stringify(list);
    const pieces = [];
    for (let i = 0; i < json.length; i += PIECE) pieces.push(json.slice(i, i + PIECE));
    if (!pieces.length) pieces.push('');
    pieces.forEach((d, i) => this.safe(L, { t: 'snap', i, n: pieces.length, d }));
  }
  onSnapPiece(L, m) {
    if (!this.snapIn || this.snapIn.from !== L.id) this.snapIn = { from: L.id, n: m.n, parts: [], got: 0 };
    const sn = this.snapIn;
    if (sn.parts[m.i] === undefined) { sn.parts[m.i] = String(m.d || ''); sn.got++; }
    if (sn.got < sn.n) return;
    this.snapIn = null;
    let list = [];
    try { list = JSON.parse(sn.parts.join('')); }
    catch (e) { this.askFrom = null; this.emit('snapFailed', {}); return; }
    for (const [key, e] of list) {
      if (!e || typeof key !== 'string') continue;
      this.seeTs(e.ts);
      if (this.applyEntry(key, e)) this.dispatch(key, e.del ? undefined : e.v, { del: !!e.del, peer: e.peer, stored: true, snap: true });
    }
    this.haveSnap = true;
    this.askFrom = null;
    this.emit('snapDone', { count: list.length });
  }

  // ---------- ずれの確認 ----------
  sendSums() {
    for (const L of this.links.values()) if (L.ok && L.conn.open) this.safe(L, { t: 'sum', n: this.dig.n, h: this.dig.x.toString(16) });
  }
  checkSum(L, m) {
    if (m.n === this.dig.n && m.h === this.dig.x.toString(16)) { L.mis = 0; return; }
    L.mis = (L.mis || 0) + 1;
    if (L.mis >= 2) {
      L.mis = 0;
      const now = Date.now();
      if (now - this.needAt > NEED_COOLDOWN) { this.needAt = now; this.safe(L, { t: 'need' }); }
    }
  }

  // ---------- 状態 ----------
  status() {
    return { roomId: this.roomId, slot: this.slot, peerId: this.peerId, links: this.linkCount(), keys: this.kv.size, haveSnap: this.haveSnap };
  }
}

const api = {
  Room, proofOf, fnv, entryHash, SLOTS, PIECE,
  create: (opts) => new Room(opts),          // 部屋を作る／入る は同じ。誰もいなければ自動で最初の持ち主になる
  join: (opts) => new Room(opts)
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.VoxelRT = api;
})(typeof window !== 'undefined' ? window : globalThis);
