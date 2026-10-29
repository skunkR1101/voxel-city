// ============================================================
// 音声ブロック（範囲で1回・常にループ・タッチで鳴らす）
//  ・音声ファイルはこの端末に保存（大きさの上限なし。端末が再生できる mp3・m4a・wav・ogg など）
//  ・設定（場所・範囲・モード・間隔・ピッチ・音量）は部屋の全員に同期
//  ・鳴るかどうかは、各自の端末で「自分の位置」を見て決める＝範囲内にいる人だけに聞こえる
// 読み込み：本体 voxel-craft.html で、voxel-craft-ext.js と voxel-craft-multi.js の後に読みます
// ============================================================
(function () {
'use strict';

const VX = window.VoxelExt;
if (!VX || typeof VX.T_SOUND !== 'number') { console.error('voxel-craft-sound: 道具の番号が見つかりません'); return; }
const T_SOUND = VX.T_SOUND;

const LOCAL_KEY = 'voxelcraft_sound_v1';    // この端末のブロック設定（部屋の外でも残る）
const DB_NAME = 'voxelcraft_sound_db_v1';   // 音声ファイル（大きくても入るように IndexedDB に保存）
const LOOK_COS = Math.cos(0.15);            // 視点とブロックのずれ（約8度以内）
const LOOK_DIST = 12;                       // 視点で見つけられる距離（マス）
const TOUCH_GAP = 1500;                     // タッチで鳴らすのは、1つにつき1.5秒に1回まで
const MODES = ['enter', 'loop', 'touch'];
const RTS = ['radius', 'box'];

// ---------- 状態 ----------
const defs = new Map();        // id -> 設定
const rt = new Map();          // id -> 再生の状態（この端末の中だけ）
const audio = new Map();       // id -> { el, url, ok }（この端末の音声ファイル）
const seenTouch = new Map();   // id -> 受け取った最後のタッチ時刻
const lastTouch = new Map();   // id -> 自分が最後にタッチで鳴らした時刻
const meshes = new Map();      // id -> { speaker, range, key }
let lookId = null;             // 視点が合っている音声ブロック
let editId = null;             // 設定画面を開いている音声ブロック
let curRoom = null, sentRoom = null;

function nowTs() { return window.VoxelNet && VoxelNet.nowTs ? VoxelNet.nowTs() : Date.now(); }
function clampN(v, lo, hi, d) { const n = Number(v); if (!isFinite(n)) return d; return Math.min(hi, Math.max(lo, n)); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function isRoomOn() { return !!(window.VoxelMulti && VoxelMulti.connected && VoxelMulti.connected()); }

// 設定の形をそろえる（受け取ったものも、古いものも、同じ形にする）
function normalize(raw) {
  const pos = (Array.isArray(raw.pos) ? raw.pos : [0, 0, 0]).map(n => Math.floor(clampN(n, -1e6, 1e6, 0)));
  const a = (Array.isArray(raw.a) ? raw.a : [pos[0] - 8, pos[1] - 4, pos[2] - 8]).map(n => Math.floor(clampN(n, -1e6, 1e6, 0)));
  const b = (Array.isArray(raw.b) ? raw.b : [pos[0] + 8, pos[1] + 4, pos[2] + 8]).map(n => Math.floor(clampN(n, -1e6, 1e6, 0)));
  const every = raw.every == null || raw.every === '' ? null : clampN(raw.every, 0.5, 86400, 10);
  return {
    id: String(raw.id), pos, name: String(raw.name || '音声ブロック').slice(0, 20),
    fileName: String(raw.fileName || ''), fileSize: Number(raw.fileSize) || 0,
    mode: MODES.includes(raw.mode) ? raw.mode : 'enter',
    rt: RTS.includes(raw.rt) ? raw.rt : 'radius',
    r: clampN(raw.r, 1, 500, 8), a, b, every,
    pitch: Math.round(clampN(raw.pitch, -24, 24, 0) * 10) / 10,
    vol: Math.round(clampN(raw.vol, 0, 100, 100)),
    src: raw.src === 'room' ? 'room' : 'local', room: raw.room || null,
    ts: Number(raw.ts) || 0
  };
}
function wire(d) {  // 部屋へ送るのは設定だけ（src や room はこの端末の中の印）
  return { pos: d.pos, name: d.name, fileName: d.fileName, fileSize: d.fileSize, mode: d.mode, rt: d.rt,
    r: d.r, a: d.a, b: d.b, every: d.every, pitch: d.pitch, vol: d.vol, ts: d.ts };
}

// ---------- この端末に保存 ----------
function saveLocal() {
  try {
    const list = [...defs.values()].filter(d => d.src === 'local').map(d => ({ id: d.id, ...wire(d) }));
    localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
  } catch (e) {}
}
function loadLocal() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); } catch (e) {}
  if (!Array.isArray(list)) return;
  for (const raw of list) if (raw && typeof raw.id === 'string') defs.set(raw.id, normalize({ ...raw, src: 'local' }));
}

// ---------- 音声ファイル（IndexedDB） ----------
function dbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function fileGet(id) {
  const db = await dbOpen();
  return new Promise((res, rej) => {
    const q = db.transaction('files').objectStore('files').get(id);
    q.onsuccess = () => res(q.result || null);
    q.onerror = () => rej(q.error);
  });
}
async function filePut(id, blob) {
  const db = await dbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(blob, id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function fileDel(id) {
  const db = await dbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// この端末の音声を、再生できる形で用意する（一度用意したものは使い回す）
async function ensureAudio(d) {
  const have = audio.get(d.id);
  if (have) return have.ok ? have : null;
  const e = { el: null, url: null, ok: false };
  audio.set(d.id, e);
  let blob = null;
  try { blob = await fileGet(d.id); } catch (err) { blob = null; }
  if (audio.get(d.id) !== e) return null;          // 途中で作り直された
  if (!blob) return null;
  e.url = URL.createObjectURL(blob);
  const el = new Audio();
  el.preload = 'auto';
  el.src = e.url;
  el.onended = () => onEnded(d.id);
  e.el = el; e.ok = true;
  return e;
}
function dropAudio(id) {
  const e = audio.get(id);
  if (!e) return;
  try { if (e.el) { e.el.pause(); e.el.removeAttribute('src'); e.el.load(); } } catch (err) {}
  if (e.url) { try { URL.revokeObjectURL(e.url); } catch (err) {} }
  audio.delete(id);
}
// ピッチ（半音）と音量（%）を、音声の再生に反映する
function applyTone(el, pitch, vol) {
  el.playbackRate = Math.pow(2, pitch / 12);      // 半音単位。速さと一緒にピッチも変わる
  try { el.preservesPitch = false; el.webkitPreservesPitch = false; } catch (err) {}
  el.volume = Math.min(1, Math.max(0, vol / 100));
}

// ---------- 鳴らす ----------
async function playDef(d, tone) {
  const e = await ensureAudio(d);
  if (!e) { sndToast('「' + d.name + '」の音声がこの端末にありません（この端末で音声を選んでください）'); return; }
  const p = tone ? tone.pitch : d.pitch, v = tone ? tone.vol : d.vol;
  applyTone(e.el, p, v);
  try { e.el.currentTime = 0; } catch (err) {}
  const pr = e.el.play();
  if (pr && pr.catch) pr.catch(() => {});
}
function stopDef(id) {
  const e = audio.get(id);
  if (e && e.el) { try { e.el.pause(); } catch (err) {} }
}
// 空欄の繰り返しは、再生が終わったらもう一度鳴らす（ループモードで範囲内にいる間だけ）
function onEnded(id) {
  const d = defs.get(id), st = rt.get(id);
  if (!d || !st) return;
  if (d.mode === 'loop' && d.every == null && st.on && insideNow(d)) playDef(d);
}
let insideCache = null;  // 直近の判定（終了時の繰り返しで使う）
function insideNow(d) { return !!(insideCache && insideCache.has(d.id)); }

// 範囲に入っているか（自分の位置で判定）
function inRange(d, p) {
  if (d.rt === 'box') {
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
    return x >= Math.min(d.a[0], d.b[0]) && x <= Math.max(d.a[0], d.b[0]) &&
           y >= Math.min(d.a[1], d.b[1]) && y <= Math.max(d.a[1], d.b[1]) &&
           z >= Math.min(d.a[2], d.b[2]) && z <= Math.max(d.a[2], d.b[2]);
  }
  const dx = p.x - (d.pos[0] + 0.5), dy = p.y - (d.pos[1] + 0.5), dz = p.z - (d.pos[2] + 0.5);
  return dx * dx + dy * dy + dz * dz <= d.r * d.r;
}

// タッチ：自分が鳴らし、同じ部屋の人にも知らせる（範囲内の人だけが鳴らす）
function touchPlay(d) {
  const t = performance.now();
  if (t - (lastTouch.get(d.id) || -1e9) < TOUCH_GAP) return;
  lastTouch.set(d.id, t);
  if (typeof player !== 'undefined' && inRange(d, player.pos)) playDef(d);
  if (isRoomOn()) VoxelMulti.send('sndp:' + d.id, { t: Date.now() }, false, true);
}

// ---------- 毎回の判定（0.1秒ごと） ----------
const fwd = new THREE.Vector3();
const tmpV = new THREE.Vector3();
function findLook() {
  if (typeof camera === 'undefined' || !camera || !started) return null;
  camera.getWorldDirection(fwd);
  let best = null, bd = Infinity;
  for (const d of defs.values()) {
    tmpV.set(d.pos[0] + 0.5, d.pos[1] + 0.5, d.pos[2] + 0.5).sub(camera.position);
    const dist = tmpV.length();
    if (dist > LOOK_DIST || dist < 0.8) continue;
    tmpV.divideScalar(dist);
    if (tmpV.dot(fwd) >= LOOK_COS && dist < bd) { bd = dist; best = d.id; }
  }
  return best;
}

function logic(now) {
  syncRoom();
  lookId = findLook();
  updateLookButton();
  if (typeof player === 'undefined' || !player || !player.pos) return;
  const playing = started && !paused && !menuOpen;
  const p = player.pos;
  insideCache = new Set();
  for (const d of defs.values()) if (inRange(d, p)) insideCache.add(d.id);

  for (const d of defs.values()) {
    let st = rt.get(d.id);
    if (!st) { st = { was: false, on: false, last: 0 }; rt.set(d.id, st); }
    const inside = insideCache.has(d.id);
    if (!playing || d.mode !== 'loop') {           // ループは止める（ほかのモードは、再生中の音をそのまま）
      if (st.on) { st.on = false; stopDef(d.id); }
    }
    if (!playing) { st.was = inside; continue; }
    if (d.mode === 'enter') {
      if (inside && !st.was) playDef(d);           // 範囲に入った時だけ1回
      st.was = inside;
    } else if (d.mode === 'loop') {
      if (inside && !st.on) { st.on = true; st.last = now; playDef(d); }
      else if (!inside && st.on) { st.on = false; stopDef(d.id); }
      else if (inside && st.on && d.every != null && now - st.last >= d.every * 1000) { st.last = now; playDef(d); }
    }
    st.was = inside;
  }
}

// ---------- 部屋の出入り ----------
// 部屋の中で受け取った設定は、部屋を出たら消す（この端末で作った分は残す）
function dropRoomDef(d) {
  defs.delete(d.id);
  dropAudio(d.id);
  rt.delete(d.id);
  disposeMesh(d.id);
  if (editId === d.id) closeSettings();
}
function syncRoom() {
  const r = window.VoxelMulti && VoxelMulti.roomId ? VoxelMulti.roomId() : null;
  if (r !== curRoom) {
    curRoom = r;
    for (const d of [...defs.values()]) if (d.src === 'room' && d.room !== r) dropRoomDef(d);
  }
  const on = isRoomOn();
  if (on && sentRoom !== r) {                       // 入ったら、この端末で作った分を部屋へ送る
    sentRoom = r;
    for (const d of defs.values()) if (d.src === 'local') sendDef(d);
  }
  if (!on) sentRoom = null;
}
function sendDef(d) {
  if (isRoomOn()) VoxelMulti.send('snd:' + d.id, wire(d), false, false);
}

// ---------- 部屋からの受け取り ----------
if (window.VoxelMulti && VoxelMulti.onOp) {
  VoxelMulti.onOp('snd', rec => {
    const id = String(rec.key || '').slice(4);
    if (!id) return;
    const cur = defs.get(id);
    if (rec.del || !rec.v || typeof rec.v !== 'object') {
      if (cur) deleteDef(id, false, true);
      return;
    }
    const inc = rec.v;
    if (cur) {
      if ((Number(inc.ts) || 0) < (cur.ts || 0)) return;          // 古い知らせは無視
      const fileChanged = inc.fileName !== cur.fileName || inc.fileSize !== cur.fileSize;
      Object.assign(cur, normalize({ ...inc, id, src: cur.src, room: cur.room }));
      if (fileChanged) dropAudio(id);
      if (cur.src === 'local') saveLocal();
      refreshMesh(cur);
      if (editId === id) closeSettings();
      return;
    }
    const d = normalize({ ...inc, id, src: 'room', room: VoxelMulti.roomId() });
    defs.set(id, d);
    refreshMesh(d);
  });
  VoxelMulti.onOp('sndp', rec => {                  // タッチの知らせ（記録には残らない）
    if (rec.del || !rec.v) return;
    const id = String(rec.key || '').slice(5);
    const d = defs.get(id);
    if (!d || d.mode !== 'touch') return;
    const t = Number(rec.v.t) || 0;
    if (t <= (seenTouch.get(id) || 0)) return;
    seenTouch.set(id, t);
    if (typeof player !== 'undefined' && started && !paused && !menuOpen && inRange(d, player.pos)) playDef(d);
  });
}

// ---------- 置く・消す ----------
function newId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function placeHere() {
  if (!started || paused || menuOpen) return;
  if (!window.VoxelRoad || !VoxelRoad.surfacePoint) { sndToast('道路の部品が読み込めていません'); return; }
  const g = VoxelRoad.surfacePoint();
  if (!g) { sndToast('地面に向けてタップしてください'); return; }
  const pos = [Math.floor(g.x), Math.floor(g.y + 0.01), Math.floor(g.z)];
  for (const d of defs.values()) {
    if (d.pos[0] === pos[0] && d.pos[1] === pos[1] && d.pos[2] === pos[2]) { openSettings(d.id); return; }
  }
  const id = newId();
  const d = normalize({
    id, pos, name: '音声ブロック', mode: 'enter', rt: 'radius', r: 8,
    a: [pos[0] - 8, pos[1] - 4, pos[2] - 8], b: [pos[0] + 8, pos[1] + 4, pos[2] + 8],
    every: null, pitch: 0, vol: 100, src: 'local', ts: nowTs()
  });
  defs.set(id, d);
  saveLocal();
  sendDef(d);
  refreshMesh(d);
  openSettings(id);
}
function deleteDef(id, notify, keepFile) {
  const d = defs.get(id);
  if (!d) return;
  defs.delete(id);
  dropAudio(id);
  rt.delete(id);
  disposeMesh(id);
  if (!keepFile) { fileDel(id).catch(() => {}); }
  if (d.src === 'local') saveLocal();
  if (notify !== false && isRoomOn()) VoxelMulti.send('snd:' + id, null, true, false);
  if (editId === id) closeSettings();
}

// ---------- 見た目（スピーカーと、範囲の線） ----------
let sndMat = null, sndConeMat = null;
function ensureMesh(d) {
  let m = meshes.get(d.id);
  if (m) return m;
  if (!sndMat) {
    sndMat = new THREE.MeshLambertMaterial({ color: 0x33475b });
    sndConeMat = new THREE.MeshLambertMaterial({ color: 0xffd45a, emissive: 0x332200 });
  }
  const speaker = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), sndMat);
  const cone = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), sndConeMat);
  cone.position.set(0, 0, 0.32);
  speaker.add(box, cone);
  speaker.position.set(d.pos[0] + 0.5, d.pos[1] + 0.5, d.pos[2] + 0.5);
  scene.add(speaker);
  m = { speaker, range: null, key: '' };
  meshes.set(d.id, m);
  return m;
}
function rangeKey(d) { return d.rt + ':' + (d.rt === 'box' ? d.a.concat(d.b).join(',') : d.r); }
function refreshMesh(d) {
  if (!meshes.has(d.id)) return;
  const m = meshes.get(d.id);
  if (m.range) { scene.remove(m.range); m.range.geometry.dispose(); m.range.material.dispose(); m.range = null; m.key = ''; }
}
function disposeMesh(id) {
  const m = meshes.get(id);
  if (!m) return;
  scene.remove(m.speaker);
  if (m.range) { scene.remove(m.range); m.range.geometry.dispose(); m.range.material.dispose(); }
  meshes.delete(id);
}
function buildRange(d) {
  const mat = new THREE.LineBasicMaterial({ color: 0xffd45a, transparent: true, opacity: 0.85 });
  let obj;
  if (d.rt === 'box') {
    const x1 = Math.min(d.a[0], d.b[0]), x2 = Math.max(d.a[0], d.b[0]) + 1;
    const y1 = Math.min(d.a[1], d.b[1]), y2 = Math.max(d.a[1], d.b[1]) + 1;
    const z1 = Math.min(d.a[2], d.b[2]), z2 = Math.max(d.a[2], d.b[2]) + 1;
    const bg = new THREE.BoxGeometry(x2 - x1, y2 - y1, z2 - z1);
    const eg = new THREE.EdgesGeometry(bg);
    bg.dispose();
    obj = new THREE.LineSegments(eg, mat);
    obj.position.set((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2);
  } else {
    const sg = new THREE.SphereGeometry(d.r, 20, 12);
    const wg = new THREE.WireframeGeometry(sg);
    sg.dispose();
    mat.opacity = 0.45;
    obj = new THREE.LineSegments(wg, mat);
    obj.position.set(d.pos[0] + 0.5, d.pos[1] + 0.5, d.pos[2] + 0.5);
  }
  obj.frustumCulled = false;
  return obj;
}
function render() {
  const hold = typeof HOTBAR !== 'undefined' && HOTBAR[selIdx] === T_SOUND;
  for (const d of defs.values()) {
    const m = ensureMesh(d);
    const show = hold || editId === d.id;
    if (!show) { if (m.range) m.range.visible = false; continue; }
    const k = rangeKey(d);
    if (!m.range || m.key !== k) {
      if (m.range) { scene.remove(m.range); m.range.geometry.dispose(); m.range.material.dispose(); }
      m.range = buildRange(d);
      scene.add(m.range);
      m.key = k;
    }
    m.range.visible = true;
  }
}

// ---------- 視点が合ったときの「設定」ボタン ----------
let lookBtn = null, toastEl = null, toastT = null;
function sndToast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.style.display = 'block';
  clearTimeout(toastT);
  toastT = setTimeout(() => { toastEl.style.display = 'none'; }, 2800);
}
function updateLookButton() {
  if (!lookBtn) return;
  const show = lookId != null && started && !paused && !menuOpen;
  if (!show) { lookBtn.style.display = 'none'; return; }
  const d = defs.get(lookId);
  lookBtn.textContent = '🔊 ' + (d ? d.name : '音声') + ' を設定';
  lookBtn.style.display = 'block';
}

// ---------- 設定画面 ----------
let panelEl = null;
function ensurePanel() {
  if (panelEl) return panelEl;
  panelEl = document.createElement('div');
  panelEl.id = 'sndPanel';
  document.body.appendChild(panelEl);
  panelEl.addEventListener('click', e => { if (e.target === panelEl) closeSettings(); });
  panelEl.addEventListener('pointerdown', e => e.stopPropagation());
  return panelEl;
}
function openSettings(id) {
  const d = defs.get(id);
  if (!d) return;
  editId = id;
  const p = ensurePanel();
  const box = v => `value="${esc(v)}"`;
  const mopt = MODES.map(m => `<option value="${m}" ${d.mode === m ? 'selected' : ''}>${{ enter: '範囲に入ったら1回鳴らす', loop: '範囲内で繰り返し鳴らす（ループ）', touch: 'タッチ・クリックで鳴らす' }[m]}</option>`).join('');
  const ropt = RTS.map(r => `<option value="${r}" ${d.rt === r ? 'selected' : ''}>${{ radius: 'このブロックから何マス聞こえるか', box: '始点と終点の座標で指定' }[r]}</option>`).join('');
  p.innerHTML = `<div class="box">
    <h3>🔊 音声ブロックの設定</h3>
    <label>名前<input id="snName" type="text" maxlength="20" ${box(d.name)}></label>
    <label>音声ファイル（mp3・m4a・wav・ogg など。大きくても大丈夫）
      <input id="snFile" type="file" accept="audio/*"></label>
    <div class="note" id="snFileInfo"></div>
    <label>モード<select id="snMode">${mopt}</select></label>
    <div class="note" id="snModeNote"></div>
    <label>範囲の決め方<select id="snRt">${ropt}</select></label>
    <div id="snRadiusBox"><label>範囲（このブロックから何マス）<input id="snR" type="number" min="1" max="500" step="0.5" ${box(d.r)}></label></div>
    <div id="snBoxBox">
      <div class="note">始点（X・Y・Z）</div>
      <div class="row6"><input id="snAx" type="number" step="1" ${box(d.a[0])}><input id="snAy" type="number" step="1" ${box(d.a[1])}><input id="snAz" type="number" step="1" ${box(d.a[2])}></div>
      <div class="note">終点（X・Y・Z）</div>
      <div class="row6"><input id="snBx" type="number" step="1" ${box(d.b[0])}><input id="snBy" type="number" step="1" ${box(d.b[1])}><input id="snBz" type="number" step="1" ${box(d.b[2])}></div>
    </div>
    <div id="snLoopBox"><label>鳴らす間隔（秒）<input id="snEvery" type="number" min="0.5" step="0.5" placeholder="空欄＝再生が終わるたびに繰り返す" ${d.every == null ? '' : box(d.every)}></label></div>
    <label>ピッチ（半音。+12で1オクターブ高く、-12で低く）<input id="snPitch" type="number" min="-24" max="24" step="0.1" ${box(d.pitch)}></label>
    <div class="note" id="snPitchInfo"></div>
    <label>音量（%）<input id="snVol" type="number" min="0" max="100" step="1" ${box(d.vol)}></label>
    <div class="btns">
      <button id="snTest" class="sub">テスト再生</button>
      <button id="snSave">保存</button>
      <button id="snDel" class="danger">削除</button>
      <button id="snClose" class="sub">閉じる</button>
    </div>
  </div>`;
  p.classList.add('show');
  menuOpen = true;
  if (typeof releaseActions === 'function') releaseActions();
  for (const k in keys) keys[k] = false;
  if (document.pointerLockElement) document.exitPointerLock();

  const $ = s => document.getElementById(s);
  const refreshForm = () => {
    const m = $('snMode').value, r = $('snRt').value;
    $('snRadiusBox').style.display = r === 'radius' ? '' : 'none';
    $('snBoxBox').style.display = r === 'box' ? '' : 'none';
    $('snLoopBox').style.display = m === 'loop' ? '' : 'none';
    $('snModeNote').textContent = m === 'enter' ? '範囲に入ったとき1回鳴ります。出て、もう一度入ると、また鳴ります。'
      : m === 'loop' ? '範囲にいる間、指定した間隔で鳴り続けます。' : '視点を合わせてタッチ（クリック）すると、範囲内の全員に鳴ります。';
    const pit = clampN($('snPitch').value, -24, 24, 0);
    $('snPitchInfo').textContent = '再生の速さ ×' + Math.pow(2, pit / 12).toFixed(3) + '（ピッチとあわせて変わります）';
  };
  const fileInfo = () => {
    const cur = defs.get(id);
    if (!cur) return;
    $('snFileInfo').innerHTML = cur.fileName
      ? '今の音声：' + esc(cur.fileName) + '（' + (cur.fileSize / 1048576).toFixed(2) + ' MB）' + (audio.get(id) && audio.get(id).ok ? '' : '<br><span class="warn">※この端末にはまだ音声がありません。ファイルを選ぶと、この端末でも鳴ります</span>')
      : '<span class="warn">音声ファイルが未設定です</span>';
  };
  fileInfo();
  refreshForm();
  ['snMode', 'snRt', 'snPitch'].forEach(s => $(s).addEventListener('input', refreshForm));
  $('snMode').addEventListener('change', refreshForm);
  $('snRt').addEventListener('change', refreshForm);

  $('snFile').addEventListener('change', async () => {
    const f = $('snFile').files && $('snFile').files[0];
    if (!f) return;
    const cur = defs.get(id);
    if (!cur) return;
    const probe = document.createElement('audio');
    const ok = probe.canPlayType(f.type || 'audio/mpeg');
    try {
      await filePut(id, f);
      dropAudio(id);
      cur.fileName = f.name; cur.fileSize = f.size; cur.ts = nowTs();
      if (cur.src === 'local') saveLocal();
      sendDef(cur);
      fileInfo();
      sndToast(ok ? '音声を登録しました' : '音声を登録しました（この端末では再生できない形式の可能性があります。mp3・m4a・wav を試してください）');
    } catch (err) {
      sndToast('音声の登録に失敗しました：' + (err && err.message ? err.message : err));
    }
  });

  $('snTest').addEventListener('click', async () => {
    const cur = defs.get(id);
    if (!cur) return;
    const tone = { pitch: clampN($('snPitch').value, -24, 24, 0), vol: clampN($('snVol').value, 0, 100, 100) };
    playDef(cur, tone);
  });
  $('snSave').addEventListener('click', () => {
    const cur = defs.get(id);
    if (!cur) return;
    const rtv = $('snRt').value;
    const pos = cur.pos;
    const every = $('snEvery') ? $('snEvery').value.trim() : '';
    const next = normalize({
      ...wire(cur), id, src: cur.src, room: cur.room,
      name: $('snName').value.trim() || '音声ブロック',
      mode: $('snMode').value, rt: rtv,
      r: clampN($('snR').value, 1, 500, 8),
      a: [$('snAx').value, $('snAy').value, $('snAz').value].map(v => Math.floor(clampN(v, -1e6, 1e6, pos[0]))),
      b: [$('snBx').value, $('snBy').value, $('snBz').value].map(v => Math.floor(clampN(v, -1e6, 1e6, pos[0]))),
      every: every === '' ? null : clampN(every, 0.5, 86400, 10),
      pitch: clampN($('snPitch').value, -24, 24, 0),
      vol: clampN($('snVol').value, 0, 100, 100),
      ts: nowTs()
    });
    Object.assign(cur, next);
    if (cur.mode !== 'loop') { const st = rt.get(id); if (st && st.on) { st.on = false; stopDef(id); } }
    if (cur.src === 'local') saveLocal();
    sendDef(cur);
    refreshMesh(cur);
    sndToast('保存しました');
    closeSettings();
  });
  $('snDel').addEventListener('click', () => {
    if (!confirm('この音声ブロックを削除しますか？')) return;
    deleteDef(id, true);
  });
  $('snClose').addEventListener('click', () => closeSettings());
}
function closeSettings() {
  if (!panelEl) return;
  panelEl.classList.remove('show');
  editId = null;
  menuOpen = false;
  if (!isTouch && started) { const pr = canvas.requestPointerLock && canvas.requestPointerLock(); if (pr && pr.catch) pr.catch(() => {}); }
}

// ---------- 組み込み（道具を持ったときだけ、タップ・長押しを音声の操作にする） ----------
const origPlace = window.doPlace, origBreak = window.doBreak, origStart = window.startAct;
const holdingSnd = () => HOTBAR[selIdx] === T_SOUND;
const canAct = () => started && !menuOpen && !paused;
window.doPlace = function () {
  if (holdingSnd()) { if (canAct()) placeHere(); return; }
  if (lookId != null && canAct()) {                 // 視点を合わせたタッチ型の音声ブロックは、タッチで鳴らす（置かない）
    const d = defs.get(lookId);
    if (d && d.mode === 'touch') { touchPlay(d); return; }
  }
  return origPlace.apply(this, arguments);
};
window.doBreak = function () {
  if (holdingSnd()) {
    if (canAct() && lookId != null) {
      const d = defs.get(lookId);
      if (d && confirm('「' + d.name + '」を削除しますか？')) deleteDef(d.id, true);
    }
    return;
  }
  return origBreak.apply(this, arguments);
};
window.startAct = function (kind) {
  if (holdingSnd()) {
    if (kind === 'place') { if (canAct()) placeHere(); return; }   // 押し続けても1回だけ
    if (kind === 'break') { window.doBreak(); return; }
  }
  return origStart.apply(this, arguments);
};

// 音が出せない端末で、最初のタッチ（操作）のときに鳴らす準備をする
window.addEventListener('pointerdown', () => {
  for (const e of audio.values()) {
    if (!e.el || !e.el.paused || e.unl) continue;
    e.unl = true;
    const pr = e.el.play();
    if (pr && pr.then) pr.then(() => e.el.pause()).catch(() => {});
  }
}, { passive: true });

// ---------- 画面の部品と、毎フレーム ----------
function buildDom() {
  const st = document.createElement('style');
  st.textContent = `
#sndPanel{position:fixed;inset:0;z-index:97;display:none;align-items:center;justify-content:center;background:rgba(5,10,18,.6)}
#sndPanel.show{display:flex}
#sndPanel .box{width:min(92vw,420px);max-height:88vh;overflow:auto;background:#14202e;color:#fff;border-radius:12px;padding:16px;font-family:sans-serif;font-size:14px;box-sizing:border-box;box-shadow:0 8px 24px rgba(0,0,0,.5)}
#sndPanel h3{margin:0 0 10px;font-size:17px}
#sndPanel label{display:block;margin:9px 0}
#sndPanel input,#sndPanel select{width:100%;box-sizing:border-box;padding:7px;border-radius:6px;border:1px solid #3a4d66;background:#0d1622;color:#fff;font-size:15px;margin-top:3px}
#sndPanel .row6{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:4px 0}
#sndPanel .note{font-size:12px;opacity:.85;margin:4px 0}
#sndPanel .warn{color:#ffb86b}
#sndPanel .btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
#sndPanel .btns button{flex:1;min-width:80px;padding:10px;border:0;border-radius:8px;background:#3d9be0;color:#fff;font-size:15px}
#sndPanel .btns button.sub{background:#34465c}
#sndPanel .btns button.danger{background:#b5423a}
#sndLookBtn{position:fixed;right:14px;top:42%;z-index:60;display:none;padding:10px 14px;border:0;border-radius:10px;background:rgba(20,32,46,.88);color:#fff;font-size:15px;box-shadow:0 2px 8px rgba(0,0,0,.4)}
#sndToast{position:fixed;left:50%;top:14%;transform:translateX(-50%);z-index:70;display:none;background:rgba(0,0,0,.78);color:#fff;padding:8px 14px;border-radius:8px;font-size:14px;max-width:90vw;text-align:center;box-sizing:border-box}`;
  document.head.appendChild(st);
  lookBtn = document.createElement('button');
  lookBtn.id = 'sndLookBtn';
  ['pointerdown', 'touchstart', 'mousedown'].forEach(ev => lookBtn.addEventListener(ev, e => e.stopPropagation()));
  lookBtn.addEventListener('click', () => { if (lookId != null) openSettings(lookId); });
  document.body.appendChild(lookBtn);
  toastEl = document.createElement('div');
  toastEl.id = 'sndToast';
  document.body.appendChild(toastEl);
}

let lastLogic = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (now - lastLogic >= 100) {
    lastLogic = now;
    try { logic(now); } catch (err) { console.error(err); }
  }
  try { render(); } catch (err) { console.error(err); }
}

function init() {
  buildDom();
  loadLocal();
  for (const d of defs.values()) ensureMesh(d);
  requestAnimationFrame(frame);
}
if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);

window.VoxelSound = {
  list: () => [...defs.values()].map(d => ({ id: d.id, name: d.name, mode: d.mode, src: d.src })),
  lookId: () => lookId
};
})();
