/* voxel-rt-state.js  道路・線路・列車・車・人混み・カスタムブロックなどの「作業データ」を部屋で共有する（第5段階の続き）
 *  ・対象：ワールドの保存に使っている10個の記録（localStorage の voxelcraft_*_v1）
 *  ・記録が大きい中身（カスタムブロックのテクスチャ・モデルなど）は、IndexedDB に別に置かれている。
 *    その中身も、部屋の記録（wb:…）に少しずつ分けて入れる（新しく入った人・GitHub の保存にも入る）
 *  ・この端末で変わったら部屋の記録（ws:…）に入れる。相手の変更は、画面を開いたまま反映しない。
 *    「反映して再読み込み」ボタンで反映する（中身がそろっているときだけ押せる）
 *  ・部屋に入ったとき：部屋に作業データが無ければ、この端末のものを部屋へ出す。あれば、確認してから読み込む
 *  注意：同じ記録を2人が同時に変えた場合は、新しい方が残る（片方の変更は消える）
 *  読み込み順：voxel-rt-gh.js の後
 */
(function () {
'use strict';

const L = window.VoxelRTLogic;
const KEYS = [
  'voxelcraft_road_v1', 'voxelcraft_dia_v1', 'voxelcraft_station_v1', 'voxelcraft_train_v1',
  'voxelcraft_traffic_v1', 'voxelcraft_crowd_v1', 'voxelcraft_ext_v1', 'voxelcraft_bag_v1',
  'voxelcraft_defdel_v1', 'voxelcraft_tilt_v1'
];
const POLL_MS = 2000;
const JOIN_CHECK_MS = 4000;
const PACE_MS = 40;                  // 送る1通ごとの間隔（一度にたくさん送らない）
const PART = 16000;                  // 中身を分ける大きさ（文字数）
const ADOPT_MARK = 'vcrt_adopt_at_v1';
const ADOPT_QUIET_MS = 15000;
const FP_KEY = 'vcrt_blobfp_v1';     // この端末に入れた中身の印（キー -> 印）

let rm = null;
let timers = [];
const lastSeen = new Map();          // キー -> 最後に見た、この端末の値（null は無し）
const sentFp = new Map();            // 部屋へ送った中身の印（キー -> 印）
let outQ = [], outTimer = null;
let banner = null, bannerMsg = null, bannerBtn = null;
let shown = '';
let localFps = {};

function getLocal(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function setLocal(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
function loadFps() { try { localFps = JSON.parse(localStorage.getItem(FP_KEY) || '{}') || {}; } catch (e) { localFps = {}; } }
function saveFps() { setLocal(FP_KEY, JSON.stringify(localFps)); }

function kvValue(room, k) {
  const e = room.kv.get('ws:' + k);
  return e && !e.del && typeof e.v === 'string' ? e.v : null;
}
// 記録の中で、大きい中身（IndexedDB のキー）を指している参照を集める
function refsOf(str) {
  const out = new Set();
  const re = /"__blob"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(str)) !== null) out.add(m[1]);
  return out;
}
// 中身の印（同じ中身なら同じ印）
function fpOf(text) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return text.length.toString(36) + '-' + h1.toString(36) + '-' + h2.toString(36);
}
const enc = key => encodeURIComponent(key);

// ---------- 送る（少しずつ） ----------
function pump() {
  if (outTimer) return;
  outTimer = setTimeout(stepOut, 0);
}
function stepOut() {
  outTimer = null;
  if (!rm) { outQ = []; return; }
  if (!outQ.length) return;
  const [key, value] = outQ.shift();
  try { rm.set(key, value); } catch (e) { console.error(e); }
  outTimer = setTimeout(stepOut, PACE_MS);
}
// 中身を、部屋の記録に分けて入れる（同じ中身は一度だけ）
function sendBlobRefs(room, str) {
  if (!window.VoxelExt || !VoxelExt.blobGet) return;
  for (const key of refsOf(str)) {
    Promise.resolve(VoxelExt.blobGet(key)).then(text => {
      if (rm !== room || typeof text !== 'string') return;
      const f = fpOf(text);
      if (sentFp.get(key) === f) return;
      sentFp.set(key, f);
      const n = Math.max(1, Math.ceil(text.length / PART));
      for (let i = 0; i < n; i++) outQ.push(['wb:' + enc(key) + '#' + i, text.slice(i * PART, (i + 1) * PART)]);
      outQ.push(['wb:' + enc(key) + '#n', { n, fp: f }]);
      pump();
    }, () => {});
  }
}

// この端末の変更を、部屋へ出す
function pushLocal(room, force) {
  for (const k of KEYS) {
    const cur = getLocal(k);
    if (!force && cur === lastSeen.get(k)) continue;
    lastSeen.set(k, cur);
    if (cur === null) room.del('ws:' + k);
    else { room.set('ws:' + k, cur); sendBlobRefs(room, cur); }
  }
}

// ---------- 受け取る（中身がそろったら、この端末に書く） ----------
function localFpOf(key) { return localFps[key] || null; }
function remoteMetaOf(room, key) {
  const m = room.kv.get('wb:' + enc(key) + '#n');
  return m && !m.del && m.v && typeof m.v.fp === 'string' ? m.v : null;
}
// その中身が、この端末にそろっているか
function blobReady(room, key) {
  const meta = remoteMetaOf(room, key);
  return !!meta && localFpOf(key) === meta.fp;
}
function assembleBlobs(room) {
  for (const k of KEYS) {
    const remote = kvValue(room, k);
    if (!remote) continue;
    for (const key of refsOf(remote)) {
      const meta = remoteMetaOf(room, key);
      if (!meta || localFpOf(key) === meta.fp) continue;
      let text = '';
      let complete = true;
      for (let i = 0; i < meta.n; i++) {
        const e = room.kv.get('wb:' + enc(key) + '#' + i);
        if (!e || e.del || typeof e.v !== 'string') { complete = false; break; }
        text += e.v;
      }
      if (!complete || fpOf(text) !== meta.fp) continue;
      const fp = meta.fp;
      if (!window.VoxelExt || !VoxelExt.blobPut) continue;
      Promise.resolve(VoxelExt.blobPut(key, text)).then(() => { localFps[key] = fp; saveFps(); }, () => {});
    }
  }
}
function allReady(room, diffs) {
  for (const k of Object.keys(diffs)) for (const key of refsOf(diffs[k])) if (!blobReady(room, key)) return false;
  return true;
}

// ---------- 部屋の内容と、この端末の違い ----------
function remoteDiffs(room) {
  const out = {};
  for (const k of KEYS) {
    const rv = kvValue(room, k);
    if (rv === null) continue;
    if (rv !== getLocal(k)) out[k] = rv;
  }
  return out;
}
function recentlyAdopted() {
  try { return Date.now() - Number(sessionStorage.getItem(ADOPT_MARK) || 0) < ADOPT_QUIET_MS; } catch (e) { return false; }
}
// 読み込んで、再読み込みする（部屋に入り直すために、招待リンクを #に入れておく）
function adoptAndReload(room, diffs) {
  for (const k of Object.keys(diffs)) setLocal(k, diffs[k]);
  try { sessionStorage.setItem(ADOPT_MARK, String(Date.now())); } catch (e) {}
  const inv = L.makeInvite(location.href, room.roomId, room.password);
  try { location.hash = inv.slice(inv.indexOf('#')); } catch (e) {}
  location.reload();
}

// 入ったとき：部屋に作業データが無ければ、この端末から出す。あれば、確認して読み込む
function joinCheck(room) {
  if (rm !== room) return;
  const hasRemote = KEYS.some(k => kvValue(room, k) !== null);
  if (!hasRemote) { pushLocal(room, true); return; }
  assembleBlobs(room);
  const diffs = remoteDiffs(room);
  if (!Object.keys(diffs).length) { pushLocal(room); return; }
  if (recentlyAdopted()) return;
  if (!allReady(room, diffs)) { showBanner(room); return; }
  const ok = window.confirm('この部屋の道路・線路・列車・カスタムブロックなどを、この端末に読み込みます。' +
    '（この端末で、この部屋とは別に作った分は置き換わります）よろしいですか？');
  if (ok) adoptAndReload(room, diffs);
  else showBanner(room);
}

// 画面を開いたまま、相手の変更が届いたとき：ボタンで反映する（画面は自動では変えない）
function checkLive(room) {
  if (rm !== room) return;
  assembleBlobs(room);
  pushLocal(room);
  const diffs = remoteDiffs(room);
  if (!Object.keys(diffs).length) { hideBanner(); return; }
  showBanner(room);
}

// ---------- 画面 ----------
function buildBanner() {
  banner = document.createElement('div');
  banner.id = 'rtStateBar';
  banner.style.cssText = 'position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:70;display:none;' +
    'background:rgba(40,60,90,.95);color:#fff;border-radius:10px;padding:8px 12px;font:14px/1.5 system-ui,sans-serif;' +
    'box-shadow:0 2px 8px rgba(0,0,0,.4);max-width:92vw;align-items:center;gap:10px';
  bannerMsg = document.createElement('span');
  bannerBtn = document.createElement('button');
  bannerBtn.textContent = '反映して再読み込み';
  bannerBtn.style.cssText = 'background:#2e6a9a;color:#fff;border:none;border-radius:6px;padding:6px 10px;font-size:14px';
  bannerBtn.addEventListener('click', () => {
    if (!rm) return;
    assembleBlobs(rm);
    const diffs = remoteDiffs(rm);
    if (!Object.keys(diffs).length) { hideBanner(); return; }
    if (!allReady(rm, diffs)) { bannerMsg.textContent = '大きいデータを受け取っています。そろってからもう一度押してください。'; return; }
    adoptAndReload(rm, diffs);
  });
  banner.appendChild(bannerMsg);
  banner.appendChild(bannerBtn);
  document.body.appendChild(banner);
}
function showBanner(room) {
  if (!banner) return;
  const diffs = remoteDiffs(room);
  const keys = Object.keys(diffs).join(',');
  banner.style.display = 'flex';
  if (keys === shown && bannerMsg.textContent) return;
  shown = keys;
  bannerMsg.textContent = allReady(room, diffs)
    ? '他の人が道路・列車・カスタムブロックなどを変更しました。'
    : '他の人が変更しました。大きいデータを受け取っています…';
}
function hideBanner() { if (banner) banner.style.display = 'none'; shown = ''; }

// ---------- 部屋に入った・出た ----------
function attach(room) {
  timers.forEach(t => { clearInterval(t); clearTimeout(t); }); timers = [];
  outQ = []; if (outTimer) { clearTimeout(outTimer); outTimer = null; }
  rm = room || null;
  lastSeen.clear(); sentFp.clear();
  hideBanner();
  if (!rm) return;
  loadFps();
  for (const k of KEYS) lastSeen.set(k, getLocal(k));
  timers.push(setInterval(() => checkLive(room), POLL_MS));
  timers.push(setTimeout(() => joinCheck(room), JOIN_CHECK_MS));
}

function startUp() {
  buildBanner();
  if (window.VoxelRTUI && window.VoxelRTUI.onRoom) window.VoxelRTUI.onRoom(attach);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startUp);
else startUp();

window.VoxelRTState = { KEYS, refsOf, fpOf, pushLocal, remoteDiffs, assembleBlobs, joinCheck, checkLive, allReady, pending: () => outQ.length };
})();
