/* voxel-rt-ui.js  マルチプレイの画面（第2段階）
 *  ・部屋に入る／作る（部屋ID・合言葉・ゲーマータグ）、招待リンク、退出
 *  ・チャット（全言語・記号。入退室のお知らせは黄色）
 *  ・名前の表示（頭の上。ブロックの後ろに隠れたら出さない）
 *  ・ロケーターバー（相手の方向を、ホットバーの上に色の点で表示）
 *  ・設定画面から、選んだプレイヤーのところへテレポート
 *  ・招待リンク（#vcjoin=…）を開くと、そのまま部屋に入る
 *  依存：voxel-rt-logic.js / voxel-rt-core.js / voxel-rt-transport.js（この順で読み込む）
 *  既存の画面（ホットバー・設定・プレイヤー情報 player、camera、getBlock、isSolid、boxCollides）を使う
 */
(function () {
'use strict';

const L = window.VoxelRTLogic;
const VR = window.VoxelRT;
const TR = window.VoxelRTTransport;
if (!L || !VR || !TR) { console.error('voxel-rt: 部品が読み込まれていません'); return; }

const NAME_KEY = 'vcrt_name_v1';
const ROOM_ID_RE = /^[A-Za-z0-9_-]{3,32}$/;
const PRESENCE_MS = 250;        // 動いているとき、位置を送る間隔
const HEARTBEAT_MS = 1000;      // 止まっているとき、生存の知らせを送る間隔
const STALE_MS = 40000;         // これより長く便りがない相手は、画面から消す（お知らせは出さない）
const QUIET_MS = 3000;          // 入った直後は、すでにいる人の「参加しました」を出さない
const CHAT_MAX = 200;           // チャット1行の長さ（文字）
const LOG_MAX = 80;
const STRIP_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');

let room = null, transport = null;
const roomListeners = [];       // 部屋に入った・出たときに知らせる先（世界の同期など）
function notifyRoom(rm) { for (const f of roomListeners) { try { f(rm); } catch (e) { console.error(e); } } }
let myName = L.DEFAULT_NAME;
let quietUntil = 0;
let lastRejectMsg = 0;
const remotes = new Map();      // peerId -> {name, x, y, z, yaw, last}
let sentPos = null, sentYaw = 0, sentAt = 0;

// ---------- 小さな部品 ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}
function readName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; }
}
function saveName(n) {
  try { localStorage.setItem(NAME_KEY, n); } catch (e) {}
}
function cleanText(s, max) {
  return Array.from(String(s == null ? '' : s).replace(STRIP_RE, '').trim()).slice(0, max).join('');
}

// ---------- 画面の部品（CSS） ----------
function injectCss() {
  const st = document.createElement('style');
  st.textContent =
    '#rtCard input{width:100%;box-sizing:border-box;background:#1f2b38;color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:6px;padding:9px;font-size:16px;margin-top:6px}' +
    '#rtCard .go{display:block;width:100%;background:#2e6a9a;color:#fff;border:none;border-radius:8px;padding:10px;font-size:14px;margin-top:8px;cursor:pointer}' +
    '#rtCard .go.sub{background:#3a4450}' +
    '#rtCard .go:disabled{opacity:.5}' +
    '#rtCard .m{font-size:12px;color:#9fb3c8;line-height:1.6;margin:6px 0 0}' +
    '#rtCard .tp{display:block;width:100%;text-align:left;background:#1f2b38;color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:6px;padding:8px;font-size:14px;margin-top:6px;cursor:pointer}' +
    '#rtChat{position:fixed;left:8px;bottom:110px;width:min(340px,46vw);z-index:40;pointer-events:none;font:14px/1.5 system-ui,sans-serif}' +
    '#rtChat .hd{pointer-events:auto;display:none;width:100%;text-align:left;background:rgba(0,0,0,.55);color:#fff;border:1px solid rgba(255,255,255,.35);border-radius:6px;padding:4px 8px;font-size:13px}' +
    '#rtChat.on .hd{display:block}' +
    '#rtChat.min .log,#rtChat.min form{display:none !important}' +
    '#rtChat .log{max-height:34vh;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;gap:2px}' +
    '#rtChat .ln{background:rgba(0,0,0,.45);color:#fff;border-radius:6px;padding:2px 8px;width:fit-content;max-width:100%;word-break:break-word;text-shadow:0 1px 2px #000}' +
    '#rtChat .ln.sys{color:#ffe600}' +
    '#rtChat form{display:none;pointer-events:auto;margin-top:6px}' +
    '#rtChat.on form{display:flex;gap:6px}' +
    '#rtChat.on .log{pointer-events:none}' +
    '#rtChat input{flex:1;min-width:0;background:rgba(0,0,0,.6);color:#fff;border:1px solid rgba(255,255,255,.4);border-radius:6px;padding:7px;font-size:16px}' +
    '#rtChat button{background:#2e6a9a;color:#fff;border:none;border-radius:6px;padding:0 12px;font-size:14px}' +
    '#rtLoc{position:fixed;left:50%;transform:translateX(-50%);width:min(560px,92vw);height:12px;z-index:30;pointer-events:none;display:none}' +
    '#rtLoc .bar{position:absolute;inset:0;background:rgba(0,0,0,.35);border-radius:6px;border:1px solid rgba(255,255,255,.35)}' +
    '#rtLoc .dot{position:absolute;top:50%;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;border:2px solid #fff;box-sizing:border-box}' +
    '#rtTags{position:fixed;inset:0;pointer-events:none;z-index:25;overflow:hidden}' +
    '#rtTags .tag{position:absolute;transform:translate(-50%,-100%);color:#fff;background:rgba(0,0,0,.45);border-radius:6px;padding:1px 6px;font:13px/1.4 system-ui,sans-serif;white-space:nowrap;text-shadow:0 1px 2px #000;display:none}';
  document.head.appendChild(st);
}

// ---------- チャットの画面 ----------
let chatBox, chatLog, chatForm, chatInput;
function buildChat() {
  chatBox = el('div'); chatBox.id = 'rtChat';
  const hd = el('button', 'hd', 'チャット ▾');
  hd.addEventListener('click', () => { const m = chatBox.classList.toggle('min'); hd.textContent = m ? 'チャット ▸' : 'チャット ▾'; });
  chatBox.appendChild(hd);
  chatLog = el('div', 'log'); chatBox.appendChild(chatLog);
  chatForm = el('form');
  chatInput = el('input');
  chatInput.type = 'text';
  chatInput.maxLength = CHAT_MAX;
  chatInput.placeholder = 'チャット（Enterで送信）';
  chatInput.autocomplete = 'off';
  // ゲームの操作（移動・視点）が、入力中の文字に反応しないようにする
  chatInput.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); sendChat(); } });
  chatInput.addEventListener('keyup', e => e.stopPropagation());
  chatInput.addEventListener('focus', () => { try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) {} });
  const send = el('button', '', '送信'); send.type = 'submit';
  chatForm.appendChild(chatInput); chatForm.appendChild(send);
  chatForm.addEventListener('submit', e => { e.preventDefault(); sendChat(); });
  chatBox.appendChild(chatForm);
  document.body.appendChild(chatBox);
}
function addLine(text, cls, nameColor, name) {
  if (!chatLog) return;
  const d = el('div', 'ln' + (cls ? ' ' + cls : ''));
  if (name != null) {
    const n = el('span', '', '<' + name + '> ');
    n.style.color = nameColor || '#fff';
    d.appendChild(n);
    d.appendChild(document.createTextNode(text));
  } else {
    d.textContent = text;
  }
  chatLog.appendChild(d);
  while (chatLog.childNodes.length > LOG_MAX) chatLog.removeChild(chatLog.firstChild);
}
function sysLine(text) { addLine(text, 'sys'); }
function setChatOn(on) { if (chatBox) chatBox.classList.toggle('on', !!on); }

function sendChat() {
  const t = cleanText(chatInput.value, CHAT_MAX);
  chatInput.value = '';
  if (!t || !room) return;
  room.ephemeral('chat:' + room.peerId, { n: myName, t });
  addLine(t, '', L.colorOf(myName), myName);
}

// ---------- 名前の表示・ロケーターバー ----------
let locBar = null, tagLayer = null;
const tagEls = new Map();
const dotEls = new Map();
function buildOverlays() {
  locBar = el('div'); locBar.id = 'rtLoc';
  locBar.appendChild(el('div', 'bar'));
  document.body.appendChild(locBar);
  tagLayer = el('div'); tagLayer.id = 'rtTags';
  document.body.appendChild(tagLayer);
}
function placeLocator() {
  if (!locBar) return;
  const hb = document.getElementById('hotbar');
  if (hb && chatBox) chatBox.style.bottom = Math.round(window.innerHeight - hb.getBoundingClientRect().top + 34) + 'px';
  const show = !!room && remotes.size > 0 && hb;
  locBar.style.display = show ? 'block' : 'none';
  if (!show) return;
  const r = hb.getBoundingClientRect();
  locBar.style.bottom = Math.round(window.innerHeight - r.top + 6) + 'px';
  const pl = player.pos;
  const me = { x: pl.x, z: pl.z };
  const seen = new Set();
  for (const [id, r2] of remotes) {
    const loc = L.locatorPos(me, { x: r2.x, z: r2.z }, player.yaw);
    let d = dotEls.get(id);
    if (!d) { d = el('div', 'dot'); d.title = r2.name; d.style.background = L.colorOf(id); locBar.appendChild(d); dotEls.set(id, d); }
    d.style.left = (loc.pos * 100).toFixed(1) + '%';
    d.style.opacity = loc.behind ? '0.35' : '1';
    seen.add(id);
  }
  for (const [id, d] of dotEls) if (!seen.has(id)) { d.remove(); dotEls.delete(id); }
}

// 頭の上の名前。カメラから見て、ブロックの後ろに隠れていたら出さない
function blocked(tx, ty, tz) {
  const c = camera.position;
  const dx = tx - c.x, dy = ty - c.y, dz = tz - c.z;
  const dist = Math.hypot(dx, dy, dz);
  const steps = Math.ceil(dist / 0.25);
  for (let i = 1; i < steps; i++) {
    const s = i / steps;
    const x = c.x + dx * s, y = c.y + dy * s, z = c.z + dz * s;
    if (dist * s < 0.6) continue;                          // 目の前（カメラのすぐそば）は無視
    if (isSolid(getBlock(Math.floor(x), Math.floor(y), Math.floor(z)))) return true;
  }
  return false;
}
function updateTags() {
  if (!tagLayer) return;
  const vw = window.innerWidth, vh = window.innerHeight;
  const seen = new Set();
  for (const [id, r] of remotes) {
    let t = tagEls.get(id);
    if (!t) { t = el('div', 'tag', r.name); tagLayer.appendChild(t); tagEls.set(id, t); }
    if (t.textContent !== r.name) t.textContent = r.name;
    seen.add(id);
    const hx = r.x, hy = r.y + 1.8 + 0.4, hz = r.z;
    const dx = hx - player.pos.x, dz = hz - player.pos.z;
    const v = new THREE.Vector3(hx, hy, hz).project(camera);
    const onScreen = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
    if (!room || !onScreen || Math.hypot(dx, dz) > 80 || blocked(hx, hy, hz)) { t.style.display = 'none'; continue; }
    t.style.display = 'block';
    t.style.left = ((v.x + 1) / 2 * vw).toFixed(0) + 'px';
    t.style.top = ((1 - v.y) / 2 * vh).toFixed(0) + 'px';
  }
  for (const [id, t] of tagEls) if (!seen.has(id)) { t.remove(); tagEls.delete(id); }
}

function clearOverlays() {
  for (const t of tagEls.values()) t.remove();
  tagEls.clear();
  for (const d of dotEls.values()) d.remove();
  dotEls.clear();
  if (locBar) locBar.style.display = "none";
}

// ---------- 設定画面（部屋の入口・テレポート） ----------
let card, statusEl, nameIn, roomIn, passIn, goBtn, copyBtn, leaveBtn, tpBox;
let tpKey = '';
function buildCard() {
  injectCss();
  card = el('div', 'card'); card.id = 'rtCard';
  card.appendChild(el('h2', '', 'オンライン（みんなで遊ぶ）'));
  statusEl = el('p', 'm', '未接続');
  card.appendChild(statusEl);

  card.appendChild(el('div', 'm', 'ゲーマータグ（16文字まで・どの文字も可）'));
  nameIn = el('input'); nameIn.type = 'text'; nameIn.placeholder = 'プレイヤー';
  nameIn.value = readName();
  card.appendChild(nameIn);

  card.appendChild(el('div', 'm', '部屋ID（英数字・-・_　3〜32文字）'));
  roomIn = el('input'); roomIn.type = 'text'; roomIn.autocomplete = 'off'; roomIn.autocapitalize = 'off';
  card.appendChild(roomIn);

  card.appendChild(el('div', 'm', '合言葉'));
  passIn = el('input'); passIn.type = 'text'; passIn.autocomplete = 'off'; passIn.autocapitalize = 'off';
  card.appendChild(passIn);

  goBtn = el('button', 'go', '部屋に入る（なければ作る）');
  goBtn.addEventListener('click', () => joinFromForm());
  card.appendChild(goBtn);

  copyBtn = el('button', 'go sub', '招待リンクをコピー');
  copyBtn.addEventListener('click', () => copyInvite());
  card.appendChild(copyBtn);

  leaveBtn = el('button', 'go sub', '退出する');
  leaveBtn.addEventListener('click', () => leaveRoom(true));
  card.appendChild(leaveBtn);

  card.appendChild(el('div', 'm', 'プレイヤーへテレポート'));
  tpBox = el('div'); card.appendChild(tpBox);
  card.appendChild(el('p', 'm', '合言葉は、信頼できる人にだけ伝えてください。招待リンクには合言葉が入っています。'));

  const host = document.querySelector('#settings .sbox') || document.getElementById('settings') || document.body;
  host.insertBefore(card, host.firstChild);
  updateButtons();
}
function setStatus(s) { if (statusEl) statusEl.textContent = s; }
function updateButtons() {
  const on = !!room;
  if (goBtn) goBtn.disabled = on;
  if (copyBtn) copyBtn.disabled = !on;
  if (leaveBtn) leaveBtn.disabled = !on;
}
function renderTeleport() {
  if (!tpBox) return;
  const key = Array.from(remotes, ([id, r]) => id + ':' + r.name).join('|');
  if (key === tpKey) return;
  tpKey = key;
  tpBox.textContent = '';
  if (remotes.size === 0) { tpBox.appendChild(el('p', 'm', '（ほかの人がいないと、ここに出ません）')); return; }
  for (const [id, r] of remotes) {
    const b = el('button', 'tp', r.name);
    b.addEventListener('click', () => teleportTo(id));
    tpBox.appendChild(b);
  }
}
function teleportTo(id) {
  const r = remotes.get(id);
  if (!r) return;
  const spots = [[2, 0], [-2, 0], [0, 2], [0, -2], [0, 0]];
  for (const [dx, dz] of spots) {
    for (const dy of [0, 1, 2]) {
      const x = r.x + dx, y = r.y + dy, z = r.z + dz;
      if (!boxCollides(x, y, z)) { player.pos.set(x, y, z); player.vel.set(0, 0, 0); sysLine(r.name + 'のところへ移動しました'); return; }
    }
  }
  player.pos.set(r.x, r.y + 3, r.z); player.vel.set(0, 0, 0);
  sysLine(r.name + 'のところへ移動しました');
}

// ---------- 入る・出る ----------
function currentName() { return cleanText(nameIn.value, L.NAME_MAX) || L.DEFAULT_NAME; }

async function joinFromForm() {
  const roomId = roomIn.value.trim();
  const password = passIn.value;
  if (!ROOM_ID_RE.test(roomId)) { setStatus('部屋IDは、英数字・-・_ で3〜32文字にしてください'); return; }
  if (!password || password.length > 64) { setStatus('合言葉を入れてください（64文字まで）'); return; }
  await joinRoom(roomId, password, currentName());
}

async function joinRoom(roomId, password, name) {
  if (room) leaveRoom(false);
  myName = L.sanitizeName(name);
  saveName(myName);
  nameIn.value = myName;
  remotes.clear();
  const tp = TR.createTransport();
  const rm = VR.create({ roomId, password, name: myName, transport: tp });
  transport = tp; room = rm;
  wireRoom(rm);
  notifyRoom(rm);
  setStatus('部屋に入っています…');
  updateButtons();
  try {
    await rm.join();
  } catch (e) {
    setStatus('部屋に入れませんでした：' + (e && e.message || e) + (tp.lastError ? '（' + tp.lastError + '）' : ''));
    rm.leave(); tp.close();
    room = null; transport = null;
    notifyRoom(null);
    setChatOn(false);
    updateButtons();
    return;
  }
  quietUntil = Date.now() + QUIET_MS;
  setStatus('部屋：' + roomId + '（席 ' + (rm.slot + 1) + '）　参加中');
  setChatOn(true);
  sysLine(L.joinText(myName));
  sentPos = null;
  updateButtons();
  renderTeleport();
}

function wireRoom(rm) {
  rm.on('pl', (key, v, meta) => {
    if (!v || !meta || meta.peer === rm.peerId) return;
    const id = meta.peer;
    const n = cleanText(v.n, L.NAME_MAX) || L.DEFAULT_NAME;
    const isNew = !remotes.has(id);
    remotes.set(id, { name: n, x: +v.x || 0, y: +v.y || 0, z: +v.z || 0, yaw: +v.yaw || 0, last: Date.now() });
    if (isNew && Date.now() > quietUntil) sysLine(L.joinText(n));
    if (isNew) renderTeleport();
  });
  rm.on('bye', (key, v, meta) => {
    if (!meta || meta.peer === rm.peerId) return;
    const r = remotes.get(meta.peer);
    if (!r) return;
    remotes.delete(meta.peer);
    sysLine(L.leaveText(r.name));
    renderTeleport();
  });
  rm.on('chat', (key, v, meta) => {
    if (!v || !meta || meta.peer === rm.peerId) return;
    const n = cleanText(v.n, L.NAME_MAX) || L.DEFAULT_NAME;
    const t = cleanText(v.t, CHAT_MAX);
    if (t) addLine(t, '', L.colorOf(n), n);
  });
  rm.onEvent((ev, data) => {
    if (rm !== room) return;
    if (ev === 'links') setStatus('部屋：' + rm.roomId + '（席 ' + (rm.slot + 1) + '）　つながっている人：' + data);
    if (ev === 'rejected' && Date.now() - lastRejectMsg > 10000) {
      lastRejectMsg = Date.now();
      sysLine('合言葉が違う人からの接続を止めました');
    }
  });
}

function leaveRoom(announce) {
  if (!room) return;
  const rm = room, tp = transport;
  try { rm.ephemeral('bye:' + rm.peerId, { n: myName }); } catch (e) {}
  room = null; transport = null;
  notifyRoom(null);
  rm.leave();
  if (tp) tp.close();
  remotes.clear();
  clearOverlays();
  renderTeleport();
  setChatOn(false);
  if (announce) setStatus('退出しました');
  updateButtons();
}

async function copyInvite() {
  if (!room) return;
  const link = L.makeInvite(location.href, room.roomId, room.password);
  let ok = false;
  try { await navigator.clipboard.writeText(link); ok = true; } catch (e) {}
  if (!ok) { try { window.prompt('この招待リンクをコピーしてください', link); ok = true; } catch (e) {} }
  setStatus(ok ? '招待リンクをコピーしました（開くと、そのまま入れます）' : '招待リンクを表示できませんでした');
}

// ---------- 自分の位置を送る・相手の便りを確かめる ----------
function tick(now) {
  requestAnimationFrame(tick);
  if (!room || !room.peerId) return;
  // 自分の位置（動いたときは細かく、止まっているときは1秒に1回）
  const p = player.pos;
  const moved = !sentPos || Math.abs(p.x - sentPos.x) > 0.01 || Math.abs(p.y - sentPos.y) > 0.01 || Math.abs(p.z - sentPos.z) > 0.01 || Math.abs(player.yaw - sentYaw) > 0.01;
  if ((moved && now - sentAt >= PRESENCE_MS) || now - sentAt >= HEARTBEAT_MS) {
    sentPos = { x: p.x, y: p.y, z: p.z }; sentYaw = player.yaw; sentAt = now;
    room.ephemeral('pl:' + room.peerId, { n: myName, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), yaw: +player.yaw.toFixed(3) });
  }
  // 長く便りがない相手は、画面から消す（お知らせは出さない）
  const t = Date.now();
  let gone = false;
  for (const [id, r] of remotes) if (t - r.last > STALE_MS) { remotes.delete(id); gone = true; }
  if (gone) renderTeleport();
  placeLocator();
  if (!tick.lastTag || now - tick.lastTag > 60) { tick.lastTag = now; updateTags(); }
  renderTeleport();
}

// ---------- 起動 ----------
// 招待リンクで開いたときは、メニューを出さずに、そのまま部屋のワールドへ入る
// （ゲーマータグが未設定のときだけ、名前の入力を一度だけ出す）
function enterFromInvite(inv) {
  roomIn.value = inv.roomId;
  passIn.value = inv.password;
  const go = () => {
    const name = currentName();
    startWorldQuietly();
    joinRoom(inv.roomId, inv.password, name);
  };
  if (readName()) { go(); return; }
  askNameOnce(go);
}
// 開始画面（ワールド一覧・クリックして開始）を飛ばして、ゲームを始める
function startWorldQuietly() {
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    const title = document.getElementById('wsTitle');
    const ready = window.VoxelWorld && VoxelWorld.start && title;
    if (ready && title.style.display !== 'none') { clearInterval(t); VoxelWorld.start(); }
    else if (ready || tries > 100) clearInterval(t);     // 既に開始済み、または見つからない
    const ov = document.getElementById('overlay');
    if (ov) ov.style.display = 'none';
  }, 100);
}
// 名前を一度だけ聞く（最低限の画面）
function askNameOnce(done) {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;z-index:95;background:rgba(8,16,28,.85);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box';
  const card = document.createElement('div');
  card.style.cssText = 'background:#14202e;color:#fff;border-radius:12px;padding:18px;width:min(92vw,360px);font:15px/1.6 system-ui,sans-serif';
  const h = document.createElement('div'); h.textContent = 'ゲーマータグ（16文字まで）'; card.appendChild(h);
  const input = document.createElement('input');
  input.type = 'text'; input.placeholder = L.DEFAULT_NAME; input.maxLength = 40;
  input.style.cssText = 'width:100%;box-sizing:border-box;background:#1f2b38;color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:6px;padding:10px;font-size:16px;margin:8px 0';
  card.appendChild(input);
  const ok = document.createElement('button'); ok.textContent = '参加する';
  ok.style.cssText = 'width:100%;background:#2e6a9a;color:#fff;border:none;border-radius:8px;padding:12px;font-size:16px';
  ok.addEventListener('click', () => {
    nameIn.value = cleanText(input.value, L.NAME_MAX) || L.DEFAULT_NAME;
    saveName(nameIn.value);
    box.remove();
    done();
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') ok.click(); });
  card.appendChild(ok);
  box.appendChild(card);
  document.body.appendChild(box);
  setTimeout(() => input.focus(), 50);
}
function startUp() {
  buildCard();
  buildChat();
  buildOverlays();
  requestAnimationFrame(tick);
  window.addEventListener('pagehide', () => leaveRoom(false));
  const inv = L.parseInvite(location.hash);
  if (inv) enterFromInvite(inv);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startUp);
else startUp();

window.VoxelRTUI = { onRoom: fn => { roomListeners.push(fn); if (room) fn(room); }, room: () => room, join: joinRoom, leave: () => leaveRoom(true), remotes: () => remotes, say: t => { chatInput.value = t; sendChat(); } };
})();
