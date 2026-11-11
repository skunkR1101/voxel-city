/* voxel-craft-economy.js  端末の「経済」アプリ（段階2）
 *
 *  ・会社の一覧（管理・加入・全て）、会社の詳細（社長名・コンセプト・総貯金・収益・メンバー）
 *  ・新規起業（会社名・社長名（複数）・コンセプト・アイコン）
 *  ・スカウト（会社のメンバーが、まだ入っていない人を誘う）→ 相手が「申請」タブで承認して加入
 *  ・送金（自社の貯金から、ほかの会社へ。整数の円）
 *
 *  保存の仕組み：部屋に入っている間は、部屋の共有データ（eco: で始まる記録）に保存し、みんなで同じ内容を見る。
 *  部屋に入っていないときは、この端末の中だけに保存する（ひとりで試せる）。
 *  取引は、1件ずつ別の記録にして残す（同時に操作しても、記録が上書きされないように）。
 *  ※ 残高の確認は、この端末に届いている記録で行う。同時に大きな送金をすると、残高を超えることがあり得る。
 *
 *  読み込み：voxel-craft-phone.js の後に、voxel-craft-ext.js が自動で読み込む
 */
(function () {
'use strict';
if (window.VoxelEconomy) return;

const UID_KEY = 'vcEco_uid_v1';
const NAME_KEY = 'vcrt_name_v1';          // 部屋の通信で使っている名前（同じものを使う）
const LOCAL_KEY = 'eco:local';            // 部屋に入っていないときの保存先（端末の保存領域）
const LIM = { name: 20, pres: 10, presName: 16, concept: 200 };

// ---------- 準備 ----------
let VX = null;
const local = new Map();                 // 部屋に入っていないときの記録
let localReady = false, saveT = 0;
const subs = new Set();
let hooked = null;

function uidOf() {
  try {
    let u = localStorage.getItem(UID_KEY);
    if (!u) { u = 'u' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); localStorage.setItem(UID_KEY, u); }
    return u;
  } catch (e) { return 'u' + Math.random().toString(36).slice(2, 10); }
}
const ME = uidOf();
function myName() {
  try { return (localStorage.getItem(NAME_KEY) || '').trim() || 'プレイヤー'; } catch (e) { return 'プレイヤー'; }
}
function clean(s, max) {
  return Array.from(String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()).slice(0, max).join('');
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function newId(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function yen(n) { return Number(n || 0).toLocaleString('ja-JP') + '円'; }

// ---------- 保存（部屋の共有データ／この端末だけ） ----------
function room() {
  const r = window.VoxelRTUI && VoxelRTUI.room && VoxelRTUI.room();
  return r && r.active ? r : null;
}
function inRoom() { return !!room(); }
function notify() { for (const f of subs) { try { f(); } catch (e) { console.error(e); } } }

function localLoad() {
  if (localReady || !VX) return;
  localReady = true;
  VX.blobGet(LOCAL_KEY).then(s => {
    if (typeof s === 'string') { try { for (const [k, v] of JSON.parse(s)) local.set(k, v); } catch (e) {} }
    notify();
  }).catch(() => {});
}
function localSave() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { if (VX) VX.blobPut(LOCAL_KEY, JSON.stringify([...local])).catch(() => {}); }, 300);
}
function getv(k) {
  const r = room();
  if (r) { const e = r.kv.get(k); return e && !e.del && e.v !== undefined ? e.v : undefined; }
  return local.get(k);
}
function entries(prefix) {
  const out = [];
  const r = room();
  if (r) {
    for (const [k, e] of r.kv) if (k.startsWith(prefix) && !e.del && e.v !== undefined) out.push(e.v);
  } else {
    for (const [k, v] of local) if (k.startsWith(prefix)) out.push(v);
  }
  return out;
}
function put(k, v) {
  const r = room();
  if (r) r.set(k, v);
  else { local.set(k, v); localSave(); }
  notify();
}

// 部屋に入った・動きがあったら、画面を更新する
setInterval(() => {
  const r = room();
  if (r && r !== hooked) {
    hooked = r;
    r.onEvent((n, d) => { if (n === 'change' && d && String(d.key).startsWith('eco:')) notify(); });
    presence();
    notify();
  }
  if (!r && hooked) { hooked = null; notify(); }
}, 800);

// ---------- 記録の読み取り ----------
function companies() { return entries('eco:co:').filter(c => c && c.id); }
function company(cid) { return getv('eco:co:' + cid) || null; }
function roleOf(cid) { const m = getv('eco:mem:' + cid + ':' + ME); return m ? m.role : null; }   // 'admin' | 'member' | null
function members(cid) { return entries('eco:mem:' + cid + ':').filter(m => m && m.uid); }
function txs(cid) { return entries('eco:tx:').filter(t => t && t.cid === cid); }
function totals(cid) {
  let bal = 0, inc = 0;
  for (const t of txs(cid)) { bal += Number(t.amount) || 0; if (t.kind === 'income') inc += Number(t.amount) || 0; }
  return { bal, inc };
}
function scouts() { return entries('eco:scout:').filter(s => s && s.sid); }
function players() { return entries('eco:who:').filter(p => p && p.uid && p.uid !== ME); }
function myCompanies(kind) {
  return companies().filter(c => {
    const r = roleOf(c.id);
    if (kind === 'admin') return r === 'admin';
    if (kind === 'member') return r === 'member';
    return !!r;
  });
}

// ---------- 操作（入力を確かめてから書く） ----------
function presence() {
  if (!inRoom() && !VX) return;
  put('eco:who:' + ME, { uid: ME, name: myName(), ts: Date.now() });
}
function createCompany(d) {
  const name = clean(d.name, LIM.name);
  const presidents = (d.presidents || []).map(x => clean(x, LIM.presName)).filter(Boolean).slice(0, LIM.pres);
  const concept = clean(d.concept, LIM.concept);
  if (!name) return '会社名を入れてください';
  if (presidents.length === 0) return '社長名を1人以上入れてください';
  const id = newId('c');
  const ts = Date.now();
  put('eco:co:' + id, { id, name, presidents, concept, icon: d.icon || null, owner: ME, ts });
  put('eco:mem:' + id + ':' + ME, { cid: id, uid: ME, role: 'admin', name: myName(), ts });
  return null;
}
function canScout(cid, targetUid) {
  if (!roleOf(cid)) return '（この会社のメンバーだけがスカウトできます）';
  if (getv('eco:mem:' + cid + ':' + targetUid)) return 'この人は、もうこの会社に入っています';
  const pending = scouts().some(s => s.cid === cid && s.target === targetUid && s.status === 'pending');
  if (pending) return 'すでにスカウトを送っています（返事を待ちましょう）';
  return null;
}
function scoutPlayer(cid, target) {
  const err = canScout(cid, target.uid);
  if (err) return err;
  const sid = newId('s');
  put('eco:scout:' + sid, { sid, cid, target: target.uid, targetName: target.name, by: ME, byName: myName(), ts: Date.now(), status: 'pending' });
  return null;
}
function respondScout(sid, accept) {
  const s = getv('eco:scout:' + sid);
  if (!s || s.target !== ME || s.status !== 'pending') return 'この申請は、もう処理できません';
  if (accept && !getv('eco:co:' + s.cid)) return 'この会社は、もうありません';
  put('eco:scout:' + sid, Object.assign({}, s, { status: accept ? 'accepted' : 'rejected', ts: Date.now() }));
  if (accept && !roleOf(s.cid)) put('eco:mem:' + s.cid + ':' + ME, { cid: s.cid, uid: ME, role: 'member', name: myName(), ts: Date.now() });   // 既に入っている人の役目は変えない
  return null;
}
function sendMoney(fromCid, toCid, amount) {
  if (!Number.isInteger(amount) || amount < 1) return '金額は1円以上の整数で入れてください';
  if (fromCid === toCid) return '同じ会社には送金できません';
  if (!roleOf(fromCid)) return 'この会社から送金する権限がありません';
  if (!company(toCid)) return '送り先の会社が見つかりません';
  const bal = totals(fromCid).bal;
  if (amount > bal) return '貯金が足りません（今の貯金：' + yen(bal) + '）';
  const pair = newId('p');
  const ts = Date.now();
  put('eco:tx:' + pair + '-o', { cid: fromCid, kind: 'send', amount: -amount, to: toCid, pair, by: ME, ts });
  put('eco:tx:' + pair + '-i', { cid: toCid, kind: 'receive', amount, from: fromCid, pair, by: ME, ts });
  return null;
}
// 利益などの収益を入れる（段階3の利益地点から使う）
function addIncome(cid, amount, note) {
  if (!Number.isInteger(amount) || amount < 1 || !company(cid)) return false;
  const id = newId('t');
  put('eco:tx:' + id, { cid, kind: 'income', amount, note: clean(note || '', 40), by: ME, ts: Date.now() });
  return true;
}

// ---------- 利益地点（範囲に入った人・車・電車の数だけ、会社に収益が入る） ----------
// 判定そのものは voxel-craft-profit.js が行う。ここは保存と、設定の画面だけ
const PP_CONDS = { crowd: '人混み', car: '自動車', train: '電車' };
function remove(k) {
  const r = room();
  if (r) r.del(k);
  else { local.delete(k); localSave(); }
  notify();
}
function pointsOf(cid) { return entries('eco:pp:' + cid + ':').filter(p => p && p.id && p.cid === cid); }
function allPoints() { return entries('eco:pp:').filter(p => p && p.id && company(p.cid)); }
function addPoint(cid, d) {
  if (!company(cid)) return 'その会社がありません';
  if (roleOf(cid) !== 'admin') return '利益地点は、社長・管理の人だけが設定できます';
  if (!d.range) return 'ステッキで範囲の始点と終点をタップして選んでください';
  if (!PP_CONDS[d.cond]) return '条件を選んでください';
  const amount = Number(d.amount);
  if (!Number.isInteger(amount) || amount < 1 || amount > 1e9) return '金額は1以上の整数で入力してください';
  const id = newId('p');
  put('eco:pp:' + cid + ':' + id, { id, cid, name: clean(d.name || '', 20), cond: d.cond, amount,
    min: d.range.min.map(Number), max: d.range.max.map(Number), by: ME, ts: Date.now() });
  return '';
}
function removePoint(cid, id) {
  if (roleOf(cid) !== 'admin') return '削除は、社長・管理の人だけができます';
  remove('eco:pp:' + cid + ':' + id);
  return '';
}
function ppHtml(c) {
  const r = (window.VoxelExt && VoxelExt.wandRange) ? VoxelExt.wandRange() : null;
  const rangeTxt = r
    ? `選んでいる範囲：(${r.min.join(', ')}) 〜 (${r.max.join(', ')})`
    : 'ステッキで、範囲の始点と終点をタップして選んでください（選んだら、この画面を開き直すと表示が変わります）';
  const list = pointsOf(c.id).sort((a, b) => (a.ts || 0) - (b.ts || 0)).map(p =>
    `<div style="display:flex;gap:6px;align-items:center;margin:4px 0;background:rgba(255,255,255,.08);border-radius:8px;padding:6px">
      <span style="flex:1;min-width:0"><b>${esc(p.name || '（名前なし）')}</b>　${PP_CONDS[p.cond] || ''}／1回 ${yen(p.amount)}<br>
      <small style="opacity:.75">(${p.min.join(', ')}) 〜 (${p.max.join(', ')})</small></span>
      <button data-eco="ppdel" data-v="${esc(p.id)}" data-c="${esc(c.id)}" style="${btn(false)}">削除</button></div>`).join('')
    || '<div style="opacity:.75">まだ、利益地点はありません</div>';
  const opts = Object.entries(PP_CONDS).map(([k, l]) => `<option value="${k}" ${st.pp.cond === k ? 'selected' : ''}>${l}</option>`).join('');
  return `<div style="font-weight:bold;margin-top:8px">利益地点</div>
    <div style="font-size:12px;opacity:.85;margin:4px 0">${esc(rangeTxt)}</div>
    <input data-eco-field="ppName" value="${esc(st.pp.name)}" placeholder="地点の名前（任意）" maxlength="20" style="${field};margin:4px 0">
    <select data-eco-field="ppCond" style="${field};margin:4px 0">${opts}</select>
    <input data-eco-field="ppAmount" value="${esc(st.pp.amount)}" inputmode="numeric" placeholder="1回の金額（円）" style="${field};margin:4px 0">
    <button data-eco="ppadd" data-c="${esc(c.id)}" style="${btn(true)};margin:4px 0">この範囲を利益地点に登録</button>
    <div style="font-size:11px;opacity:.75;margin-bottom:4px">範囲に人・車・電車が入るたびに、1人・1台・1編成ごとに金額が会社に入ります（出ていって、また入ると、もう一度入ります）。</div>
    ${list}`;
}

// ---------- 画面 ----------
let st = { tab: 'co', filter: 'all', sel: null, msg: '', msgOk: true, icon: null, fromCid: '', toCid: '', pp: { name: '', cond: 'crowd', amount: '1000' },
  draft: { name: '', concept: '', pres: [''], amount: '' } };   // 入力中の内容（画面を作り直しても消えない）
let mountEl = null;

function say(ok, text) { st.msgOk = ok; st.msg = text; }
function msgHtml() {
  if (!st.msg) return '';
  return `<div style="margin:6px 0;padding:6px 8px;border-radius:8px;background:${st.msgOk ? 'rgba(80,180,120,.25)' : 'rgba(220,90,90,.3)'}">${esc(st.msg)}</div>`;
}
function iconImg(c, size) {
  const inner = c && c.icon ? `<img src="${esc(c.icon)}" alt="" style="width:100%;height:100%;object-fit:cover">`
    : `<span style="font-size:${Math.round(size * 0.45)}px">🏢</span>`;
  return `<div style="width:${size}px;height:${size}px;border-radius:12px;overflow:hidden;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;flex:none">${inner}</div>`;
}
function roleLabel(r) { return r === 'admin' ? '社長・管理' : r === 'member' ? 'メンバー' : ''; }
function tabBtn(id, label) {
  const on = st.tab === id;
  return `<button data-eco="tab" data-v="${id}" style="${btn(on)}">${label}</button>`;
}
function btn(on) {
  return `background:${on ? '#4a6fd1' : 'rgba(255,255,255,.14)'};color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:8px;padding:6px 10px;font:inherit;font-size:12px;cursor:pointer`;
}
const field = 'width:100%;box-sizing:border-box;background:rgba(0,0,0,.35);color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:8px;padding:7px 9px;font:inherit;font-size:13px';

function banner() {
  return inRoom()
    ? '<div style="font-size:11px;opacity:.8;margin-bottom:6px">部屋の中の会社です（ほかの人と共有されます）</div>'
    : '<div style="font-size:11px;color:#f0c27b;margin-bottom:6px">部屋に入っていません。この端末の中だけに保存されます。</div>';
}

function listHtml() {
  const kind = st.filter;
  const list = kind === 'all' ? companies() : myCompanies(kind);
  const filters = [['admin', '管理'], ['member', '加入'], ['all', '全て']]
    .map(([k, l]) => `<button data-eco="filter" data-v="${k}" style="${btn(st.filter === k)}">${l}</button>`).join('');
  const cards = list.length === 0
    ? '<div style="opacity:.75;padding:12px 0">この一覧には、会社がありません。</div>'
    : list.sort((a, b) => (a.ts || 0) - (b.ts || 0)).map(c => {
        const t = totals(c.id);
        const r = roleOf(c.id);
        return `<button data-eco="open" data-v="${esc(c.id)}" style="display:flex;gap:10px;align-items:center;width:100%;text-align:left;background:rgba(255,255,255,.08);color:#fff;border:1px solid rgba(255,255,255,.15);border-radius:12px;padding:10px;margin:6px 0;font:inherit;cursor:pointer">
          ${iconImg(c, 48)}
          <span style="flex:1;min-width:0"><b>${esc(c.name)}</b> ${r ? `<small style="opacity:.75">（${roleLabel(r)}）</small>` : ''}<br>
          <small style="opacity:.8">社長：${(c.presidents || []).map(esc).join('、')}</small><br>
          <small>貯金 ${yen(t.bal)}</small></span></button>`;
      }).join('');
  return `${filters ? `<div style="display:flex;gap:6px;margin-bottom:4px">${filters}</div>` : ''}${cards}`;
}

function detailHtml(c) {
  const t = totals(c.id);
  const r = roleOf(c.id);
  const mem = members(c.id).map(m => `<li>${esc(m.name || '（名前なし）')}：${roleLabel(m.role)}</li>`).join('');
  const myScouts = scouts().filter(s => s.cid === c.id).sort((a, b) => b.ts - a.ts);
  const scoutLines = myScouts.length ? myScouts.map(s => `<li>${esc(s.targetName || '')}：${({ pending: '返事待ち', accepted: '加入しました', rejected: '断られました' })[s.status] || ''}</li>`).join('') : '<li>まだありません</li>';
  const canOpen = !!r;
  const cand = canOpen ? players().filter(p => !getv('eco:mem:' + c.id + ':' + p.uid)) : [];
  const candHtml = cand.length
    ? cand.map(p => `<div style="display:flex;align-items:center;gap:8px;margin:4px 0"><span style="flex:1">${esc(p.name || '（名前なし）')}</span><button data-eco="scout" data-v="${esc(p.uid)}" data-c="${esc(c.id)}" style="${btn(false)}">スカウト</button></div>`).join('')
    : '<div style="opacity:.75">スカウトできる人が、今はいません（まだ入っていない人が、部屋にいるときに表示されます）。</div>';
  return `<button data-eco="back" style="${btn(false)};margin-bottom:8px">‹ 一覧へ</button>
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px">${iconImg(c, 64)}
      <div style="min-width:0"><b style="font-size:17px">${esc(c.name)}</b><br><small>${roleLabel(r) || '（この会社の外の人）'}</small></div></div>
    <div style="margin:6px 0"><small style="opacity:.8">社長名</small><br>${(c.presidents || []).map(esc).join('、')}</div>
    <div style="margin:6px 0"><small style="opacity:.8">コンセプト</small><br>${c.concept ? esc(c.concept) : '（未入力）'}</div>
    <div style="display:flex;gap:8px;margin:8px 0">
      <div style="flex:1;background:rgba(255,255,255,.1);border-radius:10px;padding:8px"><small>総貯金</small><br><b>${yen(t.bal)}</b></div>
      <div style="flex:1;background:rgba(255,255,255,.1);border-radius:10px;padding:8px"><small>収益（累計）</small><br><b>${yen(t.inc)}</b></div>
    </div>
    ${canOpen ? `<button data-eco="sendfrom" data-v="${esc(c.id)}" style="${btn(false)};margin-bottom:8px">この会社から送金する</button>` : ''}
    ${r === 'admin' ? ppHtml(c) : ''}
    <div style="font-weight:bold;margin-top:8px">メンバー</div><ul style="margin:4px 0 8px;padding-left:18px">${mem || '<li>（まだいません）</li>'}</ul>
    ${canOpen ? `<div style="font-weight:bold;margin-top:8px">スカウト</div>${candHtml}
      <div style="font-weight:bold;margin-top:8px">スカウトの状況</div><ul style="margin:4px 0;padding-left:18px">${scoutLines}</ul>` : ''}`;
}

function incomingHtml() {
  const mine = scouts().filter(s => s.target === ME).sort((a, b) => b.ts - a.ts);
  const pending = mine.filter(s => s.status === 'pending');
  const rows = pending.length ? pending.map(s => {
    const c = company(s.cid);
    return `<div style="background:rgba(255,255,255,.08);border-radius:10px;padding:10px;margin:6px 0">
      <div><b>${c ? esc(c.name) : '（会社は、もうありません）'}</b> から、スカウトされています</div>
      <small style="opacity:.8">誘った人：${esc(s.byName || '')}</small>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button data-eco="accept" data-v="${esc(s.sid)}" style="${btn(true)}">承認して加入</button>
        <button data-eco="reject" data-v="${esc(s.sid)}" style="${btn(false)}">断る</button>
      </div></div>`;
  }).join('') : '<div style="opacity:.75;padding:8px 0">新しいスカウトはありません。</div>';
  return `<div style="font-weight:bold;margin-bottom:4px">申請リスト</div>${rows}`;
}

function sendHtml() {
  const mine = myCompanies('any');
  if (mine.length === 0) return '<div style="opacity:.75">送金できる会社がありません。まずは会社に入るか、起業しましょう。</div>';
  const from = mine.find(c => c.id === st.fromCid) || mine[0];
  st.fromCid = from.id;
  const others = companies().filter(c => c.id !== from.id);
  const to = others.find(c => c.id === st.toCid) || others[0];
  st.toCid = to ? to.id : '';
  const opts = (list, sel) => list.map(c => `<option value="${esc(c.id)}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  return `<div style="font-weight:bold;margin-bottom:6px">送金</div>
    <label style="display:block;margin:6px 0"><small>送る会社（自社の貯金から）</small><br>
      <select data-eco-field="fromCid" style="${field}">${opts(mine, from.id)}</select></label>
    <div style="font-size:12px;opacity:.85;margin:2px 0 6px">貯金：${yen(totals(from.id).bal)}</div>
    <label style="display:block;margin:6px 0"><small>受け取る会社</small><br>
      <select data-eco-field="toCid" style="${field}">${others.length ? opts(others, to.id) : '<option value="">（ほかの会社がありません）</option>'}</select></label>
    <label style="display:block;margin:6px 0"><small>金額（円・整数）</small><br>
      <input data-eco-field="amount" type="number" min="1" step="1" inputmode="numeric" value="${esc(st.draft.amount)}" style="${field}"></label>
    <button data-eco="send" style="${btn(true)};width:100%;padding:9px;margin-top:6px">送金する</button>`;
}

function startHtml() {
  const d = st.draft;
  const presRows = d.pres.map((p, i) => `<input data-pres="${i}" value="${esc(p)}" placeholder="社長名" maxlength="${LIM.presName}" style="${field};margin:3px 0">`).join('');
  return `<div style="font-weight:bold;margin-bottom:6px">新規起業</div>
    <label style="display:block;margin:6px 0"><small>会社名（${LIM.name}文字まで）</small><br>
      <input data-eco-field="name" value="${esc(d.name)}" maxlength="${LIM.name}" style="${field}"></label>
    <div style="margin:6px 0"><small>社長名（複数入力できます）</small>${presRows}
      <button data-eco="addpres" style="${btn(false)};margin-top:4px" ${d.pres.length >= LIM.pres ? 'disabled' : ''}>社長を追加</button></div>
    <label style="display:block;margin:6px 0"><small>コンセプト（${LIM.concept}文字まで）</small><br>
      <textarea data-eco-field="concept" maxlength="${LIM.concept}" rows="3" style="${field}">${esc(d.concept)}</textarea></label>
    <div style="margin:6px 0"><small>アイコン（任意）</small><br>
      <div style="display:flex;gap:8px;align-items:center">${iconImg({ icon: st.icon }, 52)}
        <button data-eco="pickicon" style="${btn(false)}">画像を選ぶ</button>
        ${st.icon ? `<button data-eco="clearicon" style="${btn(false)}">標準に戻す</button>` : ''}</div></div>
    <button data-eco="create" style="${btn(true)};width:100%;padding:9px;margin-top:8px">新規起業する</button>`;
}

function render() {
  if (!mountEl) return;
  const pendingCount = scouts().filter(s => s.target === ME && s.status === 'pending').length;
  let body = '';
  if (st.tab === 'co') body = st.sel && company(st.sel) ? detailHtml(company(st.sel)) : (st.sel = null, listHtml());
  else if (st.tab === 'in') body = incomingHtml();
  else if (st.tab === 'send') body = sendHtml();
  else body = startHtml();
  mountEl.innerHTML = `${banner()}
    <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px">
      ${tabBtn('co', '会社')}${tabBtn('in', '申請' + (pendingCount ? '（' + pendingCount + '）' : ''))}${tabBtn('send', '送金')}${tabBtn('start', '起業')}
    </div>
    ${msgHtml()}${body}`;
  localLoad();
}

// 画面の操作
function handleClick(e) {
  const b = e.target.closest('[data-eco]');
  if (!b) return;
  const act = b.dataset.eco, v = b.dataset.v;
  if (act === 'tab') { st.tab = v; st.sel = null; st.msg = ''; render(); return; }
  if (act === 'filter') { st.filter = v; st.sel = null; render(); return; }
  if (act === 'open') { st.sel = v; st.msg = ''; render(); return; }
  if (act === 'back') { st.sel = null; render(); return; }
  if (act === 'sendfrom') { st.tab = 'send'; st.fromCid = v; st.msg = ''; render(); return; }
  if (act === 'scout') {
    const p = players().find(x => x.uid === v);
    if (!p) say(false, 'この人は、もう部屋にいないようです');
    else { const err = scoutPlayer(b.dataset.c, p); say(!err, err || (p.name + 'をスカウトしました（相手の申請リストに届きます）')); }
    render(); return;
  }
  if (act === 'accept' || act === 'reject') {
    const err = respondScout(v, act === 'accept');
    say(!err, err || (act === 'accept' ? '加入しました' : '断りました'));
    render(); return;
  }
  if (act === 'send') {
    const amount = Number(st.draft.amount);
    const err = sendMoney(st.fromCid, st.toCid, amount);
    say(!err, err || (yen(amount) + ' を送金しました'));
    if (!err) st.draft.amount = '';
    render(); return;
  }
  if (act === 'addpres') { if (st.draft.pres.length < LIM.pres) st.draft.pres.push(''); render(); return; }
  if (act === 'ppadd') {
    const err = addPoint(b.dataset.c, { name: st.pp.name, cond: st.pp.cond, amount: st.pp.amount, range: (window.VoxelExt && VoxelExt.wandRange) ? VoxelExt.wandRange() : null });
    say(!err, err || '利益地点を登録しました');
    if (!err) st.pp.name = '';
    render(); return;
  }
  if (act === 'ppdel') {
    const err = removePoint(b.dataset.c, v);
    say(!err, err || '利益地点を削除しました');
    render(); return;
  }
  if (act === 'pickicon') { pickIcon(); return; }
  if (act === 'clearicon') { st.icon = null; render(); return; }
  if (act === 'create') {
    const d = st.draft;
    const err = createCompany({ name: d.name, presidents: d.pres, concept: d.concept, icon: st.icon });
    if (err) say(false, err);
    else { say(true, '起業しました！「会社」の一覧で確認できます'); st.draft = { name: '', concept: '', pres: [''], amount: st.draft.amount }; st.icon = null; st.tab = 'co'; st.filter = 'admin'; }
    render(); return;
  }
}
function pickIcon() {
  let f = document.getElementById('ecoIconFile');
  if (!f) {
    f = document.createElement('input');
    f.type = 'file'; f.accept = 'image/*'; f.id = 'ecoIconFile'; f.style.display = 'none';
    document.body.appendChild(f);
    f.addEventListener('change', async () => {
      const file = f.files && f.files[0]; f.value = '';
      if (!file) return;
      try {
        const bmp = await createImageBitmap(file);
        const sc = Math.min(1, 192 / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(bmp.width * sc)); c.height = Math.max(1, Math.round(bmp.height * sc));
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        st.icon = c.toDataURL('image/jpeg', 0.8);
        say(true, 'アイコンを選びました');
      } catch (e) { say(false, '画像を読み込めませんでした'); }
      render();
    });
  }
  f.click();
}

// 入力中は、画面を作り直さない（入力が消えないように）
function mount(el) {
  mountEl = el;
  if (!el.dataset.ecoReady) {
    el.dataset.ecoReady = '1';
    el.addEventListener('click', handleClick);
    el.addEventListener('input', e => {
      const t = e.target;
      const f = t.dataset && t.dataset.ecoField;
      if (f === 'name' || f === 'concept' || f === 'amount') st.draft[f] = t.value;
      if (f === 'ppName') st.pp.name = t.value;
      if (f === 'ppAmount') st.pp.amount = t.value;
      if (t.dataset && t.dataset.pres !== undefined) st.draft.pres[Number(t.dataset.pres)] = t.value;
    });
    el.addEventListener('change', e => {
      const f = e.target.dataset && e.target.dataset.ecoField;
      if (f === 'fromCid') st.fromCid = e.target.value;
      if (f === 'toCid') st.toCid = e.target.value;
      if (f === 'ppCond') st.pp.cond = e.target.value;
    });
    el.addEventListener('keydown', e => e.stopPropagation());
    el.addEventListener('keyup', e => e.stopPropagation());
  }
  presence();
  render();
}
subs.add(() => {
  if (!mountEl || !mountEl.isConnected) return;
  const x = document.activeElement;
  if (x && mountEl.contains(x) && /INPUT|TEXTAREA|SELECT/.test(x.tagName)) return;
  render();
});

window.VoxelEconomy = {
  companies, company, totals, addIncome, members, roleOf,
  pointsOf, allPoints, addPoint, removePoint, PP_CONDS,
  yen
};

function whenReady() {
  if (!window.VoxelExt || !window.VoxelPhone || !VoxelPhone.registerApp) { setTimeout(whenReady, 200); return; }
  VX = window.VoxelExt;
  VoxelPhone.registerApp({ id: 'economy', name: '経済', emoji: '💴', mount });
  localLoad();
}
whenReady();
})();
