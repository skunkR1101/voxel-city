/* voxel-craft-station.js (v1)  駅設定・種別ダイヤの完全自動運転
 * 読み込み順：ext → road → train → dia → station
 * 既存の4ファイルと本体HTMLは変更しない（窓口 window.VoxelTrain / window.VoxelDia を使う）
 *
 *  ・駅：線路をタップして登録（P キーで駅編集 ON/OFF）。路線の経路に近い所にだけ置けます
 *  ・駅ごと：ドアの側（左／右／両方／開けない）、折り返し、次の駅までの速度
 *  ・種別ごと：発車メロディー（ドアが開いてから何秒後か・聞こえる範囲）、接近放送（何m手前で・聞こえる範囲）、
 *             通過待ち（指定座標を別の種別が通過するまで待機）
 *  ・停車シーケンス：停車3秒後にドア開 → （通過待ち）→ 発車メロディー・放送（1→2→3、0.5秒あき）
 *             → 最後の音の1.5秒後にドア閉 → 閉まった2.5秒後に発車
 *  ・ダイヤ（路線エディットの時刻表）に合わせて、経路を完全自動で運行
 *  ・前の列車との距離が近づくと減速し、近すぎると急停車
 *  ・プレイヤーから遠い列車は描画せず計算だけ行う（軽量化）
 *
 * 制限（正直に）：自動運転の列車には VVVF 音は付けません。プレイヤーの運転列車は衝突判定の対象外です。
 */
(function () {
'use strict';

// ============================================================
// 窓口・定数
// ============================================================
const VT = window.VoxelTrain, VD = window.VoxelDia;
if (!VT || !VD) { console.error('voxel-craft-train.js と voxel-craft-dia.js を先に読み込んでください'); return; }
const { lib, carById, buildCar, partsOf, applyAnimsEx, decodeCached, routeAt } = VT;
const V3 = THREE.Vector3;

const KEY = 'voxelcraft_station_v1';
const ROAD_KEY = 'voxelcraft_road_v1';
const DOOR_OPEN_DELAY = 3.0;     // 停車から開くまで（秒）
const CLOSE_AFTER_MELODY = 1.5;  // 最後の音が鳴り終わってから閉まるまで
const CLOSE_NO_MELODY = 3.0;     // 音がないとき、開いてから閉まるまで
const DEPART_AFTER_CLOSE = 2.5;  // 閉まってから発車まで
const SEQ_GAP = 0.5;             // 音と音の間のあき
const PASS_R = 2.5;              // 通過座標の判定半径（m）
const SPAWN_RANGE = 150;         // これより近い列車だけ描画（m）
const RANGE_DEF = 40;            // 聞こえる範囲の既定値（マス）
const COLL_SAFE = 3;             // これより近いと急停車（m）
const COLL_BRAKE = 6;            // これくらいの間隔まで減速して止まる（m）
const ASIDE_LAT = 1.2;           // 同じ線路上とみなす横方向の幅（m）。待避線は別の線路として扱う

// ============================================================
// 状態
// ============================================================
let sdb = { stations: [], auto: true };
const trains = [];
const pendingSpawns = [];         // 発車待ちの列車（出発地点があくまで待つ）
const fired = new Set();
const queue = [];                 // 放送の再生待ち：{ at, buf, st, range }
const stationBusy = new Map();    // 駅ごとに、放送が鳴り終わる時刻（順番に鳴らすため）
const passes = [];                // 座標の通過記録：{ key, typeId, t }
let waitCoords = [];
let gclock = 0;
let lastFrame = performance.now();
const visualCache = new Map();    // 車両ID → { root, length }
const ui = { edit: false, mode: 'place', panel: false, stId: null, typeId: null, lineId: null };
const rail = { sig: '', pieces: [], t: 0 };
let markerGrp = null, msgEl = null, msgT = 0, panelEl = null, barEl = null;

// ============================================================
// 補助
// ============================================================
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function uid() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function pad(n) { return String(n).padStart(2, '0'); }
function msg(t) {
  if (!msgEl) return;
  msgEl.textContent = t;
  msgEl.classList.add('show');
  clearTimeout(msgT);
  msgT = setTimeout(() => msgEl.classList.remove('show'), 2600);
}
function linesNow() { return VD.lines(); }
function lineById(id) { return linesNow().find(l => l.id === id) || null; }
function stationById(id) { return sdb.stations.find(s => s.id === id) || null; }
function typesOf(line) { return line ? line.types : []; }
function ts(st, typeId) {
  if (!st.types) st.types = {};
  if (!st.types[typeId]) st.types[typeId] = { stop: true, kmh: 0, wait: null, melodies: [], approach: [], arrivalSign: false };
  return st.types[typeId];
}

// ============================================================
// 保存・読み込み
// ============================================================
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(sdb)); return true; }
  catch (e) { msg('保存できませんでした（容量超過）'); return false; }
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (Array.isArray(s.stations)) sdb.stations = s.stations;
    if (typeof s.auto === 'boolean') sdb.auto = s.auto;
  } catch (e) {}
}
function rebuildWaitCoords() {
  waitCoords = [];
  for (const st of sdb.stations) for (const tid of Object.keys(st.types || {})) {
    const w = st.types[tid].wait;
    if (w) waitCoords.push({ key: ck(w.x, w.z), x: w.x, z: w.z });
  }
}
function ck(x, z) { return Math.round(x * 2) / 2 + ',' + Math.round(z * 2) / 2; }

// ============================================================
// 線路・経路（路線ファイルの経路を走行用に変換）
// ============================================================
function flatOf(pts) {
  const flat = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const d = b.clone().sub(a);
    const l = d.length();
    if (l < 1e-6) continue;
    const f = d.clone().divideScalar(l);
    flat.push({ c: a.clone().add(b).multiplyScalar(0.5), f, l, s0: total });
    total += l;
  }
  return { flat, total };
}
function projectS(route, p) {
  let best = Infinity, bs = 0;
  for (const seg of route.flat) {
    const a = seg.c.clone().addScaledVector(seg.f, -seg.l / 2);
    const u = clamp(p.clone().sub(a).dot(seg.f) / seg.l, 0, 1);
    const q = a.clone().addScaledVector(seg.f, u * seg.l);
    const dd = q.distanceTo(p);
    if (dd < best) { best = dd; bs = seg.s0 + u * seg.l; }
  }
  return { s: bs, d: best };
}
function routePts(R) { return R.pts.map(p => new V3(p[0], p[1], p[2])); }
// 路線上の駅（経路から4m以内にある駅）を、走行距離の順に並べる
function stopsOn(line, route, typeId) {
  const out = [];
  for (const st of sdb.stations) {
    if (st.lineId !== line.id) continue;
    if (st.types && st.types[typeId] && st.types[typeId].stop === false) continue;   // 通過する種別
    const pr = projectS(route, new V3(st.x, st.y, st.z));
    if (pr.d > 4) continue;
    if (pr.s < 0.5 || pr.s > route.total + 0.5) continue;
    out.push({ s: Math.min(pr.s, route.total), st });
  }
  out.sort((a, b) => a.s - b.s);
  return out;
}
function lineLength(line) {
  let n = 0;
  for (const c of line.formations) for (const id of c.cars) { const car = carById(id); if (car) n += car.length + VT.GAP; }
  return n;
}

// ============================================================
// 車両の見た目（必要なときだけ作る・同じ車両は一度だけ作って複製する）
// ============================================================
function visualOf(car) {
  if (!visualCache.has(car.id)) {
    visualCache.set(car.id, buildCar(car).then(b => ({ root: b.root, length: b.length })));
  }
  return visualCache.get(car.id);
}
async function ensureVisual(t) {
  if (t.cars || t.building) return;
  t.building = true;
  const arr = [];
  for (const id of t.carIds) {
    const car = carById(id);
    if (!car) continue;
    const v = await visualOf(car);
    const root = v.root.clone(true);
    root.traverse(o => { if (o.isMesh && o.material) o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone(); });
    arr.push({ car, root, parts: partsOf(root), length: v.length });
  }
  t.cars = arr;
  t.building = false;
}

// ============================================================
// 扉・幕アニメーション（名前から、どの側か・開閉か・幕かを判断する）
// ============================================================
function animKind(name) {
  const n = name.toLowerCase();
  let kind = null;
  if (/開|open|ひら/.test(n)) kind = 'open';
  else if (/閉|close|しめ/.test(n)) kind = 'close';
  else if (/幕|sign|maku|行先|行き先/.test(n)) kind = 'sign';
  let side = null;
  if (/左|left/.test(n) || /(^|[^a-z])l([^a-z]|$)/.test(n)) side = 'L';
  if (/右|right/.test(n) || /(^|[^a-z])r([^a-z]|$)/.test(n)) side = 'R';
  return { kind, side };
}
function sideOk(side, sides) {
  if (sides === 'N') return false;
  if (!side || sides === 'B') return true;
  return sides === side;
}
function carAnimPlan(car, sides) {
  const plan = { open: [], close: [], sign: [], ambient: [] };
  for (const name of Object.keys(car.anims || {})) {
    const k = animKind(name);
    if (k.kind === 'open' || k.kind === 'close') { if (sideOk(k.side, sides)) plan[k.kind].push(name); }
    else if (k.kind === 'sign') plan.sign.push(name);
    else plan.ambient.push(name);
  }
  return plan;
}
function animLocal(car, name, t) {
  const a = car.anims[name];
  if (!a) return 0;
  return a.loop ? (t % Math.max(0.01, a.length)) : Math.min(t, a.length);
}
// そのときの各アニメーションの再生時刻を決める
function animMap(t, car) {
  const map = {};
  const st = t.dwell && t.dwell.st;
  const plan = carAnimPlan(car, st ? st.sides : 'N');
  for (const name of plan.ambient) if (car.anims[name].loop) map[name] = animLocal(car, name, gclock);
  const dw = t.dwell;
  if (dw) {
    if (dw.closing) for (const n of plan.close) map[n] = animLocal(car, n, gclock - dw.closedG);
    else if (dw.opened) for (const n of plan.open) map[n] = animLocal(car, n, gclock - dw.openedAt);
    if (dw.ts && dw.ts.arrivalSign) for (const n of plan.sign) map[n] = animLocal(car, n, gclock - dw.arriveG);
  }
  return map;
}

// ============================================================
// 放送の再生（順番・範囲・聞こえる距離）
// ============================================================
function queueItems(items, st, earliest, openedAt) {
  VT.ensureAudio();
  return Promise.all(items.map(it => {
    const snd = VD.sounds().find(s => s.id === it.soundId);
    if (!snd) return null;
    return decodeCached(snd.data).then(buf => ({ buf, it })).catch(() => null);
  })).then(res => {
    let last = null;
    for (const r of res) {
      if (!r) continue;
      const prev = stationBusy.get(st.id) || 0;
      let at = Math.max((openedAt == null ? gclock : openedAt) + (r.it.delay || 0), earliest);
      if (prev > 0) at = Math.max(at, prev + SEQ_GAP);
      const end = at + r.buf.duration;
      stationBusy.set(st.id, end);
      queue.push({ at, buf: r.buf, st, range: r.it.range || RANGE_DEF });
      last = end;
    }
    queue.sort((a, b) => a.at - b.at);
    return last;
  });
}
function pumpQueue() {
  if (!queue.length) return;
  const A = VT.audio();
  if (!A.actx || !A.masterGain) return;
  while (queue.length && queue[0].at <= gclock) {
    const q = queue.shift();
    const d = Math.hypot(player.pos.x - q.st.x, player.pos.z - q.st.z);
    if (d > q.range) continue;   // 聞こえる範囲の外
    const src = A.actx.createBufferSource();
    const g = A.actx.createGain();
    src.buffer = q.buf;
    g.gain.value = 1 - 0.5 * (d / q.range);
    src.connect(g); g.connect(A.masterGain);
    src.start();
  }
}

// ============================================================
// 通過待ち
// ============================================================
function findPass(w, typeId, from) {
  const key = ck(w.x, w.z);
  for (let i = passes.length - 1; i >= 0; i--) {
    const p = passes[i];
    if (p.t < from || p.key !== key) continue;
    if (w.other ? p.typeId === w.other : p.typeId !== typeId) return p;
  }
  return null;
}
function recordPasses(t) {
  if (!t.head || !waitCoords.length) return;
  t.inside = t.inside || {};
  for (const c of waitCoords) {
    const d = Math.hypot(t.head.x - c.x, t.head.z - c.z);
    const inside = d < PASS_R;
    if (inside && !t.inside[c.key]) passes.push({ key: c.key, typeId: t.typeId, t: gclock });
    t.inside[c.key] = inside;
  }
  if (passes.length > 300) passes.splice(0, passes.length - 300);
}

// ============================================================
// 列車（自動運転）
// ============================================================
function spawn(line, R, fromTime) {
  const F = (R.formId && line.formations.find(f => f.id === R.formId)) || line.formations[0];
  if (!F || !F.cars.length) { msg(`「${R.name}」の編成がありません`); return null; }
  const route = flatOf(routePts(R));
  if (route.total < 1) return null;
  const t = {
    id: uid(), line, routeId: R.id, typeId: R.typeId, carIds: F.cars.slice(), endAction: R.endAction === 'return' ? 'return' : 'remove',
    pts: routePts(R), route, s: 0, speed: 0, cap: Infinity,
    cruiseKmh: lib.maxKmh, stops: [], si: 0, state: 'run', dwell: null,
    reversed: false, cars: null, building: false, shown: false, head: null, dir: null,
    dead: false, len: 0, inside: {}, fired: new Set()
  };
  t.len = F.cars.reduce((n, id) => { const c = carById(id); return n + (c ? c.length + VT.GAP : 0); }, 0);
  t.stops = stopsOn(line, t.route, R.typeId);
  trains.push(t);
  return t;
}
// 出発地点の近くに別の列車がいないか
function startClear(R) {
  const route = flatOf(routePts(R));
  const p0 = routeAt(route, 0).pos;
  for (const t of trains) {
    if (t.dead || !t.head) continue;
    if (Math.hypot(t.head.x - p0.x, t.head.z - p0.z) < (t.len || 20) + 12) return false;
  }
  return true;
}
function processPending() {
  for (let i = pendingSpawns.length - 1; i >= 0; i--) {
    const q = pendingSpawns[i];
    if (startClear(q.R)) { spawn(q.line, q.R); pendingSpawns.splice(i, 1); }
  }
}
function reverseTrain(t) {
  t.pts = t.pts.slice().reverse();
  t.route = flatOf(t.pts);
  t.s = 0; t.speed = 0; t.si = 0; t.state = 'run'; t.dwell = null;
  t.stops = stopsOn(t.line, t.route, t.typeId);
  t.reversed = !t.reversed;
}
function newDwell(stop) {
  const st = stop.st;
  const tset = ts(st, lineTypeOf(stop, st));
  return {
    st, ts: tset, arriveG: gclock, openG: gclock + DOOR_OPEN_DELAY,
    opened: false, openedAt: null, waiting: !!tset.wait, waitFrom: gclock, waitDone: null,   // 停車した時点から通過を待つ
    melodyReady: false, melodyEnd: null, closing: false, closedG: null, departG: null
  };
}
function lineTypeOf(stop, st) { return stop.typeId; }

function arrive(t, stop) {
  t.speed = 0;
  t.state = 'dwell';
  stop.typeId = t.typeId;
  t.dwell = newDwell(stop);
  t.dwell.st = stop.st;
  t.dwell.ts = ts(stop.st, t.typeId);
  t.dwell.stop = stop;
  t.dwell.typeId = t.typeId;
}

// 停車中の流れ（ドア開 → 通過待ち → 放送 → ドア閉 → 発車）
function updateDwell(t) {
  const dw = t.dwell, tsx = dw.ts, st = dw.st;
  if (!dw.opened && gclock >= dw.openG) {
    dw.opened = true;
    dw.openedAt = gclock;
    if (!tsx.wait) startMelodies(t, dw, null);
  }
  if (dw.waiting && dw.waitDone == null) {
    const p = findPass(tsx.wait, t.typeId, dw.waitFrom);
    if (p) { dw.waitDone = p.t; dw.waiting = false; startMelodies(t, dw, p.t); }
  }
  if (dw.opened && !dw.closing && dw.melodyReady && (!tsx.wait || dw.waitDone != null)) {
    let closeAt = dw.melodyEnd != null ? dw.melodyEnd + CLOSE_AFTER_MELODY : dw.openedAt + CLOSE_NO_MELODY;
    if (dw.waitDone != null) closeAt = Math.max(closeAt, dw.waitDone + CLOSE_AFTER_MELODY);
    if (gclock >= closeAt) { dw.closing = true; dw.closedG = gclock; }
  }
  if (dw.closing && gclock >= dw.closedG + DEPART_AFTER_CLOSE) depart(t, dw);
}
function startMelodies(t, dw, waitDone) {
  const items = dw.ts.melodies.filter(m => m.soundId);
  if (!items.length) { dw.melodyReady = true; dw.melodyEnd = null; return; }
  const earliest = waitDone != null ? waitDone : dw.openedAt;
  queueItems(items.map(m => ({ soundId: m.soundId, delay: m.delay || 0, range: m.range || RANGE_DEF })), dw.st, earliest, dw.openedAt)
    .then(end => { dw.melodyEnd = end; dw.melodyReady = true; });
}
function depart(t, dw) {
  const st = dw.st;
  // 次の駅までの速度（この種別のこの駅の設定）
  t.cruiseKmh = dw.ts.kmh > 0 ? dw.ts.kmh : lib.maxKmh;
  t.dwell = null;
  t.state = 'run';
  t.si++;
  if (t.si >= t.stops.length) {
    // 終点の駅：折り返し（設定）なら戻る、そうでなければ消える
    if (!t.reversed && (t.endAction === 'return' || st.turnback)) reverseTrain(t);   // 折り返して戻る
    else if (!t.reversed) t.dead = true;                                             // 戻らない：消える
    // 戻り途中（t.reversed）の最後の停車駅を出たあとは、始点まで走って消える（endOfRun）
  }
}

// 接近放送：次の駅まで、設定したマス数に近づいたら鳴らす（各放送は一度だけ）
function checkApproach(t, nxt) {
  const dist = nxt.s - t.s;
  const c = ts(nxt.st, t.typeId);
  c.approach.forEach((m, i) => {
    const key = nxt.st.id + '|' + i;
    if (t.fired.has(key) || !m.soundId || dist > m.trigger) return;
    t.fired.add(key);
    queueItems([{ soundId: m.soundId, delay: 0, range: m.range || RANGE_DEF }], nxt.st, gclock, gclock);
  });
}
// 終点に着いたあと：「始点に戻る」設定なら逆向きに戻り、戻り切ったら消える
function endOfRun(t) {
  if (!t.reversed && t.endAction === 'return') reverseTrain(t);
  else t.dead = true;
}
function moveTrain(t, dt) {
  const L = t.line;
  const accel = L.accel, decel = L.decel;
  const nxt = t.stops[t.si];
  if (nxt) checkApproach(t, nxt);
  let target = Math.min(t.cruiseKmh, lib.maxKmh) / 3.6;
  if (nxt) {
    const dist = nxt.s - t.s;
    if (dist < 0.02 && t.speed < 0.3) { arrive(t, nxt); return; }
    target = Math.min(target, Math.sqrt(2 * decel * Math.max(0, dist)));
  }
  target = Math.min(target, t.cap);
  if (t.cap <= 0) t.speed = 0;                       // 急停車
  else if (t.speed < target) t.speed = Math.min(target, t.speed + accel * dt);
  else t.speed = Math.max(target, t.speed - decel * 1.5 * dt);
  const ds = t.speed * dt;
  if (nxt && t.s + ds >= nxt.s) { t.s = nxt.s; t.speed = 0; arrive(t, nxt); return; }
  t.s += ds;
  if (!nxt && t.s >= t.route.total - 0.2) endOfRun(t);     // 停車駅のない終点
}

// 前の列車との距離で速度の上限を決める（同じ線路上の列車だけ見る）
function collisionCaps() {
  const cell = 30;
  const grid = new Map();
  const key = (x, z) => Math.floor(x / cell) + ',' + Math.floor(z / cell);
  const live = trains.filter(t => !t.dead && t.head);
  for (const t of live) {
    const k = key(t.head.x, t.head.z);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(t);
    t.cap = Infinity;
  }
  for (const a of live) {
    const cx = Math.floor(a.head.x / cell), cz = Math.floor(a.head.z / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const arr = grid.get((cx + dx) + ',' + (cz + dz));
      if (!arr) continue;
      for (const b of arr) {
        if (b === a) continue;
        const vx = b.head.x - a.head.x, vz = b.head.z - a.head.z;
        const dlen = a.dir ? Math.hypot(a.dir.x, a.dir.z) || 1 : 1;
        const fx = a.dir ? a.dir.x / dlen : 0, fz = a.dir ? a.dir.z / dlen : 0;
        const proj = vx * fx + vz * fz;
        if (proj <= 0 || proj > 60) continue;
        const lat = Math.abs(-vx * fz + vz * fx);
        if (lat > ASIDE_LAT) continue;
        const gap = proj - (a.len + b.len) / 2;
        if (gap < COLL_SAFE) a.cap = 0;
        else a.cap = Math.min(a.cap, Math.sqrt(2 * a.line.decel * Math.max(0, gap - COLL_BRAKE)));
      }
    }
  }
}

function updateTrainPos(t) {
  const r = routeAt(t.route, t.s);
  t.head = r.pos.clone();
  t.dir = r.dir.clone();
}
function renderTrain(t) {
  const d = t.head ? Math.hypot(player.pos.x - t.head.x, player.pos.z - t.head.z) : Infinity;
  if (d < SPAWN_RANGE) {
    if (!t.cars) { ensureVisual(t); return; }
    if (!t.shown) { for (const c of t.cars) scene.add(c.root); t.shown = true; }
    placeCars(t);
  } else if (t.shown) {
    for (const c of t.cars) scene.remove(c.root);
    t.shown = false;
  }
}
function placeCars(t) {
  let front = t.s;
  for (const c of t.cars) {
    const center = front - c.length / 2;
    const head = routeAt(t.route, center + c.length / 2);
    const tail = routeAt(t.route, center - c.length / 2);
    const mid = routeAt(t.route, center);
    const dir = head.pos.clone().sub(tail.pos);
    if (dir.lengthSq() < 1e-8) dir.copy(mid.dir);
    c.root.position.copy(mid.pos);
    c.root.lookAt(mid.pos.clone().add(dir.normalize()));
    applyAnimsEx(c.car, c.parts, animMap(t, c.car));
    front = center - c.length / 2 - VT.GAP;
  }
}

// ============================================================
// ダイヤ：時刻になったら、その経路を走らせる
// ============================================================
function dispatchCheck() {
  const d = new Date();
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  const dk = d.toDateString();
  for (const line of linesNow()) for (const R of line.routes) {
    if (!R.dep || !R.dep.includes(hm)) continue;
    const k = dk + '|' + R.id + '|' + hm;
    if (fired.has(k)) continue;
    fired.add(k);
    if (fired.size > 5000) fired.clear();
    pendingSpawns.push({ line, R });
  }
}

// ============================================================
// 毎フレーム
// ============================================================
function updateAll(dt) {
  rebuildWaitCoords();   // 駅の設定が変わっても取りこぼさないよう、毎回作り直す（件数は少ない）
  // 先に、各列車の位置と向きを決める（衝突判定に使う）
  for (const t of trains) if (!t.dead) updateTrainPos(t);
  collisionCaps();
  for (const t of trains) {
    if (t.dead) continue;
    if (t.state === 'run') moveTrain(t, dt);
    else if (t.state === 'dwell') updateDwell(t);
    if (t.dead) continue;
    updateTrainPos(t);
    recordPasses(t);
    renderTrain(t);
  }
  for (let i = trains.length - 1; i >= 0; i--) {
    const t = trains[i];
    if (!t.dead) continue;
    if (t.cars && t.shown) for (const c of t.cars) scene.remove(c.root);
    trains.splice(i, 1);
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (started && !paused) {
    gclock += dt;
    if (sdb.auto) dispatchCheck();
    updateAll(dt);
    pumpQueue();
  }
  if (started && !paused) processPending();
  refreshRail(false);
  updateBar();
}

// ============================================================
// 駅の登録（線路をタップ）
// ============================================================
function refreshRail(force) {
  const now = performance.now();
  if (!force && now - rail.t < 1500) return;
  rail.t = now;
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(ROAD_KEY) || '{}'); } catch (e) {}
  const src = (raw.pieces || []).filter(p => p.kind === 'rail');
  const sig = src.length + '|' + (raw.gid || 0);
  if (sig === rail.sig) return;
  rail.sig = sig;
  rail.pieces = src.map(p => {
    const f = new V3(0, 0, 1).applyQuaternion(new THREE.Quaternion(p.q[0], p.q[1], p.q[2], p.q[3]));
    return { mid: new V3(p.x, p.y, p.z), l: p.l, f };
  });
}
function pickRail(maxD) {
  refreshRail(false);
  if (!rail.pieces.length) return null;
  const cam = camera.position;
  const d = camera.getWorldDirection(new V3());
  let best = null, bs = Infinity;
  for (const pc of rail.pieces) {
    const t = clamp(pc.mid.clone().sub(cam).dot(d), 0, 80);
    const dist = cam.clone().addScaledVector(d, t).distanceTo(pc.mid);
    if (dist > maxD) continue;
    const score = dist + 0.02 * t;
    if (score < bs) { bs = score; best = pc.mid.clone(); }
  }
  return best;
}
function stationTap() {
  const p = pickRail(2.0);
  if (!p) { msg('線路に向けてタップしてください'); return; }
  if (ui.mode === 'pass') {
    const st = stationById(ui.stId);
    if (!st || !ui.typeId) { msg('パネルで駅と種別を選んでください'); return; }
    const t = ts(st, ui.typeId);
    t.wait = { x: Math.round(p.x * 2) / 2, z: Math.round(p.z * 2) / 2, other: t.wait ? t.wait.other : null };
    rebuildWaitCoords(); save(); renderPanel(); updateMarkers();
    msg('通過座標を設定しました');
    return;
  }
  // 駅を置く：近くに経路がある路線を探す
  let line = null, bd = 6;
  for (const L of linesNow()) for (const R of L.routes) {
    const route = flatOf(routePts(R));
    const pr = projectS(route, p);
    if (pr.d < bd) { bd = pr.d; line = L; }
  }
  if (!line) { msg('近くに経路がありません。先に路線の経路を登録してください'); return; }
  const n = sdb.stations.filter(s => s.lineId === line.id).length + 1;
  const st = { id: uid(), lineId: line.id, name: '駅' + n, x: r3(p.x), y: r3(p.y), z: r3(p.z), sides: 'B', turnback: false, types: {} };
  sdb.stations.push(st);
  ui.stId = st.id;
  save(); rebuildWaitCoords(); renderPanel(); updateBar(); updateMarkers();
  msg(`「${st.name}」を登録しました（${line.name}）`);
}
function r3(v) { return Math.round(v * 1000) / 1000; }

// ============================================================
// 表示（駅の印・通過座標の印）
// ============================================================
function updateMarkers() {
  if (markerGrp) { scene.remove(markerGrp); markerGrp.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); markerGrp = null; }
  if (!ui.edit && !ui.panel) return;
  const g = new THREE.Group();
  const add = (x, y, z, col, sz) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sz, sz, sz), new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 0.9 }));
    m.position.set(x, y + 1.2, z);
    m.renderOrder = 11;
    g.add(m);
  };
  for (const st of sdb.stations) {
    add(st.x, st.y, st.z, st.id === ui.stId ? 0xffd84a : 0x66e0ff, 1.2);
    for (const tid of Object.keys(st.types || {})) {
      const w = st.types[tid].wait;
      if (w) add(w.x, st.y, w.z, 0xc39bff, 0.7);
    }
  }
  scene.add(g);
  markerGrp = g;
}

// ============================================================
// 設定パネル
// ============================================================
function renderPanel() {
  if (!panelEl) return;
  const body = document.getElementById('stBody');
  const lines = linesNow();
  const L = lineById(ui.lineId) || lines[0] || null;
  ui.lineId = L ? L.id : null;
  let h = '';
  h += `<div class="st-row"><label><input type="checkbox" id="stAuto" ${sdb.auto ? 'checked' : ''}> 時刻表どおりに完全自動で運行する</label>
    <span class="st-note">時刻表は路線エディットで設定（経路の時刻表欄）</span></div>`;
  h += `<div class="st-row"><button class="st-btn ${ui.edit ? 'on' : ''}" data-a="toggleEdit">駅編集：${ui.edit ? 'ON（線路をタップで駅を置く）' : 'OFF'}（Pキー）</button>
    <button class="st-btn" data-a="modePlace">駅を置く</button>
    <button class="st-btn" data-a="modePass">通過座標を置く</button></div>`;
  h += `<div class="st-row">路線 <select data-f="line">${lines.map(l => `<option value="${esc(l.id)}" ${L && L.id === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>`;

  const sts = sdb.stations.filter(s => L && s.lineId === L.id);
  h += `<h3>駅（${sts.length}）</h3>`;
  for (const st of sts) {
    h += `<div class="st-item ${ui.stId === st.id ? 'sel' : ''}"><button class="st-btn small" data-a="selSt" data-id="${esc(st.id)}">選択</button>
      <span>${esc(st.name)}</span><span class="st-note">(${Math.round(st.x)}, ${Math.round(st.z)})</span></div>`;
  }
  const S = stationById(ui.stId);
  if (S && L && S.lineId === L.id) {
    h += `<h3>${esc(S.name)} の設定</h3>`;
    h += `<div class="st-row">名前 <input data-f="sname" value="${esc(S.name)}">
      ドア <select data-f="sides">
        <option value="L" ${S.sides === 'L' ? 'selected' : ''}>左</option>
        <option value="R" ${S.sides === 'R' ? 'selected' : ''}>右</option>
        <option value="B" ${S.sides === 'B' ? 'selected' : ''}>両方</option>
        <option value="N" ${S.sides === 'N' ? 'selected' : ''}>開けない</option></select>
      <label><input type="checkbox" data-f="turnback" ${S.turnback ? 'checked' : ''}> この駅で折り返す</label>
      <button class="st-btn small danger" data-a="delSt">駅を削除</button></div>`;
    const types = typesOf(L);
    h += `<h3>種別ごとの設定</h3><div class="st-row">種別 <select data-f="stType">${types.map(t => `<option value="${esc(t.id)}" ${ui.typeId === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>`;
    const T = types.find(t => t.id === ui.typeId) || types[0];
    if (T) {
      ui.typeId = T.id;
      const c = ts(S, T.id);
      h += `<div class="st-row"><label><input type="checkbox" data-f="stopOn" ${c.stop !== false ? 'checked' : ''}> この種別はこの駅に停車する（外すと通過）</label></div>`;
      h += `<div class="st-row">次の駅まで <input type="number" min="0" max="${lib.maxKmh}" step="5" data-f="kmh" value="${c.kmh}" style="width:80px"> km/h（0＝上限 ${lib.maxKmh} km/h）
        <label><input type="checkbox" data-f="sign" ${c.arrivalSign ? 'checked' : ''}> 到着時に幕アニメーション</label></div>`;
      const w = c.wait;
      const otherOpts = types.filter(t => t.id !== T.id);
      h += `<div class="st-row"><label><input type="checkbox" data-f="waitOn" ${w ? 'checked' : ''}> 通過待ちをする</label>
        ${w ? `座標 (${w.x}, ${w.z}) 　待つ相手 <select data-f="waitOther"><option value="">ほかのすべての種別</option>${otherOpts.map(t => `<option value="${esc(t.id)}" ${w.other === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
        <button class="st-btn small" data-a="setPass">座標を置き直す</button>` : '<span class="st-note">「通過座標を置く」で座標を指定してください</span>'}</div>`;
      h += `<h4>発車メロディー・扉閉放送（ドアが開いてから何秒後／聞こえる範囲）</h4>`;
      c.melodies.forEach((m, i) => {
        h += `<div class="st-item">${i + 1}. ${soundSelect('mSound', i, m.soundId)} 開いて <input type="number" min="0" step="0.5" data-f="mDelay" data-i="${i}" value="${m.delay}" style="width:60px">秒後
          範囲 <input type="number" min="1" step="1" data-f="mRange" data-i="${i}" value="${m.range}" style="width:60px">マス
          <button class="st-btn small danger" data-a="delMel" data-i="${i}">削除</button></div>`;
      });
      h += `<div class="st-row"><button class="st-btn" data-a="addMel">発車メロディー・放送を追加</button></div>`;
      h += `<h4>接近放送（駅から路線内何マスに近づいたら／聞こえる範囲）</h4>`;
      c.approach.forEach((m, i) => {
        h += `<div class="st-item">${i + 1}. ${soundSelect('aSound', i, m.soundId)} 手前 <input type="number" min="1" step="1" data-f="aTrig" data-i="${i}" value="${m.trigger}" style="width:60px">マス
          範囲 <input type="number" min="1" step="1" data-f="aRange" data-i="${i}" value="${m.range}" style="width:60px">マス
          <button class="st-btn small danger" data-a="delApp" data-i="${i}">削除</button></div>`;
      });
      h += `<div class="st-row"><button class="st-btn" data-a="addApp">接近放送を追加</button></div>`;
    }
  }

  h += `<h3>手動テスト</h3><div class="st-row">`;
  const allR = L ? L.routes : [];
  h += `<select id="stTestRoute">${allR.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}</select>
    <button class="st-btn" data-a="testRun">今すぐ1本発車させる</button>
    <span class="st-note">稼働中：${trains.length} 本</span></div>`;
  body.innerHTML = h;
  const ac = document.getElementById('stAuto');
  if (ac) ac.addEventListener('change', () => { sdb.auto = ac.checked; save(); });
}
function soundSelect(f, i, cur) {
  return `<select data-f="${f}" data-i="${i}"><option value="">（なし）</option>${VD.sounds().map(s => `<option value="${esc(s.id)}" ${cur === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`;
}
function curST() { return stationById(ui.stId); }
function curTS() { const S = curST(); return S && ui.typeId ? ts(S, ui.typeId) : null; }
function onClick(e) {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  const a = b.dataset.a, id = b.dataset.id, i = Number(b.dataset.i);
  const S = curST(), c = curTS();
  switch (a) {
    case 'toggleEdit': setEdit(!ui.edit); break;
    case 'modePlace': ui.mode = 'place'; setEdit(true); msg('線路をタップして駅を置きます'); closePanel(); return;
    case 'modePass':
      if (!S || !ui.typeId) { msg('駅と種別を選んでください'); return; }
      ui.mode = 'pass'; setEdit(true); msg('通過待ちに使う線路の位置をタップ'); closePanel(); return;
    case 'selSt': ui.stId = id; break;
    case 'delSt':
      if (!S || !confirm(`「${S.name}」を削除しますか？`)) return;
      sdb.stations = sdb.stations.filter(s => s !== S); ui.stId = null; break;
    case 'setPass': ui.mode = 'pass'; setEdit(true); msg('通過座標を置き直す線路をタップ'); closePanel(); return;
    case 'addMel': if (c) c.melodies.push({ soundId: null, delay: 0, range: RANGE_DEF }); break;
    case 'delMel': if (c) c.melodies.splice(i, 1); break;
    case 'addApp': if (c) c.approach.push({ soundId: null, trigger: 60, range: RANGE_DEF }); break;
    case 'delApp': if (c) c.approach.splice(i, 1); break;
    case 'testRun': {
      const L = lineById(ui.lineId);
      const R = L && L.routes.find(r => r.id === document.getElementById('stTestRoute').value);
      if (!R) { msg('経路がありません'); return; }
      if (!started) { msg('ゲームを開始してから実行してください'); return; }
      VT.ensureAudio();
      pendingSpawns.push({ line: L, R }); msg(`「${R.name}」を発車待ちに入れました（出発地点があき次第発車）`);
      break;
    }
    default: return;
  }
  afterChange();
}
function onChange(e) {
  const el = e.target, f = el.dataset.f;
  if (!f) return;
  const S = curST(), c = curTS(), i = Number(el.dataset.i);
  switch (f) {
    case 'line': ui.lineId = el.value; ui.stId = null; ui.typeId = null; break;
    case 'stType': ui.typeId = el.value; break;
    case 'sname': if (S) S.name = el.value.trim() || S.name; break;
    case 'sides': if (S) S.sides = el.value; break;
    case 'turnback': if (S) S.turnback = el.checked; break;
    case 'kmh': if (c) c.kmh = clamp(Math.round(Number(el.value) || 0), 0, lib.maxKmh); break;
    case 'sign': if (c) c.arrivalSign = el.checked; break;
    case 'stopOn': if (c) c.stop = el.checked; break;
    case 'waitOn':
      if (!c) break;
      if (el.checked) { if (!c.wait) c.wait = { x: S.x, z: S.z, other: null }; msg('通過座標は「座標を置き直す」で指定してください'); }
      else c.wait = null;
      break;
    case 'waitOther': if (c && c.wait) c.wait.other = el.value || null; break;
    case 'mSound': if (c) c.melodies[i].soundId = el.value || null; break;
    case 'mDelay': if (c) c.melodies[i].delay = Math.max(0, Number(el.value) || 0); break;
    case 'mRange': if (c) c.melodies[i].range = Math.max(1, Math.round(Number(el.value) || RANGE_DEF)); break;
    case 'aSound': if (c) c.approach[i].soundId = el.value || null; break;
    case 'aTrig': if (c) c.approach[i].trigger = Math.max(1, Math.round(Number(el.value) || 60)); break;
    case 'aRange': if (c) c.approach[i].range = Math.max(1, Math.round(Number(el.value) || RANGE_DEF)); break;
    default: return;
  }
  afterChange();
}
function afterChange() {
  save(); rebuildWaitCoords(); renderPanel(); updateMarkers();
}
function setEdit(on) {
  ui.edit = !!on;
  if (!ui.edit) ui.mode = 'place';
  renderPanel(); updateBar(); updateMarkers();
}
function openPanel() {
  if (settingsEl.classList.contains('show')) return;
  ui.panel = true;
  panelEl.classList.add('show');
  menuOpen = true;
  releaseActions();
  for (const k in keys) keys[k] = false;
  if (document.pointerLockElement) document.exitPointerLock();
  renderPanel(); updateBar(); updateMarkers();
}
function closePanel() {
  if (!ui.panel) return;
  ui.panel = false;
  panelEl.classList.remove('show');
  menuOpen = false;
  if (!isTouch && started) {
    const p = canvas.requestPointerLock && canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => {});
  }
  updateBar();
}
function updateBar() {
  if (!barEl) return;
  const show = ui.edit && started && !menuOpen && !paused && !ui.panel;
  barEl.style.display = show ? 'flex' : 'none';
}

// ============================================================
// 入力の割り込み（駅編集中だけ、線路への操作を横取りする）
// ============================================================
const pPlace = window.doPlace, pBreak = window.doBreak;
const pStart = window.startAct, pStop = window.stopAct;
window.doPlace = function () {
  if (ui.edit && !ui.panel) return stationTap();
  return pPlace();
};
window.doBreak = function () {
  if (ui.edit && !ui.panel) {
    // 左クリック：照準の近くの駅を消す（駅の印を狙う）
    const cam = camera.position, d = camera.getWorldDirection(new V3());
    let best = null, bd = 2.5;
    for (const st of sdb.stations) {
      const p = new V3(st.x, st.y + 1.2, st.z);
      const t = clamp(p.clone().sub(cam).dot(d), 0, 80);
      const dist = cam.clone().addScaledVector(d, t).distanceTo(p);
      if (dist < bd) { bd = dist; best = st; }
    }
    if (best) {
      if (confirm(`「${best.name}」を削除しますか？`)) { sdb.stations = sdb.stations.filter(s => s !== best); ui.stId = null; afterChange(); }
    } else msg('削除する駅を照準に合わせてください');
    return;
  }
  return pBreak();
};
window.startAct = function (kind) {
  if (ui.edit && !ui.panel && (kind === 'break' || kind === 'place')) {
    if (acts[kind]) return;
    acts[kind] = 'station';
    if (kind === 'break') window.doBreak(); else stationTap();
    return;
  }
  return pStart(kind);
};
window.stopAct = function (kind) {
  if (acts[kind] === 'station') { acts[kind] = null; return; }
  return pStop(kind);
};
window.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.code === 'Escape' && ui.panel) { closePanel(); return; }
  if (!started || ui.panel || menuOpen) return;
  if (e.code === 'KeyP') setEdit(!ui.edit);
});

// ============================================================
// 画面の要素
// ============================================================
function tapBtn(el, fn) {
  el.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); fn(); }, { passive: false });
  el.addEventListener('touchend', e => { e.preventDefault(); e.stopPropagation(); }, { passive: false });
  el.addEventListener('click', e => { e.stopPropagation(); fn(); });
}
function buildUI() {
  const style = document.createElement('style');
  style.textContent = `
  #stBtn{position:fixed;right:10px;top:300px;z-index:6;background:rgba(0,0,0,.45);color:#fff;
    border:1px solid rgba(255,255,255,.4);border-radius:6px;padding:7px 11px;font-size:13px;cursor:pointer}
  #stBar{position:fixed;left:50%;bottom:150px;transform:translateX(-50%);z-index:8;display:none;gap:6px}
  #stBar button{background:rgba(0,0,0,.6);color:#fff;border:2px solid #fff;border-radius:10px;padding:10px 14px;
    font-size:14px;font-weight:bold;touch-action:manipulation;cursor:pointer}
  #stToast{position:fixed;left:50%;top:22%;transform:translateX(-50%);background:rgba(0,0,0,.75);color:#fff;
    padding:8px 14px;border-radius:8px;z-index:63;opacity:0;transition:opacity .3s;pointer-events:none;font-size:13px;max-width:90vw}
  #stToast.show{opacity:1}
  .st-panel{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:44}
  .st-panel.show{display:flex}
  .st-box{background:#1b2530;color:#fff;border-radius:10px;padding:14px;width:min(96vw,760px);max-height:94vh;
    overflow:auto;box-sizing:border-box;font-size:14px;box-shadow:0 6px 24px rgba(0,0,0,.5)}
  .st-head{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .st-box h2{margin:0 0 8px;font-size:18px}
  .st-box h3{margin:14px 0 6px;font-size:14px;color:#cfe3f5}
  .st-box h4{margin:10px 0 4px;font-size:13px;color:#ffe38a}
  .st-note{font-size:12px;color:#9fb3c8}
  .st-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:6px}
  .st-item{display:flex;gap:6px;flex-wrap:wrap;align-items:center;background:rgba(255,255,255,.06);border-radius:6px;padding:5px 6px;margin-top:4px}
  .st-item.sel{outline:1px solid #8fd08f}
  .st-btn{background:#2e4a66;color:#fff;border:none;border-radius:6px;padding:7px 12px;cursor:pointer;font-size:13px}
  .st-btn.small{padding:4px 8px;font-size:12px}
  .st-btn.danger{background:#7a3030}
  .st-btn.on{background:#4a7a3a}
  .st-box input,.st-box select{background:#2a3846;color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:4px;padding:4px 6px;font-size:13px;max-width:100%}
  `;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.id = 'stBtn';
  btn.textContent = '🚉 駅';
  document.body.appendChild(btn);
  btn.addEventListener('click', e => { e.stopPropagation(); openPanel(); });

  barEl = document.createElement('div');
  barEl.id = 'stBar';
  barEl.innerHTML = `<button id="stBarPanel">設定</button><button id="stBarEnd">駅編集終了</button>`;
  document.body.appendChild(barEl);
  tapBtn(document.getElementById('stBarPanel'), openPanel);
  tapBtn(document.getElementById('stBarEnd'), () => setEdit(false));

  msgEl = document.createElement('div');
  msgEl.id = 'stToast';
  document.body.appendChild(msgEl);

  panelEl = document.createElement('div');
  panelEl.className = 'st-panel';
  panelEl.id = 'stPanel';
  panelEl.innerHTML = `<div class="st-box"><div class="st-head"><h2>駅設定・自動運転</h2><button class="st-btn" id="stClose">閉じる</button></div>
    <div id="stBody"></div></div>`;
  document.body.appendChild(panelEl);
  panelEl.addEventListener('click', onClick);
  panelEl.addEventListener('change', onChange);
  document.getElementById('stClose').addEventListener('click', closePanel);
}

// ============================================================
// 初期化
// ============================================================
function init() {
  load();
  rebuildWaitCoords();
  buildUI();
  renderPanel();
  requestAnimationFrame(frame);
}
// 動作確認・他ファイルからの呼び出し用の窓口
window.VoxelStation = {
  spawn: (lineId, routeId) => {
    const L = lineById(lineId), R = L && L.routes.find(r => r.id === routeId);
    if (!R) return false;
    pendingSpawns.push({ line: L, R });
    return true;
  },
  trains: () => trains.map(t => ({ id: t.id, s: t.s, speed: t.speed, state: t.state, si: t.si, dead: t.dead, len: t.len })),
  clock: () => gclock,
  stations: () => sdb.stations
};
init();

})();
