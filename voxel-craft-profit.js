/* voxel-craft-profit.js  利益地点の判定（経済アプリの「利益地点」）
 *
 *  範囲（2点で選んだ箱）に、人混み・自動車・電車が入ったら、
 *  1人・1台・1編成ごとに、その地点の金額を会社に入れる（VoxelEconomy.addIncome）。
 *  ・範囲の外へ出て、また入ったら、もう一度払う（同じ入り方で何度も稼がないよう、入った回数で数える）
 *  ・判定は「持ち主（計算している端末）」だけが行う。ほかの端末は数えないので、二重に払われない
 *  ・起動して最初の判定では、もう範囲の中にいる人・車・電車は払わない（起動直後の取りこぼし・二重を防ぐ）
 *  ・上限は設けない（通過ごとの金額だけ）
 *
 *  読み込み：voxel-craft-ext.js が自動で読み込む（voxel-craft-economy.js の後）
 */
(function () {
'use strict';
if (window.VoxelProfit) return;

const LABEL = { crowd: '人混み', car: '自動車', train: '電車' };
const inside = new Map();   // 地点の id -> Set（前の判定で範囲の中にいた人・車・電車の id）
const primed = new Set();   // 一度でも判定した地点の id

// 種類ごとの、現在の位置（owner＝この端末が計算している側だけ true）
function source(kind) {
  try {
    if (kind === 'crowd' && window.VoxelCrowd && VoxelCrowd.humanPoints) return VoxelCrowd.humanPoints();
    if (kind === 'car' && window.VoxelTraffic && VoxelTraffic.carPoints) return VoxelTraffic.carPoints();
    if (kind === 'train' && window.VoxelStation && VoxelStation.trainPoints) return VoxelStation.trainPoints();
  } catch (e) { console.error(e); }
  return null;
}

// 位置が、範囲（最小の角と最大の角。どちらも整数のブロック座標）の中か
function inBox(p, min, max) {
  const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
  return x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1] && z >= min[2] && z <= max[2];
}

function tick() {
  if (!window.VoxelEconomy || !VoxelEconomy.allPoints) return;
  const points = VoxelEconomy.allPoints();

  // 消された地点の記録は捨てる
  const alive = new Set(points.map(p => p.id));
  for (const id of [...inside.keys()]) if (!alive.has(id)) { inside.delete(id); primed.delete(id); }
  if (!points.length) return;

  const cache = {};
  for (const p of points) {
    if (!LABEL[p.cond]) continue;
    if (!(p.cond in cache)) cache[p.cond] = source(p.cond);
    const s = cache[p.cond];
    if (!s || !s.owner || !Array.isArray(s.list)) continue;   // 持ち主ではない端末は、数えない

    const before = inside.get(p.id) || new Set();
    const now = new Set();
    let entered = 0;
    for (const e of s.list) {
      if (!inBox(e, p.min, p.max)) continue;
      now.add(e.id);
      if (!before.has(e.id)) entered++;   // 外から中へ入ってきた分だけ数える
    }
    inside.set(p.id, now);

    if (!primed.has(p.id)) { primed.add(p.id); continue; }   // 最初の判定は、今の人数を覚えるだけ
    if (entered > 0) {
      const name = p.name || '名前なし';
      VoxelEconomy.addIncome(p.cid, p.amount * entered, '利益地点（' + name + '）' + LABEL[p.cond] + ' ' + entered + '回');
    }
  }
}

setInterval(tick, 200);

window.VoxelProfit = {
  tick,
  stats: () => ({ tracking: inside.size })
};
})();
