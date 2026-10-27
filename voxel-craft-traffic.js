/* voxel-craft-traffic.js  自動車の自動運転交通（新しいファイル。本体HTMLの、ui.js の後に読み込む）
 *  ・「自動車交通制御」アイテム（道具）で、道路と同じ操作（始点・中間点・終点）でルートを引く（道路とは別のネットワーク）
 *  ・ルートの繋ぎ目をタップ → そこから別方向へ伸ばせる（分岐・合流）。長押し → 速度・分岐の確率の設定
 *  ・車：標準の車3種類 ＋ 自分のモデル（OBJ / FBX＋テクスチャ）。判定幅で滑らかに停車・自動再発進
 *  ・車もマーカーもまとめて描く（インスタンス描画）。読み込んだチャンクの外では描画だけ止める
 */
(function () {
'use strict';

const VX = window.VoxelExt;
const VR = window.VoxelRoad;
if (!VX || !VR) { console.error('voxel-craft-traffic.js: ext / road が必要です'); return; }
const T_TRAFFIC = VX.T_TRAFFIC;

const KEY = 'voxelcraft_traffic_v1';
const MAX_CARS = 400;
const LANE = 0.22;                       // 車線（進行方向の右寄り）
const NODE_SNAP = 0.8;                   // 繋ぎ目とみなす距離
const DEF_KMH = 30;
const kmhToBps = kmh => kmh / 12;        // 速さ（ブロック/秒）。30km/h ≈ 2.5
const PALETTE = ['#ff5a5a', '#ffb347', '#ffe066', '#7ddc6a', '#5ad2ff', '#8f7bff', '#ff7ad9', '#ffffff'];

// ============================================================
// 1. データ（ルートの繋ぎ目・区間・車の設定）
// ============================================================
const S = {
  nodes: new Map(),        // id -> { id, p: Vector3, kmh, out:[edgeId], in:[edgeId], w:{edgeId: weight} }
  edges: new Map(),        // id -> { id, a, b, pts:[[x,y,z]], cum:[], len, curve, color }
  seq: 1, colorN: 0,
  interval: 4,             // 車の出現間隔（秒）
  weights: {},             // 車の種類ID -> 出現の重み（既定は 1）
  customs: [],             // 自分の車（保存用：{id,name,len,front,back,alpha,fmt,model,tex}）
  cars: [],
  spawnAcc: 0,
  paused: false
};
const TP = { pend: null, mid: null, nextMid: false, color: null, undo: [] };
let markersDirty = true, lastMarkerKey = '';

function nodeNear(p) {
  let best = null, bd = NODE_SNAP;
  for (const n of S.nodes.values()) {
    const d = Math.hypot(n.p.x - p.x, n.p.z - p.z);
    if (d < bd && Math.abs(n.p.y - p.y) < 1.2) { bd = d; best = n; }
  }
  return best;
}
function addNode(p) {
  const n = { id: S.seq++, p: p.clone(), kmh: DEF_KMH, out: [], in: [], w: {} };
  S.nodes.set(n.id, n);
  return n;
}
// 曲がりの急さで、少しだけ減速する（直線は 1）
function curveOf(pts, cum, len) {
  let maxAng = 0, prev = null;
  const step = 1;
  for (let s = 0; s < len; s += step) {
    const a = pointAt({ pts, cum, len }, s), b = pointAt({ pts, cum, len }, Math.min(len, s + step));
    const dx = b.x - a.x, dz = b.z - a.z;
    const L = Math.hypot(dx, dz);
    if (L < 1e-6) continue;
    const dir = [dx / L, dz / L];
    if (prev) {
      const dot = clampN(prev[0] * dir[0] + prev[1] * dir[1], -1, 1);
      maxAng = Math.max(maxAng, Math.acos(dot));
    }
    prev = dir;
  }
  const deg = maxAng * 180 / Math.PI;
  if (deg <= 40) return 1;
  return clampN(1 - (deg - 40) / 120 * 0.3, 0.7, 1);
}
function clampN(v, a, b) { return Math.max(a, Math.min(b, v)); }

function addEdge(a, b, pts, color) {
  const arr = pts.map(q => [q.x, q.y, q.z]);
  arr[0] = [a.p.x, a.p.y, a.p.z];
  arr[arr.length - 1] = [b.p.x, b.p.y, b.p.z];
  const cum = [0];
  for (let i = 1; i < arr.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(arr[i][0] - arr[i - 1][0], arr[i][1] - arr[i - 1][1], arr[i][2] - arr[i - 1][2]);
  }
  const len = cum[cum.length - 1];
  if (len < 0.5) return null;
  const e = { id: S.seq++, a: a.id, b: b.id, pts: arr, cum, len, color };
  e.curve = curveOf(arr, cum, len);
  S.edges.set(e.id, e);
  a.out.push(e.id);
  b.in.push(e.id);
  a.w[e.id] = 1;
  markersDirty = true;
  return e;
}
function removeEdge(id) {
  const e = S.edges.get(id);
  if (!e) return;
  const a = S.nodes.get(e.a), b = S.nodes.get(e.b);
  if (a) { a.out = a.out.filter(x => x !== id); delete a.w[id]; }
  if (b) b.in = b.in.filter(x => x !== id);
  S.edges.delete(id);
  for (const c of S.cars) if (c.e === id) c.dead = true;
  for (const n of [a, b]) if (n && !n.out.length && !n.in.length) S.nodes.delete(n.id);
  markersDirty = true;
}
function removeNode(id) {
  const n = S.nodes.get(id);
  if (!n) return;
  for (const eid of [...n.out, ...n.in]) removeEdge(eid);
  S.nodes.delete(id);
  markersDirty = true;
}

// 区間の上の位置（s はその区間の始点からの距離）
function pointAt(e, s) {
  const cum = e.cum, pts = e.pts;
  const ss = clampN(s, 0, e.len);
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= ss) lo = m; else hi = m; }
  const seg = (cum[hi] - cum[lo]) || 1e-6;
  const t = clampN((ss - cum[lo]) / seg, 0, 1);
  const a = pts[lo], b = pts[hi];
  const dx = b[0] - a[0], dz = b[2] - a[2];
  const L = Math.hypot(dx, dz) || 1;
  return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, z: a[2] + (b[2] - a[2]) * t, hx: dx / L, hz: dz / L };
}
function nextColor() {
  const c = PALETTE[S.colorN % PALETTE.length];
  S.colorN++;
  return c;
}

// ============================================================
// 2. 保存・読み込み
// ============================================================
let saveTimer = 0;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300); }
function saveNow() {
  const data = {
    seq: S.seq, colorN: S.colorN, interval: S.interval, weights: S.weights,
    nodes: [...S.nodes.values()].map(n => ({ id: n.id, p: [n.p.x, n.p.y, n.p.z], kmh: n.kmh, w: n.w })),
    edges: [...S.edges.values()].map(e => ({ id: e.id, a: e.a, b: e.b, pts: e.pts, color: e.color })),
    customs: S.customs
  };
  try { localStorage.setItem(KEY, JSON.stringify(data)); }
  catch (e) { toast2('保存できませんでした（容量の上限。自分の車のモデルが大きすぎるかもしれません）'); }
}
function loadNow() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { d = null; }
  if (!d) return;
  S.seq = d.seq || 1; S.colorN = d.colorN || 0; S.interval = d.interval || 4;
  S.weights = d.weights || {};
  S.customs = Array.isArray(d.customs) ? d.customs : [];
  for (const n of d.nodes || []) {
    S.nodes.set(n.id, { id: n.id, p: new THREE.Vector3(n.p[0], n.p[1], n.p[2]), kmh: n.kmh || DEF_KMH, out: [], in: [], w: n.w || {} });
  }
  for (const e of d.edges || []) {
    const a = S.nodes.get(e.a), b = S.nodes.get(e.b);
    if (!a || !b) continue;
    const cum = [0];
    for (let i = 1; i < e.pts.length; i++) {
      cum[i] = cum[i - 1] + Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1], e.pts[i][2] - e.pts[i - 1][2]);
    }
    const len = cum[cum.length - 1];
    const ed = { id: e.id, a: e.a, b: e.b, pts: e.pts, cum, len, color: e.color || '#ffffff' };
    ed.curve = curveOf(ed.pts, cum, len);
    S.edges.set(ed.id, ed);
    a.out.push(ed.id);
    b.in.push(ed.id);
    if (a.w[ed.id] == null) a.w[ed.id] = 1;
  }
  markersDirty = true;
}

// ============================================================
// 3. 車の種類（標準の車 ＋ 自分の車）
// ============================================================
const variants = new Map();   // id -> { id, name, len, front, back, parts:[{geo,mat}], ims:[] , std }
function mergeBoxes(list) {
  const pos = [], nor = [], col = [], idx = [];
  for (const b of list) {
    const g = new THREE.BoxGeometry(b.w, b.h, b.d);
    const p = g.attributes.position.array, n = g.attributes.normal.array, ix = g.index.array;
    const base = pos.length / 3;
    for (let i = 0; i < p.length; i += 3) {
      pos.push(p[i] + b.x, p[i + 1] + b.y, p[i + 2] + b.z);
      nor.push(n[i], n[i + 1], n[i + 2]);
      col.push(b.c[0], b.c[1], b.c[2]);
    }
    for (let i = 0; i < ix.length; i++) idx.push(ix[i] + base);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}
const RGB = hex => { const v = parseInt(hex.slice(1), 16); return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255]; };
// 標準の車（前は +Z 向き。車輪は地面につく）
function defaultSpecs() {
  const wheel = (x, z) => ({ w: 0.12, h: 0.26, d: 0.26, x, y: 0.13, z, c: RGB('#111111') });
  return [
    { id: 'd_sedan', name: 'セダン', len: 1.6, front: 0.8, back: 0.4, boxes: [
      { w: 0.8, h: 0.4, d: 1.6, x: 0, y: 0.32, z: 0, c: RGB('#3b7bd9') },
      { w: 0.7, h: 0.34, d: 0.8, x: 0, y: 0.69, z: -0.1, c: RGB('#1d2a3a') },
      wheel(0.42, 0.5), wheel(-0.42, 0.5), wheel(0.42, -0.5), wheel(-0.42, -0.5)] },
    { id: 'd_truck', name: 'トラック', len: 2.2, front: 1.2, back: 0.6, boxes: [
      { w: 0.9, h: 0.9, d: 1.4, x: 0, y: 0.6, z: -0.4, c: RGB('#f2f2f2') },
      { w: 0.9, h: 0.7, d: 0.6, x: 0, y: 0.45, z: 0.7, c: RGB('#d64545') },
      wheel(0.45, 0.7), wheel(-0.45, 0.7), wheel(0.45, -0.2), wheel(-0.45, -0.2), wheel(0.45, -0.7), wheel(-0.45, -0.7)] },
    { id: 'd_bus', name: 'バス', len: 2.6, front: 1.5, back: 0.6, boxes: [
      { w: 0.9, h: 1.2, d: 2.4, x: 0, y: 0.7, z: 0, c: RGB('#f2c230') },
      { w: 0.92, h: 0.4, d: 2.0, x: 0, y: 1.05, z: 0, c: RGB('#2c3e50') },
      wheel(0.45, 0.8), wheel(-0.45, 0.8), wheel(0.45, -0.8), wheel(-0.45, -0.8)] }
  ];
}

function removeVariant(id) {
  const v = variants.get(id);
  if (v) for (const im of v.ims) scene.remove(im);
  variants.delete(id);
}
function makeVariant(id, name, len, front, back, parts, std) {
  const v = { id, name, len, front, back, parts, ims: [], std: !!std };
  variants.set(id, v);
  return v;
}
function buildDefaults() {
  for (const sp of defaultSpecs()) {
    makeVariant(sp.id, sp.name, sp.len, sp.front, sp.back,
      [{ geo: mergeBoxes(sp.boxes), mat: new THREE.MeshLambertMaterial({ vertexColors: true }) }], true);
  }
}
// 自分の車（OBJ / FBX ＋ テクスチャ）。長い方向を前後（Z）にそろえ、指定の長さに合わせる
function loadTexture(dataUrl) {
  return new Promise((res, rej) => {
    new THREE.TextureLoader().load(dataUrl, t => {
      t.magFilter = THREE.NearestFilter; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
      res(t);
    }, undefined, rej);
  });
}
async function buildCustom(rec) {
  let root = null;
  if (rec.fmt === 'fbx') {
    if (!THREE.FBXLoader) throw new Error('FBXLoader なし');
    const bin = atob(rec.model), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    root = new THREE.FBXLoader().parse(u.buffer, '');
  } else {
    if (!THREE.OBJLoader) throw new Error('OBJLoader なし');
    root = new THREE.OBJLoader().parse(rec.model);
  }
  root.updateMatrixWorld(true);
  let tex = null;
  if (rec.tex) { try { tex = await loadTexture(rec.tex); } catch (e) { tex = null; } }
  const parts = [];
  root.traverse(m => {
    if (!m.isMesh || !m.geometry) return;
    const g = m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    let mat;
    if (tex) {
      mat = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide, color: 0xffffff });
      if (rec.alpha === 'glow') { mat.emissive = new THREE.Color(0xffffff); mat.emissiveMap = tex; mat.emissiveIntensity = 1; }
      else mat.alphaTest = 0.3;                              // 透過（半透明の部分をそのまま透かす）
    } else {
      mat = new THREE.MeshLambertMaterial({ color: 0xbbbbbb, side: THREE.DoubleSide });
    }
    parts.push({ geo: g, mat });
  });
  if (!parts.length) throw new Error('メッシュが見つかりません');
  // 向きと大きさをそろえる
  const box = new THREE.Box3();
  for (const p of parts) { p.geo.computeBoundingBox(); box.union(p.geo.boundingBox); }
  let size = box.getSize(new THREE.Vector3());
  if (size.x > size.z) {
    const R = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    for (const p of parts) p.geo.applyMatrix4(R);
    box.makeEmpty();
    for (const p of parts) { p.geo.computeBoundingBox(); box.union(p.geo.boundingBox); }
    size = box.getSize(new THREE.Vector3());
  }
  const k = rec.len / Math.max(0.01, size.z);
  const c = box.getCenter(new THREE.Vector3());
  const M = new THREE.Matrix4().makeTranslation(-c.x, -box.min.y, -c.z).premultiply(new THREE.Matrix4().makeScale(k, k, k));
  for (const p of parts) p.geo.applyMatrix4(M);
  return makeVariant('c_' + rec.id, rec.name, rec.len, rec.front, rec.back, parts, false);
}
async function buildAllCustoms() {
  for (const rec of S.customs) {
    if (variants.has('c_' + rec.id)) continue;
    try { await buildCustom(rec); }
    catch (e) { console.error(e); toast2('「' + rec.name + '」の車を読み込めませんでした'); }
  }
}

// ============================================================
// 4. 操作（道具の使い方）
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
function holding() { return HOTBAR[selIdx] === T_TRAFFIC; }
function snapP(g) {
  const gr = VR.getGrid() || 1;
  const off = VR.getOffset() || 0;
  const y = g.y + off;
  return new THREE.Vector3(
    gr > 0 ? Math.round(g.x / gr) * gr : g.x,
    gr > 0 ? Math.round(y / gr) * gr : y,
    gr > 0 ? Math.round(g.z / gr) * gr : g.z);
}
function groundP() {
  const g = VR.surfacePoint();
  return g ? snapP(g) : null;
}

// 地面をタップ：道路と同じ（始点 → 中間点（任意）→ 終点）。繋ぎ目の上なら、そこに繋がる
function tapGround() {
  const p = groundP();
  if (!p) { toast2('地面に向けてタップしてください'); return; }
  const hit = nodeNear(p);
  if (!TP.pend) {
    if (hit && hit.out.length >= 2) { openNodePanel(hit.id); return; }   // 分岐の中心点 → 確率の設定
    if (hit) {
      TP.pend = { node: hit.id, p: hit.p.clone() };
      toast2('繋ぎ目から伸ばします。次の点をタップ');
    } else {
      TP.pend = { node: null, p: p.clone() };
      toast2('始点を指定しました。（中間点は「中間点」ボタン）終点をタップ');
    }
    if (!TP.color) TP.color = hit && hit.out.length ? S.edges.get(hit.out[0]).color : nextColor();
    return;
  }
  if (TP.nextMid) {
    if (TP.pend.p.distanceTo(p) < 0.5) { toast2('中間点は始点から離して置いてください'); return; }
    TP.mid = p.clone();
    TP.nextMid = false;
    toast2('中間点を置きました。終点をタップ');
    return;
  }
  const to = hit ? { node: hit.id, p: hit.p.clone() } : { node: null, p: p.clone() };
  if (TP.pend.p.distanceTo(to.p) < 0.5) { toast2('もう少し離して置いてください'); return; }
  const samples = VR.computePath({ p: TP.pend.p }, { p: to.p }, TP.mid);
  if (!samples.length) { toast2('ルートが短すぎます'); return; }
  const created = [];
  const a = TP.pend.node != null ? S.nodes.get(TP.pend.node) : (() => { const n = addNode(TP.pend.p); created.push(n.id); return n; })();
  const b = to.node != null ? S.nodes.get(to.node) : (() => { const n = addNode(to.p); created.push(n.id); return n; })();
  const e = addEdge(a, b, samples.map(s => s.mid), TP.color);
  if (!e) { for (const id of created) S.nodes.delete(id); toast2('ルートが短すぎます'); return; }
  TP.undo.push({ edge: e.id, nodes: created });
  TP.pend = { node: b.id, p: b.p.clone() };       // 続けて伸ばせる
  TP.mid = null;
  saveSoon();
}
function undoLast() {
  const u = TP.undo.pop();
  if (!u) { toast2('戻せるものがありません'); return; }
  removeEdge(u.edge);
  for (const id of u.nodes) { const n = S.nodes.get(id); if (n && !n.out.length && !n.in.length) S.nodes.delete(id); }
  TP.pend = null; TP.mid = null; TP.nextMid = false; TP.color = null;
  markersDirty = true;
  saveSoon();
  toast2('1つ戻しました');
}

// 長押し：繋ぎ目なら設定パネル、道からなければ近い区間を消す
function holdAt() {
  const p = groundP();
  if (!p) return;
  const hit = nodeNear(p);
  if (hit) { openNodePanel(hit.id); return; }
  let best = null, bd = 1.0;
  for (const e of S.edges.values()) {
    for (let s = 0; s <= e.len; s += 0.5) {
      const q = pointAt(e, s);
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < bd && Math.abs(q.y - p.y) < 1.5) { bd = d; best = e; }
    }
  }
  if (best) {
    removeEdge(best.id);
    saveSoon();
    toast2('ルートの区間を消しました');
  }
}

// ============================================================
// 5. 車の動き
// ============================================================
function edgeSpeed(e) {
  const a = S.nodes.get(e.a);
  return kmhToBps(a ? a.kmh : DEF_KMH) * e.curve;
}
function spawnOne() {
  const starts = [...S.nodes.values()].filter(n => n.in.length === 0 && n.out.length > 0);
  if (!starts.length) return;
  const ready = [...variants.values()];
  if (!ready.length) return;
  if (S.cars.length >= MAX_CARS) return;
  const n = starts[Math.floor(Math.random() * starts.length)];
  // 出現の重み（種類ごとの %）
  let tot = 0;
  const ws = ready.map(v => { const w = S.weights[v.id] == null ? 1 : S.weights[v.id]; tot += w; return w; });
  let r = Math.random() * tot, vi = 0;
  for (; vi < ws.length - 1; vi++) { if (r < ws[vi]) break; r -= ws[vi]; }
  const v = ready[vi];
  const eid = pickOut(n);
  const e = S.edges.get(eid);
  if (!e) return;
  // 出た直後に、同じ区間に車がいれば出さない
  for (const c of S.cars) if (c.e === eid && c.s < v.len + 0.8) return;
  S.cars.push({ vid: v.id, e: eid, s: 0, sp: 0, blocked: false, dead: false });
}
function pickOut(node) {
  let tot = 0;
  const ws = node.out.map(id => { const w = node.w[id] == null ? 1 : node.w[id]; tot += w; return w; });
  if (tot <= 0) return node.out[0];
  let r = Math.random() * tot;
  for (let i = 0; i < node.out.length; i++) { if (r < ws[i]) return node.out[i]; r -= ws[i]; }
  return node.out[node.out.length - 1];
}
function simulate(dt) {
  // 区間ごとの車（先頭が小さい s の順＝後ろから）
  const byEdge = new Map();
  for (const c of S.cars) {
    if (c.dead) continue;
    let l = byEdge.get(c.e);
    if (!l) { l = []; byEdge.set(c.e, l); }
    l.push(c);
  }
  for (const l of byEdge.values()) l.sort((a, b) => b.s - a.s);     // 先頭（s が大きい）から
  const V = id => variants.get(id);
  for (const c of S.cars) {
    if (c.dead) continue;
    const e = S.edges.get(c.e);
    if (!e) { c.dead = true; continue; }
    const v = V(c.vid);
    const myLen = v ? v.len : 1.6, myFront = v ? v.front : 0.8;
    const list = byEdge.get(c.e) || [];
    const idx = list.indexOf(c);
    // 前の車（同じ区間、または次の区間の先頭）
    let gap = Infinity, lead = null;
    if (idx > 0) { lead = list[idx - 1]; gap = lead.s - c.s; }
    else {
      const nd = S.nodes.get(e.b);
      if (nd) for (const oid of nd.out) {
        const l2 = byEdge.get(oid);
        if (!l2 || !l2.length) continue;
        const first = l2[l2.length - 1];
        const d = (e.len - c.s) + first.s;
        if (d < gap) { gap = d; lead = first; }
      }
    }
    let blocked = false;
    if (lead) {
      const lv = V(lead.vid);
      const lLen = lv ? lv.len : 1.6, lBack = lv ? lv.back : 0.4;
      const free = gap - (myLen / 2 + lLen / 2);
      const need = myFront + lBack;
      blocked = c.blocked ? free < need + 0.3 : free < need;     // 少しだけ余裕を持って再発進
    }
    // 合流：他の入口から、先に着く車がいれば待つ
    if (!blocked && e.len - c.s < 5) {
      const nd = S.nodes.get(e.b);
      const dc = e.len - c.s;
      if (nd) for (const iid of nd.in) {
        if (iid === c.e) continue;
        const ie = S.edges.get(iid);
        if (!ie) continue;
        for (const o of S.cars) {
          if (o.dead || o.e !== iid) continue;
          const dn = ie.len - o.s;
          const ov = V(o.vid);
          const oBack = ov ? ov.back : 0.4;
          if (dn < dc && dn < myFront + oBack + 1.2) { blocked = true; break; }
        }
        if (blocked) break;
      }
    }
    c.blocked = blocked;
    const target = blocked ? 0 : edgeSpeed(e);
    const dv = target - c.sp;
    c.sp += clampN(dv, -3.2 * dt, 2.0 * dt);                     // 滑らかに加速・減速
    if (c.sp < 0) c.sp = 0;
    c.s += c.sp * dt;
    let cur = e;
    while (c.s >= cur.len && !c.dead) {
      const nd = S.nodes.get(cur.b);
      if (!nd || !nd.out.length) { c.dead = true; break; }        // ルートの終点に着いたら消す
      const next = S.edges.get(pickOut(nd));
      if (!next) { c.dead = true; break; }
      c.s -= cur.len;                                             // 次の区間へ、はみ出した分を持ち越す
      c.e = next.id;
      cur = next;
    }
  }
  S.cars = S.cars.filter(c => !c.dead);
}

// ============================================================
// 6. 描画（インスタンス描画。読み込み範囲の外は描かない）
// ============================================================
const inLoaded = (x, y, z) => inRange(Math.floor(x / CS), Math.floor(z / CS), curPcx, curPcz, RD) &&
  Math.abs(Math.floor(y / CS) - curPcy) <= RD;

const carMatBase = new THREE.Matrix4(), carTmp = new THREE.Matrix4(), carQ = new THREE.Quaternion(), carP = new THREE.Vector3(), carS = new THREE.Vector3(1, 1, 1);
function ensureInstances(v) {
  if (v.ims.length) return;
  v.ims = v.parts.map(pt => {
    const im = new THREE.InstancedMesh(pt.geo, pt.mat, MAX_CARS);
    im.frustumCulled = false;
    im.castShadow = false;
    im.receiveShadow = false;
    im.count = 0;
    im.userData.sharedGeo = true;
    scene.add(im);
    return im;
  });
}
function renderCars() {
  const groups = new Map();
  for (const c of S.cars) {
    if (c.dead) continue;
    let g = groups.get(c.vid);
    if (!g) { g = []; groups.set(c.vid, g); }
    g.push(c);
  }
  for (const v of variants.values()) {
    if (!v.parts.length) continue;
    ensureInstances(v);
    const list = groups.get(v.id) || [];
    let n = 0;
    for (const c of list) {
      const e = S.edges.get(c.e);
      if (!e) continue;
      const q = pointAt(e, c.s);
      // 車線（進行方向の右寄り）
      const x = q.x + (-q.hz) * LANE, z = q.z + q.hx * LANE;
      if (!inLoaded(x, q.y, z)) continue;                         // 範囲の外は描かない（計算は続ける）
      if (n >= MAX_CARS) break;
      carQ.setFromAxisAngle(carP.set(0, 1, 0), Math.atan2(q.hx, q.hz));
      carP.set(x, q.y + 0.04, z);
      carTmp.compose(carP, carQ, carS);
      for (const im of v.ims) im.setMatrixAt(n, carTmp);
      n++;
    }
    for (const im of v.ims) { im.count = n; im.instanceMatrix.needsUpdate = true; }
  }
}

// ルートマーカー（太い色の線）と繋ぎ目の球
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const sphGeo = new THREE.SphereGeometry(0.3, 10, 8);
const markMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
const jointMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
const pendMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false });
const mk = new THREE.Matrix4(), mq = new THREE.Quaternion(), mp = new THREE.Vector3(), ms = new THREE.Vector3(), mcol = new THREE.Color();
// 描画物を作り直さず、数が増えたときだけ大きいものに替える
function fillIM(h, geo, mat, list) {
  if (!list.length) { if (h.im) h.im.count = 0; return; }
  if (!h.im || h.cap < list.length) {
    if (h.im) scene.remove(h.im);
    h.cap = Math.max(64, list.length * 2);
    h.im = new THREE.InstancedMesh(geo, mat, h.cap);
    h.im.frustumCulled = false;
    h.im.userData.sharedGeo = true;
    scene.add(h.im);
  }
  const im = h.im;
  list.forEach((it, i) => { im.setMatrixAt(i, it.m); im.setColorAt(i, it.c); });
  im.count = list.length;
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
}
const hMark = { im: null, cap: 0 }, hJoint = { im: null, cap: 0 }, hPend = { im: null, cap: 0 };
function rebuildMarkers() {
  const boxes = [], joints = [];
  for (const e of S.edges.values()) {
    const c = new THREE.Color(e.color);
    for (let s = 0; s < e.len; s += 0.5) {
      const s2 = Math.min(e.len, s + 0.5);
      const a = pointAt(e, s), b = pointAt(e, s2);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 + 0.12, mz = (a.z + b.z) / 2;
      if (!inLoaded(mx, my, mz)) continue;
      const seg = s2 - s + 0.03;
      mq.setFromAxisAngle(mp.set(0, 1, 0), Math.atan2(b.x - a.x, b.z - a.z));
      mk.compose(mp.set(mx, my, mz), mq, ms.set(0.42, 0.22, seg));
      boxes.push({ m: mk.clone(), c });
    }
  }
  for (const n of S.nodes.values()) {
    if (!inLoaded(n.p.x, n.p.y, n.p.z)) continue;
    const branch = n.out.length >= 2;
    const r = branch ? 0.5 : 0.3;
    const col = branch ? new THREE.Color('#ffd54a') : (n.out.length ? new THREE.Color(S.edges.get(n.out[0]).color) : new THREE.Color(S.edges.get(n.in[0]) ? S.edges.get(n.in[0]).color : '#ffffff'));
    mk.compose(mp.set(n.p.x, n.p.y + 0.12, n.p.z), mq.set(0, 0, 0, 1), ms.set(r, r, r));
    joints.push({ m: mk.clone(), c: col });
  }
  fillIM(hMark, boxGeo, markMat, boxes);
  fillIM(hJoint, sphGeo, jointMat, joints);
}
function drawPending(g) {
  if (!TP.pend || !g) { hPend.im && (hPend.im.count = 0); return; }
  const samples = VR.computePath({ p: TP.pend.p }, { p: g }, TP.mid);
  const list = [];
  const col = new THREE.Color(TP.color || '#ffffff');
  for (let i = 0; i < samples.length; i += 2) {
    const q = samples[i].mid;
    const t = samples[i].tan;
    mq.setFromAxisAngle(mp.set(0, 1, 0), Math.atan2(t.x, t.z));
    mk.compose(mp.set(q.x, q.y + 0.12, q.z), mq, ms.set(0.42, 0.22, 1.0));
    list.push({ m: mk.clone(), c: col });
  }
  fillIM(hPend, boxGeo, pendMat, list);
}

let markVisible = false, markChunkKey = '';
function updateMarkers() {
  const show = holding() && started && !menuOpen && !paused;
  if (!show) {
    if (markVisible) {
      for (const h of [hMark, hJoint, hPend]) if (h.im) h.im.visible = false;
      markVisible = false;
    }
    return;
  }
  const key = curPcx + ',' + curPcy + ',' + curPcz;
  if (!markVisible || markersDirty || key !== markChunkKey) {
    rebuildMarkers();
    markersDirty = false;
    markChunkKey = key;
  }
  markVisible = true;
  for (const h of [hMark, hJoint, hPend]) if (h.im) h.im.visible = true;
  const g = groundP();
  drawPending(TP.pend && g ? g : null);
}

// ============================================================
// 7. 画面の表示（HUD・パネル）
// ============================================================
const css = document.createElement('style');
css.textContent = `
  #trHud{position:fixed;left:50%;top:92px;transform:translateX(-50%);z-index:6;display:none;flex-direction:column;align-items:center;gap:4px;pointer-events:none}
  #trHud.show{display:flex}
  #trHud .row{display:flex;gap:4px;pointer-events:auto;flex-wrap:wrap;justify-content:center}
  #trHud .tbtn{background:rgba(0,0,0,.55);color:#fff;border:1px solid rgba(255,255,255,.35);border-radius:8px;padding:6px 9px;font-size:12px;cursor:pointer}
  #trHud .info{color:#fff;font-size:11px;text-shadow:0 1px 2px #000;background:rgba(0,0,0,.35);border-radius:6px;padding:2px 6px}
  #trPanel{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:40}
  #trPanel.show{display:flex}
  #trPanel .box{background:#1b2530;color:#fff;border-radius:10px;padding:14px;width:min(94vw,520px);max-height:92vh;overflow:auto;box-sizing:border-box;font-size:13px}
  #trPanel h2{margin:0 0 8px;font-size:16px}
  #trPanel h3{margin:12px 0 4px;font-size:14px;color:#ffd54a}
  #trPanel .btn{background:#2e4a66;color:#fff;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:12px;margin:2px}
  #trPanel .btn.danger{background:#7a2e2e}
  #trPanel input,#trPanel select{background:#14202e;color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:5px;padding:3px 4px;font-size:12px}
  #trPanel .note{color:#9fb3c8;font-size:11px;line-height:1.5}
  #trPanel .rowv{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px 0}
`;
document.head.appendChild(css);

const hud = document.createElement('div');
hud.id = 'trHud';
hud.innerHTML = `
  <div class="row">
    <button class="tbtn" data-a="mid">中間点</button>
    <button class="tbtn" data-a="stop">ここで止める</button>
    <button class="tbtn" data-a="undo">1つ戻す</button>
    <button class="tbtn" data-a="set">車・出現の設定</button>
  </div>
  <div class="info" id="trInfo"></div>`;
document.body.appendChild(hud);
hud.addEventListener('click', e => {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  const a = b.dataset.a;
  if (a === 'mid') { if (TP.pend) { TP.nextMid = true; toast2('中間点をタップしてください'); } else toast2('先に始点をタップしてください'); }
  else if (a === 'stop') { TP.pend = null; TP.mid = null; TP.nextMid = false; TP.color = null; toast2('ルートの途中を止めました'); }
  else if (a === 'undo') undoLast();
  else if (a === 'set') openSetPanel();
});
function updateHud() {
  const show = holding() && started && !menuOpen && !paused;
  hud.classList.toggle('show', show);
  if (!show) return;
  const info = document.getElementById('trInfo');
  const txt = TP.pend ? (TP.nextMid ? '中間点を待っています' : '終点を待っています（続けて伸ばせます）') : '始点をタップしてルートを引く（繋ぎ目をタップで分岐）';
  const t = `${txt}　｜　繋ぎ目 ${S.nodes.size}・区間 ${S.edges.size}・車 ${S.cars.length}`;
  if (info.textContent !== t) info.textContent = t;
}

const panel = document.createElement('div');
panel.id = 'trPanel';
document.body.appendChild(panel);
let openPanelKind = null;
function openP(kind, html) {
  openPanelKind = kind;
  panel.innerHTML = `<div class="box">${html}</div>`;
  panel.classList.add('show');
  menuOpen = true;
  if (typeof releaseActions === 'function') releaseActions();
  for (const k in keys) keys[k] = false;
  if (document.pointerLockElement) document.exitPointerLock();
}
function closeP() {
  if (!openPanelKind) return;
  panel.classList.remove('show');
  openPanelKind = null;
  menuOpen = false;
  if (!isTouch && started) { const p = canvas.requestPointerLock && canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); }
}
panel.addEventListener('click', e => { if (e.target === panel) closeP(); });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 繋ぎ目の設定（速度・分岐の確率・そこから伸ばす・消す）
function openNodePanel(id) {
  const n = S.nodes.get(id);
  if (!n) return;
  const sum = n.out.reduce((t, eid) => t + (n.w[eid] == null ? 1 : n.w[eid]), 0) || 1;
  const outs = n.out.map((eid, i) => {
    const e = S.edges.get(eid);
    const pct = Math.round((n.w[eid] == null ? 1 : n.w[eid]) / sum * 100);
    return `<div class="rowv">→ 区間${i + 1}（${Math.round(e.len)}マス）
      <span style="color:${e.color}">■</span>
      重み <input type="number" min="0" step="1" value="${n.w[eid] == null ? 1 : n.w[eid]}" data-w="${eid}" style="width:64px">
      <span>約 ${pct}%</span></div>`;
  }).join('');
  openP('node', `
    <h2>繋ぎ目の設定</h2>
    <div class="rowv">ここから先の速さ（km/h）<input type="number" min="5" max="120" step="1" value="${n.kmh}" id="trKmh" style="width:80px"></div>
    <p class="note">カーブが急なところでは、自動で少しだけ減速します。</p>
    ${n.out.length >= 2 ? `<h3>分岐の確率（重みの比で決まります）</h3>${outs}` : (n.out.length ? `<h3>この先</h3>${outs}` : '<p class="note">この繋ぎ目から先には、まだルートがありません。</p>')}
    <div class="rowv" style="margin-top:10px">
      <button class="btn" data-a="extend">ここから別方向へ伸ばす</button>
      <button class="btn danger" data-a="del">この繋ぎ目を消す</button>
      <button class="btn" data-a="close">閉じる</button>
    </div>`);
  panel.onclick = e => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    if (b.dataset.a === 'close') closeP();
    if (b.dataset.a === 'extend') { TP.pend = { node: n.id, p: n.p.clone() }; TP.mid = null; TP.nextMid = false; closeP(); toast2('繋ぎ目から伸ばします。次の点をタップ'); }
    if (b.dataset.a === 'del') { removeNode(n.id); saveSoon(); closeP(); toast2('繋ぎ目を消しました'); }
  };
  panel.onchange = e => {
    if (e.target.id === 'trKmh') { n.kmh = clampN(Number(e.target.value) || DEF_KMH, 5, 120); saveSoon(); }
    if (e.target.dataset.w) { n.w[e.target.dataset.w] = Math.max(0, Number(e.target.value) || 0); saveSoon(); openNodePanel(n.id); }
  };
}

// 車・出現の設定
function openSetPanel() {
  const all = [...variants.values()];
  const rows = all.map(v => {
    const custom = v.id.startsWith('c_');
    const rec = custom ? S.customs.find(c => 'c_' + c.id === v.id) : null;
    return `<div class="rowv">
      <b>${esc(v.name)}</b>${custom ? '（自分の車）' : '（標準）'}
      出現の重み <input type="number" min="0" step="1" value="${S.weights[v.id] == null ? 1 : S.weights[v.id]}" data-wt="${v.id}" style="width:60px">
      ${custom ? `判定 前<input type="number" min="0" step="0.1" value="${v.front}" data-df="${rec.id}" style="width:56px"> 後<input type="number" min="0" step="0.1" value="${v.back}" data-db="${rec.id}" style="width:56px">
      <button class="btn danger" data-del="${rec.id}">削除</button>` : `判定 前${v.front} 後${v.back}`}
    </div>`;
  }).join('');
  const wsum = all.reduce((t, v) => t + (S.weights[v.id] == null ? 1 : S.weights[v.id]), 0) || 1;
  const pcts = all.map(v => `${esc(v.name)} ${Math.round((S.weights[v.id] == null ? 1 : S.weights[v.id]) / wsum * 100)}%`).join('　');
  openP('set', `
    <h2>車・出現の設定</h2>
    <div class="rowv">出現の間隔（秒）<input type="number" min="0.5" step="0.5" value="${S.interval}" id="trInt" style="width:70px"></div>
    <p class="note">出現する割合：${pcts || '（車の種類がまだありません）'}</p>
    <h3>車の種類</h3>
    ${rows}
    <h3>自分の車を追加</h3>
    <div class="rowv">名前 <input id="trNm" value="マイカー" style="width:120px"></div>
    <div class="rowv">長さ（マス）<input id="trLn" type="number" step="0.1" value="2" style="width:70px">
      判定 前 <input id="trFr" type="number" step="0.1" value="1" style="width:60px"> 後 <input id="trBk" type="number" step="0.1" value="0.5" style="width:60px"></div>
    <div class="rowv">テクスチャの半透明部分 <select id="trAl"><option value="cut">そのまま透過する</option><option value="glow">発光させる</option></select></div>
    <div class="rowv">モデル（.obj / .fbx）<input id="trMd" type="file" accept=".obj,.fbx"></div>
    <div class="rowv">テクスチャ（png / jpg・任意）<input id="trTx" type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"></div>
    <div class="rowv"><button class="btn" data-a="add">追加する</button><span id="trMsg" class="note"></span></div>
    <h3>その他</h3>
    <div class="rowv"><button class="btn danger" data-a="clearcars">走っている車を全部消す</button>
      <button class="btn danger" data-a="clearroute">ルートを全部消す</button>
      <button class="btn" data-a="close">閉じる</button></div>`);
  panel.onchange = e => {
    const t = e.target;
    if (t.id === 'trInt') { S.interval = clampN(Number(t.value) || 4, 0.5, 600); saveSoon(); }
    if (t.dataset.wt) { S.weights[t.dataset.wt] = Math.max(0, Number(t.value) || 0); saveSoon(); }
    if (t.dataset.df || t.dataset.db) {
      const id = Number(t.dataset.df || t.dataset.db);
      const rec = S.customs.find(c => c.id === id);
      if (rec) {
        if (t.dataset.df) rec.front = Math.max(0, Number(t.value) || 0); else rec.back = Math.max(0, Number(t.value) || 0);
        const v = variants.get('c_' + id); if (v) { v.front = rec.front; v.back = rec.back; }
        saveSoon();
      }
    }
  };
  panel.onclick = async e => {
    const b = e.target.closest('[data-a],[data-del]');
    if (!b) return;
    if (b.dataset.del) {
      const id = Number(b.dataset.del);
      S.customs = S.customs.filter(c => c.id !== id);
      removeVariant('c_' + id);
      saveSoon(); openSetPanel(); return;
    }
    const a = b.dataset.a;
    if (a === 'close') closeP();
    if (a === 'clearcars') { S.cars = []; toast2('車を消しました'); }
    if (a === 'clearroute') { S.edges.clear(); S.nodes.clear(); S.cars = []; TP.pend = null; TP.undo = []; markersDirty = true; saveSoon(); toast2('ルートを消しました'); closeP(); }
    if (a === 'add') {
      const msg = document.getElementById('trMsg');
      const md = document.getElementById('trMd').files[0];
      if (!md) { msg.textContent = 'モデルのファイルを選んでください'; return; }
      const fmt = md.name.split('.').pop().toLowerCase();
      if (fmt !== 'obj' && fmt !== 'fbx') { msg.textContent = '.obj か .fbx を選んでください'; return; }
      msg.textContent = '読み込み中…';
      const model = await readFile(md, fmt === 'fbx' ? 'dataurl' : 'text');
      const tf = document.getElementById('trTx').files[0];
      const tex = tf ? await readFile(tf, 'dataurl') : null;
      const id = Date.now() % 1000000000;
      const rec = {
        id, name: document.getElementById('trNm').value || 'マイカー',
        len: clampN(Number(document.getElementById('trLn').value) || 2, 0.8, 6),
        front: Math.max(0, Number(document.getElementById('trFr').value) || 0),
        back: Math.max(0, Number(document.getElementById('trBk').value) || 0),
        alpha: document.getElementById('trAl').value, fmt,
        model: fmt === 'fbx' ? model.split(',')[1] : model, tex
      };
      try {
        await buildCustom(rec);
        S.customs.push(rec);
        saveSoon();
        openSetPanel();
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
    if (mode === 'text') r.readAsText(f);
    else r.readAsDataURL(f);
  });
}

// ============================================================
// 8. 組み込み（道具を持ったときだけ、タップ・長押しを交通の操作にする）
// ============================================================
const origPlace = window.doPlace, origBreak = window.doBreak, origStart = window.startAct;
window.doPlace = function () {
  if (holding()) {
    if (!started || menuOpen || paused) return;
    tapGround();
    return;
  }
  return origPlace.apply(this, arguments);
};
window.doBreak = function () {
  if (holding()) {
    if (!started || menuOpen || paused) return;
    holdAt();
    return;
  }
  return origBreak.apply(this, arguments);
};
window.startAct = function (kind) {
  if (holding()) {
    // 交通の道具では、押し続けても1回だけ動かす（長押しは doBreak で処理）
    if (kind === 'place') { if (started && !menuOpen && !paused) tapGround(); return; }
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
  if (started && !paused) {
    simulate(dt);
    S.spawnAcc += dt;
    if (S.spawnAcc >= S.interval) { S.spawnAcc = 0; spawnOne(); }
  }
  renderCars();
  updateMarkers();
  updateHud();
}

function init() {
  buildDefaults();
  loadNow();
  buildAllCustoms();
  requestAnimationFrame(frame);
  setInterval(saveSoonIfDirty, 4000);
}
let lastSaveCount = -1;
function saveSoonIfDirty() {
  const k = S.seq + ':' + S.nodes.size + ':' + S.edges.size;
  if (k !== lastSaveCount) { lastSaveCount = k; saveNow(); }
}
window.VoxelTraffic = { save: saveNow, stats: () => ({ nodes: S.nodes.size, edges: S.edges.size, cars: S.cars.length }) };
init();

})();
