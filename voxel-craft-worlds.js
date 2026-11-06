/* voxel-craft-worlds.js  ワールドリスト（新しいファイル・第1段階：この端末に保存）
 *  ・シングルプレイのワールドを何個でも持てる。一覧に、最後にいた場所の画像・位置・日時を出す
 *  ・ワールドごとに持つもの：地形の編集・シード・道路/ダイヤ/駅/列車/交通/人混み/カスタムブロック/持ち物
 *  ・端末で共通のままのもの：GitHub のトークン・部屋の情報・音量や操作などの設定（保存ファイルにも入れない）
 *  ・読み込み順：voxel-craft-save.js の後（VoxelWorld を使う）。flat.js があれば新規作成でフラットを選べる
 */
(function () {
'use strict';

const DB_NAME = 'voxelcraft_worlds', STORE = 'w';
const CUR_KEY = 'vcw_current';           // 今開いているワールドの番号（この端末）
const OPEN_KEY = 'vcw_open';             // 再読み込み後に、すぐ開始するワールドの番号
// ワールドごとに持つ保存先（ここに無いものは、すべての世界で共通）
const WORLD_KEYS = [
  'voxelcraft_road_v1', 'voxelcraft_dia_v1', 'voxelcraft_station_v1', 'voxelcraft_train_v1',
  'voxelcraft_traffic_v1', 'voxelcraft_crowd_v1', 'voxelcraft_ext_v1', 'voxelcraft_bag_v1',
  'voxelcraft_defdel_v1', 'voxelcraft_tilt_v1', 'voxelcraft_bstate_v1'
];

// ============================================================
// 保存先（IndexedDB）
// ============================================================
let dbP = null;
function db() {
  if (!dbP) dbP = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbP;
}
function get(k) {
  return db().then(d => new Promise((res, rej) => {
    const q = d.transaction(STORE, 'readonly').objectStore(STORE).get(k);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  }));
}
function put(k, v) {
  return db().then(d => new Promise((res, rej) => {
    const t = d.transaction(STORE, 'readwrite');
    t.objectStore(STORE).put(v, k);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  }));
}
function del(k) {
  return db().then(d => new Promise((res, rej) => {
    const t = d.transaction(STORE, 'readwrite');
    t.objectStore(STORE).delete(k);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  }));
}
// 読み込み待ちのワールドは、保存機能（save.js）と同じ場所に置く（再読み込み後に、そのまま反映される）
function putPending(seed, edits) {
  return new Promise((res, rej) => {
    const r = indexedDB.open('voxelcraft', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => {
      const t = r.result.transaction('kv', 'readwrite');
      t.objectStore('kv').put({ seed, edits }, 'pendingWorld');
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    };
    r.onerror = () => rej(r.error);
  });
}

// ============================================================
// 今の世界を取り出す・書き戻す
// ============================================================
function worldStorage() {
  const out = {};
  for (const k of WORLD_KEYS) { const v = localStorage.getItem(k); if (v !== null) out[k] = v; }
  return out;
}
async function captureStorage() {
  const st = worldStorage();
  if (st['voxelcraft_ext_v1'] !== undefined && window.VoxelExt && VoxelExt.fullExtJson) {
    st['voxelcraft_ext_v1'] = await VoxelExt.fullExtJson();   // モデルの中身も含める（別の端末でも読めるように）
  }
  return st;
}
// 最後にいた場所の画像（画面を描き直して、小さく縮める）
function captureThumb() {
  try {
    if (typeof renderer === 'undefined' || typeof scene === 'undefined' || typeof camera === 'undefined') return null;
    renderer.render(scene, camera);
    const c = document.createElement('canvas');
    c.width = 192; c.height = 108;
    c.getContext('2d').drawImage(renderer.domElement, 0, 0, 192, 108);
    return c.toDataURL('image/jpeg', 0.72);
  } catch (e) { return null; }
}

// 基本のゲーム側の変数（let/const なので window からは取れない）
function isPlaying() { return typeof started !== 'undefined' && !!started; }
function curId() { try { return localStorage.getItem(CUR_KEY) || ''; } catch (e) { return ''; } }
function setCur(id) { try { if (id) localStorage.setItem(CUR_KEY, id); else localStorage.removeItem(CUR_KEY); } catch (e) {} }

// 今開いているワールドを、その番号の場所へ保存する
async function snapshotCurrent() {
  const id = curId();
  if (!id || !window.VoxelWorld) return;
  const s = VoxelWorld.buildSave();                         // 編集と、シード
  const storage = await captureStorage();
  const playing = isPlaying();
  const pos = playing ? { x: +player.pos.x.toFixed(1), y: +player.pos.y.toFixed(1), z: +player.pos.z.toFixed(1) } : null;
  const savedAt = Date.now();
  await put('w:' + id, { seed: s.seed, edits: s.base.edits, storage, sounds: s.sounds || [], savedAt });
  const idx = (await get('index')) || [];
  const m = idx.find(w => w.id === id);
  if (m) {
    m.savedAt = savedAt;
    if (pos) m.pos = pos;
    if (playing) { const t = captureThumb(); if (t) m.thumb = t; }
    await put('index', idx);
  }
}

// 世界を書き込み、再読み込みして開く（ページを読み直すと、各機能がこの内容で動き出す）
async function openWorld(id) {
  await snapshotCurrent();
  const rec = await get('w:' + id);
  if (!rec) { toast('ワールドが見つかりません'); return; }
  try {
    for (const k of WORLD_KEYS) localStorage.removeItem(k);
    for (const [k, v] of Object.entries(rec.storage || {})) {
      if (typeof v !== 'string' || !WORLD_KEYS.includes(k)) continue;
      if (k === 'voxelcraft_ext_v1' && window.VoxelExt && VoxelExt.importExtJson) await VoxelExt.importExtJson(v);
      else localStorage.setItem(k, v);
    }
    if (window.VoxelDia && VoxelDia.importSounds) await VoxelDia.importSounds(rec.sounds || []);
    await putPending(rec.seed ?? null, rec.edits || []);
  } catch (e) { toast('ワールドを開けませんでした（保存領域の容量が足りない可能性があります）'); return; }
  setCur(id);
  try { localStorage.setItem(OPEN_KEY, id); } catch (e) {}
  location.reload();
}

async function createWorld(name, seedText, flat) {
  await snapshotCurrent();
  const id = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const seed = flat && window.VoxelFlat ? VoxelFlat.FLAT_SEED : VoxelWorld.normalizeSeed(seedText);
  const now = Date.now();
  await put('w:' + id, { seed, edits: [], storage: {}, sounds: [], savedAt: now });
  const idx = (await get('index')) || [];
  idx.push({ id, name: name || ('ワールド' + (idx.length + 1)), seed, createdAt: now, savedAt: now, pos: null, thumb: null });
  await put('index', idx);
  await openWorld(id);
}

// 最初の起動・ファイルから読み込んだあとは、今の内容を一覧に入れる
async function adoptCurrentIfNeeded() {
  if (curId()) return;
  const id = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const s = VoxelWorld.buildSave();
  const storage = await captureStorage();
  const now = Date.now();
  await put('w:' + id, { seed: s.seed, edits: s.base.edits, storage, sounds: s.sounds || [], savedAt: now });
  const idx = (await get('index')) || [];
  idx.push({ id, name: '読み込んだワールド', seed: s.seed, createdAt: now, savedAt: now, pos: null, thumb: null });
  await put('index', idx);
  setCur(id);
}

// ============================================================
// 一覧の画面（タイトル画面に、一番上のカードとして出す）
// ============================================================
function fmt(t) {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function toast(t) { if (window.VoxelWorld && VoxelWorld.toast) VoxelWorld.toast(t); }

function injectStyle() {
  const st = document.createElement('style');
  st.textContent =
    '#vcwCard .w{display:flex;gap:10px;align-items:center;padding:8px;border-radius:8px;background:rgba(255,255,255,.06);margin-top:8px}' +
    '#vcwCard .w img,#vcwCard .w .ph{width:96px;height:54px;object-fit:cover;border-radius:6px;background:#0b1118;flex:none;display:block}' +
    '#vcwCard .t{flex:1;min-width:0}' +
    '#vcwCard .n{font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#vcwCard .m{font-size:11px;color:#9fb3c8;line-height:1.5}' +
    '#vcwCard .cur{color:#8fe3a0}' +
    '#vcwCard .b{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}' +
    '#vcwCard .b button{font-size:12px;padding:5px 10px;border-radius:6px;border:none;background:#2e6a9a;color:#fff;cursor:pointer}' +
    '#vcwCard .b button.d{background:#7a3b3b}' +
    '#vcwCard input{width:100%;box-sizing:border-box;background:#1f2b38;color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:6px;padding:9px;font-size:14px;margin-top:6px}' +
    '#vcwCard .go{display:block;width:100%;background:#2e6a9a;color:#fff;border:none;border-radius:8px;padding:11px;font-size:15px;margin-top:8px;cursor:pointer}' +
    '#vcwListBtn{position:fixed;left:10px;top:48px;z-index:6;display:none;background:rgba(0,0,0,.5);color:#fff;border:1px solid rgba(255,255,255,.4);border-radius:6px;padding:7px 11px;font-size:13px;cursor:pointer}';
  document.head.appendChild(st);
}

let listEl = null;
async function renderList() {
  if (!listEl) return;
  const idx = (await get('index').catch(() => null)) || [];
  const cur = curId();
  listEl.textContent = '';
  if (!idx.length) { const p = document.createElement('p'); p.className = 'm'; p.textContent = 'まだワールドがありません。下の「新しいワールド」で作れます。'; listEl.appendChild(p); return; }
  for (const w of idx.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))) {
    const row = document.createElement('div');
    row.className = 'w';
    if (w.thumb) { const im = document.createElement('img'); im.src = w.thumb; im.alt = ''; row.appendChild(im); }
    else { const ph = document.createElement('div'); ph.className = 'ph'; row.appendChild(ph); }
    const t = document.createElement('div'); t.className = 't';
    const n = document.createElement('div'); n.className = 'n'; n.textContent = (w.id === cur ? '● ' : '') + (w.name || 'ワールド');
    const m = document.createElement('div'); m.className = 'm';
    const kind = w.seed === (window.VoxelFlat && VoxelFlat.FLAT_SEED) ? 'フラット' : '通常';
    m.textContent = kind + '　最後に遊んだ: ' + fmt(w.savedAt || w.createdAt || 0) +
      (w.pos ? '　場所: ' + Math.round(w.pos.x) + ', ' + Math.round(w.pos.y) + ', ' + Math.round(w.pos.z) : '');
    if (w.id === cur) m.classList.add('cur');
    t.appendChild(n); t.appendChild(m);
    const b = document.createElement('div'); b.className = 'b';
    const open = document.createElement('button'); open.textContent = w.id === cur ? '続けて遊ぶ' : '開く';
    open.addEventListener('click', () => openWorld(w.id));
    const ren = document.createElement('button'); ren.textContent = '名前';
    ren.addEventListener('click', async () => {
      const v = prompt('ワールドの名前', w.name || '');
      if (v === null) return;
      const list = (await get('index')) || [];
      const mm = list.find(x => x.id === w.id); if (mm) { mm.name = v.trim().slice(0, 30) || mm.name; await put('index', list); }
      renderList();
    });
    const rm = document.createElement('button'); rm.textContent = '削除'; rm.className = 'd';
    rm.addEventListener('click', async () => {
      if (w.id === curId()) { toast('開いているワールドは削除できません（別のワールドを開いてから削除してください）'); return; }
      if (!confirm('「' + (w.name || 'ワールド') + '」を削除します。元に戻せません。よろしいですか？')) return;
      await del('w:' + w.id);
      const list = ((await get('index')) || []).filter(x => x.id !== w.id);
      await put('index', list);
      renderList();
    });
    b.appendChild(open); b.appendChild(ren); b.appendChild(rm);
    t.appendChild(b);
    row.appendChild(t);
    listEl.appendChild(row);
  }
}

function buildCard() {
  const title = document.getElementById('wsTitle');
  const h1 = title && title.querySelector('h1');
  if (!h1 || document.getElementById('vcwCard')) return;
  injectStyle();
  const card = document.createElement('div');
  card.className = 'card'; card.id = 'vcwCard';
  const h = document.createElement('h2'); h.textContent = 'ワールド一覧（この端末）';
  listEl = document.createElement('div');
  card.appendChild(h); card.appendChild(listEl);

  const h2 = document.createElement('h2'); h2.textContent = '新しいワールド'; h2.style.marginTop = '14px';
  const nameIn = document.createElement('input'); nameIn.placeholder = 'ワールドの名前（空欄で自動）'; nameIn.id = 'vcwName'; nameIn.maxLength = 30;
  const go = document.createElement('button'); go.className = 'go'; go.textContent = '作成して開く';
  go.addEventListener('click', () => {
    const flatSel = document.getElementById('flatSel');
    const flat = !!(flatSel && flatSel.value === 'flat');
    const seedText = (document.getElementById('wsSeed') || {}).value || '';
    createWorld(nameIn.value.trim(), seedText, flat);
  });
  card.appendChild(h2); card.appendChild(nameIn); card.appendChild(go);
  h1.parentNode.insertBefore(card, h1.nextSibling);
  renderList();
}

// 「新しいワールドで開始」は、一覧に入るように、こちらで作る
document.addEventListener('click', e => {
  const t = e.target;
  if (!t || t.id !== 'wsNew') return;
  e.stopImmediatePropagation();
  e.preventDefault();
  const flatSel = document.getElementById('flatSel');
  const flat = !!(flatSel && flatSel.value === 'flat');
  const seedText = (document.getElementById('wsSeed') || {}).value || '';
  createWorld('', seedText, flat);
}, true);

// ファイルから読み込むときは、今のワールドへ書き込まないように外しておく
document.addEventListener('change', e => {
  if (e.target && e.target.id === 'wsFile') setCur('');
}, true);

// ============================================================
// 遊んでいるあいだの保存・一覧へ戻るボタン
// ============================================================
function buildListButton() {
  if (document.getElementById('vcwListBtn')) return;
  const b = document.createElement('button');
  b.id = 'vcwListBtn'; b.textContent = 'ワールド一覧へ';
  b.addEventListener('click', async () => {
    await snapshotCurrent();
    try { localStorage.removeItem(OPEN_KEY); } catch (e) {}
    location.reload();
  });
  document.body.appendChild(b);
  setInterval(() => { b.style.display = isPlaying() ? 'block' : 'none'; }, 500);
}
setInterval(() => { if (isPlaying() && curId()) snapshotCurrent().catch(() => {}); }, 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') snapshotCurrent().catch(() => {}); });
window.addEventListener('pagehide', () => { snapshotCurrent().catch(() => {}); });

// ============================================================
// 起動
// ============================================================
async function boot() {
  // 直前に開いたワールドを、すぐ開始する
  let openId = '';
  try { openId = localStorage.getItem(OPEN_KEY) || ''; localStorage.removeItem(OPEN_KEY); } catch (e) {}
  // 画面（タイトル）ができるまで待つ
  const wait = setInterval(async () => {
    if (!document.getElementById('wsTitle')) return;
    clearInterval(wait);
    try { await adoptCurrentIfNeeded(); } catch (e) { console.error(e); }
    buildCard();
    buildListButton();
    if (openId && window.VoxelWorld && VoxelWorld.start) setTimeout(() => VoxelWorld.start(), 300);
  }, 200);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

window.VoxelWorlds = { list: () => get('index'), openWorld, createWorld, snapshotCurrent };
})();
