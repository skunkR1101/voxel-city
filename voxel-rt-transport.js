/* voxel-rt-transport.js  通信の差し替え口の、PeerJS（公開の仲介サービス）版（第2段階）
 *  ・席の名前は「vcr2-部屋ID-席番号」。古い版（vcx1-）とは混ざらないように、接頭語を変えている
 *  ・core には「部屋ID-席番号」だけを見せる（接頭語は、ここで付け外しする）
 *  ・claimSlot は、取れたら true、その席が使用中なら false を返す
 *  読み込み順：voxel-rt-core.js の後
 */
(function (root) {
'use strict';

const PEERJS_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
const PREFIX = 'vcr2-';
const TURN_KEY = 'voxelcraft_turn_v1';        // 既存の設定（設定画面で任意に入れる中継サーバー）
const CLAIM_TIMEOUT_MS = 12000;

let peerJsReady = null;
function loadPeerJs() {
  if (window.Peer) return Promise.resolve();
  if (peerJsReady) return peerJsReady;
  peerJsReady = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = PEERJS_URL;
    s.onload = () => (window.Peer ? res() : rej(new Error('通信部品の読み込みに失敗しました')));
    s.onerror = () => { peerJsReady = null; rej(new Error('通信部品を読み込めません。インターネットの接続を確認してください')); };
    document.head.appendChild(s);
  });
  return peerJsReady;
}

// 通信の経路（STUN：直接つなぐ。TURN：直接つながらないときの中継）
function iceConfig() {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  try {
    const t = JSON.parse(localStorage.getItem(TURN_KEY) || 'null');
    if (t && t.url) iceServers.push({ urls: t.url, username: t.user || undefined, credential: t.pass || undefined });
  } catch (e) {}
  return { iceServers, iceCandidatePoolSize: 4 };
}

// PeerJS の接続を、core が使う形（peer・open・send・on・close）に包む
// 接続の様子を、画面の診断ログ（VoxelDebug）に残す（原因の特定用。通信の動きは変えない）
function tlog(m) { try { if (window.VoxelDebug) VoxelDebug.log('通信（部屋）', m); } catch (e) {} }
function watchIce(c, name) {
  try {
    const pc = c.peerConnection;
    if (!pc || !pc.addEventListener) return;
    pc.addEventListener('iceconnectionstatechange', () => tlog('相手 ' + name + ' の経路：' + pc.iceConnectionState));
  } catch (e) {}
}
function wrapConn(c, name) {
  try {
    watchIce(c, name);
    c.on('open', () => tlog('相手 ' + name + ' とつながりました'));
    c.on('close', () => tlog('相手 ' + name + ' とのつながりが切れました'));
    c.on('error', e => tlog('相手 ' + name + ' との通信エラー：' + ((e && e.type) || e)));
  } catch (e) {}
  return {
    peer: name,
    get open() { return !!c.open; },
    get bufferedAmount() { const dc = c.dataChannel; return dc ? (dc.bufferedAmount || 0) : 0; },
    send(m) { c.send(m); },
    on(ev, fn) { c.on(ev, fn); },
    close() { try { c.close(); } catch (e) {} }
  };
}
function stripPrefix(full) { return String(full || '').startsWith(PREFIX) ? String(full).slice(PREFIX.length) : String(full || ''); }

function createTransport() {
  const t = {
    peer: null,
    myId: '',
    lastError: '',
    _onConn: null,
    _pending: [],

    // 席を取る（取れたら true）
    async claimSlot(k, roomId) {
      await loadPeerJs();
      const id = PREFIX + roomId + '-' + k;
      return new Promise((res, rej) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          try { p.destroy(); } catch (e) {}
          t.lastError = '仲介サービスに接続できません（時間切れ）';
          tlog('席 ' + (k + 1) + ' の取得が時間切れになりました（仲介サービスに届かない可能性）');
          rej(new Error(t.lastError));
        }, CLAIM_TIMEOUT_MS);
        const p = new window.Peer(id, { debug: 0, config: iceConfig() });
        tlog('席 ' + (k + 1) + ' を取りに行きます（' + roomId + '）');
        p.on('open', () => {
          if (done) return;
          done = true; clearTimeout(timer);
          t.peer = p; t.myId = id;
          tlog('席 ' + (k + 1) + ' を取りました');
          // 席を取ったあとは、相手からの接続を受け付ける
          p.on('connection', c => {
            const w = wrapConn(c, stripPrefix(c.peer));
            if (t._onConn) t._onConn(w); else t._pending.push(w);
          });
          p.on('disconnected', () => { tlog('仲介サービスから切れました（再接続します）'); setTimeout(() => { try { p.reconnect(); } catch (e) {} }, 3000); });
          // 相手が見つからない等のエラーは、そのつど自動で再試行されるので、ここでは記録だけ
          p.on('error', e => { t.lastError = (e && e.type) || 'error'; tlog('通信エラー：' + t.lastError); });
          res(true);
        });
        p.on('error', e => {
          if (done) return;
          done = true; clearTimeout(timer);
          try { p.destroy(); } catch (x) {}
          if (e && e.type === 'unavailable-id') { tlog('席 ' + (k + 1) + ' はほかの人が使っています'); res(false); }
          else { t.lastError = (e && e.type) || 'error'; tlog('席 ' + (k + 1) + ' を取れませんでした：' + t.lastError); rej(new Error(t.lastError)); }
        });
      });
    },

    onConnection(fn) {
      t._onConn = fn;
      while (t._pending.length) fn(t._pending.shift());
    },

    // 相手へつなぐ（remoteId は「部屋ID-席番号」）
    connect(remoteId) {
      if (!t.peer) throw new Error('まだ席を取っていません');
      const c = t.peer.connect(PREFIX + remoteId, { reliable: true });
      return wrapConn(c, String(remoteId));
    },

    // 通信をすべて閉じて、席を空ける
    close() {
      try { if (t.peer) t.peer.destroy(); } catch (e) {}
      t.peer = null; t.myId = ''; t._onConn = null; t._pending = [];
    }
  };
  return t;
}

const api = { createTransport, loadPeerJs, iceConfig, PREFIX };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.VoxelRTTransport = api;
})(typeof window !== 'undefined' ? window : globalThis);
