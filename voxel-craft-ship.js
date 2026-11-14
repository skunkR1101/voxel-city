/* voxel-craft-ship.js (v2)  船
 * ・船メーカー（道具）を持つと、ホットバーの上に「選んだ範囲を船にする」「船の一覧」が出ます
 * ・範囲のブロックが船になり、海の上に浮く。乗る：X キー（または「船に乗る」）。運転：W・S・A・D／画面のボタン。降りる：X
 * ・当たり判定：1.0マスの通常ブロック（傾き・0.5マスは当たらない）。陸や建物にぶつかると止まる（壁沿いは滑る）
 * ・「ブロックに戻す」：船を消して、元のブロック（傾きも）を、船のいる場所に戻す（向きは90°単位）
 * ・マルチプレイ：船の情報は部屋の状態（voxelcraft_ship_v1）で共有。船の中身は素材として送る。
 *   船を動かす様子は、乗っている人の動きを数分の一秒ごとに送る（保存はしない）
 * ・保存：船の情報は localStorage（voxelcraft_ship_v1）、形のデータは IndexedDB（shipblk:ID）
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
const BOARD_DIST = 6;
const MOVE_SEND_MS = 100;
const CLASSES = [
  { name: 'ヨット',   maxV: 9,   thrust: 4.0, drag: 0.6, turn: 1.6 },
  { name: '小型船',   maxV: 7,   thrust: 3.0, drag: 0.6, turn: 1.3 },
  { name: 'フェリー', maxV: 5,   thrust: 2.0, drag: 0.5, turn: 0.9 },
  { name: '大型客船', maxV: 3.6, thrust: 1.3, drag: 0.4, turn: 0.6 },
  { name: '大型軍艦', maxV: 5.5, thrust: 1.8, drag: 0.5, turn: 0.7 }
];
// 当たり判定で調べる、柱の中の4点（角から少し内側）
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

// 1フレーム分の運転。thr：+1 前進・-1 後進・0 なし、rud：+1 右・-1 左・0 まっすぐ
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
  if (!footprintHits(s.perim, s.px, s.py, s.pz, nyaw, blocked) || footprintHits(s.perim, s.px, s.py, s.pz, s.yaw, blocked)) {
    s.yaw = nyaw;
  }
  s.turnRate = turn;

  // 進む：ぶつかったら壁沿いに滑る。どちらにも進めなければ止まって跳ね返る
  const d = s.v * dt;
  const fx = -Math.sin(s.yaw) * d, fz = -Math.cos(s.yaw) * d;
  const stuck = footprintHits(s.perim, s.px, s.py, s.pz, s.yaw, blocked);
  let bumped = false;
  if (Math.abs(d) > 0) {
    if (stuck) { s.px += fx; s.pz += fz; }
    else if (!footprintHits(s.perim, s.px + fx, s.py, s.pz + fz, s.yaw, blocked)) { s.px += fx; s.pz += fz; }
    else if (!footprintHits(s.perim, s.px + fx, s.py, s.pz, s.yaw, blocked)) { s.px += fx; s.v *= 0.9; }
    else if (!footprintHits(s.perim, s.px, s.py, s.pz + fz, s.yaw, blocked)) { s.pz += fz; s.v *= 0.9; }
    else { s.v *= -0.2; bumped = true; }
  }
  return { bumped };
}

// ============================================================
// 状態
// ============================================================
const ships = [];          // 画面の船（形を読めたもの）
let metas = [];            // 保存の一覧（読めないものも残す）
let metaBroken = false;    // 保存の文字が壊れているときは、上書きしない
let pendingCount = 0, retryN = 0;
let helm = null;           // 乗っている船：{ ship, savedPos, savedView, savedPitch }
const shipCtl = { thr: 0, rud: 0 };
let ui = null;             // 船メーカーの画面
let helmUI = null;         // 運転のボタン
let bar = null;            // ホットバーの上の帯

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

// 形のデータ（船の中身・元のブロック・傾きブロック）を読む。まだ届いていなければ null
async function loadShape(rec) {
  const raw = await VX.blobGet(shapeKey(rec));
  if (typeof raw !== 'string') return null;
  return JSON.parse(raw);
}

// 保存の1件から、画面の船を作る（形のデータが届いていなければ null）
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

// 部屋の仲間が船を作った・消した・設定を変えたとき（部屋の状態が届いたら呼ばれる）
function reloadShips() {
  const list = readMeta();
  if (list === null) return;
  const byId = new Map(list.map(r => [r.id, r]));
  for (const s of ships.slice()) {
    if (!byId.has(s.rec.id)) {
      if (helm && helm.ship === s) dismount();
      scene.remove(s.root);
      ships.splice(ships.indexOf(s), 1);
    }
  }
  metas = list;
  for (const s of ships) {
    const r = byId.get(s.rec.id);
    s.rec = r;
    const moving = helm && helm.ship === s;
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
function nearestShip(max) {
  let best = null, bd = Infinity;
  for (const s of ships) {
    const d = Math.hypot(s.px - player.pos.x, s.pz - player.pos.z);
    if (d < bd) { bd = d; best = s; }
  }
  return bd <= max ? best : null;
}

function board(s) {
  if (helm) return;
  helm = { ship: s, savedPos: player.pos.clone(), savedView: viewMode, savedPitch: player.pitch };
  viewMode = 1;
  player.vel.set(0, 0, 0);
  shipCtl.thr = 0; shipCtl.rud = 0;
  showHelmUI(true);
  say('乗りました。W・S で進む・下がる、A・D で舵（X キーで降ります）');
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
  if (!helm) return;
  const h = helm, s = h.ship;
  const spot = exitSpot(s);
  helm = null;
  player.pos.copy(spot);
  player.vel.set(0, 0, 0);
  viewMode = h.savedView;
  player.pitch = h.savedPitch;
  s.rec.px = s.px; s.rec.pz = s.pz; s.rec.yaw = s.yaw;
  writeMeta();
  shipCtl.thr = 0; shipCtl.rud = 0;
  showHelmUI(false);
  say('船から降りました');
}

function helmTick(dt) {
  const s = helm.ship;
  const thr = (keys.KeyW || shipCtl.thr > 0) ? 1 : ((keys.KeyS || shipCtl.thr < 0) ? -1 : 0);
  const rud = (keys.KeyD || shipCtl.rud > 0) ? 1 : ((keys.KeyA || shipCtl.rud < 0) ? -1 : 0);
  s.t += dt;
  stepShip(s, dt, thr, rud, blockedFor(null));
  s.roll += (-s.turnRate * 0.25 - s.roll) * Math.min(1, dt * 2);
  updateRoot(s);
  player.yaw = s.yaw;
  player.pos.set(s.px, s.py + s.maxTop + 0.2, s.pz);
  player.vel.set(0, 0, 0);
  // 部屋の仲間に、船の動きを送る（保存はしない）
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

// 仲間の船の動きを受け取る（乗っていない船だけ）
function onRemoteMove(rec) {
  const id = String(rec.key).slice(7);
  const s = ships.find(x => x.rec.id === id);
  if (!s || (helm && helm.ship === s) || !rec.v) return;
  s.target = { px: rec.v.px, pz: rec.v.pz, yaw: rec.v.yaw, t: Date.now() };
}
function registerMoveHandler() {
  if (window.VoxelLive && VoxelLive.onOp) VoxelLive.onOp('shipmv', onRemoteMove);
  else setTimeout(registerMoveHandler, 500);
}
registerMoveHandler();
// 仲間の船を、受け取った位置へなめらかに寄せる
setInterval(() => {
  for (const s of ships) {
    if (!s.target || (helm && helm.ship === s)) continue;
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
    return origUpdatePhysics.apply(this, arguments);
  };
}

window.addEventListener('keydown', e => {
  if (e.code !== 'KeyX' || e.repeat) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  if (typeof menuOpen !== 'undefined' && menuOpen) return;
  if (helm) { dismount(); return; }
  const s = nearestShip(BOARD_DIST);
  if (s) board(s);
});

function hold(el, down, up) {
  const end = e => { e.preventDefault(); up(); };
  el.addEventListener('pointerdown', e => { e.preventDefault(); down(); });
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', end);
}

function showHelmUI(on) {
  if (!helmUI) buildHelmUI();
  helmUI.root.style.display = on ? 'flex' : 'none';
}
function buildHelmUI() {
  const st = document.createElement('style');
  st.textContent = `
  #shipHelm{position:fixed;left:0;right:0;bottom:6px;z-index:9;display:none;justify-content:space-between;align-items:flex-end;padding:0 10px;pointer-events:none;touch-action:none}
  #shipHelm .grp{display:flex;gap:10px;align-items:flex-end;pointer-events:auto}
  #shipHelm .big{width:84px;height:84px;border-radius:50%;background:rgba(0,0,0,.5);color:#fff;border:2px solid rgba(255,255,255,.5);font-size:14px;touch-action:none;user-select:none}
  #shipHelm .big.end{width:72px;height:72px;font-size:12px;background:rgba(120,30,30,.7)}
  #shipHelm .hud{position:fixed;left:50%;top:10px;transform:translateX(-50%);background:rgba(0,0,0,.55);color:#fff;padding:5px 12px;border-radius:8px;font-size:13px;white-space:nowrap;pointer-events:none}
  #shipBoard{position:fixed;right:14px;bottom:120px;z-index:9;display:none;padding:10px 16px;border-radius:10px;border:0;background:#2e6a9a;color:#fff;font-size:15px}`;
  document.head.appendChild(st);
  const root = document.createElement('div');
  root.id = 'shipHelm';
  root.innerHTML = `
    <div class="grp">
      <button class="big" data-k="rl">◀ 左</button>
      <button class="big" data-k="rr">右 ▶</button>
    </div>
    <div class="grp">
      <button class="big" data-k="tb">▼ 後退</button>
      <button class="big" data-k="tf">▲ 前進</button>
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
  const btn = document.createElement('button');
  btn.id = 'shipBoard';
  btn.textContent = '船に乗る';
  document.body.appendChild(btn);
  btn.addEventListener('click', () => { const s = nearestShip(BOARD_DIST); if (s) board(s); });
  helmUI = { root, hud: root.querySelector('#shipHud') };
  setInterval(() => {
    btn.style.display = (!helm && nearestShip(BOARD_DIST)) ? 'block' : 'none';
  }, 300);
}

// ============================================================
// ホットバーの上の帯（船メーカーを持っているときだけ）
// ============================================================
function ensureBar() {
  if (bar) return;
  bar = document.createElement('div');
  bar.id = 'shipBar';
  bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);z-index:45;display:none;gap:8px;align-items:center;background:rgba(20,30,45,.94);color:#fff;padding:6px 10px;border-radius:10px;font-size:13px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.4)';
  bar.innerHTML = '<span>⛵ 船メーカー</span>'
    + '<button data-b="make" style="padding:6px 10px;border:0;border-radius:6px;background:#2e7d4f;color:#fff">選んだ範囲を船にする</button>'
    + '<button data-b="list" style="padding:6px 10px;border:0;border-radius:6px;background:#2e6a9a;color:#fff">船の一覧</button>';
  document.body.appendChild(bar);
  bar.addEventListener('click', e => {
    const b = e.target.closest('[data-b]');
    if (!b) return;
    if (b.dataset.b === 'make') { ensurePanel(); makeFromSelection(); }
    else tap();
  });
}
function updateBar() {
  ensureBar();
  const held = !helm && typeof HOTBAR !== 'undefined' && typeof selIdx !== 'undefined' && HOTBAR[selIdx] === T_SHIP;
  bar.style.display = held ? 'flex' : 'none';
  if (held) {
    const hb = document.getElementById('hotbar');
    const top = hb ? hb.getBoundingClientRect().top : window.innerHeight - 80;
    bar.style.top = Math.max(0, top - 50) + 'px';
  }
}
setInterval(updateBar, 200);

// ============================================================
// 船メーカーの画面
// ============================================================
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function tap() { ensurePanel(); ui.panel.style.display = ''; renderPanel(); }

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
    <p style="margin:4px 0;font-size:13px">ステッキで範囲を選び、「選んだ範囲を船にする」を押します。海の上で作ってください（陸に重なると作れません）。当たり判定は1.0マスのブロックだけです。</p>
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
    if (a === 'del') deleteShip(b.dataset.id);
  });
}

function renderPanel() {
  if (!ui) return;
  if (!metas.length) { ui.list.innerHTML = '<div style="color:#666">まだ船がありません</div>'; return; }
  ui.list.innerHTML = metas.map(rec => {
    const on = ships.some(s => s.rec === rec);
    return `<div style="border-bottom:1px solid #eee;padding:6px 0">
      <div><b>${esc(rec.name)}</b>${on ? '' : '<span style="color:#a33">（形のデータを読み込み中）</span>'}</div>
      <div style="margin:4px 0">重さ <select data-f="cls" style="padding:2px">${CLASSES.map((c, i) => `<option value="${i}" ${i === rec.cls ? 'selected' : ''}>${c.name}</option>`).join('')}</select>
        沈む深さ <input data-f="draft" type="number" min="0" max="10" step="1" value="${rec.draft}" style="width:60px;padding:2px"></div>
      <button data-s="save" data-id="${esc(rec.id)}" style="padding:2px 8px">設定を保存</button>
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
  // 元に戻すための記録：1.0マスのブロック（種類と状態）と、傾きブロック（位置・向き・大きさ）
  const savedCells = cells.map(c => {
    const st = VX.blockState.get(VX.keyOf(c.x, c.y, c.z)) || null;
    return [c.x - cx, c.y - base, c.z - cz, c.id, st];
  });
  const savedTilts = tilts.map(e => [
    e.c[0] - cx, e.c[1] - base, e.c[2] - cz,
    e.q.x, e.q.y, e.q.z, e.q.w, e.id, e.st || null, e.s || 1, !!e.isModel
  ]);

  // 3. 海に浮かべられるか（選んだ範囲のブロックは、ぶつかる物に数えない）
  const perim = buildCols(localCells.map(c => ({ x: c[0], y: c[1], z: c[2] })));
  const py = waterFloat(draft);
  if (footprintHits(perim, cx, py, cz, 0, blockedFor(r))) { setMsg('海の上で作ってください（陸や建物に重なっています）'); return; }

  // 4. 先に保存する（保存できなければ、ブロックは消さない）
  const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const shapeRef = { __blob: SHAPE_PREFIX + id };
  const rec = { id, name, cls, draft, px: cx, pz: cz, yaw: 0, shape: shapeRef };
  const payload = JSON.stringify({ data, cells: localCells, savedCells, savedTilts });
  try { await VX.blobPut(SHAPE_PREFIX + id, payload); }
  catch (e) { setMsg('保存できませんでした（容量がいっぱいの可能性があります）'); return; }
  metas.push(rec);
  if (!writeMeta()) { metas.pop(); setMsg('保存できませんでした（容量を確認してください）'); return; }

  // 5. 元のブロックを消す（傾き・0.5マスも含む）
  for (const e of tilts.slice()) { if (window.VoxelDiag && VoxelDiag.dropTilt) VoxelDiag.dropTilt(e); }
  for (const c of cells) { setBlock(c.x, c.y, c.z, AIR); VX.blockState.delete(VX.keyOf(c.x, c.y, c.z)); }

  // 6. 画面に出す
  try { const s = await buildShip(rec); if (s) ships.push(s); } catch (e) { console.error(e); }
  setMsg('');
  renderPanel();
  say('船「' + name + '」を作りました。乗るには X キー（または「船に乗る」ボタン）');
}

// 船を消して、元のブロックを船のいる場所に戻す（向きは90°単位、重なる所があれば何も変えない）
async function restoreBlocks(id) {
  const rec = metas.find(m => m.id === id);
  if (!rec) return;
  if (!window.confirm('船「' + rec.name + '」を消して、元のブロックに戻します。よろしいですか？')) return;
  const s = ships.find(x => x.rec === rec);
  if (helm && s && helm.ship === s) dismount();
  let shape;
  try { shape = await loadShape(rec); } catch (e) { shape = null; }
  if (!shape || !shape.savedCells) { setMsg('形のデータが届いていないため、戻せません'); return; }
  const px = s ? s.px : rec.px, pz = s ? s.pz : rec.pz, py = s ? s.py : waterFloat(rec.draft);
  const yaw = s ? s.yaw : (rec.yaw || 0);
  const ang = Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2);
  const c = Math.round(Math.cos(ang)), sn = Math.round(Math.sin(ang));
  const toWorld = (lx, ly, lz) => ({ x: px + c * lx + sn * lz, y: py + ly, z: pz - sn * lx + c * lz });

  // 1. 置けるかを先に確かめる（一つでも置けなければ、何も変えない）
  const plan = shape.savedCells.map(([lx, ly, lz, id2, st]) => {
    const w = toWorld(lx + 0.5, ly + 0.5, lz + 0.5);
    const bx = Math.floor(w.x + 1e-6), by = Math.floor(w.y + 1e-6), bz = Math.floor(w.z + 1e-6);
    return { bx, by, bz, id2, st };
  });
  const bad = plan.filter(p => { const t = getBlock(p.bx, p.by, p.bz); return t !== AIR && t !== WATER; });
  if (bad.length) { setMsg('ここに置けないブロックが' + bad.length + '個あります。船を海の別の場所に動かしてから戻してください'); return; }

  // 2. 戻す
  for (const p of plan) {
    setBlock(p.bx, p.by, p.bz, p.id2);
    if (p.st) VX.blockState.set(VX.keyOf(p.bx, p.by, p.bz), p.st);
  }
  let tiltN = 0;
  const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ang);
  for (const t of shape.savedTilts || []) {
    const [c0, c1, c2, qx, qy, qz, qw, id2, st, sc, isModel] = t;
    const w = toWorld(c0, c1, c2);
    const q = qYaw.clone().multiply(new THREE.Quaternion(qx, qy, qz, qw));
    if (!VX.addTilt(id2, [w.x, w.y, w.z], q, st)) continue;
    const ent = VX.tiltList[VX.tiltList.length - 1];
    if (window.VoxelDiag && VoxelDiag.tilt) VoxelDiag.tilt.place(ent, ent.c, ent.q, sc);
    if (window.VoxelDiag && VoxelDiag.adoptTilt) VoxelDiag.adoptTilt(ent);
    tiltN++;
  }

  // 3. 船を消す
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
  if (helm && s && helm.ship === s) dismount();
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
  if (helm) { const s = helm.ship; s.rec.px = s.px; s.rec.pz = s.pz; s.rec.yaw = s.yaw; }
  if (helm || ships.length) writeMeta();
});

// 起動：保存の船を読み込む
const metaNow = readMeta();
metas = metaNow || [];
metaBroken = metaNow === null;
loadAll();

window.VoxelShip = {
  tap,
  board: () => { const s = nearestShip(BOARD_DIST); if (s) board(s); },
  count: () => ships.length,
  _pure: { CLASSES, buildCols, footprintHits, stepShip }
};
})();
