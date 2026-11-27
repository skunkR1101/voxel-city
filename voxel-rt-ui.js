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
const roomHooks = [];          // 部屋に入ったとき（fn(rm)）・出たとき（fn(null)）に呼ぶ。ブロック・保存・アバターなどの各モジュール用
function fireRoom(rm) {
  for (const fn of roomHooks) { try { fn(rm); } catch (e) { console.error(e); } }
}
if (!L || !VR || !TR) { console.error('voxel-rt: 部品が読み込まれていません'); return; }

const NAME_KEY = 'vcrt_name_v1';
const ROOM_ID_RE = /^[A-Za-z0-9_-]{3,32}$/;
const CHAT_LAYOUT_KEY = 'vcrt_chatlayout_v1';   // チャット欄の位置（下からの px）と横幅（px）。この端末にだけ保存
const CHAT_DEFAULT = { bottom: 72, width: 380 };
const LAST_KEY = 'vcrt_last_v1';   // 最後に入った部屋（次回から自動で入るため。この端末にだけ保存）
function saveLast(roomId, password) { try { localStorage.setItem(LAST_KEY, JSON.stringify({ roomId, password })); } catch (e) {} }
function loadLast() {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
    if (v && ROOM_ID_RE.test(v.roomId) && typeof v.password === 'string' && v.password) return v;
  } catch (e) {}
  return null;
}
function forgetLast() { try { localStorage.removeItem(LAST_KEY); } catch (e) {} }
const PRESENCE_MS = 250;        // 動いているとき、位置を送る間隔
const HEARTBEAT_MS = 1000;      // 止まっているとき、生存の知らせを送る間隔
const STALE_MS = 40000;         // これより長く便りがない相手は、画面から消す（お知らせは出さない）
const QUIET_MS = 3000;          // 入った直後は、すでにいる人の「参加しました」を出さない
const CHAT_MAX = 200;           // チャット1行の長さ（文字）
const LOG_MAX = 300;            // 残しておく履歴の行数（上にスクロールして見られる）
const STRIP_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');

let room = null, transport = null;
let serverSync = null;   // 中継サーバーへの保存（段階A）
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
    '#rtChat{position:fixed;left:8px;bottom:72px;top:auto;width:min(380px,62vw);z-index:40;pointer-events:none;font:14px/1.5 system-ui,sans-serif}' +
    '#rtChat .log{max-height:34vh;overflow-y:hidden;display:flex;flex-direction:column;overscroll-behavior:contain}' +
    '#rtChat .lw{display:flex;flex-direction:column;gap:2px;margin-top:auto}' +
    '#rtChat .ln{background:rgba(0,0,0,.45);color:#fff;border-radius:6px;padding:2px 8px;width:fit-content;max-width:100%;word-break:break-word;text-shadow:0 1px 2px #000}' +
    '#rtChat .ln.sys{color:#ffe600}' +
    '#rtChat form{display:none;pointer-events:auto;margin-top:6px}' +
    '#rtChat.on form{display:flex;gap:6px}' +
    '#rtChat.on .log{pointer-events:auto;overflow-y:auto;touch-action:pan-y;-webkit-overflow-scrolling:touch}' +
    '#rtChat input{flex:1;min-width:0;background:rgba(0,0,0,.6);color:#fff;border:1px solid rgba(255,255,255,.4);border-radius:6px;padding:7px;font-size:16px}' +
    '#rtChat button{background:#2e6a9a;color:#fff;border:none;border-radius:6px;padding:0 12px;font-size:14px}' +
    '#rtChat .ln a{color:#8fd3ff;text-decoration:underline;pointer-events:auto;word-break:break-all}' +
    '#rtChat .ln img{display:block;max-width:min(60vw,220px);max-height:170px;border-radius:6px;margin-top:3px;pointer-events:auto;cursor:zoom-in}' +
    '#rtChat .chead{pointer-events:auto;display:inline-block;background:rgba(0,0,0,.5);color:#fff;border-radius:6px;padding:2px 10px;margin-bottom:3px;font-size:13px;cursor:pointer;user-select:none}' +
    '#rtChat.min .log,#rtChat.min form{display:none}' +
    '#rtLoc{position:fixed;left:50%;transform:translateX(-50%);width:min(560px,92vw);height:12px;z-index:30;pointer-events:none;display:none}' +
    '#rtLoc .bar{position:absolute;inset:0;background:rgba(0,0,0,.35);border-radius:6px;border:1px solid rgba(255,255,255,.35)}' +
    '#rtLoc .dot{position:absolute;top:50%;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;border:2px solid #fff;box-sizing:border-box}' +
    '#rtTags{position:fixed;inset:0;pointer-events:none;z-index:25;overflow:hidden}' +
    '#rtTags .tag{position:absolute;transform:translate(-50%,-100%);color:#fff;background:rgba(0,0,0,.45);border-radius:6px;padding:1px 6px;font:13px/1.4 system-ui,sans-serif;white-space:nowrap;text-shadow:0 1px 2px #000;display:none}';
  document.head.appendChild(st);
}

// ---------- チャットの画面 ----------
let chatBox, chatLog, chatLines, chatForm, chatInput;
let chatLayout = { bottom: CHAT_DEFAULT.bottom, width: CHAT_DEFAULT.width };
function loadChatLayout() {
  try {
    const v = JSON.parse(localStorage.getItem(CHAT_LAYOUT_KEY) || 'null');
    if (v && typeof v === 'object') {
      chatLayout = {
        bottom: Math.min(300, Math.max(0, Math.round(Number(v.bottom)) || 0)),
        width: Math.min(600, Math.max(200, Math.round(Number(v.width)) || CHAT_DEFAULT.width))
      };
    }
  } catch (e) {}
}
function saveChatLayout() {
  try { localStorage.setItem(CHAT_LAYOUT_KEY, JSON.stringify(chatLayout)); } catch (e) {}
}
function applyChatLayout() {
  if (!chatBox) return;
  chatBox.style.bottom = chatLayout.bottom + 'px';
  chatBox.style.width = 'min(' + chatLayout.width + 'px,90vw)';
}
// ボタン配置の設定パネル（vcLayoutPanel）の中に、チャット欄の位置・大きさの調整を入れる
function injectChatSettings(tries) {
  const box = document.querySelector('#vcLayoutPanel .vcBox');
  if (!box) { if ((tries || 0) < 30) setTimeout(() => injectChatSettings((tries || 0) + 1), 500); return; }
  if (document.getElementById('rtChatSettings')) return;
  const wrap = document.createElement('div');
  wrap.id = 'rtChatSettings';
  wrap.innerHTML =
    '<h3 style="margin:14px 0 0;font-size:14px;color:#cfe3f5">チャット欄の位置・大きさ</h3>' +
    '<label>下からの位置：<span id="rtChatBottomV"></span></label>' +
    '<input type="range" id="rtChatBottom" min="0" max="300" step="4">' +
    '<label>横幅：<span id="rtChatWidthV"></span></label>' +
    '<input type="range" id="rtChatWidth" min="200" max="600" step="10">' +
    '<button id="rtChatReset" class="sub">チャット欄を初期位置に戻す</button>';
  const close = document.getElementById('vcLayoutClose');
  box.insertBefore(wrap, close || null);
  const bIn = document.getElementById('rtChatBottom'), wIn = document.getElementById('rtChatWidth');
  const sync = () => {
    bIn.value = chatLayout.bottom; wIn.value = chatLayout.width;
    document.getElementById('rtChatBottomV').textContent = chatLayout.bottom + 'px';
    document.getElementById('rtChatWidthV').textContent = chatLayout.width + 'px';
  };
  bIn.addEventListener('input', () => { chatLayout.bottom = +bIn.value; applyChatLayout(); saveChatLayout(); sync(); });
  wIn.addEventListener('input', () => { chatLayout.width = +wIn.value; applyChatLayout(); saveChatLayout(); sync(); });
  document.getElementById('rtChatReset').addEventListener('click', () => {
    chatLayout = { bottom: CHAT_DEFAULT.bottom, width: CHAT_DEFAULT.width };
    applyChatLayout(); saveChatLayout(); sync();
  });
  sync();
  // 設定パネルを開くたびに、今の値を表示し直す
  const openBtn = document.getElementById('vcLayoutToggle');
  if (openBtn) openBtn.addEventListener('click', sync);
}

function buildChat() {
  chatBox = el('div'); chatBox.id = 'rtChat';
  // 見出し（タップで、チャット欄をまるごと折りたたむ・戻す）
  const head = el('div', 'chead', 'チャット ▾');
  head.addEventListener('click', e => { e.stopPropagation(); setChatMin(!chatBox.classList.contains('min')); });
  chatBox.appendChild(head);
  chatLog = el('div', 'log'); chatBox.appendChild(chatLog);
  chatLines = el('div', 'lw'); chatLog.appendChild(chatLines);
  // 履歴のスクロール中は、ゲームの指の操作（視点の回転）に取られないようにする
  chatLog.addEventListener('touchmove', e => e.stopPropagation(), { passive: true });
  try { setChatMin(localStorage.getItem(CHAT_MIN_KEY) === '1'); } catch (e) {}
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
  const pic = el('button', '', '🖼'); pic.type = 'button'; pic.title = '画像を送る';
  pic.addEventListener('click', e => { e.preventDefault(); pickImage(); });
  const emo = el('button', '', '😀'); emo.type = 'button'; emo.title = '絵文字';
  emo.addEventListener('click', e => { e.preventDefault(); toggleEmoji(); });
  const send = el('button', '', '送信'); send.type = 'submit';
  chatForm.appendChild(chatInput); chatForm.appendChild(pic); chatForm.appendChild(emo); chatForm.appendChild(send);
  chatForm.addEventListener('submit', e => { e.preventDefault(); sendChat(); });
  chatBox.appendChild(chatForm);
  document.body.appendChild(chatBox);
}
// チャットの表示：URL は押せるリンク。画像（gif・png・jpg・webp）の URL は、その場で画像として出す
// 画像の送信（小さく縮めた JPEG）は、部屋の中継を通るので大きさを抑えている（IMG_MAX）
const URL_RE = /https?:\/\/[^\s]+/g;
const IMG_URL_RE = /\.(gif|png|jpe?g|webp)(\?[^\s]*)?$/i;
const IMG_MAX = 60000;           // 送る画像の上限（文字数。約45KB）
function renderBody(box, text) {
  let last = 0, m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text))) {
    if (m.index > last) box.appendChild(document.createTextNode(text.slice(last, m.index)));
    const u = m[0];
    if (IMG_URL_RE.test(u)) {
      const img = document.createElement('img');
      img.src = u; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
      img.onerror = () => { img.replaceWith(document.createTextNode(u)); };
      img.addEventListener('click', e => { e.stopPropagation(); openLightbox(u); });
      box.appendChild(img);
    } else {
      const a = document.createElement('a');
      a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = u;
      box.appendChild(a);
    }
    last = m.index + u.length;
  }
  if (last < text.length) box.appendChild(document.createTextNode(text.slice(last)));
}
function addLine(text, cls, nameColor, name, img) {
  if (!chatLog || !chatLines) return;
  const d = el('div', 'ln' + (cls ? ' ' + cls : ''));
  if (name != null) {
    const n = document.createElement('span');
    n.textContent = '<' + name + '> ';
    n.style.color = nameColor || '#fff';
    d.appendChild(n);
  }
  renderBody(d, text || '');
  if (img) {
    const i = document.createElement('img'); i.src = img; i.alt = '';
    i.addEventListener('click', e => { e.stopPropagation(); openLightbox(img); });
    d.appendChild(i);
  }
  const near = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40;
  chatLines.appendChild(d);
  while (chatLines.childNodes.length > LOG_MAX) chatLines.removeChild(chatLines.firstChild);
  if (near) chatLog.scrollTop = chatLog.scrollHeight;
}
function sysLine(text) { addLine(text, 'sys'); }
function setChatOn(on) { if (chatBox) chatBox.classList.toggle('on', !!on); }
const CHAT_MIN_KEY = 'vcrt_chatmin_v1';
function setChatMin(min) {
  if (!chatBox) return;
  chatBox.classList.toggle('min', !!min);
  const head = chatBox.querySelector('.chead');
  if (head) head.textContent = 'チャット ' + (min ? '▸' : '▾');
  try { localStorage.setItem(CHAT_MIN_KEY, min ? '1' : '0'); } catch (e) {}
}
// 画像をタップすると大きく表示。もう一度どこかを押すと閉じる
function openLightbox(src) {
  if (document.getElementById('rtLight')) return;
  const w = document.createElement('div');
  w.id = 'rtLight';
  w.style.cssText = 'position:fixed;inset:0;z-index:95;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;padding:12px;cursor:zoom-out;touch-action:none';
  const im = document.createElement('img');
  im.src = src; im.alt = '';
  im.style.cssText = 'max-width:96vw;max-height:94vh;object-fit:contain;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.6)';
  w.appendChild(im);
  w.addEventListener('click', e => { e.stopPropagation(); w.remove(); });
  document.body.appendChild(w);
}

function sendChat() {
  const t = cleanText(chatInput.value, CHAT_MAX);
  chatInput.value = '';
  if (!t || !room) return;
  room.ephemeral('chat:' + room.peerId, { n: myName, t });
  addLine(t, '', L.colorOf(myName), myName);
}
// 画像を選んで送る：小さく縮めて JPEG にし、部屋の中継で届ける（保存はしない）
function shrinkImage(file) {
  return new Promise((res, rej) => {
    const src = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const k = Math.min(1, 200 / Math.max(img.width, img.height, 1));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k));
        c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        let q = 0.7, url = c.toDataURL('image/jpeg', q);
        while (url.length > IMG_MAX && q > 0.3) { q -= 0.15; url = c.toDataURL('image/jpeg', q); }
        url.length <= IMG_MAX ? res(url) : rej(new Error('too big'));
      } catch (e) { rej(e); } finally { URL.revokeObjectURL(src); }
    };
    img.onerror = () => { URL.revokeObjectURL(src); rej(new Error('bad image')); };
    img.src = src;
  });
}
function pickImage() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0];
    if (!f || !room) return;
    try {
      const url = await shrinkImage(f);
      room.ephemeral('chat:' + room.peerId, { n: myName, t: '', img: url });
      addLine('', '', L.colorOf(myName), myName, url);
    } catch (e) { sysLine('画像を送れませんでした（大きすぎるか、読めない形式です）'); }
  });
  inp.click();
}

// ---------- 絵文字（好きな画像を登録して、チャットに送る。登録はこの端末だけに保存） ----------
const EMO_KEY = 'vcrt_emoji_v1';
const EMO_MAX = 200;
const EMO_PX = 96;
let emoBox = null, emoEdit = false;
function emoList() {
  try {
    const a = JSON.parse(localStorage.getItem(EMO_KEY) || '[]');
    return Array.isArray(a) ? a.filter(u => typeof u === 'string' && u.indexOf('data:image/png;base64,') === 0) : [];
  } catch (e) { return []; }
}
function emoSave(list) {
  try { localStorage.setItem(EMO_KEY, JSON.stringify(list.slice(0, EMO_MAX))); return true; } catch (e) { sysLine('絵文字を保存できませんでした（端末の空き容量が足りないかもしれません）'); return false; }
}
function toggleEmoji(force) {
  if (!emoBox) buildEmoji();
  const on = force == null ? emoBox.style.display === 'none' : !!force;
  emoBox.style.display = on ? 'block' : 'none';
  if (on) renderEmoji();
}
function buildEmoji() {
  emoBox = el('div'); emoBox.id = 'rtEmoji';
  emoBox.style.cssText = 'position:fixed;left:8px;bottom:150px;width:min(380px,62vw);max-height:40vh;overflow-y:auto;' +
    'overscroll-behavior:contain;touch-action:pan-y;-webkit-overflow-scrolling:touch;z-index:41;background:rgba(10,14,20,.95);' +
    'color:#fff;border-radius:10px;padding:8px;display:none;box-sizing:border-box;font:13px system-ui,sans-serif';
  document.body.appendChild(emoBox);
  // パネルの中の操作は、ゲームの操作（視点・設置）に取られないようにする
  for (const t of ['pointerdown', 'click']) emoBox.addEventListener(t, e => e.stopPropagation());
  emoBox.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
  emoBox.addEventListener('touchmove', e => e.stopPropagation(), { passive: true });
}
const EMO_BTN = 'border:none;border-radius:6px;padding:6px 10px;background:#2e6a9a;color:#fff;font-size:13px';
function renderEmoji() {
  const list = emoList();
  emoBox.innerHTML = '';
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px';
  const title = document.createElement('b'); title.textContent = '絵文字（' + list.length + '）'; title.style.flex = '1';
  const edit = document.createElement('button');
  edit.textContent = emoEdit ? '完了' : '削除';
  edit.style.cssText = EMO_BTN + (emoEdit ? ';background:#7a4a1a' : '');
  edit.addEventListener('click', e => { e.preventDefault(); emoEdit = !emoEdit; renderEmoji(); });
  const add = document.createElement('button');
  add.textContent = '＋ 追加';
  add.style.cssText = EMO_BTN;
  add.addEventListener('click', e => { e.preventDefault(); pickEmoji(); });
  head.append(title, edit, add);
  emoBox.appendChild(head);
  if (!list.length) {
    const n = document.createElement('div');
    n.style.cssText = 'opacity:.75;padding:6px 2px';
    n.textContent = '絵文字はまだありません。「＋ 追加」で好きな画像を登録できます（切り取りができます）。';
    emoBox.appendChild(n);
    return;
  }
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(56px,1fr));gap:6px';
  list.forEach((u, i) => {
    const b = document.createElement('button');
    b.style.cssText = 'border:1px solid rgba(255,255,255,.25);border-radius:8px;background:rgba(255,255,255,.06);padding:4px;position:relative';
    const im = document.createElement('img'); im.src = u; im.alt = '';
    im.style.cssText = 'width:48px;height:48px;object-fit:contain;display:block;margin:0 auto';
    b.appendChild(im);
    b.addEventListener('click', e => {
      e.preventDefault();
      if (emoEdit) {
        const cur = emoList(); cur.splice(i, 1); emoSave(cur); renderEmoji();
      } else sendEmoji(u);
    });
    grid.appendChild(b);
  });
  emoBox.appendChild(grid);
  if (emoEdit) {
    const note = document.createElement('div');
    note.style.cssText = 'margin-top:6px;opacity:.8;font-size:12px';
    note.textContent = '削除したい絵文字をタップすると消えます（「完了」で戻ります）';
    emoBox.appendChild(note);
  }
}
function sendEmoji(url) {
  if (!room) {
    sysLine('部屋に入ると、相手にも絵文字が届きます');
  } else {
    room.ephemeral('chat:' + room.peerId, { n: myName, t: '', img: url });
  }
  addLine('', '', L.colorOf(myName), myName, url);
  toggleEmoji(false);
}
function pickEmoji() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.addEventListener('change', () => {
    const f = inp.files && inp.files[0];
    if (f) openCrop(f);
  });
  inp.click();
}
// 画像を、切り取りに使える大きさ（最大 512px）の PNG にする（どの大きさの画像でも受け付ける）
function scaledPng(file, max) {
  return new Promise((res, rej) => {
    const src = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const k = Math.min(1, max / Math.max(img.width, img.height, 1));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k));
        c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        res({ url: c.toDataURL('image/png'), w: c.width, h: c.height });
      } catch (e) { rej(e); } finally { URL.revokeObjectURL(src); }
    };
    img.onerror = () => { URL.revokeObjectURL(src); rej(new Error('bad image')); };
    img.src = src;
  });
}
// 切り取り：正方形の枠の中を、ドラッグで位置を合わせ、スライダーで拡大・縮小して決める
async function openCrop(file) {
  let pic;
  try { pic = await scaledPng(file, 512); }
  catch (e) { sysLine('この画像は読めませんでした'); return; }
  const ov = document.createElement('div');
  ov.id = 'rtCrop';
  ov.style.cssText = 'position:fixed;inset:0;z-index:96;background:rgba(0,0,0,.9);display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;gap:10px;padding:12px;box-sizing:border-box;color:#fff;font:14px system-ui,sans-serif;touch-action:none';
  const size = Math.max(160, Math.min(320, Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.7)));
  const stage = document.createElement('div');
  stage.style.cssText = 'position:relative;width:' + size + 'px;height:' + size + 'px;overflow:hidden;border-radius:8px;background:#222;cursor:move;touch-action:none';
  const im = document.createElement('img');
  im.src = pic.url; im.alt = ''; im.draggable = false;
  im.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;max-width:none;user-select:none;pointer-events:none';
  stage.appendChild(im);
  const frame = document.createElement('div');
  frame.style.cssText = 'position:absolute;inset:0;border:2px dashed rgba(255,255,255,.85);box-sizing:border-box;pointer-events:none';
  stage.appendChild(frame);
  const zoom = document.createElement('input');
  zoom.type = 'range'; zoom.min = '1'; zoom.max = '4'; zoom.step = '0.01'; zoom.value = '1';
  zoom.style.width = size + 'px';
  const label = document.createElement('div'); label.textContent = '拡大・縮小（ドラッグで位置を合わせる）'; label.style.opacity = '.85';
  const btns = document.createElement('div'); btns.style.cssText = 'display:flex;gap:8px';
  const ok = document.createElement('button'); ok.textContent = '決定'; ok.style.cssText = EMO_BTN;
  const ng = document.createElement('button'); ng.textContent = 'キャンセル'; ng.style.cssText = EMO_BTN + ';background:#555';
  btns.append(ok, ng);
  ov.append(label, stage, zoom, btns);
  // 切り取りの操作は、ゲームの指の操作（視点の回転）に取られないようにする
  for (const t of ['touchstart', 'touchmove', 'pointerdown', 'click']) ov.addEventListener(t, e => e.stopPropagation(), { passive: true });
  document.body.appendChild(ov);

  const base = Math.max(size / pic.w, size / pic.h);   // 枠をちょうど覆う大きさ
  let scale = base, ox = (size - pic.w * base) / 2, oy = (size - pic.h * base) / 2;
  const clampPos = () => {
    ox = Math.min(0, Math.max(size - pic.w * scale, ox));
    oy = Math.min(0, Math.max(size - pic.h * scale, oy));
  };
  const place = () => {
    clampPos();
    im.style.width = (pic.w * scale) + 'px';
    im.style.height = (pic.h * scale) + 'px';
    im.style.transform = 'translate(' + ox + 'px,' + oy + 'px)';
  };
  zoom.addEventListener('input', () => {
    const cx = (size / 2 - ox) / scale, cy = (size / 2 - oy) / scale;   // 今の中心（画像の上）
    scale = base * Number(zoom.value);
    ox = size / 2 - cx * scale; oy = size / 2 - cy * scale;
    place();
  });
  let drag = null;
  stage.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; stage.setPointerCapture(e.pointerId); });
  stage.addEventListener('pointermove', e => {
    if (!drag) return;
    ox += e.clientX - drag.x; oy += e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
    place();
  });
  const endDrag = () => { drag = null; };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  place();

  const close = () => { ov.remove(); };
  ng.addEventListener('click', close);
  ok.addEventListener('click', () => {
    const out = document.createElement('canvas');
    out.width = EMO_PX; out.height = EMO_PX;
    const sx = -ox / scale, sy = -oy / scale, sw = size / scale, sh = size / scale;
    out.getContext('2d').drawImage(im, sx, sy, sw, sh, 0, 0, EMO_PX, EMO_PX);
    let url = out.toDataURL('image/png');
    if (url.length > IMG_MAX) {
      // 念のため、さらに小さくする（相手に届けるときの上限に収める）
      const small = document.createElement('canvas'); small.width = 64; small.height = 64;
      small.getContext('2d').drawImage(out, 0, 0, 64, 64);
      url = small.toDataURL('image/png');
    }
    const list = emoList();
    list.push(url);
    if (emoSave(list)) {
      toggleEmoji(true);
      sysLine('絵文字を登録しました');
    }
    close();
  });
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
  leaveBtn.addEventListener('click', () => { forgetLast(); leaveRoom(true); });
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
  tp.setRoomPassword(password);
  const rm = VR.create({ roomId, password, name: myName, transport: tp });
  transport = tp; room = rm;
  wireRoom(rm);
  setStatus('部屋に入っています…');
  updateButtons();
  try {
    await rm.join();
  } catch (e) {
    setStatus('部屋に入れませんでした：' + (e && e.message || e) + (tp.lastError ? '（' + tp.lastError + '）' : ''));
    rm.leave(); tp.close();
    room = null; transport = null;
    setChatOn(false);
    updateButtons();
    return;
  }
  try { if (window.VoxelRTServer) serverSync = VoxelRTServer.attach(rm, tp); } catch (e) { console.error(e); }
  fireRoom(rm);
  saveLast(roomId, password);
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
    const img = typeof v.img === 'string' && /^data:image\/(jpeg|png);base64,/.test(v.img) && v.img.length <= IMG_MAX ? v.img : null;
    if (t || img) addLine(t, '', L.colorOf(n), n, img);
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
  if (serverSync) { try { serverSync.stop(); } catch (e) {} serverSync = null; }
  try { rm.ephemeral('bye:' + rm.peerId, { n: myName }); } catch (e) {}
  room = null; transport = null;
  fireRoom(null);
  rm.leave();
  if (tp) tp.close();
  remotes.clear();
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
function startUp() {
  buildCard();
  buildChat();
  loadChatLayout();
  applyChatLayout();
  injectChatSettings(0);
  buildOverlays();
  requestAnimationFrame(tick);
  window.addEventListener('pagehide', () => leaveRoom(false));
  const inv = L.parseInvite(location.hash);
  if (inv) {
    roomIn.value = inv.roomId;
    passIn.value = inv.password;
    joinRoom(inv.roomId, inv.password, currentName());
  } else {
    // 前回入った部屋に、自動で入り直す（退出ボタンを押すと、自動では入らなくなります）
    const last = loadLast();
    if (last) {
      roomIn.value = last.roomId;
      passIn.value = last.password;
      joinRoom(last.roomId, last.password, currentName());
    }
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startUp);
else startUp();

window.VoxelRTUI = {
  join: joinRoom,
  leave: () => leaveRoom(true),
  remotes: () => remotes,
  say: t => { chatInput.value = t; sendChat(); },
  // 部屋に入っている間ずっと fn(rm) を呼ぶ（すでに入っていれば、すぐに一度呼ぶ）
  onRoom: fn => {
    roomHooks.push(fn);
    if (room && room.peerId) { try { fn(room); } catch (e) { console.error(e); } }
  }
};
})();
