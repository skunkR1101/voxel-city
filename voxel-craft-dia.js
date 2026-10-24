/* voxel-craft-dia.js (v1)  列車ダイヤ運行システム
 * 読み込み順：voxel-craft-ext.js → voxel-craft-road.js → voxel-craft-train.js → voxel-craft-dia.js
 * 本体HTML・既存の3ファイルは変更しない（既存の関数を後から包んで拡張する）
 *
 *  ・路線：加速度・減速度（路線ごと）、VVVF音のON/OFF（路線ごと）
 *  ・種別：何個でも追加。種別ごとに経路・時刻表・車内放送・警笛を持つ
 *  ・編成：列車エディットの車両リストから連結して、何個でも登録
 *  ・経路：線路をタップ（始点）→タップ（終点）で自動登録。中間点（Mキー／画面ボタン）で分岐も指定可能
 *  ・経路は色付きのラインで表示（路線エディット中）。後から何本でも追加可能
 *  ・車内放送・警笛：走行中のプレイヤー（編成に乗っている本人）だけに聞こえる
 *  ・ジョイント音：区間の始点・終点と間隔（m）、音声をアップロードして保存・再利用
 *
 * 操作：O … 路線エディットのON/OFF ／ 🗺 路線 ボタン … 設定パネル ／ 運行は設定パネルの「運行開始」
 */
(function () {
'use strict';

// ============================================================
// 定数・状態
// ============================================================
const KEY = 'voxelcraft_dia_v1';
const ROAD_KEY = 'voxelcraft_road_v1';
const V3 = THREE.Vector3;
const VT = window.VoxelTrain;          // voxel-craft-train.js の窓口（先に読み込まれている必要があります）
const { lib, ctl, GAP, carById, buildCar, partsOf, applyAnims, makeVvvfChannel, startChannel, updateChannel, decodeCached, ensureAudio, routeAt } = VT;
const audioNow = () => VT.audio();
const RIDE_LIFT = 0.15;              // 色付きラインの高さ（線路の上）
const JOINT_MIN = 5;                 // ジョイント音の最小間隔（m）
const HORN_COL = 0xff4d4d;
const JOINT_COL = 0xc39bff;

let dia = { lines: [], sounds: [] }; // 保存されるデータ

const ui = {
  panel: false, editing: false, editMode: null,   // editMode: 'route' | 'announce' | 'horn' | 'joint' | null
  lineId: null, typeId: null, formId: null, routeId: null, soundId: null,
  pending: null, mid: null, nextMid: false,
  grp: null
};
const rail = { sig: '', pieces: [], G: null, t: 0 };
let markerCur = null, markerPend = null, msgEl = null, msgT = 0;
let barEl = null, panelEl = null, barStatusEl = null;

// ============================================================
// 補助
// ============================================================
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function r3(v) { return Math.round(v * 1000) / 1000; }
function uid() { return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function msg(t) {
  if (!msgEl) return;
  msgEl.textContent = t;
  msgEl.classList.add('show');
  clearTimeout(msgT);
  msgT = setTimeout(() => msgEl.classList.remove('show'), 2800);
}
function curLine() { return dia.lines.find(l => l.id === ui.lineId) || null; }
// 別ファイル（駅・自動運転）から読むための窓口
window.VoxelDia = {
  lines: () => dia.lines,
  sounds: () => dia.sounds,
  currentLineId: () => ui.lineId,
  save,
  // 音声の一括取り込み（ワールド読み込み用）
  importSounds: async list => {
    for (const x of list || []) {
      if (!x || !x.id || !x.data) continue;
      await soundPut(x.id, x.data);
      if (!dia.sounds.some(y => y.id === x.id)) dia.sounds.push({ id: x.id, name: x.name || '音声', data: x.data });
    }
    save();
  },
  // 現在の音声の一覧（中身つき）
  soundsWithData: () => dia.sounds.map(x => ({ id: x.id, name: x.name, data: x.data }))
};
function typeOf(L, id) { return L ? L.types.find(t => t.id === id) || null : null; }
function soundOf(id) { return dia.sounds.find(s => s.id === id) || null; }
function polyLen(pts) {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += pts[i].distanceTo(pts[i - 1]);
  return n;
}
function rayDist(p) {
  const cam = camera.position;
  const d = camera.getWorldDirection(new V3());
  const t = clamp(p.clone().sub(cam).dot(d), 0, 80);
  return cam.clone().addScaledVector(d, t).distanceTo(p);
}

// ============================================================
// 保存・読み込み
// ============================================================
// 音声の中身（大きいデータ）は IndexedDB に保存する。localStorage には名前だけ残す
// （localStorage は約5MBしか使えず、音声ファイルで容量超過しやすいため）
const IDB_NAME = 'voxelcraft', IDB_STORE = 'kv', SND_PREFIX = 'snd:';
let dbP = null;
function openDb() {
  if (!dbP) dbP = new Promise((res, rej) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbP;
}
function idbRun(mode, fn) {
  return openDb().then(d => new Promise((res, rej) => {
    const tx = d.transaction(IDB_STORE, mode);
    const out = fn(tx.objectStore(IDB_STORE));
    tx.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  }));
}
function soundPut(id, data) { return idbRun('readwrite', st => st.put(data, SND_PREFIX + id)); }
function soundDel(id) { return idbRun('readwrite', st => st.delete(SND_PREFIX + id)); }
function soundsLoadAll() {
  return openDb().then(d => new Promise((res, rej) => {
    const tx = d.transaction(IDB_STORE, 'readonly');
    const st = tx.objectStore(IDB_STORE);
    const range = IDBKeyRange.bound(SND_PREFIX, SND_PREFIX + '\uffff');
    const map = new Map();
    const req = st.openCursor(range);
    req.onsuccess = () => {
      const c = req.result;
      if (c) { map.set(String(c.key).slice(SND_PREFIX.length), c.value); c.continue(); }
    };
    tx.oncomplete = () => res(map);
    tx.onerror = () => rej(tx.error);
  }));
}
function save() {
  try {
    const light = { lines: dia.lines, sounds: dia.sounds.map(x => ({ id: x.id, name: x.name })) };
    localStorage.setItem(KEY, JSON.stringify(light));
    return true;
  } catch (e) {
    msg('保存できませんでした（容量超過）');
    return false;
  }
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (Array.isArray(s.lines)) dia.lines = s.lines;
    if (Array.isArray(s.sounds)) {
      // 以前の版では音声の中身を localStorage に入れていたので、IndexedDB へ移す
      for (const x of s.sounds) if (x && x.id && x.data) soundPut(x.id, x.data).catch(() => {});
      dia.sounds = s.sounds.map(x => ({ id: x.id, name: x.name, data: x.data || null }));
    }
  } catch (e) {}
  // 音声の中身を IndexedDB から読み込む（読み終わるまで、その音は鳴りません）
  soundsLoadAll().then(map => {
    for (const x of dia.sounds) { if (map.has(x.id)) x.data = map.get(x.id); }
    renderPanel();
  }).catch(() => msg('音声の保存領域を開けませんでした'));
  if (dia.lines.length) ui.lineId = dia.lines[0].id;
  const L = curLine();
  if (L && L.types.length) ui.typeId = L.types[0].id;
}

// ============================================================
// 線路グラフ（路線エディットの経路探索に使う。道路モードの保存データを読む）
// ============================================================
function buildGraph(pieces) {
  const nodes = [], grid = new Map(), pn = [];
  const keyOf = (x, y, z) => x + ',' + y + ',' + z;
  const find = p => {
    const cx = Math.floor(p.x), cy = Math.floor(p.y), cz = Math.floor(p.z);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const arr = grid.get(keyOf(cx + dx, cy + dy, cz + dz));
      if (!arr) continue;
      for (const i of arr) if (nodes[i].p.distanceTo(p) < 0.5) return i;
    }
    const i = nodes.length;
    nodes.push({ p: p.clone(), adj: [] });
    const k = keyOf(cx, cy, cz);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
    return i;
  };
  pieces.forEach((pc, i) => {
    const ia = find(pc.a), ib = find(pc.b);
    pn[i] = [ia, ib];
    if (ia !== ib) {
      nodes[ia].adj.push({ to: ib, pi: i, l: pc.l });
      nodes[ib].adj.push({ to: ia, pi: i, l: pc.l });
    }
  });
  return { nodes, pn };
}
function refreshRail(force) {
  const now = performance.now();
  if (!force && now - rail.t < 1500) return;
  rail.t = now;
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(ROAD_KEY) || '{}'); } catch (e) {}
  const src = (raw.pieces || []).filter(p => p.kind === 'rail');
  const sig = src.length + '|' + (raw.gid || 0) + '|' + (raw.nodes ? raw.nodes.length : 0);
  if (sig === rail.sig) return;
  rail.sig = sig;
  rail.pieces = src.map(p => {
    const f = new V3(0, 0, 1).applyQuaternion(new THREE.Quaternion(p.q[0], p.q[1], p.q[2], p.q[3]));
    const mid = new V3(p.x, p.y, p.z);
    return {
      mid, l: p.l,
      a: mid.clone().addScaledVector(f, -p.l / 2),
      b: mid.clone().addScaledVector(f, p.l / 2)
    };
  });
  rail.G = buildGraph(rail.pieces);
  if (ui.editing) {          // 線路が変わったら途中の指定はリセット
    ui.pending = null; ui.mid = null; ui.nextMid = false;
  }
}
// 画面の照準に近い線路の区間を探す（見えている線路のうち一番近いもの）
function pickPiece(maxD) {
  if (!rail.pieces.length) return -1;
  const cam = camera.position;
  const d = camera.getWorldDirection(new V3());
  let best = -1, bs = Infinity;
  rail.pieces.forEach((pc, i) => {
    const t = clamp(pc.mid.clone().sub(cam).dot(d), 0, 80);
    const dist = cam.clone().addScaledVector(d, t).distanceTo(pc.mid);
    if (dist > maxD) return;
    const score = dist + 0.02 * t;
    if (score < bs) { bs = score; best = i; }
  });
  return best;
}

// 始点の区間 si から終点の区間 ei まで、線路をつないで最短の経路を求める
// 同じ区間は一度しか通らない（始点・終点の区間そのものは途中で使わない）
function findPath(si, ei) {
  const G = rail.G, P = rail.pieces;
  if (!G || si < 0 || ei < 0 || si === ei) return null;
  const N = G.nodes.length;
  const pn = G.pn;
  if (!pn[si] || !pn[ei]) return null;
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const done = new Uint8Array(N);
  const hs = P[si].l / 2;
  for (const s of pn[si]) if (hs < dist[s]) dist[s] = hs;
  for (;;) {
    let u = -1, bu = Infinity;
    for (let i = 0; i < N; i++) if (!done[i] && dist[i] < bu) { bu = dist[i]; u = i; }
    if (u < 0) break;
    done[u] = 1;
    for (const e of G.nodes[u].adj) {
      if (e.pi === si || e.pi === ei) continue;
      const nd = bu + e.l;
      if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = u; }
    }
  }
  const he = P[ei].l / 2;
  let best = -1, bd = Infinity;
  for (const t of pn[ei]) {
    if (dist[t] === Infinity) continue;
    const c = dist[t] + he;
    if (c < bd) { bd = c; best = t; }
  }
  if (best < 0) return null;
  const seq = [];
  let cur = best, guard = 0;
  while (cur >= 0 && guard++ <= N) { seq.push(cur); cur = prev[cur]; }
  seq.reverse();
  const pts = [P[si].mid.clone()];
  for (const n of seq) pts.push(G.nodes[n].p.clone());
  pts.push(P[ei].mid.clone());
  return dedupe(pts);
}
function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    if (!out.length || out[out.length - 1].distanceTo(p) > 1e-3) out.push(p);
  }
  return out;
}
// 中間点があれば「始点→中間点→終点」をつなぐ
function buildRoutePts(si, mi, ei) {
  if (mi == null) return findPath(si, ei);
  const a = findPath(si, mi), b = findPath(mi, ei);
  if (!a || !b) return null;
  return dedupe(a.concat(b));
}

// 経路（点の列）を、走行用の区間リストに変換する（routeAt と同じ形）
function flatOf(pts) {
  const flat = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const d = b.clone().sub(a);
    const l = d.length();
    if (l < 1e-6) continue;
    const f = d.clone().divideScalar(l);
    const c = a.clone().add(b).multiplyScalar(0.5);
    flat.push({ c, f, l, s0: total });
    total += l;
  }
  return { flat, total };
}
// 点が経路のどの位置（走行距離 s）に近いかを求める
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

// ============================================================
// 路線エディット：タップ処理
// ============================================================
function editTap() {
  if (!ui.editing) return;
  const L = curLine();
  if (!L) { msg('先に路線を作成してください（🗺 路線）'); return; }
  refreshRail(true);
  const idx = pickPiece(2.0);
  if (idx < 0) { msg('線路に向けてタップしてください'); return; }
  const pc = rail.pieces[idx];
  const mode = ui.editMode;

  if (mode === 'route') {
    if (!ui.pending) {
      ui.pending = { pi: idx, mid: pc.mid.clone() };
      ui.mid = null; ui.nextMid = false;
      msg('始点を指定しました。中間点は「中間点」ボタン（Mキー）、終点をタップ');
    } else if (ui.nextMid) {
      if (idx === ui.pending.pi) { msg('中間点は始点と別の線路に置いてください'); return; }
      ui.mid = { pi: idx, mid: pc.mid.clone() };
      ui.nextMid = false;
      msg('中間点を置きました。終点をタップ');
    } else {
      if (idx === ui.pending.pi) { msg('終点は始点と別の線路を指定してください'); return; }
      const pts = buildRoutePts(ui.pending.pi, ui.mid ? ui.mid.pi : null, idx);
      if (!pts || polyLen(pts) < 1) { msg('経路が見つかりません。線路がつながっているか確認してください'); return; }
      const T = typeOf(L, ui.typeId) || L.types[0];
      const n = L.routes.filter(r => r.typeId === T.id).length + 1;
      const rt = { id: uid(), typeId: T.id, name: '経路' + n, pts: pts.map(p => [r3(p.x), r3(p.y), r3(p.z)]), dep: [] };
      L.routes.push(rt);
      ui.routeId = rt.id;
      ui.pending = null; ui.mid = null; ui.nextMid = false;
      msg(`「${T.name}」の経路を登録しました（${Math.round(polyLen(pts))} m）。続けて次の経路も追加できます`);
    }
  } else if (mode === 'announce' || mode === 'horn') {
    const T = typeOf(L, ui.typeId) || L.types[0];
    if (mode === 'announce' && !ui.soundId) { msg('パネルで放送の音声を選んでください'); return; }
    L.events.push({ id: uid(), typeId: T.id, kind: mode, soundId: mode === 'announce' ? ui.soundId : null, p: [r3(pc.mid.x), r3(pc.mid.y), r3(pc.mid.z)] });
    msg(mode === 'horn' ? '警笛の位置を置きました' : '車内放送の位置を置きました');
  } else if (mode === 'joint') {
    if (!ui.pending) {
      ui.pending = { mid: pc.mid.clone() };
      msg('ジョイント区間の終点をタップ');
    } else {
      const a = ui.pending.mid, b = pc.mid;
      L.joints.push({ id: uid(), a: [r3(a.x), r3(a.y), r3(a.z)], b: [r3(b.x), r3(b.y), r3(b.z)], interval: 25, soundId: ui.soundId || null });
      ui.pending = null;
      msg('ジョイント区間を追加しました（間隔・音はパネルで設定）');
    }
  } else {
    msg('上の「経路を追加」などのボタンを選んでから線路をタップしてください');
    return;
  }
  save();
  rebuildViz();
  renderPanel();
}
// 路線エディット中の左クリック：照準の近くにある放送・警笛・ジョイント区間の点を消す
function editBreak() {
  const L = curLine();
  if (!L || !ui.editing) return;
  let hit = null, bd = 2.0;
  for (const ev of L.events) {
    const d = rayDist(new V3(ev.p[0], ev.p[1], ev.p[2]));
    if (d < bd) { bd = d; hit = { list: L.events, item: ev }; }
  }
  for (const j of L.joints) {
    for (const k of ['a', 'b']) {
      const d = rayDist(new V3(j[k][0], j[k][1], j[k][2]));
      if (d < bd) { bd = d; hit = { list: L.joints, item: j }; }
    }
  }
  if (!hit) { msg('削除できる放送・警笛・ジョイント点がありません（照準を近づけてください）'); return; }
  hit.list.splice(hit.list.indexOf(hit.item), 1);
  save();
  rebuildViz();
  renderPanel();
  msg('削除しました');
}
function setEditing(on) {
  ui.editing = !!on;
  if (!ui.editing) { ui.editMode = null; ui.pending = null; ui.mid = null; ui.nextMid = false; }
  rebuildViz();
  updateBar();
  msg(ui.editing ? '路線エディット：上のボタンで編集内容を選んでから線路をタップ' : '路線エディットを終了しました');
}

// ============================================================
// 表示：色付きライン・点（路線エディット中だけ表示）
// ============================================================
function ribbonGeo(pts, width) {
  const pos = [];
  const w = width / 2;
  const push = v => pos.push(v.x, v.y, v.z);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const d = new V3(b.x - a.x, 0, b.z - a.z);
    if (d.lengthSq() < 1e-8) continue;
    d.normalize();
    const n = new V3(-d.z, 0, d.x).multiplyScalar(w);
    const p1 = new V3(a.x + n.x, a.y + RIDE_LIFT, a.z + n.z);
    const p2 = new V3(a.x - n.x, a.y + RIDE_LIFT, a.z - n.z);
    const p3 = new V3(b.x + n.x, b.y + RIDE_LIFT, b.z + n.z);
    const p4 = new V3(b.x - n.x, b.y + RIDE_LIFT, b.z - n.z);
    push(p1); push(p2); push(p3);
    push(p2); push(p4); push(p3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}
function rebuildViz() {
  if (ui.grp) {
    scene.remove(ui.grp);
    ui.grp.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    ui.grp = null;
  }
  if (!ui.editing) return;
  const L = curLine();
  if (!L) return;
  const g = new THREE.Group();
  for (const rt of L.routes) {
    const T = typeOf(L, rt.typeId);
    const col = T ? T.color : '#ffffff';
    const pts = rt.pts.map(p => new V3(p[0], p[1], p[2]));
    const m = new THREE.Mesh(ribbonGeo(pts, 0.42), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
    m.renderOrder = 8;
    g.add(m);
  }
  const box = (x, y, z, col) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 0.9 }));
    m.position.set(x, y + 0.8, z);
    m.renderOrder = 9;
    g.add(m);
  };
  for (const ev of L.events) {
    const T = typeOf(L, ev.typeId);
    box(ev.p[0], ev.p[1], ev.p[2], ev.kind === 'horn' ? HORN_COL : (T ? new THREE.Color(T.color).getHex() : 0xffffff));
  }
  for (const j of L.joints) {
    box(j.a[0], j.a[1], j.a[2], JOINT_COL);
    box(j.b[0], j.b[1], j.b[2], JOINT_COL);
  }
  scene.add(g);
  ui.grp = g;
}

// ============================================================
// 音（車内放送・警笛・ジョイント音）
// ============================================================
function playSound(id) {
  const s = soundOf(id);
  const A = audioNow();
  if (!s || !A.actx || !A.masterGain) return;
  decodeCached(s.data).then(buf => {
    const src = A.actx.createBufferSource();
    src.buffer = buf;
    src.connect(A.masterGain);
    src.start();
  }).catch(() => {});
}
function playHorn() {
  const A = audioNow();
  if (!A.actx || !A.masterGain) return;
  const actx = A.actx, masterGain = A.masterGain;
  const t = actx.currentTime;
  for (const f of [392, 494]) {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sawtooth';
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18, t + 0.05);
    g.gain.setValueAtTime(0.18, t + 1.2);
    g.gain.linearRampToValueAtTime(0, t + 1.4);
    o.connect(g); g.connect(masterGain);
    o.start(t); o.stop(t + 1.5);
  }
}

// ============================================================
// 運行（路線の加減速・VVVF・放送・ジョイント音）
// 列車エディットの運行（run）の仕組みを流用し、この運行だけ別の計算に切り替える
// ============================================================
function nowMinutes() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
function parseDep(str) {
  const out = [];
  for (const part of String(str).split(/[,、\s]+/)) {
    const m = part.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const h = Number(m[1]), mi = Number(m[2]);
    if (h > 23 || mi > 59) continue;
    out.push(String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0'));
  }
  return out;
}
function nextDep(route) {
  if (!route.dep || !route.dep.length) return null;
  const now = nowMinutes();
  let best = null, bd = Infinity;
  for (const hm of route.dep) {
    const [h, m] = hm.split(':').map(Number);
    let diff = h * 60 + m - now;
    if (diff < 0) diff += 1440;
    if (diff < bd) { bd = diff; best = hm; }
  }
  return best ? { hm: best, left: bd } : null;
}
function prepEvents(L, typeId, route) {
  const out = [];
  for (const ev of L.events) {
    if (ev.typeId !== typeId) continue;
    const pr = projectS(route, new V3(ev.p[0], ev.p[1], ev.p[2]));
    if (pr.d > 3) continue;
    out.push({ s: pr.s, kind: ev.kind, soundId: ev.soundId, done: false });
  }
  out.sort((a, b) => a.s - b.s);
  return out;
}
function prepJoints(L, route) {
  const out = [];
  for (const j of L.joints) {
    const A = projectS(route, new V3(j.a[0], j.a[1], j.a[2]));
    const B = projectS(route, new V3(j.b[0], j.b[1], j.b[2]));
    if (A.d > 3 || B.d > 3) continue;
    out.push({ s0: Math.min(A.s, B.s), s1: Math.max(A.s, B.s), next: Math.min(A.s, B.s), interval: Math.max(JOINT_MIN, Number(j.interval) || 25), soundId: j.soundId });
  }
  return out;
}

async function startDiaRun(formId, routeId) {
  const L = curLine();
  if (!L) { msg('路線を選んでください'); return; }
  if (VT.getRun()) { msg('運行中です。先に運行を終了してください'); return; }
  if (!started) { msg('ゲームを開始してから運行してください'); return; }
  const F = L.formations.find(f => f.id === formId);
  const R = L.routes.find(r => r.id === routeId);
  if (!F || !F.cars.length) { msg('編成を選んでください（編成が空です）'); return; }
  if (!R) { msg('経路を選んでください（先に経路を登録）'); return; }
  const T = typeOf(L, R.typeId);
  const route = flatOf(R.pts.map(p => new V3(p[0], p[1], p[2])));
  if (route.total < 1) { msg('経路が短すぎます'); return; }

  ensureAudio();
  const cars = [];
  for (const id of F.cars) {
    const car = carById(id);
    if (!car) continue;
    const b = await buildCar(car);
    const root = b.root.clone(true);
    root.traverse(o => { if (o.isMesh && o.material) o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone(); });
    scene.add(root);
    let ch = null;
    if (L.vvvf && audioNow().actx) {
      const chn = makeVvvfChannel(car);
      if (chn) {
        try {
          startChannel(chn, await decodeCached(car.vvvf.accel.data), await decodeCached(car.vvvf.decel.data));
          ch = chn;
        } catch (e) { console.error(e); }
      }
    }
    cars.push({ car, root, parts: partsOf(root), length: b.length, ch });
  }
  if (!cars.length) { msg('編成の車両を読み込めませんでした'); return; }

  const info = nextDep(R);
  let depMsg = '';
  if (R.dep && R.dep.length) {
    const near = R.dep.map(hm => { const [h, m] = hm.split(':').map(Number); const d = Math.abs(h * 60 + m - nowMinutes()); return { hm, d: Math.min(d, 1440 - d) }; }).sort((a, b) => a.d - b.d)[0];
    depMsg = near.d <= 2 ? `（時刻表 ${near.hm} の定刻）` : `（時刻表 ${near.hm} と ${near.d} 分ずれ）`;
  }
  VT.setRun({
    custom: true,
    route, s: 0, speed: 0, cars, t: 0,
    saved: { pos: player.pos.clone(), viewMode },
    dia: { line: L, typeName: T ? T.name : '', events: prepEvents(L, R.typeId, route), joints: prepJoints(L, route), depMsg, info }
  });
  viewMode = 1;
  player.vel.set(0, 0, 0);
  ctl.acc = ctl.brk = ctl.emg = false;
  document.getElementById('trnRunUI').style.display = 'flex';
  closePanel();
  msg(`運行開始 ${depMsg}：W（加速）・S（減速）で運転`);
}

function fireEvent(ev) {
  if (ev.kind === 'horn') playHorn();
  else if (ev.soundId) playSound(ev.soundId);
}
function diaUpdate(r, dt) {
  const L = r.dia.line;
  const throttle = (!!keys.KeyW || ctl.acc) && !ctl.emg;
  const brake = !!keys.KeyS || ctl.brk || ctl.emg;
  if (throttle) r.speed += L.accel * dt;
  if (brake) r.speed -= L.decel * (ctl.emg ? 2.5 : 1) * dt;
  r.speed -= 0.08 * dt;
  if (r.speed < 0) r.speed = 0;
  const maxV = lib.maxKmh / 3.6;
  if (r.speed > maxV) r.speed = maxV;
  r.s += r.speed * dt;
  if (r.s >= r.route.total) { r.s = r.route.total - 1e-3; r.speed = 0; }
  r.t += dt;
  const kmh = r.speed * 3.6;

  // 車内放送・警笛（走行中のプレイヤーだけに聞こえる）
  for (const ev of r.dia.events) {
    if (!ev.done && r.s >= ev.s) { ev.done = true; fireEvent(ev); }
  }
  // ジョイント音（区間内を間隔ごとに鳴らす）
  for (const j of r.dia.joints) {
    while (j.next <= j.s1 && r.s >= j.next) {
      if (j.soundId) playSound(j.soundId);
      j.next += j.interval;
    }
  }

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

  const sp = document.getElementById('trnSpeed');
  if (sp) sp.textContent = `${Math.round(kmh)} km/h`;
  const hud = document.getElementById('trnHud');
  if (hud) {
    hud.style.display = 'block';
    const nx = r.dia.info ? `　次の発車 ${r.dia.info.hm}` : '';
    hud.textContent = `${L.name}｜${r.dia.typeName}｜${Math.round(r.s)} / ${Math.round(r.route.total)} m｜最高 ${lib.maxKmh} km/h${nx}`;
  }
}
// ============================================================
// 設定パネル
// ============================================================
function openPanel() {
  if (settingsEl.classList.contains('show')) return;
  ui.panel = true;
  panelEl.classList.add('show');
  menuOpen = true;
  releaseActions();
  for (const k in keys) keys[k] = false;
  if (document.pointerLockElement) document.exitPointerLock();
  renderPanel();
  updateBar();
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

function renderPanel() {
  if (!panelEl) return;
  const body = document.getElementById('diaBody');
  const L = curLine();
  let h = '';
  h += `<h3>路線</h3><div class="dia-row">`;
  h += `<select data-f="lineSel"><option value="">（路線を選択）</option>${dia.lines.map(l => `<option value="${esc(l.id)}" ${L && L.id === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>`;
  h += `<input id="diaNewLine" placeholder="新しい路線名"><button class="dia-btn" data-a="newLine">路線を作成</button>`;
  if (L) h += `<button class="dia-btn danger" data-a="delLine">この路線を削除</button>`;
  h += `</div>`;
  h += `<div class="dia-row"><button class="dia-btn ${ui.editing ? 'on' : ''}" data-a="toggleEdit">路線エディット：${ui.editing ? 'ON（線路に色付きラインを表示）' : 'OFF'}（Oキー）</button></div>`;
  if (!L) { h += `<p class="dia-note">路線を作成すると、ここで種別・編成・経路・放送などを設定できます。</p>`; body.innerHTML = h; return; }

  h += `<div class="dia-row">路線名 <input data-f="lname" value="${esc(L.name)}">
    加速度 <input type="number" step="0.05" min="0.05" max="5" data-f="accel" value="${L.accel}"> m/s²
    減速度 <input type="number" step="0.05" min="0.05" max="8" data-f="decel" value="${L.decel}"> m/s²</div>`;
  h += `<div class="dia-row"><label><input type="checkbox" data-f="vvvf" ${L.vvvf ? 'checked' : ''}> 路線内の加減速に応じてVVVF音を鳴らす</label></div>`;

  // 種別
  h += `<h3>種別（何個でも追加できます）</h3>`;
  for (const t of L.types) {
    h += `<div class="dia-item ${ui.typeId === t.id ? 'sel' : ''}">
      <input type="color" data-f="tcolor" data-id="${esc(t.id)}" value="${esc(t.color)}">
      <input data-f="tname" data-id="${esc(t.id)}" value="${esc(t.name)}">
      <button class="dia-btn small" data-a="selType" data-id="${esc(t.id)}">選択</button>
      <button class="dia-btn small danger" data-a="delType" data-id="${esc(t.id)}">削除</button></div>`;
  }
  h += `<div class="dia-row"><input id="diaNewType" placeholder="種別名（例：快速）"><input type="color" id="diaNewColor" value="#ffd84a"><button class="dia-btn" data-a="addType">種別を追加</button></div>`;

  // 編成
  h += `<h3>編成バリエーション（列車エディットの車両から連結）</h3>`;
  if (!lib.cars.length) h += `<p class="dia-note">列車エディットで車両を作ると、ここで連結できます。</p>`;
  for (const f of L.formations) {
    h += `<div class="dia-box2"><div class="dia-row"><input data-f="fname" data-id="${esc(f.id)}" value="${esc(f.name)}">
      <span class="dia-note">${f.cars.length}両</span>
      <button class="dia-btn small danger" data-a="delForm" data-id="${esc(f.id)}">削除</button></div><div class="dia-cars">`;
    for (const c of lib.cars) {
      const idx = f.cars.indexOf(c.id);
      h += `<label class="dia-car"><input type="checkbox" data-f="fcar" data-id="${esc(f.id)}" data-v="${esc(c.id)}" ${idx >= 0 ? 'checked' : ''}>${idx >= 0 ? (idx + 1) + '. ' : ''}${esc(c.name)}</label>`;
    }
    h += `</div><p class="dia-note">チェックした順に、前から連結されます。</p></div>`;
  }
  h += `<div class="dia-row"><input id="diaNewForm" placeholder="編成名（例：6両・快速用）"><button class="dia-btn" data-a="addForm">編成を追加</button></div>`;

  // 経路（選択中の種別）
  const T = typeOf(L, ui.typeId) || L.types[0];
  ui.typeId = T.id;
  h += `<h3>経路（種別：${esc(T.name)}）</h3>`;
  const rts = L.routes.filter(r => r.typeId === T.id);
  for (const r of rts) {
    h += `<div class="dia-item">
      <input data-f="rname" data-id="${esc(r.id)}" value="${esc(r.name)}">
      <span class="dia-note">${Math.round(polyLen(r.pts.map(p => new V3(p[0], p[1], p[2]))))} m</span>
      時刻表 <input data-f="dep" data-id="${esc(r.id)}" value="${esc(r.dep.join(', '))}" placeholder="7:30, 7:45" style="width:150px">
      終点で <select data-f="rend" data-id="${esc(r.id)}"><option value="remove" ${r.endAction !== 'return' ? 'selected' : ''}>編成を消す</option><option value="return" ${r.endAction === 'return' ? 'selected' : ''}>始点に戻る</option></select>
      編成 <select data-f="rform" data-id="${esc(r.id)}"><option value="">（先頭の編成）</option>${L.formations.map(f => `<option value="${esc(f.id)}" ${r.formId === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
      <button class="dia-btn small danger" data-a="delRoute" data-id="${esc(r.id)}">削除</button></div>`;
  }
  h += `<div class="dia-row"><button class="dia-btn" data-a="startRoute">経路を追加（線路の始点→終点をタップ）</button>
     <span class="dia-note">中間点を使うと分岐も指定できます（Mキー・画面の「中間点」ボタン）</span></div>`;

  // 放送・警笛
  h += `<h3>車内放送・警笛（種別ごと）</h3>`;
  h += `<div class="dia-row">使う音声 <select data-f="pickSound"><option value="">（なし）</option>${dia.sounds.map(s => `<option value="${esc(s.id)}" ${ui.soundId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
     <button class="dia-btn" data-a="setEv" data-v="announce">放送の位置を置く</button>
     <button class="dia-btn" data-a="setEv" data-v="horn">警笛の位置を置く</button></div>`;
  for (const ev of L.events.filter(e => e.typeId === T.id)) {
    const s = soundOf(ev.soundId);
    h += `<div class="dia-item">${ev.kind === 'horn' ? '警笛' : '車内放送'}：${esc(s ? s.name : '（警笛音）')}
      <button class="dia-btn small danger" data-a="delEv" data-id="${esc(ev.id)}">削除</button></div>`;
  }

  // ジョイント音
  h += `<h3>ジョイント音（区間）</h3>`;
  h += `<div class="dia-row"><button class="dia-btn" data-a="setEv" data-v="joint">区間を追加（始点→終点の線路をタップ）</button></div>`;
  L.joints.forEach((j, i) => {
    h += `<div class="dia-item">区間${i + 1}　間隔 <input type="number" min="${JOINT_MIN}" step="1" data-f="jint" data-id="${esc(j.id)}" value="${j.interval}" style="width:70px"> m
      　音 <select data-f="jsound" data-id="${esc(j.id)}"><option value="">（なし）</option>${dia.sounds.map(s => `<option value="${esc(s.id)}" ${j.soundId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      <button class="dia-btn small danger" data-a="delJoint" data-id="${esc(j.id)}">削除</button></div>`;
  });

  // 音声ライブラリ
  h += `<h3>音声ライブラリ（アップロードした音声は保存されます）</h3>`;
  for (const s of dia.sounds) {
    h += `<div class="dia-item">${esc(s.name)} <button class="dia-btn small danger" data-a="delSound" data-id="${esc(s.id)}">削除</button></div>`;
  }
  h += `<div class="dia-row"><input type="file" id="diaSndFile" accept="audio/*"><input id="diaSndName" placeholder="名前（省略可）"><button class="dia-btn" data-a="addSound">音声を保存</button></div>`;

  // 運行
  h += `<h3>ダイヤ運行</h3>`;
  const F = L.formations.find(f => f.id === ui.formId) || L.formations[0] || null;
  ui.formId = F ? F.id : null;
  const R = rts.find(r => r.id === ui.routeId) || rts[0] || null;
  ui.routeId = R ? R.id : null;
  if (!L.formations.length || !rts.length) {
    h += `<p class="dia-note">編成と経路を登録すると運行できます。</p>`;
  } else {
    h += `<div class="dia-row">編成 <select data-f="runForm">${L.formations.map(f => `<option value="${esc(f.id)}" ${F && F.id === f.id ? 'selected' : ''}>${esc(f.name)}（${f.cars.length}両）</option>`).join('')}</select>
      経路 <select data-f="runRoute">${rts.map(r => `<option value="${esc(r.id)}" ${R && R.id === r.id ? 'selected' : ''}>${esc(r.name)}${r.dep.length ? '（時刻表あり）' : ''}</option>`).join('')}</select>
      <button class="dia-btn" data-a="runStart">運行開始</button></div>`;
    if (R && R.dep.length) {
      const n = nextDep(R);
      h += `<p class="dia-note">次の発車：${n ? n.hm + `（あと ${n.left} 分）` : '—'}　時刻表：${esc(R.dep.join(', '))}</p>`;
    }
  }
  h += `<p class="dia-note">運転は W（加速）・S（減速）、または画面の運転ボタン。車内放送・警笛は運行中のプレイヤーだけに聞こえます。</p>`;
  body.innerHTML = h;
}

function afterChange() {
  save();
  rebuildViz();
  renderPanel();
}

function onPanelClick(e) {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  const a = b.dataset.a, id = b.dataset.id, v = b.dataset.v;
  const L = curLine();
  switch (a) {
    case 'newLine': {
      const n = (document.getElementById('diaNewLine').value.trim()) || ('路線' + (dia.lines.length + 1));
      const nl = { id: uid(), name: n, accel: 0.7, decel: 1.5, vvvf: true, types: [{ id: uid(), name: '普通', color: '#66e0ff' }], formations: [], routes: [], events: [], joints: [] };
      dia.lines.push(nl);
      ui.lineId = nl.id; ui.typeId = nl.types[0].id; ui.formId = null; ui.routeId = null;
      break;
    }
    case 'delLine': {
      if (!L || !confirm(`路線「${L.name}」を削除しますか？`)) return;
      dia.lines = dia.lines.filter(x => x !== L);
      ui.lineId = dia.lines.length ? dia.lines[0].id : null;
      ui.typeId = null; ui.formId = null; ui.routeId = null;
      setEditing(false);
      break;
    }
    case 'toggleEdit': setEditing(!ui.editing); renderPanel(); updateBar(); return;
    case 'addType': {
      if (!L) return;
      const n = document.getElementById('diaNewType').value.trim() || ('種別' + (L.types.length + 1));
      const t = { id: uid(), name: n, color: document.getElementById('diaNewColor').value };
      L.types.push(t);
      ui.typeId = t.id;
      break;
    }
    case 'selType': ui.typeId = id; ui.routeId = null; break;
    case 'delType': {
      if (!L || L.types.length <= 1) { msg('種別は1つ以上必要です'); return; }
      if (!confirm('この種別と、その経路・放送・警笛を削除しますか？')) return;
      L.types = L.types.filter(t => t.id !== id);
      L.routes = L.routes.filter(r => r.typeId !== id);
      L.events = L.events.filter(ev => ev.typeId !== id);
      if (ui.typeId === id) ui.typeId = L.types[0].id;
      break;
    }
    case 'addForm': {
      if (!L) return;
      const n = document.getElementById('diaNewForm').value.trim() || ('編成' + (L.formations.length + 1));
      const f = { id: uid(), name: n, cars: [] };
      L.formations.push(f);
      ui.formId = f.id;
      break;
    }
    case 'delForm': if (L && confirm('この編成を削除しますか？')) L.formations = L.formations.filter(f => f.id !== id); break;
    case 'startRoute':
      if (!L) return;
      setEditing(true);
      ui.editMode = 'route';
      ui.pending = null; ui.mid = null; ui.nextMid = false;
      msg('線路の上で始点をタップ → 終点をタップで経路が登録されます');
      closePanel();
      break;
    case 'setEv':
      if (!L) return;
      if (!ui.editing) setEditing(true);
      ui.editMode = v; ui.pending = null;
      msg(v === 'joint' ? 'ジョイント区間：始点の線路をタップ' : (v === 'horn' ? '警笛を置く位置の線路をタップ' : '放送を流す位置の線路をタップ'));
      closePanel();
      break;
    case 'delRoute': if (L && confirm('この経路を削除しますか？')) L.routes = L.routes.filter(r => r.id !== id); break;
    case 'delEv': if (L) L.events = L.events.filter(ev => ev.id !== id); break;
    case 'delJoint': if (L) L.joints = L.joints.filter(j => j.id !== id); break;
    case 'delSound': {
      if (!confirm('この音声を削除しますか？（使っている放送・ジョイント音は無音になります）')) return;
      soundDel(id).catch(() => {});
      dia.sounds = dia.sounds.filter(s => s.id !== id);
      for (const l of dia.lines) {
        for (const ev of l.events) if (ev.soundId === id) ev.soundId = null;
        for (const j of l.joints) if (j.soundId === id) j.soundId = null;
      }
      if (ui.soundId === id) ui.soundId = null;
      break;
    }
    case 'addSound': addSound(); return;
    case 'runStart': startDiaRun(ui.formId, ui.routeId); return;
    default: return;
  }
  afterChange();
}
async function addSound() {
  const f = document.getElementById('diaSndFile').files[0];
  if (!f) { msg('音声ファイルを選んでください'); return; }
  const name = (document.getElementById('diaSndName').value || '').trim() || f.name;
  let data;
  try {
    data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
  } catch (err) { msg('音声を読み込めませんでした'); return; }
  const s = { id: uid(), name, data };
  try { await soundPut(s.id, data); }
  catch (err) { msg('音声を保存できませんでした（ブラウザの保存領域が使えません）'); return; }
  dia.sounds.push(s);
  save();
  ui.soundId = s.id;
  renderPanel();
  msg(`「${name}」を音声ライブラリに保存しました`);
}
function onPanelChange(e) {
  const el = e.target, f = el.dataset.f, id = el.dataset.id, v = el.dataset.v;
  if (!f) return;
  const L = curLine();
  const num = () => { const n = Number(el.value); return isFinite(n) ? n : 0; };
  const find = (arr, key) => arr.find(x => x.id === key);
  switch (f) {
    case 'lineSel': {
      ui.lineId = el.value || null;
      const nl = curLine();
      ui.typeId = nl && nl.types.length ? nl.types[0].id : null;
      ui.formId = null; ui.routeId = null;
      break;
    }
    case 'lname': if (L) L.name = el.value.trim() || L.name; break;
    case 'accel': if (L) L.accel = clamp(num(), 0.05, 5); break;
    case 'decel': if (L) L.decel = clamp(num(), 0.05, 8); break;
    case 'vvvf': if (L) L.vvvf = el.checked; break;
    case 'tcolor': { const t = L && find(L.types, id); if (t) t.color = el.value; break; }
    case 'tname': { const t = L && find(L.types, id); if (t) t.name = el.value.trim() || t.name; break; }
    case 'fname': { const fm = L && find(L.formations, id); if (fm) fm.name = el.value.trim() || fm.name; break; }
    case 'fcar': {
      const fm = L && find(L.formations, id);
      if (!fm) break;
      if (el.checked) { if (!fm.cars.includes(v)) fm.cars.push(v); }
      else fm.cars = fm.cars.filter(c => c !== v);
      break;
    }
    case 'rname': { const r = L && find(L.routes, id); if (r) r.name = el.value.trim() || r.name; break; }
    case 'dep': { const r = L && find(L.routes, id); if (r) r.dep = parseDep(el.value); break; }
    case 'rform': { const r = L && find(L.routes, id); if (r) r.formId = el.value || null; break; }
    case 'rend': { const r = L && find(L.routes, id); if (r) r.endAction = el.value === 'return' ? 'return' : 'remove'; break; }
    case 'pickSound': ui.soundId = el.value || null; renderPanel(); return;
    case 'jint': { const j = L && find(L.joints, id); if (j) j.interval = clamp(Math.round(num()), JOINT_MIN, 5000); break; }
    case 'jsound': { const j = L && find(L.joints, id); if (j) j.soundId = el.value || null; break; }
    case 'runForm': ui.formId = el.value; renderPanel(); return;
    case 'runRoute': ui.routeId = el.value; renderPanel(); return;
    default: return;
  }
  afterChange();
}

function ensurePanel() {
  panelEl = document.createElement('div');
  panelEl.id = 'diaPanel';
  panelEl.className = 'dia-panel';
  panelEl.innerHTML = `<div class="dia-box"><div class="dia-head"><h2>列車ダイヤ・路線エディット</h2>
    <button class="dia-btn sub" id="diaClose">閉じる</button></div><div id="diaBody"></div>
    <p class="dia-note" id="diaTip">路線の作成 → 種別・編成の登録 → 経路（線路の始点→終点）→ 放送・警笛・ジョイント音 → 運行</p></div>`;
  document.body.appendChild(panelEl);
  panelEl.addEventListener('click', onPanelClick);
  panelEl.addEventListener('change', onPanelChange);
  document.getElementById('diaClose').addEventListener('click', closePanel);
}
function updateBar() {
  if (!barEl) return;
  const show = ui.editing && started && !menuOpen && !paused && !ui.panel;
  barEl.style.display = show ? 'flex' : 'none';
  const mid = document.getElementById('diaMidBtn');
  if (mid) {
    const rm = ui.editMode === 'route';
    mid.style.display = rm ? 'block' : 'none';
    mid.classList.toggle('on', ui.nextMid);
    mid.classList.toggle('set', !!ui.mid && !ui.nextMid);
    mid.textContent = ui.nextMid ? '中間点を置く' : (ui.mid ? '中間点 ✓' : '中間点');
  }
  if (barStatusEl) {
    const names = { route: '経路', announce: '放送位置', horn: '警笛位置', joint: 'ジョイント区間' };
    barStatusEl.textContent = '路線エディット' + (ui.editMode ? '：' + names[ui.editMode] : '（上のボタンで編集内容を選択）');
  }
}
function toggleMid() {
  if (ui.editMode !== 'route') return;
  if (!ui.pending) { msg('先に始点をタップしてください'); return; }
  ui.nextMid = !ui.nextMid;
  msg(ui.nextMid ? '次にタップする線路を中間点にします' : '中間点の指定を解除しました');
  updateBar();
}
function cancelPending() {
  if (ui.nextMid) { ui.nextMid = false; msg('中間点の指定を取り消しました'); }
  else if (ui.mid) { ui.mid = null; msg('中間点を取り消しました'); }
  else if (ui.pending) { ui.pending = null; msg('始点を取り消しました'); }
  else msg('取り消すものがありません');
  updateBar();
}

// ============================================================
// 入力の割り込み（路線エディット中だけ、線路への操作を横取りする）
// ============================================================
const pPlace = window.doPlace, pBreak = window.doBreak;
const pStart = window.startAct, pStop = window.stopAct;
window.doPlace = function () {
  if (ui.editing && !ui.panel) return editTap();
  return pPlace();
};
window.doBreak = function () {
  if (ui.editing && !ui.panel) return editBreak();
  return pBreak();
};
window.startAct = function (kind) {
  if (ui.editing && !ui.panel && (kind === 'break' || kind === 'place')) {
    if (acts[kind]) return;
    acts[kind] = 'dia';
    if (kind === 'break') editBreak(); else editTap();
    return;
  }
  return pStart(kind);
};
window.stopAct = function (kind) {
  if (acts[kind] === 'dia') { acts[kind] = null; return; }
  return pStop(kind);
};

window.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.code === 'Escape' && ui.panel) { closePanel(); return; }
  if (!started || ui.panel || menuOpen) return;
  if (e.code === 'KeyO') setEditing(!ui.editing);
  else if (e.code === 'KeyM' && ui.editing) toggleMid();
});

// ============================================================
// 画面のボタン（スマホでも操作できるように）
// ============================================================
function tapBtn(el, fn) {
  el.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); fn(); }, { passive: false });
  el.addEventListener('touchend', e => { e.preventDefault(); e.stopPropagation(); }, { passive: false });
  el.addEventListener('click', e => { e.stopPropagation(); fn(); });
}
function buildUI() {
  const style = document.createElement('style');
  style.textContent = `
  #diaBtn{position:fixed;right:10px;top:262px;z-index:6;background:rgba(0,0,0,.45);color:#fff;
    border:1px solid rgba(255,255,255,.4);border-radius:6px;padding:7px 11px;font-size:13px;cursor:pointer}
  #diaBar{position:fixed;right:10px;top:300px;z-index:8;display:none;flex-direction:column;gap:6px;align-items:flex-end;pointer-events:auto}
  #diaBar .dia-status{background:rgba(0,0,0,.6);color:#fff;font-size:12px;padding:4px 8px;border-radius:6px;white-space:nowrap}
  #diaBar button{background:rgba(0,0,0,.6);color:#fff;border:2px solid #fff;border-radius:10px;padding:10px 14px;
    font-size:14px;font-weight:bold;touch-action:manipulation;cursor:pointer}
  #diaBar button.on{background:#2f7a3c;border-color:#bff5c9}
  #diaBar button.set{background:#6a5a1e;border-color:#ffe38a}
  #diaMidBtn{display:none}
  #diaToast{position:fixed;left:50%;top:22%;transform:translateX(-50%);background:rgba(0,0,0,.75);color:#fff;
    padding:8px 14px;border-radius:8px;z-index:62;opacity:0;transition:opacity .3s;pointer-events:none;font-size:13px;max-width:90vw}
  #diaToast.show{opacity:1}
  .dia-panel{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:43}
  .dia-panel.show{display:flex}
  .dia-box{background:#1b2530;color:#fff;border-radius:10px;padding:14px;width:min(96vw,760px);max-height:94vh;
    overflow:auto;box-sizing:border-box;font-size:14px;box-shadow:0 6px 24px rgba(0,0,0,.5)}
  .dia-head{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .dia-box h2{margin:0 0 8px;font-size:18px}
  .dia-box h3{margin:14px 0 6px;font-size:14px;color:#cfe3f5}
  .dia-note{font-size:12px;color:#9fb3c8;line-height:1.6;margin:4px 0}
  .dia-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:6px}
  .dia-item{display:flex;gap:6px;flex-wrap:wrap;align-items:center;background:rgba(255,255,255,.06);border-radius:6px;padding:5px 6px;margin-top:4px}
  .dia-item.sel{outline:1px solid #8fd08f}
  .dia-box2{background:rgba(255,255,255,.04);border-radius:6px;padding:6px;margin-top:6px}
  .dia-cars{display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:4px}
  .dia-car{font-size:13px;white-space:nowrap}
  .dia-btn{background:#2e4a66;color:#fff;border:none;border-radius:6px;padding:7px 12px;cursor:pointer;font-size:13px}
  .dia-btn.small{padding:4px 8px;font-size:12px}
  .dia-btn.danger{background:#7a3030}
  .dia-btn.on{background:#4a7a3a}
  .dia-btn.sub{background:#3a3f48}
  .dia-box input,.dia-box select{background:#2a3846;color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:4px;padding:4px 6px;font-size:13px;max-width:100%}
  .dia-box input[type=color]{width:38px;padding:2px}
  .dia-box input[type=file]{border:none;background:none;padding:0}
  `;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.id = 'diaBtn';
  btn.textContent = '🗺 路線';
  document.body.appendChild(btn);
  btn.addEventListener('click', e => { e.stopPropagation(); openPanel(); });

  barEl = document.createElement('div');
  barEl.id = 'diaBar';
  barEl.innerHTML = `<div class="dia-status" id="diaStatus"></div>
    <button id="diaMidBtn">中間点</button>
    <button id="diaCancel">取消</button>
    <button id="diaPanelBtn">設定</button>
    <button id="diaEndBtn">編集終了</button>`;
  document.body.appendChild(barEl);
  barStatusEl = document.getElementById('diaStatus');
  tapBtn(document.getElementById('diaMidBtn'), toggleMid);
  tapBtn(document.getElementById('diaCancel'), cancelPending);
  tapBtn(document.getElementById('diaPanelBtn'), openPanel);
  tapBtn(document.getElementById('diaEndBtn'), () => setEditing(false));

  msgEl = document.createElement('div');
  msgEl.id = 'diaToast';
  document.body.appendChild(msgEl);

  ensurePanel();
}

// ============================================================
// 初期化
// ============================================================
function diaFrame() {
  requestAnimationFrame(diaFrame);
  if (ui.editing && started && !menuOpen && !paused && !ui.panel) {
    refreshRail(false);
    const idx = pickPiece(2.0);
    if (idx >= 0) {
      markerCur.visible = true;
      markerCur.position.copy(rail.pieces[idx].mid).add(new V3(0, 0.5, 0));
      markerCur.material.color.set(ui.editMode === 'route' ? 0x66e0ff : 0xffd84a);
    } else markerCur.visible = false;
    if (ui.pending && ui.pending.mid) {
      markerPend.visible = true;
      markerPend.position.copy(ui.pending.mid).add(new V3(0, 0.5, 0));
    } else markerPend.visible = false;
  } else {
    markerCur.visible = false;
    markerPend.visible = false;
  }
  updateBar();
}
function makeMarker(color) {
  const m = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(0.6, 0.6, 0.6)),
    new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 })
  );
  m.renderOrder = 10;
  m.visible = false;
  scene.add(m);
  return m;
}
function init() {
  if (!VT) { console.error('voxel-craft-train.js が先に読み込まれていません'); return; }
  VT.customUpdate = (r, dt) => diaUpdate(r, dt);
  load();
  buildUI();
  markerCur = makeMarker(0x66e0ff);
  markerPend = makeMarker(0xffd84a);
  renderPanel();
  requestAnimationFrame(diaFrame);
}
window.VoxelSync = window.VoxelSync || {};
VoxelSync.dia = { reload: () => { load(); rebuildViz(); renderPanel(); } };

init();

})();
