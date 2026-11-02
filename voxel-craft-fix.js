/* voxel-craft-fix.js  地形のずれ・白い画面の対策（新しいファイル）
 *  1. 地形の高さ・木の位置のキャッシュは、シードが変わったら消す
 *     （消さないと、既定のシードで作った高さが、保存ワールドの地形に残って、建物や地形がずれる）
 *  2. キャッシュが大きくなりすぎたら消す（長く遊ぶとメモリが増え続け、タブが落ちるのを防ぐ）
 *     どちらも、消したあとで計算し直すだけなので、地形の結果は変わらない
 *  3. 予期しないエラーを、画面の下に文字で出す（白い画面の原因を、そのまま教えてもらえるように）
 *  読み込み順：voxel-craft-save.js の後（flat.js・ext.js・perf.js より後でもよい）
 */
(function () {
'use strict';

const MAX_ENTRIES = 300000;          // キャッシュの上限（これを超えたら、いったん全部消す）
let lastHash = window.hash2;         // 今のシードの目印（シードが変わると、save.js が hash2 を差し替える）

function syncSeed() {
  if (window.hash2 !== lastHash) {
    lastHash = window.hash2;
    if (typeof heightCache !== 'undefined') heightCache.clear();
    if (typeof treeCache !== 'undefined') treeCache.clear();
  }
  if (typeof heightCache !== 'undefined' && heightCache.size > MAX_ENTRIES) heightCache.clear();
  if (typeof treeCache !== 'undefined' && treeCache.size > MAX_ENTRIES) treeCache.clear();
}

if (typeof window.surfaceHeight === 'function') {
  const origSurface = window.surfaceHeight;
  window.surfaceHeight = function (x, z) { syncSeed(); return origSurface.call(this, x, z); };
}
if (typeof window.treeInCell === 'function') {
  const origTree = window.treeInCell;
  window.treeInCell = function (cx, cz) { syncSeed(); return origTree.call(this, cx, cz); };
}

// ============================================================
// 予期しないエラーを、画面の下に出す（何が起きたかを確かめやすくする）
// ============================================================
let errBox = null;
function showError(msg) {
  try {
    if (!errBox) {
      errBox = document.createElement('div');
      errBox.id = 'vcFixErr';
      errBox.style.cssText = 'position:fixed;left:6px;right:6px;bottom:6px;z-index:99;background:rgba(120,20,20,.92);color:#fff;' +
        'font:12px/1.5 monospace;padding:8px 10px;border-radius:8px;max-height:30vh;overflow:auto;white-space:pre-wrap;word-break:break-all';
      const x = document.createElement('button');
      x.textContent = '×';
      x.style.cssText = 'float:right;background:none;border:none;color:#fff;font-size:16px;cursor:pointer';
      x.addEventListener('click', () => errBox.remove());
      errBox.appendChild(x);
      document.body.appendChild(errBox);
    }
    const line = document.createElement('div');
    line.textContent = new Date().toLocaleTimeString() + '  ' + msg;
    errBox.appendChild(line);
  } catch (e) {}
}
window.addEventListener('error', e => showError('エラー: ' + (e.message || '') + (e.filename ? ' (' + e.filename.split('/').pop() + ':' + e.lineno + ')' : '')));
window.addEventListener('unhandledrejection', e => showError('非同期エラー: ' + (e.reason && (e.reason.message || e.reason) || '')));

// 描画（WebGL）が、GPUのメモリ不足などで失われたとき（iPad などで起きやすい・白い画面の原因）
// 自動で読み直す。読み直す前に、保存と同じ処理（pagehide）が走るので、作業は保存される
const cv = document.getElementById('c');
if (cv) {
  cv.addEventListener('webglcontextlost', e => {
    e.preventDefault();
    showError('描画が止まりました（端末のメモリ不足の可能性）。2秒後に自動で読み直します');
    setTimeout(() => location.reload(), 2000);
  }, false);
}

window.VoxelFix = { syncSeed };
})();
