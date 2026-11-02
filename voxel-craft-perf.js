/* voxel-craft-perf.js  描画の軽量化（新しいファイル）
 *  ・今ある buildMesh（ext.js のカスタムブロック・モデル・発光を描く版を含む）を包む。描き方は一切変えない
 *  ・チャンクを作るとき、周りの地形がまだ無ければ、フレームごとに1つずつ作って分散させる
 *    （これまでは最大26チャンク分を同じフレームで作っていたため、一瞬のカクつきの原因になっていた）
 *  ・読み込み順：voxel-craft-ext.js の後（ext が buildMesh を用意したあとで包むため）
 */
(function () {
'use strict';

const base = window.buildMesh;
if (typeof base !== 'function') {
  console.warn('voxel-craft-perf.js: buildMesh が見つからないため、何もしません（ext.js の後に読み込んでください）');
  return;
}

// 境界に必要な、まだ地形データを作っていない隣のチャンクを探す
function firstMissingNeighbour(e) {
  for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    if (dx === 0 && dy === 0 && dz === 0) continue;
    // 下の隣は、境界の1段（底より上にあるとき）だけ使う。底より下は岩盤なので作らなくてよい
    if (dy === -1 && e.cy * CS - 1 <= BOTTOM) continue;
    const cx = e.cx + dx, cy = e.cy + dy, cz = e.cz + dz;
    const n = chunks.get(ckey(cx, cy, cz));
    if (!n || !n.gen) return [cx, cy, cz];
  }
  return null;
}

window.buildMesh = function (e) {
  if (!e.gen) generateEntry(e);
  if (e.data) {
    const miss = firstMissingNeighbour(e);
    if (miss) {
      getEntry(miss[0], miss[1], miss[2]);   // 隣の地形を1つだけ作る（重いので、フレームを分ける）
      requestMesh(e);                        // 次のフレームで、この続きを作る
      return;
    }
  }
  return base.call(this, e);                 // 描き方は、今の buildMesh にそのまま任せる
};
window.VoxelPerf = { version: 2 };
})();
