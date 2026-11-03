/* voxel-rt-gh.js  部屋の作業を GitHub に保存・読み込み（第5段階・ブロックの分）
 *  ・保存先：リポジトリの worlds/<部屋ID>.json（1つのファイル）。トークンは端末の中だけ（設定の「マルチ」で登録したもの）
 *  ・保存の中身：部屋の記録（blk:…）の全部。新しい方を残す（時刻つき）ので、同時に保存されても消えない
 *  ・保存は、変更が止まってから30秒後に自動で行う。手動の「今すぐ保存」もある
 *  ・部屋に入って少ししたら、保存の内容を読み込んで、足りない分を埋める
 *  ・保存するとき、GitHub の上の版を読んでから書く（同時に書かれたら、読み直してやり直す）
 *  依存：voxel-rt-world.js の後（部屋・画面の反映を使う）
 */
(function () {
'use strict';

const GH_KEY = 'voxelcraft_gh_v1';          // 既存の形式 {repo, token}
const POLL_MS = 3000;
const QUIET_MS = 30000;                      // 変更が止まってから、この時間後に自動保存
const LOAD_AFTER_JOIN_MS = 4000;
const FILE_VERSION = 1;

let rm = null;
let timers = [];
let changedAt = 0, pending = false, busy = false;

// ---------- 設定・通信 ----------
function normRepo(s) {
  return String(s || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
}
function ghCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(GH_KEY) || 'null');
    if (!c || !c.repo || !c.token) return null;
    return { repo: normRepo(c.repo), token: String(c.token).trim() };
  } catch (e) { return null; }
}
function errText(status) {
  const m = {
    401: 'トークンが正しくありません（貼り付けミス・期限切れ）',
    403: '書き込み権限がありません（トークンの Contents を Read and write にしてください）',
    404: 'リポジトリが見つからないか、トークンの対象外です',
    422: '保存できませんでした（データが大きすぎるなど）'
  };
  return m[status] || ('GitHub との通信に失敗しました（' + status + '）');
}
function headers(c, raw) {
  return { Authorization: 'Bearer ' + c.token, Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json' };
}
function b64Enc(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64Dec(str) {
  const bin = atob(String(str).replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(out);
}
function pathOf(roomId) { return 'worlds/' + encodeURIComponent(roomId) + '.json'; }
function urlOf(c, path) { return 'https://api.github.com/repos/' + c.repo + '/contents/' + path; }

// ファイルを読む（無ければ null）。大きいファイルは raw で読む
async function getFile(c, path) {
  const r = await fetch(urlOf(c, path), { headers: headers(c), cache: 'no-store' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(errText(r.status));
  const j = await r.json();
  let text;
  if (j.content && j.encoding === 'base64') text = b64Dec(j.content);
  else {
    const rr = await fetch(urlOf(c, path), { headers: headers(c, true), cache: 'no-store' });
    if (!rr.ok) throw new Error(errText(rr.status));
    text = await rr.text();
  }
  return { sha: j.sha, json: JSON.parse(text) };
}
// ファイルを書く。他の人が先に書いていたら 'conflict'
async function putFile(c, path, obj, sha, message) {
  const body = { message, content: b64Enc(JSON.stringify(obj)) };
  if (sha) body.sha = sha;
  let res = null;
  for (let i = 0; i < 3 && !res; i++) {                 // 電波の一時的な失敗は、少し待って再送
    try {
      const ctl = new AbortController();
      const tmo = setTimeout(() => ctl.abort(), 30000);
      try {
        res = await fetch(urlOf(c, path), { method: 'PUT', headers: { ...headers(c), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      } finally { clearTimeout(tmo); }
      if (res.status >= 500) res = null;
    } catch (e) { res = null; }
    if (!res) await new Promise(r => setTimeout(r, 600 * (i + 1)));
  }
  if (!res) throw new Error('GitHub に届きませんでした（通信が不安定です）');
  if (res.status === 409) return 'conflict';
  if (!res.ok) {
    let msg = ''; try { msg = (await res.json()).message || ''; } catch (e) {}
    throw new Error(errText(res.status) + (msg ? '［' + msg + '］' : ''));
  }
  let newSha = null;
  try { const j = await res.json(); newSha = (j.content && j.content.sha) || null; } catch (e) {}
  return { ok: true, sha: newSha };
}

// ---------- 部屋との出入り ----------
// 新しい方を残す（同じ時刻なら、作った人の名前の大きい方）
function isNewer(e, cur) {
  if (!cur) return true;
  if (e.ts !== cur.ts) return e.ts > cur.ts;
  return String(e.peer) > String(cur.peer);
}
// 保存の中身を部屋へ入れる（足りない・古いものだけ）。入ったものは、画面の反映にも回す
function mergeInto(room, entries) {
  const changed = [];
  for (const [key, e] of entries) {
    if (typeof key !== 'string' || !e || typeof e.ts !== 'number') continue;
    if (!isNewer(e, room.kv.get(key))) continue;
    if (room.write(key, e, true)) changed.push([key, e]);
  }
  if (changed.length && window.VoxelRTWorld) window.VoxelRTWorld.apply(changed);
  return changed.length;
}

// 今の部屋の内容を GitHub へ保存する。戻り値：保存したときの件数
async function saveRoom(room) {
  const c = ghCfg();
  if (!c) throw new Error('GitHub のトークンが、この端末にありません（設定の「マルチ」で登録してください）');
  const path = pathOf(room.roomId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await getFile(c, path);
    if (cur && cur.json && Array.isArray(cur.json.entries)) mergeInto(room, cur.json.entries);
    const entries = [...room.kv.entries()];
    const obj = { v: FILE_VERSION, room: room.roomId, saved: new Date().toISOString(), entries };
    const r = await putFile(c, path, obj, cur ? cur.sha : null, 'world save: ' + room.roomId);
    if (r !== 'conflict') {
      pending = false;
      return entries.length;
    }
  }
  throw new Error('ほかの人が同時に保存していて、保存できませんでした。もう一度押してください');
}
// GitHub の内容を部屋へ読み込む。戻り値：増えた件数（保存が無いときは -1）
async function loadRoom(room) {
  const c = ghCfg();
  if (!c) throw new Error('GitHub のトークンが、この端末にありません');
  const cur = await getFile(c, pathOf(room.roomId));
  if (!cur || !cur.json || !Array.isArray(cur.json.entries)) return -1;
  return mergeInto(room, cur.json.entries);
}

// ---------- 画面（部屋パネルの下） ----------
let statusEl, saveBtn, loadBtn;
function setStatus(t) { if (statusEl) statusEl.textContent = t; }
function updateButtons() {
  const on = !!rm;
  if (saveBtn) saveBtn.disabled = !on || busy;
  if (loadBtn) loadBtn.disabled = !on || busy;
}
function buildCard() {
  const host = document.getElementById('rtCard');
  if (!host) return;
  const box = document.createElement('div');
  box.className = 'card';
  box.style.marginTop = '8px';
  const h = document.createElement('h2'); h.textContent = 'GitHub に保存（部屋の作業）';
  box.appendChild(h);
  statusEl = document.createElement('p'); statusEl.className = 'm';
  statusEl.textContent = ghCfg() ? '部屋に入ると、変更が止まって30秒後に自動で保存されます' : 'GitHub のトークンが、この端末にありません（設定の「マルチ」で登録）';
  box.appendChild(statusEl);
  saveBtn = document.createElement('button'); saveBtn.className = 'go'; saveBtn.textContent = '今すぐ保存';
  saveBtn.addEventListener('click', () => manualSave());
  box.appendChild(saveBtn);
  loadBtn = document.createElement('button'); loadBtn.className = 'go sub'; loadBtn.textContent = 'GitHub から読み込む';
  loadBtn.addEventListener('click', () => manualLoad());
  box.appendChild(loadBtn);
  host.parentNode.insertBefore(box, host.nextSibling);
  updateButtons();
}
async function manualSave() {
  if (!rm) return;
  busy = true; updateButtons(); setStatus('保存しています…');
  try { const n = await saveRoom(rm); setStatus('保存しました（' + n + ' 件）'); }
  catch (e) { setStatus('保存できませんでした：' + (e && e.message || e)); }
  finally { busy = false; updateButtons(); }
}
async function manualLoad() {
  if (!rm) return;
  busy = true; updateButtons(); setStatus('読み込んでいます…');
  try {
    const n = await loadRoom(rm);
    setStatus(n < 0 ? 'まだ保存がありません' : (n ? '読み込みました（新しく入った ' + n + ' 件）' : '読み込みました（新しいものはありませんでした）'));
  } catch (e) { setStatus('読み込めませんでした：' + (e && e.message || e)); }
  finally { busy = false; updateButtons(); }
}

// ---------- 自動保存（変更が止まって30秒たったら保存） ----------
let seenN = -1, seenX = -1, pollT = null;
function tick() {
  if (!rm || busy) return;
  const n = rm.dig.n, x = rm.dig.x;
  if (n !== seenN || x !== seenX) { seenN = n; seenX = x; changedAt = Date.now(); pending = true; }
  if (pending && Date.now() - changedAt >= QUIET_MS && ghCfg()) {
    busy = true; updateButtons();
    setStatus('自動で保存しています…');
    saveRoom(rm).then(k => setStatus('自動保存しました（' + k + ' 件）'))
      .catch(e => { changedAt = Date.now(); setStatus('自動保存できませんでした：' + (e && e.message || e)); })
      .finally(() => { busy = false; updateButtons(); });
  }
}

// ---------- 部屋に入った・出た ----------
function attach(room) {
  timers.forEach(clearTimeout); timers = [];
  if (pollT) { clearInterval(pollT); pollT = null; }
  const left = rm;
  // 部屋を出るとき、変更が残っていれば、出る前の部屋の内容を保存する
  if (!room && left && pending && ghCfg()) saveRoom(left).catch(() => {});
  rm = room || null;
  seenN = -1; seenX = -1; pending = false;
  if (!rm) { setStatus(ghCfg() ? '部屋に入ると、変更が止まって30秒後に自動で保存されます' : 'GitHub のトークンが、この端末にありません（設定の「マルチ」で登録）'); updateButtons(); return; }
  pollT = setInterval(tick, POLL_MS);
  // 入ってしばらくしたら、保存の内容を読み込む
  timers.push(setTimeout(() => { if (rm === room && ghCfg()) manualLoadQuiet(room); }, LOAD_AFTER_JOIN_MS));
  updateButtons();
}
async function manualLoadQuiet(room) {
  busy = true; updateButtons();
  try {
    const n = await loadRoom(room);
    if (rm === room) setStatus(n < 0 ? 'この部屋の保存は、まだありません' : (n ? '保存から ' + n + ' 件読み込みました' : '保存と同じ内容です'));
  } catch (e) { if (rm === room) setStatus('読み込めませんでした：' + (e && e.message || e)); }
  finally { busy = false; updateButtons(); }
}

// ---------- 起動 ----------
function startUp() {
  buildCard();
  if (window.VoxelRTUI && window.VoxelRTUI.onRoom) window.VoxelRTUI.onRoom(attach);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startUp);
else startUp();

window.VoxelRTGh = { saveRoom, loadRoom, mergeInto, ghCfg, pathOf };
})();
