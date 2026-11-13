/* キーボード操作（voxel-craft-keys.js）を、この場所と同じ場所から読み込む（読み込み忘れを防ぐ） */
(function () {
  const here = document.currentScript && document.currentScript.src ? document.currentScript.src : location.href;
  for (const [flag, file] of [['__vcKeys', 'voxel-craft-keys.js'], ['__vcPhone', 'voxel-craft-phone.js'], ['VoxelEconomy', 'voxel-craft-economy.js'], ['VoxelProfit', 'voxel-craft-profit.js'], ['VoxelRoute', 'voxel-craft-route.js'], ['VoxelEdit', 'voxel-craft-edit.js'], ['VoxelConvert', 'voxel-craft-convert.js'], ['VoxelHelp', 'voxel-craft-help.js']]) {
    if (window[flag] || document.querySelector('script[src*="' + file + '"]')) continue;
    const s = document.createElement('script');
    s.src = new URL(file, here).href;
    document.head.appendChild(s);
  }
})();
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
// ブロックIDは2バイト（ワールドのマスを Uint16 で保存）。カスタムは 100〜65535 を使える
const CUSTOM_BASE = 100, CUSTOM_MAX = 65535;
const T_WAND = 50, T_DROPPER = 51, T_FILL = 52, T_COPY = 53, T_PASTE = 54, T_PASTE_ROT = 55, T_TRAFFIC = 56, T_CROWD = 57, T_SOUND = 58, T_PHONE = 59;
const TOOLS = {
  50: { name: 'ステッキ', icon: '🪄', desc: 'タップで範囲の始点・終点を指定（3回目からは繰り返し）' },
  51: { name: 'スポイト', icon: '🧪', desc: 'ブロックをタップして登録（空気も登録できます）' },
  52: { name: 'フィル', icon: '🪣', desc: '長押しで選択範囲をスポイトのブロックで埋める' },
  53: { name: 'コピー', icon: '⧉', desc: '長押しで選択範囲をコピー' },
  54: { name: 'ペースト', icon: '📌', desc: '長押しでコピーを貼り付け（半透明プレビュー付き）' },
  55: { name: 'ペースト前の回転・反転', icon: '🔄', desc: '持っている間、上の入力欄で回転・反転を設定（ペーストに反映）' },
  56: { name: '自動車交通制御', icon: '🚗', desc: 'ルートを引く・分岐・速度・車の設定（ルートマーカーは持っている間だけ見えます）' },
  57: { name: '人混みマネージャー', icon: '👥', desc: '範囲を選んで人混みを作る（持っている間だけ範囲が見えます）' },
  58: { name: '音声ブロック', icon: '🔊', desc: '地面をタップで置きます。視点を合わせると「設定」が出ます（長押しで削除）' },
  59: { name: 'マイ端末', icon: '📱', desc: '持っている間、「端末を開く」ボタンで端末のメニューを開けます' }
};
const isTool = id => id >= T_WAND && id <= T_PHONE;
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
  colorOff: false,          // カラーの指定を解除中（置くとき色を付けない）
  lightMin: 0,              // 光の届かない所の明るさ（0〜100%。0で真っ暗）
  replaceMode: false,       // 置き換えモード（フィル時、対象だけを別のブロックに置き換える）
  replaceFrom: null,        // 置き換え対象（ブロックID）
  replaceTo: null,          // 置き換えるブロック（ブロックID）
  waterDim: 0,              // 水の暗さ（0〜100）
  waterTint: '#ffffff',     // 水の色味（シェーダー時・通常時の両方）
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
// ブロックの向き・色（カスタムブロックの状態）は、ワールドの保存と一緒に残す（再読み込みで向きが戻らないように）
const BSTATE_KEY = 'voxelcraft_bstate_v1';
let bstateSaved = null;
function loadBstate() {
  try {
    const arr = JSON.parse(localStorage.getItem(BSTATE_KEY) || '[]');
    for (const [k, s] of arr) if (typeof k === 'string' && s) blockState.set(k, s);
  } catch (e) { /* 読めないときは、向きだけ初期値にする */ }
}
function saveBstate() {
  const arr = [];
  for (const [k, s] of blockState) if (s) arr.push([k, { color: s.color ?? null, rot: s.rot ?? 0, qb: s.qb ?? null }]);
  const json = arr.length ? JSON.stringify(arr) : '[]';
  if (json === bstateSaved) return;
  try { localStorage.setItem(BSTATE_KEY, json); bstateSaved = json; }
  catch (e) { if (typeof toast === 'function') toast('ブロックの向きを保存できませんでした（保存領域がいっぱいです）'); }
}
loadBstate();
setInterval(saveBstate, 1500);
// 向き・色を変えたマスを、部屋へも送る（相手の画面でも同じ向きになる）
function touchState(x, y, z) {
  if (window.VoxelMulti && VoxelMulti.touchCell) VoxelMulti.touchCell(x, y, z);
}
// 別機能（斜めグリッドなど）が置き場所を決めるとき、プレビューの位置を受け取る関数
let placeHook = null;
function setPlaceHook(fn) { placeHook = fn; }
window.addEventListener('voxelworld:fresh', () => { blockState.clear(); saveBstate(); });
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
  const used = new Set(ext.defs.map(d => d.id));
  for (let i = CUSTOM_BASE; i <= CUSTOM_MAX; i++) {
    if (!used.has(i)) return i;
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
    if (s.light && typeof s.light.min === 'number') ext.lightMin = clamp(s.light.min, 0, 100);
    if (s.water && typeof s.water === 'object') {
      if (typeof s.water.dim === 'number') ext.waterDim = clamp(s.water.dim, 0, 100);
      if (typeof s.water.tint === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.water.tint)) ext.waterTint = s.water.tint;
    }
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
function contentKey(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return 'h' + s.length.toString(36) + '-' + h1.toString(36) + '-' + h2.toString(36);
}
function lightenDefs(defs) {
  const live = new Set(), pending = [];
  const put = (key, v) => { const pr = writeBlob(key, v); if (pr) pending.push(pr); };
  // 中身から決まるキー（同じ中身なら同じキー）。端末ごとの番号で付けると、別の端末の中身と取り違えるため
  const ref = (_unused, v) => {
    if (isRef(v)) { live.add(v.__blob); return v; }
    if (typeof v !== 'string' || v.length < BIG_TEXT) return v;
    const key = contentKey(v);
    live.add(key); put(key, v);
    return { __blob: key };
  };
  const out = defs.map(d => {
    const o = { ...d };
    if (d.texData !== undefined) o.texData = ref(null, d.texData);
    if (d.model) {
      const m = { ...d.model };
      m.data = ref(null, m.data);
      if (m.mtl !== undefined) m.mtl = ref(null, m.mtl);
      if (isRef(m.images)) { live.add(m.images.__blob); }
      else if (m.images && typeof m.images === 'object' && Object.keys(m.images).length) {
        const s = JSON.stringify(m.images), k = contentKey(s);
        live.add(k);
        put(k, s);
        m.images = { __blob: k, json: true };
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
      tilt: ext.tilt, grid: ext.grid,
      water: { dim: ext.waterDim, tint: ext.waterTint }, light: { min: ext.lightMin }
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
  // 取り出せなかったときは参照のまま残す（空や未定義にして保存し直すと、中身が永久に消えるため）
  let raw;
  try { raw = await blobGet(v.__blob); } catch (e) { return v; }
  if (raw === undefined || raw === null) return v;
  if (v.json) { try { return JSON.parse(raw); } catch (e) { return v; } }
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
    colorHistory: ext.colorHistory, defs, tilt: ext.tilt, grid: ext.grid,
    water: { dim: ext.waterDim, tint: ext.waterTint }, light: { min: ext.lightMin } });
}
// 読み込み用：書き出したファイルの設定を、この端末の形で保存する
async function importExtJson(json) {
  const s = JSON.parse(json);
  const L = lightenDefs(Array.isArray(s.defs) ? s.defs : []);
  await Promise.all(L.pending);
  localStorage.setItem(EXT_KEY, JSON.stringify({
    turbo: !!s.turbo, shaderBefore: typeof s.shaderBefore === 'boolean' ? s.shaderBefore : null,
    categories: s.categories, colorHistory: s.colorHistory, defs: L.defs, tilt: s.tilt, grid: s.grid,
    water: s.water, light: s.light
  }));
  cleanBlobs(L.live);
}
// 起動時：参照になっている中身を IndexedDB から戻す
async function hydrateDefs() {
  // 1つの定義で失敗しても、ほかの定義は必ず戻す（途中で止まると、全部が登録されず見えなくなるため）
  for (const d of ext.defs) {
    try {
      if (isRef(d.texData)) d.texData = await resolveRef(d.texData);
      if (d.model) {
        const m = d.model;
        if (isRef(m.data)) m.data = await resolveRef(m.data);
        if (isRef(m.mtl)) m.mtl = await resolveRef(m.mtl);
        if (isRef(m.images)) m.images = await resolveRef(m.images);
      }
    } catch (e) { console.error('定義の中身を戻せませんでした', e); }
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
function placeModel(raw, scale, place) {
  const outer = new THREE.Group();
  raw.scale.setScalar(scale);
  // Blockbenchの位置のまま：Blockbenchの原点（0,0,0）をブロックの中心（底面）に合わせる。
  // 道路・線路のBlockbench位置モードと同じ扱い（ずらさない）。
  // 以前は角（-0.5,-0.5）へずらしていたため、原点中心に作ったモデルがブロックの端にずれていた
  if (place === 'raw') {
    raw.position.set(0, 0, 0);
    outer.add(raw);
    outer.updateMatrixWorld(true);
    return outer;
  }
  raw.position.set(0, 0, 0);
  outer.add(raw);
  outer.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(outer);
  // Blockbench の制作位置をそのまま使う：1ブロック分の枠（16px、または1単位）の中心をブロックの中心に合わせる。
  // モデルの大きさに関係なく、端に寄せた位置・はみ出した部分も、制作したとおりの場所に出る。
  // 縦方向は底面を床に合わせる（今までどおり）。
  // 水平方向は、モデルの幅の中心をブロックの中心に合わせる（原点がどこにあっても、ずれない）
  const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
  raw.position.set(-cx, -b.min.y, -cz);
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
async function loadModelObject(format, data, texUrl, scaleOverride, rotDeg, mdl, place) {
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
  const root = placeModel(raw, scale, place);
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
    // 絵が読めないとき（参照のまま・読み込み失敗）は、白ではなく空の絵で登録する。
    // 登録しないと、このブロックを使った傾きブロックや線路・道路が消えてしまうため
    const src = typeof def.texData === 'string' && def.texData ? def.texData : null;
    rt.tex = (src && await texFromUrl(src)) || await texFromUrl(blankTexUrl());
    rt.material = new THREE.MeshLambertMaterial({
      map: rt.tex, vertexColors: true, alphaTest: 0.3
    });
  } else if (def.model) {
    try {
      const r = await loadModelObject(def.model.format, def.model.data, typeof def.texData === 'string' ? def.texData : null,
        typeof def.scale === 'number' ? def.scale : null, def.modelRot || 0, def.model, def.place || 'center');
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

// ============================================================
// リアルなモデルのブロックは、1つずつ描かず「チャンクごとに1回でまとめて描く」（インスタンス描画）
// 見た目（形・色・向き・影）は今までと同じ。描く回数が減るので、数が多くても軽くなる
// ============================================================
// 影の形：テクスチャの透けている部分（格子・柵・草など）は、影にも残さない。
// 何も指定しないと、透けている部分まで含めた四角い影になるため（細かいモデルが四角く影を落とす原因）
const shadowMatCache = new WeakMap();
function shadowMatFor(map) {
  let m = shadowMatCache.get(map);
  if (!m) {
    m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: map, alphaTest: 0.5 });
    shadowMatCache.set(map, m);
  }
  return m;
}
// モデルの各部品に、その形の影を割り当てる（テクスチャが無い部品は、そのままの形）
function fitModelShadow(obj) {
  obj.traverse(o => {
    if (!o.isMesh) return;
    const mt = Array.isArray(o.material) ? o.material[0] : o.material;
    o.customDepthMaterial = (mt && mt.map) ? shadowMatFor(mt.map) : undefined;
  });
}
// 向きが変わらない部品の位置（モデルの中での位置・傾き）を、根元からの行列で持つ
function relMatrixTo(obj, root) {
  const chain = [];
  for (let o = obj; o && o !== root; o = o.parent) chain.push(o);
  const m = new THREE.Matrix4();
  for (let i = chain.length - 1; i >= 0; i--) { chain[i].updateMatrix(); m.multiply(chain[i].matrix); }
  return m;
}
// 部品ごとの情報（最初の1回だけ作る）。複数素材の部品があるモデルは、従来どおり1つずつ描く
function modelBatchParts(rt) {
  if (rt.batchParts !== undefined) return rt.batchParts;
  const tpl = rt.template;
  tpl.updateMatrixWorld(true);
  const meshes = [];
  tpl.traverse(o => { if (o.isMesh) meshes.push(o); });
  const ok = meshes.length > 0 && meshes.every(m => !Array.isArray(m.material) && !Array.isArray(m.geometry));
  if (!ok) { rt.batchParts = null; return null; }
  rt.batchParts = meshes.map(m => {
    const mat = m.material.clone();
    const base = m.material.color ? m.material.color.clone() : new THREE.Color(0xffffff);
    mat.color.set(0xffffff);                                  // 色は「インスタンスの色」で決める
    mat.userData.isClone = true;
    return { geo: m.geometry, rel: relMatrixTo(m, tpl), mat, base };
  });
  return rt.batchParts;
}
// 同じ種類のモデルブロックを、チャンク内で部品ごとに1つのまとめ描画にする
function makeModelBatch(id, list) {
  const rt = defRT.get(id);
  if (!rt || !rt.template) return [];
  const parts = modelBatchParts(rt);
  if (!parts) {                                              // 特殊なモデルは従来どおり
    const out = [];
    for (const it of list) { const inst = makeModelInstance(id, it.x, it.y, it.z); if (inst) out.push(inst); }
    return out;
  }
  const n = list.length;
  const ims = parts.map(p => {
    const im = new THREE.InstancedMesh(p.geo, p.mat, n);
    im.frustumCulled = false;                               // 範囲の管理は、チャンクの読み込みで行う
    im.castShadow = shaderOn;
    im.receiveShadow = shaderOn;
    im.customDepthMaterial = p.mat.map ? shadowMatFor(p.mat.map) : undefined;   // 影の形（透けた部分は影にしない）
    im.userData.sharedGeo = true;                           // 形は元のモデルと共有（破棄しない）
    return im;
  });
  const S = rt.template.scale;
  const blockM = new THREE.Matrix4(), tmp = new THREE.Matrix4(), col = new THREE.Color();
  list.forEach((it, i) => {
    const st = blockState.get(keyOf(it.x, it.y, it.z)) || {};
    const q = modelQuat(st);
    const c = modelCenterFor([it.x, it.y, it.z], q);
    blockM.compose(c, q, S);
    const colored = !!(rt.def.colorable && st.color);
    if (colored) col.set(st.color);
    parts.forEach((p, j) => {
      tmp.multiplyMatrices(blockM, p.rel);
      ims[j].setMatrixAt(i, tmp);
      ims[j].setColorAt(i, colored ? col : p.base);
    });
  });
  for (const im of ims) {
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }
  return ims;
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
  fitModelShadow(inst);
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
      if (o.isMesh && o.geometry && !o.userData.sharedGeo) o.geometry.dispose();
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
// 発光の色の濃さを反映した色（濃さ0で灰色、1で元の色、2でより鮮やか）。明るさの減り方は変えない
function glowTintOf(rt) {
  const base = glowColorOf(rt);
  const s = glowDeepOf(rt.def.glowDeep ?? 1);
  const lum = 0.299 * base[0] + 0.587 * base[1] + 0.114 * base[2];
  return base.map(c => clamp(lum + (c - lum) * s, 0, 1.2));
}
// このチャンクと周りの隣（±1チャンク）にある発光ブロック。光は隣のチャンクまで届くので、隣も見る
function isGlowId(id) {
  if (id < CUSTOM_BASE) return false;
  const rt = defRT.get(id);
  return !!(rt && rt.def && rt.def.alpha === 'glow');
}
// 光の届く距離（明るさの数値で変わる。弱いと近くだけ、強いと遠くまで）
function glowRadiusOf(power) { return 3 + 2.2 * power; }
function glowSourcesOf(dd, e) {
  const out = [];
  if (!ext.defs.some(df => df.alpha === 'glow')) return out;
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    let data = dd;
    if (dx || dy || dz) {
      const nb = chunks.get(ckey(e.cx + dx, e.cy + dy, e.cz + dz));
      data = nb && nb.data;
    }
    if (!data) continue;
    for (let li = 0; li < 4096; li++) {
      const t = data[li];
      if (t < CUSTOM_BASE) continue;
      const rt = defRT.get(t);
      if (!rt || !rt.ready || !rt.def || rt.def.alpha !== 'glow') continue;
      const col = glowTintOf(rt);
      const power = rt.def.glowPower || 1.5;
      out.push({
        x: dx * CS + (li & 15) + 0.5, y: dy * CS + ((li >> 4) & 15) + 0.5, z: dz * CS + ((li >> 8) & 15) + 0.5,
        r: col[0], g: col[1], b: col[2], I: power * 0.6, R: glowRadiusOf(power)
      });
    }
  }
  return out;
}
// 発光の光を、面ごとの頂点の色へ足す。
// ・光の強さは距離とともに滑らかに減り、届く距離の外は0（チャンク全体は染まらない）
// ・面が光の方を向いているほど明るい（向いていない面は、わずかな回り込みだけ）
function applyGlowLight(bufs, srcs) {
  if (!srcs.length) return;
  for (const buf of bufs) {
    const p = buf.p, c = buf.c, n = buf.n;
    if (!p.length) continue;
    const hasN = !!n && n.length === p.length;
    for (let v = 0; v < p.length; v += 3) {
      const vx = p[v], vy = p[v + 1], vz = p[v + 2];
      const nx = hasN ? n[v] : 0, ny = hasN ? n[v + 1] : 0, nz = hasN ? n[v + 2] : 0;
      let ar = 0, ag = 0, ab = 0;
      for (let s = 0; s < srcs.length; s++) {
        const sc = srcs[s];
        const dx = sc.x - vx, dy = sc.y - vy, dz = sc.z - vz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= sc.R * sc.R) continue;
        const d = Math.sqrt(d2) || 1e-4;
        const t = 1 - d / sc.R;
        const att = t * t * (3 - 2 * t);                 // なめらかに減る（端で0）
        const lam = hasN ? 0.25 + 0.75 * Math.max(0, (nx * dx + ny * dy + nz * dz) / d) : 1;
        const k = sc.I * att * lam;
        ar += sc.r * k; ag += sc.g * k; ab += sc.b * k;
      }
      if (ar === 0 && ag === 0 && ab === 0) continue;
      c[v] = Math.min(1.6, c[v] + ar);
      c[v + 1] = Math.min(1.6, c[v + 1] + ag);
      c[v + 2] = Math.min(1.6, c[v + 2] + ab);
    }
  }
}
// ── 暗がりの光（本家のように、光の届かない所は暗くなる）──
// 空から届く光（15）が、不透明なブロックを避けて1マスごとに弱まりながら広がる。
// 真下へは減らずに届く（空の光の性質）。チャンクの外側も少しだけ計算して、境目の暗さを防ぐ。
const LIGHT_M = 8;                 // 計算に使うチャンク外側の余白（ブロック数）
const LIGHT_S = CS + LIGHT_M * 2;  // 計算範囲の一辺
const LIGHT_SKY_TOP = 160;         // これより上は空（ブロックは無い）
const colTopCache = new Map();     // "x,z" -> その列で一番上の不透明ブロックの高さ
const lightQ = new Int32Array(LIGHT_S * LIGHT_S * LIGHT_S * 16);
function lightOpaque(t) {
  if (t === AIR || t === WATER || t === LEAVES) return false;
  if (t >= CUSTOM_BASE) {
    const rt = defRT.get(t);
    if (!rt || !rt.def) return true;                  // 読み込み中は、いったん不透明として扱う
    if (rt.def.kind === 'model') return false;
    if (rt.def.alpha === 'cut' || rt.def.alpha === 'blend' || rt.def.alpha === 'glow') return false;
    return true;
  }
  return true;
}
function colTopOf(x, z) {
  const k = x + ',' + z;
  let v = colTopCache.get(k);
  if (v !== undefined) return v;
  v = BOTTOM - 1;
  for (let y = LIGHT_SKY_TOP; y >= BOTTOM; y--) if (lightOpaque(getBlock(x, y, z))) { v = y; break; }
  colTopCache.set(k, v);
  return v;
}
// 光の明るさ（0〜15）を、表示する明るさ（0〜1）へ。「暗がりの最低の明るさ」の設定で、真っ暗にもできる
function lightMultOf(lv) {
  const minL = clamp(ext.lightMin, 0, 100) / 100;
  return minL + (1 - minL) * Math.pow(lv / 15, 1.4);
}
// チャンクの頂点の色に、そこに届く光を掛ける（暗い所は暗く）
function applyDarkness(bufs, ox, oy, oz) {
  const S = LIGHT_S, M = LIGHT_M, n = S * S * S;
  const lv = new Uint8Array(n), opq = new Uint8Array(n), wat = new Uint8Array(n);
  const ix = (x, y, z) => (x + M) + (y + M) * S + (z + M) * S * S;
  let qh = 0, qt = 0;
  for (let z = -M; z < CS + M; z++) for (let x = -M; x < CS + M; x++) {
    const wx = ox + x, wz = oz + z;
    const top = colTopOf(wx, wz);
    for (let y = -M; y < CS + M; y++) {
      const i = ix(x, y, z);
      const bt = getBlock(wx, oy + y, wz);
      if (bt === WATER) wat[i] = 1;
      if (lightOpaque(bt)) { opq[i] = 1; continue; }
      if (oy + y > top) { lv[i] = 15; lightQ[qt++] = i; }
    }
  }
  // 広がり（幅優先）
  while (qh < qt) {
    const i = lightQ[qh++];
    const l = lv[i];
    if (l <= 1) continue;
    const xi = i % S, yi = Math.floor(i / S) % S, zi = Math.floor(i / (S * S));
    const spread = (nx, ny, nz, lvNext) => {
      if (nx < 0 || ny < 0 || nz < 0 || nx >= S || ny >= S || nz >= S) return;
      const j = nx + ny * S + nz * S * S;
      if (opq[j] || lv[j] >= lvNext) return;
      lv[j] = lvNext;
      lightQ[qt++] = j;
    };
    spread(xi + 1, yi, zi, l - 1);
    spread(xi - 1, yi, zi, l - 1);
    spread(xi, yi, zi + 1, l - 1);
    spread(xi, yi, zi - 1, l - 1);
    spread(xi, yi + 1, zi, l - 1);
    spread(xi, yi - 1, zi, l === 15 ? 15 : l - 1);     // 真下への空の光は弱まらない
  }
  for (const buf of bufs) {
    const p = buf.p, c = buf.c, nrm = buf.n;
    const hasN = !!nrm && nrm.length === p.length;
    // 固いブロック（SB）は、光の届き具合（aDark）と、水に触れているか（aWet）を頂点ごとに持つ
    const perVertex = buf.solid === true;
    if (perVertex) { buf.d = new Array(p.length / 3); buf.w = new Array(p.length / 3); }
    for (let v = 0; v < p.length; v += 3) {
      // 面の外側（光が来る側）のマスの明るさを使う。頂点の座標はチャンク内の座標（0〜16）なので、そのまま使う
      const cx = Math.floor(p[v] + (hasN ? nrm[v] * 0.5 : 0));
      const cy = Math.floor(p[v + 1] + (hasN ? nrm[v + 1] * 0.5 : 0));
      const cz = Math.floor(p[v + 2] + (hasN ? nrm[v + 2] * 0.5 : 0));
      const inside = cx >= -M && cx < CS + M && cy >= -M && cy < CS + M && cz >= -M && cz < CS + M;
      const fi = inside ? ix(cx, cy, cz) : -1;
      const m = inside ? lightMultOf(lv[fi]) : 1;
      if (perVertex) {
        buf.d[v / 3] = m;
        buf.w[v / 3] = inside && wat[fi] ? 1 : 0;
      }
      if (m >= 1) continue;
      c[v] *= m; c[v + 1] *= m; c[v + 2] *= m;
    }
  }
}
// ── 固いブロックの見た目（シェーダーON時）──
// ・洞窟の中でも、太陽の光が当たっている所（入口から差す光）は、暗くせずに明るいまま残す。
//   → 画面の「光の差し込み」が、洞窟の入口の光から筋を作れるようになる
// ・水の下にある面（水底など）には、ゆらゆら動く水の模様（コースティクス）を重ねる
// 元の描画は変えず、置き換えが効かなかった場合は今までどおり（安全に戻る）
solidMat.onBeforeCompile = shader => {
  shader.uniforms.uTime = { value: 0 };
  shader.uniforms.uOn = { value: 0 };
  solidMat.userData.uniforms = shader.uniforms;
  shader.vertexShader = shader.vertexShader
    .replace('void main() {', 'attribute float aDark;\nattribute float aWet;\nvarying float vDark;\nvarying float vWet;\nvarying vec3 vWorldPos;\nvoid main() {')
    .replace('#include <project_vertex>', '#include <project_vertex>\n  vDark = aDark;\n  vWet = aWet;\n  vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  shader.fragmentShader = shader.fragmentShader
    .replace('void main() {', 'varying float vDark;\nvarying float vWet;\nvarying vec3 vWorldPos;\nuniform float uTime;\nuniform float uOn;\n' +
      'float caustic(vec2 p, float t) {\n' +
      '  float a = sin(p.x * 2.6 + t * 1.1) * cos(p.y * 2.3 - t * 0.8);\n' +
      '  float b = sin((p.x + p.y) * 3.7 - t * 1.6);\n' +
      '  return pow(clamp(0.5 + 0.25 * (a + b), 0.0, 1.0), 5.0);\n' +
      '}\nvoid main() {')
    .replace('vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
      'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;\n' +
      '  outgoingLight += reflectedLight.directDiffuse * (1.0 - vDark);\n' +
      '  outgoingLight += vWet * uOn * caustic(vWorldPos.xz, uTime) * vec3(0.5, 0.8, 1.0) * 0.45;');
};
// 水の模様を動かす（毎フレーム、時間と、シェーダーのON/OFFだけ更新する）
(function tickSolidLook() {
  const u = solidMat.userData.uniforms;
  if (u) { u.uTime.value = performance.now() / 1000; u.uOn.value = shaderOn ? 1 : 0; }
  requestAnimationFrame(tickSolidLook);
})();

// 光が変わるかもしれないチャンク（余白の範囲に入るチャンク）だけ作り直す
function markLightNeighbors(x, y, z) {
  const cx = Math.floor(x / CS), cy = Math.floor(y / CS), cz = Math.floor(z / CS);
  const lx = x - cx * CS, ly = y - cy * CS, lz = z - cz * CS;
  const rng = l => ({ lo: l < LIGHT_M ? -1 : 0, hi: l >= CS - LIGHT_M ? 1 : 0 });
  const rx = rng(lx), ry = rng(ly), rz = rng(lz);
  for (let dz = rz.lo; dz <= rz.hi; dz++) for (let dy = ry.lo; dy <= ry.hi; dy++) for (let dx = rx.lo; dx <= rx.hi; dx++) {
    markDirtyKey(cx + dx, cy + dy, cz + dz);
  }
}
// 発光ブロックを置いた・消したときは、光が届く範囲のチャンクを作り直す
const origSetBlockForGlow = window.setBlock;
window.setBlock = function (x, y, z, t) {
  const old = getBlock(x, y, z);
  const r = origSetBlockForGlow.apply(this, arguments);
  if (old !== t) {
    colTopCache.delete(x + ',' + z);            // 空からの光の列を、作り直す
    markLightNeighbors(x, y, z);                // 暗がりの光が届く範囲（隣のチャンクまで）を作り直す
  }
  if (isGlowId(t) || isGlowId(old)) {
    const cx = Math.floor(x / CS), cy = Math.floor(y / CS), cz = Math.floor(z / CS);
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      markDirtyKey(cx + dx, cy + dy, cz + dz);
    }
  }
  return r;
};

// ── 水のカラー ──
// 置くとき、いまのカラー（解除中でなければその色）を水に付ける。水はカラーの変更も対応
function colorForNew() { return ext.colorOff ? null : ext.curColor; }
let placingNow = false;
const prevDoPlaceWater = window.doPlace;
window.doPlace = function () {
  placingNow = true;
  try { return prevDoPlaceWater.apply(this, arguments); } finally { placingNow = false; }
};
const origSetBlockForWater = window.setBlock;
window.setBlock = function (x, y, z, t) {
  const old = getBlock(x, y, z);
  const r = origSetBlockForWater.apply(this, arguments);
  const k = keyOf(x, y, z);
  if (t === WATER && placingNow) {
    blockState.set(k, { color: colorForNew(), rot: 0 });
    touchState(x, y, z);
  } else if (old === WATER && t !== WATER && blockState.has(k)) {
    blockState.delete(k);
  }
  return r;
};
// 設定画面に「水の見た目」を追加する（暗さのスライダー・色味・初期値に戻す）
function buildWaterSettings() {
  const close = document.getElementById('settingsClose');
  if (!close || document.getElementById('extWaterSec')) return;
  const sec = document.createElement('div');
  sec.id = 'extWaterSec';
  sec.style.cssText = 'margin:10px 0;padding:8px;border:1px solid #3a4a60;border-radius:8px';
  sec.innerHTML = `
    <div style="font-weight:bold;margin-bottom:6px">水の見た目</div>
    <label>水の暗さ：<span id="extWaterDimV"></span>
      <input type="range" id="extWaterDim" min="0" max="100" step="5" style="width:100%"></label>
    <div style="margin-top:6px">水の色味：
      <input type="color" id="extWaterTint">
      <button class="ext-btn sub" id="extWaterReset" type="button">初期値に戻す</button>
    </div>
    <div style="font-size:11px;color:#9fb3c8;margin-top:4px">夜の水は、暗さの設定とは別に自動で暗くなります。</div>`;
  close.parentNode.insertBefore(sec, close);
  // 明るさ（光の届かない所の明るさ）
  const lsec = document.createElement('div');
  lsec.id = 'extLightSec';
  lsec.style.cssText = 'margin:10px 0;padding:8px;border:1px solid #3a4a60;border-radius:8px';
  lsec.innerHTML = `
    <div style="font-weight:bold;margin-bottom:6px">光の届かない所の明るさ</div>
    <label>明るさ：<span id="extLightMinV"></span>
      <input type="range" id="extLightMin" min="0" max="100" step="5" style="width:100%"></label>
    <div style="font-size:11px;color:#9fb3c8;margin-top:4px">0%で真っ暗（本家の洞窟のように）。上げると、暗い所も少し見えます。</div>`;
  close.parentNode.insertBefore(lsec, close);
  const lightUi = () => {
    document.getElementById('extLightMin').value = ext.lightMin;
    document.getElementById('extLightMinV').textContent = ext.lightMin + '%';
  };
  const lightApply = () => { for (const e of chunks.values()) markDirty(e); saveExt(); };
  lightUi();
  document.getElementById('extLightMin').addEventListener('input', e => {
    document.getElementById('extLightMinV').textContent = e.target.value + '%';
  });
  document.getElementById('extLightMin').addEventListener('change', e => {
    ext.lightMin = +e.target.value;   // 指を離したときだけ、全体を作り直す（動かしている間は軽いまま）
    document.getElementById('extLightMinV').textContent = ext.lightMin + '%';
    lightApply();
  });
  const syncUi = () => {
    document.getElementById('extWaterDim').value = ext.waterDim;
    document.getElementById('extWaterDimV').textContent = ext.waterDim + '%';
    document.getElementById('extWaterTint').value = ext.waterTint;
  };
  syncUi();
  document.getElementById('extWaterDim').addEventListener('input', e => {
    ext.waterDim = +e.target.value;
    document.getElementById('extWaterDimV').textContent = ext.waterDim + '%';
    applyWaterLook(); saveExt();
  });
  document.getElementById('extWaterTint').addEventListener('input', e => {
    ext.waterTint = e.target.value;
    applyWaterLook(); saveExt();
  });
  document.getElementById('extWaterReset').addEventListener('click', () => {
    ext.waterDim = 0; ext.waterTint = '#ffffff';
    syncUi(); applyWaterLook(); saveExt();
  });
}
// 設定画面に「統一の自動反映」を追加する（部屋で最後に行われた作業を、統一せずに自動で反映する）
// ============================================================
// 視野（画角）と、画面のボタンの非表示（設定）
// ============================================================
const VIEW_KEY = 'voxelcraft_view_v1';
function viewPref() {
  try { return Object.assign({ fov: 75, hideUi: false }, JSON.parse(localStorage.getItem(VIEW_KEY) || '{}')); }
  catch (e) { return { fov: 75, hideUi: false }; }
}
function applyViewPref() {
  const v = viewPref();
  try { if (typeof camera !== 'undefined' && camera) { camera.fov = Number(v.fov) || 75; camera.updateProjectionMatrix(); } } catch (e) {}
  document.body.classList.toggle('vc-hide-ui', !!v.hideUi);
}
function setViewPref(patch) {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(Object.assign(viewPref(), patch))); } catch (e) {}
  applyViewPref();
}
(function addHideUiCss() {
  const st = document.createElement('style');
  // 設定の画面を開いているときは、ボタンを隠さない（設定を操作できるように）
  st.textContent =
    'body.vc-hide-ui:not(:has(#settings.show)) #info,' +
    'body.vc-hide-ui:not(:has(#settings.show)) #hotWrap,' +
    'body.vc-hide-ui:not(:has(#settings.show)) #touchUI,' +
    'body.vc-hide-ui:not(:has(#settings.show)) #reticle,' +
    'body.vc-hide-ui:not(:has(#settings.show)) #extQuick,' +
    'body.vc-hide-ui:not(:has(#settings.show)) #rtChat,' +
    'body.vc-hide-ui:not(:has(#settings.show)) #rtLoc,' +
    'body.vc-hide-ui:not(:has(#settings.show)) #rtTags,' +
    'body.vc-hide-ui:not(:has(#settings.show)) .tb,' +
    'body.vc-hide-ui:not(:has(#settings.show)) button:not(#gearBtn):not(#overlay *):not(#settings *):not(.ext-panel *):not(#rtPreview *)' +
    '{ display: none !important; }';
  document.head.appendChild(st);
})();
function buildViewSettings() {
  const close = document.getElementById('settingsClose');
  if (!close || document.getElementById('viewSec')) return;
  const v = viewPref();
  const sec = document.createElement('div');
  sec.id = 'viewSec';
  sec.style.cssText = 'margin:10px 0;padding:8px;border:1px solid #3a4a60;border-radius:8px';
  sec.innerHTML = `
    <div style="font-weight:bold;margin-bottom:6px">視野・画面</div>
    <label style="display:block;margin:4px 0">視野（画角）：<span id="viewFovVal">${v.fov}</span>°
      <input type="range" id="viewFov" min="30" max="110" step="1" value="${v.fov}" style="width:100%"></label>
    <div style="font-size:11px;opacity:.75;margin-bottom:6px">大きいほど広く見えます（標準は75°）。</div>
    <label style="display:flex;gap:8px;align-items:center;margin:6px 0">
      <input type="checkbox" id="viewHideUi" ${v.hideUi ? 'checked' : ''}>
      <span><b>画面上の全てのボタンを非表示</b><br><span style="font-size:11px;opacity:.75">設定ボタン以外を隠します（写真撮影用）。解除は、この設定でオフにしてください。</span></span>
    </label>`;
  close.parentNode.insertBefore(sec, close);
  const fov = document.getElementById('viewFov');
  fov.addEventListener('input', () => { document.getElementById('viewFovVal').textContent = fov.value; setViewPref({ fov: Number(fov.value) }); });
  document.getElementById('viewHideUi').addEventListener('change', e => setViewPref({ hideUi: e.target.checked }));
}

function buildAutoSyncSetting() {
  const close = document.getElementById('settingsClose');
  if (!close || document.getElementById('extAutoSec')) return;
  const sec = document.createElement('div');
  sec.id = 'extAutoSec';
  sec.style.cssText = 'margin:10px 0;padding:8px;border:1px solid #3a4a60;border-radius:8px';
  const on = () => (window.VoxelRTUnify && VoxelRTUnify.autoSyncOn) ? VoxelRTUnify.autoSyncOn()
    : localStorage.getItem('vcpref_autosync') === '1';
  sec.innerHTML = `
    <label style="display:flex;gap:8px;align-items:flex-start">
      <input type="checkbox" id="extAutoSync" ${on() ? 'checked' : ''} style="margin-top:3px">
      <span><b>統一の自動反映</b><br>部屋に入ったとき、ほかの人が最後に行った作業を、統一せずに自動で反映します。</span>
    </label>
    <div style="font-size:11px;color:#f0c27b;margin-top:4px">オンのときは、この端末だけの作業は、部屋の内容に置き換わります。</div>`;
  close.parentNode.insertBefore(sec, close);
  document.getElementById('extAutoSync').addEventListener('change', e => {
    const v = e.target.checked;
    if (window.VoxelRTUnify && VoxelRTUnify.setAutoSync) VoxelRTUnify.setAutoSync(v);
    else try { localStorage.setItem('vcpref_autosync', v ? '1' : '0'); } catch (err) {}
  });
}
// 水の見た目（暗さ・色味）を、シェーダー用と通常用の両方に反映する
function applyWaterLook() {
  const dim = clamp(ext.waterDim, 0, 100) / 100;
  if (typeof waterShaderMat !== 'undefined') {
    waterShaderMat.uniforms.waterDim.value = dim;
    waterShaderMat.uniforms.waterTint.value.set(ext.waterTint);
  }
  if (typeof waterMat !== 'undefined') {
    waterMat.color.set(ext.waterTint).multiplyScalar(1 - dim * 0.8);
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

  // 簡易な影（頂点AO）の判定。細かいモデルのブロックは「透ける」扱いにして、
  // 全ブロックと同じ四角い影が付かないようにする（フルブロックのカスタムは今までどおり不透明）
  const opqAO = t => {
    if (t === AIR || t === WATER) return 0;
    if (t >= CUSTOM_BASE) {
      const rt = defRT.get(t);
      if (rt && rt.def && rt.def.kind === 'model') return 0;
    }
    return 1;
  };
  const computeAOExt = (pi, f) => {
    const nd = FACES[f];
    const k = nd.axis, A = (k + 1) % 3, B = (k + 2) % 3;
    const base = pi + nd.off;
    const out = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const c = nd.corners[i];
      const sA = c[A] ? 1 : -1, sB = c[B] ? 1 : -1;
      const s1 = opqAO(P[base + sA * STRIDE[A]]);
      const s2 = opqAO(P[base + sB * STRIDE[B]]);
      const cc = opqAO(P[base + sA * STRIDE[A] + sB * STRIDE[B]]);
      const lvl = (s1 && s2) ? 0 : 3 - (s1 + s2 + cc);
      out[i] = AO_BRIGHT[lvl];
    }
    return out;
  };

  const SB = { p: [], n: [], uv: [], c: [], i: [], solid: true };
  const WB = { p: [], n: [], uv: [], c: [], i: [] };
  const PB = { p: [], n: [], uv: [], c: [], i: [] };
  const CB = new Map();
  const MB = new Map();                  // モデルのブロック（ID ごとに、まとめて描く）
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
        let lst = MB.get(t);
        if (!lst) { lst = []; MB.set(t, lst); }
        lst.push({ x: wx, y: wy, z: wz });
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
        emitCubeFace(buf, x, y, z, f, computeAOExt(pi, f), tint);
      }
      continue;
    }

    for (let f = 0; f < 6; f++) {
      const nt = P[pi + FACES[f].off];
      if (t === WATER) {
        if (nt !== AIR) continue;
        emitQuad(WB, x, y, z, f, tileIndex(t, f), [1, 1, 1, 1]);
        // 水のカラー指定（色があれば、この面の4頂点に色を付ける）
        const wst = blockState.get(keyOf(wx, wy, wz));
        if (wst && wst.color) {
          const tc = hexToRgb(wst.color);
          const base = WB.c.length - 12;
          for (let i = 0; i < 4; i++) { WB.c[base + i * 3] = tc[0]; WB.c[base + i * 3 + 1] = tc[1]; WB.c[base + i * 3 + 2] = tc[2]; }
        }
      } else {
        if (nt !== AIR && nt !== WATER && nt < CUSTOM_BASE) continue;
        emitQuad(SB, x, y, z, f, tileIndex(t, f), computeAOExt(pi, f));
      }
    }
  }

  for (const [id, list] of MB) {
    for (const o of makeModelBatch(id, list)) { scene.add(o); extra.push(o); }
  }
  applyDarkness([SB, WB, PB, ...CB.values()], ox, oy, oz);      // 光の届かない所は暗く（発光は後から足す）
  applyGlowLight([SB, WB, PB, ...CB.values()], glowSourcesOf(d, e));
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

// 傾いたブロックに当てたときは、そのブロックの角度と格子に吸着して置く（どの角度でも・設定に関係なく）
function snapToTilt(p, n) {
  const T = p.ent.q.clone();
  const ref = new THREE.Vector3(p.ent.c[0], p.ent.c[1], p.ent.c[2]);
  const c = p.point.clone().addScaledVector(n, 0.5);
  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].map(a => a.applyQuaternion(T));
  const alignN = axes.map(a => Math.abs(a.dot(n)));
  if (Math.max(...alignN) > 0.9) {       // 面がきれいな向き（箱の面）のときだけ、格子に揃える
    const d = c.clone().sub(ref);
    const out = new THREE.Vector3();
    axes.forEach((a, i) => {
      const s = d.dot(a);
      out.addScaledVector(a, alignN[i] > 0.5 ? s : Math.round(s));   // 面に垂直な向きは高さをそのまま、横は1マス単位
    });
    c.copy(out.add(ref));
  }
  return { c: [c.x, c.y, c.z], q: T, snapped: true };
}
function tiltPlacement(p) {
  const n = p.normal.clone().normalize();
  if (p.kind === 'tilt' && p.ent) return snapToTilt(p, n);
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
  if (tp.snapped) {
    // 吸着したとき：相手の角度を土台に、モデルは配置方式の正面の向きを足す
    if (def && def.kind === 'model') {
      const o = modelOrient(def, p);
      return { q: tp.q.clone().multiply(modelQuat({ rot: o.rot, qb: null })), rot: o.rot };
    }
    return { q: tp.q.clone(), rot: ext.rot };
  }
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
      fitModelShadow(o);
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

  if (!tiltMode() && p.kind !== 'tilt') {
    const cell = placeCellFrom(p);
    const cur = getBlock(cell[0], cell[1], cell[2]);
    if (cur !== AIR && cur !== WATER) return;
    if (overlapsPlayer(cell[0], cell[1], cell[2])) return;
    setBlock(cell[0], cell[1], cell[2], id);
    if (isModel) {
      const o = modelOrient(rt.def, p);
      blockState.set(keyOf(cell[0], cell[1], cell[2]), { color: rt.def.colorable ? colorForNew() : null, rot: o.rot, qb: o.qb });
    } else if (rt) {
      blockState.set(keyOf(cell[0], cell[1], cell[2]), { color: rt.def.colorable ? colorForNew() : null, rot: ext.rot });
    }
    if (rt && rt.def.colorable) pushHistory(ext.curColor);
    playPlace(id);
    return;
  }

  // 傾き・フリー配置（見た目のみ）
  const tp = tiltPlacement(p);
  const cc = tp.c;
  const to = tiltOrientFor(rt && rt.def, p, tp);
  const stState = rt ? { color: rt.def.colorable ? colorForNew() : null, rot: to.rot } : null;
  const cell = [Math.floor(cc[0]), Math.floor(cc[1]), Math.floor(cc[2])];
  if (ext.grid === 1 && isSolidAt(cell)) return;      // 細かい格子（0.5など）は壁を無視する
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

// スポイト：タップでブロックを登録。長押しで空気を登録（モバイルでも、インベントリを開かずに空気を登録できる）
const DROP_LONG_MS = 450;
let dropHold = null;                 // { kind, timer, long }
window.startAct = function (kind) {
  const id = HOTBAR[selIdx];
  if (isTool(id)) {
    if (acts[kind]) return;
    acts[kind] = 'tool';
    if (kind === 'break' && id === T_DROPPER) {
      // 押した時点では何もしない。離したときに「タップ」か「長押し」かを決める
      dropHold = { kind, long: false, timer: setTimeout(() => {
        if (dropHold) dropHold.long = true;
        ext.dropper = AIR_ID;
        toast('スポイトに空気を登録しました（長押し）');
        renderInventoryIfOpen();
      }, DROP_LONG_MS) };
    } else if (kind === 'break' && (id === T_FILL || id === T_COPY || id === T_PASTE)) {
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
  if (acts[kind] === 'tool') {
    acts[kind] = null;
    if (dropHold && dropHold.kind === kind) {
      clearTimeout(dropHold.timer);
      const long = dropHold.long;
      dropHold = null;
      if (!long) dropperTap();
    }
    return;
  }
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
const redoStack = [];
function pushUndo(changes) {
  if (!changes.length) return;
  undoStack.push(changes);
  if (undoStack.length > 10) undoStack.shift();
  redoStack.length = 0;                       // 新しい操作をしたら、やり直しの履歴は消える
}
// 記録の通りに戻す。戻す直前の状態を、同じ形の記録にして返す（取り消しとやり直しで、互いに使える）
function applyRecord(ch) {
  const snap = [];
  for (let i = ch.length - 1; i >= 0; i--) {
    const c = ch[i];
    if (c.tiltEnt) {
      const e = c.tiltEnt;
      snap.push({ tiltRedo: { id: e.id, c: e.c.slice(), q: e.q.clone(), st: e.st } });
      if (window.VoxelDiag && VoxelDiag.dropTilt) VoxelDiag.dropTilt(e);
      continue;
    }
    if (c.tiltRedo) {
      const r = c.tiltRedo;
      if (addTilt(r.id, r.c, r.q, r.st)) snap.push({ tiltEnt: tiltList[tiltList.length - 1] });
      continue;
    }
    snap.push({ x: c.x, y: c.y, z: c.z, k: c.k, oldId: getBlock(c.x, c.y, c.z), oldSt: blockState.get(c.k) || null });
    setBlock(c.x, c.y, c.z, c.oldId);
    if (c.oldSt) blockState.set(c.k, c.oldSt);
    else blockState.delete(c.k);
  }
  return snap.reverse();
}
function undoLast() {
  const ch = undoStack.pop();
  if (!ch) { toast('元に戻す操作がありません'); return; }
  redoStack.push(applyRecord(ch));
  toast('元に戻しました');
}
function redoLast() {
  const ch = redoStack.pop();
  if (!ch) { toast('やり直す操作がありません'); return; }
  undoStack.push(applyRecord(ch));
  toast('やり直しました');
}

function fillSel() {
  const b = selBounds();
  if (!b || wand.stage !== 2) { toast('先にステッキで範囲を選択してください'); return; }
  if (b.sx * b.sy * b.sz > MAX_VOLUME) { toast('範囲が大きすぎます'); return; }
  // 置き換えモードのときは、「置き換え対象」だけを「置き換えるブロック」に変える
  const repl = ext.replaceMode && ext.replaceFrom != null && ext.replaceTo != null;
  const id = repl ? ext.replaceTo : ext.dropper;
  const from = repl ? ext.replaceFrom : null;
  const changes = [];
  for (let y = b.min[1]; y <= b.max[1]; y++) for (let z = b.min[2]; z <= b.max[2]; z++) for (let x = b.min[0]; x <= b.max[0]; x++) {
    const oldId = getBlock(x, y, z);
    if (repl ? (oldId !== from || oldId === id) : (oldId === id)) continue;
    const k = keyOf(x, y, z);
    const oldSt = blockState.get(k) || null;
    changes.push({ x, y, z, k, oldId, oldSt });
    setBlock(x, y, z, id);
    blockState.delete(k);
  }
  pushUndo(changes);
  if (repl) toast(`「${repLabel(from)}」を「${repLabel(id)}」に ${changes.length} 個置き換えました`);
  else toast(`「${nameOf(id)}」で ${changes.length} 個埋めました`);
}

// ── 置き換え（フィル時に、対象のブロックだけを別のブロックに変える）──
function repLabel(id) {
  if (id === AIR_ID) return '空気';
  const d = ext.defs.find(x => x.id === id);
  if (d) return d.name || ('カスタム ' + id);
  return nameOf(id);
}
// 置き換えの選択に出す一覧：空気・標準ブロック（水を含む）・カスタムブロック
function replaceItems() {
  const std = [AIR_ID, ...DEFAULT_IDS];
  const custom = ext.defs.map(d => d.id);
  return [...std, ...custom];
}
function openReplacePicker() {
  let stage = 'from';
  const ov = document.createElement('div');
  ov.id = 'extRepOv';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:20;display:flex;align-items:center;justify-content:center;padding:12px';
  const box = document.createElement('div');
  box.style.cssText = 'background:#1b2430;color:#fff;border-radius:12px;padding:12px;width:460px;max-width:100%;max-height:86vh;overflow:auto';
  ov.appendChild(box);
  document.body.appendChild(ov);
  const items = replaceItems();
  const draw = () => {
    const title = stage === 'from' ? '① 置き換え対象（この種類を、置き換えます）' : '② 置き換えるブロック（これに変えます）';
    box.innerHTML = `
      <div style="font-weight:bold;margin-bottom:8px">${title}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:6px">
        ${items.map(id => `<button class="ext-btn sub" data-id="${id}" type="button">${esc(repLabel(id))}</button>`).join('')}
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end">
        <button class="ext-btn sub" data-x="close" type="button">閉じる</button>
      </div>`;
  };
  draw();
  box.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.x === 'close') { ov.remove(); updateReplaceBar(); return; }
    const id = Number(b.dataset.id);
    if (stage === 'from') { ext.replaceFrom = id; stage = 'to'; draw(); return; }
    ext.replaceTo = id;
    ext.replaceMode = true;
    ov.remove();
    updateReplaceBar();
    toast(`「${repLabel(ext.replaceFrom)}」→「${repLabel(id)}」を置き換えモードにしました`);
  });
}
function buildReplaceBar() {
  if (document.getElementById('extReplaceBar')) return;
  const bar = document.createElement('div');
  bar.id = 'extReplaceBar';
  bar.style.cssText = 'position:fixed;left:12px;top:352px;z-index:6;display:none;flex-direction:column;gap:6px';
  bar.innerHTML = `
    <button class="ext-btn" id="extRepMode" type="button"></button>
    <button class="ext-btn sub" id="extRepSet" type="button"></button>`;
  document.body.appendChild(bar);
  document.getElementById('extRepMode').addEventListener('click', () => {
    if (!ext.replaceMode && (ext.replaceFrom == null || ext.replaceTo == null)) { openReplacePicker(); return; }
    ext.replaceMode = !ext.replaceMode;
    updateReplaceBar();
  });
  document.getElementById('extRepSet').addEventListener('click', () => openReplacePicker());
  updateReplaceBar();
  // フィルを持っているときだけ表示する
  setInterval(() => {
    const show = typeof HOTBAR !== 'undefined' && HOTBAR[selIdx] === T_FILL;
    bar.style.display = show ? 'flex' : 'none';
  }, 250);
}
function updateReplaceBar() {
  const m = document.getElementById('extRepMode');
  const s = document.getElementById('extRepSet');
  if (!m || !s) return;
  m.textContent = '置き換えモード：' + (ext.replaceMode ? 'ON' : 'OFF');
  m.style.background = ext.replaceMode ? '#2f7d4f' : '';
  s.textContent = (ext.replaceFrom == null || ext.replaceTo == null)
    ? '置き換えを設定'
    : `${repLabel(ext.replaceFrom)} → ${repLabel(ext.replaceTo)}`;
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

// ペーストの基準：コピーの四隅のうち、プレイヤーに一番近い角を、照準の位置に合わせる。
// （箱はプレイヤーから遠ざかる向きに伸びるので、手前の端がぴったり合わせられる）
function pasteOriginFor(base) {
  const c = ext.clip;
  if (!c) return base;
  const o = ext.pasteOpt;
  let W = c.sx, H = c.sy, D = c.sz;
  const rots = ((o.rot % 4) + 4) % 4;
  for (let k = 0; k < rots; k++) { const t = W; W = D; D = t; }
  const pitches = ((o.pitch % 4) + 4) % 4;
  for (let k = 0; k < pitches; k++) { const t = H; H = D; D = t; }
  const px = player.pos.x - (base[0] + 0.5);
  const pz = player.pos.z - (base[2] + 0.5);
  const offX = px > 0 ? W - 1 : 0;     // プレイヤーが+側にいれば、+側の端を基準にする
  const offZ = pz > 0 ? D - 1 : 0;
  return [base[0] - offX, base[1], base[2] - offZ];
}
function pasteHere() {
  if (!ext.clip) { toast('先にコピーしてください'); return; }
  const p = pickTarget();
  if (!p) { toast('ペースト先に向けて長押ししてください'); return; }
  const a = pasteOriginFor(placeCellFrom(p));
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
// ============================================================
// ワールドエディットの画面ボタン（取り消し・やり直し・ペーストの回転・反転）
//  ・取り消し・やり直し：ワールドエディットの道具を持っている間
//  ・回転・反転：ペーストを持っている間
//  ・位置と大きさは、コントローラー設定（voxel-craft-ui.js）から変えられる
// ============================================================
const WE_TOOLS = [T_WAND, T_DROPPER, T_FILL, T_COPY, T_PASTE, T_PASTE_ROT];
const PASTE_TOOLS = [T_PASTE, T_PASTE_ROT];
const edBtns = {};
const ED_STYLE = 'position:fixed;z-index:6;width:58px;height:58px;box-sizing:border-box;border-radius:10px;' +
  'background:rgba(20,30,45,.72);color:#fff;border:1px solid rgba(255,255,255,.45);font:13px system-ui,sans-serif;' +
  'touch-action:none;user-select:none;-webkit-user-select:none;display:none;padding:0;cursor:pointer';
function buildEditBar() {
  const specs = [
    ['edUndo', '取り消し', () => undoLast()],
    ['edRedo', 'やり直し', () => redoLast()],
    ['edRot', '回転', () => { ext.pasteOpt.rot = (ext.pasteOpt.rot + 1) % 4; pasteDirty = true; toast(`ペースト：回転 ${ext.pasteOpt.rot * 90}°`); }],
    ['edPitch', '縦回転', () => { ext.pasteOpt.pitch = ((ext.pasteOpt.pitch || 0) + 1) % 4; pasteDirty = true; toast(`ペースト：縦回転 ${ext.pasteOpt.pitch * 90}°`); }],
    ['edFlipX', '左右反転', () => { ext.pasteOpt.mx = !ext.pasteOpt.mx; pasteDirty = true; toast(`ペースト：左右反転 ${ext.pasteOpt.mx ? 'ON' : 'OFF'}`); }],
    ['edFlipZ', '前後反転', () => { ext.pasteOpt.mz = !ext.pasteOpt.mz; pasteDirty = true; toast(`ペースト：前後反転 ${ext.pasteOpt.mz ? 'ON' : 'OFF'}`); }]
  ];
  for (const [id, label, fn] of specs) {
    const b = document.createElement('button');
    b.id = id;
    b.type = 'button';
    b.className = 'vcTb';
    b.textContent = label;
    b.style.cssText = ED_STYLE;
    b.addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); fn(); });
    b.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
    document.body.appendChild(b);
    edBtns[id] = b;
  }
}
function syncEditBar() {
  if (!edBtns.edUndo) { if (document.body) buildEditBar(); return; }
  const id = HOTBAR[selIdx];
  const live = started && !menuOpen && !paused && !panelOpen;
  const we = live && WE_TOOLS.includes(id);
  const pa = live && PASTE_TOOLS.includes(id);
  edBtns.edUndo.style.display = we ? 'block' : 'none';
  edBtns.edRedo.style.display = we ? 'block' : 'none';
  for (const k of ['edRot', 'edPitch', 'edFlipX', 'edFlipZ']) edBtns[k].style.display = pa ? 'block' : 'none';
}

function updatePaste() {
  syncRotBar();
  syncEditBar();
  const id = HOTBAR[selIdx];
  if (id !== T_PASTE || !ext.clip || menuOpen || paused || !started || panelOpen) {
    pasteGroup.visible = false;
    return;
  }
  if (pasteDirty) rebuildPaste();
  const p = pickTarget();
  if (!p) { pasteGroup.visible = false; return; }
  const a = pasteOriginFor(placeCellFrom(p));
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
  // 別の機能（斜めグリッド）が置き場所を決めるとき、そこに合わせてプレビューする
  const plan = placeHook ? placeHook(p, id) : null;
  if (plan) {
    ghost.position.copy(plan.pos);
    ghost.quaternion.copy(plan.q);
    ghost.visible = true;
    const hid = id >= CUSTOM_BASE ? defRT.get(id) : null;
    const hcol = !plan.valid ? 0xff5555 : (hid && hid.def.colorable ? new THREE.Color(ext.curColor).getHex() : 0xffffff);
    ghost.traverse(o => { if (o.isMesh && o.material && o.material.color) o.material.color.setHex(hcol); });
    return;
  }
  let valid;
  if (!tiltMode() && p.kind !== 'tilt') {
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
    valid = ext.grid !== 1 || !isSolidAt([Math.floor(tp.c[0]), Math.floor(tp.c[1]), Math.floor(tp.c[2])]);   // 細かい格子は壁を無視
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
  const tools = [T_WAND, T_DROPPER, T_FILL, T_COPY, T_PASTE, T_PASTE_ROT, T_TRAFFIC, T_CROWD, T_SOUND, T_PHONE].map(id => `
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
const DEFAULT_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12];   // 7 = 水（カラー対応）
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
    return `<div class="ext-item" style="position:relative">
      <label style="position:absolute;top:4px;left:4px;z-index:1;background:rgba(8,16,28,.7);border-radius:6px;padding:2px 4px"><input type="checkbox" data-pick="${d.id}" ${invSel.has(d.id) ? 'checked' : ''}></label>
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
      <div class="ext-swatch-lg" style="background:${BLOCK_INFO[id].color}"></div>
      <div>${esc(BLOCK_INFO[id].name)}</div>
      <div style="font-size:11px;color:#9fb3c8">標準ブロック</div>
      <div class="ext-row" style="justify-content:center;margin-top:4px">
        <button class="ext-btn" data-use="${id}">使う</button>
      </div>
    </div>`).join('') : '';
  // 選択中のブロックだけ残す（削除されたものを除く）
  const liveIds = new Set(ext.defs.map(d => d.id));
  for (const id of [...invSel]) if (!liveIds.has(id)) invSel.delete(id);
  const n = invSel.size;
  const catOpts = ext.categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  const bulkHtml = (ext.curCat === '道具' || ext.curCat === '標準') ? '' : `
    <div class="ext-bulk" style="grid-column:1/-1;position:sticky;top:0;z-index:3;background:#14202e;padding:6px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.4)">
      <div class="ext-row" style="gap:4px;flex-wrap:wrap;align-items:center">
        <span style="font-size:12px">選択 ${n} 件</span>
        <button class="ext-btn sub" data-bulk="range">1つ目〜2つ目を範囲選択</button>
        <button class="ext-btn sub" data-bulk="all">表示中を全選択</button>
        <button class="ext-btn sub" data-bulk="none">選択解除</button>
      </div>
      <div class="ext-row" style="gap:4px;flex-wrap:wrap;align-items:center;margin-top:4px">
        <button class="ext-btn sub" data-bulk="dup" ${n ? '' : 'disabled'}>複製</button>
        <button class="ext-btn danger" data-bulk="del" ${n ? '' : 'disabled'}>削除</button>
        <select class="ext-input" id="extBulkCat">${catOpts}</select>
        <button class="ext-btn sub" data-bulk="cat" ${n ? '' : 'disabled'}>カテゴリ移動</button>
      </div>
      <div class="ext-row" style="gap:4px;flex-wrap:wrap;align-items:center;margin-top:4px">
        <select class="ext-input" id="extBulkLook">
          <option value="">見え方：変えない</option><option value="cut">くり抜き</option><option value="blend">半透過</option><option value="glow">発光</option>
        </select>
        <select class="ext-input" id="extBulkColor">
          <option value="">カラー：変えない</option><option value="on">カラーにする</option><option value="off">カラーをやめる</option>
        </select>
        <button class="ext-btn sub" data-bulk="set" ${n ? '' : 'disabled'}>設定を一括変更</button>
      </div>
    </div>`;
  gridEl.innerHTML = bulkHtml + ((defHtml + customHtml) || (ext.curCat === '道具' ? '' : '<p class="note">このカテゴリにブロックはありません。「＋ 新規ブロック」から作成できます。</p>'));
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
  removeDefs(new Set([id]));
  toast('削除しました');
}
// 複数のブロックを、まとめて削除する（ワールドの配置は一度の走査で消す）
function removeDefs(idSet) {
  const defs = ext.defs.filter(d => idSet.has(d.id));
  if (!defs.length) return 0;
  if (window.VoxelCustom && VoxelCustom.forget) for (const d of defs) VoxelCustom.forget(VoxelCustom.defHash(d));
  for (const e of chunks.values()) {
    if (!e.data) continue;
    let changed = false;
    for (let i = 0; i < e.data.length; i++) {
      if (idSet.has(e.data[i])) { e.data[i] = AIR; changed = true; }
    }
    const ed = editsByChunk.get(e.key);
    if (ed) for (const [i, t] of [...ed]) if (idSet.has(t)) ed.delete(i);
    if (changed) markDirty(e);
  }
  for (let i = tiltList.length - 1; i >= 0; i--) {
    if (idSet.has(tiltList[i].id)) removeTilt(tiltList[i]);
  }
  ext.defs = ext.defs.filter(d => !idSet.has(d.id));
  for (const id of idSet) { defRT.delete(id); delete BLOCK_INFO[id]; }
  for (let i = 0; i < HOTBAR.length; i++) {
    if (idSet.has(HOTBAR[i])) HOTBAR[i] = GRASS;
  }
  if (idSet.has(ext.dropper)) ext.dropper = AIR_ID;
  for (const id of idSet) invSel.delete(id);
  saveExt();
  renderInventory();
  refreshHotbarVisuals();
  selectSlot(selIdx);
  return defs.length;
}

// ── 一覧での複数選択（ブロックの編集メニュー）──
// invSel は選んだ順に入る（最初の2つ＝「1つ目」「2つ目」）
const invSel = new Set();
// 複製：同じ中身を別のブロックとして作る（名前を変えるので、部屋の人にも別のブロックとして届く）
async function duplicateDefs(defs) {
  const made = [];
  for (const d of defs) {
    const id = nextId();
    if (id < 0) { toast('カスタムブロックの上限に達したため、残りは複製できませんでした'); break; }
    const nd = { ...d, id, aid: newAid(), name: `${d.name}（複製）`, rev: Date.now() };
    if (d.model) nd.model = { ...d.model };
    ext.defs.push(nd);
    made.push(nd);
  }
  saveExt();
  for (const nd of made) { try { await registerDef(nd); } catch (e) { console.error(e); } }
  renderInventory();
  return made.length;
}
// 一覧の表示順（いま見えているカテゴリの中の順）
function visibleDefs() {
  return ext.defs.filter(d => ext.curCat === '全て' || d.category === ext.curCat);
}
// 「1つ目」と「2つ目」の間にあるブロックを、表示の順で全部選ぶ
function rangeSelect() {
  const picked = [...invSel];
  if (picked.length < 2) { toast('先に、1つ目と2つ目のブロックを選んでください'); return; }
  const vis = visibleDefs().map(d => d.id);
  const a = vis.indexOf(picked[0]), b = vis.indexOf(picked[1]);
  if (a < 0 || b < 0) { toast('1つ目と2つ目が、いま表示中のカテゴリに無いため選べません'); return; }
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) invSel.add(vis[i]);
  renderInventory();
}
function selectedDefs() {
  return [...invSel].map(id => defById(id)).filter(Boolean);
}
// 設定の一括変更：見え方・カラーの可否（空欄は変えない）。変えたブロックは、部屋の人にも届く
async function bulkSetLook(look, color) {
  const defs = selectedDefs();
  for (const d of defs) {
    if (look) { d.alpha = look; if (look === 'glow' && d.glowPower == null) d.glowPower = 1.5; }
    if (color === 'on') d.colorable = true;
    if (color === 'off') d.colorable = false;
    d.rev = Date.now();
    if (window.VoxelCustom) VoxelCustom.invalidate(d);
  }
  saveExt();
  for (const d of defs) {
    try { await registerDef(d); } catch (e) { console.error(e); }
    if (window.VoxelFx) VoxelFx.apply(d);
  }
  for (const e of chunks.values()) markDirty(e);      // 置いてあるブロックの見た目も作り直す
  renderInventory();
  return defs.length;
}

// ============================================================
// カラーパネル
// ============================================================
const PALETTE = ['#ffffff', '#d9d9d9', '#8c8c8c', '#333333', '#000000', '#e74c3c', '#e67e22', '#f1c40f',
  '#2ecc71', '#1abc9c', '#3498db', '#2c3e8f', '#9b59b6', '#e84393', '#8d5524', '#c8a46b'];
function setCurColor(c) {
  ext.curColor = c;
  ext.colorOff = false;
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
  document.getElementById('extCurLabel').textContent = ext.colorOff
    ? '色の指定：解除中（置いても色は付きません）'
    : '現在の色：' + ext.curColor;
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
  // 水（標準ブロック）も、カラーを指定して照準先を塗り替えられる
  const hw = origRaycast(7);
  if (hw && hw.b === WATER) {
    const kw = keyOf(hw.x, hw.y, hw.z);
    const pw = blockState.get(kw) || {};
    blockState.set(kw, { ...pw, color: colorForNew(), rot: 0 });
    touchState(hw.x, hw.y, hw.z);
    if (!ext.colorOff) pushHistory(ext.curColor);
    remeshAt(hw.x, hw.y, hw.z);
    return;
  }
  const t = targetCustom();
  if (!t) return;
  if (!t.rt.def.colorable) { toast('このブロックはカラーブロックではありません'); return; }
  const k = keyOf(t.h.x, t.h.y, t.h.z);
  const prev = blockState.get(k) || {};
  blockState.set(k, { ...prev, color: ext.curColor, rot: prev.rot || 0 });
  touchState(t.h.x, t.h.y, t.h.z);
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
  touchState(t.h.x, t.h.y, t.h.z);
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
    touchState(t.h.x, t.h.y, t.h.z);
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
  if (name === 'extBag') renderBag();
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
// 発光の色の濃さ（0＝白っぽい、1＝ブロックの色そのまま、2＝より濃い）。明るさとは別の設定
function glowDeepOf(v) { return Math.min(2, Math.max(0, Number(v) ?? 1)); }
function syncGlowUI() {
  const w = document.getElementById('extGlowWrap');
  if (w) w.style.display = (draft && draft.look === 'glow') ? 'inline-block' : 'none';
  const w2 = document.getElementById('extGlowDeepWrap');
  if (w2) w2.style.display = (draft && draft.look === 'glow') ? 'inline-block' : 'none';
}
function newDraft() {
  return {
    kind: 'cube', name: '', category: ext.categories[0] || '未分類', colorable: false,
    look: 'cut', glow: 1.5, glowDeep: 1,
    texData: null, model: null, modelTex: null, template: null,
    orient: 'fixed',
    scaleMode: 'auto', customScale: 1, resolvedScale: null, modelRot: 0, place: 'center',
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
  document.getElementById('extGlowDeep').value = String(glowDeepOf(d.glowDeep ?? 1));
  syncGlowUI();
  document.getElementById('extCubeSec').style.display = d.kind === 'cube' ? 'flex' : 'none';
  document.getElementById('extModelSec').style.display = d.kind === 'model' ? 'block' : 'none';
  document.getElementById('extCubePrev').src = d.texData || blankTexUrl();
  document.getElementById('extBreakPreset').value = d.sounds.break.type === 'preset' ? d.sounds.break.key : 'none';
  document.getElementById('extPlacePreset').value = d.sounds.place.type === 'preset' ? d.sounds.place.key : 'none';
  document.getElementById('extOrient').value = d.orient;
  document.getElementById('extModelRot').value = String(d.modelRot || 0);
  document.getElementById('extScaleMode').value = d.scaleMode;
  document.getElementById('extPlace').value = d.place || 'center';
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
    const r = await loadModelObject(draft.model.format, draft.model.data, draft.modelTex, scaleOverrideOf(draft), draft.modelRot || 0, draft.model, draft.place || 'center');
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
    id, aid: newAid(), name: draft.name, kind: draft.kind, category: draft.category, colorable: draft.colorable,
    texData: draft.kind === 'cube' ? draft.texData : draft.modelTex,
    model: draft.kind === 'model' ? {
      format: draft.model.format, data: draft.model.data,
      ...(draft.model.mtl !== undefined ? { mtl: draft.model.mtl, images: draft.model.images || {} } : {})
    } : null,
    orient: draft.kind === 'model' ? draft.orient : undefined,
    modelRot: draft.kind === 'model' ? (draft.modelRot || 0) : undefined,
    place: draft.kind === 'model' ? (draft.place || 'center') : undefined,
    scale: draft.kind === 'model' ? (draft.resolvedScale ?? 1) : undefined,
    sounds: draft.sounds,
    alpha: draft.look || 'cut',
    glowPower: draft.look === 'glow' ? glowOf(draft.glow) : undefined,
    glowDeep: draft.look === 'glow' ? glowDeepOf(draft.glowDeep) : undefined
  };
  ext.defs.push(def);
  if (!saveExt()) { ext.defs.pop(); return; }
  if (window.VoxelCustom && VoxelCustom.unforget) VoxelCustom.unforget(VoxelCustom.defHash(def));
  await registerDef(def);
  if (window.VoxelFx && VoxelFx.apply) VoxelFx.apply(def);
  if (bulk) {
    // 一括作成：次のものへ（設定は次にも引き継ぐ。もちろん次で変えられる）
    bulk.done++;
    bulk.keep = pickKeep(draft);
    bulk.i++;
    toast(`「${name}」を登録しました`);
    if (bulk.i >= bulk.items.length) { bulkFinish(); return; }
    await bulkShow();
    return;
  }
  closeImport();
  renderInventory();
  toast(`「${name}」を登録しました`);
}
function closeImport() {
  draft = null;
  bulk = null;
  const bb = document.getElementById('extBulkBar'); if (bb) bb.style.display = 'none';
  const sv = document.getElementById('extSave'); if (sv) sv.textContent = '保存して登録';
  closePanel();
}

// ============================================================
// 一括作成：選んだ複数のファイルを、1つずつ同じ作成画面で設定して登録する
// ============================================================
let bulk = null;                                     // { items, i, done, keep }
function baseName(n) { return String(n).replace(/\.[^.]+$/, ''); }
function pickKeep(d) {
  return { category: d.category, colorable: d.colorable, look: d.look, glow: d.glow, glowDeep: d.glowDeep, orient: d.orient,
    modelRot: d.modelRot, scaleMode: d.scaleMode, customScale: d.customScale, place: d.place, sounds: d.sounds };
}
async function modelItemsFrom(files) {
  const extOf = f => f.name.split('.').pop().toLowerCase();
  // 同じ名前（拡張子を除く）のものを対応づける：.mtl はマテリアル、同名の画像はテクスチャ
  const mtls = new Map(), pngs = new Map(), imgs = {}, mains = [];
  for (const f of files) {
    const x = extOf(f);
    if (x === 'mtl') mtls.set(baseName(f.name).toLowerCase(), await readAs(f, 'text'));
    else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(x)) {
      const d = await readAs(f, 'dataurl');
      imgs[f.name.toLowerCase()] = d;
      pngs.set(baseName(f.name).toLowerCase(), d);
    } else if (['obj', 'fbx', 'json', 'bbmodel'].includes(x)) mains.push(f);
  }
  const out = [];
  for (const f of mains) {
    const x = extOf(f);
    const format = x === 'obj' ? 'obj' : x === 'fbx' ? 'fbx' : 'json';
    const data = format === 'fbx' ? await readAs(f, 'dataurl') : await readAs(f, 'text');
    const mdl = { format, data };
    const key = baseName(f.name).toLowerCase();
    const mtl = mtls.get(key);
    if (mtl !== undefined) { mdl.mtl = mtl; mdl.images = { ...imgs }; }
    const item = { kind: 'model', name: baseName(f.name), model: mdl };
    if (mtl === undefined && pngs.has(key)) item.modelTex = pngs.get(key);   // 同名のPNGは、そのモデルのテクスチャにする
    out.push(item);
  }
  return out;
}
function startBulk(items) {
  if (!items.length) return;
  bulk = { items, i: 0, done: 0, keep: null };
  draft = newDraft();
  openPanel('extImport');
  bulkShow();
}
async function bulkShow() {
  const it = bulk.items[bulk.i];
  draft = newDraft();
  if (bulk.keep) Object.assign(draft, JSON.parse(JSON.stringify(bulk.keep)));
  draft.kind = it.kind;
  draft.name = it.name;
  if (it.kind === 'cube') draft.texData = it.texData;
  else { draft.model = it.model; draft.modelTex = it.modelTex || null; draft.resolvedScale = null; }
  draft.place = it.place || 'center';
  fillImportForm();
  if (it.kind === 'model') await rebuildDraftTemplate();
  document.getElementById('extBulkBar').style.display = 'flex';
  document.getElementById('extBulkMsg').textContent =
    `一括作成 ${bulk.i + 1} / ${bulk.items.length}：${it.name}（保存すると次へ進みます）`;
  document.getElementById('extSave').textContent = '保存して次へ';
}
async function bulkSkip() {
  if (!bulk) return;
  bulk.i++;
  if (bulk.i >= bulk.items.length) { bulkFinish(); return; }
  await bulkShow();
}
function bulkStop() {
  if (!bulk) return;
  bulkFinish(`一括作成を中止しました（${bulk.done} 個登録済み）`);
}
function bulkFinish(msg) {
  const n = bulk ? bulk.done : 0;
  bulk = null;
  closeImport();
  renderInventory();
  toast(msg || `一括で ${n} 個登録しました`);
}

// ============================================================
// アセット（カスタムブロック・線路・道路）の保存と読み込み
// ============================================================
function newAid() { return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9); }
function uniqueName(base, names) {
  for (let n = 1; ; n++) {
    const c = `${base}(${n})`;
    if (!names.includes(c)) return c;
  }
}
async function resolvedDef(d) {
  const o = { ...d };
  delete o.id;
  if (d.texData !== undefined) o.texData = await resolveRef(d.texData);
  if (d.model) {
    const m = { ...d.model };
    m.data = await resolveRef(m.data);
    if (m.mtl !== undefined) m.mtl = await resolveRef(m.mtl);
    if (m.images !== undefined) m.images = await resolveRef(m.images);
    o.model = m;
  }
  return o;
}
async function exportAssets() {
  let changed = false;
  for (const d of ext.defs) if (!d.aid) { d.aid = newAid(); changed = true; }
  if (changed) saveExt();
  const head = JSON.stringify({ format: 'voxelcraft-assets', version: 1, exportedAt: new Date().toISOString(),
    categories: ext.categories.slice() });
  const parts = [head.slice(0, -1) + ',"customs":['];
  let first = true;
  for (const d of ext.defs) {
    if (d.id < CUSTOM_BASE) continue;
    const o = await resolvedDef(d);
    parts.push((first ? '' : ',') + JSON.stringify(o));
    first = false;
  }
  parts.push('],"roads":');
  const roads = window.VoxelRoad && VoxelRoad.exportAssets ? await VoxelRoad.exportAssets() : [];
  parts.push(JSON.stringify(roads) + '}');
  const blob = new Blob(parts, { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  a.href = url;
  a.download = `voxelcraft-assets-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast(`保存しました（カスタムブロック ${ext.defs.length} 個・線路・道路 ${roads.length} 個）`);
}
let conflictResolve = null;
function askConflict(n) {
  return new Promise(res => {
    conflictResolve = res;
    document.getElementById('extConflictMsg').textContent =
      `同じIDのブロックが ${n} 個あります（中身が違います）。この読み込みで見つかった分は、すべて同じ方法で処理します。`;
    openPanel('extConflict');
  });
}
function resolveConflict(v) {
  const r = conflictResolve;
  conflictResolve = null;
  closePanel();
  if (r) r(v);
}
const DEF_FIELDS = ['name', 'kind', 'colorable', 'texData', 'model', 'orient', 'modelRot', 'place', 'scale', 'alpha', 'glowPower', 'glowDeep'];
async function importAssets(file) {
  let s;
  try { s = JSON.parse(await readAs(file, 'text')); } catch (e) { toast('ファイルを読めませんでした'); return; }
  if (!s || s.format !== 'voxelcraft-assets') { toast('アセットファイルではありません'); return; }
  const customs = Array.isArray(s.customs) ? s.customs : [];
  const roads = Array.isArray(s.roads) ? s.roads : [];
  // 同じIDで中身が違うものの数（ブロック＋線路・道路）
  let conflicts = 0;
  for (const c of customs) {
    if (!c.aid) continue;
    const have = ext.defs.find(d => d.aid === c.aid);
    if (have && VoxelCustom.defHash(c) !== VoxelCustom.defHash(have)) conflicts++;
  }
  const roadConflicts = window.VoxelRoad && VoxelRoad.assetConflicts ? await VoxelRoad.assetConflicts(roads) : 0;
  let mode = 'rename';
  if (conflicts + roadConflicts > 0) {
    mode = await askConflict(conflicts + roadConflicts);
    if (!mode) { toast('読み込みを取り消しました'); return; }
  }
  let added = 0, over = 0, ren = 0, same = 0;
  for (const c of customs) {
    const H = VoxelCustom.defHash(c);
    const byAid = c.aid ? ext.defs.find(d => d.aid === c.aid) : null;
    if (byAid && VoxelCustom.defHash(byAid) === H) { same++; continue; }
    if (!byAid && ext.defs.some(d => VoxelCustom.defHash(d) === H)) { same++; continue; }
    if (byAid && mode === 'overwrite') {
      for (const k of DEF_FIELDS) byAid[k] = c[k];
      byAid.sounds = c.sounds || { break: { type: 'none' }, place: { type: 'none' } };
      if (c.category && !ext.categories.includes(c.category)) ext.categories.push(c.category);
      byAid.category = c.category || byAid.category;
      VoxelCustom.invalidate(byAid);
      VoxelCustom.unforget(H);
      await registerDef(byAid);
      over++;
      continue;
    }
    const id = nextId();
    if (id < 0) { toast('カスタムブロックの上限に達したため、残りを読み込めませんでした'); break; }
    const isCopy = !!byAid;                              // 同じIDで中身が違う → 名前を変えて追加
    const nd = { ...c, id, aid: isCopy || !c.aid ? newAid() : c.aid,
      name: isCopy ? uniqueName(c.name || 'カスタムブロック', ext.defs.map(d => d.name)) : (c.name || 'カスタムブロック'),
      sounds: c.sounds || { break: { type: 'none' }, place: { type: 'none' } } };
    if (!nd.category || !ext.categories.includes(nd.category)) {
      if (nd.category) ext.categories.push(nd.category); else nd.category = ext.categories[0] || '未分類';
    }
    ext.defs.push(nd);
    VoxelCustom.unforget(H);
    await registerDef(nd);
    if (isCopy) ren++; else added++;
  }
  if (Array.isArray(s.categories)) for (const c of s.categories) if (typeof c === 'string' && c && !ext.categories.includes(c)) ext.categories.push(c);
  saveExt();
  renderInventory();
  let rr = { added: 0, over: 0, ren: 0, same: 0 };
  if (roads.length && window.VoxelRoad && VoxelRoad.importAssets) rr = await VoxelRoad.importAssets(roads, mode);
  toast(`読み込みました：追加 ${added + rr.added}・上書き ${over + rr.over}・名前を変えて追加 ${ren + rr.ren}・同じものは省略 ${same + rr.same}`);
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
  const asec = document.createElement('div');
  asec.innerHTML = `
    <h3>カスタムブロック・線路・道路のアセット</h3>
    <div class="ext-row" style="margin-top:6px">
      <button class="ext-btn" id="extAssetSave">全てのカスタムブロック・線路・道路を保存</button>
      <button class="ext-btn sub" id="extAssetLoad">ファイルから読み込む</button>
      <input type="file" id="extAssetFile" accept=".json,application/json" style="display:none">
    </div>
    <p class="note">保存したファイルを別のワールドで読み込むと、ブロックの見た目や設定を引き継げます。同じIDのブロックが中身の違うまま既にある場合は、上書きか名前を変えて追加かを選べます（名前を変えると「(1)」などが付きます）。</p>`;
  sbox.insertBefore(asec, closeBtn);
  document.getElementById('extAssetSave').addEventListener('click', () => exportAssets().catch(e => { console.error(e); toast('保存できませんでした'); }));
  document.getElementById('extAssetLoad').addEventListener('click', () => document.getElementById('extAssetFile').click());
  document.getElementById('extAssetFile').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) await importAssets(f).catch(err => { console.error(err); toast('読み込みに失敗しました'); });
  });
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
  /* インベントリ：パネルの高さを画面に合わせて固定し、一覧だけを上下にスクロールさせる。
     アイコンはマス目の幅に合わせて大きさを保つ（アイテムが増えても小さくならない） */
  .ext-inv-box{height:min(88vh,780px);max-height:88vh;display:flex;flex-direction:column;overflow:hidden;width:min(94vw,860px)}
  .ext-inv-body{display:flex;gap:12px;flex:1;min-height:0;align-items:stretch}
  .ext-inv-main{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
  .ext-inv-box .ext-cats{width:180px;flex:0 0 180px;min-height:0;overflow-y:auto;padding-right:2px}
  .ext-grid-wrap{flex:1;min-height:120px;overflow-y:auto;overflow-x:hidden;padding:2px 6px 6px 2px;margin-top:4px;
    border-radius:8px;background:rgba(0,0,0,.12);-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
  #extGrid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
  #extGrid .ext-item{min-width:0;display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px}
  #extGrid .ext-item img{width:100%;max-width:120px;height:auto;aspect-ratio:1/1;border-radius:8px}
  #extGrid .ext-item select{max-width:100%}
  #extGrid .ext-item .ext-swatch-lg{width:100%;max-width:120px;aspect-ratio:1/1;border-radius:8px}
  @media (max-width:640px){
    .ext-inv-box{height:min(92vh,640px);width:94vw}
    .ext-inv-body{flex-direction:column}
    .ext-inv-box .ext-cats{width:auto;flex:0 0 auto;flex-direction:row;overflow-x:auto;overflow-y:hidden;max-height:none}
    .ext-inv-box .ext-cats .ext-cat{white-space:nowrap}
    #extGrid{grid-template-columns:repeat(auto-fill,minmax(110px,1fr))}
  }
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
  <div class="ext-panel" id="extInv"><div class="ext-box ext-inv-box">
    <h2>インベントリ</h2>
    <div class="ext-inv-body">
      <div class="ext-cats" id="extCats"></div>
      <div class="ext-inv-main">
        <div class="ext-row" style="margin-bottom:8px">
          <button class="ext-btn" id="extNew">＋ 新規ブロック</button>
          <button class="ext-btn sub" id="extColorOpen">🎨 カラー</button>
        </div>
        <div id="extToolsSec"></div>
        <h3>ブロック</h3>
        <p class="note">「使う」で、ホットバーの選択中のスロットに入ります。</p>
        <div class="ext-grid-wrap" id="extGridWrap"><div class="ext-grid" id="extGrid"></div></div>
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
      <button class="ext-btn sub" id="extColorOff">カラーの指定を解除</button>
    </div>
    <h3>使用履歴</h3>
    <div class="ext-row" id="extHistory"></div>
    <div class="ext-row" style="margin-top:12px"><button class="ext-btn sub" id="extColorClose">閉じる</button></div>
  </div></div>

  <div class="ext-panel" id="extImport"><div class="ext-box" style="width:min(94vw,660px)">
    <h2>カスタムブロックを作成</h2>
    <div class="ext-row" id="extBulkBar" style="display:none;margin-bottom:8px">
      <span class="note" id="extBulkMsg" style="flex:1"></span>
      <button class="ext-btn sub" id="extBulkSkip">この1つをスキップ</button>
      <button class="ext-btn sub" id="extBulkStop">一括を中止</button>
    </div>
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
      <label id="extGlowDeepWrap" style="display:none">色の濃さ
        <input class="ext-input" id="extGlowDeep" type="number" min="0" max="2" step="0.1" value="1" style="width:70px">
      </label>
    </div>
    <div id="extCubeSec" class="ext-row" style="margin-top:10px">
      <button class="ext-btn" id="extSkinOpen">スキンを描く・編集</button>
      <button class="ext-btn sub" id="extPngOpen">PNGを読み込む</button>
      <button class="ext-btn sub" id="extPngBulk">PNGを複数選択（一括作成）</button>
      <input type="file" id="extPngFile" accept="image/png,image/jpeg" style="display:none">
      <input type="file" id="extPngBulkFile" accept="image/png,image/jpeg" multiple style="display:none">
      <img id="extCubePrev" style="width:72px;height:72px;image-rendering:pixelated;background:rgba(0,0,0,.2);border-radius:6px">
    </div>
    <div id="extModelSec" style="display:none;margin-top:10px">
      <div class="ext-row">
        <button class="ext-btn sub" id="extModelBulk">モデルを複数選択（一括作成）</button>
        <input type="file" id="extModelBulkFile" multiple accept=".obj,.fbx,.json,.bbmodel,.mtl,image/png,image/jpeg,image/gif,image/webp,image/bmp" style="display:none">
        <span class="note">モデルごとに、同じ名前の .mtl と、選んだ画像を使います。</span>
      </div>
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
        <label>位置
          <select class="ext-input" id="extPlace">
            <option value="center">自動で中心（今まで通り）</option>
            <option value="raw">Blockbenchで作った位置のまま</option>
          </select>
        </label>
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

  <div class="ext-panel" id="extConflict" style="z-index:60"><div class="ext-box" style="width:min(94vw,520px)">
    <h2>同じIDのブロックがあります</h2>
    <p class="note" id="extConflictMsg"></p>
    <div class="ext-row" style="margin-top:12px">
      <button class="ext-btn" id="extCfOver">上書きする</button>
      <button class="ext-btn sub" id="extCfRen">名前を変えて追加（(1)などを付ける）</button>
      <button class="ext-btn sub" id="extCfCancel">キャンセル（読み込まない）</button>
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
  document.getElementById('extColorOff').addEventListener('click', () => {
    ext.colorOff = true;
    renderColor();
    toast('カラーの指定を解除しました（置いても色は付きません）');
  });

  document.getElementById('extCats').addEventListener('click', e => {
    const catEl = e.target.closest('.ext-cat');
    const act = e.target.dataset.act;
    if (catEl && !act) { ext.curCat = catEl.dataset.c; invSel.clear(); renderInventory(); return; }
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

  document.getElementById('extGrid').addEventListener('click', async e => {
    const use = e.target.dataset.use, del = e.target.dataset.del, bulk = e.target.dataset.bulk;
    if (use) useItem(Number(use));
    if (del) deleteDef(Number(del));
    if (!bulk) return;
    const defs = selectedDefs();
    if (bulk === 'range') rangeSelect();
    else if (bulk === 'all') { for (const d of visibleDefs()) invSel.add(d.id); renderInventory(); }
    else if (bulk === 'none') { invSel.clear(); renderInventory(); }
    else if (bulk === 'dup') {
      if (!defs.length) return;
      const k = await duplicateDefs(defs);
      toast(`${k}件複製しました`);
    }
    else if (bulk === 'del') {
      if (!defs.length) return;
      if (!confirm(`選んだ${defs.length}件のブロックを削除しますか？\n配置済みのこれらのブロックも消えます。`)) return;
      removeDefs(new Set(defs.map(d => d.id)));
      toast('削除しました');
    }
    else if (bulk === 'cat') {
      const target = document.getElementById('extBulkCat').value;
      if (!defs.length || !target) return;
      const now = Date.now();
      for (const d of defs) { d.category = target; d.rev = now; }
      saveExt();
      renderInventory();
      toast(`${defs.length}件を「${target}」に移動しました`);
    }
    else if (bulk === 'set') {
      if (!defs.length) return;
      const look = document.getElementById('extBulkLook').value;
      const color = document.getElementById('extBulkColor').value;
      if (!look && !color) { toast('変える項目を選んでください'); return; }
      const k = await bulkSetLook(look, color);
      toast(`${k}件の設定を変更しました`);
    }
  });
  document.getElementById('extGrid').addEventListener('change', e => {
    if (e.target.dataset.pick) {
      const id = Number(e.target.dataset.pick);
      if (e.target.checked) invSel.add(id); else invSel.delete(id);
      renderInventory();
      return;
    }
    const id = e.target.dataset.cat;
    if (!id) return;
    const def = defById(Number(id));
    if (def) { def.category = e.target.value; def.rev = Date.now(); saveExt(); renderInventory(); }
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
  document.getElementById('extGlowDeep').addEventListener('change', e => { draft.glowDeep = glowDeepOf(e.target.value); e.target.value = String(draft.glowDeep); });
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
  document.getElementById('extPlace').addEventListener('change', async e => {
    draft.place = e.target.value;
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
  // 一括作成（PNG複数・モデル複数）
  document.getElementById('extPngBulk').addEventListener('click', () => document.getElementById('extPngBulkFile').click());
  document.getElementById('extPngBulkFile').addEventListener('change', async e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    const items = [];
    for (const f of files) items.push({ kind: 'cube', name: baseName(f.name), texData: await readAs(f, 'dataurl') });
    startBulk(items);
  });
  document.getElementById('extModelBulk').addEventListener('click', () => document.getElementById('extModelBulkFile').click());
  document.getElementById('extModelBulkFile').addEventListener('change', async e => {
    const files = [...e.target.files];
    e.target.value = '';
    const items = await modelItemsFrom(files);
    if (items.length) startBulk(items);
    else toast('モデル（.obj・.fbx・.json など）を選んでください');
  });
  document.getElementById('extBulkSkip').addEventListener('click', bulkSkip);
  document.getElementById('extBulkStop').addEventListener('click', bulkStop);
  // 読み込みの競合の選択
  document.getElementById('extCfOver').addEventListener('click', () => resolveConflict('overwrite'));
  document.getElementById('extCfRen').addEventListener('click', () => resolveConflict('rename'));
  document.getElementById('extCfCancel').addEventListener('click', () => resolveConflict(null));

  wireSkinEditor();

  window.addEventListener('keydown', e => {
    if (e.code === 'Escape' && panelOpen) {
      if (document.getElementById('extSkin').classList.contains('show')) closeSkinEditor();
      else if (panelOpen === 'extImport') closeImport();
      else if (panelOpen === 'extConflict') resolveConflict(null);
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
    toggleBag();
    return;
  }
  if (e.code === 'KeyG') {
    if (panelOpen === 'extColor') closePanel(); else if (!panelOpen) openPanel('extColor');
    return;
  }
  if (menuOpen || paused || !started) return;
  if (e.code === 'KeyC') recolorTarget();
  if (e.code === 'KeyR') resetTarget();
  if (e.code === 'KeyV') rotateTarget();                  // 回転は V へ（T はチャット）
  if (e.code === 'KeyZ') undoLast();
  if (e.code === 'KeyY') { ext.pasteOpt.rot = (ext.pasteOpt.rot + 1) % 4; pasteDirty = true; toast(`ペースト：回転 ${ext.pasteOpt.rot * 90}°`); }
  if (e.code === 'KeyU') { ext.pasteOpt.mx = !ext.pasteOpt.mx; pasteDirty = true; toast(`ペースト：X反転 ${ext.pasteOpt.mx ? 'ON' : 'OFF'}`); }
  if (e.code === 'KeyI') { ext.pasteOpt.mz = !ext.pasteOpt.mz; pasteDirty = true; toast(`ペースト：Z反転 ${ext.pasteOpt.mz ? 'ON' : 'OFF'}`); }
});

// ============================================================
// 毎フレームの処理
// ============================================================
// 手で置いた（細かいグリッド・斜め・傾き）ブロックは、読み込んだチャンクの外では描かない
let tiltCullAt = 0;
function cullTilts() {
  for (const ent of tiltList) {
    const c = ent.c, o = ent.obj;
    if (!c || !o) continue;
    if (ent.hideDraft) { o.visible = false; continue; }      // エディットで消した（保存するまで隠す）
    const cx = Math.floor(c[0] / CS), cy = Math.floor(c[1] / CS), cz = Math.floor(c[2] / CS);
    const vis = inRange(cx, cz, curPcx, curPcz, RD) && Math.abs(cy - curPcy) <= RD;
    if (o.visible !== vis) o.visible = vis;
  }
}
function extLoop() {
  requestAnimationFrame(extLoop);
  if (performance.now() - tiltCullAt > 250) { tiltCullAt = performance.now(); cullTilts(); }
  if (panelOpen === 'extBag') drawBagSkin(performance.now() / 1000);
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

// ============================================================
// バックパック（インベントリを大きく開く。「＋」ボタン／Eキー）
//  左：アイテム一覧（カテゴリごと）　右：自分のスキン・バックパック・アイテムスロット
//  使い方：一覧のアイテムをタップ →（バックパック or スロットをタップ）で入る
//         空欄にするのは、ダブルタップ（ダブルクリック）
// ============================================================
const BAG_N = 27;                       // 9列×3段
const BAG_KEY = 'voxelcraft_bag_v1';
let bag = loadBag();
let bagCat = '全て';
let bagPick = null;                     // 一覧で選んで、これから入れるアイテムの ID
let bagLastKey = '', bagLastT = 0;      // ダブルタップ判定
function loadBag() {
  const out = new Array(BAG_N).fill(0);
  try {
    const a = JSON.parse(localStorage.getItem(BAG_KEY) || 'null');
    if (Array.isArray(a)) for (let i = 0; i < BAG_N; i++) out[i] = Number(a[i]) || 0;
  } catch (e) {}
  return out;
}
function saveBag() { try { localStorage.setItem(BAG_KEY, JSON.stringify(bag)); } catch (e) {} }

function buildBagPanel() {
  const css = document.createElement('style');
  css.textContent = `
    #extBag .bag-box{background:#1b2530;color:#fff;border-radius:10px;padding:12px;width:min(96vw,860px);
      height:min(92vh,780px);max-height:94vh;overflow:hidden;box-sizing:border-box;display:flex;flex-direction:column}
    #extBag .bag-wrap{display:flex;gap:12px;align-items:stretch;flex:1;min-height:0}
    #extBag .bag-left,#extBag .bag-right{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:6px;min-height:0}
    #extBag .bag-right{overflow-y:auto;padding-right:2px}
    #extBag .bag-cats{display:flex;flex-wrap:wrap;gap:4px;max-height:96px;overflow-y:auto;flex:0 0 auto}
    #extBag .bag-cat{padding:4px 7px;border-radius:5px;background:rgba(255,255,255,.08);font-size:12px;cursor:pointer;white-space:nowrap}
    #extBag .bag-cat.sel{background:#2e4a66}
    /* アイテム一覧：パネルの高さいっぱいに広がり、一覧だけを上下にスクロール。アイコンは列幅に合わせて大きさを保つ */
    #extBag .bag-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;
      flex:1;min-height:160px;overflow-y:auto;overflow-x:hidden;padding:6px;background:rgba(0,0,0,.2);border-radius:8px;
      align-content:start;grid-auto-rows:max-content;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
    #extBag .bag-item{background:rgba(255,255,255,.06);border:2px solid transparent;border-radius:8px;padding:5px;min-width:0;
      text-align:center;font-size:12px;line-height:1.3;cursor:pointer;overflow:hidden}
    #extBag .bag-item .bic{width:100%;height:auto;aspect-ratio:1/1;border-radius:6px;font-size:28px}
    #extBag .bag-item.pick{border-color:#ffd54a;background:#3a4e2a}
    #extBag .bag-skin{height:190px;border-radius:8px;background:rgba(0,0,0,.25);overflow:hidden}
    #extBag .bag-skin canvas{width:100%;height:100%;display:block}
    #extBag .bag-label{font-size:12px;color:#9fb3c8}
    #extBag .bag-grid{display:grid;grid-template-columns:repeat(9,minmax(0,1fr));gap:3px}
    #extBag .bcell{aspect-ratio:1;min-width:0;border:2px solid rgba(255,255,255,.22);border-radius:4px;
      background:rgba(0,0,0,.3);cursor:pointer;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative}
    #extBag .bcell.sel{border-color:#fff}
    #extBag .bcell .num{position:absolute;left:2px;top:0;font-size:9px;color:#cfd9e4;text-shadow:0 1px 2px #000}
    #extBag .bic{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:18px;
      background-size:cover;background-position:center}
    #extBag .bag-note{font-size:12px;color:#ffd54a;min-height:18px;margin:6px 0 0}
    #extBag.bag-picking .bcell,#extBag.bag-picking .slot-cell{outline:1px dashed rgba(255,213,74,.5)}
    @media (max-width:560px){
      #extBag .bag-box{padding:8px;height:min(94vh,760px)}
      #extBag .bag-wrap{gap:8px;flex-direction:column}
      #extBag .bag-left{flex:1 1 auto;min-height:0}
      #extBag .bag-right{flex:0 0 auto;overflow:visible}
      #extBag .bag-skin{height:110px}
      #extBag .bag-list{grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:6px;min-height:150px}
    }
    #bagPlus{width:46px;height:46px;box-sizing:border-box;border:2px dashed rgba(255,255,255,.45);border-radius:5px;
      background:rgba(0,0,0,.25);color:#fff;font-size:22px;display:flex;align-items:center;justify-content:center;cursor:pointer;
      user-select:none;-webkit-user-select:none}
    body.touch #bagPlus{width:34px;height:34px;font-size:18px}
  `;
  document.head.appendChild(css);

  const wrap = document.createElement('div');
  wrap.innerHTML = `
  <div class="ext-panel" id="extBag"><div class="bag-box">
    <h2 style="margin:0 0 6px">インベントリ</h2>
    <div class="bag-wrap">
      <div class="bag-left">
        <div class="bag-cats" id="bagCats"></div>
        <div class="bag-list" id="bagList"></div>
      </div>
      <div class="bag-right">
        <div class="bag-skin"><canvas id="bagSkin"></canvas></div>
        <div class="bag-label">バックパック</div>
        <div class="bag-grid" id="bagGrid"></div>
        <div class="bag-label">アイテムスロット</div>
        <div class="bag-grid" id="bagHot"></div>
      </div>
    </div>
    <p class="bag-note" id="bagNote"></p>
    <div class="ext-row" style="margin-top:6px"><button class="ext-btn sub" id="bagClose">閉じる</button></div>
  </div></div>`;
  document.body.appendChild(wrap.firstElementChild);

  const box = document.querySelector('#extBag .bag-box');
  box.addEventListener('click', e => {
    const cat = e.target.closest('.bag-cat');
    if (cat) { bagCat = cat.dataset.c; renderBag(); return; }
    const item = e.target.closest('.bag-item');
    if (item) {
      const id = Number(item.dataset.id);
      bagPick = bagPick === id ? null : id;
      renderBag();
      return;
    }
    const cell = e.target.closest('.bcell');
    if (cell) onBagCell(cell);
  });
  document.getElementById('bagClose').addEventListener('click', () => closePanel());

  // 「＋」ボタン（ホットバーの右）
  const hb = document.getElementById('hotbar');
  if (hb) {
    const plus = document.createElement('div');
    plus.id = 'bagPlus';
    plus.textContent = '＋';
    plus.title = 'インベントリを開く（Eキー）';
    plus.addEventListener('click', e => { e.stopPropagation(); toggleBag(); });
    hb.appendChild(plus);
  }
}
function toggleBag() {
  if (panelOpen === 'extBag') closePanel();
  else if (!panelOpen) openPanel('extBag');
}

// アイテムの見た目
function bagIconHtml(id) {
  if (!id) return '';
  if (isTool(id)) return `<div class="bic" style="background:#2b3a4a">${TOOLS[id].icon}</div>`;
  const def = defById(id);
  if (def) return `<div class="bic" style="background-image:url(${thumbOf(def)})"></div>`;
  const info = BLOCK_INFO[id];
  return `<div class="bic" style="background:${info ? info.color : '#888'}"></div>`;
}
function bagNameOf(id) {
  if (!id) return '空欄';
  if (isTool(id)) return TOOLS[id].name;
  const def = defById(id);
  if (def) return def.name;
  return (BLOCK_INFO[id] && BLOCK_INFO[id].name) || '';
}
function bagCatalog(cat) {
  const out = [];
  if (cat === '全て' || cat === '標準') for (const id of DEFAULT_IDS) out.push({ id, name: BLOCK_INFO[id].name, cat: '標準' });
  if (cat === '全て' || cat === '道具') for (const id of [T_WAND, T_DROPPER, T_FILL, T_COPY, T_PASTE, T_PASTE_ROT, T_TRAFFIC, T_CROWD, T_SOUND, T_PHONE]) out.push({ id, name: TOOLS[id].name, cat: '道具' });
  for (const d of ext.defs) if (cat === '全て' || d.category === cat) out.push({ id: d.id, name: d.name, cat: d.category });
  return out;
}

function renderBag() {
  const catsEl = document.getElementById('bagCats');
  const listEl = document.getElementById('bagList');
  const gridEl = document.getElementById('bagGrid');
  const hotEl = document.getElementById('bagHot');
  if (!catsEl || !listEl) return;
  const cats = ['全て', '標準', '道具', ...ext.categories];
  catsEl.innerHTML = cats.map(c => `<span class="bag-cat ${c === bagCat ? 'sel' : ''}" data-c="${esc(c)}">${esc(c)}</span>`).join('');
  listEl.innerHTML = bagCatalog(bagCat).map(it => `
    <div class="bag-item ${it.id === bagPick ? 'pick' : ''}" data-id="${it.id}">
      ${bagIconHtml(it.id)}<div>${esc(it.name)}</div>
    </div>`).join('') || '<p class="note" style="grid-column:1/-1">このカテゴリにはアイテムがありません</p>';
  gridEl.innerHTML = bag.map((id, i) =>
    `<div class="bcell" data-b="${i}">${bagIconHtml(id)}</div>`).join('');
  hotEl.innerHTML = HOTBAR.map((id, i) =>
    `<div class="bcell ${i === selIdx ? 'sel' : ''}" data-h="${i}"><span class="num">${i + 1}</span>${bagIconHtml(id)}</div>`).join('');
  const picking = bagPick !== null;
  document.getElementById('extBag').classList.toggle('bag-picking', picking);
  document.getElementById('bagNote').textContent = picking
    ? `「${bagNameOf(bagPick)}」を持っています。バックパックかアイテムスロットをタップすると入ります。`
    : 'アイテムをタップしてから、バックパックかアイテムスロットをタップすると入ります。ダブルタップで空欄にできます。';
  setupSkinPreview();
}

let bagFrom = null;     // バックパックから持ち出したもの（移動元）{ key, h, i }
function onBagCell(cell) {
  const isHot = cell.dataset.h !== undefined;
  const i = Number(isHot ? cell.dataset.h : cell.dataset.b);
  const key = (isHot ? 'h' : 'b') + i;
  if (bagPick !== null) {
    const from = bagFrom;
    bagFrom = null;
    if (from && from.key === key) {                           // 同じ場所をもう一度タップ → 取り消し
      bagPick = null; bagLastKey = ''; renderBag(); return;
    }
    if (from) { if (from.h) HOTBAR[from.i] = 0; else bag[from.i] = 0; }   // 移動元を空ける
    if (isHot) { HOTBAR[i] = bagPick; selectSlot(i); refreshHotbarVisuals(); }
    else bag[i] = bagPick;
    saveBag();
    toast(`「${bagNameOf(bagPick)}」を入れました`);
    bagPick = null;
    bagLastKey = '';
    renderBag();
    return;
  }
  const now = Date.now();
  if (key === bagLastKey && now - bagLastT < 400) {          // ダブルタップ・ダブルクリック → 空欄
    if (isHot) { HOTBAR[i] = 0; refreshHotbarVisuals(); }
    else { bag[i] = 0; saveBag(); }
    bagLastKey = '';
    renderBag();
    return;
  }
  bagLastKey = key; bagLastT = now;
  if (!isHot && bag[i]) {                                    // バックパックのアイテムをタップ → 持つ（次にスロットかバックパックをタップで入る）
    bagPick = bag[i];
    bagFrom = { key, h: false, i };
    renderBag();
    return;
  }
  if (isHot) { selectSlot(i); renderBag(); }
}

// ---- 自分のスキン（今の人型をそのまま映す。ゆっくり回る） ----
let skinR = null, skinScene = null, skinCam = null, skinGroup = null, skinAng = 0, skinModelKey = null;
function setupSkinPreview() {
  const cv = document.getElementById('bagSkin');
  if (!cv || typeof THREE === 'undefined') return;
  if (!skinR) {
    try {
      skinR = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
      skinR.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      skinScene = new THREE.Scene();
      skinCam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
      skinScene.add(new THREE.AmbientLight(0xffffff, 0.8));
      const dl = new THREE.DirectionalLight(0xffffff, 0.8);
      dl.position.set(2, 4, 3);
      skinScene.add(dl);
      skinGroup = new THREE.Group();
      skinScene.add(skinGroup);
    } catch (e) { console.error(e); skinR = null; return; }
  }
  const w = cv.clientWidth || 200, h = cv.clientHeight || 190;
  if (cv.width !== Math.round(w * skinR.getPixelRatio()) || cv.height !== Math.round(h * skinR.getPixelRatio())) {
    skinR.setSize(w, h, false);
    skinCam.aspect = w / h;
    skinCam.updateProjectionMatrix();
  }
  // 人型が変わったときだけ、コピーを作り直す
  let src = null;
  try { src = modelHolder; } catch (e) {}
  if (!src) return;
  const key = src.uuid + ':' + src.children.length + ':' + (src.children[0] ? src.children[0].uuid : '');
  if (key === skinModelKey) return;
  skinModelKey = key;
  skinGroup.children.slice().forEach(o => skinGroup.remove(o));
  const cl = src.clone(true);
  cl.position.set(0, 0, 0);
  cl.rotation.set(0, 0, 0);
  cl.visible = true;
  skinGroup.add(cl);
  skinGroup.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(skinGroup);
  const c = box.getCenter(new THREE.Vector3());
  const sz = box.getSize(new THREE.Vector3());
  const top = Math.max(0.5, sz.y);
  skinCam.position.set(0, c.y, top * 2.3);
  skinCam.lookAt(0, c.y, 0);
}
function drawBagSkin(t) {
  if (!skinR || !skinGroup) return;
  skinAng = t * 0.6;
  skinGroup.rotation.y = skinAng;
  try { skinR.render(skinScene, skinCam); } catch (e) {}
}

function init() {
  injectCSS();
  buildDOM();
  buildBagPanel();
  loadExt();
  BLOCK_INFO[T_WAND] = { name: 'ステッキ', color: '#445566' };
  BLOCK_INFO[T_DROPPER] = { name: 'スポイト', color: '#445566' };
  BLOCK_INFO[T_FILL] = { name: 'フィル', color: '#445566' };
  BLOCK_INFO[T_COPY] = { name: 'コピー', color: '#445566' };
  BLOCK_INFO[T_PASTE] = { name: 'ペースト', color: '#445566' };
  BLOCK_INFO[T_PASTE_ROT] = { name: '回転・反転', color: '#445566' };
  BLOCK_INFO[T_TRAFFIC] = { name: '自動車交通制御', color: '#445566' };
  BLOCK_INFO[T_CROWD] = { name: '人混みマネージャー', color: '#445566' };
  BLOCK_INFO[T_SOUND] = { name: '音声ブロック', color: '#5a4a22' };
  BLOCK_INFO[T_PHONE] = { name: 'マイ端末', color: '#2a313c' };
  hookSettings();
  wire();
  syncTurboUI();
  if (ext.turbo) setTurbo(true);
  window.addEventListener('resize', applyRenderScale);
  setInterval(enforceTurbo, 300);
  buildWaterSettings();
  applyWaterLook();
  buildReplaceBar();
  buildAutoSyncSetting();
  buildViewSettings();
  applyViewPref();
  hydrateReady = hydrateDefs().then(() => {
    // 中身を戻したあとは、しるしを作り直す（戻す前に作った古いしるしで照合すると、同じブロックを別物と判定して増えるため）
    if (window.VoxelCustom) for (const def of ext.defs) VoxelCustom.invalidate(def);
    for (const def of ext.defs) registerDef(def);
    refreshHotbarVisuals();
    renderInventory();
  }).catch(e => console.error(e));
  requestAnimationFrame(extLoop);
}
// 起動時に中身を戻す処理（終わるまで、部屋の内容との照合を待つ）
// ※ init() より前に宣言する（後ろだと init() 内の代入で例外になり、window.VoxelExt が作られない）
let hydrateReady = null;
init();

// ── 他の機能ファイル（通信・カスタム・斜め配置・見え方）が使う内部の名前を公開する ──
// ext.js は1つの関数の中に閉じているため、外のファイルからは見えない。そこで window.VoxelExt にまとめて渡す。
// 相手の端末で変わったカスタムブロック（追加・削除・カテゴリ移動など）を、再読み込みなしでこの画面に反映する
//  戻り値：'same'（同じ内容）／'applied'（反映した）／'wait'（中身の受け取りがまだ）
// 相手の内容は「足す」だけにする。番号・分類・見た目を、相手の内容で置き換えない：
//  ・ブロックは中身（しるし）で照らし合わせ、同じ中身はこの端末の番号をそのまま使う
//  ・知らない中身は、この端末の空き番号で新しく足す（相手の番号は使わない。番号は端末ごとに違うため）
//  ・この端末に無いものを理由なく消さない（消すのは、この端末で削除したものだけ）
//  ・分類は足すだけ。ブロックの分類が変わったときだけ、その分類へ動かす
//  戻り値：'same'（変わらない）／'applied'（足した・動かした）／'wait'（中身の受け取りがまだ）
let lastRemoteExtText = null;      // 最後に処理した相手の内容（同じものを何度も処理しない）
async function applyRemoteExt(text) {
  if (typeof text !== 'string' || text === localStorage.getItem(EXT_KEY) || text === lastRemoteExtText) return 'same';
  if (!window.VoxelCustom) return 'same';
  if (hydrateReady) await hydrateReady.catch(() => {});
  let s;
  try { s = JSON.parse(text); } catch (e) { return 'same'; }
  const rdefs = Array.isArray(s.defs) ? s.defs : [];
  for (const d of rdefs) {
    const refs = [d.texData, d.model && d.model.data, d.model && d.model.mtl, d.model && d.model.images];
    for (const v of refs) if (isRef(v) && !(await blobGet(v.__blob).catch(() => null))) return 'wait';
  }
  let changed = false;
  const added = [];
  const updated = [];
  // 分類：足すだけ
  if (Array.isArray(s.categories)) {
    for (const c of s.categories) {
      if (typeof c === 'string' && c && !ext.categories.includes(c)) { ext.categories.push(c); changed = true; }
    }
  }
  for (const d of rdefs) {
    const o = { ...d };
    if (isRef(d.texData)) o.texData = await resolveRef(d.texData);
    if (d.model) {
      const m = { ...d.model };
      if (isRef(m.data)) m.data = await resolveRef(m.data);
      if (isRef(m.mtl)) m.mtl = await resolveRef(m.mtl);
      if (isRef(m.images)) m.images = await resolveRef(m.images);
      o.model = m;
    }
    const H = VoxelCustom.defHash(o);
    // 同じブロックかどうかは、まず固定ID（aid）で判定する。中身のしるしは見た目の細かな違いで変わることがあるため、二次的に使う
    const have = (o.aid && ext.defs.find(x => x.aid === o.aid)) || ext.defs.find(x => VoxelCustom.defHash(x) === H);
    if (have) {
      // 同じ中身：分類だけ、相手が動かしていれば合わせる（この端末に無い分類へは動かさない）
      if (o.category && o.category !== have.category && ext.categories.includes(o.category)) {
        have.category = o.category; changed = true;
      }
      // 同じブロック（aid）で、相手の方が新しい設定（一括変更など）になっていれば、設定だけ合わせる
      if (o.aid && have.aid === o.aid && (o.rev || 0) > (have.rev || 0) && VoxelCustom.defHash(have) !== H) {
        for (const k of ['name', 'kind', 'colorable', 'alpha', 'glowPower', 'glowDeep', 'orient', 'scale', 'modelRot', 'place', 'texData', 'model']) {
          if (o[k] !== undefined) have[k] = o[k];
        }
        have.rev = o.rev;
        VoxelCustom.invalidate(have);
        updated.push(have); changed = true;
      }
      continue;
    }
    if (VoxelCustom.isForgotten(H)) continue;          // この端末で消したものは戻さない
    const id = nextId();
    if (id < 0) continue;                              // 上限：無理に置き換えない
    if (o.category && !ext.categories.includes(o.category)) ext.categories.push(o.category);
    const nd = { ...o, id };
    ext.defs.push(nd);
    added.push(nd); changed = true;
  }
  if (!changed) { lastRemoteExtText = text; return 'same'; }
  if (Array.isArray(s.colorHistory) && !(ext.colorHistory && ext.colorHistory.length)) ext.colorHistory = s.colorHistory.slice(0, 12);
  saveExt();                                           // この端末の形で保存（この端末の内容を書き換えるのは、足した分だけ）
  for (const d of [...added, ...updated]) {
    try { await registerDef(d); } catch (e) { console.error(e); }
    if (window.VoxelFx) VoxelFx.apply(d);
  }
  if (updated.length) for (const e of chunks.values()) markDirty(e);
  renderInventory();
  lastRemoteExtText = text;
  return 'applied';
}
window.VoxelExt = {
  T_TRAFFIC, T_CROWD, T_SOUND, T_PHONE, TOOLS, CUSTOM_BASE, CUSTOM_MAX, ext, defRT, blockState, tiltList,
  keyOf, nextId, saveExt, renderInventory, addTilt, removeTilt, pickTarget, pushHistory, isTool, registerDef, refreshHotbarVisuals, fullExtJson, importExtJson, blobGet, blobPut: blobWriteOp, blobDel: blobDelOp, setPlaceHook,
  applyRemoteExt, hydrated: () => hydrateReady, makeModelInstance,
  // ステッキで始点と終点を選び終えているときの範囲（利益地点の設定に使う）。選んでいなければ null
  wandRange: () => { if (wand.stage !== 2) return null; const b = selBounds(); return b ? { min: b.min.slice(), max: b.max.slice() } : null; }
};

})();
