/* voxel-craft-road.js  (v5)
 * 道路・線路の敷設モジュール（本体HTML・ext.js は変更しない）
 *  ・道路モード（K）／線路モード（J）
 *  ・始点 →（任意で中間点）→ 終点。中間点はMキーか画面右側の「中間点」ボタン
 *  ・勾配（坂）も曲線と同じく、なめらかに角度が変わる
 *  ・敷設は32マスごとの区画で管理し、描画距離の外の区画は描画しない（軽量化）
 *  ・モデルは縮めず、区間の長さに合わせて切り分けて貼る
 *  ・敷設ごとに個別削除
 */
(function () {
'use strict';

// ============================================================
// 定数・状態
// ============================================================
const KEY = 'voxelcraft_road_v1';
const W_ROAD = 2, W_RAIL = 1;
const Y_LIFT = 0.03;
const THICK = 0.12;
const RC = 32;                       // 区画の一辺（マス）
const V3 = THREE.Vector3;

const BUILTIN = [
  { id: 'std_road', kind: 'road', name: '標準道路', builtin: true, texData: null, model: null },
  { id: 'std_rail', kind: 'rail', name: '標準線路', builtin: true, texData: null, model: null }
];

const st = {
  variants: [],
  pieces: [],         // { v, kind, w, x, y, z, q, l, ph, g }
  nodes: [],          // { p, d, sl, kind, g }
  sel: { road: 'std_road', rail: 'std_rail' },
  undo: [],
  gid: 0
};
const rs = { mode: null, grid: 1, offset: 0, pending: null, mid: null, nextMid: false };
const vrt = new Map();
let prevPool = new Map();
const chunks = new Map();            // 区画キー -> { cx, cz, pieces, meshes }
let prevVid = null;
let rdOpen = false;
let markerCur = null, markerPend = null, markerDel = null, markerMid = null;
let hudTick = 0;
let lastPreviewKey = '';
const _M = new THREE.Matrix4(), _p = new V3(), _q = new THREE.Quaternion(), _s = new V3();

// ============================================================
// 補助
// ============================================================
function hz(v) {
  const r = new V3(v.x, 0, v.z);
  if (r.lengthSq() < 1e-8) return new V3(0, 0, 1);
  return r.normalize();
}
function hlen(t) { return Math.hypot(t.x, t.z) || 1e-6; }
function r4(v) { return Math.round(v * 1e4) / 1e4; }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function mod(a, m) { return ((a % m) + m) % m; }
let toastEl = null, toastT = 0;
function toast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl.classList.remove('show'), 2600);
}
function allVariants() { return BUILTIN.concat(st.variants); }
function variantById(id) { return allVariants().find(v => v.id === id); }
function uid() { return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// ============================================================
// 保存・読み込み
// ============================================================
function saveAll() {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      variants: st.variants,
      pieces: st.pieces.map(p => ({ v: p.v, kind: p.kind, w: p.w, x: r4(p.x), y: r4(p.y), z: r4(p.z), q: p.q.map(r4), l: r4(p.l), ph: r4(p.ph || 0), g: p.g })),
      nodes: st.nodes.map(n => ({ x: r4(n.p.x), y: r4(n.p.y), z: r4(n.p.z), dx: r4(n.d.x), dz: r4(n.d.z), sl: r4(n.sl || 0), kind: n.kind, g: n.g })),
      sel: st.sel, undo: st.undo, gid: st.gid, grid: rs.grid, offset: rs.offset
    }));
  } catch (e) {
    toast('保存できませんでした（容量を超えています）');
  }
}
function loadAll() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (Array.isArray(s.variants)) st.variants = s.variants;
    if (Array.isArray(s.pieces)) {
      st.pieces = s.pieces.map((p, i) => ({
        v: p.v, kind: p.kind, w: p.w, x: p.x, y: p.y, z: p.z, q: p.q, l: p.l,
        ph: typeof p.ph === 'number' ? p.ph : 0,
        g: typeof p.g === 'number' ? p.g : -(i + 1)
      }));
    }
    if (Array.isArray(s.nodes)) {
      st.nodes = s.nodes.map(n => ({
        p: new V3(n.x, n.y, n.z), d: new V3(n.dx, 0, n.dz), sl: typeof n.sl === 'number' ? n.sl : 0,
        kind: n.kind, g: typeof n.g === 'number' ? n.g : -1
      }));
    }
    if (Array.isArray(s.undo)) st.undo = s.undo;
    if (typeof s.gid === 'number') st.gid = s.gid;
    if (s.sel) {
      if (typeof s.sel.road === 'string') st.sel.road = s.sel.road;
      if (typeof s.sel.rail === 'string') st.sel.rail = s.sel.rail;
    }
    if ([1, 0.5, 0].includes(s.grid)) rs.grid = s.grid;
    if (typeof s.offset === 'number') rs.offset = s.offset;
  } catch (e) {}
}

// ============================================================
// バリエーション（モデル・テクスチャ）
// ============================================================
let boxGeoCache = null;
function boxGeo() {
  if (!boxGeoCache) boxGeoCache = new THREE.BoxGeometry(1, THICK, 1).translate(0, THICK / 2, 0);
  return boxGeoCache;
}
const defTexCache = {};
function defaultTex(kind) {
  if (defTexCache[kind]) return defTexCache[kind];
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (kind === 'road') {
    g.fillStyle = '#4b4e54'; g.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 300; i++) {
      const v = 60 + Math.floor(Math.random() * 40);
      g.fillStyle = `rgba(${v},${v},${v + 4},0.35)`;
      g.fillRect(Math.random() * 64, Math.random() * 64, 1, 1);
    }
    g.fillStyle = '#d9d9d2'; g.fillRect(3, 0, 2, 64); g.fillRect(59, 0, 2, 64);
    g.fillStyle = '#e6d35a';
    for (let y = 0; y < 64; y += 16) g.fillRect(31, y, 2, 9);
  } else {
    g.fillStyle = '#5a4330'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#3b2a1c';
    for (let y = 0; y < 64; y += 12) g.fillRect(0, y, 64, 6);
    g.fillStyle = '#c9ccd1'; g.fillRect(14, 0, 3, 64); g.fillRect(47, 0, 3, 64);
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  defTexCache[kind] = t;
  return t;
}
function loadTex(url) {
  return new Promise(res => {
    new THREE.TextureLoader().load(url, t => {
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      res(t);
    }, undefined, () => res(null));
  });
}
function jsonToGroup(json) {
  const g = new THREE.Group();
  const tw = (json.texture_size && json.texture_size[0]) || 16;
  const th = (json.texture_size && json.texture_size[1]) || 16;
  const FO = ['east', 'west', 'up', 'down', 'south', 'north'];
  for (const el of json.elements || []) {
    if (!el.from || !el.to) continue;
    const [x1, y1, z1] = el.from, [x2, y2, z2] = el.to;
    const geo = new THREE.BoxGeometry((x2 - x1) / 16, (y2 - y1) / 16, (z2 - z1) / 16);
    const uv = geo.attributes.uv;
    FO.forEach((name, f) => {
      const fd = el.faces && el.faces[name];
      const r = (fd && fd.uv) || [0, 0, 16, 16];
      const u0 = r[0] / tw, u1 = r[2] / tw, v0 = 1 - r[3] / th, v1 = 1 - r[1] / th;
      const c = [[u0, v1], [u1, v1], [u0, v0], [u1, v0]];
      for (let i = 0; i < 4; i++) uv.setXY(f * 4 + i, c[i][0], c[i][1]);
    });
    uv.needsUpdate = true;
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial());
    m.position.set((x1 + x2) / 32, (y1 + y2) / 32, (z1 + z2) / 32);
    g.add(m);
  }
  return g;
}
function sanitize(obj) {
  obj.traverse(o => {
    if (!o.isMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    ms.forEach(m => {
      if (!m) return;
      m.transparent = false; m.opacity = 1; m.depthWrite = true; m.depthTest = true;
      m.side = THREE.DoubleSide;
      m.alphaTest = m.map ? 0.5 : 0;
      m.needsUpdate = true;
    });
  });
}
function measureSize(obj) {
  const w = new THREE.Group();
  w.add(obj);
  w.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(w);
  w.remove(obj);
  return b.getSize(new V3());
}

async function buildParts(d) {
  if (!d.model) {
    const tex = d.texData ? await loadTex(d.texData) : defaultTex(d.kind);
    return { parts: [{ geo: boxGeo(), mat: new THREE.MeshLambertMaterial({ map: tex }) }], lenZ: 1, zMin: 0, isModel: false };
  }
  let raw;
  if (d.model.format === 'obj') {
    raw = new THREE.OBJLoader().parse(d.model.data);
  } else if (d.model.format === 'fbx') {
    const buf = await (await fetch(d.model.data)).arrayBuffer();
    raw = new THREE.FBXLoader().parse(buf, '');
  } else {
    raw = jsonToGroup(JSON.parse(d.model.data));
  }
  const tex = d.texData ? await loadTex(d.texData) : null;
  if (tex) raw.traverse(o => { if (o.isMesh) o.material = new THREE.MeshLambertMaterial({ map: tex }); });

  const size0 = measureSize(raw);
  const maxD = Math.max(size0.x, size0.y, size0.z);
  const scale = (typeof d.scale === 'number' && d.scale > 0) ? d.scale : (maxD > 8 ? 1 / 16 : 1);
  raw.scale.setScalar(scale);
  const wrap = new THREE.Group();
  wrap.add(raw);
  wrap.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(wrap);
  const c = b.getCenter(new V3());
  raw.position.set(-c.x, -b.min.y, -c.z);
  wrap.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(wrap);
  const size = bb.getSize(new V3());

  sanitize(wrap);
  const parts = [];
  wrap.traverse(o => {
    if (!o.isMesh) return;
    let g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    if (!g.attributes.normal) g.computeVertexNormals();
    parts.push({ geo: g, mat: o.material });
  });
  if (!parts.length) throw new Error('no mesh');
  return { parts, lenZ: Math.max(size.z, 1e-4), zMin: bb.min.z, isModel: true };
}
async function ensureVariant(d) {
  try {
    const r = await buildParts(d);
    vrt.set(d.id, { parts: r.parts, lenZ: r.lenZ, zMin: r.zMin, isModel: r.isModel, ghost: null, tri: new Map(), cut: new Map() });
  } catch (err) {
    console.error(err);
    vrt.set(d.id, { parts: null, ghost: null, tri: new Map(), cut: new Map() });
    toast(`「${d.name}」のモデルを読み込めませんでした`);
  }
}
async function ensureAll() {
  for (const d of allVariants()) if (!vrt.has(d.id)) await ensureVariant(d);
  rebuildMain();
  renderLists();
}

// ============================================================
// モデルの区間切り出し（同じ切り方は一度だけ計算して使い回す）
// ============================================================
function triOf(r, k) {
  if (r.tri.has(k)) return r.tri.get(k);
  const g = r.parts[k].geo;
  const T = {
    pos: g.attributes.position.array,
    nor: g.attributes.normal ? g.attributes.normal.array : null,
    uv: g.attributes.uv ? g.attributes.uv.array : null,
    count: g.attributes.position.array.length / 3
  };
  r.tri.set(k, T);
  return T;
}
function vertAt(T, i, zMin) {
  return {
    p: [T.pos[3 * i], T.pos[3 * i + 1], T.pos[3 * i + 2] - zMin],
    n: T.nor ? [T.nor[3 * i], T.nor[3 * i + 1], T.nor[3 * i + 2]] : [0, 1, 0],
    uv: T.uv ? [T.uv[2 * i], T.uv[2 * i + 1]] : [0, 0]
  };
}
function lerpV(a, b, t) {
  return {
    p: a.p.map((x, i) => x + (b.p[i] - x) * t),
    n: a.n.map((x, i) => x + (b.n[i] - x) * t),
    uv: a.uv.map((x, i) => x + (b.uv[i] - x) * t)
  };
}
function clipPoly(poly, c, sign) {
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const cur = poly[i], nxt = poly[(i + 1) % n];
    const cin = sign * (cur.p[2] - c) >= 0;
    const nin = sign * (nxt.p[2] - c) >= 0;
    if (cin) out.push(cur);
    if (cin !== nin) {
      const t = (c - cur.p[2]) / (nxt.p[2] - cur.p[2]);
      out.push(lerpV(cur, nxt, t));
    }
  }
  return out;
}
function cutTris(T, zMin, zA, zB, off, l, P, N, U) {
  for (let i = 0; i < T.count; i += 3) {
    // 帯の外に完全に出る三角形は早めに捨てる（軽量化）
    let zmin = Infinity, zmax = -Infinity;
    for (let j = 0; j < 3; j++) {
      const z = T.pos[3 * (i + j) + 2] - zMin;
      if (z < zmin) zmin = z;
      if (z > zmax) zmax = z;
    }
    if (zmax < zA || zmin > zB) continue;
    let poly = [vertAt(T, i, zMin), vertAt(T, i + 1, zMin), vertAt(T, i + 2, zMin)];
    poly = clipPoly(poly, zA, 1);
    if (poly.length < 3) continue;
    poly = clipPoly(poly, zB, -1);
    if (poly.length < 3) continue;
    for (let j = 1; j < poly.length - 1; j++) {
      for (const v of [poly[0], poly[j], poly[j + 1]]) {
        P.push(v.p[0], v.p[1], v.p[2] + off - l / 2);
        N.push(v.n[0], v.n[1], v.n[2]);
        U.push(v.uv[0], v.uv[1]);
      }
    }
  }
}
function cutGeo(r, k, a, l) {
  const key = k + '|' + a.toFixed(4) + '|' + l.toFixed(4);
  let g = r.cut.get(key);
  if (g) return g;
  const T = triOf(r, k);
  const P = [], N = [], U = [];
  const seg1 = Math.min(l, r.lenZ - a);
  cutTris(T, r.zMin, a, a + seg1, -a, l, P, N, U);
  if (l - seg1 > 1e-6) cutTris(T, r.zMin, 0, l - seg1, r.lenZ - a, l, P, N, U);
  g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  r.cut.set(key, g);
  return g;
}

// ============================================================
// 照準・スナップ
// ============================================================
function surfacePoint() {
  const h = raycastBlock(60);
  if (h) {
    const cam = camera.position;
    const d = camera.getWorldDirection(new V3());
    const n = [h.nx, h.ny, h.nz], c = [h.x, h.y, h.z], o = [cam.x, cam.y, cam.z], dv = [d.x, d.y, d.z];
    const ax = n[0] !== 0 ? 0 : (n[1] !== 0 ? 1 : 2);
    const pv = c[ax] + (n[ax] > 0 ? 1 : 0);
    const t = dv[ax] !== 0 ? (pv - o[ax]) / dv[ax] : NaN;
    if (isFinite(t) && t > 0) return new V3(o[0] + dv[0] * t, o[1] + dv[1] * t, o[2] + dv[2] * t);
    return new V3(h.x + 0.5, h.y + 1, h.z + 0.5);
  }
  const d = camera.getWorldDirection(new V3());
  if (d.y > -0.05) return null;
  const t = (player.pos.y - camera.position.y) / d.y;
  if (t < 0 || t > 60) return null;
  return camera.position.clone().addScaledVector(d, t);
}

function cursorTarget() {
  const pt = surfacePoint();
  if (!pt) return null;
  const p = pt.clone();
  p.y += rs.offset;
  const g = rs.grid;
  if (g > 0) {
    p.x = Math.round(p.x / g) * g;
    p.z = Math.round(p.z / g) * g;
    p.y = Math.round(p.y / g) * g;
  }
  for (const n of st.nodes) {
    if (n.kind !== rs.mode) continue;
    if (Math.hypot(n.p.x - p.x, n.p.z - p.z) < 0.8 && Math.abs(n.p.y - p.y) < 1.2) {
      return { p: n.p.clone(), node: n, d: n.d.clone(), sl: n.sl };
    }
  }
  return { p, node: null, d: null, sl: null };
}

// ============================================================
// 経路の生成
// ============================================================
function bez(A, P1, P2, B, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return new V3(a * A.x + b * P1.x + c * P2.x + d * B.x, 0, a * A.z + b * P1.z + c * P2.z + d * B.z);
}
function arcPoints(A, M, B, N) {
  const ax = A.x, az = A.z, bx = M.x, bz = M.z, cx = B.x, cz = B.z;
  const d = 2 * (ax * (bz - cz) + bx * (cz - az) + cx * (az - bz));
  const a2 = ax * ax + az * az, b2 = bx * bx + bz * bz, c2 = cx * cx + cz * cz;
  const ox = (a2 * (bz - cz) + b2 * (cz - az) + c2 * (az - bz)) / d;
  const oz = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  const R = Math.hypot(ax - ox, az - oz);
  const TAU = 2 * Math.PI;
  const nrm = x => ((x % TAU) + TAU) % TAU;
  const aA = Math.atan2(az - oz, ax - ox);
  const aM = Math.atan2(bz - oz, bx - ox);
  const aB = Math.atan2(cz - oz, cx - ox);
  const cAM = nrm(aM - aA), cAB = nrm(aB - aA);
  const sweep = cAM < cAB ? cAB : cAB - TAU;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const ang = aA + sweep * t;
    pts.push(new V3(ox + R * Math.cos(ang), 0, oz + R * Math.sin(ang)));
  }
  return pts;
}
function densify(pts, N) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  const total = cum[cum.length - 1];
  const out = [];
  let j = 1;
  for (let i = 0; i <= N; i++) {
    const s = total * i / N;
    while (j < pts.length - 1 && cum[j] < s) j++;
    const seg = (cum[j] - cum[j - 1]) || 1e-6;
    const f = clamp((s - cum[j - 1]) / seg, 0, 1);
    out.push(new V3(
      pts[j - 1].x + (pts[j].x - pts[j - 1].x) * f, 0,
      pts[j - 1].z + (pts[j].z - pts[j - 1].z) * f
    ));
  }
  return out;
}

function computePath(from, to, mid) {
  const A = from.p, B = to.p;
  const dx = B.x - A.x, dz = B.z - A.z;
  const L = Math.hypot(dx, dz);
  if (L < 0.5) return [];
  const cd = new V3(dx / L, 0, dz / L);
  const chord = (B.y - A.y) / L;
  const mA = (from.sl != null) ? clamp(from.sl, -2, 2) : chord;
  const mE = to.node ? clamp(-(to.node.sl || 0), -2, 2) : chord;

  let pts = [], smooth = false;
  if (mid) {
    const cross = (mid.x - A.x) * (B.z - A.z) - (mid.z - A.z) * (B.x - A.x);
    if (Math.abs(cross) < 0.03 * L) {
      pts = densify([new V3(A.x, 0, A.z), new V3(mid.x, 0, mid.z), new V3(B.x, 0, B.z)], 160);
    } else {
      pts = arcPoints(A, mid, B, 200);
    }
    smooth = true;
  } else {
    const dA = from.d ? hz(from.d) : cd.clone();
    const dE = to.node ? hz(to.node.d).negate() : cd.clone();
    const straight = dA.dot(cd) > 0.9995 && dE.dot(cd) > 0.9995;
    if (straight) {
      pts = densify([new V3(A.x, 0, A.z), new V3(B.x, 0, B.z)], 160);
    } else {
      const turnA = 1 - dA.dot(cd), turnE = 1 - dE.dot(cd);
      const k1 = L * clamp(0.35 + 0.25 * turnA, 0.35, 0.85);
      const k2 = L * clamp(0.35 + 0.25 * turnE, 0.35, 0.85);
      const P1 = new V3(A.x + dA.x * k1, 0, A.z + dA.z * k1);
      const P2 = new V3(B.x - dE.x * k2, 0, B.z - dE.z * k2);
      for (let i = 0; i <= 160; i++) pts.push(bez(A, P1, P2, B, i / 160));
      smooth = true;
    }
  }

  const hcum = [0];
  for (let i = 1; i < pts.length; i++) hcum[i] = hcum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  const HT = hcum[hcum.length - 1];
  if (HT < 0.01) return [];
  for (let i = 0; i < pts.length; i++) {
    const u = hcum[i] / HT;
    const u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    pts[i].y = h00 * A.y + h10 * mA * HT + h01 * B.y + h11 * mE * HT;
  }
  pts[0].set(A.x, A.y, A.z);
  pts[pts.length - 1].set(B.x, B.y, B.z);

  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + pts[i].distanceTo(pts[i - 1]);
  const total = cum[cum.length - 1];
  if (total < 0.01) return [];

  const at = s => {
    s = Math.max(0, Math.min(total, s));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const seg = cum[i] - cum[i - 1] || 1e-6;
    const f = (s - cum[i - 1]) / seg;
    return pts[i - 1].clone().lerp(pts[i], f);
  };
  const curvy = smooth || Math.abs(mA - mE) > 0.001 || Math.abs(mA - chord) > 0.001;
  const step = curvy ? 0.5 : 1;
  const n = Math.max(1, Math.round(total / step));
  const sl = total / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    const s0 = i * sl, s1 = (i + 1) * sl, sm = (s0 + s1) / 2;
    const m = at(sm);
    const tan = at(sm + 0.02).sub(at(sm - 0.02));
    if (tan.lengthSq() < 1e-10) tan.set(cd.x, 0, cd.z);
    out.push({ mid: m, tan: tan.normalize(), len: sl, ph: s0 });
  }
  if (out.length > 2) {
    const sm2 = out.map((s, i) => {
      const a = out[Math.max(0, i - 1)].tan, c = out[Math.min(out.length - 1, i + 1)].tan;
      return new V3(
        a.x * 0.25 + s.tan.x * 0.5 + c.x * 0.25,
        a.y * 0.25 + s.tan.y * 0.5 + c.y * 0.25,
        a.z * 0.25 + s.tan.z * 0.5 + c.z * 0.25
      ).normalize();
    });
    for (let i = 0; i < out.length; i++) out[i].tan = sm2[i];
  }
  return out;
}

function makePiece(vid, kind, w, s, g) {
  const d = new THREE.Object3D();
  d.position.copy(s.mid);
  d.lookAt(s.mid.x + s.tan.x, s.mid.y + s.tan.y, s.mid.z + s.tan.z);
  return {
    v: vid, kind, w,
    x: s.mid.x, y: s.mid.y + Y_LIFT, z: s.mid.z,
    q: [d.quaternion.x, d.quaternion.y, d.quaternion.z, d.quaternion.w],
    l: s.len, ph: s.ph, g
  };
}
function pieceMatrix(pc, out, r) {
  _p.set(pc.x, pc.y, pc.z);
  _q.set(pc.q[0], pc.q[1], pc.q[2], pc.q[3]);
  if (r && r.isModel) _s.set(1, 1, 1);
  else _s.set(pc.w, 1, pc.l);
  return out.compose(_p, _q, _s);
}

// 見た目が同じもの（モデル・切り方）をまとめる。切り方は1/16マス単位にそろえて数を減らす
function bucketize(pieces) {
  const map = new Map();
  for (const pc of pieces) {
    const r = vrt.get(pc.v);
    if (!r || !r.parts) continue;
    r.parts.forEach((part, k) => {
      let key, geo;
      if (r.isModel) {
        let aq = Math.round(mod(pc.ph || 0, r.lenZ) * 16) / 16;
        if (aq >= r.lenZ) aq = 0;
        const lq = Math.max(1 / 64, Math.round(pc.l * 64) / 64);
        key = `${pc.v}|${k}|${aq.toFixed(4)}|${lq.toFixed(4)}`;
        geo = cutGeo(r, k, aq, lq);
      } else {
        key = `${pc.v}|${k}`;
        geo = part.geo;
      }
      let b = map.get(key);
      if (!b) { b = { key, geo, vid: pc.v, k, list: [] }; map.set(key, b); }
      b.list.push(pc);
    });
  }
  return map;
}

// ============================================================
// 区画（描画距離の外は描かない）
// ============================================================
function indexPieces() {
  for (const c of chunks.values()) {
    if (c.meshes) for (const m of c.meshes) scene.remove(m);
  }
  chunks.clear();
  for (const p of st.pieces) {
    const cx = Math.floor(p.x / RC), cz = Math.floor(p.z / RC);
    const k = cx + ',' + cz;
    let c = chunks.get(k);
    if (!c) { c = { cx, cz, pieces: [], meshes: null }; chunks.set(k, c); }
    c.pieces.push(p);
  }
}
function buildChunk(c) {
  c.meshes = [];
  const buckets = bucketize(c.pieces);
  for (const b of buckets.values()) {
    const r = vrt.get(b.vid);
    const mat = r.parts[b.k].mat;
    const im = new THREE.InstancedMesh(b.geo, mat, b.list.length);
    b.list.forEach((pc, i) => im.setMatrixAt(i, pieceMatrix(pc, _M, r)));
    im.instanceMatrix.needsUpdate = true;
    im.frustumCulled = false;
    scene.add(im);
    c.meshes.push(im);
  }
}
function dropChunkMeshes(c) {
  if (!c.meshes) return;
  for (const m of c.meshes) scene.remove(m);
  c.meshes = null;
}
// 毎フレーム：描画距離の内側の区画だけ描く（1フレームに1区画ずつ作って滑らかに）
function updateVisible() {
  const pcx = Math.floor(player.pos.x / RC), pcz = Math.floor(player.pos.z / RC);
  const R = Math.ceil(((RD || 6) + 1) * CS / RC) + 1;
  let budget = 1;
  for (const c of chunks.values()) {
    const inR = Math.abs(c.cx - pcx) <= R && Math.abs(c.cz - pcz) <= R;
    if (inR) {
      if (!c.meshes && budget > 0) { buildChunk(c); budget--; }
    } else if (c.meshes) {
      dropChunkMeshes(c);
    }
  }
}

// ============================================================
// 敷設の確定・取り消し・個別削除
// ============================================================
function roadTap() {
  const t = cursorTarget();
  if (!t) { toast('地面に向けてタップしてください'); return; }
  if (!rs.pending) {
    rs.pending = { p: t.p.clone(), d: t.d ? t.d.clone() : null, sl: t.sl, node: t.node };
    rs.mid = null; rs.nextMid = false;
    toast('始点を指定しました。（中間点は「中間点」ボタン／Mキー）終点をタップ');
    return;
  }
  if (rs.nextMid) {
    if (t.p.distanceTo(rs.pending.p) < 0.5) { toast('中間点は始点から離して置いてください'); return; }
    rs.mid = t.p.clone();
    rs.nextMid = false;
    toast('中間点を置きました。終点をタップ');
    return;
  }
  const path = computePath(rs.pending, t, rs.mid);
  if (!path.length) { toast('距離が短すぎます'); return; }
  commit(path, rs.pending, t);
  rs.mid = null;
}
function commit(path, from, to) {
  const kind = rs.mode, vid = st.sel[kind];
  const w = kind === 'rail' ? W_RAIL : W_ROAD;
  const g = ++st.gid;
  for (const s of path) st.pieces.push(makePiece(vid, kind, w, s, g));
  const first = path[0], last = path[path.length - 1];
  if (!from.node) st.nodes.push({ p: from.p.clone(), d: hz(first.tan).negate(), sl: -first.tan.y / hlen(first.tan), kind, g });
  let endNode = to.node;
  if (!endNode) {
    endNode = { p: to.p.clone(), d: hz(last.tan), sl: last.tan.y / hlen(last.tan), kind, g };
    st.nodes.push(endNode);
  }
  st.undo.push({ g });
  if (st.undo.length > 200) st.undo.shift();
  rs.pending = { p: endNode.p.clone(), d: endNode.d.clone(), sl: endNode.sl, node: endNode };
  rebuildMain();
  saveAll();
}

function removeGroup(g) {
  st.pieces = st.pieces.filter(p => p.g !== g);
  st.nodes = st.nodes.filter(n => n.g !== g);
  st.undo = st.undo.filter(u => u.g !== g);
  rs.pending = null;
  rs.mid = null;
  rebuildMain();
  saveAll();
}
function nearestGroup(p, maxDist) {
  let best = null, bd = maxDist;
  const cx = Math.floor(p.x / RC), cz = Math.floor(p.z / RC);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const c = chunks.get((cx + dx) + ',' + (cz + dz));
    if (!c) continue;
    for (const pc of c.pieces) {
      const d = Math.hypot(pc.x - p.x, pc.z - p.z);
      if (d < bd && Math.abs(pc.y - p.y) < 3) { bd = d; best = pc; }
    }
  }
  return best;
}
function roadBreak() {
  if (rs.mid) { rs.mid = null; toast('中間点を取り消しました'); return; }
  if (rs.nextMid) { rs.nextMid = false; toast('中間点の指定を取り消しました'); return; }
  if (rs.pending) { rs.pending = null; toast('始点をキャンセルしました'); return; }
  const t = cursorTarget();
  if (!t) return;
  const pc = nearestGroup(t.p, 1.8);
  if (!pc) { toast('削除できる敷設がありません（対象に近づけてください）'); return; }
  const n = st.pieces.filter(p => p.g === pc.g).length;
  removeGroup(pc.g);
  toast(`この敷設（${n}区間）を削除しました`);
}
function undoRoad() {
  const rec = st.undo.pop();
  if (!rec) { toast('元に戻す敷設がありません'); return; }
  removeGroup(rec.g);
  toast('直前の敷設を元に戻しました');
}
function clearAll() {
  if (!confirm('敷設した道路・線路をすべて削除しますか？')) return;
  st.pieces = []; st.nodes = []; st.undo = []; rs.pending = null; rs.mid = null;
  rebuildMain();
  saveAll();
  toast('すべて削除しました');
}
function toggleMid() {
  if (!rs.mode) return;
  if (!rs.pending) { toast('先に始点を指定してください'); return; }
  rs.nextMid = !rs.nextMid;
  toast(rs.nextMid ? '次のタップを中間点にします' : '中間点の指定を解除しました');
  updateMidBtn();
}

// ============================================================
// 描画の更新（変更時は区画を作り直す。実際の描画は updateVisible が担当）
// ============================================================
function rebuildMain() {
  indexPieces();
}
function ghostMat(r, k) {
  if (!r.ghost) {
    r.ghost = r.parts.map(p => {
      const m = p.mat.clone();
      m.transparent = true; m.opacity = 0.5; m.depthWrite = false; m.alphaTest = 0;
      m.color.set(0xbfe9ff);
      return m;
    });
  }
  return r.ghost[k];
}
function showPreview(pieces, vid) {
  if (vid !== prevVid) { clearPreview(); prevVid = vid; }
  for (const rec of prevPool.values()) rec.im.visible = false;
  const r = vrt.get(vid);
  if (!r || !r.parts || !pieces.length) return;
  // 予定の経路が動くたびに新しい描画物を増やさない。順番（部品の順）で同じ描画物を使い回す
  const buckets = [...bucketize(pieces).values()];
  buckets.forEach((b, idx) => {
    const slot = 'p' + idx;
    const n = b.list.length;
    let rec = prevPool.get(slot);
    if (!rec || rec.cap < n) {
      if (rec) scene.remove(rec.im);
      const cap = Math.max(32, n * 2);
      const im = new THREE.InstancedMesh(b.geo, ghostMat(r, b.k), cap);
      im.frustumCulled = false;
      im.renderOrder = 6;
      scene.add(im);
      rec = { im, cap };
      prevPool.set(slot, rec);
    }
    if (rec.im.geometry !== b.geo) rec.im.geometry = b.geo;
    rec.im.material = ghostMat(r, b.k);
    rec.im.visible = true;
    rec.im.count = n;
    b.list.forEach((pc, i) => rec.im.setMatrixAt(i, pieceMatrix(pc, _M, r)));
    rec.im.instanceMatrix.needsUpdate = true;
  });
}
function hidePreview() {
  for (const rec of prevPool.values()) rec.im.visible = false;
}
function clearPreview() {
  for (const rec of prevPool.values()) scene.remove(rec.im);
  prevPool = new Map();
  prevVid = null;
}
function makeMarker(color) {
  const m = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(0.6, 0.6, 0.6)),
    new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 })
  );
  m.renderOrder = 7;
  m.visible = false;
  scene.add(m);
  return m;
}

// ============================================================
// モード切替・HUD・中間点ボタン
// ============================================================
function setMode(kind) {
  rs.mode = rs.mode === kind ? null : kind;
  rs.pending = null; rs.mid = null; rs.nextMid = false;
  lastPreviewKey = '';
  syncModeButtons();
  if (rs.mode) toast(rs.mode === 'road' ? '道路モード：始点をタップ' : '線路モード：始点をタップ');
  else toast('敷設モードを終了しました');
}
function syncModeButtons() {
  const a = document.getElementById('rdModeRoad'), b = document.getElementById('rdModeRail');
  if (!a || !b) return;
  a.classList.toggle('on', rs.mode === 'road');
  b.classList.toggle('on', rs.mode === 'rail');
}
function updateMidBtn() {
  const mb = document.getElementById('rdMidBtn');
  if (!mb) return;
  const show = !!rs.mode && started && !menuOpen && !rdOpen && !paused;
  mb.style.display = show ? 'block' : 'none';
  const xb = document.getElementById('rdExitBtn');
  if (xb) xb.style.display = show ? 'block' : 'none';
  mb.classList.toggle('on', rs.nextMid);
  mb.classList.toggle('set', !!rs.mid && !rs.nextMid);
  mb.textContent = rs.nextMid ? '中間点を置く' : (rs.mid ? '中間点 ✓' : '中間点');
}
function updateHud() {
  const hud = document.getElementById('rdHud');
  if (!hud) return;
  if (!rs.mode) { hud.style.display = 'none'; return; }
  hud.style.display = 'block';
  const name = rs.mode === 'road' ? '道路' : '線路';
  const v = variantById(st.sel[rs.mode]);
  let step;
  if (!rs.pending) step = '始点をタップ（敷設の上で左クリック・長押しで削除）';
  else if (rs.nextMid) step = '中間点をタップ';
  else if (rs.mid) step = '終点をタップ（中間点あり）';
  else step = '終点をタップ（中間点は右の「中間点」ボタン）';
  hud.textContent = `${name}モード（${v ? v.name : ''}）：${step} ｜ グリッド ${rs.grid === 0 ? 'フリー' : rs.grid + 'マス'} ｜ 高さ ${rs.offset >= 0 ? '+' : ''}${rs.offset}`;
}

// ============================================================
// フレームごとの処理
// ============================================================
function roadFrame() {
  requestAnimationFrame(roadFrame);
  updateVisible();
  const active = !!rs.mode && started && !menuOpen && !paused && !rdOpen;
  updateMidBtn();
  if (!active) {
    markerCur.visible = markerPend.visible = markerDel.visible = markerMid.visible = false;
    hidePreview();
    updateHud();
    lastPreviewKey = '';
    return;
  }
  const t = cursorTarget();
  if (!t) {
    markerCur.visible = markerPend.visible = markerDel.visible = false;
    hidePreview();
    return;
  }
  const vid = st.sel[rs.mode];
  markerCur.visible = true;
  markerCur.position.set(t.p.x, t.p.y + 0.5, t.p.z);
  markerCur.material.color.set(rs.nextMid ? 0x6dff8a : 0x66e0ff);
  if (rs.mid) {
    markerMid.visible = true;
    markerMid.position.set(rs.mid.x, rs.mid.y + 0.5, rs.mid.z);
  } else markerMid.visible = false;

  if (rs.pending) {
    markerDel.visible = false;
    markerPend.visible = true;
    markerPend.position.set(rs.pending.p.x, rs.pending.p.y + 0.5, rs.pending.p.z);
    // 照準が変わったときだけ予定の経路を作り直す（軽量化）
    const key = [rs.mode, rs.nextMid, t.p.x.toFixed(2), t.p.y.toFixed(2), t.p.z.toFixed(2),
      rs.pending.p.x.toFixed(2), rs.pending.p.y.toFixed(2), rs.pending.p.z.toFixed(2),
      rs.mid ? rs.mid.x.toFixed(2) + rs.mid.z.toFixed(2) : '-'].join('|');
    if (key !== lastPreviewKey) {
      lastPreviewKey = key;
      if (!rs.nextMid) {
        const path = computePath(rs.pending, t, rs.mid);
        const w = rs.mode === 'rail' ? W_RAIL : W_ROAD;
        showPreview(path.map(s => makePiece(vid, rs.mode, w, s, 0)), vid);
      } else {
        hidePreview();
      }
    }
  } else {
    markerPend.visible = false;
    hidePreview();
    lastPreviewKey = '';
    const pc = nearestGroup(t.p, 1.8);
    if (pc) {
      markerDel.visible = true;
      markerDel.position.set(pc.x, pc.y + 0.5, pc.z);
      markerCur.material.color.set(0xff6b6b);
    } else {
      markerDel.visible = false;
    }
  }
  hudTick++;
  if (hudTick % 10 === 0) updateHud();
}

// ============================================================
// 入力の割り込み
// ============================================================
const pPlace = window.doPlace, pBreak = window.doBreak;
const pStart = window.startAct, pStop = window.stopAct;

window.doPlace = function () {
  if (rs.mode) return roadTap();
  return pPlace();
};
window.doBreak = function () {
  if (rs.mode) return roadBreak();
  return pBreak();
};
window.startAct = function (kind) {
  if (rs.mode && (kind === 'break' || kind === 'place')) {
    if (acts[kind]) return;
    acts[kind] = 'road';
    if (kind === 'break') roadBreak(); else roadTap();
    return;
  }
  return pStart(kind);
};
window.stopAct = function (kind) {
  if (acts[kind] === 'road') { acts[kind] = null; return; }
  return pStop(kind);
};

window.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (!started || rdOpen || menuOpen) return;
  if (e.code === 'KeyK') setMode('road');
  else if (e.code === 'KeyJ') setMode('rail');
  else if (e.code === 'KeyM' && rs.mode) toggleMid();
  else if (e.code === 'Backspace' && rs.mode) { e.preventDefault(); roadBreak(); }
});

// ============================================================
// パネル
// ============================================================
function openRdPanel() {
  if (settingsEl.classList.contains('show')) return;
  rdOpen = true;
  document.getElementById('rdPanel').classList.add('show');
  menuOpen = true;
  releaseActions();
  for (const k in keys) keys[k] = false;
  if (document.pointerLockElement) document.exitPointerLock();
  renderLists();
  document.getElementById('rdGrid').value = String(rs.grid);
  document.getElementById('rdOffset').value = String(rs.offset);
  syncModeButtons();
}
function closeRdPanel() {
  rdOpen = false;
  document.getElementById('rdPanel').classList.remove('show');
  menuOpen = false;
  if (!isTouch && started) {
    const p = canvas.requestPointerLock && canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => {});
  }
}
function renderLists() {
  const mk = kind => allVariants().filter(v => v.kind === kind).map(v => {
    const thumb = v.texData ? `background:url(${v.texData}) center/cover` : 'background:#3a4450';
    const sel = st.sel[kind] === v.id;
    return `<div class="rd-item ${sel ? 'sel' : ''}">
      <span class="rd-chip" style="${thumb}">${v.builtin ? (kind === 'road' ? '🛣' : '🚆') : ''}</span>
      <span class="rd-name">${v.name}</span>
      <button class="rd-btn small" data-sel="${v.id}" data-kind="${kind}">${sel ? '使用中' : '使う'}</button>
      ${v.builtin ? '' : `<button class="rd-btn small danger" data-del="${v.id}">削除</button>`}
    </div>`;
  }).join('');
  const r = document.getElementById('rdListRoad'), l = document.getElementById('rdListRail');
  if (r) r.innerHTML = mk('road');
  if (l) l.innerHTML = mk('rail');
}
function useVariant(id, kind) {
  st.sel[kind] = id;
  rs.pending = null; rs.mid = null;
  saveAll();
  renderLists();
  rebuildMain();
  toast(`「${variantById(id).name}」を使います`);
}
async function addVariant() {
  const name = (document.getElementById('rdName').value.trim()) || ('カスタム' + (st.variants.length + 1));
  const kind = document.getElementById('rdKind').value;
  const texFile = document.getElementById('rdTex').files[0];
  const modelFile = document.getElementById('rdModel').files[0];
  const scaleStr = document.getElementById('rdScale').value.trim();
  const status = document.getElementById('rdStatus');
  if (!modelFile && !texFile) { status.textContent = 'テクスチャかモデルのどちらか（または両方）を選んでください。'; return; }
  let model = null, texData = null;
  try {
    if (texFile) texData = await new Promise((res, rej) => {
      const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(texFile);
    });
    if (modelFile) {
      const x = modelFile.name.split('.').pop().toLowerCase();
      const format = x === 'obj' ? 'obj' : x === 'fbx' ? 'fbx' : (x === 'json' || x === 'bbmodel') ? 'json' : null;
      if (!format) { status.textContent = '対応形式は .obj .fbx .json .bbmodel です。'; return; }
      const data = await new Promise((res, rej) => {
        const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej;
        if (format === 'fbx') r.readAsDataURL(modelFile); else r.readAsText(modelFile);
      });
      model = { format, data };
    }
  } catch (err) {
    status.textContent = 'ファイルの読み込みに失敗しました。';
    return;
  }
  const scale = Number(scaleStr);
  const def = { id: uid(), kind, name, texData, model, builtin: false, scale: (scaleStr && scale > 0) ? scale : undefined };
  status.textContent = 'モデルを読み込み中…';
  await ensureVariant(def);
  if (!vrt.get(def.id).parts) { status.textContent = 'モデルを読み込めませんでした。形式を確認してください。'; return; }
  st.variants.push(def);
  st.sel[kind] = def.id;
  saveAll();
  rebuildMain();
  renderLists();
  status.textContent = `「${name}」を追加しました。`;
  document.getElementById('rdName').value = '';
  document.getElementById('rdTex').value = '';
  document.getElementById('rdModel').value = '';
  document.getElementById('rdScale').value = '';
}
function deleteVariant(id) {
  const v = st.variants.find(x => x.id === id);
  if (!v) return;
  if (!confirm(`「${v.name}」を削除しますか？\nこのバリエーションで敷設した道路・線路も消えます。`)) return;
  const gs = new Set(st.pieces.filter(p => p.v === id).map(p => p.g));
  st.variants = st.variants.filter(x => x.id !== id);
  st.pieces = st.pieces.filter(p => p.v !== id);
  st.nodes = st.nodes.filter(n => !gs.has(n.g));
  st.undo = st.undo.filter(u => !gs.has(u.g));
  vrt.delete(id);
  if (st.sel[v.kind] === id) st.sel[v.kind] = v.kind === 'road' ? 'std_road' : 'std_rail';
  rs.pending = null; rs.mid = null;
  rebuildMain();
  saveAll();
  renderLists();
  toast('削除しました');
}

function buildUI() {
  const style = document.createElement('style');
  style.textContent = `
  #rdBtn{position:fixed;right:10px;top:86px;z-index:6;background:rgba(0,0,0,.45);color:#fff;
    border:1px solid rgba(255,255,255,.4);border-radius:6px;padding:7px 11px;font-size:13px;cursor:pointer}
  #rdMidBtn{position:fixed;right:12px;top:200px;z-index:8;display:none;background:rgba(0,0,0,.6);color:#fff;
    border:2px solid #fff;border-radius:12px;padding:14px 18px;font-size:16px;font-weight:bold;
    touch-action:manipulation;cursor:pointer;min-width:120px;text-align:center}
  #rdExitBtn{position:fixed;right:12px;top:272px;z-index:8;display:none;background:rgba(120,30,30,.85);color:#fff;
    border:2px solid #ffb3b3;border-radius:12px;padding:12px 16px;font-size:15px;font-weight:bold;
    touch-action:manipulation;cursor:pointer;min-width:120px;text-align:center}
  #rdMidBtn.on{background:#2f7a3c;border-color:#bff5c9}
  #rdMidBtn.set{background:#6a5a1e;border-color:#ffe38a}
  #rdHud{position:fixed;left:50%;bottom:118px;transform:translateX(-50%);z-index:7;background:rgba(0,0,0,.6);
    color:#fff;padding:6px 10px;border-radius:6px;font-size:12px;display:none;pointer-events:none;white-space:nowrap}
  #rdToast{position:fixed;left:50%;top:22%;transform:translateX(-50%);background:rgba(0,0,0,.75);color:#fff;
    padding:8px 14px;border-radius:8px;z-index:60;opacity:0;transition:opacity .3s;pointer-events:none;font-size:13px}
  #rdToast.show{opacity:1}
  .rd-panel{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:41}
  .rd-panel.show{display:flex}
  .rd-box{background:#1b2530;color:#fff;border-radius:10px;padding:16px;width:min(94vw,640px);max-height:92vh;
    overflow:auto;box-sizing:border-box;font-size:14px;box-shadow:0 6px 24px rgba(0,0,0,.5)}
  .rd-box h2{margin:0 0 10px;font-size:18px}
  .rd-box h3{margin:14px 0 6px;font-size:14px;color:#cfe3f5}
  .rd-box .note{font-size:12px;color:#9fb3c8;line-height:1.6;margin:6px 0}
  .rd-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:6px}
  .rd-btn{background:#2e4a66;color:#fff;border:none;border-radius:6px;padding:7px 12px;cursor:pointer;font-size:13px}
  .rd-btn.small{padding:4px 8px;font-size:12px}
  .rd-btn.danger{background:#7a3030}
  .rd-btn.on{background:#4a7a3a}
  .rd-btn.sub{background:#3a3f48}
  .rd-box input,.rd-box select{background:#2a3846;color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:4px;padding:4px 6px;font-size:13px}
  .rd-item{display:flex;align-items:center;gap:6px;background:rgba(255,255,255,.06);border-radius:6px;padding:4px 6px;width:100%;box-sizing:border-box}
  .rd-item.sel{outline:1px solid #8fd08f}
  .rd-chip{width:34px;height:34px;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;font-size:18px}
  .rd-name{flex:1}
  `;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.id = 'rdBtn';
  btn.textContent = '🛣 敷設';
  document.body.appendChild(btn);
  btn.addEventListener('click', e => { e.stopPropagation(); openRdPanel(); });

  const mb = document.createElement('button');
  mb.id = 'rdMidBtn';
  mb.textContent = '中間点';
  document.body.appendChild(mb);
  const midTap = e => { e.preventDefault(); e.stopPropagation(); toggleMid(); };
  mb.addEventListener('touchstart', midTap, { passive: false });
  mb.addEventListener('touchend', e => { e.preventDefault(); e.stopPropagation(); }, { passive: false });
  mb.addEventListener('click', e => { e.stopPropagation(); toggleMid(); });

  // 敷設モード終了（押すと通常のブロック配置に戻る）
  const xb = document.createElement('button');
  xb.id = 'rdExitBtn';
  xb.textContent = '敷設モード終了';
  document.body.appendChild(xb);
  const exitTap = e => { e.preventDefault(); e.stopPropagation(); if (rs.mode) setMode(rs.mode); updateMidBtn(); };
  xb.addEventListener('touchstart', exitTap, { passive: false });
  xb.addEventListener('touchend', e => { e.preventDefault(); e.stopPropagation(); }, { passive: false });
  xb.addEventListener('click', e => { e.stopPropagation(); if (rs.mode) setMode(rs.mode); updateMidBtn(); });

  const hud = document.createElement('div');
  hud.id = 'rdHud';
  document.body.appendChild(hud);

  toastEl = document.createElement('div');
  toastEl.id = 'rdToast';
  document.body.appendChild(toastEl);

  const wrap = document.createElement('div');
  wrap.innerHTML = `
  <div class="rd-panel" id="rdPanel"><div class="rd-box">
    <h2>道路・線路の敷設</h2>
    <div class="rd-row">
      <button class="rd-btn" id="rdModeRoad">🛣 道路モード（K）</button>
      <button class="rd-btn" id="rdModeRail">🚆 線路モード（J）</button>
      <button class="rd-btn sub" id="rdMid">中間点（M）</button>
      <button class="rd-btn sub" id="rdUndo">直前を元に戻す</button>
      <button class="rd-btn danger" id="rdClear">すべて削除</button>
    </div>
    <h3>配置</h3>
    <div class="rd-row">
      <label>グリッド
        <select id="rdGrid">
          <option value="1">1マス</option><option value="0.5">0.5マス</option><option value="0">フリー（グリッド無し）</option>
        </select>
      </label>
      <label>高さ（地表から）
        <input type="number" id="rdOffset" step="0.25" value="0" style="width:90px"> マス
      </label>
    </div>
    <p class="note">
      <b>敷設の手順</b>：①始点をタップ → ②（任意）「中間点」ボタン（画面右側）を押してから、カーブの途中をタップ → ③終点をタップ。
      坂（勾配）も曲線と同じく、角度がなめらかに変わります。既存の道路の端に近づけると吸着し、そこから続けて敷設できます。
    </p>
    <p class="note">操作：右クリック／タップで点を指定。左クリック／長押しで、敷設の上なら「その敷設を削除」、途中ならキャンセル。Backspaceでも取り消せます。</p>
    <p class="note">軽量化：描画距離の外の敷設は描画されません。近づくと順に表示されます。</p>
    <h3>道路のバリエーション</h3>
    <div id="rdListRoad" style="display:flex;flex-direction:column;gap:4px"></div>
    <h3>線路のバリエーション</h3>
    <div id="rdListRail" style="display:flex;flex-direction:column;gap:4px"></div>
    <h3>バリエーションを追加（インポート）</h3>
    <div class="rd-row">
      <input id="rdName" placeholder="名前" style="flex:1;min-width:140px">
      <select id="rdKind"><option value="road">道路</option><option value="rail">線路</option></select>
    </div>
    <div class="rd-row"><label>テクスチャ <input type="file" id="rdTex" accept="image/png,image/jpeg"></label></div>
    <div class="rd-row"><label>モデル <input type="file" id="rdModel" accept=".obj,.fbx,.json,.bbmodel"></label></div>
    <div class="rd-row"><label>スケール（空欄＝自動）<input id="rdScale" type="number" step="0.01" min="0.001" style="width:100px"></label></div>
    <p class="note">モデルは縮めずに使います。進行方向をZ軸、道幅をX軸にしてください。</p>
    <div class="rd-row">
      <button class="rd-btn" id="rdSave">追加して登録</button>
      <button class="rd-btn sub" id="rdClose">閉じる</button>
    </div>
    <p class="note" id="rdStatus"></p>
  </div></div>`;
  while (wrap.firstChild) document.body.appendChild(wrap.firstChild);

  document.getElementById('rdModeRoad').addEventListener('click', () => setMode('road'));
  document.getElementById('rdModeRail').addEventListener('click', () => setMode('rail'));
  document.getElementById('rdMid').addEventListener('click', toggleMid);
  document.getElementById('rdUndo').addEventListener('click', undoRoad);
  document.getElementById('rdClear').addEventListener('click', clearAll);
  document.getElementById('rdGrid').addEventListener('change', e => {
    rs.grid = Number(e.target.value); saveAll();
  });
  document.getElementById('rdOffset').addEventListener('change', e => {
    rs.offset = clamp(Number(e.target.value) || 0, -40, 60);
    e.target.value = String(rs.offset);
    saveAll();
  });
  document.getElementById('rdSave').addEventListener('click', addVariant);
  document.getElementById('rdClose').addEventListener('click', closeRdPanel);
  const onList = e => {
    const s = e.target.dataset.sel, d = e.target.dataset.del;
    if (s) useVariant(s, e.target.dataset.kind);
    if (d) deleteVariant(d);
  };
  document.getElementById('rdListRoad').addEventListener('click', onList);
  document.getElementById('rdListRail').addEventListener('click', onList);
  window.addEventListener('keydown', e => {
    if (e.code === 'Escape' && rdOpen) closeRdPanel();
  });
}

// ============================================================
// 初期化
// ============================================================
function init() {
  loadAll();
  buildUI();
  markerCur = makeMarker(0x66e0ff);
  markerPend = makeMarker(0xffd84a);
  markerDel = makeMarker(0xff4d4d);
  markerMid = makeMarker(0x6dff8a);
  rebuildMain();
  ensureAll();
  requestAnimationFrame(roadFrame);
}
window.VoxelSync = window.VoxelSync || {};
VoxelSync.road = { reload: () => { loadAll(); rebuildMain(); if (typeof ensureAll === 'function') ensureAll(); } };

init();

// 自動車交通（voxel-craft-traffic.js）から、道路と同じ「地面の点」「経路の計算」「操作間隔」を使うための窓口
window.VoxelRoad = {
  surfacePoint, computePath, Y_LIFT,
  getGrid: () => rs.grid,
  getOffset: () => rs.offset
};

})();

