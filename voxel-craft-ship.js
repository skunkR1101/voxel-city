/* voxel-craft-ship.js (v3)  船
 * ・船メーカー（道具）を持つと、ホットバーの上に帯（範囲を船にする／船の一覧／タップの種類／座席クリア）が出ます
 * ・範囲を選んだ状態で、範囲内のブロックをタップ → 座席（または操縦席）になります（帯の「タップの種類」で切り替え）
 * ・座席・操縦席に近づくと「乗る」（PC：X キー、スマホ：画面の「乗る」ボタン）。操縦席は運転、座席は乗るだけ
 * ・運転：W・S（前進・後進）、A・D（舵）／画面のボタン。降りる：X キー（または「降りる」）
 * ・当たり判定：1.0マスの通常ブロック（傾き・0.5マスは当たらない）。陸や建物にぶつかると止まる（壁沿いは滑る）
 * ・「ブロックに戻す」：船を消して、元のブロック（傾きも）を、船のいる場所に戻す（向きは90°単位）
 * ・マルチプレイ：船の情報は部屋の状態（voxelcraft_ship_v1）で共有。船の動きは乗っている人が 0.1 秒ごとに送る（保存しない）
 */
(function () {
'use strict';

const VX = window.VoxelExt, VC = window.VoxelConvert;
if (!VX || !VC || !VC.gather || typeof VX.T_SHIP_MAKER !== 'number') {
  console.error('voxel-craft-ship: 必要な部品が見つかりません');
  return;
}

const T_SHIP = VX.T_SHIP_MAKER;
const META_KEY = 'voxelcraft_ship_v1';
const SHAPE_PREFIX = 'shipblk:';
const RETRY_MS = 3000, RETRY_MAX = 10;
const HULL_BOARD_DIST = 6;     // 座席が無い船は、船の近く（この距離）で操縦席として乗れる
const SEAT_DIST = 2.5;         // 座席・操縦席は、この距離まで近づくと乗れる
const MOVE_SEND_MS = 100;
const MAX_STEP = 0.2;          // 1回の計算で進む最大距離（壁をすり抜けないように、分けて計算する）
const CLASSES = [
  { name: 'ヨット',   maxV: 9,   thrust: 4.0, drag: 0.6, turn: 1.6 },
  { name: '小型船',   maxV: 7,   thrust: 3.0, drag: 0.6, turn: 1.3 },
  { name: 'フェリー', maxV: 5,   thrust: 2.0, drag: 0.5, turn: 0.9 },
  { name: '大型客船', maxV: 3.6, thrust: 1.3, drag: 0.4, turn: 0.6 },
  { name: '大型軍艦', maxV: 5.5, thrust: 1.8, drag: 0.5, turn: 0.7 }
];
const SAMPLES = [[0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]];

// ============================================================
// 純粋な計算（テストしやすいように分けてある）
// ============================================================
// cells：船の中の1.0マスの位置（x,z は角、y は船の底からの段）。外側の柱だけを返す
function buildCols(cells) {
  const all = new Map();
  for (const c of cells) {
    const k = c.x + ',' + c.z;
    let col = all.get(k);
    if (!col) { col = { x: c.x, z: c.z, ys: new Set() }; all.set(k, col); }
    col.ys.add(c.y);
  }
  const has = (x, z) => all.has(x + ',' + z);
  const perim = [];
  for (const col of all.values()) {
    if (!(has(col.x + 1, col.z) && has(col.x - 1, col.z) && has(col.x, col.z + 1) && has(col.x, col.z - 1))) {
      perim.push({ x: col.x, z: col.z, ys: [...col.ys] });
    }
  }
  return perim;
}

// 船（位置 px,py,pz、向き yaw）の外側の柱が、ぶつかるブロックに重なるか
function footprintHits(perim, px, py, pz, yaw, blocked) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (const col of perim) {
    for (const [ox, oz] of SAMPLES) {
      const lx = col.x + ox, lz = col.z + oz;
      const wx = px + c * lx + s * lz;
      const wz = pz - s * lx + c * lz;
      const bx = Math.floor(wx), bz = Math.floor(wz);
      for (const dy of col.ys) {
        const by0 = Math.floor(py + dy + 0.05);
        const by1 = Math.floor(py + dy + 0.95);
        if (blocked(bx, by0, bz)) return true;
        if (by1 !== by0 && blocked(bx, by1, bz)) return true;
      }
    }
  }
  return false;
}

// 1回分の運転。thr：+1 前進・-1 後進・0 なし、rud：+1 右・-1 左・0 まっすぐ
// 船の前は (-sin yaw, -cos yaw)。右に切る＝向きの角度（yaw）が減る
function stepShip(s, dt, thr, rud, blocked) {
  const C = CLASSES[s.cls] || CLASSES[0];
  const a = thr > 0 ? C.thrust : (thr < 0 ? -C.thrust * 0.5 : 0);
  s.v += (a - C.drag * s.v) * dt;
  if (thr === 0) s.v -= s.v * 0.3 * dt;
  s.v = Math.max(-C.maxV * 0.4, Math.min(C.maxV, s.v));

  // 舵：速いほどよく切れる（止まっていると切れない）
  const k = Math.min(1, Math.abs(s.v) / (C.maxV * 0.5));
  const turn = rud * C.turn * k * (s.v >= 0 ? 1 : -1);
  const nyaw = s.yaw - turn * dt;
  if (!footprintHits(s.perim, s.px, s.py, s.pz, nyaw, blocked)) s.yaw = nyaw;
  s.turnRate = turn;

  // 進む：ぶつかったら壁沿いに滑る。どちらにも進めなければ止まって跳ね返る
  const d = s.v * dt;
  const fx = -Math.sin(s.yaw) * d, fz = -Math.cos(s.yaw) * d;
  let bumped = false;
  if (Math.abs(d) > 0) {
    if (!footprintHits(s.perim, s.px + fx, s.py, s.pz + fz, s.yaw, blocked)) { s.px += fx; s.pz += fz; }
    else if (!footprintHits(s.perim, s.px + fx, s.py, s.pz, s.yaw, blocked)) { s.px += fx; s.v *= 0.9; }
    else if (!footprintHits(s.perim, s.px, s.py, s.pz + fz, s.yaw, blocked)) { s.pz += fz; s.v *= 0.9; }
    else { s.v *= -0.2; bumped = true; }
  }
  return { bumped };
}

// 時間を、小さな段階に分けて運転する（1段階で進む距離を MAX_STEP 以下にして、壁をすり抜けないようにする）
function advanceShip(s, dt, thr, rud, blocked) {
  const n = Math.min(40, Math.max(1, Math.ceil((Math.abs(s.v) * dt) / MAX_STEP)));
  let bumped = false;
  for (let i = 0; i < n; i++) {
    if (stepShip(s, dt / n, thr, rud, blocked).bumped) bumped = true;
  }
  return { bumped, substeps: n };
}

// すでに何かに重なっているときは、近くの重ならない場所へ動かす（見つからなければ、そのまま）
function resolveOverlap(s, blocked) {
  if (!footprintHits(s.perim, s.px, s.py, s.pz, s.yaw, blocked)) return false;
  for (let r = 0.25; r <= 1.5; r += 0.25) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const nx = s.px + Math.cos(a) * r, nz = s.pz + Math.sin(a) * r;
      if (!footprintHits(s.perim, nx, s.py, nz, s.yaw, blocked)) { s.px = nx; s.pz = nz; return true; }
    }
  }
  return false;
}

// 座席・操縦席の、世界での位置（立つ足元の位置）
function seatWorld(s, seat) {
  const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
  const lx = seat.x + 0.5, lz = seat.z + 0.5;
  return { x: s.px + c * lx + sn * lz, y: s.py + seat.y + 1, z: s.pz - sn * lx + c * lz };
}

// ============================================================
// 状態
// ============================================================
const ships = [];          // 画面の船（形を読めたもの）
let metas = [];            // 保存の一覧（読めないものも残す）
let metaBroken = false;    // 保存の文字が壊れているときは、上書きしない
let pendingCount = 0, retryN = 0;
let helm = null;           // 操縦中：{ ship, seat, savedPos, savedView, savedPitch }
let seated = null;         // 座席に座っている：{ ship, seat, savedView, savedPitch }
const shipCtl = { thr: 0, rud: 0 };
let ui = null;             // 船の一覧の画面
let helmUI = null;         // 操縦・降りるのボタン
let board_ = null;         // 「乗る」ボタン
let bar = null;            // ホットバーの上の帯
let pendingSeats = [];     // 選んでいる範囲の座席（まだ船になっていない）
let pendingKey = '';       // どの範囲の座席か
let tapMode = 'seat';      // タップの種類：'seat'（座席）／'helm'（操縦席）

const waterFloat = draft => SEA + 1 - draft;   // 海面（SEA の上）から draft マス下に底を置く
const shapeKey = rec => (rec.shape && rec.shape.__blob) || (SHAPE_PREFIX + rec.id);

function readMeta() {
  try {
    const v = JSON.parse(localStorage.getItem(META_KEY) || '[]');
    return Array.isArray(v) ? v : null;
  } catch (e) { return null; }
}
function writeMeta() {
  if (metaBroken) return false;
  try { localStorage.setItem(META_KEY, JSON.stringify(metas)); return true; }
  catch (e) { return false; }
}
function say(t) { if (!t) return; if (typeof toast === 'function') toast(t); else console.log(t); }
function setMsg(t) { if (ui) ui.msg.textContent = t || ''; say(t); }

function loadTex(url) {
  return new Promise(res => {
    new THREE.TextureLoader().load(url, t => {
      t.magFilter = THREE.NearestFilter; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
      res(t);
    }, undefined, () => res(null));
  });
}

function blockedFor(ign) {
  return (x, y, z) => {
    if (ign && x >= ign.min[0] && x <= ign.max[0] && y >= ign.min[1] && y <= ign.max[1] && z >= ign.min[2] && z <= ign.max[2]) return false;
    const t = getBlock(x, y, z);
    return typeof isSolid === 'function' ? isSolid(t) : (t !== 0 && t !== WATER);
  };
}

function updateRoot(s) {
  const bob = Math.sin(s.t * 1.3 + s.px * 0.05) * 0.08;
  const wave = Math.sin(s.t * 1.1 + s.pz * 0.07) * 0.025;
  s.root.position.set(s.px, s.py + bob, s.pz);
  s.root.rotation.set(wave * 0.6, s.yaw, -s.roll + wave, 'YXZ');
}

async function loadShape(rec) {
  const raw = await VX.blobGet(shapeKey(rec));
  if (typeof raw !== 'string') return null;
  return JSON.parse(raw);
}

async function buildShip(rec) {
  const shape = await loadShape(rec);
  if (!shape) return null;
  const texMap = {};
  for (const tk of Object.keys(shape.data.texs || {})) texMap[tk] = await loadTex(shape.data.texs[tk]);
  const root = VC.buildRoot(shape.data, texMap);
  const cellList = shape.cells.map(c => ({ x: c[0], y: c[1], z: c[2] }));
  let maxTop = 0;
  for (const c of cellList) maxTop = Math.max(maxTop, c.y + 1);
  const s = {
    rec, root, perim: buildCols(cellList), maxTop, cls: rec.cls, draft: rec.draft,
    seats: rec.seats || [],
    px: rec.px, pz: rec.pz, yaw: rec.yaw || 0, py: waterFloat(rec.draft),
    v: 0, turnRate: 0, roll: 0, t: 0, target: null, sendT: 0
  };
  scene.add(root);
  updateRoot(s);
  return s;
}

async function loadAll() {
  pendingCount = 0;
  for (const rec of metas) {
    if (ships.some(s => s.rec === rec)) continue;
    let s = null;
    try { s = await buildShip(rec); } catch (e) { console.error(e); }
    if (s) ships.push(s); else pendingCount++;
  }
  if (pendingCount && retryN++ < RETRY_MAX) setTimeout(loadAll, RETRY_MS);
  else if (pendingCount) say('読み込めない船が' + pendingCount + '隻あります（形のデータが届いていません）。データは残っています');
  else retryN = 0;
}

// 部屋の仲間が船を作った・消した・設定を変えたとき
function reloadShips() {
  const list = readMeta();
  if (list === null) return;
  const byId = new Map(list.map(r => [r.id, r]));
  for (const s of ships.slice()) {
    if (!byId.has(s.rec.id)) {
      if (helm && helm.ship === s) dismount();
      if (seated && seated.ship === s) dismount();
      scene.remove(s.root);
      ships.splice(ships.indexOf(s), 1);
    }
  }
  metas = list;
  for (const s of ships) {
    const r = byId.get(s.rec.id);
    s.rec = r;
    s.seats = r.seats || [];
    const moving = (helm && helm.ship === s) || (seated && seated.ship === s);
    if (!moving && s.cls !== r.cls) s.cls = r.cls;
    if (!moving && s.draft !== r.draft) { s.draft = r.draft; s.py = waterFloat(r.draft); }
    if (!moving && !(s.target && Date.now() - s.target.t < 3000)) { s.px = r.px; s.pz = r.pz; s.yaw = r.yaw || 0; updateRoot(s); }
  }
  loadAll();
}
if (!window.VoxelSync) window.VoxelSync = {};
VoxelSync.ship = { reload: reloadShips };

// ============================================================
// 乗る・降りる・運転
// ============================================================
// 今いちばん近くて乗れる場所（座席、または座席の無い船の操縦席）
function nearestBoardable() {
  let best = null, bd = Infinity;
  for (const s of ships) {
    if (s.seats.length) {
      for (const seat of s.seats) {
        const w = seatWorld(s, seat);
        const d = Math.hypot(w.x - player.pos.x, w.z - player.pos.z);
        if (d <= SEAT_DIST && Math.abs(w.y - player.pos.y) < 2.5 && d < bd) { bd = d; best = { ship: s, seat }; }
      }
    } else {
      const d = Math.hypot(s.px - player.pos.x, s.pz - player.pos.z);
      if (d <= HULL_BOARD_DIST && d < bd) { bd = d; best = { ship: s, seat: null }; }
    }
  }
  return best;
}

function boardCandidate(c) {
  if (!c) return;
  if (c.seat && c.seat.k === 'seat') sit(c.ship, c.seat);
  else helmOn(c.ship, c.seat);
}

function helmOn(s, seat) {
  if (helm || seated) return;
  helm = { ship: s, seat, savedPos: player.pos.clone(), savedView: viewMode, savedPitch: player.pitch };
  viewMode = 1;
  player.vel.set(0, 0, 0);
  shipCtl.thr = 0; shipCtl.rud = 0;
  showHelmUI('helm');
  say('操縦席に座りました。W・S で進む・下がる、A・D で舵（X キーで降ります）');
}

function sit(s, seat) {
  if (helm || seated) return;
  seated = { ship: s, seat, savedView: viewMode, savedPitch: player.pitch };
  viewMode = 1;
  player.vel.set(0, 0, 0);
  showHelmUI('seat');
  say('座席に座りました（X キーで降ります）');
}

function exitSpot(s) {
  let maxX = 0;
  for (const c of s.perim) maxX = Math.max(maxX, c.x + 1);
  const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
  const sides = [[maxX + 1.5, 0], [-maxX - 1.5, 0], [0, maxX + 1.5], [0, -maxX - 1.5]];
  const y = SEA + 2;
  const blocked = blockedFor(null);
  for (const [lx, lz] of sides) {
    const x = s.px + c * lx + sn * lz, z = s.pz - sn * lx + c * lz;
    if (!blocked(Math.floor(x), Math.floor(y), Math.floor(z))) return new THREE.Vector3(x, y, z);
  }
  return new THREE.Vector3(s.px, y, s.pz);
}

function dismount() {
  if (helm) {
    const h = helm, s = h.ship;
    helm = null;
    player.pos.copy(exitSpot(s));
    player.vel.set(0, 0, 0);
    viewMode = h.savedView;
    player.pitch = h.savedPitch;
    s.rec.px = s.px; s.rec.pz = s.pz; s.rec.yaw = s.yaw;
    writeMeta();
  } else if (seated) {
    const h = seated, s = h.ship;
    seated = null;
    player.pos.copy(exitSpot(s));
    player.vel.set(0, 0, 0);
    viewMode = h.savedView;
    player.pitch = h.savedPitch;
  } else return;
  shipCtl.thr = 0; shipCtl.rud = 0;
  showHelmUI('off');
  say('船から降りました');
}

function helmTick(dt) {
  const s = helm.ship;
  const thr = (keys.KeyW || shipCtl.thr > 0) ? 1 : ((keys.KeyS || shipCtl.thr < 0) ? -1 : 0);
  const rud = (keys.KeyD || shipCtl.rud > 0) ? 1 : ((keys.KeyA || shipCtl.rud < 0) ? -1 : 0);
  s.t += dt;
  const blockedNow = blockedFor(null);
  if (resolveOverlap(s, blockedNow)) say('船が障害物に重なっていたので、少し動かしました');
  advanceShip(s, dt, thr, rud, blockedNow);
  s.roll += (-s.turnRate * 0.25 - s.roll) * Math.min(1, dt * 2);
  updateRoot(s);
  player.yaw = s.yaw;
  if (helm.seat) { const w = seatWorld(s, helm.seat); player.pos.set(w.x, w.y, w.z); }
  else player.pos.set(s.px, s.py + s.maxTop + 0.2, s.pz);
  player.vel.set(0, 0, 0);
  s.sendT += dt;
  if (s.sendT >= MOVE_SEND_MS / 1000 && window.VoxelLive && VoxelLive.connected && VoxelLive.connected()) {
    s.sendT = 0;
    VoxelLive.send('shipmv:' + s.rec.id, { px: s.px, pz: s.pz, yaw: s.yaw, v: s.v }, false, true);
  }
  if (helmUI && helmUI.hud) {
    const dir = s.v > 0.3 ? '前進' : (s.v < -0.3 ? '後進' : '停止');
    helmUI.hud.textContent = s.rec.name + '　' + CLASSES[s.cls].name + '　速さ ' + Math.abs(s.v).toFixed(1) + '（' + dir + '）';
  }
}

function seatTick(dt) {
  const s = seated.ship;
  s.t += dt;
  updateRoot(s);
  const w = seatWorld(s, seated.seat);
  player.pos.set(w.x, w.y, w.z);
  player.vel.set(0, 0, 0);
}

// 仲間の船の動きを受け取る（乗っていない船だけ）
function onRemoteMove(rec) {
  const id = String(rec.key).slice(7);
  const s = ships.find(x => x.rec.id === id);
  if (!s || (helm && helm.ship === s) || (seated && seated.ship === s) || !rec.v) return;
  s.target = { px: rec.v.px, pz: rec.v.pz, yaw: rec.v.yaw, t: Date.now() };
}
function registerMoveHandler() {
  if (window.VoxelLive && VoxelLive.onOp) VoxelLive.onOp('shipmv', onRemoteMove);
  else setTimeout(registerMoveHandler, 500);
}
registerMoveHandler();
setInterval(() => {
  for (const s of ships) {
    if (!s.target || (helm && helm.ship === s) || (seated && seated.ship === s)) continue;
    s.px += (s.target.px - s.px) * 0.3;
    s.pz += (s.target.pz - s.pz) * 0.3;
    s.yaw += (s.target.yaw - s.yaw) * 0.3;
    updateRoot(s);
  }
}, 50);

const origUpdatePhysics = window.updatePhysics;
if (typeof origUpdatePhysics === 'function') {
  window.updatePhysics = function (dt, inp) {
    if (helm) { helmTick(dt); return; }
    if (seated) { seatTick(dt); return; }
    return origUpdatePhysics.apply(this, arguments);
  };
}

window.addEventListener('keydown', e => {
  if (e.code !== 'KeyX' || e.repeat) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  if (typeof menuOpen !== 'undefined' && menuOpen) return;
  if (helm || seated) { dismount(); return; }
  boardCandidate(nearestBoardable());
});

function hold(el, down, up) {
  const end = e => { e.preventDefault(); up(); };
  el.addEventListener('pointerdown', e => { e.preventDefault(); down(); });
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', end);
}

// 操縦・降りるのボタン（最初から作っておく。乗るまで表示されないだけ）
function buildHelmUI() {
  const st = document.createElement('style');
  st.textContent = `
  #shipHelm{position:fixed;left:0;right:0;bottom:6px;z-index:9;display:none;justify-content:space-between;align-items:flex-end;padding:0 10px;pointer-events:none;touch-action:none}
  #shipHelm .grp{display:flex;gap:10px;align-items:flex-end;pointer-events:auto}
  #shipHelm .big{width:84px;height:84px;border-radius:50%;background:rgba(0,0,0,.5);color:#fff;border:2px solid rgba(255,255,255,.5);font-size:14px;touch-action:none;user-select:none}
  #shipHelm .big.end{width:72px;height:72px;font-size:12px;background:rgba(120,30,30,.7)}
  #shipHelm .hud{position:fixed;left:50%;top:10px;transform:translateX(-50%);background:rgba(0,0,0,.55);color:#fff;padding:5px 12px;border-radius:8px;font-size:13px;white-space:nowrap;pointer-events:none}
  #shipBoard{position:fixed;right:14px;bottom:120px;z-index:9;display:none;padding:12px 18px;border-radius:10px;border:0;background:#2e6a9a;color:#fff;font-size:16px;touch-action:manipulation}`;
  document.head.appendChild(st);
  const root = document.createElement('div');
  root.id = 'shipHelm';
  root.innerHTML = `
    <div class="grp" data-part="drive">
      <button class="big" data-k="rl">◀ 左</button>
      <button class="big" data-k="rr">右 ▶</button>
    </div>
    <div class="grp" data-part="drive2">
      <button class="big" data-k="tb">▼ 後退</button>
      <button class="big" data-k="tf">▲ 前進</button>
    </div>
    <div class="grp" data-part="exit">
      <button class="big end" data-k="exit">降りる<br>(X)</button>
    </div>
    <div class="hud" id="shipHud"></div>`;
  document.body.appendChild(root);
  const q = k => root.querySelector('[data-k="' + k + '"]');
  hold(q('tf'), () => { shipCtl.thr = 1; }, () => { shipCtl.thr = 0; });
  hold(q('tb'), () => { shipCtl.thr = -1; }, () => { shipCtl.thr = 0; });
  hold(q('rl'), () => { shipCtl.rud = -1; }, () => { shipCtl.rud = 0; });
  hold(q('rr'), () => { shipCtl.rud = 1; }, () => { shipCtl.rud = 0; });
  q('exit').addEventListener('click', () => dismount());
  helmUI = { root, hud: root.querySelector('#shipHud'), parts: { drive: root.querySelectorAll('[data-part="drive"],[data-part="drive2"]') } };

  const btn = document.createElement('button');
  btn.id = 'shipBoard';
  btn.style.display = 'none';
  document.body.appendChild(btn);
  btn.addEventListener('click', () => boardCandidate(nearestBoardable()));
  board_ = btn;
  setInterval(() => {
    const c = (!helm && !seated) ? nearestBoardable() : null;
    btn.style.display = c ? 'block' : 'none';
    if (c) btn.textContent = (c.seat && c.seat.k === 'seat') ? '座席に座る' : (c.seat ? '操縦席に乗る' : '船に乗る');
  }, 250);
}
function showHelmUI(mode) {
  if (!helmUI) return;
  const r = helmUI.root;
  r.style.display = mode === 'off' ? 'none' : 'flex';
  const driving = mode === 'helm';
  helmUI.parts.drive.forEach(el => { el.style.display = driving ? 'flex' : 'none'; });
  if (mode === 'off') helmUI.hud.textContent = '';
}

// ============================================================
// ホットバーの上の帯（船メーカーを持っているときだけ）
// ============================================================
function ensureBar() {
  if (bar) return;
  bar = document.createElement('div');
  bar.id = 'shipBar';
  bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);z-index:45;display:none;gap:6px;align-items:center;background:rgba(20,30,45,.94);color:#fff;padding:6px 10px;border-radius:10px;font-size:13px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.4)';
  bar.innerHTML = '<span>⛵</span>'
    + '<button data-b="make" style="padding:6px 10px;border:0;border-radius:6px;background:#2e7d4f;color:#fff">範囲を船にする</button>'
    + '<button data-b="mode" style="padding:6px 10px;border:0;border-radius:6px;background:#6a4a2e;color:#fff"></button>'
    + '<button data-b="clear" style="padding:6px 10px;border:0;border-radius:6px;background:#555;color:#fff">座席クリア</button>'
    + '<button data-b="list" style="padding:6px 10px;border:0;border-radius:6px;background:#2e6a9a;color:#fff">船の一覧</button>';
  document.body.appendChild(bar);
  bar.addEventListener('click', e => {
    const b = e.target.closest('[data-b]');
    if (!b) return;
    const a = b.dataset.b;
    if (a === 'make') { ensurePanel(); makeFromSelection(); }
    else if (a === 'mode') { tapMode = tapMode === 'seat' ? 'helm' : 'seat'; updateBar(true); say(tapMode === 'seat' ? 'タップで座席を追加します' : 'タップで操縦席を追加します'); }
    else if (a === 'clear') { pendingSeats = []; pendingKey = ''; say('座席をクリアしました'); }
    else if (a === 'list') openPanel();
  });
}
function updateBar(force) {
  ensureBar();
  const held = !helm && !seated && typeof HOTBAR !== 'undefined' && typeof selIdx !== 'undefined' && HOTBAR[selIdx] === T_SHIP;
  bar.style.display = held ? 'flex' : 'none';
  if (held) {
    const hb = document.getElementById('hotbar');
    const top = hb ? hb.getBoundingClientRect().top : window.innerHeight - 80;
    bar.style.top = Math.max(0, top - 50) + 'px';
    const m = bar.querySelector('[data-b="mode"]');
    m.textContent = 'タップ：' + (tapMode === 'seat' ? '座席' : '操縦席');
    const n = pendingSeats.length;
    bar.querySelector('[data-b="clear"]').textContent = '座席クリア' + (n ? '（' + n + '）' : '');
  }
}
setInterval(() => updateBar(false), 200);

// 範囲内のブロックをタップ → 座席（操縦席）を追加／外す
function seatTap() {
  const r = VX.wandRange ? VX.wandRange() : null;
  if (!r) { say('ステッキで範囲を選んでから、範囲内のブロックをタップすると座席になります'); return; }
  const h = raycastBlock(7);
  if (!h) { say('範囲内のブロックをタップしてください'); return; }
  const inside = h.x >= r.min[0] && h.x <= r.max[0] && h.y >= r.min[1] && h.y <= r.max[1] && h.z >= r.min[2] && h.z <= r.max[2];
  if (!inside) { say('選んだ範囲の中のブロックをタップしてください'); return; }
  const key = r.min.join(',') + '|' + r.max.join(',');
  if (pendingKey !== key) { pendingSeats = []; pendingKey = key; }
  const idx = pendingSeats.findIndex(p => p.x === h.x && p.y === h.y && p.z === h.z);
  if (idx >= 0) { pendingSeats.splice(idx, 1); say('座席を外しました'); }
  else { pendingSeats.push({ x: h.x, y: h.y, z: h.z, k: tapMode }); say((tapMode === 'seat' ? '座席' : '操縦席') + 'を追加しました（' + pendingSeats.length + '）'); }
  updateBar(true);
}

// ============================================================
// 船の一覧の画面
// ============================================================
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function openPanel() { ensurePanel(); ui.panel.style.display = ''; renderPanel(); }

function ensurePanel() {
  if (ui) return;
  const p = document.createElement('div');
  p.id = 'shipPanel';
  p.style.cssText = 'position:fixed;left:50%;top:4%;transform:translateX(-50%);z-index:80;width:min(460px,94vw);max-height:90vh;overflow:auto;background:#fff;color:#222;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);padding:12px;font-size:14px;display:none;box-sizing:border-box';
  p.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <b style="font-size:16px">船メーカー</b>
      <button data-s="close" style="padding:4px 10px">閉じる</button>
    </div>
    <p style="margin:4px 0;font-size:13px">ステッキで範囲を選び、範囲内のブロックをタップすると座席・操縦席になります（帯の「タップ」で切り替え）。海の上で作ってください。当たり判定は1.0マスのブロックだけです。</p>
    <div style="border:1px solid #ddd;border-radius:8px;padding:8px;margin:8px 0">
      <b>新しい船</b>
      <div style="margin:6px 0">名前 <input id="shNew" value="自作の船" style="width:180px;padding:4px"></div>
      <div style="margin:6px 0">重さ（動きの軽さ）
        <select id="shNewCls" style="padding:4px">${CLASSES.map((c, i) => `<option value="${i}" ${i === 1 ? 'selected' : ''}>${c.name}</option>`).join('')}</select></div>
      <div style="margin:6px 0">沈む深さ（下から何マス海に沈むか）
        <input id="shNewDraft" type="number" min="0" max="10" step="1" value="1" style="width:70px;padding:4px"></div>
      <button data-s="make" style="padding:8px 14px;background:#2e7d4f;color:#fff;border:0;border-radius:8px">選んだ範囲を船にする</button>
    </div>
    <div style="border:1px solid #ddd;border-radius:8px;padding:8px;margin:8px 0">
      <b>今ある船</b>
      <div id="shList" style="margin-top:6px"></div>
    </div>
    <div id="shMsg" style="font-size:13px;color:#a33"></div>`;
  document.body.appendChild(p);
  ui = { panel: p, msg: p.querySelector('#shMsg'), list: p.querySelector('#shList') };
  p.addEventListener('click', e => {
    const b = e.target.closest('[data-s]');
    if (!b) return;
    const a = b.dataset.s;
    if (a === 'close') p.style.display = 'none';
    if (a === 'make') makeFromSelection();
    if (a === 'save') saveEdit(b.dataset.id);
    if (a === 'restore') restoreBlocks(b.dataset.id);
    if (a === 'seatsclear') clearSeats(b.dataset.id);
    if (a === 'del') deleteShip(b.dataset.id);
  });
}

function renderPanel() {
  if (!ui) return;
  if (!metas.length) { ui.list.innerHTML = '<div style="color:#666">まだ船がありません</div>'; return; }
  ui.list.innerHTML = metas.map(rec => {
    const on = ships.some(s => s.rec === rec);
    const seats = rec.seats || [];
    const nSeat = seats.filter(x => x.k === 'seat').length, nHelm = seats.filter(x => x.k === 'helm').length;
    return `<div style="border-bottom:1px solid #eee;padding:6px 0">
      <div><b>${esc(rec.name)}</b>${on ? '' : '<span style="color:#a33">（形のデータを読み込み中）</span>'}
        <span style="color:#666;font-size:12px">座席 ${nSeat}・操縦席 ${nHelm}</span></div>
      <div style="margin:4px 0">重さ <select data-f="cls" style="padding:2px">${CLASSES.map((c, i) => `<option value="${i}" ${i === rec.cls ? 'selected' : ''}>${c.name}</option>`).join('')}</select>
        沈む深さ <input data-f="draft" type="number" min="0" max="10" step="1" value="${rec.draft}" style="width:60px;padding:2px"></div>
      <button data-s="save" data-id="${esc(rec.id)}" style="padding:2px 8px">設定を保存</button>
      <button data-s="seatsclear" data-id="${esc(rec.id)}" style="padding:2px 8px">座席を全部消す</button>
      <button data-s="restore" data-id="${esc(rec.id)}" style="padding:2px 8px">ブロックに戻す</button>
      <button data-s="del" data-id="${esc(rec.id)}" style="padding:2px 8px;color:#a33">削除</button>
    </div>`;
  }).join('');
}

function readDraft(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : 1;
}

// 範囲のブロックを船にする。元のブロック（傾きも）は、戻せるように船の形のデータに残す
async function makeFromSelection() {
  const r = VX.wandRange ? VX.wandRange() : null;
  if (!r) { setMsg('ステッキで範囲を選んでから押してください'); return; }
  const name = (document.getElementById('shNew').value || '').trim() || '自作の船';
  const cls = Number(document.getElementById('shNewCls').value) || 0;
  const draft = readDraft(document.getElementById('shNewDraft').value);

  // 1. 範囲の中身と、底の高さ
  const cells = [];
  let base = Infinity;
  for (let x = r.min[0]; x <= r.max[0]; x++) for (let y = r.min[1]; y <= r.max[1]; y++) for (let z = r.min[2]; z <= r.max[2]; z++) {
    const id = getBlock(x, y, z);
    if (id === AIR || id === WATER) continue;
    cells.push({ x, y, z, id });
    base = Math.min(base, y);
  }
  const inRange = e => e.obj && !e.hideDraft && e.c && [0, 1, 2].every(i => e.c[i] >= r.min[i] && e.c[i] < r.max[i] + 1);
  const tilts = VX.tiltList.filter(inRange);
  for (const e of tilts) base = Math.min(base, e.isModel ? e.c[1] : e.c[1] - 0.5 * (e.s || 1));
  if (!isFinite(base)) { setMsg('範囲にブロックがありません'); return; }

  // 2. 見た目のデータ（船の原点は、底の中心）
  const B = VC.newBuckets(), seen = new Set(), out = { count: 0, skipped: 0 };
  VC.gather(r.min, r.max, 'ship', B, seen, out);
  if (!out.count) { setMsg('範囲にブロックがありません'); return; }
  const cx = (r.min[0] + r.max[0] + 1) / 2, cz = (r.min[2] + r.max[2] + 1) / 2;
  const r3 = v => Math.round(v * 1000) / 1000, r4 = v => Math.round(v * 10000) / 10000;
  const all = [...B.map.values()];
  for (const b of all) for (let i = 0; i < b.P.length; i += 3) { b.P[i] -= cx; b.P[i + 1] -= base; b.P[i + 2] -= cz; }
  const usedTex = new Set();
  const mats = all.map(b => {
    if (b.mat.tk) usedTex.add(b.mat.tk);
    return { f: b.mat.f, col: b.mat.col, tk: b.mat.tk, P: b.P.map(r3), N: b.N.map(r3), U: b.U.map(r4) };
  });
  const texs = {};
  for (const tk of usedTex) texs[tk] = B.tex.get(tk);
  const data = { v: 2, texs, parts: [{ name: '船体', mats }] };
  const localCells = cells.map(c => [c.x - cx, c.y - base, c.z - cz]);
  const savedCells = cells.map(c => {
    const st = VX.blockState.get(VX.keyOf(c.x, c.y, c.z)) || null;
    return [c.x - cx, c.y - base, c.z - cz, c.id, st];
  });
  const savedTilts = tilts.map(e => [
    e.c[0] - cx, e.c[1] - base, e.c[2] - cz,
    e.q.x, e.q.y, e.q.z, e.q.w, e.id, e.st || null, e.s || 1, !!e.isModel
  ]);
  // 座席（選んだ範囲のブロックの上）
  const key = r.min.join(',') + '|' + r.max.join(',');
  const seats = pendingKey === key
    ? pendingSeats.filter(p => p.x >= r.min[0] && p.x <= r.max[0] && p.y >= r.min[1] && p.y <= r.max[1] && p.z >= r.min[2] && p.z <= r.max[2])
        .map(p => ({ x: p.x - cx, y: p.y - base, z: p.z - cz, k: p.k === 'helm' ? 'helm' : 'seat' }))
    : [];

  // 3. 海に浮かべられるか（選んだ範囲のブロックは、ぶつかる物に数えない）
  const perim = buildCols(localCells.map(c => ({ x: c[0], y: c[1], z: c[2] })));
  const py = waterFloat(draft);
  if (footprintHits(perim, cx, py, cz, 0, blockedFor(r))) { setMsg('海の上で作ってください（陸や建物に重なっています）'); return; }

  // 4. 先に保存する（保存できなければ、ブロックは消さない）
  const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const rec = { id, name, cls, draft, px: cx, pz: cz, yaw: 0, seats, shape: { __blob: SHAPE_PREFIX + id } };
  const payload = JSON.stringify({ data, cells: localCells, savedCells, savedTilts });
  try { await VX.blobPut(SHAPE_PREFIX + id, payload); }
  catch (e) { setMsg('保存できませんでした（容量がいっぱいの可能性があります）'); return; }
  metas.push(rec);
  if (!writeMeta()) { metas.pop(); setMsg('保存できませんでした（容量を確認してください）'); return; }

  // 5. 元のブロックを消す（傾き・0.5マスも含む）
  for (const e of tilts.slice()) { if (window.VoxelDiag && VoxelDiag.dropTilt) VoxelDiag.dropTilt(e); }
  for (const c of cells) { setBlock(c.x, c.y, c.z, AIR); VX.blockState.delete(VX.keyOf(c.x, c.y, c.z)); }
  pendingSeats = []; pendingKey = '';

  // 6. 画面に出す
  try { const s = await buildShip(rec); if (s) ships.push(s); } catch (e) { console.error(e); }
  setMsg('');
  renderPanel();
  say('船「' + name + '」を作りました。座席に近づいて乗れます');
}

function clearSeats(id) {
  const rec = metas.find(m => m.id === id);
  if (!rec) return;
  rec.seats = [];
  const s = ships.find(x => x.rec === rec);
  if (s) s.seats = [];
  if (!writeMeta()) { setMsg('保存できませんでした'); return; }
  renderPanel();
  say('座席を全部消しました（船に乗るときは、船の近くで乗れます）');
}

// 船を消して、元のブロックを船のいる場所に戻す（向きは90°単位、重なる所があれば何も変えない）
async function restoreBlocks(id) {
  const rec = metas.find(m => m.id === id);
  if (!rec) return;
  if (!window.confirm('船「' + rec.name + '」を消して、元のブロックに戻します。よろしいですか？')) return;
  const s = ships.find(x => x.rec === rec);
  if ((helm && helm.ship === s) || (seated && seated.ship === s)) dismount();
  let shape;
  try { shape = await loadShape(rec); } catch (e) { shape = null; }
  if (!shape || !shape.savedCells) { setMsg('形のデータが届いていないため、戻せません'); return; }
  const px = s ? s.px : rec.px, pz = s ? s.pz : rec.pz, py = s ? s.py : waterFloat(rec.draft);
  const yaw = s ? s.yaw : (rec.yaw || 0);
  const ang = Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2);
  const c = Math.round(Math.cos(ang)), sn = Math.round(Math.sin(ang));
  const toWorld = (lx, ly, lz) => ({ x: px + c * lx + sn * lz, y: py + ly, z: pz - sn * lx + c * lz });

  const plan = shape.savedCells.map(([lx, ly, lz, id2, st]) => {
    const w = toWorld(lx + 0.5, ly + 0.5, lz + 0.5);
    return { bx: Math.floor(w.x + 1e-6), by: Math.floor(w.y + 1e-6), bz: Math.floor(w.z + 1e-6), id2, st };
  });
  const bad = plan.filter(p => { const t = getBlock(p.bx, p.by, p.bz); return t !== AIR && t !== WATER; });
  if (bad.length) { setMsg('ここに置けないブロックが' + bad.length + '個あります。船を海の別の場所に動かしてから戻してください'); return; }

  for (const p of plan) {
    setBlock(p.bx, p.by, p.bz, p.id2);
    if (p.st) VX.blockState.set(VX.keyOf(p.bx, p.by, p.bz), p.st);
  }
  let tiltN = 0;
  const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ang);
  for (const t of shape.savedTilts || []) {
    const [c0, c1, c2, qx, qy, qz, qw, id2, st, sc] = t;
    const w = toWorld(c0, c1, c2);
    const q = qYaw.clone().multiply(new THREE.Quaternion(qx, qy, qz, qw));
    if (!VX.addTilt(id2, [w.x, w.y, w.z], q, st)) continue;
    const ent = VX.tiltList[VX.tiltList.length - 1];
    if (window.VoxelDiag && VoxelDiag.tilt) VoxelDiag.tilt.place(ent, ent.c, ent.q, sc);
    if (window.VoxelDiag && VoxelDiag.adoptTilt) VoxelDiag.adoptTilt(ent);
    tiltN++;
  }

  if (s) { scene.remove(s.root); ships.splice(ships.indexOf(s), 1); }
  metas = metas.filter(m => m.id !== id);
  writeMeta();
  VX.blobDel(shapeKey(rec)).catch(() => {});
  renderPanel();
  setMsg('');
  say('元のブロックに戻しました（ブロック ' + plan.length + '個・傾き ' + tiltN + '個）');
}

async function saveEdit(id) {
  const rec = metas.find(m => m.id === id);
  if (!rec) return;
  const row = [...ui.list.querySelectorAll('[data-s="save"]')].find(b => b.dataset.id === id);
  const box = row ? row.parentElement : null;
  if (!box) return;
  const cls = Number(box.querySelector('[data-f="cls"]').value) || 0;
  const draft = readDraft(box.querySelector('[data-f="draft"]').value);
  const s = ships.find(x => x.rec === rec);
  if (s) {
    const py = waterFloat(draft);
    if (!(helm && helm.ship === s) && footprintHits(s.perim, s.px, py, s.pz, s.yaw, blockedFor(null))) {
      setMsg('この深さだと陸に重なるため、変えられません'); return;
    }
    s.cls = cls; s.draft = draft; s.py = py;
  }
  rec.cls = cls; rec.draft = draft;
  if (!writeMeta()) { setMsg('保存できませんでした'); return; }
  setMsg('');
  say('船の設定を保存しました');
  renderPanel();
}

async function deleteShip(id) {
  const rec = metas.find(m => m.id === id);
  if (!rec) return;
  if (!window.confirm('船「' + rec.name + '」を消します。船の中のブロックは元に戻りません（「ブロックに戻す」なら戻せます）。よろしいですか？')) return;
  const s = ships.find(x => x.rec === rec);
  if ((helm && helm.ship === s) || (seated && seated.ship === s)) dismount();
  const next = metas.filter(m => m.id !== id);
  metas = next;
  if (!writeMeta()) { metas = [...next, rec]; setMsg('保存できませんでした（消していません）'); return; }
  if (s) { scene.remove(s.root); ships.splice(ships.indexOf(s), 1); }
  VX.blobDel(shapeKey(rec)).catch(() => {});
  renderPanel();
  say('船を消しました');
}

// 画面を閉じる・再読み込み前に、乗っている船の場所を覚える
window.addEventListener('pagehide', () => {
  const s = (helm || seated) ? (helm ? helm.ship : seated.ship) : null;
  if (s) { s.rec.px = s.px; s.rec.pz = s.pz; s.rec.yaw = s.yaw; }
  if (s || ships.length) writeMeta();
});

// ============================================================
// 起動
// ============================================================
buildHelmUI();
const metaNow = readMeta();
metas = metaNow || [];
metaBroken = metaNow === null;
loadAll();

window.VoxelShip = {
  tap: seatTap,                  // 道具を持ってタップしたとき：範囲内なら座席を追加
  openPanel,
  board: () => boardCandidate(nearestBoardable()),
  count: () => ships.length,
  _pure: { CLASSES, buildCols, footprintHits, stepShip, advanceShip, seatWorld, resolveOverlap }
};
})();
