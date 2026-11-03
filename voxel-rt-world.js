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
  if (now !== old && rm && rm.peerId) rm.set('blk:' + x + ',' + y + ',' + z, now);
  return r;
};

function onBlk(key, v, meta) {
  const m = KEY_RE.exec(key);
  if (!m) return;
  const t = v === undefined ? 0 : v;              // 削除は空気（0）として扱う
  if (!Number.isInteger(t) || t < 0 || t > 65535) return;
  queue.push([+m[1], +m[2], +m[3], t]);
  pump();
}

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
    const t = !e || e.del ? 0 : e.v;
    if (!Number.isInteger(t) || t < 0 || t > 65535) continue;
    queue.push([+m[1], +m[2], +m[3], t]);
  }
  pump();
}

function attach(room) {
  if (detach) { detach(); detach = null; }
  queue.length = 0;
  rm = room || null;
  if (!rm) return;
  rm.on('blk', onBlk);
  detach = () => { rm && rm.handlers && rm.handlers.delete('blk'); };
}

if (window.VoxelRTUI && window.VoxelRTUI.onRoom) window.VoxelRTUI.onRoom(attach);
window.VoxelRTWorld = { attach, apply: applyEntries, pending: () => queue.length };
})();
