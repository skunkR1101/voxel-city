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
const MEDIA_LIMIT = 4200000;    // 画像・GIFの大きさ上限（文字数。大きいものは、少しずつ分けて送る）
const MEDIA_PART = 60000;       // 1通の大きさ（文字数）。通信の1通の上限より小さくしている
const MEDIA_GIF_BYTES = 3000000; // GIFの元のファイルの大きさ上限（バイト）
const CHAT_OPT_KEY = 'voxelcraft_chat_opts_v1';
const CHAT_OPT_DEF = { showImg: true, showGif: true, btnImg: true, btnGif: true };
const CHAT_OPT_ITEMS = [
  ['showImg', '画像を表示する（相手からの画像）'],
  ['showGif', 'GIFを表示する（相手からのGIF）'],
  ['btnImg', '画像を送るボタンを表示する'],
  ['btnGif', 'GIFを送るボタンを表示する']
];
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
let imgBtn, gifBtn, mediaInput;
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
  imgBtn = el('button', 'mb', '画像'); imgBtn.type = 'button';
  gifBtn = el('button', 'mb', 'GIF'); gifBtn.type = 'button';
  mediaInput = el('input'); mediaInput.type = 'file'; mediaInput.style.display = 'none';
  imgBtn.addEventListener('click', () => { mediaInput.accept = 'image/png,image/jpeg,image/webp'; mediaInput.click(); });
  gifBtn.addEventListener('click', () => { mediaInput.accept = 'image/gif'; mediaInput.click(); });
  mediaInput.addEventListener('change', () => { const f = mediaInput.files && mediaInput.files[0]; mediaInput.value = ''; if (f) sendMediaFile(f); });
  chatForm.appendChild(chatInput); chatForm.appendChild(imgBtn); chatForm.appendChild(gifBtn); chatForm.appendChild(send); chatForm.appendChild(mediaInput);
  chatForm.addEventListener('submit', e => { e.preventDefault(); sendChat(); });
  chatBox.appendChild(chatForm);
  document.body.appendChild(chatBox);
  const cs = document.createElement('style');
  cs.textContent =
    '#rtChat .mb{pointer-events:auto;background:#2b3a4f;color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:6px;padding:4px 6px;font-size:12px;margin-left:4px}' +
    '#rtChat .log a{color:#8fd3ff;text-decoration:underline;pointer-events:auto}' +
    '#rtChat .log .med{display:inline-block;max-width:100%}' +
    '#rtChat .log .med img{display:block;max-width:150px;max-height:110px;border-radius:6px;margin:2px 0;pointer-events:auto}' +
    '#rtChat .log .med .ph{display:none;opacity:.75;font-size:12px}' +
    '#rtChat .log .med img{cursor:zoom-in}' +
    '#rtPreview{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.88);display:none;align-items:center;justify-content:center;padding:12px;cursor:zoom-out}' +
    '#rtPreview img{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px}' +
    '#rtChat .log.no-img .med[data-g="0"] img,#rtChat .log.no-gif .med[data-g="1"] img{display:none}' +
    '#rtChat .log.no-img .med[data-g="0"] .ph,#rtChat .log.no-gif .med[data-g="1"] .ph{display:block}';
  document.head.appendChild(cs);
  refreshChatButtons(); applyChatView();
  buildChatSettings();
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
  addText(t, L.colorOf(myName), myName);
}


// ---------- チャット：リンク・画像・GIF、表示の設定 ----------
function chatOpts() {
  try { return Object.assign({}, CHAT_OPT_DEF, JSON.parse(localStorage.getItem(CHAT_OPT_KEY) || '{}')); }
  catch (e) { return Object.assign({}, CHAT_OPT_DEF); }
}
function setChatOpts(patch) {
  const o = Object.assign(chatOpts(), patch);
  try { localStorage.setItem(CHAT_OPT_KEY, JSON.stringify(o)); } catch (e) {}
  refreshChatButtons(); applyChatView();
}
function refreshChatButtons() {
  const o = chatOpts();
  if (imgBtn) imgBtn.style.display = o.btnImg ? '' : 'none';
  if (gifBtn) gifBtn.style.display = o.btnGif ? '' : 'none';
}
function applyChatView() {
  const o = chatOpts();
  if (!chatLog) return;
  chatLog.classList.toggle('no-img', !o.showImg);
  chatLog.classList.toggle('no-gif', !o.showGif);
}
window.addEventListener('vc-chat-opts', () => { refreshChatButtons(); applyChatView(); });

function validMedia(u) {
  return typeof u === 'string' && u.length <= MEDIA_LIMIT + 100 && /^data:image\/(png|jpeg|webp|gif);base64,/.test(u);
}
function readDataUrl(f) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
}
// 静止画は、大きさと画質を下げて、上限に収まるまで縮める（WebP が使えなければ JPEG）
async function shrinkImage(f) {
  const bmp = await createImageBitmap(f);
  for (const [max, q] of [[960, 0.85], [720, 0.8], [480, 0.75], [360, 0.65]]) {
    const sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * sc)); c.height = Math.max(1, Math.round(bmp.height * sc));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    let url = c.toDataURL('image/webp', q);
    if (!url.startsWith('data:image/webp')) url = c.toDataURL('image/jpeg', q);
    if (url.length <= MEDIA_LIMIT) return url;
  }
  return null;
}
async function sendMediaFile(f) {
  if (!room) { sysLine('部屋に参加すると送れます'); return; }
  const isGif = f.type === 'image/gif';
  let url = null;
  try {
    if (isGif) {
      if (f.size > MEDIA_GIF_BYTES) { sysLine('GIFは3MB以下のものを送れます'); return; }
      url = await readDataUrl(f);
    } else {
      url = await shrinkImage(f);
    }
  } catch (e) { sysLine('画像を読み込めませんでした'); return; }
  if (!validMedia(url)) { sysLine('画像が大きすぎて送れませんでした'); return; }
  addMedia(url, isGif, L.colorOf(myName), myName);
  sendMediaParts(url, isGif ? 'gif' : 'img');
}
// 大きい画像・GIFは、少しずつ分けて送る（受け取った側で、すべて届いてから組み立てる）
function sendMediaParts(url, kind) {
  if (!room) return;
  if (url.length <= MEDIA_PART) { room.ephemeral('chat:' + room.peerId, { n: myName, k: kind, u: url }); return; }
  const id = Math.random().toString(36).slice(2, 10);
  const c = Math.ceil(url.length / MEDIA_PART);
  for (let i = 0; i < c; i++) {
    room.ephemeral('chat:' + room.peerId, { n: myName, k: 'part', mk: kind, id, i, c, d: url.slice(i * MEDIA_PART, (i + 1) * MEDIA_PART) });
  }
}
const partsIn = new Map();      // 送り手:番号 -> { c, got, kind, name, t }
function onMediaPart(peer, v, n) {
  if (typeof v.id !== 'string' || !Number.isInteger(v.i) || !Number.isInteger(v.c) || v.c < 1 || v.c > 100) return;
  if (v.i < 0 || v.i >= v.c || typeof v.d !== 'string' || v.d.length > MEDIA_PART) return;
  const key = peer + ':' + v.id;
  let p = partsIn.get(key);
  if (!p) { p = { c: v.c, got: new Array(v.c), kind: v.mk === 'gif' ? 'gif' : 'img', name: n, t: Date.now() }; partsIn.set(key, p); }
  if (p.c !== v.c) return;
  p.got[v.i] = v.d;
  if (p.got.filter(x => typeof x === 'string').length === p.c) {
    partsIn.delete(key);
    const url = p.got.join('');
    if (validMedia(url)) addMedia(url, p.kind === 'gif', L.colorOf(p.name), p.name);
  }
}
setInterval(() => {                       // 届かないままの分は、1分で捨てる
  const now = Date.now();
  for (const [k, p] of partsIn) if (now - p.t > 60000) partsIn.delete(k);
}, 15000);
// 文字の中の http・https のリンクを、押せるリンクにする（ほかの形式のリンクは作らない）
function appendLinked(parent, t) {
  const re = /https?:\/\/[^\s<>"']+/g;
  let last = 0, m;
  while ((m = re.exec(t))) {
    if (m.index > last) parent.appendChild(document.createTextNode(t.slice(last, m.index)));
    const a = el('a', '', m[0]);
    a.href = m[0]; a.target = '_blank'; a.rel = 'noopener noreferrer';
    parent.appendChild(a);
    last = m.index + m[0].length;
  }
  if (last < t.length) parent.appendChild(document.createTextNode(t.slice(last)));
}
function newLine(name, color) {
  const d = el('div', 'ln');
  if (name != null) {
    const n = el('span', '', '<' + name + '> ');
    n.style.color = color || '#fff';
    d.appendChild(n);
  }
  return d;
}
function pushLine(d) {
  chatLog.appendChild(d);
  while (chatLog.childNodes.length > LOG_MAX) chatLog.removeChild(chatLog.firstChild);
}
function addText(t, color, name) {
  if (!chatLog) return;
  const d = newLine(name, color);
  appendLinked(d, t);
  pushLine(d);
}
function addMedia(url, isGif, color, name) {
  if (!chatLog) return;
  const d = newLine(name, color);
  const m = el('span', 'med');
  m.dataset.g = isGif ? '1' : '0';
  const img = document.createElement('img');
  img.src = url; img.alt = isGif ? 'GIF' : '画像'; img.loading = 'lazy';
  img.title = 'タップで大きく見る';
  img.addEventListener('click', () => openPreview(url, isGif));
  m.appendChild(img);
  m.appendChild(el('span', 'ph', isGif ? '［GIF（表示しない設定）］' : '［画像（表示しない設定）］'));
  d.appendChild(m);
  pushLine(d);
  applyChatView();
}
// 画像・GIFを、大きく表示する（タップ・クリックで閉じる）
function openPreview(url, isGif) {
  let box = document.getElementById('rtPreview');
  if (!box) {
    box = el('div'); box.id = 'rtPreview';
    box.addEventListener('click', () => { box.style.display = 'none'; box.firstChild.src = ''; });
    box.appendChild(document.createElement('img'));
    document.body.appendChild(box);
  }
  box.firstChild.src = url;
  box.firstChild.alt = isGif ? 'GIF' : '画像';
  box.style.display = 'flex';
}
// 設定の「チャット」の欄（ゲームの設定画面の、閉じるボタンの前に入れる）
function buildChatSettings() {
  const tryBuild = () => {
    const close = document.getElementById('settingsClose');
    if (!close) return false;
    if (document.getElementById('chatOptSec')) return true;
    const sec = document.createElement('div');
    sec.id = 'chatOptSec';
    sec.style.cssText = 'margin:10px 0;padding:8px;border:1px solid #3a4a60;border-radius:8px';
    sec.innerHTML = '<div style="font-weight:bold;margin-bottom:6px">チャット（画像・GIF・リンク）</div>' +
      CHAT_OPT_ITEMS.map(([k, label]) =>
        `<label style="display:flex;gap:8px;align-items:center;margin:4px 0"><input type="checkbox" data-k="${k}"><span>${label}</span></label>`).join('');
    const o = chatOpts();
    sec.querySelectorAll('input[data-k]').forEach(cb => {
      const k = cb.dataset.k;
      cb.checked = !!o[k];
      cb.addEventListener('change', () => setChatOpts({ [k]: cb.checked }));
    });
    close.parentNode.insertBefore(sec, close);
    return true;
  };
  if (!tryBuild()) { const t = setInterval(() => { if (tryBuild()) clearInterval(t); }, 300); }
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
    if (v.k === 'part') { onMediaPart(meta.peer, v, n); return; }
    if (v.k === 'img' || v.k === 'gif') {
      if (validMedia(v.u)) addMedia(v.u, v.k === 'gif', L.colorOf(n), n);
      return;
    }
    const t = cleanText(v.t, CHAT_MAX);
    if (t) addText(t, L.colorOf(n), n);
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

window.VoxelRTUI = { onRoom: fn => { roomListeners.push(fn); if (room) fn(room); }, room: () => room, join: joinRoom, leave: () => leaveRoom(true), remotes: () => remotes, chatOpts: { get: chatOpts, set: setChatOpts }, say: t => { chatInput.value = t; sendChat(); } };
})();
