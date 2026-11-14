/* voxel-craft-ship.js (v1)  船（段階2）
 * ・船メーカー（道具）で範囲を選び「船にする」→ 範囲のブロックが船になり、海の上に浮く
 * ・乗る：X キー（または「乗る」ボタン）。運転：W・S（前進・後進）、A・D（舵）／画面のボタン。降りる：X キー（または「降りる」）
 * ・当たり判定：1.0マスの通常ブロック（傾き・0.5マスは当たらない）。陸や建物にぶつかると止まる（壁沿いは滑る）
 * ・沈む深さ（下から何マス海に沈むか）と、重さ（ヨット〜大型軍艦）は、船メーカーで設定
 * ・保存：船の情報は localStorage（voxelcraft_ship_v1）、形のデータは IndexedDB（素材）。消すのは「削除」だけ
 * ・段階2の制限：部屋（マルチ）に入っている間は作れません。船は、この端末の中だけに出ます（部屋での共有は次の段階）
 */
(function () {
'use strict';

const VX = window.VoxelExt, VC = window.VoxelConvert;
if (!VX || !VC || !VC.gather || typeof VX.T_SHIP_MAKER !== 'number') {
  console.error('voxel-craft-ship: 必要な部品が見つかりません');
  return;
}

const META_KEY = 'voxelcraft_ship_v1';
const BLOB_PREFIX = 'shipblk:';
const RETRY_MS = 3000, RETRY_MAX = 10;
const BOARD_DIST = 6;
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
// cells：船の中の1.0マスの位置（x,z は角、y は船の底からの段）。外側の柱だけを返す（当たり判定は外側で十分）
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
// blocked(x,y,z)：そのブロックが当たるかどうか
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
// 船の向き：前は (-sin, -cos)。右に切る＝向きの角度（yaw）が減る
function stepShip(s, dt, thr, rud, blocked) {
  const C = CLASSES[s.cls] || CLASSES[0];
  const a = thr > 0 ? C.thrust : (thr < 0 ? -C.thrust * 0.5 : 0);
  s.v += (a - C.drag * s.v) * dt;
  if (thr === 0) s.v -= s.v * 0.3 * dt;                      // 何も押さないと、だんだん止まる
  s.v = Math.max(-C.maxV * 0.4, Math.min(C.maxV, s.v));

  // 舵：速いほどよく切れる（止まっていると切れない）
  const k = Math.min(1, Math.abs(s.v) / (C.maxV * 0.5));
  const turn = rud * C.turn * k * (s.v >= 0 ? 1 : -1);
  const nyaw = s.yaw - turn * dt;
  if (!footprintHits(s.perim, s.px, s.py, s.pz, nyaw, blocked) || footprintHits(s.perim, s.px, s.py, s.pz, s.yaw, blocked)) {
    s.yaw = nyaw;
  }
  s.turnRate = turn;

  // 進む：ぶつかったら、壁沿いに滑る。どちらにも進めなければ止まって跳ね返る
  const d = s.v * dt;
  const fx = -Math.sin(s.yaw) * d, fz = -Math.cos(s.yaw) * d;
  const stuck = footprintHits(s.perim, s.px, s.py, s.pz, s.yaw, blocked);
  let bumped = false;
  if (Math.abs(d) > 0) {
    if (stuck) { s.px += fx; s.pz += fz; }                  // すでに重なっているときは、抜け出せるように動かす
    else if (!footprintHits(s.perim, s.px + fx, s.py, s.pz + fz, s.yaw, blocked)) { s.px += fx; s.pz += fz; }
    else if (!footprintHits(s.perim, s.px + fx, s.py, s.pz, s.yaw, blocked)) { s.px += fx; s.v *= 0.9; }
    else if (!footprintHits(s.perim, s.px, s.py, s.pz + fz, s.yaw, blocked)) { s.pz += fz; s.v *= 0.9; }
    else { s.v *= -0.2; bumped = true; }
  }
  return { bumped };
}

// ============================================================
// 船の状態と保存
// ============================================================
const ships = [];          // 動かせる船（読み込めたもの）
let metas = [];            // 保存の一覧（読めないものも残す）
let metaBroken = false;    // 保存の文字が壊れているときは、上書きしない
let pendingCount = 0, retryN = 0;
let helm = null;           // 乗っている船：{ ship, savedPos, savedView, savedPitch }
const shipCtl = { thr: 0, rud: 0 };   // 画面のボタン
let ui = null;             // 船メーカーの画面
let helmUI = null;         // 運転のボタン

const waterFloat = draft => SEA + 1 - draft;   // 海面（SEA の上）から draft マス下に底を置く

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
function toastMsg(t) { if (typeof toast === 'function') toast(t); else console.log(t); }
function inRoom() { return !!(window.VoxelLive && VoxelLive.connected && VoxelLive.connected()); }

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

// 保存の1件から、画面の船を作る（形のデータが届いていなければ null）
async function buildShip(rec) {
  const raw = await VX.blobGet(BLOB_PREFIX + rec.id);
  if (typeof raw !== 'string') return null;
  const { data, cells } = JSON.parse(raw);
  const texMap = {};
  for (const tk of Object.keys(data.texs || {})) texMap[tk] = await loadTex(data.texs[tk]);
  const root = VC.buildRoot(data, texMap);
  const cellList = cells.map(c => ({ x: c[0], y: c[1], z: c[2] }));
  let maxTop = 0;
  for (const c of cellList) maxTop = Math.max(maxTop, c.y + 1);
  const s = {
    rec, root, perim: buildCols(cellList), maxTop, cls: rec.cls, draft: rec.draft,
    px: rec.px, pz: rec.pz, yaw: rec.yaw || 0, py: waterFloat(rec.draft),
    v: 0, turnRate: 0, roll: 0, t: 0
  };
  scene.add(root);
  updateRoot(s);
  return s;
}

async function loadAll() {
  if (!metas.length) return;
  pendingCount = 0;
  for (const rec of metas) {
    if (ships.some(s => s.rec === rec)) continue;
    let s = null;
    try { s = await buildShip(rec); } catch (e) { console.error(e); }
    if (s) ships.push(s); else pendingCount++;
  }
  if (pendingCount && retryN++ < RETRY_MAX) setTimeout(loadAll, RETRY_MS);
  else if (pendingCount) toastMsg('読み込めない船が' + pendingCount + '隻あります（形のデータが見つかりません）。データは残っています');
  else retryN = 0;
}

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
  toastMsg('乗りました。W・S で進む・下がる、A・D で舵（X キーで降ります）');
}

// 降りる場所：船の横（陸や建物に重ならないところ）
function exitSpot(s) {
  let maxX = 0;
  for (const c of s.perim) maxX = Math.max(maxX, c.x + 1);
  const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
  const sides = [[maxX + 1.5, 0], [-maxX - 1.5, 0], [0, maxX + 1.5], [0, -maxX - 1.5]];
  const y = SEA + 2;
  for (const [lx, lz] of sides) {
    const x = s.px + c * lx + sn * lz, z = s.pz - sn * lx + c * lz;
    if (!blockedFor(null)(Math.floor(x), Math.floor(y), Math.floor(z))) return new THREE.Vector3(x, y, z);
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
  toastMsg('船から降りました');
}

// 乗っている間は、船の動きでプレイヤーを動かす（通常の歩く・跳ぶは止める）
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
  if (helmUI && helmUI.hud) {
    const dir = s.v > 0.3 ? '前進' : (s.v < -0.3 ? '後進' : '停止');
    helmUI.hud.textContent = s.rec.name + '　' + CLASSES[s.cls].name + '　速さ ' + Math.abs(s.v).toFixed(1) + '（' + dir + '）';
  }
}

// フレームごとの移動（html の updatePhysics の代わり。乗っている間だけ、船の動きに替える）
const origUpdatePhysics = window.updatePhysics;
if (typeof origUpdatePhysics === 'function') {
  window.updatePhysics = function (dt, inp) {
    if (helm) { helmTick(dt); return; }
    return origUpdatePhysics.apply(this, arguments);
  };
}

// X キーで乗る・降りる（文字入力中と、メニューを開いている間は無視）
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
  helmUI = { root, hud: root.querySelector('#shipHud'), board: btn };
  // 船の近くにいるとき、「船に乗る」ボタンを出す（画面の見やすさのため、少しずつ確認する）
  setInterval(() => {
    btn.style.display = (!helm && nearestShip(BOARD_DIST)) ? 'block' : 'none';
  }, 300);
}

// ============================================================
// 船メーカー（道具）
// ============================================================
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function tap() { ensurePanel(); ui.panel.style.display = ''; renderPanel(); }

function ensurePanel() {
  if (ui) return;
  const p = document.createElement('div');
  p.id = 'shipPanel';
  p.style.cssText = 'position:fixed;left:50%;top:4%;transform:translateX(-50%);z-index:60;width:min(460px,94vw);max-height:90vh;overflow:auto;background:#fff;color:#222;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);padding:12px;font-size:14px;display:none;box-sizing:border-box';
  const clsOpts = sel => CLASSES.map((c, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${c.name}</option>`).join('');
  p.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <b style="font-size:16px">船メーカー</b>
      <button data-s="close" style="padding:4px 10px">閉じる</button>
    </div>
    <p style="margin:4px 0;font-size:13px">ステッキで範囲を選び、下の「船にする」を押します。船は海の上で作ってください（陸に重なると作れません）。当たり判定は1.0マスのブロックだけです。</p>
    <div style="border:1px solid #ddd;border-radius:8px;padding:8px;margin:8px 0">
      <b>新しい船</b>
      <div style="margin:6px 0">名前 <input id="shNew" value="自作の船" style="width:180px;padding:4px"></div>
      <div style="margin:6px 0">重さ（動きの軽さ）
        <select id="shNewCls" style="padding:4px">${clsOpts(1)}</select></div>
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
    if (a === 'del') deleteShip(b.dataset.id);
  });
}

function setMsg(t) { if (ui) ui.msg.textContent = t; }

function renderPanel() {
  if (!ui) return;
  if (!metas.length) { ui.list.innerHTML = '<div style="color:#666">まだ船がありません</div>'; return; }
  ui.list.innerHTML = metas.map(rec => {
    const on = ships.some(s => s.rec === rec);
    return `<div style="border-bottom:1px solid #eee;padding:6px 0">
      <div><b>${esc(rec.name)}</b>${on ? '' : '<span style="color:#a33">（形のデータを読み込み中・未読）</span>'}</div>
      <div style="margin:4px 0">重さ <select data-f="cls" style="padding:2px">${CLASSES.map((c, i) => `<option value="${i}" ${i === rec.cls ? 'selected' : ''}>${c.name}</option>`).join('')}</select>
        沈む深さ <input data-f="draft" type="number" min="0" max="10" step="1" value="${rec.draft}" style="width:60px;padding:2px"></div>
      <button data-s="save" data-id="${esc(rec.id)}" style="padding:2px 8px">設定を保存</button>
      <button data-s="del" data-id="${esc(rec.id)}" style="padding:2px 8px;color:#a33">削除</button>
    </div>`;
  }).join('');
}

function readDraft(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : 1;
}

// 範囲の中のブロックを、船の形（1.0マスの当たり判定の柱と、見た目のデータ）にする
async function makeFromSelection() {
  if (inRoom()) { setMsg('部屋に入っている間は船を作れません（段階2の制限です）'); return; }
  const r = VX.wandRange ? VX.wandRange() : null;
  if (!r) { setMsg('ステッキで範囲を選んでから押してください'); return; }
  const name = (document.getElementById('shNew').value || '').trim() || '自作の船';
  const cls = Number(document.getElementById('shNewCls').value) || 0;
  const draft = readDraft(document.getElementById('shNewDraft').value);

  // 1. 範囲の中身（1.0マスのブロック）と、底の高さ
  const cells = [];
  let base = Infinity;
  for (let x = r.min[0]; x <= r.max[0]; x++) for (let y = r.min[1]; y <= r.max[1]; y++) for (let z = r.min[2]; z <= r.max[2]; z++) {
    const id = getBlock(x, y, z);
    if (id === AIR || id === WATER) continue;
    cells.push({ x, y, z });
    base = Math.min(base, y);
  }
  const tilts = VX.tiltList.filter(e => e.obj && !e.hideDraft && e.c && [0, 1, 2].every(i => e.c[i] >= r.min[i] && e.c[i] < r.max[i] + 1));
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
  const localCells = cells.map(c => ({ x: c.x - cx, y: c.y - base, z: c.z - cz }));

  // 3. 海に浮かべられるか（選んだ範囲のブロックは、ぶつかる物に数えない）
  const perim = buildCols(localCells);
  const py = waterFloat(draft);
  if (footprintHits(perim, cx, py, cz, 0, blockedFor(r))) { setMsg('海の上で作ってください（陸や建物に重なっています）'); return; }

  // 4. 先に保存する（保存できなければ、ブロックは消さない）
  const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const rec = { id, name, cls, draft, px: cx, pz: cz, yaw: 0 };
  const payload = JSON.stringify({ data, cells: localCells.map(c => [c.x, c.y, c.z]) });
  try { await VX.blobPut(BLOB_PREFIX + id, payload); }
  catch (e) { setMsg('保存できませんでした（容量がいっぱいの可能性があります）'); return; }
  metas.push(rec);
  if (!writeMeta()) { metas.pop(); setMsg('保存できませんでした（容量を確認してください）'); return; }

  // 5. 元のブロックを消す（傾き・0.5マスも含む）
  for (const e of tilts.slice()) { if (window.VoxelDiag && VoxelDiag.dropTilt) VoxelDiag.dropTilt(e); }
  for (const c of cells) { setBlock(c.x, c.y, c.z, AIR); VX.blockState.delete(VX.keyOf(c.x, c.y, c.z)); }

  // 6. 画面に出す
  try {
    const s = await buildShip(rec);
    if (s) ships.push(s);
  } catch (e) { console.error(e); }
  setMsg('');
  renderPanel();
  toastMsg('船「' + name + '」を作りました。乗るには X キー（または「船に乗る」ボタン）');
}

async function saveEdit(id) {
  const rec = metas.find(m => m.id === id);
  if (!rec) return;
  const row = [...ui.list.querySelectorAll('[data-s="save"]')].find(b => b.dataset.id === id);
  const box = row ? row.parentElement : null;
  const cls = Number(box.querySelector('[data-f="cls"]').value) || 0;
  const draft = readDraft(box.querySelector('[data-f="draft"]').value);
  const s = ships.find(x => x.rec === rec);
  if (s) {
    const py = waterFloat(draft);
    if (!(helm && helm.ship === s) && footprintHits(s.perim, s.px, py, s.pz, s.yaw, blockedFor(null))) {
      setMsg('この深さだと陸に重なるため、変えられません'); return;
    }
    s.cls = cls; s.draft = draft; s.py = py;
    if (helm && helm.ship === s) helm.ship.py = py;
  }
  rec.cls = cls; rec.draft = draft;
  if (!writeMeta()) { setMsg('保存できませんでした'); return; }
  setMsg('');
  toastMsg('船の設定を保存しました');
  renderPanel();
}

async function deleteShip(id) {
  const rec = metas.find(m => m.id === id);
  if (!rec) return;
  if (!window.confirm('船「' + rec.name + '」を消します。船の中のブロックは元に戻りません。よろしいですか？')) return;
  const s = ships.find(x => x.rec === rec);
  if (helm && s && helm.ship === s) dismount();
  metas = metas.filter(m => m.id !== id);
  if (!writeMeta()) { setMsg('保存できませんでした（消していません）'); metas.push(rec); return; }
  if (s) { scene.remove(s.root); ships.splice(ships.indexOf(s), 1); }
  VX.blobDel(BLOB_PREFIX + id).catch(() => {});
  renderPanel();
  toastMsg('船を消しました');
}

// 画面を閉じる・再読み込み前に、乗っている船の場所を覚える
window.addEventListener('pagehide', () => {
  if (helm) { helm.ship.rec.px = helm.ship.px; helm.ship.rec.pz = helm.ship.pz; helm.ship.rec.yaw = helm.ship.yaw; }
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
