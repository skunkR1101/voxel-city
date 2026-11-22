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
  'voxelcraft_defdel_v1', 'voxelcraft_tilt_v1', 'voxelcraft_bstate_v1', 'voxelcraft_ship_v1'
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
// 中身を部品に分ける。文字の途中（二つに割れる文字）では切らない。部品ごとの印も作る（届いたかを一つずつ確かめるため）
function splitText(text, size) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let e = Math.min(text.length, i + size);
    if (e < text.length) { const c = text.charCodeAt(e - 1); if (c >= 0xD800 && c <= 0xDBFF) e--; }
    out.push(text.slice(i, e));
    i = e;
  }
  if (!out.length) out.push('');
  return out;
}
function packBlob(text) {
  const parts = splitText(text, PART);
  return { parts, meta: { n: parts.length, fp: fpOf(text), ph: parts.map(fpOf) } };
}
function queueBlob(key, pk) {
  for (let i = 0; i < pk.parts.length; i++) outQ.push(['wb:' + enc(key) + '#' + i, pk.parts[i]]);
  outQ.push(['wb:' + enc(key) + '#n', pk.meta]);   // 目次は部品のあとに送る
}
const problems = new Map();        // キー -> 届かない理由（画面に出す）
const partSeen = new WeakMap();    // 部品の確かめ結果（同じ部品の印を、毎回計算しないため）
const pendingPut = new Set();

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
// 統一のとき：指定した素材を、今この端末が持っている中身で全部送り直す（部屋の古い部分と混ざらないように）
function resendBlobs(room, keys) {
  if (!window.VoxelExt || !VoxelExt.blobGet) return Promise.resolve();
  const jobs = keys.map(key => Promise.resolve(VoxelExt.blobGet(key)).then(text => {
    if (rm !== room || typeof text !== 'string') return;
    const pk = packBlob(text);
    sentFp.set(key, pk.meta.fp);
    queueBlob(key, pk);
  }, () => {}));
  return Promise.all(jobs).then(() => pump());
}
// 中身を、部屋の記録に分けて入れる（同じ中身は一度だけ）
function sendBlobRefs(room, str) {
  if (!window.VoxelExt || !VoxelExt.blobGet) return;
  for (const key of refsOf(str)) {
    Promise.resolve(VoxelExt.blobGet(key)).then(text => {
      if (rm !== room || typeof text !== 'string') return;
      const pk = packBlob(text);
      if (sentFp.get(key) === pk.meta.fp) return;
      sentFp.set(key, pk.meta.fp);
      queueBlob(key, pk);
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
// 部品の状態：ok（届いて、印も合う）／missing（まだ）／bad（届いたが中身が合わない）
function partState(room, key, i, meta) {
  const e = room.kv.get('wb:' + enc(key) + '#' + i);
  if (!e || e.del || typeof e.v !== 'string') return 'missing';
  if (!meta.ph) return 'ok';
  const c = partSeen.get(e);
  if (c && c.ph === meta.ph) return c.r;
  const r = fpOf(e.v) === meta.ph[i] ? 'ok' : 'bad';
  partSeen.set(e, { ph: meta.ph, r });
  return r;
}
function partsState(room, key, meta) {
  let missing = 0, bad = 0, text = '';
  for (let i = 0; i < meta.n; i++) {
    const r = partState(room, key, i, meta);
    if (r === 'missing') missing++;
    else if (r === 'bad') bad++;
    else text += room.kv.get('wb:' + enc(key) + '#' + i).v;
  }
  return { missing, bad, text: (missing || bad) ? null : text };
}
// 端末に書く（失敗したら、少し待って何度か試す。そのあとは理由を画面に出す）
function putBlob(key, text, fp, tries) {
  if (pendingPut.has(key)) return;
  pendingPut.add(key);
  Promise.resolve().then(() => VoxelExt.blobPut(key, text)).then(() => {
    pendingPut.delete(key);
    localFps[key] = fp; saveFps(); problems.delete(key);
  }, () => {
    pendingPut.delete(key);
    if (tries < 3) setTimeout(() => putBlob(key, text, fp, tries + 1), 800);
    else problems.set(key, '端末に保存できませんでした（この端末の保存領域を確かめてください）');
  });
}
function assembleBlobs(room, force) {
  if (!window.VoxelExt || !VoxelExt.blobPut) return;
  for (const k of KEYS) {
    const remote = kvValue(room, k);
    if (!remote) continue;
    for (const key of refsOf(remote)) {
      const meta = remoteMetaOf(room, key);
      if (!meta) { problems.set(key, '素材の目次がまだ届いていません'); continue; }
      if (!force && localFpOf(key) === meta.fp) { problems.delete(key); continue; }   // force: 統一のときは、この端末の同じ名前の中身も書き直す
      const ps = partsState(room, key, meta);
      if (ps.missing) { problems.set(key, '素材の部品がまだ ' + ps.missing + ' 個届いていません'); continue; }
      if (ps.bad) { problems.set(key, '素材の部品 ' + ps.bad + ' 個の中身が合いません（送り直しを頼みます）'); continue; }
      if (fpOf(ps.text) !== meta.fp) { problems.set(key, '素材の全体の印が合いません（送り直しを頼みます）'); continue; }
      putBlob(key, ps.text, meta.fp, 0);
    }
  }
}
function allReady(room, diffs) {
  for (const k of Object.keys(diffs)) for (const key of refsOf(diffs[k])) if (!blobReady(room, key)) return false;
  return true;
}

// ---------- 部屋の内容と、この端末の違い ----------
const EXT_K = 'voxelcraft_ext_v1';   // カスタムブロックの設定：ボタンなしで、すぐ反映する（checkLive で扱う）
let extBusy = false;
function remoteDiffs(room) {
  const out = {};
  for (const k of KEYS) {
    if (k === EXT_K) continue;
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
  if (window.VoxelRTUnify && VoxelRTUnify.busy()) return;
  for (const k of Object.keys(diffs)) setLocal(k, diffs[k]);
  try { sessionStorage.setItem(ADOPT_MARK, String(Date.now())); } catch (e) {}
  const inv = L.makeInvite(location.href, room.roomId, room.password);
  try { location.hash = inv.slice(inv.indexOf('#')); } catch (e) {}
  location.reload();
}

// 入ったとき：部屋に作業データが無ければ、この端末から出す。あれば、確認して読み込む
function joinCheck(room) {
  if (rm !== room) return;
  if (window.VoxelRTUnify && VoxelRTUnify.busy()) return;   // 統一の読み込みが先（統一の方で扱う）
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
// 車両（train）とダイヤ（dia）は、相手の変更を、確認なしでそのまま反映する（素材がそろってから）
const AUTO = { voxelcraft_train_v1: 'train', voxelcraft_dia_v1: 'dia', voxelcraft_ship_v1: 'ship' };
function autoApply(room) {
  for (const k of Object.keys(AUTO)) {
    const rv = kvValue(room, k);
    if (rv === null || rv === getLocal(k)) continue;
    if (!allReady(room, { [k]: rv })) continue;
    if (!setLocal(k, rv)) continue;
    lastSeen.set(k, rv);                       // 受け取った内容を、そのまま送り返さない
    const m = window.VoxelSync && VoxelSync[AUTO[k]];
    if (m && typeof m.reload === 'function') { try { m.reload(); } catch (e) { console.error(e); } }
  }
}
function checkLive(room) {
  if (rm !== room) return;
  if (window.VoxelRTUnify && VoxelRTUnify.busy()) { hideBanner(); return; }
  assembleBlobs(room);
  pushLocal(room);
  autoApply(room);
  // カスタムブロックの追加・カテゴリ移動は、画面を変えずにそのまま反映する
  const rext = kvValue(room, EXT_K);
  if (rext !== null && rext !== getLocal(EXT_K) && !extBusy && window.VoxelExt && VoxelExt.applyRemoteExt) {
    extBusy = true;
    Promise.resolve(VoxelExt.applyRemoteExt(rext)).then(r => {
      extBusy = false;
      if (r === 'applied' && rm === room) lastSeen.set(EXT_K, getLocal(EXT_K));
    }, e => { extBusy = false; console.error(e); });
  }
  const diffs = remoteDiffs(room);
  if (!Object.keys(diffs).length) { hideBanner(); return; }
  showBanner(room);   // 道路などの変更だけ、設定メニュー内の表示で知らせる
}

// ---------- 画面 ----------
function buildBanner() {
  banner = document.createElement('div');
  banner.id = 'rtStateBar';
  banner.style.cssText = 'display:none;margin-top:8px;' +
    'background:rgba(40,60,90,.95);color:#fff;border-radius:10px;padding:8px 12px;font:14px/1.5 system-ui,sans-serif;' +
    'box-shadow:0 2px 8px rgba(0,0,0,.4);max-width:92vw;align-items:center;gap:10px';
  bannerMsg = document.createElement('span');
  bannerBtn = document.createElement('button');
  bannerBtn.textContent = '反映して再読み込み';
  bannerBtn.style.cssText = 'background:#2e6a9a;color:#fff;border:none;border-radius:6px;padding:6px 10px;font-size:14px';
  bannerBtn.addEventListener('click', () => {
    if (!rm) return;
    if (window.VoxelRTUnify && VoxelRTUnify.busy()) return;
    assembleBlobs(rm);
    const diffs = remoteDiffs(rm);
    if (!Object.keys(diffs).length) { hideBanner(); return; }
    if (!allReady(rm, diffs)) { bannerMsg.textContent = '大きいデータを受け取っています。そろってからもう一度押してください。'; return; }
    adoptAndReload(rm, diffs);
  });
  banner.appendChild(bannerMsg);
  banner.appendChild(bannerBtn);
  // 設定メニュー（部屋の欄）の中に置く。画面の上には出さない
  let tries = 0;
  const place = setInterval(() => {
    const host = document.getElementById('rtCard');
    tries++;
    if (host && host.parentNode) { clearInterval(place); host.parentNode.insertBefore(banner, host.nextSibling); }
    else if (tries > 100) clearInterval(place);
  }, 200);
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
  try { room.on('need', (key, v) => onNeed(room, v)); } catch (e) { console.error(e); }
}

// ---------- 素材の受け取りの進み具合・取り直し ----------
// 届いた素材の数と全体（かけら単位）、まだ足りない素材の鍵
function blobProgress(room, diffs) {
  let total = 0, ready = 0;
  const missing = [], seen = new Set();
  for (const k of Object.keys(diffs)) {
    for (const key of refsOf(diffs[k])) {
      if (seen.has(key)) continue;
      seen.add(key);
      const meta = remoteMetaOf(room, key);
      if (!meta) { total += 1; missing.push(key); continue; }
      total += meta.n;
      for (let i = 0; i < meta.n; i++) if (partState(room, key, i, meta) === 'ok') ready++;
      if (!blobReady(room, key)) missing.push(key);
    }
  }
  return { total, ready, missing, problems: [...problems.values()].slice(0, 2) };
}
// 足りない素材を、部屋の相手に送り直してもらう（少し間をあけて、何度でも頼む）
let lastNeedAt = 0;
function askResend(room, keys) {
  const t = Date.now();
  if (!keys.length || t - lastNeedAt < 10000) return;
  lastNeedAt = t;
  try { room.ephemeral('need:' + room.peerId, { keys: keys.slice(0, 40) }); } catch (e) { console.error(e); }
}
// 送り直しの依頼が来たら、この端末が持っている素材を、もう一度部屋へ送る（中身が同じでも送り直す）
function onNeed(room, v) {
  if (rm !== room || !v) return;
  if (v.uni !== undefined) { if (window.VoxelRTUnify && VoxelRTUnify.onNeedUni) VoxelRTUnify.onNeedUni(room, v); return; }
  if (!Array.isArray(v.keys) || !window.VoxelExt || !VoxelExt.blobGet) return;
  for (const key of v.keys.slice(0, 40)) {
    if (typeof key !== 'string' || !key) continue;
    Promise.resolve(VoxelExt.blobGet(key)).then(text => {
      if (rm !== room || typeof text !== 'string') return;
      queueBlob(key, packBlob(text));
      pump();
    }, () => {});
  }
}
// この端末に無い素材の鍵（統一の前に、送れない素材がないか確かめる）
async function missingLocalBlobs() {
  const out = [];
  if (!window.VoxelExt || !VoxelExt.blobGet) return out;
  const seen = new Set();
  for (const k of KEYS) {
    const text = getLocal(k);
    if (!text) continue;
    for (const key of refsOf(text)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const v = await Promise.resolve(VoxelExt.blobGet(key)).catch(() => null);
      if (typeof v !== 'string') out.push(key);
    }
  }
  return out;
}

function startUp() {
  buildBanner();
  if (window.VoxelRTUI && window.VoxelRTUI.onRoom) window.VoxelRTUI.onRoom(attach);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startUp);
else startUp();

window.VoxelRTState = { KEYS, refsOf, fpOf, pushLocal, remoteDiffs, assembleBlobs, joinCheck, checkLive, allReady, pending: () => outQ.length,
  forgetSent: () => sentFp.clear(), blobProgress, askResend, missingLocalBlobs, resendBlobs, splitText, packBlob };   // 送った中身の記録を消す（次の pushLocal で、中身をすべて送り直す）
})();
