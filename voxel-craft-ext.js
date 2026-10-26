/* voxel-craft-ext.js  (v4)
 * voxel-craft.html の機能追加モジュール（既存HTMLは変更しない）
 *  1. ターボモード
 *  2. カスタムブロック（フルブロック＝スキン描画 / モデル＝OBJ・FBX・JSON）
 *     ・配置方式：向き固定（ノーマル）／4方向（かまど風）／自由（原木・ボタン風）
 *     ・モデルのスケール（自動／そのまま／ピクセル単位÷16／任意倍率）
 *     ・透過テクスチャはアルファで抜き、下の地面が消えない描画
 *  3. インベントリ（保存・カテゴリ管理・道具）
 *  4. ワールドエディット（ステッキ・スポイト・フィル・コピー・ペースト）
 *  5. 傾き配置（角度選択）・グリッド切替（1.0 / 0.5 / 0.25 / フリー）
 *  ※ シェーダー切替（setShader）を正しく包む順番に修正
 */
(function () {
'use strict';

// ============================================================
// 定数・状態
// ============================================================
const EXT_KEY = 'voxelcraft_ext_v1';
const CUSTOM_BASE = 100, CUSTOM_MAX = 255;
const T_WAND = 50, T_DROPPER = 51, T_FILL = 52, T_COPY = 53, T_PASTE = 54, T_PASTE_ROT = 55;
const TOOLS = {
  50: { name: 'ステッキ', icon: '🪄', desc: 'タップで範囲の始点・終点を指定（3回目からは繰り返し）' },
  51: { name: 'スポイト', icon: '🧪', desc: 'ブロックをタップして登録（空気も登録できます）' },
  52: { name: 'フィル', icon: '🪣', desc: '長押しで選択範囲をスポイトのブロックで埋める' },
  53: { name: 'コピー', icon: '⧉', desc: '長押しで選択範囲をコピー' },
  54: { name: 'ペースト', icon: '📌', desc: '長押しでコピーを貼り付け（半透明プレビュー付き）' },
  55: { name: 'ペースト前の回転・反転', icon: '🔄', desc: '持っている間、上の入力欄で回転・反転を設定（ペーストに反映）' }
};
const isTool = id => id >= T_WAND && id <= T_PASTE_ROT;
const AIR_ID = 0;
const ORIENT_NAMES = { fixed: '向き固定（ノーマル）', four: '4方向（かまど風）', free: '自由（原木・ボタン風）' };

const PRESET_NAMES = {
  none: 'なし（標準の音）', stone: '石', wood: '木', dirt: '土', grass: '草',
  sand: '砂', leaves: '葉', metal: '金属', glass: 'ガラス', water: '水', soft: 'やわらかい'
};

const ext = {
  turbo: false,
  shaderBefore: null,
  defs: [],
  categories: ['未分類'],
  colorHistory: [],
  curColor: '#ffffff',
  rot: 0,
  curCat: '全て',
  invOpen: false,
  tilt: 0,
  grid: 1,
  dropper: 3,
  clip: null,
  pasteOpt: { rot: 0, pitch: 0, mx: false, mz: false, fl: null, air: false }
};

const defRT = new Map();
const blockState = new Map();   // "x,y,z" -> { color, rot, qb }
const thumbCache = new Map();
const wand = { stage: 0, p1: null, p2: null };
const undoStack = [];
const tiltList = [];
const rc = new THREE.Raycaster();
const NDC0 = new THREE.Vector2(0, 0);
const selGroup = new THREE.Group();
const pasteGroup = new THREE.Group();
let pasteDirty = true;
let ghost = null, ghostId = -1;
let panelOpen = null;
scene.add(selGroup);
scene.add(pasteGroup);
pasteGroup.visible = false;

// 本体の setShader を、ターボ対応の包み（順番を間違えないように先に退避する）
const origSetShader = window.setShader;
window.setShader = function (on) {
  origSetShader(ext.turbo ? false : on);
  if (ext.turbo) applyRenderScale();
};

// ============================================================
// 小さな補助関数
// ============================================================
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function keyOf(x, y, z) { return x + ',' + y + ',' + z; }
function defById(id) { return ext.defs.find(d => d.id === id); }
function nameOf(id) {
  if (id === AIR_ID) return '空気';
  if (BLOCK_INFO[id]) return BLOCK_INFO[id].name;
  return 'ID ' + id;
}
function nextId() {
  for (let i = CUSTOM_BASE; i <= CUSTOM_MAX; i++) {
    if (!ext.defs.some(d => d.id === i)) return i;
  }
  return -1;
}
function readAs(file, mode) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    if (mode === 'text') r.readAsText(file); else r.readAsDataURL(file);
  });
}
function dataUrlToBuffer(url) {
  return fetch(url).then(r => r.arrayBuffer());
}
let toastEl = null, toastT = 0;
function toast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

// ============================================================
// 保存・読み込み（localStorage）
// ============================================================
function loadExt() {
  try {
    const s = JSON.parse(localStorage.getItem(EXT_KEY) || '{}');
    ext.turbo = !!s.turbo;
    ext.shaderBefore = typeof s.shaderBefore === 'boolean' ? s.shaderBefore : null;
    if (Array.isArray(s.categories) && s.categories.length) ext.categories = s.categories;
    if (Array.isArray(s.colorHistory)) ext.colorHistory = s.colorHistory.slice(0, 12);
    if (Array.isArray(s.defs)) ext.defs = s.defs;
    if (typeof s.tilt === 'number') ext.tilt = clamp(s.tilt, 0, 90);
    if (typeof s.grid === 'number') ext.grid = [1, 0.5, 0.25, 0].includes(s.grid) ? s.grid : 1;
  } catch (e) {}
}
const BLOB_DB = 'voxelcraft_blobs';
const BIG_TEXT = 2048;               // これより長い文字列は IndexedDB に置く
const blobLast = new Map();          // キー -> 最後に書いた値（同じなら書かない）
let blobDbP = null;
function blobDb() {
  if (!blobDbP) blobDbP = new Promise((res, rej) => {
    const r = indexedDB.open(BLOB_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('b');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return blobDbP;
}
function blobWriteOp(key, val) {
  return blobDb().then(db => new Promise((res, rej) => {
    const tx = db.transaction('b', 'readwrite');
    tx.objectStore('b').put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  }));
}
function blobDelOp(key) {
  return blobDb().then(db => new Promise((res, rej) => {
    const tx = db.transaction('b', 'readwrite');
    tx.objectStore('b').delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  }));
}
function blobGet(key) {
  return blobDb().then(db => new Promise((res, rej) => {
    const rq = db.transaction('b', 'readonly').objectStore('b').get(key);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  }));
}
const isRef = v => !!v && typeof v === 'object' && typeof v.__blob === 'string';
// 大きい文字列を書き込む（同じ値なら書かない）。書き込みの完了を待てる Promise を返す
function writeBlob(key, val) {
  if (blobLast.get(key) === val) return null;
  blobLast.set(key, val);
  return blobWriteOp(key, val).catch(() => {
    blobLast.delete(key);
    toast('容量の大きいデータを書き込めませんでした（保存領域がいっぱいの可能性があります）');
  });
}
// 定義の中身を「軽い形」にする：大きい文字列は IndexedDB のキーに置き換える
function lightenDefs(defs) {
  const live = new Set(), pending = [];
  const put = (key, v) => { const pr = writeBlob(key, v); if (pr) pending.push(pr); };
  const ref = (key, v) => {
    if (isRef(v)) { live.add(v.__blob); return v; }
    if (typeof v !== 'string' || v.length < BIG_TEXT) return v;
    live.add(key); put(key, v);
    return { __blob: key };
  };
  const out = defs.map(d => {
    const o = { ...d };
    if (d.texData !== undefined) o.texData = ref(d.id + ':tex', d.texData);
    if (d.model) {
      const m = { ...d.model };
      m.data = ref(d.id + ':mdl', m.data);
      if (m.mtl !== undefined) m.mtl = ref(d.id + ':mtl', m.mtl);
      if (isRef(m.images)) { live.add(m.images.__blob); }
      else if (m.images && typeof m.images === 'object' && Object.keys(m.images).length) {
        live.add(d.id + ':img');
        put(d.id + ':img', JSON.stringify(m.images));
        m.images = { __blob: d.id + ':img', json: true };
      } else m.images = undefined;
      o.model = m;
    }
    return o;
  });
  return { defs: out, live, pending };
}
function cleanBlobs(live) {
  for (const k of [...blobLast.keys()]) {
    if (!live.has(k)) { blobLast.delete(k); blobDelOp(k).catch(() => {}); }
  }
}
function saveExt() {
  try {
    const L = lightenDefs(ext.defs);
    localStorage.setItem(EXT_KEY, JSON.stringify({
      turbo: ext.turbo, shaderBefore: ext.shaderBefore,
      categories: ext.categories, colorHistory: ext.colorHistory, defs: L.defs,
      tilt: ext.tilt, grid: ext.grid
    }));
    cleanBlobs(L.live);
    return true;
  } catch (e) {
    toast('保存できませんでした（設定の保存領域がいっぱいです）');
    return false;
  }
}
async function resolveRef(v) {
  if (!isRef(v)) return v;
  const raw = await blobGet(v.__blob);
  if (v.json) { try { return JSON.parse(raw || '{}'); } catch (e) { return {}; } }
  return raw;
}
// 書き出し用：大きい中身も含めた、完全な設定の文字列
async function fullExtJson() {
  const defs = [];
  for (const d of ext.defs) {
    const o = { ...d };
    if (d.texData !== undefined) o.texData = await resolveRef(d.texData);
    if (d.model) {
      const m = { ...d.model };
      m.data = await resolveRef(m.data);
      if (m.mtl !== undefined) m.mtl = await resolveRef(m.mtl);
      if (m.images !== undefined) m.images = await resolveRef(m.images);
      o.model = m;
    }
    defs.push(o);
  }
  return JSON.stringify({ turbo: ext.turbo, shaderBefore: ext.shaderBefore, categories: ext.categories,
    colorHistory: ext.colorHistory, defs, tilt: ext.tilt, grid: ext.grid });
}
// 読み込み用：書き出したファイルの設定を、この端末の形で保存する
async function importExtJson(json) {
  const s = JSON.parse(json);
  const L = lightenDefs(Array.isArray(s.defs) ? s.defs : []);
  await Promise.all(L.pending);
  localStorage.setItem(EXT_KEY, JSON.stringify({
    turbo: !!s.turbo, shaderBefore: typeof s.shaderBefore === 'boolean' ? s.shaderBefore : null,
    categories: s.categories, colorHistory: s.colorHistory, defs: L.defs, tilt: s.tilt, grid: s.grid
  }));
  cleanBlobs(L.live);
}
// 起動時：参照になっている中身を IndexedDB から戻す
async function hydrateDefs() {
  for (const d of ext.defs) {
    if (isRef(d.texData)) d.texData = await resolveRef(d.texData);
    if (d.model) {
      const m = d.model;
      if (isRef(m.data)) m.data = await resolveRef(m.data);
      if (isRef(m.mtl)) m.mtl = await resolveRef(m.mtl);
      if (isRef(m.images)) m.images = await resolveRef(m.images);
    }
  }
}

// ============================================================
// モデル読み込み・スケール・マテリアル
// ============================================================
function texFromUrl(url) {
  return new Promise(res => {
    new THREE.TextureLoader().load(url, t => {
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      res(t);
    }, undefined, () => res(null));
  });
}
function blankTexUrl() {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 16, 16);
  return c.toDataURL('image/png');
}

function parseBlockJson(json) {
  const root = new THREE.Group();
  const tw = (json.texture_size && json.texture_size[0]) || 16;
  const th = (json.texture_size && json.texture_size[1]) || 16;
  const FACE_ORDER = ['east', 'west', 'up', 'down', 'south', 'north'];
  for (const el of json.elements || []) {
    if (!el.from || !el.to) continue;
    const [x1, y1, z1] = el.from, [x2, y2, z2] = el.to;
    const geo = new THREE.BoxGeometry((x2 - x1) / 16, (y2 - y1) / 16, (z2 - z1) / 16);
    const uv = geo.attributes.uv;
    FACE_ORDER.forEach((name, f) => {
      const fd = el.faces && el.faces[name];
      const r = (fd && fd.uv) || [0, 0, 16, 16];
      const u0 = r[0] / tw, u1 = r[2] / tw, v0 = 1 - r[3] / th, v1 = 1 - r[1] / th;
      const corners = [[u0, v1], [u1, v1], [u0, v0], [u1, v0]];
      for (let i = 0; i < 4; i++) uv.setXY(f * 4 + i, corners[i][0], corners[i][1]);
    });
    uv.needsUpdate = true;
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0xbbbbbb }));
    mesh.position.set((x1 + x2) / 32, (y1 + y2) / 32, (z1 + z2) / 32);
    root.add(mesh);
  }
  return root;
}

function applyTexToObj(obj, tex) {
  obj.traverse(o => {
    if (o.isMesh) o.material = new THREE.MeshLambertMaterial({ map: tex });
  });
}

// 読み込んだモデルのマテリアルを「不透明＋アルファ抜き」に統一する
function sanitizeMaterials(obj) {
  obj.traverse(o => {
    if (!o.isMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    ms.forEach(m => {
      if (!m) return;
      m.transparent = false;
      m.opacity = 1;
      m.depthWrite = true;
      m.depthTest = true;
      m.side = THREE.DoubleSide;
      m.alphaTest = m.map ? 0.5 : 0;
      m.needsUpdate = true;
    });
  });
}

function measure(obj) {
  const w = new THREE.Group();
  w.add(obj);
  w.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(w);
  w.remove(obj);
  return b.getSize(new THREE.Vector3());
}
// 自動スケール：最大寸法が8を超えるモデルはピクセル単位（16px＝1ブロック）とみなして÷16
function autoScaleFor(raw) {
  const s = measure(raw);
  const m = Math.max(s.x, s.y, s.z);
  return m > 8 ? 1 / 16 : 1;
}
function placeModel(raw, scale) {
  const outer = new THREE.Group();
  raw.scale.setScalar(scale);
  raw.position.set(0, 0, 0);
  outer.add(raw);
  outer.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(outer);
  // Blockbench の制作位置をそのまま使う：1ブロック分の枠（16px、または1単位）の中心をブロックの中心に合わせる。
  // モデルの大きさに関係なく、端に寄せた位置・はみ出した部分も、制作したとおりの場所に出る。
  // 縦方向は底面を床に合わせる（今までどおり）。
  raw.position.set(-0.5, -b.min.y, -0.5);
  outer.updateMatrixWorld(true);
  return outer;
}

// MTL（マテリアル）を読む：色（Kd）と、テクスチャの画像名（map_Kd）
function parseMtl(text) {
  const out = new Map();
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const p = line.split(/\s+/);
    const k = p[0];
    if (k === 'newmtl') { cur = { kd: [0.8, 0.8, 0.8], map: null }; out.set(line.slice(6).trim(), cur); }
    else if (!cur) continue;
    else if (k === 'Kd') cur.kd = [Number(p[1]) || 0, Number(p[2]) || 0, Number(p[3]) || 0];
    else if (k === 'map_Kd') cur.map = p[p.length - 1];
  }
  return out;
}
// OBJ を、マテリアル（usemtl）ごとの頂点に分ける。四角以上の面は三角形に分ける
function parseObjGroups(text) {
  const vs = [], vts = [], vns = [];
  const groups = new Map();
  let mat = '';
  const group = name => {
    if (!groups.has(name)) groups.set(name, { pos: [], uv: [], nrm: [], hasUv: false, hasN: false });
    return groups.get(name);
  };
  const idx = (s, n) => { const i = Number(s); return i < 0 ? n + i : i - 1; };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const p = line.split(/\s+/);
    const k = p[0];
    if (k === 'v') vs.push(Number(p[1]) || 0, Number(p[2]) || 0, Number(p[3]) || 0);
    else if (k === 'vt') vts.push(Number(p[1]) || 0, Number(p[2]) || 0);
    else if (k === 'vn') vns.push(Number(p[1]) || 0, Number(p[2]) || 0, Number(p[3]) || 0);
    else if (k === 'usemtl') mat = line.slice(6).trim();
    else if (k === 'f' && p.length >= 4) {
      const g = group(mat);
      const corners = [];
      for (let t = 1; t < p.length; t++) {
        const parts = p[t].split('/');
        corners.push([
          idx(parts[0], vs.length / 3),
          parts[1] ? idx(parts[1], vts.length / 2) : -1,
          parts[2] ? idx(parts[2], vns.length / 3) : -1
        ]);
      }
      for (let c = 1; c < corners.length - 1; c++) {
        for (const [vi, ti, ni] of [corners[0], corners[c], corners[c + 1]]) {
          g.pos.push(vs[vi * 3], vs[vi * 3 + 1], vs[vi * 3 + 2]);
          if (ti >= 0) { g.uv.push(vts[ti * 2], vts[ti * 2 + 1]); g.hasUv = true; } else g.uv.push(0, 0);
          if (ni >= 0) { g.nrm.push(vns[ni * 3], vns[ni * 3 + 1], vns[ni * 3 + 2]); g.hasN = true; } else g.nrm.push(0, 0, 0);
        }
      }
    }
  }
  return groups;
}
// OBJ＋MTL＋画像から、マテリアルつきのモデルを作る
async function buildObjWithMtl(text, mtlText, images) {
  const groups = parseObjGroups(text);
  const mats = parseMtl(mtlText);
  const byName = new Map(Object.entries(images || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const imgFor = file => {
    if (!file) return null;
    const base = String(file).split(/[\\/]/).pop().toLowerCase();
    return byName.get(base) || null;
  };
  const root = new THREE.Group();
  const texCache = new Map();
  for (const [name, g] of groups) {
    const m = mats.get(name);
    const mat = new THREE.MeshLambertMaterial();
    if (m) mat.color.setRGB(m.kd[0], m.kd[1], m.kd[2]);
    const url = m ? imgFor(m.map) : null;
    if (url) {
      let t = texCache.get(url);
      if (!t) { t = await texFromUrl(url); texCache.set(url, t); }
      if (t) { mat.map = t; mat.color.setRGB(1, 1, 1); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
    if (g.hasUv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
    if (g.hasN) geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.nrm, 3));
    else geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    root.add(mesh);
  }
  return root;
}
async function loadModelObject(format, data, texUrl, scaleOverride, rotDeg, mdl) {
  let raw, fromMtl = false;
  if (format === 'obj' && mdl && mdl.mtl) { raw = await buildObjWithMtl(data, mdl.mtl, mdl.images || {}); fromMtl = true; }
  else if (format === 'obj') raw = new THREE.OBJLoader().parse(data);
  else if (format === 'fbx') raw = new THREE.FBXLoader().parse(await dataUrlToBuffer(data), '');
  else if (format === 'json') raw = parseBlockJson(JSON.parse(data));
  else throw new Error('unknown format');
  if (texUrl && !fromMtl) {
    const tex = await texFromUrl(texUrl);
    if (tex) applyTexToObj(raw, tex);
  }
  const scale = typeof scaleOverride === 'number' ? scaleOverride : autoScaleFor(raw);
  const root = placeModel(raw, scale);
  // 向きの補正（Blockbenchで反転したときに、0・90・180・270度で直す）
  if (rotDeg) { root.rotation.y = rotDeg * Math.PI / 180; root.updateMatrixWorld(true); }
  sanitizeMaterials(root);
  return { root, scale };
}

let decCtx = null;
function decodeAudio(url) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return Promise.reject(new Error('no audio'));
  if (!decCtx) decCtx = new AC();
  return dataUrlToBuffer(url).then(buf => decCtx.decodeAudioData(buf));
}

function tileUVGeom(id) {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const uv = g.attributes.uv;
  for (let f = 0; f < 6; f++) {
    const tile = tileIndex(id, f);
    const col = tile % 4, row = Math.floor(tile / 4);
    const u0 = col / 4, u1 = (col + 1) / 4, vb = 1 - (row + 1) / 4, vt = 1 - row / 4;
    const c = [[u0, vb], [u1, vb], [u1, vt], [u0, vt]];
    for (let i = 0; i < 4; i++) uv.setXY(f * 4 + i, c[i][0], c[i][1]);
  }
  uv.needsUpdate = true;
  return g;
}

// ============================================================
// 定義の登録（起動時・新規作成時）
// ============================================================
async function registerDef(def) {
  const rt = { def, ready: false, tex: null, material: null, template: null, buf: {} };
  defRT.set(def.id, rt);
  BLOCK_INFO[def.id] = { name: def.name, color: '#8c8c8c' };

  if (def.kind === 'cube') {
    rt.tex = await texFromUrl(def.texData || blankTexUrl());
    rt.material = new THREE.MeshLambertMaterial({
      map: rt.tex, vertexColors: true, alphaTest: 0.3
    });
  } else if (def.model) {
    try {
      const r = await loadModelObject(def.model.format, def.model.data, def.texData,
        typeof def.scale === 'number' ? def.scale : null, def.modelRot || 0, def.model);
      rt.template = r.root;
    } catch (err) {
      console.error(err);
      toast(`「${def.name}」のモデルを読み込めませんでした`);
    }
  }
  for (const kind of ['break', 'place']) {
    const s = def.sounds && def.sounds[kind];
    if (s && s.type === 'file' && s.data) {
      try { rt.buf[kind] = await decodeAudio(s.data); } catch (e) {}
    }
  }
  rt.ready = true;
  renderAllChunks();
  refreshHotbarVisuals();
  if (ext.invOpen) renderInventory();
}
function renderAllChunks() {
  for (const e of chunks.values()) if (e.built) markDirty(e);
}

// ============================================================
// モデルの向き（配置方式）
// ============================================================
// 状態：rot（0〜3 の 90度単位の回転）と qb（面に沿わせる基本の向き）
function modelQuat(st) {
  const qY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ((st && st.rot) || 0) * Math.PI / 2);
  if (st && st.qb) {
    const qb = new THREE.Quaternion(st.qb[0], st.qb[1], st.qb[2], st.qb[3]);
    return qb.multiply(qY);
  }
  return qY;
}
// 配置方式に応じた向きを決める
function modelOrient(def, p) {
  const o = (def && def.orient) || 'fixed';
  if (o === 'four') {
    // 4方向：モデルの正面（-Z）が設置した人の方を向く
    const k = ((Math.round((player.yaw + Math.PI) / (Math.PI / 2)) % 4) + 4) % 4;
    return { rot: k, qb: null };
  }
  if (o === 'free' && p && p.normal) {
    // 自由：クリックした面に沿って立てる（壁・天井・床のどこでも）
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), p.normal.clone().normalize());
    return { rot: ext.rot, qb: [q.x, q.y, q.z, q.w] };
  }
  return { rot: ext.rot, qb: null };
}
// モデルの位置：底面が面に接するように、中心から q*(0,-0.5,0) だけずらす
function modelCenterFor(cell, q) {
  return new THREE.Vector3(cell[0] + 0.5, cell[1] + 0.5, cell[2] + 0.5)
    .add(new THREE.Vector3(0, -0.5, 0).applyQuaternion(q));
}

function makeModelInstance(id, wx, wy, wz) {
  const rt = defRT.get(id);
  if (!rt || !rt.template) return null;
  const st = blockState.get(keyOf(wx, wy, wz)) || {};
  const inst = rt.template.clone(true);
  const q = modelQuat(st);
  inst.quaternion.copy(q);
  inst.position.copy(modelCenterFor([wx, wy, wz], q));
  inst.traverse(o => {
    if (o.isMesh) { o.castShadow = shaderOn; o.receiveShadow = shaderOn; }
  });
  if (rt.def.colorable && st.color) {
    inst.traverse(o => {
      if (o.isMesh && o.material) {
        o.material = o.material.clone();
        o.material.userData.isClone = true;
        o.material.color.set(st.color);
      }
    });
  }
  return inst;
}

const origDisposeEntry = window.disposeEntry;
window.disposeEntry = function (e) {
  origDisposeEntry(e);
  if (e.extMeshes) {
    for (const o of e.extMeshes) {
      scene.remove(o);
      if (o.isMesh && o.geometry) o.geometry.dispose();
      o.traverse(c => {
        if (c.isMesh && c.material && c.material.userData && c.material.userData.isClone) c.material.dispose();
      });
    }
    e.extMeshes = null;
  }
};

// 透明テクスチャの隣の面も描くため、カスタムブロックと標準ブロックは互いに面を隠さない
// 発光ブロックの色（テクスチャの平均色）
function glowColorOf(rt) {
  if (rt.glowCol) return rt.glowCol;
  let col = [1, 1, 1];
  try {
    const img = rt.tex && rt.tex.image;
    if (img && (img.width || img.naturalWidth)) {
      const c = document.createElement('canvas');
      c.width = 8; c.height = 8;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, 8, 8);
      const px = g.getImageData(0, 0, 8, 8).data;
      let r = 0, gg = 0, b = 0, n = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 128) { r += px[i]; gg += px[i + 1]; b += px[i + 2]; n++; }
      if (n) col = [r / n / 255, gg / n / 255, b / n / 255];
    }
  } catch (e) {}
  rt.glowCol = col;
  return col;
}
// このチャンクの中にある発光ブロック（チャンクの外へは光を広げない）
function glowSourcesOf(dd) {
  const out = [];
  if (!ext.defs.some(df => df.alpha === 'glow')) return out;
  for (let li = 0; li < 4096; li++) {
    const t = dd[li];
    if (t < CUSTOM_BASE) continue;
    const rt = defRT.get(t);
    if (!rt || !rt.ready || !rt.def || rt.def.alpha !== 'glow') continue;
    const col = glowColorOf(rt);
    out.push({ x: (li & 15) + 0.5, y: ((li >> 4) & 15) + 0.5, z: ((li >> 8) & 15) + 0.5,
      r: col[0], g: col[1], b: col[2], power: rt.def.glowPower || 1.5 });
  }
  return out;
}
// 頂点の色へ光を足す。格子点ごとに一度だけ計算して、頂点はそこから引く（発光の数が多くても軽い）
function applyGlowLight(bufs, srcs) {
  if (!srcs.length) return;
  const N = 17;
  const L = new Float32Array(N * N * N * 3);
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let r = 0, g = 0, b = 0;
    for (const sc of srcs) {
      const dx = x - sc.x, dy = y - sc.y, dz = z - sc.z;
      const k = sc.power / (1 + 0.05 * Math.sqrt(dx * dx + dy * dy + dz * dz));   // 遠くても消えにくい
      r += sc.r * k; g += sc.g * k; b += sc.b * k;
    }
    const i = (x + y * N + z * N * N) * 3;
    L[i] = r; L[i + 1] = g; L[i + 2] = b;
  }
  const cell = v => Math.min(16, Math.max(0, Math.round(v)));
  for (const buf of bufs) {
    const p = buf.p, c = buf.c;
    for (let v = 0; v < p.length; v += 3) {
      const i = (cell(p[v]) + cell(p[v + 1]) * N + cell(p[v + 2]) * N * N) * 3;
      c[v] = Math.min(2.5, c[v] + L[i]);
      c[v + 1] = Math.min(2.5, c[v + 1] + L[i + 1]);
      c[v + 2] = Math.min(2.5, c[v + 2] + L[i + 2]);
    }
  }
}

window.buildMesh = function (e) {
  if (!e.gen) generateEntry(e);
  e.dirty = false;
  e.built = true;
  disposeEntry(e);
  if (!e.data) return;

  const ox = e.cx * CS, oy = e.cy * CS, oz = e.cz * CS;
  const d = e.data;

  for (let pz = 0; pz < 18; pz++) for (let py = 0; py < 18; py++) for (let px = 0; px < 18; px++) {
    const lx = px - 1, ly = py - 1, lz = pz - 1;
    let t;
    if (lx >= 0 && lx < 16 && ly >= 0 && ly < 16 && lz >= 0 && lz < 16) t = d[lx + ly * 16 + lz * 256];
    else t = getBlock(ox + lx, oy + ly, oz + lz);
    P[px + py * 18 + pz * 324] = t;
  }

  const SB = { p: [], n: [], uv: [], c: [], i: [] };
  const WB = { p: [], n: [], uv: [], c: [], i: [] };
  const PB = { p: [], n: [], uv: [], c: [], i: [] };
  const CB = new Map();
  const extra = [];

  for (let z = 0; z < 16; z++) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const pi = (x + 1) + (y + 1) * 18 + (z + 1) * 324;
    const t = P[pi];
    const wx = ox + x, wy = oy + y, wz = oz + z;

    if (t === AIR) {
      if (!ext.turbo && P[pi - STRIDE[1]] === GRASS) {
        const r = hash2(wx, wz, 777);
        if (r < 0.45) {
          const cxw = x + 0.5 + (hash2(wx, wz, 781) - 0.5) * 0.5;
          const czw = z + 0.5 + (hash2(wx, wz, 782) - 0.5) * 0.5;
          const ang = hash2(wx, wz, 783) * Math.PI;
          const shade = 0.82 + 0.18 * hash2(wx, wz, 784);
          if (r < 0.04) {
            const type = 2 + Math.floor(hash2(wx, wz, 779) * 3);
            emitPlant(PB, cxw, y, czw, type, 0.35 + 0.3 * hash2(wx, wz, 780), 0.6, ang, shade);
          } else if (hash2(wx, wz, 778) < 0.5) {
            emitPlant(PB, cxw, y, czw, 0, 0.7 + 0.4 * hash2(wx, wz, 780), 0.95, ang, shade);
          } else {
            emitPlant(PB, cxw, y, czw, 1, 0.3 + 0.25 * hash2(wx, wz, 780), 0.9, ang, shade);
          }
        }
      }
      continue;
    }

    if (t >= CUSTOM_BASE) {
      const rt = defRT.get(t);
      if (!rt || !rt.ready) continue;
      if (rt.def.kind === 'model') {
        const inst = makeModelInstance(t, wx, wy, wz);
        if (inst) { scene.add(inst); extra.push(inst); }
        continue;
      }
      if (!rt.material) continue;
      let buf = CB.get(t);
      if (!buf) { buf = { p: [], n: [], uv: [], c: [], i: [] }; CB.set(t, buf); }
      const st = rt.def.colorable ? blockState.get(keyOf(wx, wy, wz)) : null;
      const tint = (st && st.color) ? hexToRgb(st.color) : [1, 1, 1];
      for (let f = 0; f < 6; f++) {
        const nt = P[pi + FACES[f].off];
        if (nt !== AIR && nt !== WATER && nt < CUSTOM_BASE) continue;
        emitCubeFace(buf, x, y, z, f, computeAO(pi, f), tint);
      }
      continue;
    }

    for (let f = 0; f < 6; f++) {
      const nt = P[pi + FACES[f].off];
      if (t === WATER) {
        if (nt !== AIR) continue;
        emitQuad(WB, x, y, z, f, tileIndex(t, f), [1, 1, 1, 1]);
      } else {
        if (nt !== AIR && nt !== WATER && nt < CUSTOM_BASE) continue;
        emitQuad(SB, x, y, z, f, tileIndex(t, f), computeAO(pi, f));
      }
    }
  }

  applyGlowLight([SB, WB, PB, ...CB.values()], glowSourcesOf(d));
  if (SB.p.length) {
    const m = new THREE.Mesh(makeGeom(SB), solidMat);
    m.position.set(ox, oy, oz);
    m.castShadow = shaderOn;
    m.receiveShadow = shaderOn;
    scene.add(m);
    e.mesh = m;
  }
  if (WB.p.length) {
    const m = new THREE.Mesh(makeGeom(WB), shaderOn ? waterShaderMat : waterMat);
    m.position.set(ox, oy, oz);
    m.renderOrder = 2;
    scene.add(m);
    e.water = m;
  }
  if (PB.p.length && !ext.turbo) {
    const m = new THREE.Mesh(makeGeom(PB), plantMat);
    m.position.set(ox, oy, oz);
    scene.add(m);
    e.plant = m;
  }
  for (const [id, buf] of CB) {
    if (!buf.p.length) continue;
    const rt = defRT.get(id);
    const m = new THREE.Mesh(makeGeom(buf), rt.material);
    m.position.set(ox, oy, oz);
    m.castShadow = shaderOn;
    m.receiveShadow = shaderOn;
    scene.add(m);
    extra.push(m);
  }
  e.extMeshes = extra;
};

// ============================================================
// 効果音・配置・破壊（ラップ）
// ============================================================
const origPlace = window.doPlace;
const origBreak = window.doBreak;
const origPlayBreak = window.playBreak;
const origPlayPlace = window.playPlace;
const origStartAct = window.startAct;
const origStopAct = window.stopAct;

const SOUND_PRESETS = {
  stone: () => { playNoise({ freq: 2200, q: 2.5, dur: 0.22, vol: 0.45 }); playTone({ f0: 1800, f1: 1100, dur: 0.08, vol: 0.15 }); },
  wood: () => { playNoise({ freq: 900, q: 3, dur: 0.16, vol: 0.5 }); playTone({ f0: 650, f1: 400, dur: 0.1, vol: 0.15 }); },
  dirt: () => playNoise({ freq: 500, q: 0.9, dur: 0.14, vol: 0.55 }),
  grass: () => playNoise({ freq: 700, q: 0.8, dur: 0.14, vol: 0.5 }),
  sand: () => playNoise({ freq: 3000, q: 0.6, dur: 0.12, vol: 0.3 }),
  leaves: () => playNoise({ freq: 1400, q: 1.2, dur: 0.12, vol: 0.35 }),
  metal: () => { playTone({ f0: 1800, f1: 1400, dur: 0.4, vol: 0.2 }); playNoise({ freq: 4000, q: 4, dur: 0.05, vol: 0.2 }); },
  glass: () => { playNoise({ freq: 5000, q: 4, dur: 0.25, vol: 0.4 }); playTone({ f0: 2400, f1: 1800, dur: 0.15, vol: 0.08 }); },
  water: () => playNoise({ freq: 1200, q: 0.5, dur: 0.3, vol: 0.3, type: 'lowpass' }),
  soft: () => playNoise({ freq: 400, q: 0.5, dur: 0.2, vol: 0.3, type: 'lowpass' })
};
function playCustomSound(id, kind) {
  const rt = defRT.get(id);
  if (!rt || !rt.def.sounds) return false;
  const s = rt.def.sounds[kind];
  if (!s || s.type === 'none') return false;
  ensureAudio();
  if (!audio) return true;
  if (s.type === 'preset') {
    (SOUND_PRESETS[s.key] || SOUND_PRESETS.soft)();
    return true;
  }
  if (s.type === 'file' && rt.buf[kind]) {
    const src = audio.ctx.createBufferSource();
    src.buffer = rt.buf[kind];
    src.connect(audio.master);
    src.start();
    return true;
  }
  return false;
}
window.playBreak = function (bt) {
  if (bt >= CUSTOM_BASE && playCustomSound(bt, 'break')) return;
  return origPlayBreak(bt);
};
window.playPlace = function (bt) {
  if (bt >= CUSTOM_BASE && playCustomSound(bt, 'place')) return;
  return origPlayPlace(bt);
};

function applyRenderScale() {
  if (!ext.turbo) return;
  renderer.setPixelRatio(0.6);
  renderer.setSize(window.innerWidth, window.innerHeight);
}
function setTurbo(on) {
  if (on === ext.turbo) return;
  ext.turbo = on;
  if (on) {
    ext.shaderBefore = shaderOn;
    RD = Math.min(RD, 4);
    origSetShader(false);
  } else {
    RD = settings.rd;
    origSetShader(ext.shaderBefore !== null ? ext.shaderBefore : settings.shader);
  }
  lastKey = '';
  shaderChk.disabled = on;
  if (on) applyRenderScale();
  saveExt();
  syncTurboUI();
  renderAllChunks();
}
function syncTurboUI() {
  const cb = document.getElementById('extTurbo');
  if (cb) cb.checked = ext.turbo;
  const btn = document.getElementById('extBtn');
  if (btn) btn.textContent = ext.turbo ? '🎒 インベントリ（ターボON）' : '🎒 インベントリ';
}

// ============================================================
// 照準
// ============================================================
function facePoint(h) {
  const cam = camera.position;
  const d = camera.getWorldDirection(new THREE.Vector3());
  const n = [h.nx, h.ny, h.nz], c = [h.x, h.y, h.z], o = [cam.x, cam.y, cam.z], dv = [d.x, d.y, d.z];
  const ax = n[0] !== 0 ? 0 : (n[1] !== 0 ? 1 : 2);
  const pv = c[ax] + (n[ax] > 0 ? 1 : 0);
  const t = dv[ax] !== 0 ? (pv - o[ax]) / dv[ax] : NaN;
  if (!isFinite(t) || t < 0) {
    return new THREE.Vector3(h.x + 0.5 + h.nx * 0.5, h.y + 0.5 + h.ny * 0.5, h.z + 0.5 + h.nz * 0.5);
  }
  return new THREE.Vector3(o[0] + dv[0] * t, o[1] + dv[1] * t, o[2] + dv[2] * t);
}

function pickTarget() {
  const v = origRaycast(7);
  let vd = Infinity;
  if (v) vd = Math.hypot(v.x + 0.5 - camera.position.x, v.y + 0.5 - camera.position.y, v.z + 0.5 - camera.position.z);

  if (tiltList.length) {
    rc.setFromCamera(NDC0, camera);
    rc.far = 7;
    const hits = rc.intersectObjects(tiltList.map(e => e.obj), true);
    if (hits.length && hits[0].distance < vd) {
      const hit = hits[0];
      let root = hit.object;
      while (root && !root.userData.ent) root = root.parent;
      const n = hit.face
        ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
        : camera.getWorldDirection(new THREE.Vector3()).negate();
      return { kind: 'tilt', ent: root.userData.ent, point: hit.point.clone(), normal: n, dist: hit.distance };
    }
  }
  if (v) {
    return {
      kind: 'vox', h: v, point: facePoint(v),
      normal: new THREE.Vector3(v.nx, v.ny, v.nz), dist: vd
    };
  }
  return null;
}

function placeCellFrom(p) {
  if (p.kind === 'vox') return [p.h.x + p.h.nx, p.h.y + p.h.ny, p.h.z + p.h.nz];
  const q = p.point.clone().addScaledVector(p.normal, 0.5);
  return [Math.floor(q.x), Math.floor(q.y), Math.floor(q.z)];
}

function tiltPlacement(p) {
  const n = p.normal.clone().normalize();
  const ang = THREE.MathUtils.degToRad(ext.tilt);
  const up = new THREE.Vector3(0, 1, 0);
  let axis;
  if (Math.abs(n.y) > 0.5) {
    const f = camera.getWorldDirection(new THREE.Vector3());
    f.y = 0;
    if (f.lengthSq() < 1e-6) f.set(0, 0, 1);
    f.normalize();
    axis = new THREE.Vector3().crossVectors(f, up).normalize();
  } else {
    axis = new THREE.Vector3().crossVectors(n, up).normalize();
  }
  const q = new THREE.Quaternion();
  if (ext.tilt !== 0) q.setFromAxisAngle(axis, ang);
  const off = 0.5 * (Math.cos(ang) + Math.sin(ang));
  const c = p.point.clone().addScaledVector(n, off);
  if (ext.grid === 0) {
    // フリー：当てた面の持ち主（普通のブロック・傾きブロック）の格子に合わせて、隙間なく繋げる
    const hit = p.kind === 'tilt' && p.ent;
    const ref = hit ? new THREE.Vector3(p.ent.c[0], p.ent.c[1], p.ent.c[2]) : new THREE.Vector3(p.h.x + 0.5, p.h.y + 0.5, p.h.z + 0.5);
    const T = hit ? p.ent.q.clone() : new THREE.Quaternion();
    const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].map(a => a.applyQuaternion(T));
    const alignN = axes.map(a => Math.abs(a.dot(n)));
    if (Math.max(...alignN) > 0.9) {       // 面がきれいな向きのときだけ合わせる（丸いモデルの面などはそのまま）
      const d = c.clone().sub(ref);
      const out = new THREE.Vector3();
      axes.forEach((a, i) => {
        const s = d.dot(a);
        out.addScaledVector(a, alignN[i] > 0.5 ? s : Math.round(s));   // 面の向きは高さをそのまま、横は1マス単位で揃える
      });
      c.copy(out.add(ref));
    }
    const q0 = hit && ext.tilt === 0 ? T : new THREE.Quaternion();
    if (ext.tilt === 0 && hit) return { c: [c.x, c.y, c.z], q: q0 };
  }
  if (ext.grid > 0) {
    c.x = snapC(c.x, ext.grid);
    c.y = snapC(c.y, ext.grid);
    c.z = snapC(c.z, ext.grid);
  }
  return { c: [c.x, c.y, c.z], q };
}
function snapC(v, g) { return Math.round((v - 0.5) / g) * g + 0.5; }
function tiltMode() { return ext.grid !== 1 || ext.tilt !== 0; }
// 傾き配置の向き：カスタムモデルの「4方向」「固定（傾けないとき）」は、配置方式の向きを守る
function tiltOrientFor(def, p, tp) {
  if (def && def.kind === 'model' && def.orient === 'four') {
    const o = modelOrient(def, p);
    const qy = modelQuat({ rot: o.rot, qb: null });
    return { q: tp.q.clone().multiply(qy), rot: o.rot };   // 傾き × 正面の向き
  }
  if (def && def.kind === 'model' && def.orient === 'fixed' && ext.tilt === 0) {
    const o = modelOrient(def, p);
    return { q: modelQuat({ rot: o.rot, qb: null }), rot: o.rot };
  }
  return { q: tp.q, rot: ext.rot };
}

// ============================================================
// 傾いたブロック（見た目のみ・当たり判定なし）
// ============================================================
function makeTiltObject(id, st) {
  if (id >= CUSTOM_BASE) {
    const rt = defRT.get(id);
    if (!rt || !rt.ready) return null;
    if (rt.def.kind === 'model') {
      if (!rt.template) return null;
      const o = rt.template.clone(true);
      if (rt.def.colorable && st && st.color) {
        o.traverse(c => { if (c.isMesh) { c.material = c.material.clone(); c.material.color.set(st.color); } });
      }
      o.traverse(c => { if (c.isMesh) { c.castShadow = shaderOn; c.receiveShadow = shaderOn; } });
      return { obj: o, isModel: true };
    }
    if (!rt.tex) return null;
    const mat = new THREE.MeshLambertMaterial({ map: rt.tex, alphaTest: 0.3 });
    if (rt.def.colorable && st && st.color) mat.color.set(st.color);
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    m.castShadow = shaderOn; m.receiveShadow = shaderOn;
    return { obj: m, isModel: false };
  }
  if (id >= 1 && id <= 12) {
    const m = new THREE.Mesh(tileUVGeom(id), new THREE.MeshLambertMaterial({ map: atlasTex }));
    m.castShadow = shaderOn; m.receiveShadow = shaderOn;
    return { obj: m, isModel: false };
  }
  return null;
}
function addTilt(id, c, q, st) {
  const made = makeTiltObject(id, st);
  if (!made) return false;
  const obj = made.obj;
  const off = made.isModel ? new THREE.Vector3(0, -0.5, 0).applyQuaternion(q) : new THREE.Vector3();
  obj.position.set(c[0] + off.x, c[1] + off.y, c[2] + off.z);
  obj.quaternion.copy(q);
  const ent = { id, c: [c[0], c[1], c[2]], q: q.clone(), st, obj, isModel: made.isModel };
  obj.userData.ent = ent;
  obj.updateMatrixWorld(true);
  scene.add(obj);
  tiltList.push(ent);
  return true;
}
function removeTilt(ent) {
  const i = tiltList.indexOf(ent);
  if (i >= 0) tiltList.splice(i, 1);
  scene.remove(ent.obj);
  if (!ent.isModel) {
    ent.obj.traverse(c => { if (c.isMesh && c.geometry) c.geometry.dispose(); });
  }
}

// ============================================================
// 破壊・設置
// ============================================================
window.doBreak = function () {
  const p = pickTarget();
  if (!p) return;
  if (p.kind === 'tilt') {
    playBreak(p.ent.id);
    removeTilt(p.ent);
    return;
  }
  const h = p.h;
  origBreak();
  if (h.b >= CUSTOM_BASE && getBlock(h.x, h.y, h.z) === AIR) {
    blockState.delete(keyOf(h.x, h.y, h.z));
  }
};

window.doPlace = function () {
  const id = HOTBAR[selIdx];
  if (isTool(id)) return toolPrimary(id);
  const p = pickTarget();
  if (!p) return;

  const rt = id >= CUSTOM_BASE ? defRT.get(id) : null;
  if (rt && !rt.ready) return;
  const isModel = !!(rt && rt.def.kind === 'model');

  if (!tiltMode()) {
    const cell = placeCellFrom(p);
    const cur = getBlock(cell[0], cell[1], cell[2]);
    if (cur !== AIR && cur !== WATER) return;
    if (overlapsPlayer(cell[0], cell[1], cell[2])) return;
    setBlock(cell[0], cell[1], cell[2], id);
    if (isModel) {
      const o = modelOrient(rt.def, p);
      blockState.set(keyOf(cell[0], cell[1], cell[2]), { color: rt.def.colorable ? ext.curColor : null, rot: o.rot, qb: o.qb });
    } else if (rt) {
      blockState.set(keyOf(cell[0], cell[1], cell[2]), { color: rt.def.colorable ? ext.curColor : null, rot: ext.rot });
    }
    if (rt && rt.def.colorable) pushHistory(ext.curColor);
    playPlace(id);
    return;
  }

  // 傾き・フリー配置（見た目のみ）
  const tp = tiltPlacement(p);
  const cc = tp.c;
  const to = tiltOrientFor(rt && rt.def, p, tp);
  const stState = rt ? { color: rt.def.colorable ? ext.curColor : null, rot: to.rot } : null;
  const cell = [Math.floor(cc[0]), Math.floor(cc[1]), Math.floor(cc[2])];
  if (isSolidAt(cell)) return;
  const pp = player.pos;
  if (Math.hypot(cc[0] - pp.x, cc[1] - (pp.y + 0.9), cc[2] - pp.z) < 0.9) return;
  if (addTilt(id, cc, to.q, stState)) {
    if (rt && rt.def.colorable) pushHistory(ext.curColor);
    playPlace(id);
  }
};

function isSolidAt(cell) {
  const b = getBlock(cell[0], cell[1], cell[2]);
  return b !== AIR && b !== WATER;
}

window.startAct = function (kind) {
  const id = HOTBAR[selIdx];
  if (isTool(id)) {
    if (acts[kind]) return;
    acts[kind] = 'tool';
    if (kind === 'break' && (id === T_FILL || id === T_COPY || id === T_PASTE)) {
      if (id === T_FILL) fillSel();
      else if (id === T_COPY) copySel();
      else pasteHere();
    } else {
      toolPrimary(id);
    }
    return;
  }
  return origStartAct(kind);
};
window.stopAct = function (kind) {
  if (acts[kind] === 'tool') { acts[kind] = null; return; }
  return origStopAct(kind);
};

function toolPrimary(id) {
  if (id === T_WAND) return wandTap();
  if (id === T_DROPPER) return dropperTap();
  toast(TOOLS[id].name + '：' + TOOLS[id].desc);
}

// ============================================================
// ワールドエディット：ステッキ・スポイト
// ============================================================
function cellOfPick(p) {
  if (p.kind === 'vox') return [p.h.x, p.h.y, p.h.z];
  return [Math.floor(p.ent.c[0]), Math.floor(p.ent.c[1]), Math.floor(p.ent.c[2])];
}
function wandTap() {
  const p = pickTarget();
  if (!p) { toast('ブロックに向けてタップしてください'); return; }
  const c = cellOfPick(p);
  if (wand.stage === 1) {
    wand.p2 = c;
    wand.stage = 2;
  } else {
    wand.p1 = c;
    wand.p2 = null;
    wand.stage = 1;
  }
  rebuildSelVisual();
  if (wand.stage === 1) toast('始点を指定しました。もう一度タップで終点');
  else {
    const b = selBounds();
    toast(`範囲を選択しました（${b.sx}×${b.sy}×${b.sz}）`);
  }
}
function dropperTap() {
  const p = pickTarget();
  if (!p) { toast('ブロックに向けてタップしてください'); return; }
  const id = p.kind === 'vox' ? getBlock(p.h.x, p.h.y, p.h.z) : p.ent.id;
  ext.dropper = id;
  toast(`スポイト：「${nameOf(id)}」を登録しました`);
  renderInventoryIfOpen();
}

function selBounds() {
  if (wand.stage === 0 || !wand.p1) return null;
  const a = wand.p1, b = wand.stage === 2 && wand.p2 ? wand.p2 : wand.p1;
  const min = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
  const max = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
  return { min, max, sx: max[0] - min[0] + 1, sy: max[1] - min[1] + 1, sz: max[2] - min[2] + 1 };
}
const MAX_VOLUME = 262144;

function rebuildSelVisual() {
  while (selGroup.children.length) {
    const o = selGroup.children.pop();
    o.traverse(c => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    });
  }
  selGroup.userData.fill = null;
  const b = selBounds();
  if (!b) return;
  const g = new THREE.BoxGeometry(b.sx, b.sy, b.sz);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(g),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false })
  );
  const fill = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.1, depthWrite: false, depthTest: false
  }));
  const grp = new THREE.Group();
  grp.add(fill, edges);
  grp.position.set(b.min[0] + b.sx / 2, b.min[1] + b.sy / 2, b.min[2] + b.sz / 2);
  grp.renderOrder = 5;
  fill.renderOrder = 5; edges.renderOrder = 6;
  selGroup.add(grp);
  selGroup.userData.fill = fill;
}
function updateSelVisual(t) {
  const f = selGroup.userData.fill;
  if (f) f.material.opacity = 0.07 + 0.06 * Math.sin(t * 4);
}

// ============================================================
// フィル・コピー・ペースト・元に戻す
// ============================================================
function pushUndo(changes) {
  if (!changes.length) return;
  undoStack.push(changes);
  if (undoStack.length > 10) undoStack.shift();
}
function undoLast() {
  const ch = undoStack.pop();
  if (!ch) { toast('元に戻す操作がありません'); return; }
  for (let i = ch.length - 1; i >= 0; i--) {
    const c = ch[i];
    if (c.tiltEnt) { if (window.VoxelDiag && VoxelDiag.dropTilt) VoxelDiag.dropTilt(c.tiltEnt); continue; }
    setBlock(c.x, c.y, c.z, c.oldId);
    if (c.oldSt) blockState.set(c.k, c.oldSt);
    else blockState.delete(c.k);
  }
  toast('元に戻しました');
}

function fillSel() {
  const b = selBounds();
  if (!b || wand.stage !== 2) { toast('先にステッキで範囲を選択してください'); return; }
  if (b.sx * b.sy * b.sz > MAX_VOLUME) { toast('範囲が大きすぎます'); return; }
  const id = ext.dropper;
  const changes = [];
  for (let y = b.min[1]; y <= b.max[1]; y++) for (let z = b.min[2]; z <= b.max[2]; z++) for (let x = b.min[0]; x <= b.max[0]; x++) {
    const oldId = getBlock(x, y, z);
    if (oldId === id) continue;
    const k = keyOf(x, y, z);
    const oldSt = blockState.get(k) || null;
    changes.push({ x, y, z, k, oldId, oldSt });
    setBlock(x, y, z, id);
    blockState.delete(k);
  }
  pushUndo(changes);
  toast(`「${nameOf(id)}」で ${changes.length} 個埋めました`);
}

function copySel() {
  const b = selBounds();
  if (!b || wand.stage !== 2) { toast('先にステッキで範囲を選択してください'); return; }
  if (b.sx * b.sy * b.sz > MAX_VOLUME) { toast('範囲が大きすぎます'); return; }
  const n = b.sx * b.sy * b.sz;
  const ids = new Uint16Array(n);
  const sts = new Array(n).fill(null);
  for (let y = 0; y < b.sy; y++) for (let z = 0; z < b.sz; z++) for (let x = 0; x < b.sx; x++) {
    const wx = b.min[0] + x, wy = b.min[1] + y, wz = b.min[2] + z;
    const i = x + z * b.sx + y * b.sx * b.sz;
    ids[i] = getBlock(wx, wy, wz);
    const st = blockState.get(keyOf(wx, wy, wz));
    sts[i] = st ? { color: st.color, rot: st.rot, qb: st.qb || null } : null;
  }
  // 傾き・斜め・細かいグリッドのブロック（中心が範囲内にあるもの）も、位置と向きごと覚える
  const objs = [];
  for (const ent of tiltList) {
    if (!ent.obj || !ent.c || !ent.q) continue;
    const cx = ent.c[0] - b.min[0], cy = ent.c[1] - b.min[1], cz = ent.c[2] - b.min[2];
    if (cx < 0 || cy < 0 || cz < 0 || cx >= b.sx || cy >= b.sy || cz >= b.sz) continue;
    objs.push({
      id: ent.id, st: ent.st ? { color: ent.st.color, rot: ent.st.rot, qb: ent.st.qb || null } : null,
      c: [cx, cy, cz], q: [ent.q.x, ent.q.y, ent.q.z, ent.q.w]
    });
  }
  ext.clip = { sx: b.sx, sy: b.sy, sz: b.sz, ids, sts, objs };
  pasteDirty = true;
  toast(`コピーしました（${b.sx}×${b.sy}×${b.sz}${objs.length ? '・傾きブロック ' + objs.length + ' 個' : ''}）`);
  renderInventoryIfOpen();
}

function pitchQb(st) {
  // 縦回転（X軸まわり 90°）を、今のブロックの向きに重ねた向き
  const O = modelQuat(st);
  const R = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const N = R.multiply(O);
  return [N.x, N.y, N.z, N.w];
}
function transformedCells() {
  const c = ext.clip, o = ext.pasteOpt;
  const sx = c.sx, sy = c.sy, sz = c.sz;
  const out = [];
  for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    const i = x + z * sx + y * sx * sz;
    const id = c.ids[i];
    if (id === AIR && !o.air) continue;
    const st = c.sts[i];
    out.push({ x, y, z, id, st: st ? { color: st.color, rot: st.rot, qb: st.qb || null } : null });
  }
  // 反転：ペーストの反転と、向きに合わせた反転を合わせる（二重にかけると元に戻る）
  const mx = !!o.mx !== (o.fl === 'x'), mz = !!o.mz !== (o.fl === 'z');
  for (const cell of out) {
    if (mx) cell.x = sx - 1 - cell.x;
    if (mz) cell.z = sz - 1 - cell.z;
  }
  // 横回転
  let W = sx, H = sy, D = sz;
  for (let k = 0; k < o.rot; k++) {
    for (const cell of out) {
      const nx = D - 1 - cell.z, nz = cell.x;
      cell.x = nx; cell.z = nz;
      if (cell.st) cell.st = { color: cell.st.color, rot: (cell.st.rot + 1) % 4, qb: cell.st.qb };
    }
    const t = W; W = D; D = t;
  }
  // 縦回転
  const pitchSteps = ((o.pitch || 0) % 4 + 4) % 4;
  for (let k = 0; k < pitchSteps; k++) {
    for (const cell of out) {
      const ny = cell.z, nz = H - 1 - cell.y;
      cell.y = ny; cell.z = nz;
      if (cell.st) cell.st = { color: cell.st.color, rot: 0, qb: pitchQb(cell.st) };
    }
    const t = H; H = D; D = t;
  }
  return { cells: out, sx: W, sy: H, sz: D };
}

// 傾きブロックの位置と向きを、ペーストの回転・反転と同じ手順で変える（セルの変換と一致させる）
const PASTE_RY = () => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
const PASTE_RX = () => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
function mirrorQuat(q, axis) {
  const S = axis === 'x' ? new THREE.Vector3(-1, 1, 1) : new THREE.Vector3(1, 1, -1);
  const M = new THREE.Matrix4().makeScale(S.x, S.y, S.z);
  const R = new THREE.Matrix4().makeRotationFromQuaternion(q);
  return new THREE.Quaternion().setFromRotationMatrix(M.multiply(R).multiply(M));
}
function transformedObjects() {
  const c = ext.clip, o = ext.pasteOpt;
  const sx = c.sx, sy = c.sy, sz = c.sz;
  const list = (c.objs || []).map(x => ({
    id: x.id, st: x.st ? { ...x.st } : null, c: x.c.slice(), q: new THREE.Quaternion(x.q[0], x.q[1], x.q[2], x.q[3])
  }));
  const mx = !!o.mx !== (o.fl === 'x'), mz = !!o.mz !== (o.fl === 'z');
  for (const t of list) {
    if (mx) { t.c[0] = sx - t.c[0]; t.q = mirrorQuat(t.q, 'x'); }
    if (mz) { t.c[2] = sz - t.c[2]; t.q = mirrorQuat(t.q, 'z'); }
  }
  let W = sx, H = sy, D = sz;
  for (let k = 0; k < o.rot; k++) {
    for (const t of list) {
      const nx = D - t.c[2], nz = t.c[0];
      t.c[0] = nx; t.c[2] = nz;
      t.q = PASTE_RY().multiply(t.q);
    }
    const tmp = W; W = D; D = tmp;
  }
  const pitchSteps = ((o.pitch || 0) % 4 + 4) % 4;
  for (let k = 0; k < pitchSteps; k++) {
    for (const t of list) {
      const ny = t.c[2], nz = H - t.c[1];
      t.c[1] = ny; t.c[2] = nz;
      t.q = PASTE_RX().multiply(t.q);
    }
    const tmp = H; H = D; D = tmp;
  }
  return list;
}

function pasteHere() {
  if (!ext.clip) { toast('先にコピーしてください'); return; }
  const p = pickTarget();
  if (!p) { toast('ペースト先に向けて長押ししてください'); return; }
  const a = placeCellFrom(p);
  const { cells } = transformedCells();
  const changes = [];
  for (const cell of cells) {
    const wx = a[0] + cell.x, wy = a[1] + cell.y, wz = a[2] + cell.z;
    const k = keyOf(wx, wy, wz);
    const oldId = getBlock(wx, wy, wz);
    const oldSt = blockState.get(k) || null;
    if (oldId === cell.id && !oldSt && !cell.st) continue;
    changes.push({ x: wx, y: wy, z: wz, k, oldId, oldSt });
    setBlock(wx, wy, wz, cell.id);
    if (cell.id >= CUSTOM_BASE && cell.st) blockState.set(k, { color: cell.st.color, rot: cell.st.rot, qb: cell.st.qb });
    else blockState.delete(k);
  }
  // 傾きブロックも貼り付ける（同じ場所にすでにあるものは増やさない）
  const adopt = window.VoxelDiag && VoxelDiag.adoptTilt;
  let tiltCount = 0;
  const undoTilts = [];
  for (const t of transformedObjects()) {
    const cc = [a[0] + t.c[0], a[1] + t.c[1], a[2] + t.c[2]];
    const dup = tiltList.some(e => Math.abs(e.c[0] - cc[0]) < 0.01 && Math.abs(e.c[1] - cc[1]) < 0.01 && Math.abs(e.c[2] - cc[2]) < 0.01 && e.id === t.id);
    if (dup) continue;
    if (!addTilt(t.id, cc, t.q, t.st)) continue;
    const ent = tiltList[tiltList.length - 1];
    if (adopt) adopt(ent);
    undoTilts.push({ tiltEnt: ent });
    tiltCount++;
  }
  pushUndo([...changes, ...undoTilts]);
  toast(`${changes.length} 個のブロックを貼り付けました${tiltCount ? '（傾き ' + tiltCount + ' 個）' : ''}`);
}

function colorOfId(id) {
  if (id >= CUSTOM_BASE) return '#ffffff';
  return (BLOCK_INFO[id] && BLOCK_INFO[id].color) || '#ffffff';
}
function rebuildPaste() {
  while (pasteGroup.children.length) {
    const o = pasteGroup.children.pop();
    if (o.material) o.material.dispose();
  }
  if (pasteGroup.userData.geo) { pasteGroup.userData.geo.dispose(); pasteGroup.userData.geo = null; }
  pasteDirty = false;
  if (!ext.clip) return;
  const cells = transformedCells().cells.filter(c => c.id !== AIR);
  const byId = new Map();
  for (const c of cells) {
    if (!byId.has(c.id)) byId.set(c.id, []);
    byId.get(c.id).push(c);
  }
  const geo = new THREE.BoxGeometry(1.002, 1.002, 1.002);
  pasteGroup.userData.geo = geo;
  const m4 = new THREE.Matrix4();
  for (const t of transformedObjects()) {
    const made = makeTiltObject(t.id, t.st);
    if (!made) continue;
    const o = made.obj;
    const off = made.isModel ? new THREE.Vector3(0, -0.5, 0).applyQuaternion(t.q) : new THREE.Vector3();
    o.position.set(t.c[0] + off.x, t.c[1] + off.y, t.c[2] + off.z);
    o.quaternion.copy(t.q);
    o.traverse(m => { if (m.isMesh) { m.material = m.material.clone(); m.material.transparent = true; m.material.opacity = 0.4; m.material.depthWrite = false; m.castShadow = false; } });
    pasteGroup.add(o);
  }
  for (const [id, arr] of byId) {
    const mat = new THREE.MeshBasicMaterial({
      color: colorOfId(id), transparent: true, opacity: 0.38, depthWrite: false
    });
    const im = new THREE.InstancedMesh(geo, mat, arr.length);
    arr.forEach((c, i) => {
      m4.makeTranslation(c.x + 0.5, c.y + 0.5, c.z + 0.5);
      im.setMatrixAt(i, m4);
    });
    im.instanceMatrix.needsUpdate = true;
    pasteGroup.add(im);
  }
}
let rotBarEl = null, rotBarShown = false;
function ensureRotBar() {
  if (rotBarEl) return rotBarEl;
  const d = document.createElement('div');
  d.className = 'tb';
  d.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);z-index:9;display:none;background:rgba(0,0,0,.75);' +
    'color:#fff;border-radius:8px;padding:6px 10px;font-size:13px;white-space:nowrap;font-family:sans-serif;touch-action:manipulation;text-align:center';
  d.innerHTML = '横回転 <input id="prYaw" type="number" step="90" style="width:64px"> °　' +
    '縦回転 <input id="prPitch" type="number" step="90" style="width:64px"> °　' +
    '<label><input type="checkbox" id="prFlip"> 反転</label>' +
    '<div id="prNote" style="font-size:11px;opacity:.85"></div>';
  document.body.appendChild(d);
  for (const sel of ['#prYaw', '#prPitch', '#prFlip']) {
    const el = d.querySelector(sel);
    el.addEventListener('keydown', e => e.stopPropagation());
    el.addEventListener('pointerdown', e => e.stopPropagation());
    el.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
    el.addEventListener('change', applyRotBar);
  }
  rotBarEl = d;
  return d;
}
function snapQuarter(v) {
  const n = Math.round((Number(v) || 0) / 90);
  return ((n % 4) + 4) % 4;
}
function rotBarNote(o) {
  return '横 ' + (o.rot * 90) + '° ／ 縦 ' + (o.pitch * 90) + '°（ブロックは90°単位）／ 反転：' +
    (o.fl ? (o.fl === 'x' ? '左右（X）' : '左右（Z）') : 'なし');
}
function applyRotBar() {
  const d = ensureRotBar();
  const o = ext.pasteOpt;
  o.rot = snapQuarter(d.querySelector('#prYaw').value);
  o.pitch = snapQuarter(d.querySelector('#prPitch').value);
  if (!d.querySelector('#prFlip').checked) o.fl = null;
  else if (!o.fl) {
    // 反転の向きは、チェックを入れた瞬間に向いている方向で決める（正面から見て左右を反転）
    o.fl = Math.abs(Math.cos(player.yaw)) >= Math.abs(Math.sin(player.yaw)) ? 'x' : 'z';
  }
  pasteDirty = true;
  d.querySelector('#prNote').textContent = rotBarNote(o);
}
function syncRotBar() {
  const show = HOTBAR[selIdx] === T_PASTE_ROT && started && !menuOpen && !paused && !panelOpen;
  if (!show) {
    rotBarShown = false;
    if (rotBarEl) rotBarEl.style.display = 'none';
    return;
  }
  const d = ensureRotBar();
  const hb = document.getElementById('hotbar');
  const top = hb ? hb.getBoundingClientRect().top : window.innerHeight - 80;
  d.style.top = Math.max(4, top - 66) + 'px';
  if (!rotBarShown) {
    // 持った瞬間に、今の設定を入力欄へ入れる
    const o = ext.pasteOpt;
    d.querySelector('#prYaw').value = String(o.rot * 90);
    d.querySelector('#prPitch').value = String(o.pitch * 90);
    d.querySelector('#prFlip').checked = !!o.fl;
    d.querySelector('#prNote').textContent = rotBarNote(o);
  }
  rotBarShown = true;
  d.style.display = 'block';
}
function updatePaste() {
  syncRotBar();
  const id = HOTBAR[selIdx];
  if (id !== T_PASTE || !ext.clip || menuOpen || paused || !started || panelOpen) {
    pasteGroup.visible = false;
    return;
  }
  if (pasteDirty) rebuildPaste();
  const p = pickTarget();
  if (!p) { pasteGroup.visible = false; return; }
  const a = placeCellFrom(p);
  pasteGroup.position.set(a[0], a[1], a[2]);
  pasteGroup.visible = true;
}

// ============================================================
// 設置プレビュー（半透明ゴースト）
// ============================================================
function buildGhost(id) {
  if (ghost) { scene.remove(ghost); ghost = null; }
  ghostId = id;
  if (id >= 1 && id <= 12) {
    ghost = new THREE.Mesh(tileUVGeom(id), new THREE.MeshLambertMaterial({
      map: atlasTex, transparent: true, opacity: 0.45, depthWrite: false
    }));
  } else {
    const rt = defRT.get(id);
    if (!rt || !rt.ready) return;
    if (rt.def.kind === 'cube') {
      ghost = new THREE.Mesh(new THREE.BoxGeometry(1.01, 1.01, 1.01), new THREE.MeshLambertMaterial({
        map: rt.tex, transparent: true, opacity: 0.45, depthWrite: false
      }));
    } else if (rt.template) {
      ghost = rt.template.clone(true);
      ghost.traverse(o => {
        if (o.isMesh) {
          o.material = o.material.clone();
          o.material.transparent = true;
          o.material.opacity = 0.45;
          o.material.depthWrite = false;
        }
      });
    }
  }
  if (ghost) { ghost.visible = false; scene.add(ghost); }
}
function isModelId(id) {
  const rt = id >= CUSTOM_BASE ? defRT.get(id) : null;
  return !!(rt && rt.def.kind === 'model');
}
function updateGhost() {
  const id = HOTBAR[selIdx];
  const canShow = started && !menuOpen && !paused && !panelOpen && !isTool(id);
  if (!canShow) { if (ghost) ghost.visible = false; return; }
  if (ghostId !== id) buildGhost(id);
  if (!ghost) return;
  const p = pickTarget();
  if (!p) { ghost.visible = false; return; }
  let valid;
  if (!tiltMode()) {
    const cell = placeCellFrom(p);
    const cur = getBlock(cell[0], cell[1], cell[2]);
    valid = (cur === AIR || cur === WATER) && !overlapsPlayer(cell[0], cell[1], cell[2]);
    if (isModelId(id)) {
      const o = modelOrient(defById(id) || defRT.get(id).def, p);
      const q = modelQuat({ rot: o.rot, qb: o.qb });
      ghost.quaternion.copy(q);
      ghost.position.copy(modelCenterFor(cell, q));
    } else {
      ghost.position.set(cell[0] + 0.5, cell[1] + 0.5, cell[2] + 0.5);
      ghost.quaternion.identity();
    }
  } else {
    const tp = tiltPlacement(p);
    valid = !isSolidAt([Math.floor(tp.c[0]), Math.floor(tp.c[1]), Math.floor(tp.c[2])]);
    const gdef = isModelId(id) ? (defById(id) || defRT.get(id).def) : null;
    const to = tiltOrientFor(gdef, p, tp);
    const off = isModelId(id) ? new THREE.Vector3(0, -0.5, 0).applyQuaternion(to.q) : new THREE.Vector3();
    ghost.position.set(tp.c[0] + off.x, tp.c[1] + off.y, tp.c[2] + off.z);
    ghost.quaternion.copy(to.q);
  }
  ghost.visible = true;
  const rt = id >= CUSTOM_BASE ? defRT.get(id) : null;
  const colHex = !valid ? 0xff5555 : (rt && rt.def.colorable ? new THREE.Color(ext.curColor).getHex() : 0xffffff);
  ghost.traverse(o => { if (o.isMesh && o.material && o.material.color) o.material.color.setHex(colHex); });
}

// ============================================================
// プレビュー用（インポート時の自動表示・サムネイル）
// ============================================================
let prevR = null, prevScene = null, prevCam = null, prevObj = null;
function ensurePrev() {
  if (prevR) return;
  prevR = new THREE.WebGLRenderer({ canvas: document.getElementById('extPrev'), antialias: true, alpha: true });
  prevR.setSize(260, 260, false);
  prevScene = new THREE.Scene();
  prevScene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dl = new THREE.DirectionalLight(0xffffff, 0.8);
  dl.position.set(1, 2, 1.5);
  prevScene.add(dl);
  prevCam = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  prevCam.position.set(1.7, 1.4, 1.9);
  prevCam.lookAt(0, 0.5, 0);
}
let thumbR = null, thumbScene = null, thumbCam = null;
function renderThumb(id) {
  const rt = defRT.get(id);
  if (!rt || !rt.template) return null;
  if (!thumbR) {
    thumbR = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbR.setSize(128, 128, false);
    thumbScene = new THREE.Scene();
    thumbScene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dl = new THREE.DirectionalLight(0xffffff, 0.8);
    dl.position.set(1, 2, 1.5);
    thumbScene.add(dl);
    thumbCam = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    thumbCam.position.set(1.7, 1.4, 1.9);
    thumbCam.lookAt(0, 0.5, 0);
  }
  const o = rt.template.clone(true);
  o.rotation.y = 0.6;
  thumbScene.add(o);
  thumbR.render(thumbScene, thumbCam);
  const url = thumbR.domElement.toDataURL('image/png');
  thumbScene.remove(o);
  thumbCache.set(id, url);
  return url;
}
function thumbOf(def) {
  if (def.kind === 'cube') return def.texData || blankTexUrl();
  if (thumbCache.has(def.id)) return thumbCache.get(def.id);
  return renderThumb(def.id) || '';
}

// ============================================================
// ホットバー表示
// ============================================================
function setSlotVisual(i) {
  const id = HOTBAR[i];
  const el = slotEls[i];
  const sw = el && el.querySelector('.sw');
  if (!sw) return;
  if (!id) {                                  // 空欄のスロット
    sw.style.background = 'transparent';
    sw.style.border = '2px dashed rgba(255,255,255,.45)';
    sw.textContent = '';
    sw.style.display = '';
    return;
  }
  sw.style.border = '';
  if (isTool(id)) {
    sw.style.background = '#2b3a4a';
    sw.textContent = TOOLS[id].icon;
    sw.style.display = 'flex';
    sw.style.alignItems = 'center';
    sw.style.justifyContent = 'center';
    sw.style.fontSize = '18px';
    return;
  }
  sw.textContent = '';
  sw.style.display = '';
  sw.style.alignItems = '';
  sw.style.justifyContent = '';
  sw.style.fontSize = '';
  const def = defById(id);
  if (def) sw.style.background = `url(${thumbOf(def)}) center/cover`;
  else sw.style.background = (BLOCK_INFO[id] && BLOCK_INFO[id].color) || '#888';
}
function refreshHotbarVisuals() {
  for (let i = 0; i < slotEls.length; i++) setSlotVisual(i);
}

// ============================================================
// カテゴリ・インベントリ
// ============================================================
function renderToolsSection() {
  const sec = document.getElementById('extToolsSec');
  if (!sec) return;
  const show = ext.curCat === '全て' || ext.curCat === '道具';
  sec.style.display = show ? 'block' : 'none';
  if (!show) return;
  const tools = [T_WAND, T_DROPPER, T_FILL, T_COPY, T_PASTE, T_PASTE_ROT].map(id => `
    <div class="ext-item">
      <div style="font-size:30px;line-height:72px">${TOOLS[id].icon}</div>
      <div>${TOOLS[id].name}</div>
      <div class="note" style="margin:2px 0">${TOOLS[id].desc}</div>
      <button class="ext-btn" data-tool="${id}">使う</button>
    </div>`).join('');
  const o = ext.pasteOpt;
  const clipTxt = ext.clip ? `${ext.clip.sx}×${ext.clip.sy}×${ext.clip.sz}` : 'なし';
  sec.innerHTML = `
    <h3>道具</h3>
    <div class="ext-grid">${tools}</div>
    <div class="ext-row" style="margin-top:8px">
      <span>スポイトの登録：<b>${esc(nameOf(ext.dropper))}</b></span>
      <button class="ext-btn sub" data-act="dropair">空気を登録</button>
      <button class="ext-btn sub" data-act="undo">元に戻す（Z）</button>
      <span class="note">コピー：${clipTxt}</span>
    </div>
    <div class="ext-row" style="margin-top:6px">
      <span>ペースト設定：</span>
      <button class="ext-btn ${o.rot ? 'on' : 'sub'}" data-act="rot">回転 ${o.rot * 90}°（Y）</button>
      <button class="ext-btn ${o.mx ? 'on' : 'sub'}" data-act="mx">X反転（U）</button>
      <button class="ext-btn ${o.mz ? 'on' : 'sub'}" data-act="mz">Z反転（I）</button>
      <button class="ext-btn ${o.air ? 'on' : 'sub'}" data-act="air">空気も貼る</button>
    </div>`;
}
// 標準ブロック（インベントリから取り出せる。岩盤と水は除く）
const DEFAULT_IDS = [1, 2, 3, 4, 5, 6, 8, 9, 11, 12];
function renderInventory() {
  const catsEl = document.getElementById('extCats');
  const gridEl = document.getElementById('extGrid');
  if (!catsEl || !gridEl) return;

  const all = ['全て', '道具', '標準', ...ext.categories];
  catsEl.innerHTML = all.map(c => {
    let n;
    if (c === '全て') n = ext.defs.length + 5 + DEFAULT_IDS.length;
    else if (c === '標準') n = DEFAULT_IDS.length;
    else if (c === '道具') n = 5;
    else n = ext.defs.filter(d => d.category === c).length;
    return `<div class="ext-cat ${c === ext.curCat ? 'sel' : ''}" data-c="${esc(c)}"><span>${esc(c)}</span><span>${n}</span></div>`;
  }).join('') +
  `<div class="ext-row" style="margin-top:6px">
     <button class="ext-btn sub" data-act="addcat">＋ カテゴリ</button>
   </div>` +
  (ext.curCat !== '全て' && ext.curCat !== '道具' && ext.curCat !== '標準' && ext.curCat !== '未分類'
    ? `<div class="ext-row" style="margin-top:4px">
         <button class="ext-btn sub" data-act="rencat">名前変更</button>
         <button class="ext-btn danger" data-act="delcat">削除</button>
       </div>` : '');

  renderToolsSection();

  const items = ext.defs.filter(d => ext.curCat === '全て' || d.category === ext.curCat);
  const customHtml = items.map(d => {
    const rt = defRT.get(d.id);
    const thumb = thumbOf(d);
    const opts = ext.categories.map(c => `<option value="${esc(c)}" ${c === d.category ? 'selected' : ''}>${esc(c)}</option>`).join('');
    const info = d.kind === 'cube' ? 'フルブロック' : `モデル・${ORIENT_NAMES[d.orient || 'fixed']}`;
    return `<div class="ext-item">
      <img src="${thumb}" alt="">
      <div>${esc(d.name)}${rt && !rt.ready ? '（読込中）' : ''}</div>
      <div style="font-size:11px;color:#9fb3c8">${info}${d.colorable ? '・カラー' : ''}</div>
      <select class="ext-input" data-cat="${d.id}" style="width:100%;margin-top:4px">${opts}</select>
      <div class="ext-row" style="justify-content:center;margin-top:4px;gap:4px">
        <button class="ext-btn" data-use="${d.id}">使う</button>
        <button class="ext-btn danger" data-del="${d.id}">削除</button>
      </div>
    </div>`;
  }).join('');
  const defHtml = (ext.curCat === '全て' || ext.curCat === '標準') ? DEFAULT_IDS.map(id => `<div class="ext-item">
      <div style="height:72px;border-radius:6px;background:${BLOCK_INFO[id].color}"></div>
      <div>${esc(BLOCK_INFO[id].name)}</div>
      <div style="font-size:11px;color:#9fb3c8">標準ブロック</div>
      <div class="ext-row" style="justify-content:center;margin-top:4px">
        <button class="ext-btn" data-use="${id}">使う</button>
      </div>
    </div>`).join('') : '';
  gridEl.innerHTML = (defHtml + customHtml) || (ext.curCat === '道具' ? '' : '<p class="note">このカテゴリにブロックはありません。「＋ 新規ブロック」から作成できます。</p>');
}
function renderInventoryIfOpen() {
  if (panelOpen === 'extInv') renderInventory();
}

function useSlotItem(id) {
  HOTBAR[selIdx] = id;
  setSlotVisual(selIdx);
  selectSlot(selIdx);
}
function useItem(id) {
  if (!defRT.get(id) && !DEFAULT_IDS.includes(id)) return;
  useSlotItem(id);
  toast(`「${BLOCK_INFO[id].name}」をホットバーに入れました`);
  closePanel();
}
function useTool(id) {
  useSlotItem(id);
  toast(`「${TOOLS[id].name}」をホットバーに入れました`);
  closePanel();
}

function deleteDef(id) {
  const def = defById(id);
  if (!def) return;
  if (!confirm(`「${def.name}」を削除しますか？\n配置済みのこのブロックも消えます。`)) return;
  for (const e of chunks.values()) {
    if (!e.data) continue;
    let changed = false;
    for (let i = 0; i < e.data.length; i++) {
      if (e.data[i] === id) { e.data[i] = AIR; changed = true; }
    }
    const ed = editsByChunk.get(e.key);
    if (ed) for (const [i, t] of [...ed]) if (t === id) ed.delete(i);
    if (changed) markDirty(e);
  }
  for (let i = tiltList.length - 1; i >= 0; i--) {
    if (tiltList[i].id === id) removeTilt(tiltList[i]);
  }
  ext.defs = ext.defs.filter(d => d.id !== id);
  defRT.delete(id);
  delete BLOCK_INFO[id];
  for (let i = 0; i < HOTBAR.length; i++) {
    if (HOTBAR[i] === id) HOTBAR[i] = GRASS;
  }
  if (ext.dropper === id) ext.dropper = AIR_ID;
  saveExt();
  renderInventory();
  refreshHotbarVisuals();
  selectSlot(selIdx);
  toast('削除しました');
}

// ============================================================
// カラーパネル
// ============================================================
const PALETTE = ['#ffffff', '#d9d9d9', '#8c8c8c', '#333333', '#000000', '#e74c3c', '#e67e22', '#f1c40f',
  '#2ecc71', '#1abc9c', '#3498db', '#2c3e8f', '#9b59b6', '#e84393', '#8d5524', '#c8a46b'];
function setCurColor(c) {
  ext.curColor = c;
  const p = document.getElementById('extPicker');
  if (p) p.value = c;
  renderColor();
}
function renderColor() {
  const pal = document.getElementById('extPalette');
  const his = document.getElementById('extHistory');
  if (!pal || !his) return;
  pal.innerHTML = PALETTE.map(c => `<span class="ext-sw" data-col="${c}" style="background:${c}"></span>`).join('');
  his.innerHTML = ext.colorHistory.length
    ? ext.colorHistory.map(c => `<span class="ext-sw" data-col="${c}" style="background:${c}"></span>`).join('')
    : '<span class="note">まだ使用履歴はありません</span>';
  document.getElementById('extCurLabel').textContent = '現在の色：' + ext.curColor;
}
function pushHistory(c) {
  ext.colorHistory = [c, ...ext.colorHistory.filter(x => x !== c)].slice(0, 12);
  saveExt();
}

// ============================================================
// 対象ブロックへの操作（カラー・回転）
// ============================================================
function remeshAt(x, y, z) {
  markDirty(getEntry(Math.floor(x / CS), Math.floor(y / CS), Math.floor(z / CS)));
}
function targetCustom() {
  const h = origRaycast(7);
  if (!h || h.b < CUSTOM_BASE) return null;
  const rt = defRT.get(h.b);
  return rt ? { h, rt } : null;
}
function recolorTarget() {
  const t = targetCustom();
  if (!t) return;
  if (!t.rt.def.colorable) { toast('このブロックはカラーブロックではありません'); return; }
  const k = keyOf(t.h.x, t.h.y, t.h.z);
  const prev = blockState.get(k) || {};
  blockState.set(k, { ...prev, color: ext.curColor, rot: prev.rot || 0 });
  pushHistory(ext.curColor);
  remeshAt(t.h.x, t.h.y, t.h.z);
}
function resetTarget() {
  const t = targetCustom();
  if (!t) return;
  if (!t.rt.def.colorable) { toast('このブロックはカラーブロックではありません'); return; }
  const k = keyOf(t.h.x, t.h.y, t.h.z);
  const prev = blockState.get(k) || {};
  blockState.set(k, { ...prev, color: null, rot: prev.rot || 0 });
  remeshAt(t.h.x, t.h.y, t.h.z);
  toast('色をリセットしました');
}
function rotateTarget() {
  ext.rot = (ext.rot + 1) % 4;
  const t = targetCustom();
  if (t && t.rt.def.kind === 'model') {
    const k = keyOf(t.h.x, t.h.y, t.h.z);
    const prev = blockState.get(k) || { color: null, rot: 0 };
    blockState.set(k, { ...prev, rot: ((prev.rot || 0) + 1) % 4 });
    remeshAt(t.h.x, t.h.y, t.h.z);
  }
}

// ============================================================
// パネルの開閉
// ============================================================
function openPanel(name) {
  if (settingsEl.classList.contains('show')) return;
  if (panelOpen) document.getElementById(panelOpen).classList.remove('show');
  panelOpen = name;
  document.getElementById(name).classList.add('show');
  menuOpen = true;
  releaseActions();
  for (const k in keys) keys[k] = false;
  dashKey = null;
  if (document.pointerLockElement) document.exitPointerLock();
  if (name === 'extInv') renderInventory();
  if (name === 'extColor') renderColor();
  ext.invOpen = name === 'extInv';
}
function closePanel() {
  if (!panelOpen) return;
  document.getElementById(panelOpen).classList.remove('show');
  panelOpen = null;
  ext.invOpen = false;
  menuOpen = false;
  if (!isTouch && started) {
    const p = canvas.requestPointerLock && canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => {});
  }
}
function toggleInventory() {
  if (panelOpen === 'extInv') closePanel();
  else openPanel('extInv');
}

// ============================================================
// スキンエディタ（自由色のペイント方式）
// ============================================================
const SK = {
  cv: null, cx: null, n: 16, drawing: false, tool: 'pen', brush: 1,
  h: 0, s: 1, v: 0, a: 1,
  undo: [], recent: [], last: null,
  svCv: null, svCx: null, hueCv: null, hueCx: null, svDrag: false, hueDrag: false
};

function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  let r, g, b;
  const hh = ((h % 360) + 360) % 360;
  if (hh < 60) [r, g, b] = [c, x, 0];
  else if (hh < 120) [r, g, b] = [x, c, 0];
  else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c];
  else if (hh < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  const s = mx ? d / mx : 0;
  return [h, s, mx];
}
function skinRgba() {
  const [r, g, b] = hsvToRgb(SK.h, SK.s, SK.v);
  return [r, g, b, Math.round(SK.a * 255)];
}
function skinCss() {
  const [r, g, b, a] = skinRgba();
  return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
}
function skinHex() {
  const [r, g, b] = skinRgba();
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}
function setColorFromRgba(r, g, b, a) {
  [SK.h, SK.s, SK.v] = rgbToHsv(r, g, b);
  SK.a = a / 255;
}
function drawPickers() {
  const W = 200, H = 140;
  const img = SK.svCx.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = hsvToRgb(SK.h, x / (W - 1), 1 - y / (H - 1));
    const i = (y * W + x) * 4;
    img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
  }
  SK.svCx.putImageData(img, 0, 0);
  const hImg = SK.hueCx.createImageData(200, 16);
  for (let x = 0; x < 200; x++) {
    const [r, g, b] = hsvToRgb(x / 199 * 360, 1, 1);
    for (let y = 0; y < 16; y++) {
      const i = (y * 200 + x) * 4;
      hImg.data[i] = r; hImg.data[i + 1] = g; hImg.data[i + 2] = b; hImg.data[i + 3] = 255;
    }
  }
  SK.hueCx.putImageData(hImg, 0, 0);
  const sm = document.getElementById('extSVm');
  sm.style.left = (SK.s * 200) + 'px';
  sm.style.top = ((1 - SK.v) * 140) + 'px';
  document.getElementById('extHm').style.left = (SK.h / 360 * 200) + 'px';
  document.getElementById('extSwatch').style.background = skinCss();
  const hexEl = document.getElementById('extHex');
  if (document.activeElement !== hexEl) hexEl.value = skinHex();
  document.getElementById('extAlpha').value = Math.round(SK.a * 255);
  renderRecent();
}
function renderRecent() {
  const el = document.getElementById('extRecent');
  el.innerHTML = SK.recent.length
    ? SK.recent.map((c, i) => `<span class="ext-sw" data-ri="${i}" style="background:rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})"></span>`).join('')
    : '<span class="note">まだありません</span>';
}
function pushRecent() {
  const c = skinRgba();
  SK.recent = [c, ...SK.recent.filter(x => !(x[0] === c[0] && x[1] === c[1] && x[2] === c[2] && x[3] === c[3]))].slice(0, 12);
}

function skinPushUndo() {
  SK.undo.push(SK.cx.getImageData(0, 0, SK.n, SK.n));
  if (SK.undo.length > 30) SK.undo.shift();
}
function skinUndo() {
  const img = SK.undo.pop();
  if (img) SK.cx.putImageData(img, 0, 0);
}
function skinPixel(e) {
  const r = SK.cv.getBoundingClientRect();
  return [Math.floor((e.clientX - r.left) / r.width * SK.n), Math.floor((e.clientY - r.top) / r.height * SK.n)];
}
function paintAt(x, y, erase) {
  const b = SK.brush, o = -Math.floor(b / 2);
  if (erase) SK.cx.clearRect(x + o, y + o, b, b);
  else { SK.cx.fillStyle = skinCss(); SK.cx.fillRect(x + o, y + o, b, b); }
}
function strokeTo(x0, y0, x1, y1, erase) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let s = 0; s <= steps; s++) {
    paintAt(Math.round(x0 + (x1 - x0) * s / steps), Math.round(y0 + (y1 - y0) * s / steps), erase);
  }
}
function floodFill(x0, y0) {
  const n = SK.n;
  const img = SK.cx.getImageData(0, 0, n, n);
  const d = img.data;
  const idx = (x, y) => (y * n + x) * 4;
  const i0 = idx(x0, y0);
  const tr = d[i0], tg = d[i0 + 1], tb = d[i0 + 2], ta = d[i0 + 3];
  const [fr, fg, fb, fa] = skinRgba();
  if (tr === fr && tg === fg && tb === fb && ta === fa) return;
  const stack = [[x0, y0]];
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= n || y >= n) continue;
    const i = idx(x, y);
    if (d[i] !== tr || d[i + 1] !== tg || d[i + 2] !== tb || d[i + 3] !== ta) continue;
    d[i] = fr; d[i + 1] = fg; d[i + 2] = fb; d[i + 3] = fa;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  SK.cx.putImageData(img, 0, 0);
}
function skinApplyTool(x, y) {
  if (x < 0 || y < 0 || x >= SK.n || y >= SK.n) return;
  if (SK.tool === 'pick') {
    const d = SK.cx.getImageData(x, y, 1, 1).data;
    if (d[3] > 0) setColorFromRgba(d[0], d[1], d[2], d[3]);
    else SK.a = 0;
    drawPickers();
  } else if (SK.tool === 'fill') {
    floodFill(x, y);
  }
}
function skinResize(n) {
  const tmp = document.createElement('canvas');
  tmp.width = SK.cv.width; tmp.height = SK.cv.height;
  tmp.getContext('2d').drawImage(SK.cv, 0, 0);
  SK.cv.width = SK.cv.height = n;
  SK.cx.imageSmoothingEnabled = false;
  SK.cx.clearRect(0, 0, n, n);
  SK.cx.drawImage(tmp, 0, 0, n, n);
  SK.n = n;
  SK.undo = [];
}
function openSkinEditor() {
  document.getElementById('extSkin').classList.add('show');
  const n = Number(document.getElementById('extSkinSize').value);
  SK.n = n;
  SK.cv.width = SK.cv.height = n;
  SK.cx.clearRect(0, 0, n, n);
  SK.undo = [];
  drawPickers();
  if (draft && draft.texData) {
    const img = new Image();
    img.onload = () => {
      SK.cx.imageSmoothingEnabled = false;
      SK.cx.clearRect(0, 0, n, n);
      SK.cx.drawImage(img, 0, 0, n, n);
    };
    img.src = draft.texData;
  }
}
function closeSkinEditor() {
  document.getElementById('extSkin').classList.remove('show');
}

// ============================================================
// 新規ブロック作成（インポート）
// ============================================================
let draft = null;
function glowOf(v) { return Math.min(5, Math.max(0.2, Number(v) || 1.5)); }
function syncGlowUI() {
  const w = document.getElementById('extGlowWrap');
  if (w) w.style.display = (draft && draft.look === 'glow') ? 'inline-block' : 'none';
}
function newDraft() {
  return {
    kind: 'cube', name: '', category: ext.categories[0] || '未分類', colorable: false,
    look: 'cut', glow: 1.5,
    texData: null, model: null, modelTex: null, template: null,
    orient: 'fixed',
    scaleMode: 'auto', customScale: 1, resolvedScale: null, modelRot: 0,
    sounds: { break: { type: 'none' }, place: { type: 'none' } }
  };
}
function scaleOverrideOf(d) {
  if (d.scaleMode === 'native') return 1;
  if (d.scaleMode === 'pixel') return 1 / 16;
  if (d.scaleMode === 'custom') return d.customScale > 0 ? d.customScale : 1;
  return null;
}
function openImport() {
  draft = newDraft();
  if (ext.curCat !== '全て' && ext.curCat !== '道具' && ext.categories.includes(ext.curCat)) draft.category = ext.curCat;
  fillImportForm();
  openPanel('extImport');
}
function fillImportForm() {
  const d = draft;
  document.querySelector(`input[name="extKind"][value="${d.kind}"]`).checked = true;
  document.getElementById('extName').value = d.name;
  document.getElementById('extImpCat').innerHTML = ext.categories.map(c =>
    `<option value="${esc(c)}" ${c === d.category ? 'selected' : ''}>${esc(c)}</option>`).join('');
  document.getElementById('extColorable').checked = d.colorable;
  document.getElementById('extLook').value = d.look || 'cut';
  document.getElementById('extGlow').value = String(glowOf(d.glow));
  syncGlowUI();
  document.getElementById('extCubeSec').style.display = d.kind === 'cube' ? 'flex' : 'none';
  document.getElementById('extModelSec').style.display = d.kind === 'model' ? 'block' : 'none';
  document.getElementById('extCubePrev').src = d.texData || blankTexUrl();
  document.getElementById('extBreakPreset').value = d.sounds.break.type === 'preset' ? d.sounds.break.key : 'none';
  document.getElementById('extPlacePreset').value = d.sounds.place.type === 'preset' ? d.sounds.place.key : 'none';
  document.getElementById('extOrient').value = d.orient;
  document.getElementById('extModelRot').value = String(d.modelRot || 0);
  document.getElementById('extScaleMode').value = d.scaleMode;
  document.getElementById('extScaleVal').value = d.customScale;
  document.getElementById('extScaleVal').style.display = d.scaleMode === 'custom' ? 'inline-block' : 'none';
  document.getElementById('extModelStatus').textContent = d.model
    ? 'プレビュー表示中（自動で回転します）'
    : 'モデルを選ぶとプレビューが自動で表示されます。';
  ensurePrev();
  draft.template = null;
}
async function rebuildDraftTemplate() {
  if (!draft.model) return;
  document.getElementById('extModelStatus').textContent = '読み込み中…';
  try {
    const r = await loadModelObject(draft.model.format, draft.model.data, draft.modelTex, scaleOverrideOf(draft), draft.modelRot || 0, draft.model);
    draft.template = r.root;
    draft.resolvedScale = r.scale;
    document.getElementById('extModelStatus').textContent =
      `プレビュー表示中（スケール ×${+r.scale.toFixed(4)}・${draft.scaleMode === 'auto' ? '自動' : '指定'}）`;
  } catch (err) {
    console.error(err);
    draft.template = null;
    document.getElementById('extModelStatus').textContent = '読み込みに失敗しました。形式やファイルを確認してください。';
  }
}
async function saveDraft() {
  const name = (document.getElementById('extName').value.trim()) || ('カスタムブロック' + (ext.defs.length + 1));
  draft.name = name;
  draft.category = document.getElementById('extImpCat').value;
  draft.colorable = document.getElementById('extColorable').checked;
  if (draft.kind === 'model' && !draft.model) { toast('モデルファイルを選んでください'); return; }
  if (draft.kind === 'cube' && !draft.texData) draft.texData = blankTexUrl();
  if (draft.kind === 'model' && draft.resolvedScale == null) await rebuildDraftTemplate();
  const id = nextId();
  if (id < 0) { toast('登録できるカスタムブロックの上限に達しました'); return; }
  const def = {
    id, name: draft.name, kind: draft.kind, category: draft.category, colorable: draft.colorable,
    texData: draft.kind === 'cube' ? draft.texData : draft.modelTex,
    model: draft.kind === 'model' ? {
      format: draft.model.format, data: draft.model.data,
      ...(draft.model.mtl !== undefined ? { mtl: draft.model.mtl, images: draft.model.images || {} } : {})
    } : null,
    orient: draft.kind === 'model' ? draft.orient : undefined,
    modelRot: draft.kind === 'model' ? (draft.modelRot || 0) : undefined,
    scale: draft.kind === 'model' ? (draft.resolvedScale ?? 1) : undefined,
    sounds: draft.sounds,
    alpha: draft.look || 'cut',
    glowPower: draft.look === 'glow' ? glowOf(draft.glow) : undefined
  };
  ext.defs.push(def);
  if (!saveExt()) { ext.defs.pop(); return; }
  await registerDef(def);
  if (window.VoxelFx && VoxelFx.apply) VoxelFx.apply(def);
  closeImport();
  renderInventory();
  toast(`「${name}」を登録しました`);
}
function closeImport() {
  draft = null;
  closePanel();
}

// ============================================================
// 画面の切り替えボタン（グリッド・傾き・斜め角度を、設定を開かずに変える）
// ============================================================
const QUICK_KEY = 'voxelcraft_quickbar_v1';
function quickOn() { try { return localStorage.getItem(QUICK_KEY) === '1'; } catch (e) { return false; } }
function setQuickOn(v) {
  try { localStorage.setItem(QUICK_KEY, v ? '1' : '0'); } catch (e) {}
  const el = document.getElementById('extQuick');
  if (el) el.style.display = v ? 'flex' : 'none';
}
function diagAngleNow() { return window.VoxelDiag && VoxelDiag.angle ? VoxelDiag.angle() : 0; }
function syncQuickBar() {
  const g = document.getElementById('qkGrid'), t = document.getElementById('qkTilt'), d = document.getElementById('qkDeg');
  if (!g) return;
  if (document.activeElement !== g) g.value = String(ext.grid);
  if (document.activeElement !== t) t.value = String(ext.tilt);
  if (document.activeElement !== d) {
    const a = String(diagAngleNow());
    if (!Array.from(d.options || []).some(o => o.value === a)) { const o = document.createElement('option'); o.value = a; o.textContent = a + '°'; d.appendChild(o); }
    d.value = a;
  }
}
function buildQuickBar() {
  const bar = document.createElement('div');
  bar.id = 'extQuick';
  bar.innerHTML = `
    <select id="qkGrid" title="グリッド">
      <option value="1">格子 1.0</option><option value="0.5">格子 0.5</option>
      <option value="0.25">格子 0.25</option><option value="0">フリー</option>
    </select>
    <select id="qkTilt" title="傾き">
      <option value="0">傾き 0°</option><option value="15">15°</option><option value="30">30°</option>
      <option value="45">45°</option><option value="60">60°</option><option value="90">90°</option>
    </select>
    <select id="qkDeg" title="斜めの角度（格子を傾ける）">
      <option value="0">斜め 0°</option><option value="15">15°</option><option value="30">30°</option><option value="45">45°</option>
    </select>`;
  const st = document.createElement('style');
  st.textContent = `#extQuick{position:fixed;left:8px;top:96px;z-index:6;display:none;gap:4px;align-items:center;
    background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.35);border-radius:8px;padding:4px;touch-action:manipulation}
    #extQuick select{background:#14202e;color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:6px;font-size:12px;padding:3px 2px;max-width:92px}`;
  document.head.appendChild(st);
  document.body.appendChild(bar);
  const g = bar.querySelector('#qkGrid'), t = bar.querySelector('#qkTilt'), d = bar.querySelector('#qkDeg');
  for (const el of [g, t, d]) {
    el.addEventListener('keydown', e => e.stopPropagation());
    el.addEventListener('pointerdown', e => e.stopPropagation());
    el.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
  }
  g.addEventListener('change', () => { ext.grid = Number(g.value); saveExt(); syncQuickBar(); });
  t.addEventListener('change', () => { ext.tilt = Number(t.value); saveExt(); syncQuickBar(); });
  d.addEventListener('change', () => { if (window.VoxelDiag && VoxelDiag.setAngle) VoxelDiag.setAngle(d.value); syncQuickBar(); });
  setInterval(syncQuickBar, 500);
  setQuickOn(quickOn());
  syncQuickBar();
}

// ============================================================
// 設定パネル（ターボ・配置）
// ============================================================
function hookSettings() {
  const sbox = document.querySelector('#settings .sbox');
  const closeBtn = document.getElementById('settingsClose');
  const sec = document.createElement('div');
  sec.innerHTML = `
    <h3>ターボ・カスタムブロック</h3>
    <label class="chk"><input type="checkbox" id="extTurbo"> ターボモード（FPSを優先）</label>
    <p class="note">ONにするとシェーダーOFF・描画距離は最大4・草花を省略し、描画解像度を下げます。</p>
    <div class="ext-row" style="margin-top:6px">
      <button class="ext-btn" id="extOpenInv">インベントリを開く</button>
      <button class="ext-btn sub" id="extOpenNew">新規ブロック作成</button>
    </div>
    <h3>配置（傾き・グリッド）</h3>
    <label style="display:block;margin-top:6px">傾きの角度
      <select class="ext-input" id="extTiltSel" style="margin-left:6px">
        <option value="0">0°（水平・垂直）</option>
        <option value="15">15°</option><option value="30">30°</option>
        <option value="45">45°</option><option value="60">60°</option><option value="90">90°</option>
      </select>
    </label>
    <label style="display:block;margin-top:6px">グリッド
      <select class="ext-input" id="extSnapSel" style="margin-left:6px">
        <option value="1">1.0</option><option value="0.5">0.5</option>
        <option value="0.25">0.25</option><option value="0">フリー（グリッド無し）</option>
      </select>
    </label>
    <p class="note">グリッド1.0かつ角度0°のときは通常のブロック（当たり判定あり）を置きます。それ以外は傾き・フリー配置で、見た目だけのブロックになります（当たり判定はありません）。</p>
    <label class="chk" style="margin-top:8px"><input type="checkbox" id="extQuickTog"> 切り替えボタンを画面に表示（設定を開かずに、グリッド・傾き・斜めを変えられます）</label>`;
  sbox.insertBefore(sec, closeBtn);
  buildQuickBar();
  document.getElementById('extTurbo').addEventListener('change', e => setTurbo(e.target.checked));
  const tsel = document.getElementById('extTiltSel');
  const ssel = document.getElementById('extSnapSel');
  tsel.value = String(ext.tilt);
  ssel.value = String(ext.grid);
  tsel.addEventListener('change', () => { ext.tilt = Number(tsel.value); saveExt(); syncQuickBar(); });
  ssel.addEventListener('change', () => { ext.grid = Number(ssel.value); saveExt(); syncQuickBar(); });
  const qtog = document.getElementById('extQuickTog');
  qtog.checked = quickOn();
  qtog.addEventListener('change', () => setQuickOn(qtog.checked));
  document.getElementById('extOpenInv').addEventListener('click', e => {
    e.stopPropagation();
    settingsEl.classList.remove('show');
    menuOpen = false;
    openPanel('extInv');
  });
  document.getElementById('extOpenNew').addEventListener('click', e => {
    e.stopPropagation();
    settingsEl.classList.remove('show');
    menuOpen = false;
    openImport();
  });
}

// ============================================================
// CSS・DOM
// ============================================================
function injectCSS() {
  const css = `
  #extBtn{position:fixed;right:10px;top:48px;z-index:6;background:rgba(0,0,0,.45);color:#fff;
    border:1px solid rgba(255,255,255,.4);border-radius:6px;padding:7px 11px;font-size:13px;cursor:pointer}
  .ext-panel{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:40}
  .ext-panel.show{display:flex}
  .ext-box{background:#1b2530;color:#fff;border-radius:10px;padding:16px;width:min(94vw,780px);max-height:92vh;
    overflow:auto;box-sizing:border-box;font-size:14px;box-shadow:0 6px 24px rgba(0,0,0,.5)}
  .ext-box h2{margin:0 0 10px;font-size:18px}
  .ext-box h3{margin:14px 0 6px;font-size:14px;color:#cfe3f5}
  .ext-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .ext-btn{background:#2e4a66;color:#fff;border:none;border-radius:6px;padding:7px 12px;cursor:pointer;font-size:13px}
  .ext-btn.sub{background:#3a3f48} .ext-btn.danger{background:#7a3030} .ext-btn.on{background:#4a7a3a}
  .ext-input{background:#2a3846;color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:4px;padding:5px 7px;font-size:13px}
  .ext-cats{width:170px;display:flex;flex-direction:column;gap:4px}
  .ext-cat{padding:6px 8px;border-radius:5px;background:rgba(255,255,255,.06);cursor:pointer;display:flex;justify-content:space-between}
  .ext-cat.sel{background:#2e4a66}
  .ext-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px}
  .ext-item{background:rgba(255,255,255,.06);border-radius:8px;padding:6px;text-align:center;font-size:12px}
  .ext-item img{width:72px;height:72px;image-rendering:pixelated;background:rgba(0,0,0,.2);border-radius:6px}
  .ext-sw{width:24px;height:24px;border-radius:4px;border:2px solid rgba(255,255,255,.4);cursor:pointer;display:inline-block}
  .ext-canvas-box{background:#111;border-radius:8px;display:inline-block}
  .ext-box .note{font-size:12px;color:#9fb3c8;line-height:1.6;margin:6px 0}
  #extToast{position:fixed;left:50%;top:14%;transform:translateX(-50%);background:rgba(0,0,0,.75);color:#fff;
    padding:8px 14px;border-radius:8px;z-index:60;opacity:0;transition:opacity .3s;pointer-events:none;font-size:13px}
  #extToast.show{opacity:1}
  #extSkinCv{width:320px;height:320px;image-rendering:pixelated;touch-action:none;cursor:crosshair;
    background:repeating-conic-gradient(#555 0 25%,#777 0 50%) 0 / 20px 20px;border-radius:4px}
  .ext-pick-wrap{position:relative;width:200px}
  #extSV,#extHue{display:block;width:200px;touch-action:none;cursor:crosshair;border-radius:4px}
  #extHue{height:16px;margin-top:0}
  .ext-marker{position:absolute;width:12px;height:12px;border:2px solid #fff;border-radius:50%;
    transform:translate(-50%,-50%);pointer-events:none;box-shadow:0 0 0 1px #000}
  .ext-hmark{position:absolute;top:-2px;width:4px;height:20px;background:#fff;transform:translateX(-50%);
    pointer-events:none;box-shadow:0 0 0 1px #000}
  .ext-swatch{width:34px;height:34px;border-radius:6px;border:2px solid #fff;display:inline-block;
    background:#000;background-image:repeating-conic-gradient(#555 0 25%,#777 0 50%);background-size:12px 12px}
  #extSVm{position:absolute;pointer-events:none}
  body.touch #extBtn{top:48px}
  `;
  const st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);
}

function buildDOM() {
  const btn = document.createElement('button');
  btn.id = 'extBtn';
  btn.textContent = '🎒 インベントリ';
  document.body.appendChild(btn);
  btn.addEventListener('click', e => { e.stopPropagation(); toggleInventory(); });

  toastEl = document.createElement('div');
  toastEl.id = 'extToast';
  document.body.appendChild(toastEl);

  const wrap = document.createElement('div');
  wrap.innerHTML = `
  <div class="ext-panel" id="extInv"><div class="ext-box">
    <h2>インベントリ</h2>
    <div class="ext-row" style="align-items:flex-start">
      <div class="ext-cats" id="extCats"></div>
      <div style="flex:1;min-width:300px">
        <div class="ext-row" style="margin-bottom:8px">
          <button class="ext-btn" id="extNew">＋ 新規ブロック</button>
          <button class="ext-btn sub" id="extColorOpen">🎨 カラー</button>
        </div>
        <div id="extToolsSec"></div>
        <h3>ブロック</h3>
        <p class="note">「使う」で、ホットバーの選択中のスロットに入ります。</p>
        <div class="ext-grid" id="extGrid"></div>
      </div>
    </div>
    <div class="ext-row" style="margin-top:12px"><button class="ext-btn sub" id="extInvClose">閉じる</button></div>
  </div></div>

  <div class="ext-panel" id="extColor"><div class="ext-box" style="width:min(94vw,520px)">
    <h2>カラー</h2>
    <p class="note">カラーブロックに使う色を選びます。配置時にこの色が付き、「C」キーで照準先のブロックを変更できます。</p>
    <div class="ext-row" id="extPalette"></div>
    <div class="ext-row" style="margin-top:10px">
      <input type="color" id="extPicker" value="#ffffff">
      <span id="extCurLabel" class="note"></span>
    </div>
    <h3>使用履歴</h3>
    <div class="ext-row" id="extHistory"></div>
    <div class="ext-row" style="margin-top:12px"><button class="ext-btn sub" id="extColorClose">閉じる</button></div>
  </div></div>

  <div class="ext-panel" id="extImport"><div class="ext-box" style="width:min(94vw,660px)">
    <h2>カスタムブロックを作成</h2>
    <div class="ext-row">
      <label><input type="radio" name="extKind" value="cube" checked> フルブロック（スキンを描く）</label>
      <label><input type="radio" name="extKind" value="model"> モデル（OBJ / FBX / JSON）</label>
    </div>
    <div class="ext-row" style="margin-top:10px">
      <input class="ext-input" id="extName" placeholder="ブロック名" style="flex:1;min-width:160px">
      <select class="ext-input" id="extImpCat"></select>
      <label><input type="checkbox" id="extColorable"> カラーブロック</label>
      <label>見え方
        <select class="ext-input" id="extLook">
          <option value="cut">くり抜き（標準）</option>
          <option value="blend">半透過（半透明の部分が透ける）</option>
          <option value="glow">発光（光って周りを照らす）</option>
        </select>
      </label>
      <label id="extGlowWrap" style="display:none">明るさ
        <input class="ext-input" id="extGlow" type="number" min="0.2" max="5" step="0.1" value="1.5" style="width:70px">
      </label>
    </div>
    <div id="extCubeSec" class="ext-row" style="margin-top:10px">
      <button class="ext-btn" id="extSkinOpen">スキンを描く・編集</button>
      <button class="ext-btn sub" id="extPngOpen">PNGを読み込む</button>
      <input type="file" id="extPngFile" accept="image/png,image/jpeg" style="display:none">
      <img id="extCubePrev" style="width:72px;height:72px;image-rendering:pixelated;background:rgba(0,0,0,.2);border-radius:6px">
    </div>
    <div id="extModelSec" style="display:none;margin-top:10px">
      <div class="ext-row">
        <label>モデル <input type="file" id="extModelFile" multiple accept=".obj,.fbx,.json,.bbmodel,.mtl,image/png,image/jpeg,image/gif,image/webp,image/bmp"></label>
        <label>テクスチャ <input type="file" id="extModelTex" accept="image/png,image/jpeg"></label>
      </div>
      <div class="ext-row" style="margin-top:8px">
        <label>配置方式
          <select class="ext-input" id="extOrient">
            <option value="fixed">向き固定（ノーマル）</option>
            <option value="four">4方向（かまど風）</option>
            <option value="free">自由（原木・ボタン風）</option>
          </select>
        </label>
      </div>
      <div class="ext-row" style="margin-top:8px">
        <label>モデルの回転（Blockbenchで反転したときの補正）
          <select class="ext-input" id="extModelRot">
            <option value="0">0°（補正なし）</option>
            <option value="90">90°</option>
            <option value="180">180°</option>
            <option value="270">270°</option>
          </select>
        </label>
      </div>
      <div class="ext-row" style="margin-top:8px">
        <label>スケール
          <select class="ext-input" id="extScaleMode">
            <option value="auto">自動（大きすぎる場合は÷16）</option>
            <option value="native">そのまま（1単位＝1ブロック）</option>
            <option value="pixel">Blockbenchのピクセル単位（÷16）</option>
            <option value="custom">任意の倍率</option>
          </select>
        </label>
        <input class="ext-input" id="extScaleVal" type="number" step="0.01" min="0.001" style="width:90px;display:none">
      </div>
      <div class="ext-canvas-box" style="margin-top:8px"><canvas id="extPrev" width="260" height="260"></canvas></div>
      <p class="note" id="extModelStatus">モデルを選ぶとプレビューが自動で表示されます。</p>
      <p class="note">向き固定：常に上向き。4方向：設置したときに正面（-Z）が自分の方を向きます。自由：クリックした面に沿って立ちます（壁・天井・床）。Tキーで90度ずつ回転できます。</p>
    </div>
    <h3>効果音</h3>
    <div class="ext-row">
      <label>破壊音 <select class="ext-input" id="extBreakPreset"></select></label>
      <input type="file" id="extBreakFile" accept="audio/*">
    </div>
    <div class="ext-row" style="margin-top:6px">
      <label>設置音 <select class="ext-input" id="extPlacePreset"></select></label>
      <input type="file" id="extPlaceFile" accept="audio/*">
    </div>
    <p class="note">効果音はプリセットか、音声ファイル（WAV・MP3・OGGなど、ブラウザ対応の形式）を選べます。</p>
    <div class="ext-row" style="margin-top:12px">
      <button class="ext-btn" id="extSave">保存して登録</button>
      <button class="ext-btn sub" id="extImpClose">キャンセル</button>
    </div>
  </div></div>

  <div class="ext-panel" id="extSkin" style="z-index:50"><div class="ext-box" style="width:min(94vw,640px)">
    <h2>ブロックスキン編集（ペイント）</h2>
    <div class="ext-row">
      <button class="ext-btn" data-tool="pen">✏️ ペン</button>
      <button class="ext-btn sub" data-tool="eraser">消しゴム</button>
      <button class="ext-btn sub" data-tool="fill">塗りつぶし</button>
      <button class="ext-btn sub" data-tool="pick">スポイト</button>
      <label>太さ <select class="ext-input" id="extSkinBrush">
        <option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option>
      </select></label>
      <label>サイズ <select class="ext-input" id="extSkinSize">
        <option value="16">16×16</option><option value="32">32×32</option>
      </select></label>
    </div>
    <div class="ext-row" style="margin-top:10px;align-items:flex-start">
      <div><canvas id="extSkinCv"></canvas></div>
      <div style="flex:1;min-width:230px">
        <div class="ext-pick-wrap"><canvas id="extSV" width="200" height="140"></canvas><div id="extSVm" class="ext-marker"></div></div>
        <div class="ext-pick-wrap" style="margin-top:6px"><canvas id="extHue" width="200" height="16"></canvas><div id="extHm" class="ext-hmark"></div></div>
        <div class="ext-row" style="margin-top:8px"><span style="width:52px">透明度</span>
          <input type="range" id="extAlpha" min="0" max="255" style="flex:1"></div>
        <div class="ext-row" style="margin-top:6px">
          <span id="extSwatch" class="ext-swatch"></span>
          <input class="ext-input" id="extHex" style="width:110px" maxlength="7">
          <span class="note">HEX</span>
        </div>
        <h3>最近使った色</h3>
        <div class="ext-row" id="extRecent"></div>
      </div>
    </div>
    <div class="ext-row" style="margin-top:10px">
      <button class="ext-btn sub" id="extSkinUndo">元に戻す</button>
      <button class="ext-btn sub" id="extSkinClear">全消し</button>
    </div>
    <div class="ext-row" style="margin-top:12px">
      <button class="ext-btn" id="extSkinSave">このスキンを使う</button>
      <button class="ext-btn sub" id="extSkinCancel">キャンセル</button>
    </div>
  </div></div>`;
  while (wrap.firstChild) document.body.appendChild(wrap.firstChild);

  const opts = Object.keys(PRESET_NAMES).map(k => `<option value="${k}">${PRESET_NAMES[k]}</option>`).join('');
  document.getElementById('extBreakPreset').innerHTML = opts;
  document.getElementById('extPlacePreset').innerHTML = opts;

  SK.cv = document.getElementById('extSkinCv');
  SK.cx = SK.cv.getContext('2d', { willReadFrequently: true });
  SK.cv.width = SK.cv.height = 16;
  SK.svCv = document.getElementById('extSV');
  SK.svCx = SK.svCv.getContext('2d');
  SK.hueCv = document.getElementById('extHue');
  SK.hueCx = SK.hueCv.getContext('2d');
}

// ============================================================
// イベント配線
// ============================================================
function wire() {
  document.getElementById('extNew').addEventListener('click', openImport);
  document.getElementById('extColorOpen').addEventListener('click', () => openPanel('extColor'));
  document.getElementById('extInvClose').addEventListener('click', closePanel);
  document.getElementById('extColorClose').addEventListener('click', closePanel);
  document.getElementById('extPicker').addEventListener('input', e => setCurColor(e.target.value));
  document.getElementById('extPalette').addEventListener('click', e => {
    const c = e.target.dataset.col; if (c) setCurColor(c);
  });
  document.getElementById('extHistory').addEventListener('click', e => {
    const c = e.target.dataset.col; if (c) setCurColor(c);
  });

  document.getElementById('extCats').addEventListener('click', e => {
    const catEl = e.target.closest('.ext-cat');
    const act = e.target.dataset.act;
    if (catEl && !act) { ext.curCat = catEl.dataset.c; renderInventory(); return; }
    if (act === 'addcat') {
      const name = prompt('新しいカテゴリ名');
      if (name && name.trim() && !ext.categories.includes(name.trim())) {
        ext.categories.push(name.trim());
        saveExt();
        renderInventory();
      }
    } else if (act === 'rencat') {
      const name = prompt('新しいカテゴリ名', ext.curCat);
      if (name && name.trim() && name.trim() !== ext.curCat) {
        const old = ext.curCat, nn = name.trim();
        ext.categories = ext.categories.map(c => c === old ? nn : c);
        ext.defs.forEach(d => { if (d.category === old) d.category = nn; });
        ext.curCat = nn;
        saveExt();
        renderInventory();
      }
    } else if (act === 'delcat') {
      const old = ext.curCat;
      if (!confirm(`カテゴリ「${old}」を削除しますか？\n中のブロックは「未分類」に移動します。`)) return;
      if (!ext.categories.includes('未分類')) ext.categories.push('未分類');
      ext.categories = ext.categories.filter(c => c !== old);
      ext.defs.forEach(d => { if (d.category === old) d.category = '未分類'; });
      ext.curCat = '全て';
      saveExt();
      renderInventory();
    }
  });

  document.getElementById('extToolsSec').addEventListener('click', e => {
    const t = e.target.dataset.tool;
    const act = e.target.dataset.act;
    if (t) return useTool(Number(t));
    const o = ext.pasteOpt;
    if (act === 'dropair') { ext.dropper = AIR_ID; toast('スポイトに空気を登録しました'); }
    else if (act === 'undo') undoLast();
    else if (act === 'rot') { o.rot = (o.rot + 1) % 4; pasteDirty = true; }
    else if (act === 'mx') { o.mx = !o.mx; pasteDirty = true; }
    else if (act === 'mz') { o.mz = !o.mz; pasteDirty = true; }
    else if (act === 'air') { o.air = !o.air; pasteDirty = true; }
    renderInventory();
  });

  document.getElementById('extGrid').addEventListener('click', e => {
    const use = e.target.dataset.use, del = e.target.dataset.del;
    if (use) useItem(Number(use));
    if (del) deleteDef(Number(del));
  });
  document.getElementById('extGrid').addEventListener('change', e => {
    const id = e.target.dataset.cat;
    if (!id) return;
    const def = defById(Number(id));
    if (def) { def.category = e.target.value; saveExt(); renderInventory(); }
  });

  // インポート
  document.querySelectorAll('input[name="extKind"]').forEach(r => r.addEventListener('change', () => {
    draft.kind = document.querySelector('input[name="extKind"]:checked').value;
    fillImportForm();
  }));
  document.getElementById('extName').addEventListener('input', e => { draft.name = e.target.value; });
  document.getElementById('extImpCat').addEventListener('change', e => { draft.category = e.target.value; });
  document.getElementById('extColorable').addEventListener('change', e => { draft.colorable = e.target.checked; });
  document.getElementById('extLook').addEventListener('change', e => { draft.look = e.target.value; syncGlowUI(); });
  document.getElementById('extGlow').addEventListener('change', e => { draft.glow = glowOf(e.target.value); e.target.value = String(draft.glow); });
  document.getElementById('extOrient').addEventListener('change', e => { draft.orient = e.target.value; });
  document.getElementById('extModelRot').addEventListener('change', async e => {
    draft.modelRot = Number(e.target.value) || 0;
    if (draft.model) await rebuildDraftTemplate();
  });
  document.getElementById('extScaleMode').addEventListener('change', async e => {
    draft.scaleMode = e.target.value;
    document.getElementById('extScaleVal').style.display = draft.scaleMode === 'custom' ? 'inline-block' : 'none';
    if (draft.model) await rebuildDraftTemplate();
  });
  document.getElementById('extScaleVal').addEventListener('change', async e => {
    draft.customScale = Number(e.target.value) || 1;
    if (draft.model && draft.scaleMode === 'custom') await rebuildDraftTemplate();
  });
  document.getElementById('extSkinOpen').addEventListener('click', openSkinEditor);
  document.getElementById('extPngOpen').addEventListener('click', () => document.getElementById('extPngFile').click());
  document.getElementById('extPngFile').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    draft.texData = await readAs(f, 'dataurl');
    document.getElementById('extCubePrev').src = draft.texData;
  });
  document.getElementById('extModelFile').addEventListener('change', async e => {
    const files = [...e.target.files];
    if (!files.length) return;
    const extOf = f => f.name.split('.').pop().toLowerCase();
    let mainF = null, mtlF = null;
    const imgs = {};
    for (const f of files) {
      const x = extOf(f);
      if (x === 'mtl') mtlF = f;
      else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(x)) imgs[f.name.toLowerCase()] = await readAs(f, 'dataurl');
      else if (['obj', 'fbx', 'json', 'bbmodel'].includes(x) && !mainF) mainF = f;
    }
    if (!mainF) {
      // モデルは前に選んだものを使い、あとから選んだ .mtl・画像をそのモデルに付ける
      if (!draft.model) { document.getElementById('extModelStatus').textContent = '先にモデル（.obj など）を選んでください。'; return; }
      if (mtlF) draft.model.mtl = await readAs(mtlF, 'text');
      draft.model.images = { ...(draft.model.images || {}), ...imgs };
      draft.resolvedScale = null;
      await rebuildDraftTemplate();
      if (draft.model.mtl !== undefined) {
        const mats = parseMtl(draft.model.mtl);
        const used = [...mats.values()].filter(m => m.map).map(m => m.map.split(/[\\/]/).pop().toLowerCase());
        const have = Object.keys(draft.model.images);
        const missing = used.filter(name => !have.includes(name));
        document.getElementById('extModelStatus').textContent += '（マテリアル ' + mats.size + ' 個・画像 ' + have.length + ' 枚' +
          (missing.length ? '／見つからない画像：' + missing.join(', ') : '') + '）';
      }
      return;
    }
    const x = extOf(mainF);
    const format = x === 'obj' ? 'obj' : x === 'fbx' ? 'fbx' : 'json';
    try {
      const data = format === 'fbx' ? await readAs(mainF, 'dataurl') : await readAs(mainF, 'text');
      const mdl = { format, data };
      if (mtlF) { mdl.mtl = await readAs(mtlF, 'text'); mdl.images = imgs; }
      draft.model = mdl;
      draft.resolvedScale = null;
      await rebuildDraftTemplate();
      if (mtlF) {
        const n = parseMtl(mdl.mtl).size;
        const used = [...parseMtl(mdl.mtl).values()].filter(m => m.map).map(m => m.map.split(/[\\/]/).pop().toLowerCase());
        const missing = used.filter(name => !Object.keys(imgs).includes(name));
        document.getElementById('extModelStatus').textContent += '（マテリアル ' + n + ' 個・画像 ' + Object.keys(imgs).length + ' 枚' +
          (missing.length ? '／見つからない画像：' + missing.join(', ') : '') + '）';
      }
    } catch (err) {
      document.getElementById('extModelStatus').textContent = '読み込みに失敗しました。';
    }
  });
  document.getElementById('extModelTex').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    draft.modelTex = await readAs(f, 'dataurl');
    await rebuildDraftTemplate();
  });
  document.getElementById('extBreakPreset').addEventListener('change', e => {
    const v = e.target.value;
    draft.sounds.break = v === 'none' ? { type: 'none' } : { type: 'preset', key: v };
  });
  document.getElementById('extPlacePreset').addEventListener('change', e => {
    const v = e.target.value;
    draft.sounds.place = v === 'none' ? { type: 'none' } : { type: 'preset', key: v };
  });
  document.getElementById('extBreakFile').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    draft.sounds.break = { type: 'file', data: await readAs(f, 'dataurl') };
    toast('破壊音を設定しました');
  });
  document.getElementById('extPlaceFile').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    draft.sounds.place = { type: 'file', data: await readAs(f, 'dataurl') };
    toast('設置音を設定しました');
  });
  document.getElementById('extSave').addEventListener('click', saveDraft);
  document.getElementById('extImpClose').addEventListener('click', closeImport);

  wireSkinEditor();

  window.addEventListener('keydown', e => {
    if (e.code === 'Escape' && panelOpen) {
      if (document.getElementById('extSkin').classList.contains('show')) closeSkinEditor();
      else if (panelOpen === 'extImport') closeImport();
      else closePanel();
    }
  });
}

function wireSkinEditor() {
  document.querySelectorAll('#extSkin [data-tool]').forEach(b => b.addEventListener('click', () => {
    SK.tool = b.dataset.tool;
    document.querySelectorAll('#extSkin [data-tool]').forEach(x => x.classList.toggle('on', x === b));
  }));
  document.querySelector('#extSkin [data-tool="pen"]').classList.add('on');
  document.getElementById('extSkinBrush').addEventListener('change', e => { SK.brush = Number(e.target.value); });
  document.getElementById('extSkinSize').addEventListener('change', e => skinResize(Number(e.target.value)));
  document.getElementById('extSkinUndo').addEventListener('click', skinUndo);
  document.getElementById('extSkinClear').addEventListener('click', () => {
    skinPushUndo(); SK.cx.clearRect(0, 0, SK.n, SK.n);
  });

  SK.cv.addEventListener('pointerdown', e => {
    e.preventDefault();
    SK.cv.setPointerCapture(e.pointerId);
    const [x, y] = skinPixel(e);
    if (SK.tool === 'pen' || SK.tool === 'eraser' || SK.tool === 'fill') skinPushUndo();
    if (SK.tool === 'pen') pushRecent();
    SK.drawing = true;
    SK.last = [x, y];
    if (SK.tool === 'pen') paintAt(x, y, false);
    else if (SK.tool === 'eraser') paintAt(x, y, true);
    else skinApplyTool(x, y);
    if (SK.tool === 'pen' || SK.tool === 'eraser') renderRecent();
  });
  SK.cv.addEventListener('pointermove', e => {
    if (!SK.drawing || SK.tool === 'fill' || SK.tool === 'pick') return;
    const [x, y] = skinPixel(e);
    strokeTo(SK.last[0], SK.last[1], x, y, SK.tool === 'eraser');
    SK.last = [x, y];
  });
  const endDraw = () => { SK.drawing = false; };
  SK.cv.addEventListener('pointerup', endDraw);
  SK.cv.addEventListener('pointercancel', endDraw);

  const svPick = e => {
    const r = SK.svCv.getBoundingClientRect();
    SK.s = clamp((e.clientX - r.left) / r.width, 0, 1);
    SK.v = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
    drawPickers();
  };
  SK.svCv.addEventListener('pointerdown', e => { SK.svDrag = true; SK.svCv.setPointerCapture(e.pointerId); svPick(e); });
  SK.svCv.addEventListener('pointermove', e => { if (SK.svDrag) svPick(e); });
  SK.svCv.addEventListener('pointerup', () => { SK.svDrag = false; });
  SK.svCv.addEventListener('pointercancel', () => { SK.svDrag = false; });

  const huePick = e => {
    const r = SK.hueCv.getBoundingClientRect();
    SK.h = clamp((e.clientX - r.left) / r.width, 0, 1) * 360;
    drawPickers();
  };
  SK.hueCv.addEventListener('pointerdown', e => { SK.hueDrag = true; SK.hueCv.setPointerCapture(e.pointerId); huePick(e); });
  SK.hueCv.addEventListener('pointermove', e => { if (SK.hueDrag) huePick(e); });
  SK.hueCv.addEventListener('pointerup', () => { SK.hueDrag = false; });
  SK.hueCv.addEventListener('pointercancel', () => { SK.hueDrag = false; });

  document.getElementById('extAlpha').addEventListener('input', e => {
    SK.a = Number(e.target.value) / 255;
    drawPickers();
  });
  const hexEl = document.getElementById('extHex');
  hexEl.addEventListener('change', () => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hexEl.value.trim());
    if (!m) { drawPickers(); return; }
    const n = parseInt(m[1], 16);
    setColorFromRgba((n >> 16) & 255, (n >> 8) & 255, n & 255, Math.round(SK.a * 255));
    drawPickers();
  });
  document.getElementById('extRecent').addEventListener('click', e => {
    const i = e.target.dataset.ri;
    if (i === undefined) return;
    const c = SK.recent[Number(i)];
    if (!c) return;
    setColorFromRgba(c[0], c[1], c[2], c[3]);
    drawPickers();
  });

  document.getElementById('extSkinSave').addEventListener('click', () => {
    if (!draft) return;
    draft.texData = SK.cv.toDataURL('image/png');
    document.getElementById('extCubePrev').src = draft.texData;
    closeSkinEditor();
  });
  document.getElementById('extSkinCancel').addEventListener('click', closeSkinEditor);
}

// ============================================================
// キー操作
// ============================================================
window.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.code === 'KeyE') {
    if (settingsEl.classList.contains('show')) return;
    if (panelOpen === 'extImport') return;
    toggleInventory();
    return;
  }
  if (e.code === 'KeyG') {
    if (panelOpen === 'extColor') closePanel(); else if (!panelOpen) openPanel('extColor');
    return;
  }
  if (menuOpen || paused || !started) return;
  if (e.code === 'KeyC') recolorTarget();
  if (e.code === 'KeyR') resetTarget();
  if (e.code === 'KeyT') rotateTarget();
  if (e.code === 'KeyZ') undoLast();
  if (e.code === 'KeyY') { ext.pasteOpt.rot = (ext.pasteOpt.rot + 1) % 4; pasteDirty = true; toast(`ペースト：回転 ${ext.pasteOpt.rot * 90}°`); }
  if (e.code === 'KeyU') { ext.pasteOpt.mx = !ext.pasteOpt.mx; pasteDirty = true; toast(`ペースト：X反転 ${ext.pasteOpt.mx ? 'ON' : 'OFF'}`); }
  if (e.code === 'KeyI') { ext.pasteOpt.mz = !ext.pasteOpt.mz; pasteDirty = true; toast(`ペースト：Z反転 ${ext.pasteOpt.mz ? 'ON' : 'OFF'}`); }
});

// ============================================================
// 毎フレームの処理
// ============================================================
function extLoop() {
  requestAnimationFrame(extLoop);
  updateGhost();
  updateSelVisual(performance.now() / 1000);
  updatePaste();
  if (panelOpen === 'extImport' && draft && draft.template) {
    ensurePrev();
    if (prevObj !== draft.template) {
      if (prevObj) prevScene.remove(prevObj);
      prevObj = draft.template;
      prevScene.add(prevObj);
    }
    prevObj.rotation.y += 0.012;
    prevR.render(prevScene, prevCam);
  }
}

function enforceTurbo() {
  if (ext.turbo && RD > 4) { RD = 4; lastKey = ''; }
}

// ============================================================
// 初期化
// ============================================================
const origRaycast = window.raycastBlock;

function init() {
  injectCSS();
  buildDOM();
  loadExt();
  BLOCK_INFO[T_WAND] = { name: 'ステッキ', color: '#445566' };
  BLOCK_INFO[T_DROPPER] = { name: 'スポイト', color: '#445566' };
  BLOCK_INFO[T_FILL] = { name: 'フィル', color: '#445566' };
  BLOCK_INFO[T_COPY] = { name: 'コピー', color: '#445566' };
  BLOCK_INFO[T_PASTE] = { name: 'ペースト', color: '#445566' };
  BLOCK_INFO[T_PASTE_ROT] = { name: '回転・反転', color: '#445566' };
  hookSettings();
  wire();
  syncTurboUI();
  if (ext.turbo) setTurbo(true);
  window.addEventListener('resize', applyRenderScale);
  setInterval(enforceTurbo, 300);
  hydrateDefs().then(() => {
    for (const def of ext.defs) registerDef(def);
    refreshHotbarVisuals();
    renderInventory();
  }).catch(e => console.error(e));
  requestAnimationFrame(extLoop);
}
init();

// ── 他の機能ファイル（通信・カスタム・斜め配置・見え方）が使う内部の名前を公開する ──
// ext.js は1つの関数の中に閉じているため、外のファイルからは見えない。そこで window.VoxelExt にまとめて渡す。
window.VoxelExt = {
  CUSTOM_BASE, CUSTOM_MAX, ext, defRT, blockState, tiltList,
  keyOf, nextId, saveExt, renderInventory, addTilt, removeTilt, pickTarget, pushHistory, isTool, registerDef, refreshHotbarVisuals, fullExtJson, importExtJson, blobGet, blobPut: blobWriteOp, blobDel: blobDelOp
};

})();
