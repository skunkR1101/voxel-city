/* voxel-craft-train.js  (v2.1)
 * カスタム列車エディット（本体HTML・ext・road は変更しない）
 *  ・車両の作成・編集（N キー）
 *     ・OBJモデル＋テクスチャ、車両の長さ（既定20m）
 *     ・追加パーツ（ガラスなど）と透過方式（そのまま透過／半透明を発光）
 *     ・当たり判定（壁・床・座席）を複数追加。3Dプレビューで矢印をつかんで移動・拡大縮小
 *     ・アニメーション（Blockbench のJSON読み込み、またはエディタ内で作成）
 *     ・VVVF加減速音（加速・減速のファイル、分割数は既定120）
 *  ・編成と運行（B キー／画面の「▶ 運行」ボタン）
 *     ・画面のボタン（加速・減速・非常・運行終了）だけでも運転できます
 */
(function () {
'use strict';

const LIB_KEY = 'voxelcraft_train_v1';
const ROAD_KEY = 'voxelcraft_road_v1';
const GAP = 0.4;
const DEG = Math.PI / 180;
const V3 = THREE.Vector3;
const QQ = THREE.Quaternion;
const GIZMO_URL = 'https://unpkg.com/three@0.128.0/examples/js/controls/TransformControls.js';

const lib = { cars: [], comp: [], maxKmh: 120 };
const built = new Map();
const audioCache = new Map();
let selId = null;
let trainOpen = false;
let run = null;
let actx = null, masterGain = null;
let prev = null;
let trnToastEl = null, trnToastT = 0;
const ctl = { acc: false, brk: false, emg: false };

function tmsg(m) {
  if (!trnToastEl) return;
  trnToastEl.textContent = m;
  trnToastEl.classList.add('show');
  clearTimeout(trnToastT);
  trnToastT = setTimeout(() => trnToastEl.classList.remove('show'), 2600);
}
function uid() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function newCar(name) {
  return {
    id: uid(), name: name || '車両', length: 20,
    main: { data: null, tex: null, mode: 'passthrough' },
    extras: [],
    parts: {},
    hitboxes: [],
    anims: {},
    vvvf: { enabled: false, accel: null, decel: null, divisions: 120 }
  };
}
function carById(id) { return lib.cars.find(c => c.id === id); }
function touchCar(id) { built.delete(id); }

function saveLib() {
  try {
    localStorage.setItem(LIB_KEY, JSON.stringify({ cars: lib.cars, comp: lib.comp, maxKmh: lib.maxKmh }));
    return true;
  } catch (e) {
    tmsg('保存できませんでした（ファイルが大きすぎる可能性があります）');
    return false;
  }
}
function loadLib() {
  try {
    const s = JSON.parse(localStorage.getItem(LIB_KEY) || '{}');
    if (Array.isArray(s.cars)) lib.cars = s.cars;
    if (Array.isArray(s.comp)) lib.comp = s.comp.filter(id => carById(id));
    if (typeof s.maxKmh === 'number') lib.maxKmh = clamp(s.maxKmh, 20, 300);
  } catch (e) {}
}

// ============================================================
// 読み込みユーティリティ
// ============================================================
function fileAsText(f) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(f); }); }
function fileAsUrl(f) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); }); }
function texFromUrl(url) {
  return new Promise(res => {
    new THREE.TextureLoader().load(url, t => {
      t.magFilter = THREE.NearestFilter; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
      res(t);
    }, undefined, () => res(null));
  });
}
function loadScript(url) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = url; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}
let gizmoReady = null;
function ensureGizmo() {
  if (THREE.TransformControls) return Promise.resolve(true);
  if (!gizmoReady) gizmoReady = loadScript(GIZMO_URL).then(() => !!THREE.TransformControls, () => false);
  return gizmoReady;
}
function measure(obj) {
  const w = new THREE.Group();
  w.add(obj);
  w.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(w);
  w.remove(obj);
  return { size: b.getSize(new V3()), box: b };
}

function applyMode(obj, tex, mode) {
  obj.traverse(o => {
    if (!o.isMesh) return;
    const old = Array.isArray(o.material) ? o.material[0] : o.material;
    const map = tex || (old && old.map) || null;
    const color = old && old.color ? old.color.clone() : new THREE.Color(0xbbbbbb);
    if (mode === 'emissive') {
      o.material = new THREE.MeshBasicMaterial({
        map, color, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending
      });
    } else {
      o.material = new THREE.MeshLambertMaterial({ map, color, alphaTest: 0.5, side: THREE.DoubleSide });
      o.material.userData.baseColor = color.clone();
    }
  });
}

// ============================================================
// 車両の組み立て
// ============================================================
async function buildCar(car) {
  if (built.has(car.id)) return built.get(car.id);
  const root = new THREE.Group();
  const parts = new Map();
  const L = Math.max(car.length || 20, 0.5);
  let s = 1;
  let mainRoot = null;

  if (car.main.data) {
    mainRoot = new THREE.OBJLoader().parse(car.main.data);
    const tex = car.main.tex ? await texFromUrl(car.main.tex) : null;
    const m = measure(mainRoot);
    s = L / Math.max(m.size.z, 1e-3);
    mainRoot.scale.setScalar(s);
    const wrap = new THREE.Group();
    wrap.add(mainRoot);
    wrap.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(wrap);
    const c = b.getCenter(new V3());
    mainRoot.position.set(-c.x, -b.min.y, -c.z);
    applyMode(mainRoot, tex, car.main.mode || 'passthrough');
  } else {
    mainRoot = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2.8, 3.5, L), new THREE.MeshLambertMaterial({ color: 0x4a7bd6 }));
    mesh.position.set(0, 1.75, 0);
    mainRoot.add(mesh);
  }
  root.add(mainRoot);
  root.updateMatrixWorld(true);

  for (const c of [...mainRoot.children]) {
    if (!c.name) continue;
    const bb = new THREE.Box3().setFromObject(c);
    const ctr = bb.getCenter(new V3());
    const pv = car.parts[c.name] && car.parts[c.name].pivot
      ? new V3(...car.parts[c.name].pivot)
      : new V3(ctr.x, bb.min.y, ctr.z);
    const piv = new THREE.Group();
    piv.position.copy(pv);
    piv.userData.partName = c.name;
    piv.userData.rest = pv.clone();
    root.add(piv);
    piv.attach(c);
    parts.set(c.name, piv);
  }

  for (const ex of car.extras || []) {
    if (!ex.data) continue;
    const eo = new THREE.OBJLoader().parse(ex.data);
    const tex = ex.tex ? await texFromUrl(ex.tex) : null;
    eo.scale.setScalar(s);
    eo.position.copy(mainRoot.position);
    applyMode(eo, tex, ex.mode || 'passthrough');
    root.add(eo);
  }

  const res = { root, parts, length: L };
  built.set(car.id, res);
  return res;
}
function partsOf(root) {
  const m = new Map();
  root.traverse(o => { if (o.userData && o.userData.partName) m.set(o.userData.partName, o); });
  return m;
}

// ============================================================
// アニメーション
// ============================================================
function vecOf(v) {
  if (Array.isArray(v)) return v.slice(0, 3).map(Number);
  if (v && typeof v === 'object') {
    const x = v.post || v.pre || v.vector;
    if (Array.isArray(x)) return x.slice(0, 3).map(Number);
  }
  return null;
}
function trackOf(obj, scalePos) {
  if (!obj || typeof obj !== 'object') return [];
  const arr = [];
  for (const k of Object.keys(obj)) {
    const v = vecOf(obj[k]);
    if (v) arr.push([Number(k), scalePos ? v.map(x => x / 16) : v]);
  }
  return arr.sort((a, b) => a[0] - b[0]);
}
function importAnimJson(text) {
  const j = JSON.parse(text);
  const src = j.animations || j;
  const out = {};
  for (const name of Object.keys(src)) {
    const a = src[name];
    const lp = a.loop;
    out[name] = {
      length: Number(a.animation_length) || 1,
      loop: lp === true || lp === 'loop' || lp === 'true',
      bones: {}, mats: {}
    };
    for (const bn of Object.keys(a.bones || {})) {
      const b = a.bones[bn];
      out[name].bones[bn] = { rot: trackOf(b.rotation, false), pos: trackOf(b.position, true) };
    }
  }
  return out;
}
function sampleArr(arr, t) {
  if (!arr || !arr.length) return null;
  if (t <= arr[0][0]) return arr[0][1];
  const last = arr[arr.length - 1];
  if (t >= last[0]) return last[1];
  for (let i = 0; i < arr.length - 1; i++) {
    const a = arr[i], b = arr[i + 1];
    if (t >= a[0] && t <= b[0]) {
      const f = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
      if (typeof a[1] === 'number') return a[1] + (b[1] - a[1]) * f;
      return a[1].map((x, k) => x + (b[1][k] - x) * f);
    }
  }
  return last[1];
}
function setEmissive(piv, v) {
  piv.userData.emi = v;
  piv.traverse(o => {
    if (!o.isMesh || !o.material) return;
    const m = o.material;
    if (m.emissive) m.emissive.setRGB(v, v, v);
    else if (m.userData && m.userData.baseColor) m.color.copy(m.userData.baseColor).multiplyScalar(0.5 + v);
  });
}
function applyAnims(car, parts, t) {
  for (const p of parts.values()) {
    p.rotation.set(0, 0, 0);
    p.position.copy(p.userData.rest);
  }
  for (const name of Object.keys(car.anims || {})) {
    const a = car.anims[name];
    const tt = a.loop ? (t % a.length) : Math.min(t, a.length);
    for (const bn of Object.keys(a.bones || {})) {
      const p = parts.get(bn);
      if (!p) continue;
      const r = sampleArr(a.bones[bn].rot, tt);
      if (r) p.rotation.set(r[0] * DEG, r[1] * DEG, r[2] * DEG);
      const q = sampleArr(a.bones[bn].pos, tt);
      if (q) p.position.copy(p.userData.rest).add(new V3(q[0], q[1], q[2]));
    }
    for (const mn of Object.keys(a.mats || {})) {
      const p = parts.get(mn);
      if (!p) continue;
      const v = sampleArr(a.mats[mn].emi, tt);
      if (v !== null) setEmissive(p, v);
    }
  }
}

// 任意のアニメーションを、それぞれ指定した時刻で再生する（駅のドア・幕の制御用）
// tMap: { アニメーション名: 再生時刻 }。書かれていないアニメーションは基準の姿勢のまま
function applyAnimsEx(car, parts, tMap) {
  for (const p of parts.values()) {
    p.rotation.set(0, 0, 0);
    p.position.copy(p.userData.rest);
  }
  for (const name of Object.keys(tMap || {})) {
    const a = car.anims && car.anims[name];
    if (!a) continue;
    const tt = tMap[name];
    for (const bn of Object.keys(a.bones || {})) {
      const p = parts.get(bn);
      if (!p) continue;
      const r = sampleArr(a.bones[bn].rot, tt);
      if (r) p.rotation.set(r[0] * DEG, r[1] * DEG, r[2] * DEG);
      const q = sampleArr(a.bones[bn].pos, tt);
      if (q) p.position.copy(p.userData.rest).add(new V3(q[0], q[1], q[2]));
    }
    for (const mn of Object.keys(a.mats || {})) {
      const p = parts.get(mn);
      if (!p) continue;
      const v = sampleArr(a.mats[mn].emi, tt);
      if (v !== null) setEmissive(p, v);
    }
  }
}

// ============================================================
// VVVF 加減速音
// ============================================================
function ensureAudio() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return actx; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  actx = new AC();
  masterGain = actx.createGain();
  masterGain.gain.value = 0.8;
  masterGain.connect(actx.destination);
  return actx;
}
async function decodeCached(url) {
  const key = url;
  if (audioCache.has(key)) return audioCache.get(key);
  const buf = await (await fetch(url)).arrayBuffer();
  const dec = await actx.decodeAudioData(buf);
  audioCache.set(key, dec);
  return dec;
}
function makeVvvfChannel(car) {
  const v = car.vvvf;
  if (!v || !v.enabled || !v.accel || !v.decel) return null;
  const out = actx.createGain();
  out.connect(masterGain);
  const aGain = actx.createGain(), dGain = actx.createGain();
  aGain.connect(out); dGain.connect(out);
  aGain.gain.value = 0; dGain.gain.value = 0;
  // 減速音は「高速→低速」の録音として扱う（時間の向きが加速音と逆）
  return { N: Math.max(1, Math.round(v.divisions || 120)), out, aGain, dGain, aBuf: null, dBuf: null, aSrc: null, dSrc: null, idx: -1 };
}
function startChannel(ch, aBuf, dBuf) {
  ch.aBuf = aBuf; ch.dBuf = dBuf;
  ch.aSrc = actx.createBufferSource();
  ch.aSrc.buffer = aBuf; ch.aSrc.loop = true;
  ch.aSrc.connect(ch.aGain); ch.aSrc.start();
  ch.dSrc = actx.createBufferSource();
  ch.dSrc.buffer = dBuf; ch.dSrc.loop = true;
  ch.dSrc.connect(ch.dGain); ch.dSrc.start();
}
function updateChannel(ch, kmh, throttle, brake) {
  if (!ch || !ch.aSrc) return;
  const idx = clamp(Math.floor(kmh / Math.max(1, lib.maxKmh) * ch.N), 0, ch.N - 1);
  if (idx !== ch.idx) {
    ch.idx = idx;
    const sa = ch.aBuf.duration / ch.N, sd = ch.dBuf.duration / ch.N;
    ch.aSrc.loopStart = idx * sa; ch.aSrc.loopEnd = (idx + 1) * sa;
    // 減速音は高速→低速の録音なので、速度の区切りを反転して対応させる
    // （高速時は録音の前半、低速時は後半を使う）
    const di = ch.N - 1 - idx;
    ch.dSrc.loopStart = di * sd; ch.dSrc.loopEnd = (di + 1) * sd;
  }
  const now = actx.currentTime;
  ch.aGain.gain.setTargetAtTime(kmh > 0.5 && throttle ? 1 : (kmh > 0.5 && !brake ? 0.2 : 0), now, 0.15);
  ch.dGain.gain.setTargetAtTime(kmh > 0.5 && brake ? 1 : 0, now, 0.15);
}
function stopChannel(ch) {
  if (!ch) return;
  try { if (ch.aSrc) ch.aSrc.stop(); if (ch.dSrc) ch.dSrc.stop(); } catch (e) {}
  ch.out.disconnect();
}

// ============================================================
// 線路（保存データから道筋を作る）
// ============================================================
function fwdOf(q) { return new V3(0, 0, 1).applyQuaternion(new QQ(q[0], q[1], q[2], q[3])); }
function buildRoute(startPos) {
  let raw;
  try { raw = JSON.parse(localStorage.getItem(ROAD_KEY) || '{}'); } catch (e) { return null; }
  const pieces = (raw.pieces || []).filter(p => p.kind === 'rail');
  if (!pieces.length) return null;
  const groups = new Map();
  for (const p of pieces) {
    if (!groups.has(p.g)) groups.set(p.g, []);
    groups.get(p.g).push(p);
  }
  for (const arr of groups.values()) arr.sort((a, b) => a.ph - b.ph);
  const ends = gid => {
    const arr = groups.get(gid);
    const f = arr[0], l = arr[arr.length - 1];
    const ff = fwdOf(f.q), fl = fwdOf(l.q);
    return {
      start: new V3(f.x, f.y, f.z).addScaledVector(ff, -f.l / 2),
      end: new V3(l.x, l.y, l.z).addScaledVector(fl, l.l / 2),
      fStart: ff.clone(), fEnd: fl.clone()
    };
  };
  let best = null, bd = 1e9;
  for (const p of pieces) {
    const d = Math.hypot(p.x - startPos.x, p.z - startPos.z) + Math.abs(p.y - startPos.y) * 0.5;
    if (d < bd) { bd = d; best = p; }
  }
  if (!best) return null;
  const segs = [];
  const visited = new Set();
  const e0 = ends(best.g);
  const rev0 = fwdOf(best.q).dot(e0.fStart) < 0;
  segs.push({ g: best.g, rev: rev0 });
  visited.add(best.g);
  for (let guard = 0; guard < 400; guard++) {
    const cur = segs[segs.length - 1];
    const e = ends(cur.g);
    const exitPos = cur.rev ? e.start : e.end;
    const exitDir = cur.rev ? e.fStart.clone().negate() : e.fEnd;
    let cand = null, cd = 1e9;
    for (const [gid] of groups) {
      if (visited.has(gid)) continue;
      const o = ends(gid);
      for (const which of ['start', 'end']) {
        const dd = o[which].distanceTo(exitPos);
        if (dd > 0.8) continue;
        const enterDir = which === 'start' ? o.fStart : o.fEnd.clone().negate();
        const score = -exitDir.dot(enterDir) + dd * 0.01;
        if (score < cd) { cd = score; cand = { g: gid, rev: which === 'end' }; }
      }
    }
    if (!cand) break;
    segs.push(cand);
    visited.add(cand.g);
  }
  const flat = [];
  let total = 0;
  for (const sg of segs) {
    const arr = groups.get(sg.g).slice();
    if (sg.rev) arr.reverse();
    for (const p of arr) {
      const f = fwdOf(p.q);
      if (sg.rev) f.negate();
      flat.push({ c: new V3(p.x, p.y, p.z), f, l: p.l, s0: total });
      total += p.l;
    }
  }
  if (!flat.length) return null;
  return { flat, total };
}
function routeAt(route, s) {
  const flat = route.flat;
  s = clamp(s, 0, route.total - 1e-6);
  let lo = 0, hi = flat.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (flat[mid].s0 <= s) lo = mid; else hi = mid - 1;
  }
  const p = flat[lo];
  const t = (s - p.s0) / p.l;
  return { pos: p.c.clone().addScaledVector(p.f, (t - 0.5) * p.l), dir: p.f };
}

// ============================================================
// 運行
// ============================================================
async function startRun() {
  if (run) return;
  if (!lib.comp.length) { tmsg('編成が空です。車両エディットで編成を作ってください'); return; }
  const route = buildRoute(player.pos);
  if (!route) { tmsg('近くに線路が見つかりません（線路モードで敷設してください）'); return; }
  ensureAudio();
  const cars = [];
  for (const id of lib.comp) {
    const car = carById(id);
    if (!car) continue;
    const b = await buildCar(car);
    const root = b.root.clone(true);
    root.traverse(o => { if (o.isMesh && o.material) o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone(); });
    scene.add(root);
    let ch = null;
    if (actx) {
      const chn = makeVvvfChannel(car);
      if (chn) {
        try {
          startChannel(chn, await decodeCached(car.vvvf.accel.data), await decodeCached(car.vvvf.decel.data));
          ch = chn;
        } catch (e) { console.error(e); tmsg(`「${car.name}」の走行音を読み込めませんでした`); }
      }
    }
    cars.push({ car, root, parts: partsOf(root), length: b.length, ch });
  }
  run = { route, s: 0, speed: 0, cars, t: 0, saved: { pos: player.pos.clone(), viewMode } };
  viewMode = 1;
  player.vel.set(0, 0, 0);
  ctl.acc = ctl.brk = ctl.emg = false;
  document.getElementById('trnRunUI').style.display = 'flex';
  tmsg('運行開始：画面のボタン、または W（加速）・S（減速）で運転');
  updateHudRun();
}
function stopRun() {
  if (!run) return;
  for (const c of run.cars) { scene.remove(c.root); stopChannel(c.ch); }
  player.pos.copy(run.saved.pos);
  viewMode = run.saved.viewMode;
  run = null;
  document.getElementById('trnRunUI').style.display = 'none';
  document.getElementById('trnHud').style.display = 'none';
  tmsg('運行を終了しました');
}
function updateRun(dt) {
  if (!run) return;
  // 別ファイル（ダイヤ運行）が運行を引き継いでいる場合は、そちらの計算に任せる
  if (run.custom) { if (window.VoxelTrain && window.VoxelTrain.customUpdate) window.VoxelTrain.customUpdate(run, dt); return; }
  const r = run;
  const throttle = (!!keys.KeyW || ctl.acc) && !ctl.emg;
  const brake = !!keys.KeyS || ctl.brk || ctl.emg;
  if (throttle) r.speed += 0.7 * dt;
  if (brake) r.speed -= (ctl.emg ? 3.5 : 1.5) * dt;
  r.speed -= 0.08 * dt;
  if (r.speed < 0) r.speed = 0;
  const maxV = lib.maxKmh / 3.6;
  if (r.speed > maxV) r.speed = maxV;
  r.s += r.speed * dt;
  if (r.s >= r.route.total) { r.s = r.route.total - 1e-3; r.speed = 0; }
  r.t += dt;
  const kmh = r.speed * 3.6;

  let front = r.s;
  for (const c of r.cars) {
    const center = front - c.length / 2;
    const head = routeAt(r.route, center + c.length / 2);
    const tail = routeAt(r.route, center - c.length / 2);
    const mid = routeAt(r.route, center);
    const dir = head.pos.clone().sub(tail.pos);
    if (dir.lengthSq() < 1e-8) dir.copy(mid.dir);
    c.root.position.copy(mid.pos);
    c.root.lookAt(mid.pos.clone().add(dir.normalize()));
    applyAnims(c.car, c.parts, r.t);
    updateChannel(c.ch, kmh, throttle, brake);
    front = center - c.length / 2 - GAP;
  }
  const h = routeAt(r.route, r.s - 3);
  player.pos.set(h.pos.x, h.pos.y, h.pos.z);
  player.vel.set(0, 0, 0);
  updateHudRun();
}
function updateHudRun() {
  const hud = document.getElementById('trnHud');
  if (!hud) return;
  if (!run) { hud.style.display = 'none'; return; }
  hud.style.display = 'block';
  const sp = document.getElementById('trnSpeed');
  if (sp) sp.textContent = `${Math.round(run.speed * 3.6)} km/h`;
  hud.textContent = `運行中  ${Math.round(run.s)} / ${Math.round(run.route.total)} m ｜ 最高 ${lib.maxKmh} km/h`;
}
function toggleRun() {
  if (run) { stopRun(); return; }
  if (!started) { tmsg('ゲームを開始してから運行してください'); return; }
  if (trainOpen) closeTrain();
  startRun();
}

// ============================================================
// 編集プレビュー（3D）
// ============================================================
const HB_COL = { wall: 0xff9f43, floor: 0x54a0ff, seat: 0x1dd1a1 };

function ensurePreview() {
  if (prev) return prev;
  const cv = document.getElementById('trnPrev');
  const W = cv.clientWidth || 320, H = cv.clientHeight || 280;
  const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
  r.setSize(W, H, false);
  r.setClearColor(0x1a2430, 1);
  const sc = new THREE.Scene();
  sc.add(new THREE.AmbientLight(0xffffff, 0.75));
  const dl = new THREE.DirectionalLight(0xffffff, 0.8);
  dl.position.set(2, 4, 3);
  sc.add(dl);
  sc.add(new THREE.GridHelper(60, 60, 0x44556a, 0x2a3646));
  const cam = new THREE.PerspectiveCamera(40, W / H, 0.1, 500);
  prev = {
    r, sc, cam, cv,
    grp: new THREE.Group(), hbGrp: new THREE.Group(),
    rotY: 0.7, rotX: 0.25, zoom: 1, target: new V3(0, 1.5, 0),
    t: 0, playing: true, carId: null, built: null,
    hbObjs: [], hbSel: -1, hbDirty: true, tc: null, gizmoDrag: false,
    animSel: null, lx: 0, ly: 0, moved: 0, dragging: false
  };
  sc.add(prev.grp, prev.hbGrp);

  // 矢印（移動・拡大縮小）。読み込めた場合のみ使える
  ensureGizmo().then(ok => {
    if (!prev) return;
    if (!ok) { tmsg('矢印ツールを読み込めませんでした。数値入力は使えます'); return; }
    const tc = new THREE.TransformControls(prev.cam, prev.cv);
    tc.setMode('translate');
    tc.setSize(0.9);
    tc.addEventListener('dragging-changed', ev => {
      prev.gizmoDrag = ev.value;
      if (!ev.value) onGizmoEnd();
    });
    tc.addEventListener('objectChange', onGizmoChange);
    prev.sc.add(tc);
    prev.tc = tc;
    attachGizmo();
  });

  // 操作：ドラッグで回転（矢印をつかんでいる間は無効）、枠のクリックで選択
  cv.addEventListener('pointerdown', e => {
    if (prev.gizmoDrag) return;
    prev.dragging = true; prev.moved = 0;
    cv.setPointerCapture(e.pointerId);
    prev.lx = e.clientX; prev.ly = e.clientY;
  });
  cv.addEventListener('pointermove', e => {
    if (!prev.dragging || prev.gizmoDrag) return;
    const dx = e.clientX - prev.lx, dy = e.clientY - prev.ly;
    prev.moved += Math.abs(dx) + Math.abs(dy);
    prev.rotY += dx * 0.01;
    prev.rotX = clamp(prev.rotX + dy * 0.01, -0.2, 1.4);
    prev.lx = e.clientX; prev.ly = e.clientY;
  });
  cv.addEventListener('pointerup', e => {
    if (prev.dragging && prev.moved < 6 && !prev.gizmoDrag) pickHitbox(e);
    prev.dragging = false;
  });
  cv.addEventListener('wheel', e => {
    prev.zoom = clamp(prev.zoom * (e.deltaY > 0 ? 1.1 : 0.9), 0.15, 6);
    e.preventDefault();
  }, { passive: false });
  return prev;
}

// 枠を作る（車両データから1つずつ作る）
function buildHitboxObjs(car) {
  const p = prev;
  if (!p) return;
  while (p.hbGrp.children.length) p.hbGrp.remove(p.hbGrp.children[0]);
  if (p.tc) p.tc.detach();
  p.hbObjs = [];
  car.hitboxes.forEach((hb, i) => {
    const isSeat = hb.type === 'seat';
    const min = new V3(...hb.min), max = new V3(...hb.max);
    const size = max.clone().sub(min);
    const col = HB_COL[hb.type] || 0xffffff;
    const g = new THREE.BoxGeometry(1, 1, 1);
    const fill = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.22, depthWrite: false }));
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: i === p.hbSel ? 0xffff00 : col }));
    const grp = new THREE.Group();
    grp.add(fill, edge);
    grp.userData.idx = i;
    grp.userData.isSeat = isSeat;
    if (isSeat) {
      grp.position.copy(min);
      grp.scale.set(0.6, 0.6, 0.6);
    } else {
      grp.position.copy(min.clone().add(max).multiplyScalar(0.5));
      grp.scale.set(Math.max(size.x, 0.05), Math.max(size.y, 0.05), Math.max(size.z, 0.05));
    }
    p.hbGrp.add(grp);
    p.hbObjs.push(grp);
  });
  p.hbDirty = false;
  attachGizmo();
}
function attachGizmo() {
  const p = prev;
  if (!p || !p.tc) return;
  p.tc.detach();
  const g = p.hbObjs[p.hbSel];
  if (g) p.tc.attach(g);
}
// 矢印で動かした結果を車両データに書き戻す
function onGizmoChange() {
  const p = prev;
  const car = carById(p && p.carId);
  if (!p || !car || !p.tc || !p.tc.object) return;
  const obj = p.tc.object;
  const i = obj.userData.idx;
  const hb = car.hitboxes[i];
  if (!hb) return;
  const c = obj.position;
  if (obj.userData.isSeat) {
    hb.min = [c.x, c.y, c.z]; hb.max = [c.x, c.y, c.z];
  } else {
    const s = obj.scale;
    s.set(Math.max(0.05, Math.abs(s.x)), Math.max(0.05, Math.abs(s.y)), Math.max(0.05, Math.abs(s.z)));
    hb.min = [c.x - s.x / 2, c.y - s.y / 2, c.z - s.z / 2];
    hb.max = [c.x + s.x / 2, c.y + s.y / 2, c.z + s.z / 2];
  }
}
function onGizmoEnd() {
  const car = carById(prev && prev.carId);
  if (!car) return;
  touchCar(car.id);
  saveLib();
  renderEditor();
}
// 枠をクリックで選択
function pickHitbox(e) {
  const p = prev;
  const rect = p.cv.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, p.cam);
  const hits = ray.intersectObjects(p.hbObjs, true);
  if (hits.length) {
    let o = hits[0].object;
    while (o && o.userData.idx === undefined) o = o.parent;
    if (o) { selectHitbox(o.userData.idx, false); return; }
  }
  selectHitbox(-1, false);
}
function selectHitbox(i, focus) {
  if (!prev) return;
  prev.hbSel = i;
  const car = carById(prev.carId);
  if (car) buildHitboxObjs(car);
  if (focus && i >= 0 && car) {
    const hb = car.hitboxes[i];
    if (hb) {
      prev.target.set((hb.min[0] + hb.max[0]) / 2, (hb.min[1] + hb.max[1]) / 2, (hb.min[2] + hb.max[2]) / 2);
      prev.zoom = 0.5;
    }
  }
  renderEditor();
}

function renderPreview() {
  requestAnimationFrame(renderPreview);
  if (!prev || !trainOpen) return;
  const p = prev;
  const car = p.carId ? carById(p.carId) : null;
  if (car && p.built) {
    if (p.playing) p.t += 1 / 60;
    applyAnims(car, p.built.parts, p.t);
    if (p.hbDirty) buildHitboxObjs(car);
  }
  const d = 9 * p.zoom;
  const tg = p.target;
  p.cam.position.set(
    tg.x + Math.sin(p.rotY) * Math.cos(p.rotX) * d,
    tg.y + Math.sin(p.rotX) * d,
    tg.z + Math.cos(p.rotY) * Math.cos(p.rotX) * d
  );
  p.cam.lookAt(tg);
  // 選択中の枠は黄色の線で表示
  const cur = carById(p.carId);
  p.hbObjs.forEach(o => {
    const edge = o.children[1];
    if (!edge || !edge.material) return;
    const hb = cur ? cur.hitboxes[o.userData.idx] : null;
    const base = hb ? (HB_COL[hb.type] || 0xffffff) : 0xffffff;
    edge.material.color.set(o.userData.idx === p.hbSel ? 0xffff00 : base);
  });
  p.r.render(p.sc, p.cam);
}

async function setPreviewCar(id) {
  const p = ensurePreview();
  p.carId = id;
  p.hbSel = -1;
  p.target.set(0, 1.5, 0);
  while (p.grp.children.length) p.grp.remove(p.grp.children[0]);
  p.built = null;
  const car = carById(id);
  if (!car) {
    p.hbObjs = [];
    while (p.hbGrp.children.length) p.hbGrp.remove(p.hbGrp.children[0]);
    return;
  }
  const b = await buildCar(car);
  if (p.carId !== id) return;
  const copy = b.root.clone(true);
  p.grp.add(copy);
  p.built = { root: copy, parts: partsOf(copy) };
  p.t = 0;
  p.hbDirty = true;
}

// ============================================================
// エディタUI
// ============================================================
function renderLibrary() {
  const el = document.getElementById('trnLib');
  if (!el) return;
  el.innerHTML = lib.cars.length ? lib.cars.map(c => `
    <div class="trn-item ${c.id === selId ? 'sel' : ''}">
      <span class="trn-name">${esc(c.name)}（${c.length}m）</span>
      <button class="trn-btn small" data-act="pick" data-id="${c.id}">編集</button>
      <button class="trn-btn small" data-act="addc" data-id="${c.id}">編成へ</button>
      <button class="trn-btn small sub" data-act="dup" data-id="${c.id}">複製</button>
      <button class="trn-btn small danger" data-act="delc" data-id="${c.id}">削除</button>
    </div>`).join('') : '<p class="trn-note">車両がまだありません。「＋ 新規車両」で作成してください。</p>';
  const cl = document.getElementById('trnComp');
  if (cl) {
    cl.innerHTML = lib.comp.length ? lib.comp.map((id, i) => {
      const c = carById(id);
      return `<div class="trn-item">
        <span class="trn-name">${i + 1}. ${c ? esc(c.name) : '（削除済み）'}</span>
        <button class="trn-btn small sub" data-act="up" data-i="${i}">↑</button>
        <button class="trn-btn small sub" data-act="down" data-i="${i}">↓</button>
        <button class="trn-btn small danger" data-act="rmc" data-i="${i}">✕</button>
      </div>`;
    }).join('') : '<p class="trn-note">編成は空です。車両を「編成へ」で追加してください。</p>';
  }
  const tot = lib.comp.reduce((s, id) => s + ((carById(id) || { length: 0 }).length + GAP), 0);
  const info = document.getElementById('trnTotal');
  if (info) info.textContent = `編成の全長：約 ${Math.max(0, tot - GAP).toFixed(1)} m ／ 最高速度 ${lib.maxKmh} km/h`;
}

function renderEditor() {
  const el = document.getElementById('trnEdit');
  if (!el) return;
  const car = carById(selId);
  if (!car) { el.innerHTML = '<p class="trn-note">左の一覧から車両を選んでください。</p>'; return; }
  const partNames = prev && prev.built ? [...partsOf(prev.built.root).keys()] : [];
  const pn = [...new Set([...partNames, ...Object.keys(car.parts)])];
  const parts = pn.map(n => {
    const pv = (car.parts[n] && car.parts[n].pivot) || [0, 0, 0];
    return `<div class="trn-row"><span class="trn-name">${esc(n)}</span>
      ${[0, 1, 2].map(i => `<input type="number" step="0.1" class="trn-in w" data-f="pivot" data-n="${esc(n)}" data-i="${i}" value="${pv[i]}">`).join('')}</div>`;
  }).join('') || '<p class="trn-note">パーツ名はOBJの「オブジェクト名」から自動で検出されます（モデル読み込み後に表示）。</p>';

  const sel = prev ? prev.hbSel : -1;
  const hbs = car.hitboxes.map((hb, i) => `
    <div class="trn-row ${i === sel ? 'hbsel' : ''}">
      <button class="trn-btn small ${i === sel ? '' : 'sub'}" data-act="hbsel" data-i="${i}">${i === sel ? '選択中' : '選択'}</button>
      <select class="trn-in" data-f="hbType" data-i="${i}">
        <option value="wall" ${hb.type === 'wall' ? 'selected' : ''}>壁</option>
        <option value="floor" ${hb.type === 'floor' ? 'selected' : ''}>床</option>
        <option value="seat" ${hb.type === 'seat' ? 'selected' : ''}>座席</option>
      </select>
      <input class="trn-in" style="width:64px" data-f="hbName" data-i="${i}" value="${esc(hb.name || '')}" placeholder="名前">
      <div class="trn-sub2">
        ${hb.type === 'seat'
          ? `<span class="trn-note">位置</span>${[0, 1, 2].map(j => `<input type="number" step="0.1" class="trn-in w" data-f="hb" data-k="min" data-j="${j}" data-i="${i}" value="${hb.min[j].toFixed(2)}">`).join('')}`
          : `<span class="trn-note">最小</span>${[0, 1, 2].map(j => `<input type="number" step="0.1" class="trn-in w" data-f="hb" data-k="min" data-j="${j}" data-i="${i}" value="${hb.min[j].toFixed(2)}">`).join('')}
             <span class="trn-note">最大</span>${[0, 1, 2].map(j => `<input type="number" step="0.1" class="trn-in w" data-f="hb" data-k="max" data-j="${j}" data-i="${i}" value="${hb.max[j].toFixed(2)}">`).join('')}`}
      </div>
      <button class="trn-btn small danger" data-act="hbdel" data-i="${i}">✕</button>
    </div>`).join('') || '<p class="trn-note">当たり判定・座席はまだありません。下のボタンで追加し、3Dプレビューの枠をクリックして矢印で動かせます。</p>';

  const extras = car.extras.map((ex, i) => `
    <div class="trn-row">
      <span class="trn-name">${esc(ex.name || ('パーツ' + (i + 1)))}</span>
      <select class="trn-in" data-f="exMode" data-i="${i}">
        <option value="passthrough" ${ex.mode !== 'emissive' ? 'selected' : ''}>そのまま透過</option>
        <option value="emissive" ${ex.mode === 'emissive' ? 'selected' : ''}>半透明を発光</option>
      </select>
      <button class="trn-btn small danger" data-act="exdel" data-i="${i}">✕</button>
    </div>`).join('') || '<p class="trn-note">ガラスなど、本体に重ねる追加パーツはまだありません。</p>';

  const animNames = Object.keys(car.anims);
  const cur = prev && prev.animSel && car.anims[prev.animSel] ? prev.animSel : animNames[0];
  if (prev) prev.animSel = cur;
  const a = cur ? car.anims[cur] : null;
  const boneRows = a ? Object.keys(a.bones).map(bn => {
    const rows = [];
    (a.bones[bn].rot || []).forEach((k, i) => rows.push({ kind: 'rot', idx: i, t: k[0], v: k[1] }));
    (a.bones[bn].pos || []).forEach((k, i) => rows.push({ kind: 'pos', idx: i, t: k[0], v: k[1] }));
    return `<div class="trn-sub"><b>${esc(bn)}</b>
      <div class="trn-row"><button class="trn-btn small sub" data-act="kfadd" data-bn="${esc(bn)}">＋ 回転キー</button>
      <button class="trn-btn small sub" data-act="kfaddp" data-bn="${esc(bn)}">＋ 位置キー</button>
      <button class="trn-btn small danger" data-act="bnDel" data-bn="${esc(bn)}">骨ごと削除</button></div>
      ${rows.map(r => `<div class="trn-row">
        <input type="number" step="0.1" class="trn-in w" data-f="kf" data-bn="${esc(bn)}" data-kind="${r.kind}" data-idx="${r.idx}" data-j="t" value="${r.t}" title="時刻(秒)">
        ${[0, 1, 2].map(j => `<input type="number" step="0.5" class="trn-in w" data-f="kf" data-bn="${esc(bn)}" data-kind="${r.kind}" data-idx="${r.idx}" data-j="${j}" value="${r.v[j]}">`).join('')}
        <span class="trn-note">${r.kind === 'rot' ? '回転°' : '位置m'}</span>
        <button class="trn-btn small danger" data-act="kfdel" data-bn="${esc(bn)}" data-kind="${r.kind}" data-idx="${r.idx}">✕</button>
      </div>`).join('')}
    </div>`;
  }).join('') : '';

  el.innerHTML = `
  <div class="trn-sec">
    <h3>基本</h3>
    <div class="trn-row">名前 <input class="trn-in" data-f="name" value="${esc(car.name)}" style="flex:1"></div>
    <div class="trn-row">車両の長さ（m）<input type="number" step="0.5" min="1" class="trn-in" data-f="length" value="${car.length}"> <span class="trn-note">既定は20m</span></div>
    <div class="trn-row">本体モデル（.obj）<input type="file" accept=".obj" data-f="mainFile"></div>
    <div class="trn-row">テクスチャ（png/jpg）<input type="file" accept="image/png,image/jpeg" data-f="mainTex"></div>
    <div class="trn-row">透過方式 <select class="trn-in" data-f="mainMode">
      <option value="passthrough" ${car.main.mode !== 'emissive' ? 'selected' : ''}>そのまま透過</option>
      <option value="emissive" ${car.main.mode === 'emissive' ? 'selected' : ''}>半透明部分を発光</option></select></div>
    <p class="trn-note">モデルは車両の長さ（Z方向）に合わせて拡大縮小します。進行方向は +Z です。</p>
  </div>
  <div class="trn-sec"><h3>追加パーツ（ガラスなど）</h3>${extras}
    <div class="trn-row"><input type="file" accept=".obj" data-f="exNew"><button class="trn-btn small" data-act="exadd">＋ 追加</button></div>
  </div>
  <div class="trn-sec"><h3>回転中心（ドアなどを動かす軸）</h3>${parts}
    <p class="trn-note">数値は車両の中心（x・z）と床（y=0）を基準にしたメートル値です。</p>
  </div>
  <div class="trn-sec"><h3>当たり判定・座席（透明の役割ヒットボックス）</h3>${hbs}
    <div class="trn-row"><button class="trn-btn small" data-act="hbadd" data-type="wall">＋ 壁</button>
    <button class="trn-btn small" data-act="hbadd" data-type="floor">＋ 床</button>
    <button class="trn-btn small" data-act="hbadd" data-type="seat">＋ 座席</button></div>
    <p class="trn-note">3Dプレビューで枠をクリックして選択すると、矢印（移動・拡大縮小）が出ます。</p>
  </div>
  <div class="trn-sec"><h3>アニメーション（ドア・幕・ライトなど）</h3>
    <div class="trn-row"><input type="file" accept=".json" data-f="animFile"><span class="trn-note">Blockbenchのアニメーション（JSON）を読み込み</span></div>
    <div class="trn-row"><button class="trn-btn small" data-act="animnew">＋ 新規アニメーション</button>
      ${animNames.map(n => `<button class="trn-btn small ${n === cur ? '' : 'sub'}" data-act="animsel" data-n="${esc(n)}">${esc(n)}</button>`).join('')}</div>
    ${a ? `<div class="trn-row">長さ（秒）<input type="number" step="0.1" class="trn-in w" data-f="alen" value="${a.length}">
      <label><input type="checkbox" data-f="aloop" ${a.loop ? 'checked' : ''}> ループ</label>
      <button class="trn-btn small danger" data-act="animdel">このアニメを削除</button></div>
      <div class="trn-row"><input class="trn-in" id="trnBoneName" placeholder="パーツ名（例：door_L）"><button class="trn-btn small" data-act="bneadd">骨を追加</button></div>
      ${boneRows}
      <div class="trn-row"><input class="trn-in" id="trnMatName" placeholder="発光させるパーツ名（例：light）"><button class="trn-btn small" data-act="matadd">発光トラック追加</button></div>
      ${Object.keys(a.mats).map(mn => `<div class="trn-sub"><b>${esc(mn)}（発光 0〜1）</b>
        ${a.mats[mn].emi.map((k, i) => `<div class="trn-row"><input type="number" step="0.1" class="trn-in w" data-f="emt" data-mn="${esc(mn)}" data-idx="${i}" data-j="t" value="${k[0]}"><input type="number" step="0.1" min="0" max="1" class="trn-in w" data-f="emt" data-mn="${esc(mn)}" data-idx="${i}" data-j="v" value="${k[1]}"><button class="trn-btn small danger" data-act="emdel" data-mn="${esc(mn)}" data-idx="${i}">✕</button></div>`).join('')}
        <button class="trn-btn small sub" data-act="emadd" data-mn="${esc(mn)}">＋ キー</button></div>`).join('')}` : '<p class="trn-note">アニメーションがありません。JSONを読み込むか、新規作成してください。</p>'}
  </div>
  <div class="trn-sec"><h3>VVVF加減速音</h3>
    <div class="trn-row"><label><input type="checkbox" data-f="vEnable" ${car.vvvf.enabled ? 'checked' : ''}> VVVF音を付ける</label></div>
    ${car.vvvf.enabled ? `
    <div class="trn-row">加速音 <input type="file" accept="audio/*" data-f="vAccel"> <span class="trn-note">${car.vvvf.accel ? '✓ 設定済み' : '未設定'}</span></div>
    <div class="trn-row">減速音 <input type="file" accept="audio/*" data-f="vDecel"> <span class="trn-note">${car.vvvf.decel ? '✓ 設定済み' : '未設定'}</span></div>
    <div class="trn-row">時速による分割数 <input type="number" min="2" max="1000" step="1" class="trn-in w" data-f="vDiv" value="${car.vvvf.divisions}"> <span class="trn-note">既定120分割</span></div>` : '<p class="trn-note">オフ：この車両は走行音を鳴らしません。</p>'}
  </div>
  <div class="trn-row"><button class="trn-btn" data-act="savecar">この車両を保存して反映</button></div>`;
}

function openTrain() {
  if (settingsEl.classList.contains('show')) return;
  trainOpen = true;
  document.getElementById('trnPanel').classList.add('show');
  menuOpen = true;
  releaseActions();
  for (const k in keys) keys[k] = false;
  if (document.pointerLockElement) document.exitPointerLock();
  ensurePreview();
  renderLibrary();
  renderEditor();
  if (selId) setPreviewCar(selId);
}
function closeTrain() {
  trainOpen = false;
  document.getElementById('trnPanel').classList.remove('show');
  menuOpen = false;
  if (!isTouch && started) {
    const p = canvas.requestPointerLock && canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => {});
  }
}

function touchAndRefresh(id) {
  touchCar(id);
  saveLib();
  if (id === selId) setPreviewCar(id);
  renderLibrary();
}
function bindEditor() {
  const root = document.getElementById('trnEdit');
  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const car = carById(selId);
    const act = b.dataset.act;
    if (act === 'savecar') { touchAndRefresh(selId); tmsg('保存しました'); return; }
    if (!car) return;
    if (act === 'exdel') { car.extras.splice(Number(b.dataset.i), 1); touchAndRefresh(car.id); renderEditor(); }
    if (act === 'exadd') {
      const f = root.querySelector('[data-f="exNew"]').files[0];
      if (!f) { tmsg('追加するOBJを選んでください'); return; }
      car.extras.push({ id: uid(), name: f.name.replace(/\.[^.]+$/, ''), data: await fileAsText(f), tex: null, mode: 'passthrough' });
      touchAndRefresh(car.id); renderEditor();
    }
    if (act === 'hbadd') {
      car.hitboxes.push({ type: b.dataset.type, name: '', min: [-1, 0, -1], max: [1, 2, 1] });
      if (prev) prev.hbSel = car.hitboxes.length - 1;
      touchAndRefresh(car.id); renderEditor();
    }
    if (act === 'hbsel') selectHitbox(Number(b.dataset.i), true);
    if (act === 'hbdel') {
      car.hitboxes.splice(Number(b.dataset.i), 1);
      if (prev) prev.hbSel = -1;
      touchAndRefresh(car.id); renderEditor();
    }
    if (act === 'animnew') {
      const n = 'anim' + (Object.keys(car.anims).length + 1);
      car.anims[n] = { length: 2, loop: true, bones: {}, mats: {} };
      if (prev) prev.animSel = n;
      touchAndRefresh(car.id); renderEditor();
    }
    if (act === 'animsel') { if (prev) prev.animSel = b.dataset.n; renderEditor(); }
    if (act === 'animdel') { delete car.anims[prev.animSel]; touchAndRefresh(car.id); renderEditor(); }
    if (act === 'bneadd') {
      const n = (document.getElementById('trnBoneName').value || '').trim();
      if (!n || !prev || !prev.animSel) { tmsg('パーツ名を入れてください'); return; }
      const an = car.anims[prev.animSel];
      an.bones[n] = an.bones[n] || { rot: [[0, [0, 0, 0]]], pos: [] };
      touchAndRefresh(car.id); renderEditor();
    }
    if (act === 'bnDel') { delete car.anims[prev.animSel].bones[b.dataset.bn]; touchAndRefresh(car.id); renderEditor(); }
    if (act === 'kfadd' || act === 'kfaddp') {
      const an = car.anims[prev.animSel], bn = b.dataset.bn, kind = act === 'kfadd' ? 'rot' : 'pos';
      an.bones[bn][kind].push([0, [0, 0, 0]]);
      an.bones[bn][kind].sort((x, y) => x[0] - y[0]);
      touchAndRefresh(car.id); renderEditor();
    }
    if (act === 'kfdel') {
      const an = car.anims[prev.animSel], bn = b.dataset.bn, kind = b.dataset.kind, idx = Number(b.dataset.idx);
      an.bones[bn][kind].splice(idx, 1);
      touchAndRefresh(car.id); renderEditor();
    }
    if (act === 'matadd') {
      const n = (document.getElementById('trnMatName').value || '').trim();
      if (!n || !prev || !prev.animSel) { tmsg('パーツ名を入れてください'); return; }
      const an = car.anims[prev.animSel];
      an.mats[n] = an.mats[n] || { emi: [[0, 0]] };
      touchAndRefresh(car.id); renderEditor();
    }
    if (act === 'emadd') { const an = car.anims[prev.animSel]; an.mats[b.dataset.mn].emi.push([0, 0]); touchAndRefresh(car.id); renderEditor(); }
    if (act === 'emdel') { const an = car.anims[prev.animSel]; an.mats[b.dataset.mn].emi.splice(Number(b.dataset.idx), 1); touchAndRefresh(car.id); renderEditor(); }
  });

  root.addEventListener('change', async e => {
    const car = carById(selId);
    if (!car) return;
    const el = e.target;
    const f = el.dataset.f;
    const num = () => Number(el.value) || 0;
    if (f === 'name') car.name = el.value;
    else if (f === 'length') car.length = clamp(num(), 1, 200);
    else if (f === 'mainMode') car.main.mode = el.value;
    else if (f === 'mainFile') { const file = el.files[0]; if (file) car.main.data = await fileAsText(file); }
    else if (f === 'mainTex') { const file = el.files[0]; if (file) car.main.tex = await fileAsUrl(file); }
    else if (f === 'pivot') {
      const n = el.dataset.n, i = Number(el.dataset.i);
      car.parts[n] = car.parts[n] || { pivot: [0, 0, 0] };
      car.parts[n].pivot[i] = num();
    }
    else if (f === 'hbType') car.hitboxes[Number(el.dataset.i)].type = el.value;
    else if (f === 'hbName') car.hitboxes[Number(el.dataset.i)].name = el.value;
    else if (f === 'hb') {
      const hb = car.hitboxes[Number(el.dataset.i)];
      const j = Number(el.dataset.j);
      if (hb.type === 'seat') { hb.min[j] = num(); hb.max[j] = num(); }
      else hb[el.dataset.k][j] = num();
    }
    else if (f === 'exMode') car.extras[Number(el.dataset.i)].mode = el.value;
    else if (f === 'animFile') {
      const file = el.files[0];
      if (file) {
        try {
          const imp = importAnimJson(await fileAsText(file));
          Object.assign(car.anims, imp);
          tmsg(`アニメーションを ${Object.keys(imp).length} 件読み込みました`);
        } catch (err) { console.error(err); tmsg('アニメーションJSONを読み込めませんでした'); }
      }
    }
    else if (f === 'alen' && prev && prev.animSel) car.anims[prev.animSel].length = Math.max(0.1, num());
    else if (f === 'aloop' && prev && prev.animSel) car.anims[prev.animSel].loop = el.checked;
    else if (f === 'kf') {
      const an = car.anims[prev.animSel], bn = el.dataset.bn, kind = el.dataset.kind, idx = Number(el.dataset.idx);
      const row = an.bones[bn][kind][idx];
      if (el.dataset.j === 't') row[0] = Math.max(0, num());
      else row[1][Number(el.dataset.j)] = num();
      an.bones[bn][kind].sort((x, y) => x[0] - y[0]);
    }
    else if (f === 'emt') {
      const an = car.anims[prev.animSel], mn = el.dataset.mn, idx = Number(el.dataset.idx);
      const row = an.mats[mn].emi[idx];
      if (el.dataset.j === 't') row[0] = Math.max(0, num());
      else row[1] = clamp(num(), 0, 1);
      an.mats[mn].emi.sort((x, y) => x[0] - y[0]);
    }
    else if (f === 'vEnable') { car.vvvf.enabled = el.checked; renderEditor(); }
    else if (f === 'vAccel') { const file = el.files[0]; if (file) car.vvvf.accel = { name: file.name, data: await fileAsUrl(file) }; }
    else if (f === 'vDecel') { const file = el.files[0]; if (file) car.vvvf.decel = { name: file.name, data: await fileAsUrl(file) }; }
    else if (f === 'vDiv') car.vvvf.divisions = clamp(Math.round(num()), 2, 1000);
    else return;
    touchCar(car.id);
    saveLib();
    if (['mainFile', 'mainTex', 'mainMode', 'length', 'exMode', 'pivot', 'exadd', 'animFile', 'vAccel', 'vDecel', 'vEnable'].includes(f)) {
      if (car.id === selId) setPreviewCar(car.id);
    }
    if (['vEnable', 'vAccel', 'vDecel', 'animFile', 'hbType'].includes(f)) renderEditor();
    if (f === 'hb' || f === 'hbType') { if (prev) prev.hbDirty = true; }
    renderLibrary();
  });
}

function bindLibrary() {
  document.getElementById('trnNew').addEventListener('click', () => {
    const c = newCar('車両' + (lib.cars.length + 1));
    lib.cars.push(c);
    selId = c.id;
    saveLib();
    renderLibrary(); renderEditor(); setPreviewCar(c.id);
  });
  document.getElementById('trnLib').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.dataset.id, act = b.dataset.act;
    if (act === 'pick') { selId = id; renderLibrary(); renderEditor(); setPreviewCar(id); }
    if (act === 'addc') { lib.comp.push(id); saveLib(); renderLibrary(); }
    if (act === 'dup') {
      const c = carById(id);
      const d = JSON.parse(JSON.stringify(c));
      d.id = uid(); d.name = c.name + '（コピー）';
      lib.cars.push(d); saveLib(); renderLibrary();
    }
    if (act === 'delc') {
      if (!confirm('この車両を削除しますか？（編成からも外れます）')) return;
      lib.cars = lib.cars.filter(c => c.id !== id);
      lib.comp = lib.comp.filter(x => x !== id);
      built.delete(id);
      if (selId === id) { selId = null; renderEditor(); }
      saveLib(); renderLibrary();
    }
  });
  document.getElementById('trnComp').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const i = Number(b.dataset.i), act = b.dataset.act;
    if (act === 'rmc') lib.comp.splice(i, 1);
    if (act === 'up' && i > 0) [lib.comp[i - 1], lib.comp[i]] = [lib.comp[i], lib.comp[i - 1]];
    if (act === 'down' && i < lib.comp.length - 1) [lib.comp[i + 1], lib.comp[i]] = [lib.comp[i], lib.comp[i + 1]];
    saveLib(); renderLibrary();
  });
  document.getElementById('trnMaxKmh').addEventListener('change', e => {
    lib.maxKmh = clamp(Number(e.target.value) || 120, 20, 300);
    e.target.value = String(lib.maxKmh);
    saveLib(); renderLibrary();
  });
  document.getElementById('trnClose').addEventListener('click', closeTrain);
  document.getElementById('trnRun').addEventListener('click', () => { toggleRun(); });
  document.getElementById('trnZoomIn').addEventListener('click', () => { if (prev) prev.zoom = clamp(prev.zoom * 0.7, 0.15, 6); });
  document.getElementById('trnZoomOut').addEventListener('click', () => { if (prev) prev.zoom = clamp(prev.zoom / 0.7, 0.15, 6); });
  document.getElementById('trnFit').addEventListener('click', () => { if (prev) { prev.zoom = 1; prev.target.set(0, 1.5, 0); } });
  document.getElementById('trnFocus').addEventListener('click', () => {
    if (prev && prev.hbSel >= 0) selectHitbox(prev.hbSel, true);
    else tmsg('枠を選択してから押してください');
  });
  document.getElementById('trnMode').addEventListener('click', () => {
    if (!prev || !prev.tc) { tmsg('矢印ツールが利用できません'); return; }
    const m = prev.tc.mode === 'translate' ? 'scale' : 'translate';
    prev.tc.setMode(m);
    document.getElementById('trnMode').textContent = m === 'translate' ? '移動の矢印' : '拡大縮小の矢印';
  });
  document.getElementById('trnPlay').addEventListener('click', () => {
    if (!prev) return;
    prev.playing = !prev.playing;
    document.getElementById('trnPlay').textContent = prev.playing ? '⏸ 停止' : '▶ 再生';
  });
}

// ============================================================
// 運転ボタン（画面上：モバイルだけでも運転できる）
// ============================================================
function holdBtn(el, onDown, onUp) {
  const down = e => { e.preventDefault(); e.stopPropagation(); onDown(); };
  const up = e => { e.preventDefault(); e.stopPropagation(); onUp(); };
  el.addEventListener('touchstart', down, { passive: false });
  el.addEventListener('touchend', up, { passive: false });
  el.addEventListener('touchcancel', up, { passive: false });
  el.addEventListener('mousedown', down);
  el.addEventListener('mouseup', up);
  el.addEventListener('mouseleave', up);
}

// ============================================================
// UI 生成
// ============================================================
function buildUI() {
  const css = document.createElement('style');
  css.textContent = `
  #trnBtn{position:fixed;right:10px;top:124px;z-index:6;background:rgba(0,0,0,.45);color:#fff;
    border:1px solid rgba(255,255,255,.4);border-radius:6px;padding:7px 11px;font-size:13px;cursor:pointer}
  #trnRunBtn{position:fixed;right:10px;top:162px;z-index:6;background:rgba(0,0,0,.55);color:#fff;
    border:2px solid #fff;border-radius:8px;padding:7px 11px;font-size:13px;cursor:pointer;touch-action:manipulation}
  #trnHud{position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:7;background:rgba(0,0,0,.6);
    color:#fff;padding:6px 10px;border-radius:6px;font-size:12px;display:none;pointer-events:none;white-space:nowrap}
  #trnRunUI{position:fixed;left:0;right:0;bottom:6px;z-index:9;display:none;justify-content:space-between;
    align-items:flex-end;padding:0 12px;pointer-events:none}
  #trnRunUI .grp{display:flex;gap:10px;align-items:flex-end;pointer-events:auto}
  #trnRunUI .big{width:92px;height:92px;border-radius:50%;background:rgba(0,0,0,.5);color:#fff;
    border:3px solid rgba(255,255,255,.7);font-size:14px;font-weight:bold;touch-action:none;user-select:none;
    -webkit-user-select:none;display:flex;align-items:center;justify-content:center;text-align:center}
  #trnRunUI .big.acc{border-color:#7dff9a}
  #trnRunUI .big.brk{border-color:#ffb36b}
  #trnRunUI .big.emg{width:76px;height:76px;background:rgba(140,20,20,.7);border-color:#ff6b6b}
  #trnRunUI .big.end{width:76px;height:76px;font-size:12px}
  #trnSpeed{position:fixed;left:50%;bottom:110px;transform:translateX(-50%);z-index:9;display:none;
    font-size:28px;font-weight:bold;color:#fff;text-shadow:0 2px 4px #000;pointer-events:none}
  #trnToast{position:fixed;left:50%;top:22%;transform:translateX(-50%);background:rgba(0,0,0,.75);color:#fff;
    padding:8px 14px;border-radius:8px;z-index:70;opacity:0;transition:opacity .3s;pointer-events:none;font-size:13px}
  #trnToast.show{opacity:1}
  .trn-panel{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:45}
  .trn-panel.show{display:flex}
  .trn-box{background:#1b2530;color:#fff;border-radius:10px;padding:14px;width:min(96vw,1000px);max-height:94vh;
    overflow:auto;box-sizing:border-box;font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,.5)}
  .trn-box h2{margin:0 0 8px;font-size:18px}
  .trn-cols{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start}
  .trn-left{width:300px;min-width:260px;display:flex;flex-direction:column;gap:6px}
  .trn-right{flex:1;min-width:340px}
  .trn-sec{background:rgba(255,255,255,.04);border-radius:8px;padding:8px;margin-bottom:8px}
  .trn-sec h3{margin:0 0 6px;font-size:14px;color:#cfe3f5}
  .trn-sub{background:rgba(0,0,0,.18);border-radius:6px;padding:6px;margin:6px 0}
  .trn-sub2{display:flex;gap:3px;flex-wrap:wrap;align-items:center}
  .trn-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:4px}
  .trn-row.hbsel{background:rgba(255,255,0,.08);border-radius:6px;padding:2px}
  .trn-item{display:flex;gap:4px;align-items:center;background:rgba(255,255,255,.06);border-radius:6px;padding:4px}
  .trn-name{flex:1;min-width:60px}
  .trn-note{font-size:11px;color:#9fb3c8;line-height:1.5;margin:4px 0}
  .trn-btn{background:#2e4a66;color:#fff;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:12px}
  .trn-btn.small{padding:3px 7px;font-size:11px}
  .trn-btn.sub{background:#3a3f48}
  .trn-btn.danger{background:#7a3030}
  .trn-box input,.trn-box select{background:#2a3846;color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:4px;padding:3px 5px;font-size:12px}
  .trn-box input.w{width:56px}
  #trnPrevWrap{position:relative}
  #trnPrev{width:100%;height:280px;display:block;border-radius:8px;cursor:grab;touch-action:none}
  .trn-view{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
  `;
  document.head.appendChild(css);

  const btn = document.createElement('button');
  btn.id = 'trnBtn';
  btn.textContent = '🚆 車両';
  document.body.appendChild(btn);
  btn.addEventListener('click', e => { e.stopPropagation(); openTrain(); });

  const rb = document.createElement('button');
  rb.id = 'trnRunBtn';
  rb.textContent = '▶ 運行';
  document.body.appendChild(rb);
  rb.addEventListener('click', e => { e.stopPropagation(); toggleRun(); });

  const hud = document.createElement('div');
  hud.id = 'trnHud';
  document.body.appendChild(hud);

  const spd = document.createElement('div');
  spd.id = 'trnSpeed';
  document.body.appendChild(spd);

  const ui = document.createElement('div');
  ui.id = 'trnRunUI';
  ui.innerHTML = `
    <div class="grp"><div class="big brk" id="trnBrk">減速<br>(S)</div></div>
    <div class="grp">
      <div class="big emg" id="trnEmg">非常</div>
      <div class="big end" id="trnEnd">運行<br>終了</div>
    </div>
    <div class="grp"><div class="big acc" id="trnAcc">加速<br>(W)</div></div>`;
  document.body.appendChild(ui);

  trnToastEl = document.createElement('div');
  trnToastEl.id = 'trnToast';
  document.body.appendChild(trnToastEl);

  const wrap = document.createElement('div');
  wrap.innerHTML = `
  <div class="trn-panel" id="trnPanel"><div class="trn-box">
    <h2>カスタム列車エディット</h2>
    <div class="trn-row">
      <button class="trn-btn" id="trnNew">＋ 新規車両</button>
      <label>最高速度 <input id="trnMaxKmh" type="number" min="20" max="300" step="5" style="width:70px" value="${lib.maxKmh}"> km/h</label>
      <button class="trn-btn" id="trnRun">▶ 運行（B）</button>
      <button class="trn-btn sub" id="trnClose">閉じる（N）</button>
    </div>
    <p class="trn-note" id="trnTotal"></p>
    <div class="trn-cols">
      <div class="trn-left">
        <div class="trn-sec"><h3>車両の一覧</h3><div id="trnLib" style="display:flex;flex-direction:column;gap:4px"></div></div>
        <div class="trn-sec"><h3>編成（左から順に連結）</h3><div id="trnComp" style="display:flex;flex-direction:column;gap:4px"></div></div>
      </div>
      <div class="trn-right" id="trnEdit"></div>
      <div class="trn-left" style="width:360px">
        <div class="trn-sec"><h3>3Dプレビュー</h3>
          <div id="trnPrevWrap"><canvas id="trnPrev"></canvas></div>
          <div class="trn-view">
            <button class="trn-btn small" id="trnZoomIn">🔍＋ 拡大</button>
            <button class="trn-btn small" id="trnZoomOut">🔍－ 縮小</button>
            <button class="trn-btn small sub" id="trnFit">全体表示</button>
            <button class="trn-btn small sub" id="trnFocus">選択枠へ</button>
            <button class="trn-btn small sub" id="trnMode">移動の矢印</button>
            <button class="trn-btn small sub" id="trnPlay">⏸ 停止</button>
          </div>
          <p class="trn-note">ドラッグで回転、ホイール・ボタンで拡大縮小。枠をクリックで選択し、矢印をつかんで移動・拡大縮小できます（橙＝壁、青＝床、緑＝座席）。</p>
        </div>
      </div>
    </div>
  </div></div>`;
  while (wrap.firstChild) document.body.appendChild(wrap.firstChild);

  bindLibrary();
  bindEditor();
  holdBtn(document.getElementById('trnAcc'), () => { ctl.acc = true; }, () => { ctl.acc = false; });
  holdBtn(document.getElementById('trnBrk'), () => { ctl.brk = true; }, () => { ctl.brk = false; });
  holdBtn(document.getElementById('trnEmg'), () => { ctl.emg = true; }, () => { ctl.emg = false; });
  document.getElementById('trnEnd').addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); stopRun(); }, { passive: false });
  document.getElementById('trnEnd').addEventListener('click', e => { e.stopPropagation(); stopRun(); });
}

// ============================================================
// キー・ループ
// ============================================================
window.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.code === 'KeyN') {
    if (trainOpen) closeTrain(); else if (!run) openTrain();
    return;
  }
  if (e.code === 'KeyB') {
    if (trainOpen) return;
    toggleRun();
  }
});

// ---- 別ファイル（voxel-craft-dia.js など）から使うための窓口 ----
window.VoxelTrain = {
  lib, ctl, GAP,
  carById, buildCar, partsOf, applyAnims, makeVvvfChannel, startChannel, stopChannel, updateChannel,
  decodeCached, ensureAudio, routeAt, applyAnimsEx,
  audio: () => ({ actx, masterGain }),
  getRun: () => run,
  setRun: r => { run = r; },
  customUpdate: null
};

let lastT = performance.now();
function trnLoop(now) {
  requestAnimationFrame(trnLoop);
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  if (run && started && !paused) updateRun(dt);
  const sp = document.getElementById('trnSpeed');
  if (sp) sp.style.display = run ? 'block' : 'none';
}

function init() {
  loadLib();
  buildUI();
  requestAnimationFrame(renderPreview);
  requestAnimationFrame(trnLoop);
}
init();

})();
