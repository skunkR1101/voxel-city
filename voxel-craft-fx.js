/* voxel-craft-fx.js (v2)  カスタムブロックの見え方（ブロックを追加するときに決める。全員に共通）
 *  ・くり抜き：従来どおり。透明な部分は完全に抜く
 *  ・半透過  ：テクスチャの透明度どおりに、向こうが透けて見える
 *  ・発光    ：ブロックそのものが光る。周りを照らす光は ext.js が、チャンク内の発光ブロックから描く
 *  見え方は「ブロックの定義」に入っているので、相手にも同じように届く（個人設定はない）。
 * 読み込み順： … custom → fx → diag → players → ui
 */
(function () {
'use strict';
const { CUSTOM_BASE, ext, defRT } = window.VoxelExt;

// 材質に見え方を反映する
function styleMat(m, mode, map, cutTest, power) {
  if (!m) return;
  if (mode === 'blend' || mode === 'glow') {
    m.transparent = true; m.alphaTest = 0; m.depthWrite = false;
  } else {
    m.transparent = false; m.alphaTest = map ? cutTest : 0; m.depthWrite = true;
  }
  if (mode === 'glow') {
    const k = Math.min(2, Math.max(0.3, (power || 1.5) / 1.5));   // 発光の強さ（自分の画面の中でも同じ）
    m.emissive.setRGB(k, k, k);
    m.emissiveMap = map || null;
  } else {
    m.emissive.setRGB(0, 0, 0);
    m.emissiveMap = null;
  }
  m.needsUpdate = true;
}

// 定義の見た目を反映する（読み込みが終わっていなければ false）
function applyDef(def) {
  const rt = defRT.get(def.id);
  if (!rt || !rt.ready) return false;
  const mode = def.alpha || 'cut';
  rt.alphaMode = mode;
  rt.avg = null;
  if (def.kind === 'cube') {
    styleMat(rt.material, mode, rt.tex, 0.3, def.glowPower);
  } else if (rt.template) {
    rt.template.traverse(c => {
      if (!c.isMesh) return;
      (Array.isArray(c.material) ? c.material : [c.material]).forEach(m => styleMat(m, mode, m.map, 0.5, def.glowPower));
    });
  }
  return true;
}
function ensureApplied(def, tries) {
  tries = tries || 0;
  if (applyDef(def) || tries > 150) return;
  setTimeout(() => ensureApplied(def, tries + 1), 200);
}

for (const d of ext.defs) if (d.id >= CUSTOM_BASE) ensureApplied(d);

window.VoxelFx = { apply: applyDef, MODES: [['cut', 'くり抜き'], ['blend', '半透過'], ['glow', '発光']] };
})();
