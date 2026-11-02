/* voxel-craft-share.js  GitHub トークンの保存・共有（新しいファイル）
 *  1. トークンの保存先を、ブラウザの保存領域（localStorage）と IndexedDB の両方にする。
 *     片方が消えても、もう片方から自動で戻す（タブを閉じても消えないように）
 *  2. 共有パスワード（信頼できる人のみ）
 *     ・ホストが自分のトークンを入れると、ランダムなパスワードが作られる
 *     ・トークンは、そのパスワードで暗号化してから、部屋の情報に入る（平文では入らない）
 *     ・参加者は、パスワードを入れるだけで、トークンを知らずに同じ設定になる
 *  読み込み順：voxel-craft-multi.js の後
 */
(function () {
'use strict';

const GH_KEY = 'voxelcraft_gh_v1';           // multi.js と同じ（{repo, token}）
const SHARE_KEY = 'share:gh';                 // 部屋の情報の中の、暗号化したトークン
const KEEP_DB = 'voxelcraft_keep', KEEP_STORE = 'k';
const ITER = 200000;                          // パスワードから鍵を作る回数（総当たりを遅くする）

// ============================================================
// 1. 保存先（IndexedDB に写しを持つ）
// ============================================================
let kdbP = null;
function kdb() {
  if (!kdbP) kdbP = new Promise((res, rej) => {
    const r = indexedDB.open(KEEP_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(KEEP_STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return kdbP;
}
function kget(k) {
  return kdb().then(d => new Promise((res, rej) => {
    const q = d.transaction(KEEP_STORE, 'readonly').objectStore(KEEP_STORE).get(k);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  }));
}
function kput(k, v) {
  return kdb().then(d => new Promise((res, rej) => {
    const t = d.transaction(KEEP_STORE, 'readwrite');
    t.objectStore(KEEP_STORE).put(v, k);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  }));
}
let mirrored = null;
async function mirrorNow() {
  let cur = null;
  try { cur = localStorage.getItem(GH_KEY); } catch (e) {}
  if (cur === null || cur === mirrored) return;
  try { await kput('gh', cur); mirrored = cur; } catch (e) {}
}
// localStorage が消えていたら、IndexedDB から戻す（戻したら、一度だけ読み直す）
async function restoreIfLost() {
  let cur = null;
  try { cur = localStorage.getItem(GH_KEY); } catch (e) { return false; }
  if (cur !== null) return false;
  let saved = null;
  try { saved = await kget('gh'); } catch (e) { return false; }
  if (!saved) return false;
  try { localStorage.setItem(GH_KEY, saved); } catch (e) { return false; }
  mirrored = saved;
  return true;
}
// 消えにくくするよう頼む（対応している端末のみ。iPad の Safari は対応していない場合がある）
function askPersist() {
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) {}
}

// ============================================================
// 2. 共有パスワードの暗号（WebCrypto：PBKDF2 + AES-GCM）
// ============================================================
const enc = new TextEncoder(), dec = new TextDecoder();
function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(str) { const bin = atob(str), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
async function keyFrom(pass, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
// 紛らわしい文字（0/O・1/I など）を除いた、32文字から作る（16文字・4文字ずつ区切り）
function genPass() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const r = new Uint32Array(16);
  crypto.getRandomValues(r);
  let s = '';
  for (let i = 0; i < 16; i++) s += A[r[i] % A.length];   // 32で割り切れるので偏りがない
  return s.match(/.{4}/g).join('-');
}
function normPass(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
// 部屋のIDも一緒に暗号へ入れる（別の部屋の暗号を流用できないように）
async function encryptShare(pass, payload, roomId) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(pass, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('vc-share|' + roomId) }, key, enc.encode(JSON.stringify(payload)));
  return { v: 1, s: b64(salt), i: b64(iv), c: b64(new Uint8Array(ct)) };
}
async function decryptShare(pass, box, roomId) {
  const key = await keyFrom(pass, unb64(box.s));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.i), additionalData: enc.encode('vc-share|' + roomId) }, key, unb64(box.c));
  return JSON.parse(dec.decode(pt));
}

// ============================================================
// 3. 画面（タイトル画面の、一覧の下に出す）
// ============================================================
function inRoom() { return !!(window.VoxelMulti && VoxelMulti.connected && VoxelMulti.connected()); }
function roomId() { return VoxelMulti.roomId(); }
function sharedEntry() {
  try { const kv = window.VoxelNet && VoxelNet.kv ? VoxelNet.kv() : null; const e = kv && kv.get(SHARE_KEY); return e && !e.del && e.v ? e.v : null; }
  catch (e) { return null; }
}
function cfgNow() { try { return JSON.parse(localStorage.getItem(GH_KEY) || 'null'); } catch (e) { return null; } }

let msgEl = null, statusEl = null, tokIn = null, repoIn = null, passIn = null, showPassEl = null;
function say(t) { if (msgEl) msgEl.textContent = t; }

async function hostShare() {
  if (!inRoom()) return say('部屋に入ってから作れます。');
  const token = (tokIn.value || '').trim();
  if (!token) return say('GitHub のトークンを入れてください。');
  const cfg = cfgNow();
  const repo = ((repoIn.value || '').trim() || (cfg && cfg.repo) || '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
  if (!repo) return say('リポジトリ名（例：yourname/voxel-rooms）を入れてください。');
  try {
    const pass = genPass();
    const box = await encryptShare(normPass(pass), { repo, token }, roomId());
    VoxelMulti.send(SHARE_KEY, box, false, false);            // 部屋の情報として送る（GitHub にも残る）
    if (!cfg || !cfg.token) localStorage.setItem(GH_KEY, JSON.stringify({ repo, token }));   // ホスト自身の設定が無ければ、同じものを使う
    tokIn.value = '';
    showPassEl.textContent = pass;
    showPassEl.style.display = 'block';
    say('共有パスワードを作りました。信頼できる人にだけ伝えてください。');
  } catch (e) { say('作れませんでした：' + (e.message || e)); }
}

async function joinShare() {
  if (!inRoom()) return say('部屋に入ってから押してください。');
  const pass = normPass(passIn.value);
  if (pass.length < 12) return say('共有パスワードを入れてください。');
  const box = sharedEntry();
  if (!box) return say('部屋の情報をまだ受け取れていません。部屋に入って、少し待ってからもう一度押してください。');
  try {
    const p = await decryptShare(pass, box, roomId());
    if (!p || !p.token || !p.repo) throw new Error('bad');
    localStorage.setItem(GH_KEY, JSON.stringify({ repo: String(p.repo), token: String(p.token) }));
    passIn.value = '';
    say('共有トークンを設定しました。このあと、GitHub への保存に使えます。');
    refresh();
  } catch (e) { say('パスワードが違います（または、この部屋の共有ではありません）。'); }
}

function stopShare() {
  if (!inRoom()) return say('部屋に入ってから押してください。');
  if (!confirm('共有をやめます。今の参加者は、すでに設定したトークンを使い続けます。\n完全に止めるには、GitHub でトークンを作り直してください。よろしいですか？')) return;
  VoxelMulti.send(SHARE_KEY, undefined, true, false);
  showPassEl.style.display = 'none';
  say('共有をやめました。');
}

function refresh() {
  if (!statusEl) return;
  const c = cfgNow();
  const shared = !!sharedEntry();
  const parts = [];
  parts.push(c && c.token ? 'この端末：トークン設定済み' : 'この端末：トークン未設定');
  parts.push(shared ? '部屋：共有パスワードあり' : '部屋：共有なし');
  statusEl.textContent = parts.join('　');
}

function injectStyle() {
  const st = document.createElement('style');
  st.textContent =
    '#vsCard input{width:100%;box-sizing:border-box;background:#1f2b38;color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:6px;padding:9px;font-size:14px;margin-top:6px}' +
    '#vsCard .go{display:block;width:100%;background:#2e6a9a;color:#fff;border:none;border-radius:8px;padding:10px;font-size:14px;margin-top:8px;cursor:pointer}' +
    '#vsCard .go.sub{background:#3a4450}' +
    '#vsCard .m{font-size:12px;color:#9fb3c8;line-height:1.6;margin:6px 0 0}' +
    '#vsCard .pass{display:none;font:bold 20px/1.4 monospace;letter-spacing:2px;text-align:center;background:#0b1118;border-radius:8px;padding:10px;margin-top:8px;user-select:all}';
  document.head.appendChild(st);
}
function el(tag, text, cls) { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; }
function buildCard() {
  const title = document.getElementById('wsTitle');
  const h1 = title && title.querySelector('h1');
  if (!h1 || document.getElementById('vsCard')) return;
  injectStyle();
  const card = document.createElement('div');
  card.className = 'card'; card.id = 'vsCard';
  card.appendChild(el('h2', 'GitHub の共有（信頼できる人のみ）'));
  statusEl = el('p', '', 'm'); card.appendChild(statusEl);

  card.appendChild(el('h2', 'ホスト：トークンを共有する', '')).style.marginTop = '12px';
  tokIn = document.createElement('input'); tokIn.type = 'password'; tokIn.placeholder = 'GitHub のトークン（貼り付け）'; tokIn.autocomplete = 'off';
  repoIn = document.createElement('input'); repoIn.placeholder = 'リポジトリ名（例：yourname/voxel-rooms）※空欄なら設定の値';
  const mk = el('button', '共有パスワードを作る', 'go'); mk.addEventListener('click', hostShare);
  showPassEl = el('div', '', 'pass'); showPassEl.style.cssText = 'display:none';
  const stop = el('button', '共有をやめる', 'go sub'); stop.addEventListener('click', stopShare);
  card.appendChild(tokIn); card.appendChild(repoIn); card.appendChild(mk); card.appendChild(showPassEl); card.appendChild(stop);

  card.appendChild(el('h2', '参加者：パスワードで同期する', '')).style.marginTop = '12px';
  passIn = document.createElement('input'); passIn.placeholder = '共有パスワード（例：ABCD-EFGH-…）'; passIn.autocomplete = 'off';
  const join = el('button', 'パスワードで設定する', 'go'); join.addEventListener('click', joinShare);
  card.appendChild(passIn); card.appendChild(join);

  msgEl = el('p', '', 'm'); card.appendChild(msgEl);
  card.appendChild(el('p', 'トークンは、この端末の中だけに保存されます（画面には出しません）。パスワードは、信頼できる人にだけ伝えてください。', 'm'));
  h1.parentNode.insertBefore(card, h1.nextSibling);
  refresh();
}

// ============================================================
// 起動
// ============================================================
async function boot() {
  askPersist();
  const restored = await restoreIfLost().catch(() => false);
  if (restored) { try { sessionStorage.setItem('vs_restored', '1'); } catch (e) {} location.reload(); return; }
  const wait = setInterval(() => {
    if (!document.getElementById('wsTitle')) return;
    clearInterval(wait);
    buildCard();
    try { if (sessionStorage.getItem('vs_restored')) { sessionStorage.removeItem('vs_restored'); say('保存していたトークンを戻しました。'); } } catch (e) {}
  }, 200);
  setInterval(() => { mirrorNow(); refresh(); }, 3000);
  window.addEventListener('pagehide', () => { mirrorNow(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') mirrorNow(); });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

window.VoxelShare = { genPass, encryptShare, decryptShare, normPass };
})();
