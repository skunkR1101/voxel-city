/* voxel-craft-players.js (v1)  他のプレイヤーの表示
 *  ・ゲーマータグ：頭の上に表示。ブロックなどで隠れているときは表示しない（何語でもOK）
 *  ・スキン：標準の人型も、読み込んだカスタムモデル（OBJ / FBX）＋テクスチャも、他のプレイヤーに反映
 *  ・参加・退出の通知（黄色い文字でチャットに表示）
 *  ・チャット：PCは T または Enter キー、スマホは「💬」ボタン
 * 読み込み順： … save → multi → players → ui
 */
(function () {
'use strict';
if (!window.VoxelMulti) { console.warn('voxel-craft-multi.js が先に必要です'); return; }

const PEER = VoxelMulti.peer;
const PRESENCE_MS = 2000;       // 自分の位置・名前を知らせる間隔
const STALE_MS = 15000;         // この時間、連絡がなければ退出とみなす
const CHUNK = 48000;            // スキンのデータを分けて送る大きさ（文字数）
const CHAT_KEEP_MS = 20000;     // 古いチャットは表示しない（参加時の履歴を出さないため）
const TAG_Y = 2.2;              // 名前の表示の高さ（足元から）
const SYS_COLOR = '#ffe066';    // 通知の色（黄色）

// ============================================================
// 自分のスキン（送信用）
// ============================================================
let curModel = null;            // { kind:'obj'|'fbx', text }
let curTex = null;              // dataURL
let myPayload = null;           // 送る中身 { kind, text, tex }
let mySkin = null;              // 公開中の情報 { id, kind, mN, tN }（null は標準の人型）
let publishedRoom = null;       // スキンを送った部屋ID

function splitStr(s) {
  const out = [];
  for (let i = 0; i < s.length; i += CHUNK) out.push(s.slice(i, i + CHUNK));
  return out;
}
function publishSkin() {
  if (!VoxelMulti.connected()) return;
  publishedRoom = VoxelMulti.roomId();
  if (!myPayload) { mySkin = null; return; }
  const id = Math.random().toString(36).slice(2, 8);
  const mParts = splitStr(myPayload.text || '');
  const tParts = myPayload.tex ? splitStr(myPayload.tex) : [];
  mParts.forEach((d, i) => VoxelMulti.send(`sk:${PEER}:${id}:m:${i}`, { d }));
  tParts.forEach((d, i) => VoxelMulti.send(`sk:${PEER}:${id}:t:${i}`, { d }));
  mySkin = { id, kind: myPayload.kind, mN: mParts.length, tN: tParts.length };
}
function rebuildPayload() {
  if (!curModel && !curTex) myPayload = null;
  else myPayload = { kind: curModel ? curModel.kind : 'default', text: curModel ? curModel.text : '', tex: curTex };
  saveMySkin();
  publishSkin();
}
// 自分のスキンを端末に保存（再読み込み・入り直しのあとも残す）
const MYSKIN_KEY = 'voxelcraft_myskin_v1';
function saveMySkin() {
  try {
    if (!curModel && !curTex) localStorage.removeItem(MYSKIN_KEY);
    else localStorage.setItem(MYSKIN_KEY, JSON.stringify({ model: curModel, tex: curTex }));
  } catch (e) { if (typeof toast === 'function') toast('スキンを保存できませんでした（画像やモデルが大きすぎます）'); }
}
function loadMySkin() {
  try {
    const s = JSON.parse(localStorage.getItem(MYSKIN_KEY) || 'null');
    if (!s) return;
    curModel = s.model || null;
    curTex = s.tex || null;
    myPayload = (!curModel && !curTex) ? null : { kind: curModel ? curModel.kind : 'default', text: curModel ? curModel.text : '', tex: curTex };
  } catch (e) {}
}
loadMySkin();
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
function bufToB64(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, u.subarray(i, i + CH));
  return btoa(s);
}
function b64ToBuf(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}

const modelEl = document.getElementById('modelFile');
const texEl = document.getElementById('texFile');
const resetEl = document.getElementById('skinReset');
if (modelEl) modelEl.addEventListener('change', async () => {
  const f = modelEl.files[0];
  curModel = null;
  if (f) {
    const ext = f.name.split('.').pop().toLowerCase();
    try {
      if (ext === 'obj') curModel = { kind: 'obj', text: await readAs(f, 'text') };
      else if (ext === 'fbx') curModel = { kind: 'fbx', text: bufToB64(await readAs(f, 'buf')) };
    } catch (e) { curModel = null; }
  }
  rebuildPayload();
});
if (texEl) texEl.addEventListener('change', async () => {
  const f = texEl.files[0];
  curTex = null;
  if (f) { try { curTex = await readAs(f, 'url'); } catch (e) { curTex = null; } }
  rebuildPayload();
});
if (resetEl) resetEl.addEventListener('click', () => { curModel = null; curTex = null; rebuildPayload(); });

// ============================================================
// 他のプレイヤーのスキン（受け取り・組み立て）
// ============================================================
const remotes = new Map();       // peer -> 表示用の情報
const chunkStore = new Map();    // "peer|id|m|t" -> Map(番号 -> データ)
const _v = new THREE.Vector3();

// 標準の人型（テクスチャがあれば貼る）。元の人型の作り方をそのまま使う
function defaultModel(tex) {
  const st = customTex;
  customTex = tex || null;
  try {
    const d = buildDefaultModel();
    applyMaterials(d.root);
    return { root: d.root, parts: d.parts };
  } finally { customTex = st; }
}
// 読み込んだカスタムモデルを人型に組み立てる（本体の処理を一時的に借りる）
function customModel(root, tex) {
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
function chunkAdd(rec) {
  const p = rec.key.split(':');          // sk : 送った人 : id : m|t : 番号
  if (p.length !== 5 || rec.del || !rec.v) return;
  const k = p[1] + '|' + p[2] + '|' + p[3];
  let m = chunkStore.get(k);
  if (!m) { m = new Map(); chunkStore.set(k, m); }
  m.set(Number(p[4]), rec.v.d);
  const r = remotes.get(p[1]);
  if (r) ensureSkin(r);
}
function joinChunks(peer, id, kind, n) {
  if (!n) return '';
  const m = chunkStore.get(peer + '|' + id + '|' + kind);
  if (!m) return null;
  let s = '';
  for (let i = 0; i < n; i++) {
    const d = m.get(i);
    if (d === undefined) return null;      // まだ届いていない部分がある
    s += d;
  }
  return s;
}
function applyModel(r, res, key) {
  while (r.group.children.length) r.group.remove(r.group.children[0]);
  r.group.add(res.root);
  r.parts = res.parts || {};
  r.skinKey = key;
}
function ensureSkin(r) {
  const sk = r.skin;
  const key = sk ? (sk.id + ':' + sk.kind + ':' + sk.mN + ':' + sk.tN) : 'default';
  if (r.skinKey === key) return;
  // テクスチャ（あれば）
  let tex = null;
  if (sk && sk.tN) {
    if (r.texId !== sk.id || !r.tex) {
      if (r.texLoading === sk.id) return;
      const td = joinChunks(r.peer, sk.id, 't', sk.tN);
      if (td === null) return;
      r.texLoading = sk.id;
      new THREE.TextureLoader().load(td, t => {
        t.magFilter = THREE.NearestFilter;
        t.minFilter = THREE.LinearFilter;
        t.generateMipmaps = false;
        r.tex = t; r.texId = sk.id; r.texLoading = null; r.skinKey = null;
        ensureSkin(r);
      }, undefined, () => { r.texLoading = null; });
      return;
    }
    tex = r.tex;
  }
  // 標準の人型（モデルなし）
  if (!sk || sk.kind === 'default' || !sk.mN) {
    applyModel(r, defaultModel(tex), key);
    return;
  }
  // カスタムモデル：全部届くまで、今の見た目のまま待つ
  const md = joinChunks(r.peer, sk.id, 'm', sk.mN);
  if (md === null) return;
  let root = null;
  try {
    if (sk.kind === 'fbx') {
      if (!THREE.FBXLoader) throw new Error('FBXLoader なし');
      root = new THREE.FBXLoader().parse(b64ToBuf(md), '');
    } else {
      if (!THREE.OBJLoader) throw new Error('OBJLoader なし');
      root = new THREE.OBJLoader().parse(md);
    }
  } catch (e) { console.error(e); root = null; }
  const res = root ? customModel(root, tex) : null;
  applyModel(r, res || defaultModel(tex), key);
}

// ============================================================
// 他のプレイヤーの表示
// ============================================================
function makeRemote(peer) {
  const group = new THREE.Group();
  scene.add(group);
  const el = document.createElement('div');
  el.className = 'vcTag';
  el.style.display = 'none';
  document.body.appendChild(el);
  const r = {
    peer, name: '', x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, yaw: 0, spd: 0, phase: 0, amp: 0,
    inited: false, prevT: 0, seen: Date.now(), group, el, parts: {}, skin: null, skinKey: null,
    tex: null, texId: null, texLoading: null, hidden: false
  };
  remotes.set(peer, r);
  ensureSkin(r);
  return r;
}
function removeRemote(peer, announce) {
  const r = remotes.get(peer);
  if (!r) return;
  scene.remove(r.group);
  r.el.remove();
  remotes.delete(peer);
  if (announce && r.name) addSys(`${r.name}が退出しました`);
}
function onPresence(rec) {
  const peer = rec.key.slice(3);
  if (!peer || peer === PEER) return;
  if (rec.del) { removeRemote(peer, true); return; }
  const v = rec.v || {};
  // 古い情報（参加時の履歴など）は無視する
  // 退出の判断は『最後に知らせが届いた時刻』で行う（端末の時計がずれていても、他の人が消えないように）
  if (!v.ts) return;
  let r = remotes.get(peer);
  const now = Date.now();
  if (!r) {
    r = makeRemote(peer);
    r.name = v.name || 'プレイヤー';
    r.el.textContent = r.name;
    if (!VoxelMulti.isJoining()) addSys(`${r.name}が参加しました`);
  }
  // 移動の速さ（次の動きの表示に使う）
  if (r.inited && r.prevT) {
    const dt = Math.max(0.2, (now - r.prevT) / 1000);
    r.spd = Math.hypot(v.x - r.tx, v.z - r.tz) / dt;
  }
  r.prevT = now;
  if (r.name !== (v.name || 'プレイヤー')) { r.name = v.name || 'プレイヤー'; r.el.textContent = r.name; }
  r.tx = Number(v.x) || 0; r.ty = Number(v.y) || 0; r.tz = Number(v.z) || 0;
  r.yaw = Number(v.yaw) || 0;
  if (!r.inited) { r.x = r.tx; r.y = r.ty; r.z = r.tz; r.inited = true; }
  r.seen = now;
  const sk = v.skin || null;
  if (JSON.stringify(sk) !== JSON.stringify(r.skin)) r.skin = sk;
  ensureSkin(r);
}

// ============================================================
// チャットと通知
// ============================================================
let logEl = null, barEl = null, inputEl = null, toggleEl = null;
let chatOpen = false;

function addLine(text, color, bold) {
  if (!logEl) return;
  const line = document.createElement('div');
  line.textContent = text;
  line.style.color = color;
  if (bold) line.style.fontWeight = 'bold';
  logEl.appendChild(line);
  while (logEl.children.length > 14) logEl.removeChild(logEl.firstChild);
  setTimeout(() => line.remove(), 60000);
}
function addSys(text) { addLine(text, SYS_COLOR, true); }
function addChatLine(name, text) { addLine(`${name}：${text}`, '#ffffff', false); }
function myName() { return VoxelMulti.tag() || 'プレイヤー'; }

const shown = new Set();   // 表示済みのチャットのキー（重複防止）
function onChat(rec) {
  if (rec.del || !rec.v || shown.has(rec.key)) return;
  const v = rec.v;
  if (!v.ts || Date.now() - v.ts > CHAT_KEEP_MS) return;
  shown.add(rec.key);
  addChatLine(String(v.name || 'プレイヤー').slice(0, 30), String(v.text || '').slice(0, 200));
}
function sendChat() {
  const text = inputEl.value.trim().slice(0, 200);
  inputEl.value = '';
  if (!text) return;
  if (!VoxelMulti.connected()) { addSys('部屋に参加するとチャットできます'); return; }
  const key = `chat:${Date.now()}-${PEER}`;
  const v = { name: myName(), text, ts: (window.VoxelNet ? VoxelNet.nowTs() : Date.now()) };
  shown.add(key);
  addChatLine(v.name, text);
  VoxelMulti.send(key, v);
}
function openChat() {
  if (!VoxelMulti.connected()) { addSys('部屋に参加するとチャットできます'); return; }
  chatOpen = true;
  barEl.style.display = 'flex';
  inputEl.focus();
  if (document.pointerLockElement) document.exitPointerLock();
}
function closeChat() {
  chatOpen = false;
  barEl.style.display = 'none';
  inputEl.blur();
}

function buildChatUI() {
  const style = document.createElement('style');
  style.textContent = `
  .vcTag{position:fixed;transform:translate(-50%,-100%);background:rgba(0,0,0,.55);color:#fff;padding:2px 7px;
    border-radius:6px;font:12px sans-serif;pointer-events:none;white-space:nowrap;z-index:4;max-width:45vw;overflow:hidden;text-overflow:ellipsis}
  #vcChatLog{position:fixed;left:8px;top:150px;width:min(70vw,340px);max-height:32vh;overflow:hidden;z-index:4;
    pointer-events:none;font:13px/1.5 sans-serif;text-shadow:0 1px 2px #000,0 0 3px #000;display:flex;flex-direction:column;justify-content:flex-end}
  #vcChatBar{position:fixed;left:50%;bottom:8px;transform:translateX(-50%);width:min(94vw,560px);z-index:80;
    display:none;gap:6px;background:rgba(10,16,24,.9);padding:8px;border-radius:10px;box-sizing:border-box}
  #vcChatBar input{flex:1;min-width:0;background:#1f2b38;color:#fff;border:1px solid rgba(255,255,255,.35);
    border-radius:6px;padding:9px;font-size:16px}
  #vcChatBar button{background:#2e6a9a;color:#fff;border:none;border-radius:6px;padding:0 14px;font-size:14px}
  #vcChatToggle{position:fixed;left:80px;top:56px;z-index:60;background:#2e6a9a;color:#fff;border:none;border-radius:8px;
    padding:8px 12px;font-size:13px;opacity:.9;cursor:pointer;font-family:sans-serif}
  `;
  document.head.appendChild(style);

  logEl = document.createElement('div');
  logEl.id = 'vcChatLog';
  document.body.appendChild(logEl);

  barEl = document.createElement('div');
  barEl.id = 'vcChatBar';
  barEl.innerHTML = '<input id="vcChatInput" maxlength="200" placeholder="メッセージを入力（Enterで送信）" autocomplete="off"><button id="vcChatSend">送信</button><button id="vcChatClose" style="background:#3a4450">閉じる</button>';
  document.body.appendChild(barEl);
  inputEl = document.getElementById('vcChatInput');

  // 入力中は、ゲームの操作キー（WASDなど）に反応させない
  for (const type of ['keydown', 'keyup', 'keypress']) {
    inputEl.addEventListener(type, e => {
      e.stopPropagation();
      if (type === 'keydown' && e.key === 'Enter') { e.preventDefault(); sendChat(); }
      if (type === 'keydown' && e.key === 'Escape') { e.preventDefault(); closeChat(); }
    });
  }
  document.getElementById('vcChatSend').addEventListener('click', e => { e.stopPropagation(); sendChat(); });
  document.getElementById('vcChatClose').addEventListener('click', e => { e.stopPropagation(); closeChat(); });
  barEl.addEventListener('pointerdown', e => e.stopPropagation());

  toggleEl = document.createElement('button');
  toggleEl.id = 'vcChatToggle';
  toggleEl.textContent = '💬';
  toggleEl.addEventListener('click', e => { e.stopPropagation(); chatOpen ? closeChat() : openChat(); });
  document.body.appendChild(toggleEl);

  // PCのキー：T または Enter で開く
  window.addEventListener('keydown', e => {
    if (chatOpen || e.repeat) return;
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (typeof started !== 'undefined' && !started) return;
    if (e.code === 'KeyT' || e.code === 'Enter') { e.preventDefault(); openChat(); }
  });
}

// ============================================================
// 隠れているかどうか（ブロックが間にあるか）
// ============================================================
function occluded(fx, fy, fz, tx, ty, tz) {
  const dx = tx - fx, dy = ty - fy, dz = tz - fz;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 0.01) return false;
  const ux = dx / dist, uy = dy / dist, uz = dz / dist;
  const sx0 = Math.floor(fx), sy0 = Math.floor(fy), sz0 = Math.floor(fz);
  let x = sx0, y = sy0, z = sz0;
  const stepX = ux > 0 ? 1 : -1, stepY = uy > 0 ? 1 : -1, stepZ = uz > 0 ? 1 : -1;
  const tdX = ux !== 0 ? Math.abs(1 / ux) : Infinity;
  const tdY = uy !== 0 ? Math.abs(1 / uy) : Infinity;
  const tdZ = uz !== 0 ? Math.abs(1 / uz) : Infinity;
  let nX = ux > 0 ? (x + 1 - fx) * tdX : (fx - x) * tdX;
  let nY = uy > 0 ? (y + 1 - fy) * tdY : (fy - y) * tdY;
  let nZ = uz > 0 ? (z + 1 - fz) * tdZ : (fz - z) * tdZ;
  let t = 0, guard = 0;
  while (t < dist - 0.25 && guard++ < 500) {
    if (!(x === sx0 && y === sy0 && z === sz0) && isSolid(getBlock(x, y, z))) return true;
    if (nX < nY && nX < nZ) { t = nX; x += stepX; nX += tdX; }
    else if (nY < nZ) { t = nY; y += stepY; nY += tdY; }
    else { t = nZ; z += stepZ; nZ += tdZ; }
  }
  return false;
}
let lastScan = 0;
function scanOcclusion(now) {
  if (now - lastScan < 150) return;
  lastScan = now;
  const cp = camera.position;
  for (const r of remotes.values()) {
    if (!r.inited) continue;
    r.hidden = occluded(cp.x, cp.y, cp.z, r.x, r.y + 1.5, r.z);
  }
}
function placeTags() {
  for (const r of remotes.values()) {
    if (!r.inited) { r.el.style.display = 'none'; continue; }
    _v.set(r.x, r.y + TAG_Y, r.z);
    const dist = camera.position.distanceTo(_v);
    _v.project(camera);
    const sx = (_v.x + 1) / 2 * innerWidth;
    const sy = (1 - _v.y) / 2 * innerHeight;
    const show = !r.hidden && dist < 60 && _v.z < 1 && sx > -40 && sx < innerWidth + 40 && sy > -40 && sy < innerHeight + 40;
    r.el.style.display = show ? 'block' : 'none';
    if (show) { r.el.style.left = sx + 'px'; r.el.style.top = sy + 'px'; }
  }
}

// ============================================================
// 毎フレームの更新（動き・歩く動き・名前の表示）
// ============================================================
let lastFrame = performance.now();
let lastRoom = null;
let skinRoom = null;             // スキンを送った部屋（入り直すたびに送り直す）
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  // 部屋に入り直したら、前の部屋の人は消す（通知は出さない）
  const rid = VoxelMulti.roomId();
  if (rid !== lastRoom) {
    for (const p of [...remotes.keys()]) removeRemote(p, false);
    shown.clear();
    lastRoom = rid;
    skinRoom = null;
  }
  // 接続が完了してから、自分のスキンを送る（部屋に入るたびに一度だけ）
  if (rid && VoxelMulti.connected() && skinRoom !== rid) {
    skinRoom = rid;
    publishSkin();
    sendPresence();
  }

  for (const r of remotes.values()) {
    if (!r.inited) continue;
    const k = Math.min(1, dt * 10);
    r.x += (r.tx - r.x) * k;
    r.y += (r.ty - r.y) * k;
    r.z += (r.tz - r.z) * k;
    r.group.position.set(r.x, r.y, r.z);
    r.group.rotation.y = r.yaw;
    const moving = r.spd > 0.5;
    r.amp += ((moving ? 1 : 0) - r.amp) * Math.min(1, dt * 10);
    if (moving) r.phase += dt * r.spd * 2.2;
    const s = Math.sin(r.phase) * 0.8 * r.amp;
    if (r.parts.leftLeg) r.parts.leftLeg.rotation.x = s;
    if (r.parts.rightLeg) r.parts.rightLeg.rotation.x = -s;
    if (r.parts.leftArm) r.parts.leftArm.rotation.x = -s * 0.8;
    if (r.parts.rightArm) r.parts.rightArm.rotation.x = s * 0.8;
  }
  // 古い人を消す
  for (const r of [...remotes.values()]) {
    if (Date.now() - r.seen > STALE_MS) removeRemote(r.peer, true);
  }
  scanOcclusion(now);
  placeTags();
}

// ============================================================
// 自分の位置・名前を知らせる（2秒ごと）
// ============================================================
function sendPresence() {
  if (!VoxelMulti.connected() || typeof player === 'undefined') return;
  VoxelMulti.send(`pl:${PEER}`, {
    name: myName(),
    x: player.pos.x, y: player.pos.y, z: player.pos.z,
    yaw: player.yaw + (settings.flip ? Math.PI : 0),
    skin: mySkin,
    ts: Date.now()
  }, false, true);   // eph：記録に残さない一時情報
}

// ============================================================
// 起動
// ============================================================
VoxelMulti.onOp('pl', onPresence);
VoxelMulti.onOp('chat', onChat);
VoxelMulti.onOp('sk', chunkAdd);

buildChatUI();
// 動いているときは速めに、止まっているときはゆっくり送る（通信量を減らす）
let lastPos = null, movedAt = 0;
(function presenceLoop() {
  sendPresence();
  const moving = performance.now() - movedAt < 1000;
  setTimeout(presenceLoop, moving ? 250 : 2000);
})();
setInterval(() => {
  if (typeof player === "undefined") return;
  const p = player.pos;
  if (!lastPos || Math.abs(p.x - lastPos.x) + Math.abs(p.y - lastPos.y) + Math.abs(p.z - lastPos.z) > 0.01) movedAt = performance.now();
  lastPos = { x: p.x, y: p.y, z: p.z };
}, 100);
window.addEventListener('pagehide', () => {
  if (VoxelMulti.connected()) VoxelMulti.send(`pl:${PEER}`, undefined, true, true);
});
requestAnimationFrame(frame);

window.VoxelPlayers = {
  count: () => remotes.size,
  names: () => [...remotes.values()].map(r => r.name),
  openChat, closeChat,
  send: sendChat
};
})();
