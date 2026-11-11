/* voxel-craft-route.js  路線図アプリ（段階4）
 *
 *  会社ごとの、二次元の路線図。描くだけの図（実際の列車やダイヤとはつながない）。
 *  ・駅：名前・大きさ（1〜3）・透明度を決めて置く
 *  ・線：色・太さ・曲線（ON／OFF）を決めて、通る点を順にタップ。点は駅にくっつけられる（駅を動かすと線もついてくる）
 *  ・道具：移動（駅・線をドラッグ。何もないところのドラッグは画面を動かす）／駅／線／範囲（ドラッグで選ぶ）
 *  ・選んだものは、複製・削除・透明度を変えられる
 *  ・グリッド：ON なら 1マスに合わせて置く。OFF なら、自由な位置に置く
 *  ・保存：変えるたびに自動で保存（部屋に入っていれば、ほかの人にも届く＝共同編集）
 *  ・編集できるのは、その会社の社長・管理の人。ほかの人は見るだけ
 *
 *  保存の場所：経済アプリの保存（eco:rt:＜会社＞:s:＜id＞ 駅 ／ eco:rt:＜会社＞:l:＜id＞ 線）
 *  読み込み順：voxel-craft-economy.js の後（voxel-craft-ext.js が自動で読み込む）
 */
(function () {
'use strict';
if (window.VoxelRoute) return;

const PREFIX = 'eco:rt:';
const st = {
  cid: null, tool: 'move', grid: true, zoom: 40, ox: 0, oy: 0,
  sel: new Set(), draft: [], box: null, preview: null,
  sName: '', sSize: 2,
  lColor: '#e53935', lWidth: 4, lCurve: false,
  opacity: 100
};
let el = null, canvasEl = null, unsub = null, ro = null;

// ---------- 小さな補助 ----------
const E = () => window.VoxelEconomy;
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function newId(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function ky(cid, kind, id) { return PREFIX + cid + ':' + kind + ':' + id; }
function canEdit(cid) { return !!(E() && E().canEdit(cid)); }
function snap(v) { return st.grid ? Math.round(v) : Math.round(v * 10) / 10; }
function save(cid, item) { E().kvPut(ky(cid, item.kind, item.id), item); }
function removeItem(cid, item) { E().kvDel(ky(cid, item.kind, item.id)); }

// 会社の路線図を、読み込み（コピーを返す。画面で動かしても、保存されたものは変わらない）
function load(cid) {
  const all = (E().kvEntries(PREFIX + cid + ':') || []).filter(x => x && x.id).map(clone);
  return {
    s: new Map(all.filter(x => x.kind === 's').map(x => [x.id, x])),
    l: all.filter(x => x.kind === 'l')
  };
}
// 線の通る点を、座標に直す（駅に結んだ点は、駅の今の位置を使う）
function pointOf(p, s) {
  if (p.s) { const q = s.get(p.s); return q ? { x: q.x, y: q.y } : null; }
  return typeof p.x === 'number' ? { x: p.x, y: p.y } : null;
}
function resolve(line, s) { return (line.pts || []).map(p => pointOf(p, s)).filter(Boolean); }

// 画面の座標と、路線図の座標の変換
function toPx(x, y, W, H) { return { px: (x - st.ox) * st.zoom + W / 2, py: (y - st.oy) * st.zoom + H / 2 }; }
function toWorld(px, py, W, H) { return { x: (px - W / 2) / st.zoom + st.ox, y: (py - H / 2) / st.zoom + st.oy }; }
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

// 指した場所にある、駅（優先）か線を探す
function hit(data, px, py, W, H) {
  let best = null, bd = Infinity;
  for (const s of data.s.values()) {
    const p = toPx(s.x, s.y, W, H);
    const d = Math.hypot(p.px - px, p.py - py);
    if (d < 10 + s.size * 3 && d < bd) { best = { kind: 's', id: s.id }; bd = d; }
  }
  if (best) return best;
  for (const l of data.l) {
    const pts = resolve(l, data.s).map(q => toPx(q.x, q.y, W, H));
    for (let i = 1; i < pts.length; i++) {
      if (segDist(px, py, pts[i - 1].px, pts[i - 1].py, pts[i].px, pts[i].py) < 7) return { kind: 'l', id: l.id };
    }
  }
  return null;
}

// 曲線：通る点を、なめらかな線でつなぐ（Catmull-Rom）
function smooth(pts) {
  if (pts.length < 3) return pts;
  const P = [pts[0], ...pts, pts[pts.length - 1]], out = [];
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    for (let k = 0; k < 8; k++) {
      const t = k / 8, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// ---------- 描く ----------
function draw() {
  if (!canvasEl || !st.cid) return;
  const r = canvasEl.getBoundingClientRect();
  const W = r.width, H = r.height, dpr = window.devicePixelRatio || 1;
  if (!W || !H) return;
  canvasEl.width = Math.round(W * dpr); canvasEl.height = Math.round(H * dpr);
  const ctx = canvasEl.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#f6f3ea'; ctx.fillRect(0, 0, W, H);
  const data = st.preview || load(st.cid);

  // グリッド
  if (st.grid && st.zoom >= 12) {
    const a = toWorld(0, 0, W, H), b = toWorld(W, H, W, H);
    ctx.lineWidth = 1;
    for (let x = Math.floor(a.x); x <= b.x; x++) {
      ctx.strokeStyle = x % 5 === 0 ? 'rgba(0,0,0,.16)' : 'rgba(0,0,0,.07)';
      const p = toPx(x, 0, W, H).px; ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, H); ctx.stroke();
    }
    for (let y = Math.floor(a.y); y <= b.y; y++) {
      ctx.strokeStyle = y % 5 === 0 ? 'rgba(0,0,0,.16)' : 'rgba(0,0,0,.07)';
      const p = toPx(0, y, W, H).py; ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(W, p); ctx.stroke();
    }
  }

  // 線（曲線ならなめらかに）
  for (const l of data.l) {
    const pts = resolve(l, data.s);
    if (pts.length < 2) continue;
    const path = (l.curve ? smooth(pts) : pts).map(q => toPx(q.x, q.y, W, H));
    ctx.globalAlpha = l.op == null ? 1 : l.op;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = l.color; ctx.lineWidth = (l.width || 4) * 2;
    ctx.beginPath(); path.forEach((q, i) => i ? ctx.lineTo(q.px, q.py) : ctx.moveTo(q.px, q.py)); ctx.stroke();
    if (st.sel.has(l.id)) {
      ctx.globalAlpha = 1; ctx.setLineDash([4, 3]); ctx.strokeStyle = '#ffd54f'; ctx.lineWidth = 2;
      ctx.beginPath(); path.forEach((q, i) => i ? ctx.lineTo(q.px, q.py) : ctx.moveTo(q.px, q.py)); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  // 駅
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const s of data.s.values()) {
    const p = toPx(s.x, s.y, W, H);
    const rad = 6 + (s.size || 2) * 2.5;
    ctx.globalAlpha = s.op == null ? 1 : s.op;
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#333'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(p.px, p.py, rad, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.globalAlpha = 1;
    if (st.sel.has(s.id)) { ctx.strokeStyle = '#ffd54f'; ctx.setLineDash([3, 3]); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.px, p.py, rad + 5, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
    ctx.fillStyle = '#222'; ctx.font = 'bold 12px sans-serif';
    ctx.fillText(s.name || '', p.px, p.py + rad + 4);
  }

  // 線を作っている途中
  if (st.tool === 'line' && st.draft.length) {
    const pts = st.draft.map(p => pointOf(p, data.s)).filter(Boolean).map(q => toPx(q.x, q.y, W, H));
    ctx.globalAlpha = 0.8; ctx.strokeStyle = st.lColor; ctx.lineWidth = st.lWidth * 2; ctx.setLineDash([6, 4]);
    ctx.beginPath(); pts.forEach((q, i) => i ? ctx.lineTo(q.px, q.py) : ctx.moveTo(q.px, q.py)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = st.lColor; ctx.lineWidth = 2;
    for (const q of pts) { ctx.beginPath(); ctx.arc(q.px, q.py, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    ctx.globalAlpha = 1;
  }

  // 範囲の選択の枠
  if (st.box) {
    ctx.strokeStyle = '#4a6fd1'; ctx.fillStyle = 'rgba(74,111,209,.15)'; ctx.lineWidth = 1.5;
    const x = Math.min(st.box.x0, st.box.x1), y = Math.min(st.box.y0, st.box.y1);
    const w = Math.abs(st.box.x1 - st.box.x0), h = Math.abs(st.box.y1 - st.box.y0);
    ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
  }

  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(st.grid ? 'グリッド（1マス）' : '自由配置', 6, 6);
}

// ---------- 画面の部品 ----------
function companyOptions() {
  const list = E() ? E().companies() : [];
  return list.sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .map(c => `<option value="${esc(c.id)}" ${c.id === st.cid ? 'selected' : ''}>${esc(c.name)}${canEdit(c.id) ? '' : '（見るだけ）'}</option>`).join('');
}
function toolsHtml(can) {
  const tools = [['move', '移動'], ['station', '駅'], ['line', '線'], ['range', '範囲']];
  const b = (on) => `background:${on ? '#4a6fd1' : 'rgba(255,255,255,.14)'};color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:8px;padding:6px 9px;font:inherit;font-size:12px;cursor:pointer`;
  return `<div style="display:flex;gap:5px;flex-wrap:wrap;margin:6px 0">
    ${tools.map(([v, l]) => `<button data-rt="tool" data-v="${v}" style="${b(st.tool === v)}">${l}</button>`).join('')}
    <button data-rt="grid" style="${b(st.grid)}">グリッド：${st.grid ? 'ON' : 'OFF'}</button>
    <button data-rt="zoomin" style="${b(false)}">拡大</button>
    <button data-rt="zoomout" style="${b(false)}">縮小</button>
    <button data-rt="center" style="${b(false)}">中央へ</button></div>`;
}
const field = 'box-sizing:border-box;background:rgba(0,0,0,.35);color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:8px;padding:6px 8px;font:inherit;font-size:13px';
function panelHtml(can) {
  let h = '';
  if (!can) h += '<div style="font-size:11px;color:#f0c27b;margin:4px 0">この路線図は見るだけです（編集は、社長・管理の人ができます）</div>';
  if (can) {
    if (st.tool === 'move') h += '<div style="font-size:12px;opacity:.85">駅や線をドラッグで動かせます。何もないところをドラッグすると、画面が動きます。</div>';
    if (st.tool === 'station') h += `<div style="display:flex;gap:6px;align-items:center;margin:4px 0;flex-wrap:wrap">
      <input data-rt-f="sName" value="${esc(st.sName)}" maxlength="12" placeholder="駅の名前" style="${field};flex:1;min-width:120px">
      <select data-rt-f="sSize" style="${field}">${[1, 2, 3].map(n => `<option value="${n}" ${st.sSize === n ? 'selected' : ''}>大きさ${n}</option>`).join('')}</select></div>
      <div style="font-size:12px;opacity:.85">置きたい場所をタップしてください。</div>`;
    if (st.tool === 'line') h += `<div style="display:flex;gap:6px;align-items:center;margin:4px 0;flex-wrap:wrap">
      <input type="color" data-rt-f="lColor" value="${esc(st.lColor)}" style="width:44px;height:32px;border:0;background:none">
      <select data-rt-f="lWidth" style="${field}">${[1, 2, 3, 4, 5, 6, 7, 8].map(n => `<option value="${n}" ${st.lWidth === n ? 'selected' : ''}>太さ${n}</option>`).join('')}</select>
      <label style="font-size:13px"><input type="checkbox" data-rt-f="lCurve" ${st.lCurve ? 'checked' : ''}> 曲線</label></div>
      <div style="display:flex;gap:6px;align-items:center;margin:4px 0"><span style="font-size:12px;flex:1">通る点：${st.draft.length}（駅をタップすると駅に結べます）</span>
      <button data-rt="linedone" style="${field};cursor:pointer;background:#4a6fd1">線を完成</button>
      <button data-rt="linecancel" style="${field};cursor:pointer">やめる</button></div>`;
    if (st.tool === 'range') h += '<div style="font-size:12px;opacity:.85">ドラッグで範囲を選びます。タップすると、そのものだけ選べます。</div>';
  }
  if (can && st.sel.size) {
    const data = load(st.cid);
    const one = [...st.sel].length === 1 && data.s.has([...st.sel][0]) ? data.s.get([...st.sel][0]) : null;
    h += `<div style="margin:8px 0;padding:8px;background:rgba(255,255,255,.08);border-radius:10px">
      <div style="font-size:12px;margin-bottom:4px">選んでいるもの：${st.sel.size}件</div>
      ${one ? `<input data-rt-f="rename" value="${esc(one.name)}" maxlength="12" placeholder="駅の名前" style="${field};width:100%;margin-bottom:4px">` : ''}
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px"><span style="font-size:12px">透明度</span>
      <input type="range" min="10" max="100" value="${st.opacity}" data-rt-f="opacity" style="flex:1"><span style="font-size:12px">${st.opacity}%</span></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button data-rt="dup" style="${field};cursor:pointer">複製</button>
        <button data-rt="del" style="${field};cursor:pointer">削除</button>
        <button data-rt="desel" style="${field};cursor:pointer">選ぶのをやめる</button></div></div>`;
  }
  return h;
}

function render() {
  if (!el || !el.isConnected) return;
  if (!st.cid || !E().company(st.cid)) {
    const list = E().companies().sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const pick = list.find(c => canEdit(c.id)) || list[0];
    st.cid = pick ? pick.id : null;
    st.sel = new Set(); st.draft = [];
  }
  const top = el.querySelector('#rtTop'), tools = el.querySelector('#rtTools'), panel = el.querySelector('#rtPanel');
  if (!st.cid) {
    top.innerHTML = '<div style="opacity:.8;padding:12px 0">路線図は、会社を作ってから使えます（「会社」「起業」の画面で作れます）。</div>';
    tools.innerHTML = ''; panel.innerHTML = ''; if (canvasEl) canvasEl.style.display = 'none';
    return;
  }
  if (canvasEl) canvasEl.style.display = 'block';
  const can = canEdit(st.cid);
  top.innerHTML = `<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px"><span style="font-size:12px;opacity:.85">会社</span>
    <select data-rt-f="cid" style="${field};flex:1">${companyOptions()}</select></div>`;
  tools.innerHTML = can ? toolsHtml(can) : '';
  panel.innerHTML = panelHtml(can);
  draw();
}

// ---------- 操作 ----------
let drag = null;

function pointerXY(e) { const r = canvasEl.getBoundingClientRect(); return { px: e.clientX - r.left, py: e.clientY - r.top, W: r.width, H: r.height }; }

function onDown(e) {
  if (!st.cid) return;
  canvasEl.setPointerCapture(e.pointerId);
  const { px, py, W, H } = pointerXY(e);
  const w = toWorld(px, py, W, H);
  const cid = st.cid, can = canEdit(cid);
  const data = load(cid);
  if (!can) { drag = { type: 'pan', x: px, y: py, ox: st.ox, oy: st.oy }; return; }

  if (st.tool === 'move') {
    const h = hit(data, px, py, W, H);
    if (h) {
      if (!st.sel.has(h.id)) st.sel = new Set([h.id]);
      drag = { type: 'item', startW: w, base: load(cid), moved: new Set() };
      st.preview = drag.base;
    } else { st.sel = new Set(); drag = { type: 'pan', x: px, y: py, ox: st.ox, oy: st.oy }; }
  } else if (st.tool === 'station') {
    const id = newId('s');
    const n = data.s.size + 1;
    const item = { id, kind: 's', x: snap(w.x), y: snap(w.y), name: st.sName.trim() || ('駅' + n), size: st.sSize, op: 1, ts: Date.now() };
    save(cid, item);
    st.sel = new Set([id]);
  } else if (st.tool === 'line') {
    const h = hit(data, px, py, W, H);
    if (h && h.kind === 's') st.draft.push({ s: h.id });
    else st.draft.push({ x: snap(w.x), y: snap(w.y) });
  } else if (st.tool === 'range') {
    drag = { type: 'box', x0: px, y0: py, x1: px, y1: py, sx: px, sy: py };
    st.box = { x0: px, y0: py, x1: px, y1: py };
  }
  render();
}

function onMove(e) {
  if (!drag) return;
  const { px, py, W, H } = pointerXY(e);
  if (drag.type === 'pan') {
    st.ox = drag.ox - (px - drag.x) / st.zoom;
    st.oy = drag.oy - (py - drag.y) / st.zoom;
  } else if (drag.type === 'item') {
    const w = toWorld(px, py, W, H);
    const dx = w.x - drag.startW.x, dy = w.y - drag.startW.y;
    const base = drag.base;
    for (const id of st.sel) {
      const s = base.s.get(id);
      if (s) {
        // 駅は、動かした分だけ動く（今の位置から、もとの位置を覚えておく）
        if (s.x0 === undefined) { s.x0 = s.x; s.y0 = s.y; }
        s.x = snap(s.x0 + dx); s.y = snap(s.y0 + dy);
        drag.moved.add(id);
      }
      const l = base.l.find(q => q.id === id);
      if (l) {
        if (!l.pts0) l.pts0 = clone(l.pts);
        l.pts = l.pts0.map(p => (p.s ? p : { x: snap(p.x + dx), y: snap(p.y + dy) }));
        drag.moved.add(id);
      }
    }
    st.preview = base;
  } else if (drag.type === 'box') {
    drag.x1 = px; drag.y1 = py;
    st.box = { x0: drag.x0, y0: drag.y0, x1: px, y1: py };
  }
  draw();
}

function onUp(e) {
  if (!drag) return;
  const d = drag; drag = null;
  const cid = st.cid;
  if (d.type === 'item') {
    const base = d.base;
    for (const id of d.moved) {
      const s = base.s.get(id);
      if (s) { delete s.x0; delete s.y0; save(cid, s); continue; }
      const l = base.l.find(q => q.id === id);
      if (l) { delete l.pts0; save(cid, l); }
    }
    st.preview = null;
  } else if (d.type === 'box') {
    const { px, py, W, H } = pointerXY(e);
    st.box = null;
    const moved = Math.hypot(px - d.sx, py - d.sy) > 4;
    const data = load(cid);
    if (!moved) {
      const h = hit(data, px, py, W, H);
      if (!h) st.sel = new Set();
      else { const n = new Set(st.sel); n.has(h.id) ? n.delete(h.id) : n.add(h.id); st.sel = n; }
    } else {
      const a = toWorld(Math.min(d.x0, px), Math.min(d.y0, py), W, H);
      const b = toWorld(Math.max(d.x0, px), Math.max(d.y0, py), W, H);
      const inside = (q) => q.x >= a.x && q.x <= b.x && q.y >= a.y && q.y <= b.y;
      const n = new Set();
      for (const s of data.s.values()) if (inside(s)) n.add(s.id);
      for (const l of data.l) { const p = resolve(l, data.s); if (p.length && p.every(inside)) n.add(l.id); }
      st.sel = n;
    }
  }
  render();
}

// 選んだものへの操作
function selectedData(cid) { return load(cid); }
function duplicateSel(cid) {
  const data = selectedData(cid);
  const map = new Map(), newSel = new Set();
  for (const s of data.s.values()) {
    if (!st.sel.has(s.id)) continue;
    const id = newId('s');
    map.set(s.id, id);
    save(cid, { ...s, id, x: snap(s.x + 2), y: snap(s.y + 2), ts: Date.now() });
    newSel.add(id);
  }
  for (const l of data.l) {
    if (!st.sel.has(l.id)) continue;
    const id = newId('l');
    const pts = (l.pts || []).map(p => {
      if (p.s && map.has(p.s)) return { s: map.get(p.s) };
      const q = pointOf(p, data.s);
      return q ? { x: snap(q.x + 2), y: snap(q.y + 2) } : null;
    }).filter(Boolean);
    save(cid, { ...l, id, pts, ts: Date.now() });
    newSel.add(id);
  }
  st.sel = newSel;
}
function deleteSel(cid) {
  const data = selectedData(cid);
  for (const s of data.s.values()) {
    if (!st.sel.has(s.id)) continue;
    // 駅を消すと、その駅に結んでいた線の点は、消える位置にそのまま残す
    for (const l of data.l) {
      if (!(l.pts || []).some(p => p.s === s.id)) continue;
      l.pts = l.pts.map(p => { if (p.s !== s.id) return p; const q = pointOf(p, data.s); return q ? { x: q.x, y: q.y } : null; }).filter(Boolean);
      save(cid, l);
    }
    removeItem(cid, s);
  }
  for (const l of data.l) if (st.sel.has(l.id)) removeItem(cid, l);
  st.sel = new Set();
}
function setOpacity(cid, v) {
  const data = selectedData(cid);
  for (const s of data.s.values()) if (st.sel.has(s.id)) { s.op = v / 100; save(cid, s); }
  for (const l of data.l) if (st.sel.has(l.id)) { l.op = v / 100; save(cid, l); }
}

function lineDone() {
  const cid = st.cid;
  if (st.draft.length < 2) return;
  const id = newId('l');
  save(cid, { id, kind: 'l', color: st.lColor, width: st.lWidth, curve: st.lCurve, op: 1, pts: st.draft.slice(), ts: Date.now() });
  st.draft = [];
  st.sel = new Set([id]);
}

// ---------- 画面の操作（ボタン・入力） ----------
function onClick(e) {
  const b = e.target.closest && e.target.closest('[data-rt]');
  if (!b || !el.contains(b)) return;
  const act = b.dataset.rt, v = b.dataset.v;
  const cid = st.cid;
  if (act === 'tool') { st.tool = v; st.draft = []; st.box = null; }
  else if (act === 'grid') st.grid = !st.grid;
  else if (act === 'zoomin') st.zoom = Math.min(120, st.zoom * 1.25);
  else if (act === 'zoomout') st.zoom = Math.max(12, st.zoom / 1.25);
  else if (act === 'center') { st.ox = 0; st.oy = 0; }
  else if (act === 'linedone') lineDone();
  else if (act === 'linecancel') st.draft = [];
  else if (act === 'dup' && canEdit(cid)) duplicateSel(cid);
  else if (act === 'del' && canEdit(cid)) deleteSel(cid);
  else if (act === 'desel') st.sel = new Set();
  render();
}
function onChange(e) {
  const f = e.target.dataset && e.target.dataset.rtF;
  if (!f) return;
  const t = e.target;
  if (f === 'cid') { st.cid = t.value; st.sel = new Set(); st.draft = []; st.ox = 0; st.oy = 0; }
  else if (f === 'sName') st.sName = t.value;
  else if (f === 'sSize') st.sSize = Number(t.value);
  else if (f === 'lColor') st.lColor = t.value;
  else if (f === 'lWidth') st.lWidth = Number(t.value);
  else if (f === 'lCurve') st.lCurve = t.checked;
  else if (f === 'opacity' && canEdit(st.cid)) { st.opacity = Number(t.value); setOpacity(st.cid, st.opacity); }
  else if (f === 'rename' && canEdit(st.cid)) {
    const data = selectedData(st.cid);
    const id = [...st.sel][0];
    const s = data.s.get(id);
    if (s) { s.name = t.value.trim().slice(0, 12) || s.name; save(st.cid, s); }
  }
  render();
}
function onInput(e) {
  const t = e.target;
  if (t.dataset && t.dataset.rtF === 'sName') st.sName = t.value;
}

// ---------- 画面の組み立て ----------
function mount(root) {
  el = root;
  el.innerHTML = `<div id="rtTop"></div><div id="rtTools"></div>
    <canvas style="width:100%;height:280px;display:block;border-radius:10px;touch-action:none;background:#f6f3ea"></canvas>
    <div id="rtPanel"></div>
    <div style="font-size:11px;opacity:.7;margin-top:6px">変えるたびに自動で保存されます。部屋に入っていれば、ほかの人にも届きます。</div>`;
  canvasEl = el.querySelector('canvas');
  if (!el.dataset.rtReady) {
    el.dataset.rtReady = '1';
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    el.addEventListener('input', onInput);
    el.addEventListener('keydown', e => e.stopPropagation());
    el.addEventListener('keyup', e => e.stopPropagation());
  }
  canvasEl.addEventListener('pointerdown', onDown);
  canvasEl.addEventListener('pointermove', onMove);
  canvasEl.addEventListener('pointerup', onUp);
  canvasEl.addEventListener('pointercancel', onUp);
  if (ro) ro.disconnect();
  if (window.ResizeObserver) { ro = new ResizeObserver(() => draw()); ro.observe(canvasEl); }
  if (unsub) unsub();
  unsub = E().subscribe(() => {
    if (!el || !el.isConnected) return;
    const x = document.activeElement;
    if (x && el.contains(x) && /INPUT|TEXTAREA|SELECT/.test(x.tagName)) { draw(); return; }
    render();
  });
  render();
}

function whenReady() {
  if (!window.VoxelPhone || !VoxelPhone.registerApp || !window.VoxelEconomy || !VoxelEconomy.subscribe) { setTimeout(whenReady, 200); return; }
  VoxelPhone.registerApp({ id: 'route', name: '路線図', emoji: '🚉', mount });
}
whenReady();

window.VoxelRoute = { load, stats: () => ({ cid: st.cid, tool: st.tool, selected: st.sel.size }) };
})();
