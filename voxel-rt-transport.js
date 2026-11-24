/* voxel-rt-transport.js  通信の差し替え口：Cloudflare の中継サーバー版（第3段階）
 *  ・PeerJS（直接つなぐ方式）の代わりに、中継サーバー（Durable Objects）を使う
 *  ・席（0〜7）はサーバーが管理する。同じ席は1人だけ
 *  ・中継サーバーのアドレスと合言葉は、この端末にだけ保存する（初回に入力を求める）。チャットやファイルには書かない
 *  ・core が使う形（claimSlot / onConnection / connect / close、conn の peer・open・send・on・close）は、PeerJS版と同じ
 *  読み込み順：voxel-rt-core.js の後
 */
(function (root) {
'use strict';

const CFG_KEY = 'voxelcraft_relay_v1';
const RELAY_URL = 'https://voxel-room.hirashi.workers.dev';   // 中継サーバーのアドレス（公開してよい情報。合言葉は含めない）
const CLAIM_TIMEOUT_MS = 12000;
const RECONNECT_MS = 3000;

function tlog(m) { try { if (root.VoxelDebug) root.VoxelDebug.log('通信（中継）', m); } catch (e) {} }

let cfgMem = null;          // この画面で使う設定（一度入力したら、ページを開き直すまで聞かない）
let authFailed = false;     // 接続に失敗したら、ページを開き直すまで、もう一度は試さない（合言葉を何度も聞かないため）
let failMsg = '';

// 中継の合言葉は、この端末に一度入力すれば覚えておく（部屋の合言葉とは別のもの）
function loadCfg() {
  if (cfgMem) return cfgMem;
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
    if (c && c.token) cfgMem = { url: RELAY_URL, token: String(c.token) };
  } catch (e) {}
  return cfgMem;
}
function askCfg() {
  const token = window.prompt('中継サーバーの合言葉を入力してください（サーバーに設定したもの。部屋の合言葉とは別です）', '');
  if (!token || !token.trim()) throw new Error('中継の合言葉が入力されていません');
  cfgMem = { url: RELAY_URL, token: token.trim() };
  try { localStorage.setItem(CFG_KEY, JSON.stringify({ token: cfgMem.token })); } catch (e) {}
  return cfgMem;
}
function forgetCfg() {
  cfgMem = null;
  try { localStorage.removeItem(CFG_KEY); } catch (e) {}
}
function wsUrl(cfg, roomId, slot) {
  const base = cfg.url.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
  return base + '/?room=' + encodeURIComponent(roomId) + '&slot=' + slot + '&token=' + encodeURIComponent(cfg.token);
}

// 相手1人との「つながり」。core には、PeerJS の接続と同じ形に見せる
function makeConn(st, slot, roomId) {
  const c = {
    peer: roomId + '-' + slot,
    open: false,
    get bufferedAmount() { return 0; },
    send(m) {
      if (!c.open || !st.ws || st.ws.readyState !== 1) throw new Error('つながっていません');
      st.ws.send(JSON.stringify({ to: slot, data: m }));
    },
    on(ev, fn) {
      (c._h[ev] || (c._h[ev] = [])).push(fn);
      if (ev === 'data' && c._q.length) { const q = c._q.splice(0); for (const m of q) fn(m); }   // 先に届いたものを渡す
    },
    close() {
      c.open = false;
      if (st.conns.get(slot) === c) st.conns.delete(slot);
    },
    _h: {},
    _q: [],
    _emit(ev, arg) {
      if (ev === 'data' && !(c._h.data && c._h.data.length)) { c._q.push(arg); return; }
      for (const fn of (c._h[ev] || [])) { try { fn(arg); } catch (e) { console.error(e); } }
    }
  };
  return c;
}

// 中継につなぐ（席を取る）。成功なら WebSocket、席が使用中なら null、失敗なら例外
function openSocket(st, k, roomId) {
  return new Promise((res, rej) => {
    let cfg;
    try { cfg = loadCfg() || askCfg(); } catch (e) { rej(e); return; }
    let done = false;
    const ws = new WebSocket(wsUrl(cfg, roomId, k));
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { ws.close(); } catch (e) {}
      rej(new Error('中継サーバーに接続できません（時間切れ）'));
    }, CLAIM_TIMEOUT_MS);
    ws.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!done && m.t === 'welcome') { done = true; clearTimeout(timer); res(ws); return; }
      onMsg(st, m);
    };
    ws.onclose = ev => {
      if (!done) {
        done = true; clearTimeout(timer);
        if (ev.code === 4409) res(null);
        else rej(new Error('中継サーバーに接続できませんでした（コード ' + ev.code + '）'));
        return;
      }
      if (st.ws === ws) onDrop(st);
    };
    ws.onerror = () => {};
  });
}

function onMsg(st, m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'roster') {
    const next = new Set((m.slots || []).filter(s => s !== st.slot));
    for (const s of [...st.roster]) if (!next.has(s)) goOffline(st, s);
    for (const s of next) goOnline(st, s);
    st.roster = next;
    return;
  }
  if (m.t === 'msg') {
    const c = connFor(st, m.from, true);
    c._emit('data', m.data);
    return;
  }
  if (m.t === 'snapshot') {
    if (st.onSnap) { try { st.onSnap(m.entries || [], !!m.end); } catch (e) { console.error(e); } }
  }
}
function connFor(st, slot, incoming) {
  let c = st.conns.get(slot);
  if (c) return c;
  c = makeConn(st, slot, st.room);
  st.conns.set(slot, c);
  if (incoming) {
    // 相手から来た接続：core に新しい接続として渡してから、つながったことを知らせる
    if (st.onConn) st.onConn(c); else st.pending.push(c);
    c.open = true;
    c._emit('open');
  } else {
    c.open = st.roster.has(slot);
  }
  return c;
}
function goOnline(st, slot) {
  const c = st.conns.get(slot);
  if (c && !c.open) { c.open = true; c._emit('open'); }
}
function goOffline(st, slot) {
  const c = st.conns.get(slot);
  if (!c) return;
  c.open = false;
  st.conns.delete(slot);
  c._emit('close');
}
function onDrop(st) {
  st.ws = null;
  const list = [...st.conns.values()];
  st.conns.clear();
  st.roster = new Set();
  for (const c of list) { c.open = false; c._emit('close'); }
  tlog('中継から切れました（自動で席を取り直します）');
  if (!st.closed) scheduleReconnect(st);
}
function scheduleReconnect(st) {
  setTimeout(() => {
    if (st.closed || st.ws) return;
    openSocket(st, st.slot, st.room).then(ws => {
      if (!ws) { tlog('席 ' + (st.slot + 1) + ' は、ほかの人が使い始めました'); st.closed = true; return; }
      if (st.closed) { try { ws.close(); } catch (e) {} return; }
      st.ws = ws;
      tlog('中継に戻りました');
      for (const f of st.readyFns) { try { f(); } catch (e) { console.error(e); } }
    }).catch(() => scheduleReconnect(st));
  }, RECONNECT_MS);
}

function createTransport() {
  const st = {
    ws: null, room: null, slot: null,
    conns: new Map(), roster: new Set(),
    onConn: null, pending: [], closed: false,
    onSnap: null, readyFns: []
  };
  const t = {
    myId: '',
    lastError: '',

    // 席を取る（取れたら true。使用中なら false）
    async claimSlot(k, roomId) {
      if (authFailed) throw new Error(failMsg || '中継サーバーに接続できません。ページを開き直してください');
      let ws;
      try {
        ws = await openSocket(st, k, roomId);
      } catch (e) {
        authFailed = true;
        failMsg = e.message + '。中継の合言葉が違う可能性があります。ページを開き直すと、入力し直せます';
        forgetCfg();
        t.lastError = failMsg;
        tlog(failMsg);
        throw new Error(failMsg);
      }
      if (!ws) { tlog('席 ' + (k + 1) + ' はほかの人が使っています'); return false; }
      st.ws = ws; st.room = roomId; st.slot = k; st.closed = false;
      t.myId = roomId + '-' + k;
      tlog('席 ' + (k + 1) + ' を取りました');
      return true;
    },

    // 部屋の内容の保存（段階A）：送る・受け取る・再接続したとき
    storePut(entries) {
      if (!st.ws || st.ws.readyState !== 1) return false;
      st.ws.send(JSON.stringify({ store: 'put', entries }));
      return true;
    },
    storeGet() {
      if (!st.ws || st.ws.readyState !== 1) return false;
      st.ws.send(JSON.stringify({ store: 'get' }));
      return true;
    },
    onSnapshot(fn) { st.onSnap = fn; },
    onReady(fn) { st.readyFns.push(fn); },
    isReady() { return !!(st.ws && st.ws.readyState === 1); },

    onConnection(fn) {
      st.onConn = fn;
      while (st.pending.length) fn(st.pending.shift());
    },

    // 相手へつなぐ（remoteId は「部屋ID-席番号」）
    connect(remoteId) {
      if (!st.ws) throw new Error('まだ席を取っていません');
      const slot = Number(String(remoteId).split('-').pop());
      return connFor(st, slot, false);
    },

    // 通信をすべて閉じて、席を空ける
    close() {
      st.closed = true;
      try { if (st.ws) st.ws.close(); } catch (e) {}
      st.ws = null; st.conns.clear(); st.roster = new Set();
      st.onConn = null; st.pending = [];
      t.myId = '';
    }
  };
  return t;
}

const api = { createTransport, forgetCfg };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.VoxelRTTransport = api;
})(typeof window !== 'undefined' ? window : globalThis);
