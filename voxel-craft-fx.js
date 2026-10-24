/* voxel-craft-fx.js (v1)  カスタムブロックの見え方：くり抜き／半透過／発光
 *  ・くり抜き：従来どおり。透明な部分は完全に抜く
 *  ・半透過  ：テクスチャの透明度どおりに、向こうが透けて見える（マイクラ風）
 *  ・発光    ：半透明の部分が光る。シェーダーON のとき、近くの地面や壁も同じ色で照らす
 *  設定は「設定」画面の「カスタムブロックの見え方」から変える。
 * 読み込み順： … custom → fx → diag → players → ui
 */
(function () {
'use strict';

const MODES = [
  ['cut', 'くり抜き（従来どおり）'],
  ['blend', '半透過（透けて見える）'],
  ['glow', '発光（半透明の部分が光る）']
];
const LIGHTS = 6;            // 照明の数（常に同じ数にして、描画の作り直しを防ぐ）
const LIGHT_RANGE = 7;       // 光が届く距離（ブロック）
const LIGHT_POWER = 1.6;     // 光の強さ（シェーダーON時）
const SCAN = 5;              // 発光ブロックを探す範囲（プレイヤーからのブロック数）
const SCAN_MS = 300;

// ============================================================
// 1. 材質の見た目（透明度・発光）
// ============================================================
function styleMat(m, mode, map, cutTest) {
  if (!m) return;
  if (mode === 'blend' || mode === 'glow') {
    m.transparent = true; m.alphaTest = 0; m.depthWrite = false;
  } else {
    m.transparent = false; m.alphaTest = map ? cutTest : 0; m.depthWrite = true;
  }
  if (mode === 'glow') { m.emissive.setRGB(1, 1, 1); m.emissiveMap = map || null; }
  else { m.emissive.setRGB(0, 0, 0); m.emissiveMap = null; }
  m.needsUpdate = true;
}

// 定義の見た目を、いま設定されている方法で反映する（読み込みが終わっていなければ false）
function applyDef(def) {
  const rt = defRT.get(def.id);
  if (!rt || !rt.ready) return false;
  const mode = def.alpha || 'cut';
  rt.alphaMode = mode;
  rt.avg = null;   // 発光の色は、設定が変わるたびに計り直す
  if (def.kind === 'cube') {
    styleMat(rt.material, mode, rt.tex, 0.3);
  } else if (rt.template) {
    rt.template.traverse(c => {
      if (!c.isMesh) return;
      (Array.isArray(c.material) ? c.material : [c.material]).forEach(m => styleMat(m, mode, m.map, 0.5));
    });
  }
  return true;
}
function ensureApplied(def, tries) {
  tries = tries || 0;
  if (applyDef(def) || tries > 150) return;
  setTimeout(() => ensureApplied(def, tries + 1), 200);
}

// 設定を変える（相手にも、次に置くブロックから新しい見た目が届く）
function setMode(def, mode) {
  def.alpha = mode;
  if (typeof saveExt === 'function') saveExt();
  applyDef(def);
  if (window.VoxelCustom) { VoxelCustom.invalidate(def); VoxelCustom.publishDef(def); }
}

// ============================================================
// 2. 発光の色（テクスチャの平均色）と、周りを照らす照明
// ============================================================
function avgColorOf(rt) {
  if (rt.avg) return rt.avg;
  let col = [1, 1, 1];
  try {
    const img = rt.tex && rt.tex.image;
    if (img && (img.width || img.naturalWidth)) {
      const c = document.createElement('canvas');
      c.width = 8; c.height = 8;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, 8, 8);
      const d = g.getImageData(0, 0, 8, 8).data;
      let r = 0, gg = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
      if (n) col = [r / n / 255, gg / n / 255, b / n / 255];
    }
  } catch (e) {}
  rt.avg = col;
  return col;
}

const lights = [];
for (let i = 0; i < LIGHTS; i++) {
  const l = new THREE.PointLight(0xffffff, 0, LIGHT_RANGE, 1.2);
  scene.add(l);
  lights.push(l);
}

function glowRt(t) {
  if (t < CUSTOM_BASE) return null;
  const rt = defRT.get(t);
  return rt && rt.ready && rt.def.alpha === 'glow' ? rt : null;
}

function scanGlow() {
  if (typeof player === 'undefined' || !player) return;
  const p = player.pos;
  const px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z);
  const found = [];
  const d2 = (x, y, z) => (x - p.x) * (x - p.x) + (y - p.y) * (y - p.y) + (z - p.z) * (z - p.z);
  for (let dx = -SCAN; dx <= SCAN; dx++) for (let dy = -SCAN; dy <= SCAN; dy++) for (let dz = -SCAN; dz <= SCAN; dz++) {
    const x = px + dx, y = py + dy, z = pz + dz;
    const rt = glowRt(getBlock(x, y, z));
    if (rt) found.push({ x: x + 0.5, y: y + 0.5, z: z + 0.5, rt, d: d2(x + 0.5, y + 0.5, z + 0.5) });
  }
  if (typeof tiltList !== 'undefined') {
    for (const e of tiltList) {
      const rt = glowRt(e.id);
      if (rt) found.push({ x: e.c[0], y: e.c[1], z: e.c[2], rt, d: d2(e.c[0], e.c[1], e.c[2]) });
    }
  }
  found.sort((a, b) => a.d - b.d);
  for (let i = 0; i < LIGHTS; i++) {
    const l = lights[i];
    const f = found[i];
    if (!f || !shaderOn || f.d > (LIGHT_RANGE + 2) * (LIGHT_RANGE + 2)) { l.intensity = 0; continue; }
    const c = avgColorOf(f.rt);
    l.color.setRGB(c[0], c[1], c[2]);
    l.position.set(f.x, f.y, f.z);
    l.intensity = LIGHT_POWER;
  }
}
setInterval(scanGlow, SCAN_MS);

// ============================================================
// 3. 設定画面の項目
// ============================================================
let lastSig = null;
function sig() {
  return ext.defs.filter(d => d.id >= CUSTOM_BASE).map(d => d.id + ':' + d.name + ':' + (d.alpha || 'cut')).join('|');
}
function renderList(force) {
  const box = document.getElementById('fxList');
  if (!box) return;
  const s = sig();
  if (!force && s === lastSig) return;
  lastSig = s;
  box.innerHTML = '';
  const defs = ext.defs.filter(d => d.id >= CUSTOM_BASE);
  if (!defs.length) {
    const n = document.createElement('p');
    n.className = 'note';
    n.textContent = 'カスタムブロックはまだありません。';
    box.appendChild(n);
    return;
  }
  for (const d of defs) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;margin:4px 0;flex-wrap:wrap';
    const nm = document.createElement('div');
    nm.style.cssText = 'flex:1;min-width:110px;font-size:13px';
    nm.textContent = d.name;
    const sel = document.createElement('select');
    sel.className = 'ext-input';
    for (const [v, label] of MODES) {
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      if ((d.alpha || 'cut') === v) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => setMode(d, sel.value));
    row.append(nm, sel);
    box.appendChild(row);
  }
}

function addSection() {
  const sbox = document.querySelector('#settings .sbox');
  const closeBtn = document.getElementById('settingsClose');
  if (!sbox || !closeBtn) return;
  const sec = document.createElement('div');
  sec.innerHTML = `
    <h3>カスタムブロックの見え方</h3>
    <div id="fxList"></div>
    <p class="note">「半透過」は透明な部分が透けます。「発光」は半透明の部分が光り、シェーダーONのとき近くの地面や壁も同じ色で照らします。</p>`;
  sbox.insertBefore(sec, closeBtn);
  renderList(true);
}

// ============================================================
// 起動
// ============================================================
for (const d of ext.defs) if (d.id >= CUSTOM_BASE) ensureApplied(d);
setInterval(() => renderList(false), 1500);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addSection);
else addSection();

window.VoxelFx = { apply: applyDef, setMode, MODES };
})();
