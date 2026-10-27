/* voxel-craft-crowd.js  人混み（新しいファイル。自動車交通（traffic.js）の後に、本体HTMLで読み込む）
 *  ・「人混みマネージャー」（道具）：ステッキのように始点・終点で範囲を選び、「範囲生成」で人混みにする
 *  ・範囲が重なると、自動でひとつにまとまる。範囲ごとに「密度・流れの速さ・人の種類・流れの向き・人混みの音」を長押しで設定
 *  ・人は範囲の中で歩き、範囲の外に出ると消える。どんなに高い位置を選んでも、地面を探して歩く
 *  ・人は標準10種類＋自分のモデル（OBJ/FBX・MTL・テクスチャ）。body / head / leftArm / rightArm / leftLeg / rightLeg の部品で歩く
 *  ・まとめて描く（インスタンス描画）。読み込んだチャンクの外は描画だけ止める
 */
(function () {
'use strict';

const VX = window.VoxelExt, VR = window.VoxelRoad, VM = window.VoxelModels;
if (!VX || !VR || !VM) { console.error('voxel-craft-crowd.js: ext / road / traffic が必要です'); return; }
const T_CROWD = VX.T_CROWD;

const KEY = 'voxelcraft_crowd_v1';
const MAX_H = 600;                 // 同時に歩く人の上限（軽さのため）
const HUMAN_H = 1.8;               // 人の身長（マス）
const PART_KEYS = ['body', 'head', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'];
const ANIM_KEYS = { leftArm: 1, rightArm: 1, leftLeg: 1, rightLeg: 1 };
const PALETTE = ['#ff5a5a', '#ffb347', '#ffe066', '#7ddc6a', '#5ad2ff', '#8f7bff', '#ff7ad9', '#ffffff'];
const DIRS = [
  ['北（+Z）', 0], ['北東', 45], ['東（+X）', 90], ['南東', 135], ['南（−Z）', 180], ['南西', 225], ['西（−X）', 270], ['北西', 315]
];

// ============================================================
// 1. データ
// ============================================================
const C = {
  groups: [],              // { id, rects:[{x1,z1,x2,z2,y}], density, speed, variety:[vid], flow:{mode,deg}, sound:{on,custom,name}, col }
  humans: [],              // { id, v, g, x, y, z, a, sp, ph, tt, tg, k, dead }
  customs: [],             // 自分の人（保存用）
  preview: null,           // 選んだ範囲（まだ生成していない）{x1,z1,x2,z2,y}
  pick: null,              // 1つ目の点 {x,y,z}
  seq: 1, hseq: 1, gseq: 1,
  dirty: true
};
const variants = new Map();   // id -> { id, name, scale, parts:[{key,geo,mat,pivot:[x,y,z],anim}], ims:[], count:0 }
const DEFAULT_IDS = [];
const groupMeshes = new Map();   // groupId -> { plane:[], line:[] }

// 標準の人10種類（色違い・体格違い）
const DEF_HUMANS = [
  { name: 'ふつう', shirt: '#4a90d9', pants: '#3b3b5c', skin: '#f1c27d' },
  { name: 'スーツ', shirt: '#222831', pants: '#1b1f27', skin: '#e0ac69' },
  { name: 'ワンピース', shirt: '#e06c9f', pants: '#e06c9f', skin: '#f1c27d', skirt: true },
  { name: 'パーカー', shirt: '#7f8c8d', pants: '#34495e', skin: '#f1c27d' },
  { name: 'ワーカー', shirt: '#f39c12', pants: '#2c3e50', skin: '#c68642' },
  { name: '学生', shirt: '#ecf0f1', pants: '#2e4057', skin: '#f1c27d' },
  { name: 'ランナー', shirt: '#27ae60', pants: '#111111', skin: '#e0ac69' },
  { name: 'ご年配', shirt: '#8e7cc3', pants: '#5d6d7e', skin: '#d4a373' },
  { name: '子ども', shirt: '#ff7f50', pants: '#4169e1', skin: '#f1c27d', child: true },
  { name: 'ワイルド', shirt: '#8b4513', pants: '#556b2f', skin: '#c68642' }
];

const toCol = hex => new THREE.Color(hex);
function boxGeo(w, h, d, cx, cy, cz) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(cx, cy, cz);
  return g;
}
// 標準の人：部品ごとに、関節（pivot）を原点にした形
function buildDefaultHuman(sp, id) {
  const shirt = toCol(sp.shirt), pants = toCol(sp.pants), skin = toCol(sp.skin);
  const parts = [];
  const add = (key, geo, mat, pivot, anim) => parts.push({ key, geo, mat, pivot, anim: !!anim });
  const M = c => new THREE.MeshLambertMaterial({ color: c });
  // 体（固定）
  add('body', boxGeo(0.46, sp.skirt ? 0.4 : 0.66, 0.24, 0, sp.skirt ? 1.23 : 1.1, 0), M(shirt), [0, 0, 0]);
  if (sp.skirt) add('body', boxGeo(0.5, 0.36, 0.3, 0, 0.9, 0), M(pants), [0, 0, 0]);
  // 頭（固定）
  add('head', boxGeo(0.4, 0.4, 0.4, 0, 1.63, 0), M(skin), [0, 0, 0]);
  // 腕・脚（関節を上端の中心に置いて、そこを中心に振る）
  for (const side of [1, -1]) {
    const ax = 0.33 * side;
    const armPivot = [ax, 1.43, 0];
    add(side > 0 ? 'leftArm' : 'rightArm', boxGeo(0.16, 0.66, 0.16, ax, 1.1, 0), M(shirt), armPivot, true);
    const lx = 0.12 * side;
    const legPivot = [lx, 0.8, 0];
    add(side > 0 ? 'leftLeg' : 'rightLeg', boxGeo(0.2, 0.8, 0.2, lx, 0.4, 0), M(pants), legPivot, true);
  }
  return finishVariant('h' + id, sp.name, sp.child ? 0.72 : 1, parts);
}
// 部品の geometry を pivot 基準にそろえ、描画の準備をする
function finishVariant(id, name, scale, parts) {
  // 歩く部品は、関節（pivot）が原点になるように移す
  for (const p of parts) {
    if (p.anim) {
      p.geo = p.geo.clone();
      p.geo.translate(-p.pivot[0], -p.pivot[1], -p.pivot[2]);
    }
  }
  const v = { id, name, scale, parts, ims: [], count: 0 };
  variants.set(id, v);
  return v;
}

// 自分の人：OBJ/FBX（名前が body などの部品なら、その部品が関節を中心に動く）
function normKey(name) {
  const n = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
  const map = { body: 'body', torso: 'body', head: 'head', leftarm: 'leftArm', rightarm: 'rightArm', leftleg: 'leftLeg', rightleg: 'rightLeg' };
  return map[n] || null;
}
async function buildCustomHuman(rec) {
  const root = VM.parseModelRoot(rec.fmt, rec.model);
  const texMap = await VM.loadTextures(rec.texs || []);
  const mtl = rec.mtl ? VM.parseMtl(rec.mtl) : null;
  const raw = [];
  root.traverse(m => {
    if (!m.isMesh || !m.geometry) return;
    const g = m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    const key = normKey(m.name) || normKey(m.parent && m.parent.name) || 'body';
    const matName = m.material && !Array.isArray(m.material) ? m.material.name : '';
    const info = mtl && matName ? mtl.get(matName) : null;
    let tex = info && info.map ? VM.texFor(texMap, info.map) : null;
    if (!tex && (!info || !info.map)) tex = VM.firstTex(texMap);
    const kd = info && info.kd ? new THREE.Color(info.kd[0], info.kd[1], info.kd[2]) : null;
    const mat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, color: kd || (tex ? 0xffffff : 0xbbbbbb) });
    if (tex) { mat.map = tex; mat.alphaTest = 0.3; }
    raw.push({ key, geo: g, mat });
  });
  if (!raw.length) throw new Error('メッシュが見つかりません');
  // 身長を 1.8 マスにそろえ、足元を 0 に
  const box = new THREE.Box3();
  for (const p of raw) { p.geo.computeBoundingBox(); box.union(p.geo.boundingBox); }
  const size = box.getSize(new THREE.Vector3());
  const k = HUMAN_H / Math.max(0.01, size.y);
  const c = box.getCenter(new THREE.Vector3());
  const M = new THREE.Matrix4().makeTranslation(-c.x, -box.min.y, -c.z).premultiply(new THREE.Matrix4().makeScale(k, k, k));
  for (const p of raw) p.geo.applyMatrix4(M);
  // 関節：歩く部品は、上の面の中央を関節にする（Blockbench の pivot に近い位置）
  const keyBox = new Map();
  for (const p of raw) {
    if (!keyBox.has(p.key)) keyBox.set(p.key, new THREE.Box3());
    p.geo.computeBoundingBox();
    keyBox.get(p.key).union(p.geo.boundingBox);
  }
  const parts = raw.map(p => {
    const b = keyBox.get(p.key);
    const anim = !!ANIM_KEYS[p.key];
    const pivot = anim ? [(b.min.x + b.max.x) / 2, b.max.y, (b.min.z + b.max.z) / 2] : [0, 0, 0];
    return { key: p.key, geo: p.geo, mat: p.mat, pivot, anim };      // 関節への移動は finishVariant でまとめて行う
  });
  removeVariant('hc' + rec.id);
  return finishVariant('hc' + rec.id, rec.name, rec.scale || 1, parts);
}
function removeVariant(id) {
  const v = variants.get(id);
  if (v) for (const im of v.ims) scene.remove(im);
  variants.delete(id);
}

// ============================================================
// 2. 地面・範囲・人の動き
// ============================================================
const isSolid = b => b !== AIR && b !== WATER;
// 指定の高さから下へ探して、最初に当たる地面の高さ（範囲をどれだけ高く選んでも、地面を歩く）
function groundAt(x, z, fromY) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const top = Math.floor(fromY) + 3;
  for (let y = top; y > top - 48; y--) {
    if (isSolid(getBlock(ix, y, iz))) return y + 1;
  }
  return null;
}
function inRects(g, x, z) {
  for (const r of g.rects) if (x >= r.x1 && x <= r.x2 && z >= r.z1 && z <= r.z2) return true;
  return false;
}
function groupOf(x, z) {
  for (const g of C.groups) if (inRects(g, x, z)) return g;
  return null;
}
function areaOf(g) {
  let a = 0;
  for (const r of g.rects) a += (r.x2 - r.x1) * (r.z2 - r.z1);
  return a;
}
function targetCount(g) { return Math.round(g.density * areaOf(g) / 100); }
function rnd(a, b) { return a + Math.random() * (b - a); }

// 範囲の中の、流れに合った出現の位置（流れの上流の縁）
function spawnPoint(g, a) {
  const r = g.rects[Math.floor(Math.random() * g.rects.length)];
  const sx = Math.sin(a), sz = Math.cos(a);
  let x, z;
  if (Math.abs(sx) > Math.abs(sz)) {
    x = sx > 0 ? r.x1 + 0.4 : r.x2 - 0.4;
    z = rnd(r.z1 + 0.4, r.z2 - 0.4);
  } else {
    z = sz > 0 ? r.z1 + 0.4 : r.z2 - 0.4;
    x = rnd(r.x1 + 0.4, r.x2 - 0.4);
  }
  return { x, z, y: r.y };
}
function pickVariantId(g) {
  const ids = g.variety.filter(id => variants.has(id));
  const pool = ids.length ? ids : DEF_IDS();
  return pool[Math.floor(Math.random() * pool.length)];
}
const DEF_IDS = () => DEF_HUMANS.map((_, i) => 'h' + i);
function spawnHuman(g) {
  const flow = g.flow;
  let a;
  if (flow.mode === 'rand') a = Math.random() * Math.PI * 2;
  else if (flow.mode === 'two') a = (flow.deg * Math.PI / 180) + (Math.random() < 0.5 ? Math.PI : 0);
  else a = flow.deg * Math.PI / 180 + rnd(-0.12, 0.12);
  const p = (flow.mode === 'rand') ? (() => { const r = g.rects[Math.floor(Math.random() * g.rects.length)]; return { x: rnd(r.x1 + 0.4, r.x2 - 0.4), z: rnd(r.z1 + 0.4, r.z2 - 0.4), y: r.y }; })() : spawnPoint(g, a);
  if (!inRects(g, p.x, p.z)) return;
  const gy = groundAt(p.x, p.z, p.y);
  if (gy == null) return;
  C.humans.push({
    id: C.hseq++, v: pickVariantId(g), g: g.id, x: p.x, y: gy, z: p.z,
    a, sp: g.speed * rnd(0.85, 1.15), ph: Math.random() * 6.28, tt: rnd(3, 6), tg: rnd(0.2, 0.8), dead: false
  });
}

function simulateCrowd(dt) {
  // 人数を目標に合わせる（上限あり）
  let budget = 6;
  for (const g of C.groups) {
    if (!g.rects.length) continue;
    const have = C.humans.reduce((n, h) => n + (h.g === g.id ? 1 : 0), 0);
    const want = targetCount(g);
    for (let i = 0; i < want - have && budget > 0 && C.humans.length < MAX_H; i++, budget--) spawnHuman(g);
  }
  for (const h of C.humans) {
    const g = C.groups.find(q => q.id === h.g);
    if (!g) { h.dead = true; continue; }
    if (g.flow.mode === 'rand') {
      h.tt -= dt;
      if (h.tt <= 0) { h.a = Math.random() * Math.PI * 2; h.tt = rnd(3, 6); }
    }
    h.x += Math.sin(h.a) * h.sp * dt;
    h.z += Math.cos(h.a) * h.sp * dt;
    h.ph += h.sp * dt * 2.4;
    // 範囲の外に出たら消える
    if (!inRects(g, h.x, h.z)) { h.dead = true; continue; }
    h.tg -= dt;
    if (h.tg <= 0) {
      h.tg = rnd(0.4, 0.9);
      const gy = groundAt(h.x, h.z, h.y + 1);
      if (gy != null) h.y = gy;                                // 段差・坂に合わせる
    }
  }
  C.humans = C.humans.filter(h => !h.dead);
}

// ============================================================
// 3. 範囲の生成（重なったら、ひとつにまとめる）
// ============================================================
function rectOverlap(a, b) {
  return a.x1 < b.x2 && b.x1 < a.x2 && a.z1 < b.z2 && b.z1 < a.z2;
}
function commitPreview() {
  if (!C.preview) { toast2('先に、始点と終点を選んでください'); return; }
  const r = C.preview;
  // 重なる範囲をまとめる（設定は、今作った範囲のものになる）
  const hit = C.groups.filter(g => g.rects.some(q => rectOverlap(q, r)));
  const g = {
    id: C.gseq++, rects: [r], density: 5, speed: 1.2,
    variety: DEF_IDS(), flow: { mode: 'rand', deg: 0 },
    sound: { on: false, custom: null, name: '' }, col: PALETTE[(C.gseq - 1) % PALETTE.length]
  };
  for (const old of hit) {
    g.rects.push(...old.rects);
    for (const h of C.humans) if (h.g === old.id) h.g = g.id;
    removeGroupMesh(old.id);
    stopSound(old.id);
  }
  C.groups = C.groups.filter(q => !hit.includes(q));
  C.groups.push(g);
  C.preview = null;
  C.dirty = true;
  saveSoon();
  toast2(hit.length ? '重なった範囲をひとつにまとめました' : '人混みの範囲を作りました（長押しで設定）');
}
function tapGround() {
  const g = VR.surfacePoint();
  if (!g) { toast2('地面に向けてタップしてください'); return; }
  const gr = VR.getGrid() || 1;
  const p = { x: Math.round(g.x / gr) * gr, y: g.y, z: Math.round(g.z / gr) * gr };
  if (!C.pick) {
    C.pick = p;
    toast2('始点を指定しました。終点をタップ');
    return;
  }
  const r = { x1: Math.min(C.pick.x, p.x), x2: Math.max(C.pick.x, p.x), z1: Math.min(C.pick.z, p.z), z2: Math.max(C.pick.z, p.z), y: Math.max(C.pick.y, p.y) };
  C.pick = null;
  if (r.x2 - r.x1 < 1 || r.z2 - r.z1 < 1) { toast2('もう少し広く選んでください'); return; }
  C.preview = r;
  toast2('範囲を選びました。「範囲生成」で人混みにします');
}
function removeGroupMesh(id) {
  const m = groupMeshes.get(id);
  if (!m) return;
  for (const o of [...m.plane, ...m.line]) scene.remove(o);
  groupMeshes.delete(id);
}
function deleteGroup(id) {
  removeGroupMesh(id);
  stopSound(id);
  C.groups = C.groups.filter(g => g.id !== id);
  C.humans = C.humans.filter(h => h.g !== id);
  saveSoon();
}

// 範囲の表示（持っている間だけ・色つき）
const planeGeo = new THREE.PlaneGeometry(1, 1);
planeGeo.rotateX(-Math.PI / 2);
function rebuildAreaMeshes() {
  for (const id of [...groupMeshes.keys()]) if (!C.groups.some(g => g.id === id)) removeGroupMesh(id);
  for (const g of C.groups) {
    if (!C.dirty && groupMeshes.has(g.id)) continue;
    removeGroupMesh(g.id);
    const m = { plane: [], line: [] };
    const col = new THREE.Color(g.col);
    for (const r of g.rects) {
      const pl = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }));
      pl.scale.set(r.x2 - r.x1, 1, r.z2 - r.z1);
      pl.position.set((r.x1 + r.x2) / 2, r.y + 0.08, (r.z1 + r.z2) / 2);
      pl.renderOrder = 5;
      scene.add(pl);
      m.plane.push(pl);
      const pts = [new THREE.Vector3(r.x1, r.y + 0.1, r.z1), new THREE.Vector3(r.x2, r.y + 0.1, r.z1), new THREE.Vector3(r.x2, r.y + 0.1, r.z2), new THREE.Vector3(r.x1, r.y + 0.1, r.z2)];
      const ln = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: col }));
      scene.add(ln);
      m.line.push(ln);
    }
    groupMeshes.set(g.id, m);
  }
  C.dirty = false;
}
function setAreaVisible(on) {
  for (const m of groupMeshes.values()) for (const o of [...m.plane, ...m.line]) o.visible = on;
}
let previewMesh = null;
function updatePreviewMesh() {
  const show = holding() && started && !menuOpen && !paused;
  const r = C.preview || (C.pick && groundP() ? { x1: Math.min(C.pick.x, groundP().x), x2: Math.max(C.pick.x, groundP().x), z1: Math.min(C.pick.z, groundP().z), z2: Math.max(C.pick.z, groundP().z), y: C.pick.y } : null);
  if (!show || !r) { if (previewMesh) previewMesh.visible = false; return; }
  if (!previewMesh) {
    previewMesh = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide }));
    previewMesh.renderOrder = 6;
    scene.add(previewMesh);
  }
  previewMesh.visible = true;
  previewMesh.scale.set(Math.max(0.2, r.x2 - r.x1), 1, Math.max(0.2, r.z2 - r.z1));
  previewMesh.position.set((r.x1 + r.x2) / 2, r.y + 0.1, (r.z1 + r.z2) / 2);
}

// ============================================================
// 4. 人の描画（部品ごとにまとめて描く。範囲の外は描かない）
// ============================================================
const inLoaded = (x, y, z) => inRange(Math.floor(x / CS), Math.floor(z / CS), curPcx, curPcz, RD) &&
  Math.abs(Math.floor(y / CS) - curPcy) <= RD;
const mRoot = new THREE.Matrix4(), mPart = new THREE.Matrix4(), mTmp = new THREE.Matrix4();
const qRoot = new THREE.Quaternion(), qX = new THREE.Quaternion(), vPos = new THREE.Vector3(), vScale = new THREE.Vector3(), vPiv = new THREE.Vector3(), vOne = new THREE.Vector3(1, 1, 1);
const vAxisY = new THREE.Vector3(0, 1, 0), vAxisX = new THREE.Vector3(1, 0, 0);
function ensureIMs(v) {
  if (v.ims.length === v.parts.length) return;
  for (const im of v.ims) scene.remove(im);
  v.ims = v.parts.map(p => {
    const im = new THREE.InstancedMesh(p.geo, p.mat, MAX_H);
    im.frustumCulled = false;
    im.count = 0;
    im.userData.sharedGeo = true;
    scene.add(im);
    return im;
  });
}
function renderCrowd() {
  const groups = new Map();
  for (const h of C.humans) {
    if (!inLoaded(h.x, h.y, h.z)) continue;
    let l = groups.get(h.v);
    if (!l) { l = []; groups.set(h.v, l); }
    l.push(h);
  }
  for (const v of variants.values()) {
    const list = groups.get(v.id);
    if (!list || !list.length) {
      if (v.count) { for (const im of v.ims) im.count = 0; v.count = 0; }
      continue;
    }
    ensureIMs(v);
    let n = 0;
    for (const h of list) {
      if (n >= MAX_H) break;
      const scale = v.scale;
      vPos.set(h.x, h.y, h.z);
      qRoot.setFromAxisAngle(vAxisY, h.a);
      vScale.set(scale, scale, scale);
      mRoot.compose(vPos, qRoot, vScale);
      const walk = Math.min(1, h.sp / 1.2);
      const amp = 0.55 * walk;
      const s = Math.sin(h.ph) * amp;
      for (let pi = 0; pi < v.parts.length; pi++) {
        const p = v.parts[pi];
        let ang = 0;
        if (p.anim) {
          if (p.key === 'leftLeg') ang = s;
          else if (p.key === 'rightLeg') ang = -s;
          else if (p.key === 'leftArm') ang = -s * 0.8;
          else if (p.key === 'rightArm') ang = s * 0.8;
        }
        vPiv.set(p.pivot[0], p.pivot[1], p.pivot[2]);
        qX.setFromAxisAngle(vAxisX, ang);
        mPart.compose(vPiv, qX, vOne);
        mTmp.multiplyMatrices(mRoot, mPart);
        v.ims[pi].setMatrixAt(n, mTmp);
      }
      n++;
    }
    for (const im of v.ims) { im.count = n; im.instanceMatrix.needsUpdate = true; }
    v.count = n;
  }
}

// ============================================================
// 5. 人混みの音（オン・オフ。音声のアップロードも可）
// ============================================================
let actx = null, noiseBuf = null;
const sounds = new Map();   // groupId -> { gain, src | audio }
function ensureCtx() {
  if (!actx) {
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; }
  }
  if (actx && actx.state === 'suspended') actx.resume();
  return actx;
}
function makeNoise(ctx) {
  if (noiseBuf) return noiseBuf;
  const len = ctx.sampleRate * 4;
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {                     // ざわめき（低めのノイズ＋ゆっくりした揺れ）
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    const wob = 0.6 + 0.4 * Math.sin(i / ctx.sampleRate * 2.1 + Math.sin(i / ctx.sampleRate * 0.4) * 2);
    d[i] = last * 3.5 * wob;
  }
  return noiseBuf;
}
function startSound(g) {
  const ctx = ensureCtx();
  if (!ctx || sounds.has(g.id)) return;
  if (g.sound.custom) {
    const a = new Audio(g.sound.custom);
    a.loop = true; a.volume = 0;
    a.play().catch(() => {});
    sounds.set(g.id, { audio: a });
  } else {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);
    const src = ctx.createBufferSource();
    src.buffer = makeNoise(ctx); src.loop = true;
    src.connect(gain); src.start();
    sounds.set(g.id, { gain, src });
  }
}
function stopSound(id) {
  const s = sounds.get(id);
  if (!s) return;
  try { if (s.audio) s.audio.pause(); if (s.src) s.src.stop(); } catch (e) {}
  sounds.delete(id);
}
function distToRects(g, x, z) {
  let best = Infinity;
  for (const r of g.rects) {
    const dx = Math.max(r.x1 - x, 0, x - r.x2), dz = Math.max(r.z1 - z, 0, z - r.z2);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}
let soundAcc = 0;
function updateSounds(dt) {
  soundAcc += dt;
  if (soundAcc < 0.25) return;
  soundAcc = 0;
  const px = player.pos.x, pz = player.pos.z;
  for (const g of C.groups) {
    if (!g.sound.on) { if (sounds.has(g.id)) stopSound(g.id); continue; }
    const d = distToRects(g, px, pz);
    const vol = clampN(1 - d / 14, 0, 1) * 0.55;
    if (vol > 0 && !sounds.has(g.id)) startSound(g);
    const s = sounds.get(g.id);
    if (!s) continue;
    if (s.gain) s.gain.gain.value = vol;
    if (s.audio) { s.audio.volume = vol; if (vol > 0 && s.audio.paused) s.audio.play().catch(() => {}); }
  }
}
function clampN(v, a, b) { return Math.max(a, Math.min(b, v)); }

// ============================================================
// 6. 保存・読み込み
// ============================================================
let saveTimer = 0;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
function saveNow() {
  const data = {
    seq: C.seq, hseq: C.hseq, gseq: C.gseq,
    groups: C.groups.map(g => ({ id: g.id, rects: g.rects, density: g.density, speed: g.speed, variety: g.variety, flow: g.flow, sound: g.sound, col: g.col })),
    customs: C.customs
  };
  try { localStorage.setItem(KEY, JSON.stringify(data)); }
  catch (e) { toast2('保存できませんでした（容量の上限。モデルや音が大きすぎるかもしれません）'); }
}
function loadNow() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { d = null; }
  if (!d) return;
  C.seq = d.seq || 1; C.hseq = d.hseq || 1; C.gseq = d.gseq || 1;
  C.groups = Array.isArray(d.groups) ? d.groups : [];
  C.customs = Array.isArray(d.customs) ? d.customs : [];
  C.dirty = true;
}
let lastSaveKey = '';
setInterval(() => {
  const k = C.gseq + ':' + C.groups.length + ':' + C.customs.length;
  if (k !== lastSaveKey) { lastSaveKey = k; saveNow(); }
}, 4000);

// ============================================================
// 7. 画面（HUD・パネル）
// ============================================================
let toastTimer = 0;
function toast2(msg) {
  const el = document.getElementById('extToast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}
function holding() { return HOTBAR[selIdx] === T_CROWD; }
function groundP() {
  const g = VR.surfacePoint();
  if (!g) return null;
  const gr = VR.getGrid() || 1;
  return { x: Math.round(g.x / gr) * gr, y: g.y, z: Math.round(g.z / gr) * gr };
}

const css = document.createElement('style');
css.textContent = `
  #crHud{position:fixed;left:50%;top:92px;transform:translateX(-50%);z-index:6;display:none;flex-direction:column;align-items:center;gap:4px;pointer-events:none}
  #crHud.show{display:flex}
  #crHud .row{display:flex;gap:4px;pointer-events:auto;flex-wrap:wrap;justify-content:center}
  #crHud .tbtn{background:rgba(0,0,0,.55);color:#fff;border:1px solid rgba(255,255,255,.35);border-radius:8px;padding:6px 9px;font-size:12px;cursor:pointer}
  #crHud .info{color:#fff;font-size:11px;text-shadow:0 1px 2px #000;background:rgba(0,0,0,.35);border-radius:6px;padding:2px 6px}
  #crPanel{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:40}
  #crPanel.show{display:flex}
  #crPanel .box{background:#1b2530;color:#fff;border-radius:10px;padding:14px;width:min(94vw,520px);max-height:92vh;overflow:auto;box-sizing:border-box;font-size:13px}
  #crPanel h2{margin:0 0 8px;font-size:16px}
  #crPanel h3{margin:12px 0 4px;font-size:14px;color:#ffd54a}
  #crPanel .btn{background:#2e4a66;color:#fff;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:12px;margin:2px}
  #crPanel .btn.danger{background:#7a2e2e}
  #crPanel input,#crPanel select{background:#14202e;color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:5px;padding:3px 4px;font-size:12px}
  #crPanel .note{color:#9fb3c8;font-size:11px;line-height:1.5}
  #crPanel .rowv{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px 0}
`;
document.head.appendChild(css);

const hud = document.createElement('div');
hud.id = 'crHud';
hud.innerHTML = `
  <div class="row">
    <button class="tbtn" data-a="gen">範囲生成</button>
    <button class="tbtn" data-a="cancel">選択をやめる</button>
    <button class="tbtn" data-a="types">人の種類</button>
  </div>
  <div class="info" id="crInfo"></div>`;
document.body.appendChild(hud);
hud.addEventListener('click', e => {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  const a = b.dataset.a;
  if (a === 'gen') commitPreview();
  else if (a === 'cancel') { C.pick = null; C.preview = null; toast2('選択をやめました'); }
  else if (a === 'types') openTypesPanel();
});
function updateHud() {
  const show = holding() && started && !menuOpen && !paused;
  hud.classList.toggle('show', show);
  if (!show) return;
  const t = `範囲 ${C.groups.length}・人 ${C.humans.length}（上限 ${MAX_H}）｜` + (C.preview ? '「範囲生成」で人混みにできます' : (C.pick ? '終点をタップ' : '始点をタップ（長押しで範囲の設定）'));
  const info = document.getElementById('crInfo');
  if (info.textContent !== t) info.textContent = t;
}

const panel = document.createElement('div');
panel.id = 'crPanel';
document.body.appendChild(panel);
let openKind = null;
function openP(kind, html) {
  openKind = kind;
  panel.innerHTML = `<div class="box">${html}</div>`;
  panel.classList.add('show');
  menuOpen = true;
  if (typeof releaseActions === 'function') releaseActions();
  for (const k in keys) keys[k] = false;
  if (document.pointerLockElement) document.exitPointerLock();
}
function closeP() {
  if (!openKind) return;
  panel.classList.remove('show');
  openKind = null;
  menuOpen = false;
  if (!isTouch && started) { const p = canvas.requestPointerLock && canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); }
}
panel.addEventListener('click', e => { if (e.target === panel) closeP(); });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 範囲の設定（長押し）
function openGroupPanel(id) {
  const g = C.groups.find(q => q.id === id);
  if (!g) return;
  const humans = C.humans.filter(h => h.g === id).length;
  const allIds = [...variants.values()].map(v => v.id);
  const vrows = allIds.map(vid => {
    const v = variants.get(vid);
    return `<label class="rowv"><input type="checkbox" data-vt="${vid}" ${g.variety.includes(vid) ? 'checked' : ''}> ${esc(v.name)}</label>`;
  }).join('');
  const dirOpts = DIRS.map(([n, d]) => `<option value="${d}" ${Math.round(g.flow.deg) === d ? 'selected' : ''}>${n}</option>`).join('');
  openP('group', `
    <h2>人混みの範囲の設定</h2>
    <p class="note">範囲の数：${g.rects.length}　今いる人：${humans}人（目標 ${targetCount(g)}人）</p>
    <div class="rowv">密度（10×10マスあたりの人数）<input type="number" min="0" max="60" step="0.5" value="${g.density}" id="crDen" style="width:70px"></div>
    <div class="rowv">流れの速さ（マス/秒）<input type="number" min="0.2" max="6" step="0.1" value="${g.speed}" id="crSpd" style="width:70px"></div>
    <h3>流れの向き</h3>
    <div class="rowv"><select id="crFlow">
      <option value="rand" ${g.flow.mode === 'rand' ? 'selected' : ''}>完全ランダム</option>
      <option value="one" ${g.flow.mode === 'one' ? 'selected' : ''}>一方向</option>
      <option value="two" ${g.flow.mode === 'two' ? 'selected' : ''}>前後（両方向）</option></select>
      向き <select id="crDir">${dirOpts}</select>
      角度 <input type="number" min="0" max="359" step="1" value="${Math.round(g.flow.deg)}" id="crDeg" style="width:64px">°</div>
    <p class="note">「完全ランダム」は向きを、ときどき変えながら歩きます。</p>
    <h3>人のバリエーション（この範囲に出る種類）</h3>
    ${vrows}
    <h3>人混みの音</h3>
    <div class="rowv"><label><input type="checkbox" id="crSnd" ${g.sound.on ? 'checked' : ''}> 音を流す（近づくと聞こえます）</label></div>
    <div class="rowv">音声ファイル（任意・mp3/wav/ogg）<input type="file" id="crSndFile" accept="audio/*"></div>
    <div class="rowv"><span class="note">現在：${g.sound.custom ? esc(g.sound.name || '自分の音') : '標準のざわめき'}</span>
      <button class="btn" data-a="snd-default">標準の音に戻す</button></div>
    <div class="rowv" style="margin-top:10px">
      <button class="btn danger" data-a="del">この範囲を消す</button>
      <button class="btn" data-a="close">閉じる</button></div>`);
  panel.onchange = async e => {
    const t = e.target;
    if (t.id === 'crDen') g.density = clampN(Number(t.value) || 0, 0, 60);
    if (t.id === 'crSpd') g.speed = clampN(Number(t.value) || 1.2, 0.2, 6);
    if (t.id === 'crFlow') { g.flow.mode = t.value; }
    if (t.id === 'crDir') { g.flow.deg = Number(t.value); document.getElementById('crDeg').value = t.value; }
    if (t.id === 'crDeg') { g.flow.deg = ((Number(t.value) || 0) % 360 + 360) % 360; }
    if (t.id === 'crSnd') { g.sound.on = t.checked; }
    if (t.dataset.vt) {
      const vid = t.dataset.vt;
      g.variety = t.checked ? [...new Set([...g.variety, vid])] : g.variety.filter(x => x !== vid);
    }
    if (t.id === 'crSndFile' && t.files[0]) {
      g.sound.custom = await readFile(t.files[0], 'dataurl');
      g.sound.name = t.files[0].name;
      g.sound.on = true;
      stopSound(g.id);
      document.getElementById('crSnd').checked = true;
    }
    saveSoon();
  };
  panel.onclick = e => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    if (b.dataset.a === 'close') closeP();
    if (b.dataset.a === 'del') { deleteGroup(g.id); closeP(); toast2('範囲を消しました'); }
    if (b.dataset.a === 'snd-default') { g.sound.custom = null; g.sound.name = ''; stopSound(g.id); saveSoon(); openGroupPanel(g.id); }
  };
}

// 人の種類（標準10種類＋自分の人の追加）
function openTypesPanel() {
  const rows = [...variants.values()].map(v => {
    const custom = v.id.startsWith('hc');
    const rid = custom ? Number(v.id.slice(2)) : null;
    return `<div class="rowv">${esc(v.name)} ${custom ? '（自分の人）' : '（標準）'}
      ${custom ? `スケール<input type="number" min="0.2" max="4" step="0.1" value="${v.scale}" data-sc="${rid}" style="width:60px">倍 <button class="btn danger" data-del="${rid}">削除</button>` : ''}</div>`;
  }).join('');
  openP('types', `
    <h2>人の種類</h2>
    <p class="note">標準の人は10種類です。範囲ごとに、使う種類を選べます（範囲の設定から）。</p>
    ${rows}
    <h3>自分の人を追加</h3>
    <div class="rowv">名前 <input id="crNm" value="マイ人" style="width:120px"></div>
    <div class="rowv">モデル（.obj / .fbx）<input id="crMd" type="file" accept=".obj,.fbx"></div>
    <div class="rowv">マテリアル（.mtl・任意）<input id="crMtl" type="file" accept=".mtl"></div>
    <div class="rowv">テクスチャ（png/jpg・複数可）<input id="crTx" type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"></div>
    <div class="rowv">大きさ（倍率）<input id="crSc" type="number" min="0.2" max="4" step="0.1" value="1" style="width:60px"></div>
    <p class="note">部品の名前が body / head / leftArm / rightArm / leftLeg / rightLeg なら、その部品が関節を中心に歩きます。名前がなければ、全体が固定の人になります。</p>
    <div class="rowv"><button class="btn" data-a="add">追加する</button><span id="crMsg" class="note"></span></div>
    <div class="rowv"><button class="btn" data-a="close">閉じる</button></div>`);
  panel.onchange = e => {
    const t = e.target;
    if (t.dataset.sc) {
      const rec = C.customs.find(c => c.id === Number(t.dataset.sc));
      if (rec) {
        rec.scale = clampN(Number(t.value) || 1, 0.2, 4);
        saveSoon();
        buildCustomHuman(rec).then(() => toast2('大きさを変えました')).catch(() => toast2('読み込めませんでした'));
      }
    }
  };
  panel.onclick = async e => {
    const b = e.target.closest('[data-a],[data-del]');
    if (!b) return;
    if (b.dataset.del) {
      const id = Number(b.dataset.del);
      C.customs = C.customs.filter(c => c.id !== id);
      removeVariant('hc' + id);
      for (const g of C.groups) g.variety = g.variety.filter(x => x !== 'hc' + id);
      C.humans = C.humans.filter(h => h.v !== 'hc' + id);
      saveSoon(); openTypesPanel(); return;
    }
    if (b.dataset.a === 'close') closeP();
    if (b.dataset.a === 'add') {
      const msg = document.getElementById('crMsg');
      const md = document.getElementById('crMd').files[0];
      if (!md) { msg.textContent = 'モデルのファイルを選んでください'; return; }
      const fmt = md.name.split('.').pop().toLowerCase();
      if (fmt !== 'obj' && fmt !== 'fbx') { msg.textContent = '.obj か .fbx を選んでください'; return; }
      msg.textContent = '読み込み中…';
      const model = await readFile(md, fmt === 'fbx' ? 'dataurl' : 'text');
      const mf = document.getElementById('crMtl').files[0];
      const mtl = mf ? await readFile(mf, 'text') : null;
      const texs = [];
      for (const f of [...document.getElementById('crTx').files]) texs.push({ name: f.name, data: await readFile(f, 'dataurl') });
      const id = Date.now() % 1000000000;
      const rec = {
        id, name: document.getElementById('crNm').value || 'マイ人', fmt,
        scale: clampN(Number(document.getElementById('crSc').value) || 1, 0.2, 4),
        model: fmt === 'fbx' ? model.split(',')[1] : model, mtl, texs
      };
      try {
        await buildCustomHuman(rec);
        C.customs.push(rec);
        saveSoon();
        openTypesPanel();
        toast2('「' + rec.name + '」を追加しました');
      } catch (err) { console.error(err); msg.textContent = '読み込めませんでした（ファイルの形式を確認してください）'; }
    }
  };
}
function readFile(f, mode) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    if (mode === 'text') r.readAsText(f); else r.readAsDataURL(f);
  });
}

// ============================================================
// 8. 組み込み（道具を持ったときだけ、タップ・長押しを人混みの操作にする）
// ============================================================
const origPlace = window.doPlace, origBreak = window.doBreak, origStart = window.startAct;
window.doPlace = function () {
  if (holding()) {
    if (!started || menuOpen || paused) return;
    ensureCtx();
    tapGround();
    return;
  }
  return origPlace.apply(this, arguments);
};
function holdAt() {
  const p = groundP();
  if (!p) return;
  const g = groupOf(p.x, p.z);
  if (g) openGroupPanel(g.id);
  else openTypesPanel();
}
window.doBreak = function () {
  if (holding()) { if (started && !menuOpen && !paused) holdAt(); return; }
  return origBreak.apply(this, arguments);
};
window.startAct = function (kind) {
  if (holding()) {
    if (kind === 'place') { if (started && !menuOpen && !paused) { ensureCtx(); tapGround(); } return; }
    if (kind === 'break') { if (started && !menuOpen && !paused) holdAt(); return; }
  }
  return origStart.apply(this, arguments);
};

// ============================================================
// 9. 毎フレーム
// ============================================================
let lastT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000));
  lastT = now;
  if (started && !paused) simulateCrowd(dt);
  const show = holding() && started && !menuOpen && !paused;
  if (C.dirty) rebuildAreaMeshes();
  setAreaVisible(show);
  renderCrowd();
  updatePreviewMesh();
  updateHud();
  updateSounds(dt);
}

function init() {
  // 標準の人を作る
  DEF_HUMANS.forEach((sp, i) => buildDefaultHuman(sp, i));
  loadNow();
  for (const rec of C.customs) {
    buildCustomHuman(rec).catch(e => { console.error(e); toast2('「' + rec.name + '」の人を読み込めませんでした'); });
  }
  requestAnimationFrame(frame);
}
window.VoxelCrowd = { stats: () => ({ groups: C.groups.length, humans: C.humans.length, max: MAX_H }) };
init();

})();
