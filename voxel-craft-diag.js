/* voxel-craft-diag.js (v1)  斜めグリッド配置
 *  ・「設定」→「斜めグリッド配置」で角度を決めると、その角度に傾いた格子（横方向）にブロックを置ける
 *  ・都市の斜めの区画づくり用。角度は 0（通常）〜89.5 度
 *  ・置いたブロックは保存され（この端末）、マルチプレイでは相手にも届く
 *  ・当たり判定はない（歩けてしまう）。見た目と配置のためのもの
 * 読み込み順： … fx → diag → players → ui
 */
(function () {
'use strict';

const KEY = 'voxelcraft_diag_v1';
const DEG_KEY = 'voxelcraft_diag_deg';
const recs = new Map();     // キー -> 記録 { key, id, h, a, i, j, k, st, ts, ent }
const waiting = [];         // 定義がまだ届いていない記録
let deg = 0;
try { deg = Math.min(89.5, Math.max(0, Number(localStorage.getItem(DEG_KEY)) || 0)); } catch (e) {}

// ============================================================
// 1. 格子の計算（原点は世界の中心。角度ごとに傾いた格子）
// ============================================================
const UP = new THREE.Vector3(0, 1, 0);
function frame(a) {
  const t = a * Math.PI / 180;
  return {
    u: new THREE.Vector3(Math.cos(t), 0, Math.sin(t)),     // 格子の横方向
    v: new THREE.Vector3(-Math.sin(t), 0, Math.cos(t)),    // 格子の奥行き方向
    q: new THREE.Quaternion().setFromAxisAngle(UP, -t)     // ブロックの向き（格子に合わせる）
  };
}
function cellOf(p, a) {
  const F = frame(a);
  return { i: Math.floor(p.dot(F.u)), j: Math.floor(p.dot(F.v)), k: Math.floor(p.y) };
}
function centerOf(c, a) {
  const F = frame(a);
  return new THREE.Vector3()
    .addScaledVector(F.u, c.i + 0.5)
    .addScaledVector(F.v, c.j + 0.5)
    .add(new THREE.Vector3(0, c.k + 0.5, 0));
}
function keyFor(a, c) { return Number(a).toFixed(2) + '|' + c.i + ',' + c.j + ',' + c.k; }

// ============================================================
// 2. 画面に出す・消す
// ============================================================
function addVisual(r) {
  const F = frame(r.a);
  const cc = centerOf(r, r.a);
  if (!addTilt(r.id, [cc.x, cc.y, cc.z], F.q, r.st)) return false;
  const ent = tiltList[tiltList.length - 1];
  ent.diag = r.key;
  r.ent = ent;
  return true;
}
function removeVisual(r) {
  if (r.ent) removeTilt(r.ent);
  r.ent = null;
}
// 置けるかどうか（定義がまだなら false）
function resolveId(r) {
  const id = r.h ? VoxelCustom.localIdFor(r.h) : r.id;
  if (id == null) return false;
  if (id >= CUSTOM_BASE) {
    const rt = defRT.get(id);
    if (!rt || !rt.ready) return false;
  }
  r.id = id;
  return true;
}
function tryVisual(r) {
  if (!resolveId(r)) return false;
  return addVisual(r);
}

// ============================================================
// 3. 保存と通信
// ============================================================
function save() {
  try {
    const list = [...recs.values()].map(r => ({ key: r.key, id: r.id, h: r.h, a: r.a, i: r.i, j: r.j, k: r.k, st: r.st, ts: r.ts }));
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch (e) {}
}
function sendRec(r) {
  const v = { a: r.a, i: r.i, j: r.j, k: r.k, st: r.st, ts: r.ts };
  if (r.h) v.h = r.h; else v.id = r.id;
  VoxelMulti.send('dg:' + r.key, v);
}

// ============================================================
// 4. 置く・壊す
// ============================================================
function placeDiag(id) {
  const p = pickTarget();
  if (!p) return;
  const q = p.point.clone().addScaledVector(p.normal, 0.5);
  const c = cellOf(q, deg);
  const key = keyFor(deg, c);
  if (recs.has(key)) { toast('ここにはもうブロックがあります'); return; }
  const cc = centerOf(c, deg);
  if (getBlock(Math.floor(cc.x), Math.floor(cc.y), Math.floor(cc.z)) !== AIR &&
      getBlock(Math.floor(cc.x), Math.floor(cc.y), Math.floor(cc.z)) !== WATER) {
    toast('通常のブロックがあるため置けません'); return;
  }
  const pp = player.pos;
  if (Math.abs(cc.x - pp.x) < 0.9 && Math.abs(cc.z - pp.z) < 0.9 && cc.y + 0.5 > pp.y && cc.y - 0.5 < pp.y + 1.8) {
    toast('自分の位置には置けません'); return;
  }
  const rt = id >= CUSTOM_BASE ? defRT.get(id) : null;
  if (id >= CUSTOM_BASE && (!rt || !rt.ready)) return;
  const r = {
    key, id, a: deg, i: c.i, j: c.j, k: c.k, ts: Date.now(),
    st: rt ? { color: rt.def.colorable ? ext.curColor : null, rot: ext.rot } : null,
    h: rt ? VoxelCustom.publishDef(rt.def) : null
  };
  if (!addVisual(r)) { toast('このブロックは斜めには置けません'); return; }
  recs.set(key, r);
  save();
  sendRec(r);
  if (rt && rt.def.colorable && typeof pushHistory === 'function') pushHistory(ext.curColor);
  playPlace(id);
}
function removeDiag(r) {
  removeVisual(r);
  recs.delete(r.key);
  save();
  VoxelMulti.send('dg:' + r.key, undefined, true);
  playBreak(r.id);
}

const prevPlace = window.doPlace;
window.doPlace = function () {
  if (!deg) return prevPlace();
  const id = HOTBAR[selIdx];
  if (isTool(id)) return prevPlace();
  placeDiag(id);
};
const prevBreak = window.doBreak;
window.doBreak = function () {
  const p = pickTarget();
  if (p && p.kind === 'tilt' && p.ent && p.ent.diag) {
    const r = recs.get(p.ent.diag);
    if (r) removeDiag(r);
    return;
  }
  return prevBreak();
};

// ============================================================
// 5. 相手の置いた斜めブロック
// ============================================================
VoxelMulti.onOp('dg', rec => {
  const key = String(rec.key).slice(3);
  const cur = recs.get(key);
  if (cur && cur.ts > (rec.ts || 0)) return;          // 新しい方が勝つ
  if (cur) { removeVisual(cur); recs.delete(key); }
  if (rec.del) { save(); return; }
  const v = rec.v || {};
  const r = { key, id: v.id, h: v.h || null, a: Number(v.a), i: v.i, j: v.j, k: v.k, st: v.st || null, ts: rec.ts || 0 };
  recs.set(key, r);
  if (!tryVisual(r)) waiting.push(r);                  // 定義が届くまで待つ
  save();
});

function retryWaiting() {
  for (let n = waiting.length - 1; n >= 0; n--) {
    const r = waiting[n];
    if (recs.get(r.key) !== r) { waiting.splice(n, 1); continue; }
    if (tryVisual(r)) waiting.splice(n, 1);
  }
}
VoxelCustom.onAdopt(retryWaiting);
setInterval(retryWaiting, 1000);

// ============================================================
// 6. 起動（保存していた斜めブロックを、画面に戻す）
// ============================================================
try {
  for (const r of JSON.parse(localStorage.getItem(KEY) || '[]')) {
    if (!r || typeof r.key !== 'string') continue;
    recs.set(r.key, r);
    if (!tryVisual(r)) waiting.push(r);
  }
} catch (e) {}

// ============================================================
// 7. 設定画面の項目（角度）
// ============================================================
function setDeg(v) {
  deg = Math.min(89.5, Math.max(0, Number(v) || 0));
  try { localStorage.setItem(DEG_KEY, String(deg)); } catch (e) {}
  const inp = document.getElementById('diagDeg');
  if (inp) inp.value = String(deg);
}
function addSection() {
  const sbox = document.querySelector('#settings .sbox');
  const closeBtn = document.getElementById('settingsClose');
  if (!sbox || !closeBtn) return;
  const sec = document.createElement('div');
  sec.innerHTML = `
    <h3>斜めグリッド配置</h3>
    <label style="display:block;margin-top:6px">角度（度）
      <input class="ext-input" id="diagDeg" type="number" min="0" max="89.5" step="0.5" style="width:100px;margin-left:6px">
    </label>
    <div class="ext-row" style="margin-top:6px">
      <button class="ext-btn sub" data-d="0">0°（通常）</button>
      <button class="ext-btn sub" data-d="15">15°</button>
      <button class="ext-btn sub" data-d="30">30°</button>
      <button class="ext-btn sub" data-d="45">45°</button>
    </div>
    <p class="note">0°以外にすると、ブロックは選んだ角度に傾いた格子に置かれます（都市の斜めの区画向け）。当たり判定はなく、歩けてしまいます。置いたブロックは保存され、マルチプレイでは相手にも届きます。</p>`;
  sbox.insertBefore(sec, closeBtn);
  const inp = document.getElementById('diagDeg');
  inp.value = String(deg);
  inp.addEventListener('change', () => setDeg(inp.value));
  sec.querySelectorAll('[data-d]').forEach(b => b.addEventListener('click', () => setDeg(b.getAttribute('data-d'))));
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addSection);
else addSection();

window.VoxelDiag = { angle: () => deg, setAngle: setDeg, count: () => recs.size };
})();
