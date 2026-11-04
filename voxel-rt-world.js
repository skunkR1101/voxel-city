/* voxel-rt-world.js  ブロックの設置・破壊の同期（第3段階）
 *  ・自分が置いた・壊したブロックを、部屋の記録（blk:x,y,z）に入れて、全員へ送る
 *  ・相手の変更は、受け取ったら同じ setBlock で反映する（送り返さない）
 *  ・後から入った人は、スナップショットで今の全ブロックの変更を受け取る（大量のときは少しずつ反映）
 *  ・ゲームの setBlock の、いちばん外側に付ける（ほかの仕組み（ext・save など）の処理はそのまま通る）
 *  注意：地形の種類（シード・フラット）が違う人どうしでは、ブロックの位置がずれて見える
 *  読み込み順：voxel-rt-ui.js の後
 */
(function () {
'use strict';

const APPLY_PER_FRAME = 300;     // 1フレームに反映するブロック数の上限（重くならないように）
const KEY_RE = /^blk:(-?\d+),(-?\d+),(-?\d+)$/;

let rm = null;                   // 今の部屋（入っていないときは null）
let applying = false;            // 相手の変更を反映している間は、送り返さない
const queue = [];                // [x, y, z, t] の反映待ち
let pumping = false;
let detach = null;

const origSet = window.setBlock;
window.setBlock = function (x, y, z, t) {
  if (applying || !rm || typeof getBlock !== 'function') return origSet.apply(this, arguments);
  const old = getBlock(x, y, z);
  const r = origSet.apply(this, arguments);
  const now = getBlock(x, y, z);
  if (now !== old && rm && rm.peerId) rm.set('blk:' + x + ',' + y + ',' + z, encodeT(now));
  return r;
};

// カスタムブロックは、端末ごとに番号が違うことがあるので、番号と「中身のしるし」を一緒に送る
// 受け取る側は、しるしで自分の同じ中身のブロックの番号に読み替える（同じ見た目になるように）
const CUSTOM_MIN = 100;
const unresolved = new Map();      // blk key -> {x,y,z,h}：まだ同じ中身の定義が届いていないもの
function encodeT(t) {
  if (t < CUSTOM_MIN || !window.VoxelExt || !VoxelExt.ext || !window.VoxelCustom) return t;
  const d = VoxelExt.ext.defs.find(x => x.id === t);
  return d ? { t, h: VoxelCustom.defHash(d) } : t;
}
function decodeT(v) {
  if (v && typeof v === 'object') return { t: v.t, h: typeof v.h === 'string' ? v.h : null };
  return { t: v, h: null };
}
// 受け取った番号を、この端末の番号に読み替える（見つからなければ、そのまま）
function localT(t, h) {
  if (!h || !window.VoxelCustom) return { t, found: true };
  const id = VoxelCustom.localIdFor(h);
  return id === null ? { t, found: false } : { t: id, found: true };
}

function onBlk(key, v, meta) {
  const m = KEY_RE.exec(key);
  if (!m) return;
  if (window.VoxelRTUnify && VoxelRTUnify.skipBlk(key)) return;   // 統一より前の変更は無視
  const d = v === undefined ? { t: 0, h: null } : decodeT(v);     // 削除は空気（0）として扱う
  if (!Number.isInteger(d.t) || d.t < 0 || d.t > 65535) return;
  const r = localT(d.t, d.h);
  if (!r.found) unresolved.set(key, { x: +m[1], y: +m[2], z: +m[3], h: d.h }); else unresolved.delete(key);
  queue.push([+m[1], +m[2], +m[3], r.t]);
  pump();
}
// 定義が後から届いたら、待っていたブロックを正しい番号にする
setInterval(() => {
  for (const [key, u] of unresolved) {
    const r = localT(-1, u.h);
    if (!r.found || r.t < 0) continue;
    unresolved.delete(key);
    queue.push([u.x, u.y, u.z, r.t]);
  }
  if (unresolved.size === 0 && queue.length === 0) return;
  pump();
}, 3000);

function pump() {
  if (pumping) return;
  pumping = true;
  const step = () => {
    let n = 0;
    applying = true;
    try {
      while (queue.length && n < APPLY_PER_FRAME) {
        const [x, y, z, t] = queue.shift();
        if (getBlock(x, y, z) !== t) window.setBlock(x, y, z, t);
        n++;
      }
    } finally { applying = false; }
    if (queue.length) requestAnimationFrame(step);
    else pumping = false;
  };
  requestAnimationFrame(step);
}

// 保存（GitHub）から読んだ変更を、画面のブロックへ反映する（送り返さない）
function applyEntries(list) {
  for (const [key, e] of list) {
    const m = KEY_RE.exec(key);
    if (!m) continue;
    if (window.VoxelRTUnify && VoxelRTUnify.skipBlk(key)) continue;
    const d = !e || e.del ? { t: 0, h: null } : decodeT(e.v);
    if (!Number.isInteger(d.t) || d.t < 0 || d.t > 65535) continue;
    const r = localT(d.t, d.h);
    if (!r.found) unresolved.set(key, { x: +m[1], y: +m[2], z: +m[3], h: d.h }); else unresolved.delete(key);
    queue.push([+m[1], +m[2], +m[3], r.t]);
  }
  pump();
}

function attach(room) {
  if (detach) { detach(); detach = null; }
  queue.length = 0;
  unresolved.clear();
  rm = room || null;
  if (!rm) return;
  rm.on('blk', onBlk);
  detach = () => { rm && rm.handlers && rm.handlers.delete('blk'); };
}

if (window.VoxelRTUI && window.VoxelRTUI.onRoom) window.VoxelRTUI.onRoom(attach);
window.VoxelRTWorld = { attach, apply: applyEntries, pending: () => queue.length };
})();
