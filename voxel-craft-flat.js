/* voxel-craft-flat.js  フラットモード（新しいファイル）
 *  ・新規ワールドで「通常（ランダム地形）」と「フラット」を選べる
 *  ・フラット：地表の高さは全部同じ。下から「石3段・土2段・草ブロック」
 *  ・無限に広がる（チャンクは本体と同じ仕組みで、見えた分だけ作る）
 *  ・モードは「シードの特別な値」で表す。シードは共有リンク・部屋の記録・保存ファイルで
 *    すでに運ばれているので、マルチプレイでも同じ地形になる（追加の通信は要らない）
 *  ・読み込み順：本体HTML → voxel-craft-save.js の後（VoxelWorld を使う）
 *
 *  本体の地形の関数（surfaceHeight / terrainType / treeInCell）を、この端末の中だけで差し替える。
 *  本体HTMLは変更しない。通常の地形のシードは、これまでどおり動く。
 */
(function () {
'use strict';

// フラットを表す番兵のシード（'FLAT' の ASCII 値）。通常のシードとは別の値として扱う
const FLAT_SEED = 1179402580;
const FLAT_TOP = 64;          // 草ブロックの高さ（海面 SEA=62 より上。水が入らない）

function isFlatNow() {
  return !!(window.VoxelWorld && VoxelWorld.getSeed && VoxelWorld.getSeed() === FLAT_SEED);
}

// 本体の関数を退避して、フラットのときだけ差し替える（通常のときは本体の計算をそのまま使う）
const origSurface = window.surfaceHeight;
const origTerrain = window.terrainType;
const origTree = window.treeInCell;

window.surfaceHeight = function (x, z) {
  if (isFlatNow()) return FLAT_TOP;
  return origSurface(x, z);
};

// 地層：一番上が草、その下2段が土、そのさらに下（3段）が石、それより下も石（底の岩盤は本体が決める）
window.terrainType = function (wx, wy, wz, h) {
  if (!isFlatNow()) return origTerrain(wx, wy, wz, h);
  if (wy === h) return GRASS;
  if (wy >= h - 2) return DIRT;          // h-1, h-2 の2段
  return STONE;                          // それより下は石
};

// フラットには木を生やさない（平らな草原だけ）
window.treeInCell = function (cx, cz) {
  if (isFlatNow()) return null;
  return origTree(cx, cz);
};

// ============================================================
// 新規ワールド画面に「地形」の選択を出す（シングルプレイの最初の画面）
// ============================================================
function injectPicker() {
  const seedEl = document.getElementById('wsSeed');
  if (!seedEl || document.getElementById('flatSel')) return;
  const wrap = document.createElement('div');
  wrap.style.margin = '0 0 8px';
  wrap.innerHTML =
    '<select id="flatSel" style="width:100%;padding:8px;box-sizing:border-box;border-radius:8px">' +
    '<option value="normal">通常（ランダムな山・川・海）</option>' +
    '<option value="flat">フラット（石3段・土2段・草ブロック）</option>' +
    '</select>';
  seedEl.parentNode.insertBefore(wrap, seedEl);
  const sel = wrap.querySelector('#flatSel');

  function apply(mode) {
    if (mode === 'flat') {
      seedEl.value = String(FLAT_SEED);
      seedEl.disabled = true;
    } else {
      if (seedEl.value === String(FLAT_SEED)) seedEl.value = '';
      seedEl.disabled = false;
    }
  }
  sel.addEventListener('change', () => apply(sel.value));
  // 前に作ったワールドがフラットなら、選択も合わせる
  if (isFlatNow()) sel.value = 'flat';
  apply(sel.value);
}
// 画面はあとから作られるので、見つかるまで待つ
const picker = setInterval(() => { injectPicker(); if (document.getElementById('flatSel')) clearInterval(picker); }, 300);

window.VoxelFlat = { FLAT_SEED, isFlat: isFlatNow };
})();
