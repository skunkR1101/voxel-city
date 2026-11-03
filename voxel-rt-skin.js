/* voxel-rt-skin.js  プレイヤーのスキン（体）の表示・共有・動き（第4段階）
 *  ・自分のスキン（標準の人型／OBJ・FBXのモデル＋画像）を、部屋の全員へ送る（分けて送る・保存はしない）
 *  ・後から入った人にも届くように、新しくつながるたびに自分のスキンを送り直す
 *  ・相手の体は、UI が受け取っている位置（VoxelRTUI.remotes）に合わせて動かす（なめらかに移動・歩く動き）
 *  ・相手のスキンが届くまでは標準の人型を表示し、届いたら差し替える
 *  依存：voxel-rt-ui.js の後（部屋・位置の情報を使う）。本体の applySkin／buildCustomModel 等を借りる
 */
(function () {
'use strict';

const CHUNK = 48000;               // 1通の大きさの目安（文字数）。古い版と同じ
const MYSKIN_KEY = 'voxelcraft_myskin_v1';   // 古い版と同じ形式（モデル・画像）を読み書きする
const RESEND_GAP_MS = 2000;
const TELEPORT_DIST = 8;           // これより遠くへ一気に動いたら、なめらかにせず瞬間移動させる

let mine = null;                   // { model: { kind, text } | null, tex: dataURL | null }
let rm = null;                     // 今の部屋
let unsubLinks = null;
let lastLinks = 0;
let applySeq = 0;
const heads = new Map();           // 相手の peer -> { id, kind, mN, tN }
const chunks = new Map();          // "peer|id|m|t" -> Map(番号 -> データ)
const texCache = new Map();        // "peer|id" -> THREE.Texture | null（失敗）
const texLoading = new Set();
const bodies = new Map();          // 相手の peer -> 体の表示
let lastFrame = 0;

// ---------- 自分のスキンの読み書き ----------
function loadMine() {
  try {
    const s = JSON.parse(localStorage.getItem(MYSKIN_KEY) || 'null');
    mine = s ? { model: s.model || null, tex: s.tex || null } : null;
  } catch (e) { mine = null; }
}
function saveMine() {
  try {
    if (!mine || (!mine.model && !mine.tex)) localStorage.removeItem(MYSKIN_KEY);
    else localStorage.setItem(MYSKIN_KEY, JSON.stringify(mine));
  } catch (e) {}
}

function b64ToBuf(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
function bufToB64(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, u.subarray(i, i + CH));
  return btoa(s);
}
function parseModel(kind, text) {
  if (kind === 'fbx') {
    if (!THREE.FBXLoader) throw new Error('FBXLoader なし');
    return new THREE.FBXLoader().parse(b64ToBuf(text), '');
  }
  if (!THREE.OBJLoader) throw new Error('OBJLoader なし');
  return new THREE.OBJLoader().parse(text);
}
function niceTex(t) {
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}

// 自分の体に、保存してあるスキンを当てる（本体の applySkin を使う）
function applySelf() {
  const seq = ++applySeq;
  let root = null;
  if (mine && mine.model && mine.model.text) {
    try { root = parseModel(mine.model.kind, mine.model.text); }
    catch (e) { console.error(e); root = null; }
  }
  customRoot = root;
  const finish = () => { if (seq === applySeq) { try { applySkin(); } catch (e) { console.error(e); } } };
  if (!mine || !mine.tex) { customTex = null; finish(); return; }
  new THREE.TextureLoader().load(mine.tex, t => {
    if (seq !== applySeq) return;
    customTex = niceTex(t);
    finish();
  }, undefined, () => { if (seq === applySeq) { customTex = null; finish(); } });
}

// ---------- 自分のスキンを送る（少しずつ・詰まったら待つ） ----------
// 一度にたくさん送ると、通信の送信バッファがあふれて、途中の分が届かないため
const PACE_MS = 40;                 // 1通ごとの間隔
const CONGESTED_BYTES = 256 * 1024; // 送信待ちがこれ以上なら、少し待つ
const CONGEST_WAIT_MS = 150;
let outQ = [];                      // [キー, 中身] の送信待ち
let outTimer = null;
let pendingRestart = false;         // 送信の途中で、新しい人が入ったら、終わったあと送り直す

function splitStr(s) {
  const out = [];
  for (let i = 0; i < s.length; i += CHUNK) out.push(s.slice(i, i + CHUNK));
  return out;
}
function congested() {
  if (!rm || !rm.links) return false;
  for (const L of rm.links.values()) {
    if (L.conn && (L.conn.bufferedAmount || 0) > CONGESTED_BYTES) return true;
  }
  return false;
}
// 自分のスキンの送り直し（古い送信は止めて、最初から送る）
function enqueueSkin() {
  if (!rm || !rm.peerId) return;
  const id = Math.random().toString(36).slice(2, 8);
  const kind = mine && mine.model ? mine.model.kind : 'default';
  const mParts = splitStr(mine && mine.model ? (mine.model.text || '') : '');
  const tParts = splitStr(mine && mine.tex ? mine.tex : '');
  const self = rm.peerId;
  outQ = [];
  mParts.forEach((d, i) => outQ.push(['sk:' + self + ':' + id + ':m:' + i, { d }]));
  tParts.forEach((d, i) => outQ.push(['sk:' + self + ':' + id + ':t:' + i, { d }]));
  outQ.push(['skh:' + self, { id, kind, mN: mParts.length, tN: tParts.length }]);   // 最後に知らせる
  pumpOut(0);
}
function pumpOut(wait) {
  if (outTimer) return;
  outTimer = setTimeout(stepOut, wait);
}
function stepOut() {
  outTimer = null;
  if (!rm) { outQ = []; return; }
  if (!outQ.length) {
    if (pendingRestart) { pendingRestart = false; enqueueSkin(); }
    return;
  }
  if (congested()) { pumpOut(CONGEST_WAIT_MS); return; }
  const [key, value] = outQ.shift();
  try { rm.ephemeral(key, value); } catch (e) { console.error(e); }
  pumpOut(PACE_MS);
}

// ---------- 相手のスキンを受け取る ----------
function onChunk(key, v, meta) {
  if (!v || v.d === undefined || !meta || meta.peer === rm.peerId) return;
  const p = String(key).split(':');           // sk : 送った人 : 印 : m|t : 番号
  if (p.length !== 5) return;
  const k = p[1] + '|' + p[2] + '|' + p[3];
  let m = chunks.get(k);
  if (!m) { m = new Map(); chunks.set(k, m); }
  m.set(Number(p[4]), v.d);
}
function onHead(key, v, meta) {
  if (!v || !meta || meta.peer === rm.peerId) return;
  const peer = String(key).slice(4);          // "skh:" の後
  if (!peer) return;
  heads.set(peer, { id: String(v.id), kind: String(v.kind), mN: +v.mN || 0, tN: +v.tN || 0 });
  // 古い印のスキンは捨てる
  for (const k of [...chunks.keys()]) {
    if (k.startsWith(peer + '|') && !k.startsWith(peer + '|' + v.id + '|')) chunks.delete(k);
  }
}
function joinChunks(peer, id, kind, n) {
  if (!n) return '';
  const m = chunks.get(peer + '|' + id + '|' + kind);
  if (!m) return null;
  let s = '';
  for (let i = 0; i < n; i++) {
    const d = m.get(i);
    if (d === undefined) return null;         // まだ届いていない部分がある
    s += d;
  }
  return s;
}
// 届いているものがそろったら、そのスキンの中身を返す（そろっていなければ null）
function resolveSpec(peer) {
  const h = heads.get(peer);
  if (!h) return null;
  const mText = joinChunks(peer, h.id, 'm', h.mN);
  if (mText === null) return null;
  const tData = joinChunks(peer, h.id, 't', h.tN);
  if (tData === null) return null;
  return { key: peer + '|' + h.id, kind: h.kind, mText, tData };
}
// 相手の画像は、読み込みが終わるまで待つ（失敗したら画像なしで出す）
function getTex(key, data) {
  if (texCache.has(key)) return { ready: true, tex: texCache.get(key) };
  if (!texLoading.has(key)) {
    texLoading.add(key);
    new THREE.TextureLoader().load(data, t => {
      texCache.set(key, niceTex(t)); texLoading.delete(key);
    }, undefined, () => { texCache.set(key, null); texLoading.delete(key); });
  }
  return { ready: false, tex: null };
}

// ---------- 体の組み立て（本体の人型の作り方を借りる） ----------
function defaultFor(tex) {
  const st = customTex;
  customTex = tex || null;
  try { const d = buildDefaultModel(); applyMaterials(d.root); return { root: d.root, parts: d.parts }; }
  finally { customTex = st; }
}
function customFor(root, tex) {
  const sr = customRoot, st = customTex;
  customRoot = root;
  customTex = tex || null;
  try {
    const res = buildCustomModel();
    if (!res) return null;
    applyMaterials(res.root);
    return res;
  } finally { customRoot = sr; customTex = st; }
}
function buildFor(spec, tex) {
  if (spec.kind !== 'default' && spec.mText) {
    try {
      const root = parseModel(spec.kind, spec.mText);
      const res = customFor(root, tex);
      if (res) return res;
    } catch (e) { console.error(e); }
  }
  return defaultFor(tex);
}

function makeBody(peer) {
  const group = new THREE.Group();
  scene.add(group);
  const b = { group, parts: {}, skinKey: null, cur: null, phase: 0, amp: 0 };
  setModel(b, defaultFor(null), 'default');
  bodies.set(peer, b);
  return b;
}
function setModel(b, res, key) {
  while (b.group.children.length) b.group.remove(b.group.children[0]);
  b.group.add(res.root);
  b.parts = res.parts || {};
  b.skinKey = key;
}

// ---------- 毎フレーム：相手の体を、位置に合わせて動かす ----------
function angleDiff(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function animate(b, spd, dt) {
  const moving = spd > 0.5;
  b.amp += ((moving ? 1 : 0) - b.amp) * Math.min(1, dt * 10);
  if (moving) b.phase += dt * spd * 2.2;
  const s = Math.sin(b.phase) * 0.8 * b.amp;
  const p = b.parts;
  if (p.leftLeg) p.leftLeg.rotation.x = s;
  if (p.rightLeg) p.rightLeg.rotation.x = -s;
  if (p.leftArm) p.leftArm.rotation.x = -s * 0.8;
  if (p.rightArm) p.rightArm.rotation.x = s * 0.8;
}
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0.001, (now - (lastFrame || now)) / 1000));
  lastFrame = now;
  // 部屋を出たあとは、相手が0人として扱い、残っている体を片づける
  const remotes = (rm && typeof VoxelRTUI !== 'undefined') ? VoxelRTUI.remotes() : new Map();
  for (const [id, r] of remotes) {
    let b = bodies.get(id) || makeBody(id);
    if (!b.cur) b.cur = { x: r.x, y: r.y, z: r.z, yaw: r.yaw };
    const px = b.cur.x, pz = b.cur.z;
    const far = Math.hypot(r.x - b.cur.x, r.y - b.cur.y, r.z - b.cur.z) > TELEPORT_DIST;
    if (far) b.cur = { x: r.x, y: r.y, z: r.z, yaw: r.yaw };
    else {
      const k = Math.min(1, dt * 12);
      b.cur.x += (r.x - b.cur.x) * k;
      b.cur.y += (r.y - b.cur.y) * k;
      b.cur.z += (r.z - b.cur.z) * k;
      b.cur.yaw += angleDiff(b.cur.yaw, r.yaw) * k;
    }
    const spd = Math.hypot(b.cur.x - px, b.cur.z - pz) / Math.max(dt, 0.016);
    animate(b, spd, dt);
    b.group.position.set(b.cur.x, b.cur.y, b.cur.z);
    b.group.rotation.y = b.cur.yaw;
    // スキン：届いたものがそろったら、差し替える
    const spec = resolveSpec(id);
    if (spec && b.skinKey !== spec.key) {
      let tex = null, ready = true;
      if (spec.tData) { const g = getTex(spec.key, spec.tData); ready = g.ready; tex = g.tex; }
      if (ready) { setModel(b, buildFor(spec, tex), spec.key); }
    }
  }
  for (const [id, b] of bodies) {
    if (remotes.has(id)) continue;
    scene.remove(b.group);
    bodies.delete(id);
    heads.delete(id);
    for (const k of [...chunks.keys()]) if (k.startsWith(id + '|')) chunks.delete(k);
  }
}

// ---------- 部屋に入った・出た ----------
function detachRoom() {
  if (unsubLinks) { unsubLinks(); unsubLinks = null; }
  if (outTimer) { clearTimeout(outTimer); outTimer = null; }
  outQ = [];
  pendingRestart = false;
  if (rm && rm.handlers) { rm.handlers.delete('sk'); rm.handlers.delete('skh'); }
  rm = null;
  heads.clear();
  chunks.clear();
  lastLinks = 0;
}
function attachRoom(room) {
  detachRoom();
  if (!room) return;
  rm = room;
  rm.on('sk', onChunk);
  rm.on('skh', onHead);
  // つながりが増えたら、自分のスキンを送り直す（後から入った人にも届く）
  unsubLinks = rm.onEvent((ev, data) => {
    if (ev !== 'links' || rm !== room) return;
    if (typeof data === 'number' && data > lastLinks) { if (outQ.length) pendingRestart = true; else enqueueSkin(); }
    lastLinks = typeof data === 'number' ? data : 0;
  });
}

// ---------- 自分のスキンの変更（ファイルを選んだとき・標準に戻したとき） ----------
function readAs(file, mode) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    if (mode === 'text') r.readAsText(file);
    else if (mode === 'buf') r.readAsArrayBuffer(file);
    else r.readAsDataURL(file);
  });
}
function changed() { saveMine(); applySelf(); enqueueSkin(); }

const modelInput = document.getElementById('modelFile');
const texInput = document.getElementById('texFile');
const resetBtn = document.getElementById('skinReset');
if (modelInput) modelInput.addEventListener('change', async () => {
  const f = modelInput.files[0];
  if (!f) return;
  const ext = f.name.split('.').pop().toLowerCase();
  try {
    if (ext === 'obj') {
      const text = await readAs(f, 'text');
      mine = Object.assign({ model: null, tex: null }, mine, { model: { kind: 'obj', text } });
    } else if (ext === 'fbx') {
      const text = bufToB64(await readAs(f, 'buf'));
      mine = Object.assign({ model: null, tex: null }, mine, { model: { kind: 'fbx', text } });
    } else return;
    changed();
  } catch (e) { console.error(e); }
});
if (texInput) texInput.addEventListener('change', async () => {
  const f = texInput.files[0];
  if (!f) return;
  try {
    const tex = await readAs(f, 'url');
    mine = Object.assign({ model: null, tex: null }, mine, { tex });
    changed();
  } catch (e) { console.error(e); }
});
if (resetBtn) resetBtn.addEventListener('click', () => { mine = null; changed(); });

// ---------- 起動 ----------
loadMine();
applySelf();
if (window.VoxelRTUI && window.VoxelRTUI.onRoom) window.VoxelRTUI.onRoom(attachRoom);
requestAnimationFrame(frame);

window.VoxelRTSkin = { attachRoom, resolveSpec, splitStr, joinChunks, enqueueSkin, pending: () => outQ.length };
})();
