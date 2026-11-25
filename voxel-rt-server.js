/* voxel-rt-server.js  部屋の内容を、中継サーバーに保存する（段階A）
 *  ・入った人は、サーバーに保存されている内容を受け取る（後から入った人も、誰がオンラインでも受け取れる）
 *  ・部屋の内容（kv）の変更は、2秒ごとにまとめてサーバーへ送る。新しい方だけ残る
 *  ・保存しない一時情報（位置・チャットなど）は、rm.kv に入らないので対象外
 *  読み込み順：voxel-rt-core.js と voxel-rt-transport.js の後、voxel-rt-ui.js の前
 */
(function (root) {
'use strict';

const SYNC_MS = 2000;
const BATCH = 20;   // 1通のメッセージを小さく保つ（中継の上限 1MiB より十分小さく）

// rm：VoxelRT の部屋。tp：VoxelRTTransport の通信（中継版）
function attach(rm, tp) {
  const sent = new Map();   // key -> 最後に送った（または受け取った）時刻と送り主
  let timer = null;
  let stopped = false;

  function sameAs(a, b) { return a && b && a.ts === b.ts && a.peer === b.peer; }

  function pushChanged() {
    if (stopped || !tp.isReady()) return;
    const list = [];
    for (const [k, e] of rm.kv) {
      if (sameAs(sent.get(k), e)) continue;
      list.push([k, e]);
    }
    for (let i = 0; i < list.length; i += BATCH) {
      if (!tp.storePut(list.slice(i, i + BATCH))) return;   // 送れなければ、次の回に
    }
    for (const [k, e] of list) sent.set(k, { ts: e.ts, peer: e.peer });
  }

  // サーバーからの内容を、部屋に取り込む（新しい方だけ）
  tp.onSnapshot((entries, end) => {
    if (stopped) return;
    for (const [k, e] of entries) {
      if (!e || typeof e.ts !== 'number') continue;
      sent.set(k, { ts: e.ts, peer: e.peer });          // サーバーにある内容は、送り返さない
      if (rm.applyEntry(k, e)) {
        try { rm.dispatch(k, e.del ? undefined : e.v, { del: !!e.del, peer: e.peer, stored: true }); } catch (err) { console.error(err); }
      }
    }
    if (end) pushChanged();                              // 最後に、こちらだけにあるものを送る
  });

  function askAll() { if (tp.isReady()) tp.storeGet(); }
  tp.onReady(askAll);
  askAll();
  timer = setInterval(pushChanged, SYNC_MS);

  return {
    stop() { stopped = true; if (timer) clearInterval(timer); timer = null; tp.onSnapshot(null); }
  };
}

const api = { attach };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.VoxelRTServer = api;
})(typeof window !== 'undefined' ? window : globalThis);
