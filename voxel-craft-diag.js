/* voxel-craft-diag.js (v1)  斜めグリッド配置
 *  ・「設定」→「斜めグリッド配置」で角度を決めると、その角度に傾いた格子（横方向）にブロックを置ける
 *  ・都市の斜めの区画づくり用。角度は 0（通常）〜89.5 度
 *  ・置いたブロックは保存され（この端末）、マルチプレイでは相手にも届く
 *  ・当たり判定はない（歩けてしまう）。見た目と配置のためのもの
 * 読み込み順： … fx → diag → players → ui
 */
(function () {
'use strict';
// ext.js の内部の名前を、window.VoxelExt から受け取る（ext.js は外から見えないため）
const { CUSTOM_BASE, ext, defRT, tiltList, addTilt, removeTilt, pickTarget, pushHistory, isTool } = window.VoxelExt;

const KEY = 'voxelcraft_diag_v1';
const DEG_KEY = 'voxelcraft_diag_deg';
const recs = new Map();     // キー -> 記録 { key, id, h, a, i, j, k, st, ts, ent }
const waiting = [];         // 定義がまだ届いていない記録
let deg = 0;
try { deg = Math.min(89.5, Math.max(0, Number(localStorage.getItem(DEG_KEY)) || 0)); } catch (e) {}

// ============================================================
// 1. 格子の計算（原点は世界の中心。角度ごとに傾いた格子）
// ============================================================
const UP = new THREE.Vector3(0, 1, 0);
function frame(a) {
  const t = a * Math.PI / 180;
  return {
    u: new THREE.Vector3(Math.cos(t), 0, Math.sin(t)),     // 格子の横方向
    v: new THREE.Vector3(-Math.sin(t), 0, Math.cos(t)),    // 格子の奥行き方向
    q: new THREE.Quaternion().setFromAxisAngle(UP, -t)     // ブロックの向き（格子に合わせる）
  };
}
function cellOf(p, a) {
  const F = frame(a);
  return { i: Math.floor(p.dot(F.u)), j: Math.floor(p.dot(F.v)), k: Math.floor(p.y) };
}
function centerOf(c, a) {
  const F = frame(a);
  return new THREE.Vector3()
    .addScaledVector(F.u, c.i + 0.5)
    .addScaledVector(F.v, c.j + 0.5)
    .add(new THREE.Vector3(0, c.k + 0.5, 0));
}
function keyFor(a, c) { return Number(a).toFixed(2) + '|' + c.i + ',' + c.j + ',' + c.k; }

// ============================================================
// 2. 画面に出す・消す
// ============================================================
function addVisual(r) {
  const F = frame(r.a);
  const cc = centerOf(r, r.a);
  if (!addTilt(r.id, [cc.x, cc.y, cc.z], F.q, r.st)) return false;
  const ent = tiltList[tiltList.length - 1];
  ent.diag = r.key;
  r.ent = ent;
  return true;
}
function removeVisual(r) {
  if (r.ent) removeTilt(r.ent);
  r.ent = null;
}
// 置けるかどうか（定義がまだなら false）
function resolveId(r) {
  const id = r.h ? VoxelCustom.localIdFor(r.h) : r.id;
  if (id == null) return false;
  if (id >= CUSTOM_BASE) {
    const rt = defRT.get(id);
    if (!rt || !rt.ready) return false;
  }
  r.id = id;
  return true;
}
function tryVisual(r) {
  if (!resolveId(r)) return false;
  return addVisual(r);
}

// ============================================================
// 3. 保存と通信
// ============================================================
function writeStore(key, json) {
  try { localStorage.setItem(key, json); } catch (e) {}
  VoxelExt.blobPut('idb:' + key, json).catch(e => console.error('保存できませんでした', e));
}
async function readStore(key) {
  let json = null;
  try { json = await VoxelExt.blobGet('idb:' + key); } catch (e) {}
  if (!json) json = localStorage.getItem(key);
  return json;
}
let diagLoaded = false;
// この端末だけの斜めブロック（保存する）。部屋にいる間は部屋の記録だけを画面に出し、この端末のものは隠す（傾きブロックと同じ考え方）
const locRecs = new Map();
const dgTombs = new Map();    // 部屋で壊したもの key -> { ts, room }（部屋に届くまで送り続ける）
let dgScope = null;
function save() {
  if (!diagLoaded) return;
  const list = [...locRecs.values()].map(r => ({ key: r.key, id: r.id, h: r.h, a: r.a, i: r.i, j: r.j, k: r.k, st: r.st, ts: r.ts }));
  writeStore(KEY, JSON.stringify(list));
}
function dgSig(o) { return JSON.stringify([o.h || null, o.h ? null : (o.id ?? null), o.a, o.i, o.j, o.k, o.st || null]); }
function sendRec(r) {
  const v = { a: r.a, i: r.i, j: r.j, k: r.k, st: r.st, ts: r.ts };
  if (r.h) v.h = r.h; else v.id = r.id;
  VoxelMulti.send('dg:' + r.key, v);
}
function sendTomb(key) { VoxelMulti.send('dg:' + key, undefined, true); }
function dgScopeNow() { return VoxelMulti.roomId() || 'local'; }
function showRec(r) { recs.set(r.key, r); if (!tryVisual(r)) waiting.push(r); }
function dgSwitchScope(s) {
  for (const r of [...recs.values()]) if (r.src !== s) { removeVisual(r); recs.delete(r.key); }
  dgScope = s;
  if (s === 'local') for (const r of locRecs.values()) if (!recs.has(r.key)) showRec(r);
}
// 部屋の記録を一つ反映する（新しい方が勝つ。部屋で壊したものは、相手が後から置き直すまで戻さない）
function dgLog(t) { try { if (window.VoxelDebug) VoxelDebug.log('斜め・0.5マス', t); } catch (e) {} }
function dgApply(key, val, s) {
  const t = dgTombs.get(key);
  if (t) { if (!val.del && (val.ts || 0) > t.ts) dgTombs.delete(key); else return; }
  const cur = recs.get(key);
  if (val.del) {
    if (cur && cur.src === s && cur.ts <= (val.ts || 0)) { removeVisual(cur); recs.delete(key); dgLog('消す ' + key.slice(0, 24)); }
    return;
  }
  const v = val.v || {};
  if (cur && cur.src === s) {
    if (cur.ts >= (val.ts || 0)) return;
    if (cur.sig === dgSig(v)) { cur.ts = val.ts || 0; return; }      // 中身が同じなら描き直さない
  }
  if (cur) { removeVisual(cur); recs.delete(key); }
  dgLog('受け取り ' + key.slice(0, 24) + '（' + (v.h ? '自作ブロック' : '標準ブロック ' + v.id) + '）');
  showRec({ key, id: v.id, h: v.h || null, a: Number(v.a), i: v.i, j: v.j, k: v.k, st: v.st || null, ts: val.ts || 0, src: s, sig: dgSig(v) });
}
// 部屋の記録と食い違うものを直す：部屋の記録（kv）を正とする
function dgSync() {
  if (!diagLoaded) return;
  const s = dgScopeNow();
  if (s !== dgScope) dgSwitchScope(s);
  if (s === 'local' || !VoxelMulti.connected()) return;
  const kv = VoxelNet.kv();
  if (!kv) return;
  for (const [k, val] of kv) if (k.startsWith('dg:')) dgApply(k.slice(3), val, s);
  // 部屋に無いもの：この端末で置いたものは送り直す。それ以外（部屋で壊された）は消す
  for (const r of [...recs.values()]) {
    if (r.src !== s || kv.has('dg:' + r.key)) continue;
    if (r.own) sendRec(r); else { removeVisual(r); recs.delete(r.key); }
  }
  // 壊したものが部屋に届いていなければ、届くまで送り続ける
  for (const [key, t] of [...dgTombs]) {
    if (t.room !== s) { dgTombs.delete(key); continue; }
    const e = kv.get('dg:' + key);
    if (e && (e.del || (e.ts || 0) > t.ts)) { dgTombs.delete(key); continue; }
    sendTomb(key);
  }
}

// ============================================================
// 4. 置く・壊す
// ============================================================
// 置く角度：斜めのブロックに当てたら、そのブロックの角度に吸着する。それ以外は設定の角度
function angleFor(p) {
  if (p && p.kind === 'tilt' && p.ent && p.ent.diag) {
    const r = recs.get(p.ent.diag);
    if (r) return r.a;
  }
  return deg;
}
function placeDiag(id, a) {
  const p = pickTarget();
  if (!p) return;
  const q = p.point.clone().addScaledVector(p.normal, 0.5);
  const c = cellOf(q, a);
  const key = keyFor(a, c);
  if (recs.has(key)) { toast('ここにはもうブロックがあります'); return; }
  const cc = centerOf(c, a);
  if (getBlock(Math.floor(cc.x), Math.floor(cc.y), Math.floor(cc.z)) !== AIR &&
      getBlock(Math.floor(cc.x), Math.floor(cc.y), Math.floor(cc.z)) !== WATER) {
    toast('通常のブロックがあるため置けません'); return;
  }
  const pp = player.pos;
  if (Math.abs(cc.x - pp.x) < 0.9 && Math.abs(cc.z - pp.z) < 0.9 && cc.y + 0.5 > pp.y && cc.y - 0.5 < pp.y + 1.8) {
    toast('自分の位置には置けません'); return;
  }
  const rt = id >= CUSTOM_BASE ? defRT.get(id) : null;
  if (id >= CUSTOM_BASE && (!rt || !rt.ready)) return;
  const r = {
    key, id, a, i: c.i, j: c.j, k: c.k, ts: (window.VoxelNet ? VoxelNet.nowTs() : Date.now()),
    st: rt ? { color: rt.def.colorable ? ext.curColor : null, rot: ext.rot } : null,
    h: rt ? VoxelCustom.publishDef(rt.def) : null
  };
  if (!addVisual(r)) { toast('このブロックは斜めには置けません'); return; }
  r.src = dgScopeNow();
  r.own = r.src !== 'local';
  r.sig = dgSig(r);
  recs.set(key, r);
  if (r.src === 'local') { locRecs.set(key, r); save(); }
  else sendRec(r);          // 通信が切れていたら、つながった時に dgSync が送り直す
  if (rt && rt.def.colorable && typeof pushHistory === 'function') pushHistory(ext.curColor);
  playPlace(id);
}
function removeDiag(r) {
  removeVisual(r);
  recs.delete(r.key);
  if (r.src === 'local') { locRecs.delete(r.key); save(); }
  else { dgTombs.set(r.key, { ts: VoxelNet.nowTs(), room: r.src }); sendTomb(r.key); }
  playBreak(r.id);
}

const prevPlace = window.doPlace;
// 斜めグリッドで置くか（斜めのブロックに当てた・設定の角度が0以外）
function diagPlan(p) {
  if (p && p.kind === 'tilt' && p.ent && p.ent.diag) return angleFor(p);
  if (deg) return deg;
  return null;
}
window.doPlace = function () {
  const id = HOTBAR[selIdx];
  const p = isTool(id) ? null : pickTarget();
  const a = p ? diagPlan(p) : null;
  if (a !== null) { placeDiag(id, a); return; }
  const before = tiltList.length;
  const res = prevPlace();
  for (let i = before; i < tiltList.length; i++) tlAdopt(tiltList[i]);
  return res;
};

// 置く前のプレビュー（斜めの角度・格子に合わせて表示する）
VoxelExt.setPlaceHook((p, id) => {
  if (isTool(id)) return null;
  const a = diagPlan(p);
  if (a === null) return null;
  const q = p.point.clone().addScaledVector(p.normal, 0.5);
  const c = cellOf(q, a);
  const cc = centerOf(c, a);
  const F = frame(a);
  const rt = id >= CUSTOM_BASE ? defRT.get(id) : null;
  const isModel = !!(rt && rt.def.kind === 'model');
  const off = isModel ? new THREE.Vector3(0, -0.5, 0).applyQuaternion(F.q) : new THREE.Vector3();
  const pos = cc.clone().add(off);
  const pp = player.pos;
  const blocked = recs.has(keyFor(a, c)) || isSolidAt3(cc) ||
    (Math.abs(cc.x - pp.x) < 0.9 && Math.abs(cc.z - pp.z) < 0.9 && cc.y + 0.5 > pp.y && cc.y - 0.5 < pp.y + 1.8);
  return { pos, q: F.q, valid: !blocked };
});
function isSolidAt3(v) {
  const x = Math.floor(v.x), y = Math.floor(v.y), z = Math.floor(v.z);
  const b = getBlock(x, y, z);
  return b !== AIR && b !== WATER;
}
const prevBreak = window.doBreak;
window.doBreak = function () {
  let p = null;
  try { p = pickTarget(); } catch (e) { p = null; }
  if (p && p.kind === 'tilt' && p.ent && p.ent.diag) {
    const r = recs.get(p.ent.diag);
    if (r) { removeDiag(r); return; }
  }
  if (p && p.kind === 'tilt' && p.ent && p.ent.tl) {
    const id = p.ent.id;
    tlRemove(p.ent.tl, true);
    if (typeof playBreak === 'function') playBreak(id);
    return;
  }
  return prevBreak();
};

// ============================================================
// 5. 相手の置いた斜めブロック
// ============================================================
VoxelMulti.onOp('dg', rec => {
  const s = dgScopeNow();
  if (s === 'local') return;
  dgApply(String(rec.key).slice(3), { v: rec.v, del: !!rec.del, ts: rec.ts || 0 }, s);
});

function retryWaiting() {
  for (let n = waiting.length - 1; n >= 0; n--) {
    const r = waiting[n];
    if (recs.get(r.key) !== r) { waiting.splice(n, 1); continue; }
    if (tryVisual(r)) waiting.splice(n, 1);
  }
}
VoxelCustom.onAdopt(retryWaiting);
setInterval(retryWaiting, 1000);

// ============================================================
// 6. 起動（保存していた斜めブロックを、画面に戻す）
// ============================================================
(async function loadDiagStore() {
  let list;
  try { list = JSON.parse((await readStore(KEY)) || '[]'); }
  catch (e) { console.error('斜めブロックの保存データを読めませんでした', e); return; }   // 読めないときは上書きしない
  for (const r of list) {
    if (!r || typeof r.key !== 'string' || locRecs.has(r.key)) continue;
    r.src = 'local';
    locRecs.set(r.key, r);
  }
  diagLoaded = true;
  dgSync();
})();

// ============================================================
// 6b. グリッド（0.5マスなど）で傾けて置いたブロックの保存と通信
//  ・この端末（ローカル）と、部屋（マルチ）で別々に覚える。部屋に入ると部屋のものを、出るとローカルのものを出す
// ============================================================
const TL_KEY = 'voxelcraft_tilt_v1';
const tlRecs = new Map();     // キー -> 記録 { key, id, h, c, q, st, ts, src, ent }
const tlWaiting = [];         // 定義がまだ届いていない記録
let tlScope = null;
function tlNewKey() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function tlScopeNow() { return VoxelMulti.roomId() || 'local'; }
function tlStrip(r) { return { key: r.key, id: r.id, h: r.h, c: r.c, q: r.q, st: r.st, ts: r.ts }; }
let tlLocalReady = false;
function tlSaveLocal() {
  if (!tlLocalReady) return;
  writeStore(TL_KEY, JSON.stringify([...tlRecs.values()].filter(r => r.src === 'local').map(tlStrip)));
}
function tlAddVisual(r) {
  const id = r.h ? VoxelCustom.localIdFor(r.h) : r.id;
  if (id == null) return false;
  if (id >= CUSTOM_BASE) {
    const rt = defRT.get(id);
    if (!rt || !rt.ready) return false;
  }
  const q = new THREE.Quaternion(r.q[0], r.q[1], r.q[2], r.q[3]);
  if (!addTilt(id, r.c, q, r.st)) return false;
  const ent = tiltList[tiltList.length - 1];
  ent.tl = r.key;
  r.ent = ent;
  r.id = id;
  return true;
}
function tlDropRec(r) {
  if (r.ent) removeTilt(r.ent);
  r.ent = null;
  tlRecs.delete(r.key);
}
const tlTombs = new Map();     // 部屋で壊したもの key -> { ts, room }（部屋に届くまで送り続ける）
function tlSig(o) { return JSON.stringify([o.h || null, o.h ? null : (o.id ?? null), o.c, o.q, o.st || null]); }
function tlRemove(key, notify) {
  const r = tlRecs.get(key);
  if (!r) return;
  const wasLocal = r.src === 'local';
  tlDropRec(r);
  if (wasLocal) tlSaveLocal();
  else if (notify) { tlTombs.set(key, { ts: VoxelNet.nowTs(), room: r.src }); VoxelMulti.send('tl:' + key, undefined, true); }
}
// 部屋の記録を一つ反映する（新しい方が勝つ。部屋で壊したものは、相手が後から置き直すまで戻さない）
function tlApply(key, val, s) {
  const t = tlTombs.get(key);
  if (t) { if (!val.del && (val.ts || 0) > t.ts) tlTombs.delete(key); else return; }
  const cur = tlRecs.get(key);
  if (val.del) { if (cur && cur.src === s && (cur.ts || 0) <= (val.ts || 0)) tlDropRec(cur); return; }
  const v = val.v || {};
  if (!Array.isArray(v.c) || !Array.isArray(v.q)) return;
  if (cur && cur.src === s) {
    if ((cur.ts || 0) >= (val.ts || 0)) return;
    if (cur.sig === tlSig(v)) { cur.ts = val.ts || 0; return; }      // 中身が同じなら描き直さない
  }
  if (cur) tlDropRec(cur);
  dgLog('傾き 受け取り ' + key.slice(0, 24));
  const r = { key, id: v.id, h: v.h || null, c: v.c, q: v.q, st: v.st || null, ts: val.ts || v.ts || 0, src: s, ent: null, sig: tlSig(v) };
  tlRecs.set(key, r);
  if (!tlAddVisual(r)) tlWaiting.push(r);
}
// 部屋の記録と食い違うものを直す（通信が切れていた間の置く・壊すを、つながった時に届ける）
function tlSync() {
  const s = tlScopeNow();
  if (s === 'local' || !VoxelMulti.connected()) return;
  const kv = VoxelNet.kv();
  if (!kv) return;
  for (const [k, val] of kv) if (k.startsWith('tl:')) tlApply(k.slice(3), val, s);
  for (const r of [...tlRecs.values()]) {
    if (r.src !== s || kv.has('tl:' + r.key)) continue;
    if (r.own) VoxelMulti.send('tl:' + r.key, tlStrip(r)); else tlDropRec(r);
  }
  for (const [key, t] of [...tlTombs]) {
    if (t.room !== s) { tlTombs.delete(key); continue; }
    const e = kv.get('tl:' + key);
    if (e && (e.del || (e.ts || 0) > t.ts)) { tlTombs.delete(key); continue; }
    VoxelMulti.send('tl:' + key, undefined, true);
  }
}
// 傾けて置いたブロック（ext の傾き配置）を記録し、部屋にも送る
function tlAdopt(ent) {
  if (ent.diag || ent.tl) return;
  const rt = ent.id >= CUSTOM_BASE ? defRT.get(ent.id) : null;
  const scope = tlScopeNow();
  const r = {
    key: tlNewKey(), id: ent.id, h: rt && rt.def ? VoxelCustom.publishDef(rt.def) : null,
    c: [ent.c[0], ent.c[1], ent.c[2]], q: [ent.q.x, ent.q.y, ent.q.z, ent.q.w],
    st: ent.st || null, ts: (window.VoxelNet ? VoxelNet.nowTs() : Date.now()), src: scope
  };
  ent.tl = r.key;
  r.ent = ent;
  r.sig = tlSig(r);
  tlRecs.set(r.key, r);
  if (scope === 'local') tlSaveLocal();
  else {
    r.own = true; r.room = scope;                     // 通信が切れていたら、つながった時に tlSync が送り直す
    VoxelMulti.send('tl:' + r.key, tlStrip(r));
  }
}
// 通信が切れている間に置いた・壊したものも、つながった時に部屋へ届くよう、1秒ごとに部屋の記録と照らし合わせる
setInterval(dgSync, 1000);
async function tlLoadLocal() {
  tlLocalReady = false;
  let list;
  try { list = JSON.parse((await readStore(TL_KEY)) || '[]'); }
  catch (e) { console.error('傾きブロックの保存データを読めませんでした', e); return; }
  for (const v of list) {
    if (!v || typeof v.key !== 'string' || tlRecs.has(v.key)) continue;
    const r = { ...v, src: 'local', ent: null };
    tlRecs.set(r.key, r);
    if (!tlAddVisual(r)) tlWaiting.push(r);
  }
  tlLocalReady = true;
}
function tlSwitchScope(s) {
  for (const r of [...tlRecs.values()]) if (r.src !== s) tlDropRec(r);
  tlScope = s;
  if (s === 'local') tlLoadLocal();
}
function tlRetry() {
  for (let n = tlWaiting.length - 1; n >= 0; n--) {
    const r = tlWaiting[n];
    if (tlRecs.get(r.key) !== r) { tlWaiting.splice(n, 1); continue; }
    if (tlAddVisual(r)) tlWaiting.splice(n, 1);
  }
}
// 相手の置いたもの（部屋の保存データを読み込んだときも、ここに届く）
VoxelMulti.onOp('tl', rec => {
  const s = tlScopeNow();
  if (s === 'local') return;
  tlApply(String(rec.key).slice(3), { v: rec.v, del: !!rec.del, ts: rec.ts || 0 }, s);
});
setInterval(tlSync, 1000);
VoxelCustom.onAdopt(tlRetry);
setInterval(() => {
  const s = tlScopeNow();
  if (s !== tlScope) tlSwitchScope(s);
  tlRetry();
}, 500);
// 新しい世界を作ったときは、この端末のローカルの傾きブロックも消す
window.addEventListener('voxelworld:fresh', () => {
  if (tlScopeNow() !== 'local') return;
  for (const r of [...tlRecs.values()]) if (r.src === 'local') tlDropRec(r);
  tlLocalReady = true;
  writeStore(TL_KEY, '[]');
});

// ============================================================
// 7. 設定画面の項目（角度）
// ============================================================
function setDeg(v) {
  deg = Math.min(89.5, Math.max(0, Number(v) || 0));
  try { localStorage.setItem(DEG_KEY, String(deg)); } catch (e) {}
  const inp = document.getElementById('diagDeg');
  if (inp) inp.value = String(deg);
}
function addSection() {
  const sbox = document.querySelector('#settings .sbox');
  const closeBtn = document.getElementById('settingsClose');
  if (!sbox || !closeBtn) return;
  const sec = document.createElement('div');
  sec.innerHTML = `
    <h3>斜めグリッド配置</h3>
    <label style="display:block;margin-top:6px">角度（度）
      <input class="ext-input" id="diagDeg" type="number" min="0" max="89.5" step="0.5" style="width:100px;margin-left:6px">
    </label>
    <div class="ext-row" style="margin-top:6px">
      <button class="ext-btn sub" data-d="0">0°（通常）</button>
      <button class="ext-btn sub" data-d="15">15°</button>
      <button class="ext-btn sub" data-d="30">30°</button>
      <button class="ext-btn sub" data-d="45">45°</button>
    </div>
    <p class="note">0°以外にすると、ブロックは選んだ角度に傾いた格子に置かれます（都市の斜めの区画向け）。当たり判定はなく、歩けてしまいます。置いたブロックは保存され、マルチプレイでは相手にも届きます。</p>`;
  sbox.insertBefore(sec, closeBtn);
  const inp = document.getElementById('diagDeg');
  inp.value = String(deg);
  inp.addEventListener('change', () => setDeg(inp.value));
  sec.querySelectorAll('[data-d]').forEach(b => b.addEventListener('click', () => setDeg(b.getAttribute('data-d'))));
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addSection);
else addSection();

window.VoxelDiag = {
  angle: () => deg, setAngle: setDeg, count: () => recs.size,
  adoptTilt: ent => tlAdopt(ent),                                  // 貼り付けた傾きブロックを記録して部屋へ送る
  dropTilt: ent => { if (ent.tl) tlRemove(ent.tl, true); else removeTilt(ent); }   // 元に戻す用
};
})();
