/* voxel-craft-sync.js (v1)  道路・線路・駅・ダイヤ・列車ライブラリを、部屋の全員に反映する
 *  仕組み：これらの機能は、自分の保存領域（localStorage）に状態を書く。
 *         その書き込みを検知して、部屋の全員へ送る。受け取った側は、保存し直して画面を作り直す。
 *  ・1つの状態は、時刻の新しい方が勝つ（同時に別々の人が同じ種類を変えたら、後の変更で上書きされる）。
 *  ・大きな状態は、分けて送る（1通の上限があるため）。
 *  ・部屋に入るとき、その部屋の状態に合わせる（この端末の道路などは、いったん入れ替わる）。
 * 読み込み順： … save → net → multi → custom → sync → fx → diag → players → ui
 *   ※ road / dia / station / train は、この前に読み込む（それぞれの再読み込みの窓口を使う）
 */
(function () {
'use strict';

const MIRROR = {                      // 保存キー -> 通信での名前（短い英字）
  'voxelcraft_road_v1': 'road',
  'voxelcraft_dia_v1': 'dia',
  'voxelcraft_station_v1': 'station',
  'voxelcraft_train_v1': 'train'
};
const KEY_OF = {};
for (const k of Object.keys(MIRROR)) KEY_OF[MIRROR[k]] = k;
// 部屋に入るとき、この端末の状態をいったん空にする（変えたくない項目は残す）
const EMPTY = {
  road: '{"pieces":[],"nodes":[],"undo":[],"gid":0}',
  dia: '{"lines":[]}',
  station: '{"stations":[]}'
};
const PART = 16000;                    // 1かけらの大きさ（文字数）
const DEBOUNCE = 250;                  // 連続した書き込みを、まとめて送る間隔

window.VoxelSync = window.VoxelSync || {};

const origSet = Storage.prototype.setItem;
const origGet = Storage.prototype.getItem;
let quiet = false;                     // 受け取った変更を書くとき・再読み込み中は、送り返さない
const timers = new Map();
const lastMeta = new Map();            // 名前 -> { ts, n }
const partsIn = new Map();             // 名前 -> Map(ts -> [かけら])
const applied = new Map();             // 名前 -> 反映した時刻

function reloadKey(k) {
  const m = VoxelSync[MIRROR[k]];
  if (!m || typeof m.reload !== 'function') return;
  quiet = true;
  try { m.reload(); } catch (e) { console.error('再読み込みに失敗', e); }
  finally { quiet = false; }
}

// ============================================================
// 送る側
// ============================================================
function sendValue(name, text, ts) {
  const n = Math.max(1, Math.ceil(text.length / PART));
  for (let i = 0; i < n; i++) VoxelMulti.send('lsp:' + name + ':' + i, { ts, d: text.slice(i * PART, (i + 1) * PART) });
  VoxelMulti.send('lsm:' + name, { ts, n });
}
function localWrite(k, text) {
  if (quiet || !VoxelMulti.connected()) return;
  clearTimeout(timers.get(k));
  timers.set(k, setTimeout(() => {
    timers.delete(k);
    const name = MIRROR[k];
    const prev = lastMeta.get(name) ? lastMeta.get(name).ts : 0;
    const ts = Math.max((window.VoxelNet ? VoxelNet.nowTs() : Date.now()), prev + 1);
    lastMeta.set(name, { ts, n: 0 });
    sendValue(name, text, ts);
  }, DEBOUNCE));
}

// 保存領域への書き込みを横取りする（書いた内容は、そのまま保存しつつ、部屋へも送る）
Storage.prototype.setItem = function (k, v) {
  const r = origSet.call(this, k, v);
  if (this === window.localStorage && MIRROR[k] !== undefined) localWrite(k, String(v));
  return r;
};

// 部屋を作ったとき：この端末の今の状態を、部屋の全員に渡す
VoxelSync.announceAll = function () {
  for (const k of Object.keys(MIRROR)) {
    const v = origGet.call(localStorage, k);
    if (v != null) sendValue(MIRROR[k], String(v), Math.max((window.VoxelNet ? VoxelNet.nowTs() : Date.now()), (lastMeta.get(MIRROR[k]) || { ts: 0 }).ts + 1));
  }
};

// 部屋に入るとき：この端末の状態を空にして、部屋の状態を待つ（送らない）
VoxelSync.resetLocal = function () {
  applied.clear(); lastMeta.clear(); partsIn.clear();   // 前の部屋の時刻の記録は捨てる
  quiet = true;
  try {
    for (const k of Object.keys(MIRROR)) {
      if (EMPTY[MIRROR[k]] === undefined) continue;
      origSet.call(localStorage, k, EMPTY[MIRROR[k]]);
      reloadKey(k);
    }
  } finally { quiet = false; }
};

// ============================================================
// 受け取る側
// ============================================================
function applyRemote(name, text) {
  const k = KEY_OF[name];
  if (!k) return;
  if (origGet.call(localStorage, k) === text) return;   // 同じなら何もしない
  quiet = true;
  try { origSet.call(localStorage, k, text); } catch (e) { console.error(e); } finally { quiet = false; }
  reloadKey(k);
}
function tryApply(name) {
  const meta = lastMeta.get(name);
  if (!meta || !meta.n) return;
  if (meta.ts <= (applied.get(name) || 0)) return;
  const arr = (partsIn.get(name) || new Map()).get(meta.ts);
  if (!arr) return;
  for (let i = 0; i < meta.n; i++) if (typeof arr[i] !== 'string') return;   // まだ全部届いていない
  applied.set(name, meta.ts);
  applyRemote(name, arr.slice(0, meta.n).join(''));
  // 古いかけらは捨てる
  const byTs = partsIn.get(name);
  for (const t of [...byTs.keys()]) if (t < meta.ts) byTs.delete(t);
}

VoxelMulti.onOp('lsp', rec => {
  const m = /^lsp:([a-z]+):(\d+)$/.exec(rec.key || '');
  if (!m || !rec.v || typeof rec.v.d !== 'string') return;
  const name = m[1], i = Number(m[2]);
  let byTs = partsIn.get(name);
  if (!byTs) { byTs = new Map(); partsIn.set(name, byTs); }
  const arr = byTs.get(rec.v.ts) || [];
  arr[i] = rec.v.d;
  byTs.set(rec.v.ts, arr);
  tryApply(name);
});
VoxelMulti.onOp('lsm', rec => {
  const m = /^lsm:([a-z]+)$/.exec(rec.key || '');
  if (!m || !rec.v) return;
  const name = m[1];
  const cur = lastMeta.get(name);
  if (cur && cur.ts > rec.v.ts) return;               // 古い知らせは無視
  lastMeta.set(name, { ts: Number(rec.v.ts) || 0, n: Number(rec.v.n) || 0 });
  tryApply(name);
});

window.VoxelSyncInfo = { keys: () => Object.keys(MIRROR).map(k => MIRROR[k]) };
})();
