/*
 * voxel-craft-roadmaker.js — 道メーカー（段階1：1.0マス・平面の直線とカーブ）
 * ステッキで選んだ断面（ブロックの箱）を、タップで決めた経路に沿って押し出し、ブロックとして生成する。
 * 読み込み：voxel-craft-ext.js が読み込む。生成の計算は純粋な関数（Node でも確かめられる）。
 */
(function () {
  'use strict';

  // ---------- 純粋な計算（画面に依存しない） ----------

  // 正面の向き（0〜3）で、断面の横の軸（u：幅）と長さの軸（l：奥行き）の対応を決める
  // ids は「x + z*sx + y*sx*sz」の順。戻り値は at(u, y, l) -> id と、幅 W・高さ H・長さ L
  function frameOf(clip, front) {
    const { sx, sy, sz, ids } = clip;
    const plane = sx * sz;
    if (front === 1) return { W: sz, H: sy, L: sx, at: (u, y, l) => ids[l + u * sx + y * plane] };
    if (front === 2) return { W: sx, H: sy, L: sz, at: (u, y, l) => ids[(sx - 1 - u) + (sz - 1 - l) * sx + y * plane] };
    if (front === 3) return { W: sz, H: sy, L: sx, at: (u, y, l) => ids[(sx - 1 - l) + (sz - 1 - u) * sx + y * plane] };
    return { W: sx, H: sy, L: sz, at: (u, y, l) => ids[u + l * sx + y * plane] };
  }

  // 通る点（[{x,z}, ...]）を、なめらかな曲線（Catmull-Rom）で結び、1マスごとの等間隔の点に分ける
  function resamplePath(points) {
    if (points.length < 2) throw new Error('経路の点が2つ以上必要です');
    const dense = [];
    const P = points;
    for (let s = 0; s < P.length - 1; s++) {
      const p0 = P[Math.max(0, s - 1)], p1 = P[s], p2 = P[s + 1], p3 = P[Math.min(P.length - 1, s + 2)];
      const n = 24;
      for (let k = 0; k < n; k++) {
        const t = k / n, t2 = t * t, t3 = t2 * t;
        const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
        dense.push({ x: f(p0.x, p1.x, p2.x, p3.x), z: f(p0.z, p1.z, p2.z, p3.z) });
      }
    }
    dense.push({ x: P[P.length - 1].x, z: P[P.length - 1].z });
    // 弧の長さで、1マスごとに取り直す
    const out = [{ x: dense[0].x, z: dense[0].z }];
    let carry = 0;   // 次の点までの、まだ使っていない長さ
    for (let i = 1; i < dense.length; i++) {
      let a = dense[i - 1], b = dense[i];
      let seg = Math.hypot(b.x - a.x, b.z - a.z);
      let pos = 0;     // この区間の中での位置（長さ）
      while (carry + (seg - pos) >= 1) {
        const need = 1 - carry;
        pos += need;
        const t = pos / seg;
        out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
        carry = 0;
      }
      carry += seg - pos;
    }
    return out;
  }

  // 経路と断面から、生成するブロックを計算する
  // opts: { clip:{sx,sy,sz,ids}, front:0-3, includeAir:bool, points:[{x,z}], baseY:整数, maxOps }
  // 戻り値：{ ops:[{x,y,z,id}], length, slices }   （id が 0 のものは「空気＝消す」）
  function generate(opts) {
    const { clip, front = 0, includeAir = false, points, baseY, maxOps = 300000 } = opts;
    const F = frameOf(clip, front);
    const path = resamplePath(points);
    const total = path.length - 1;          // 全体の長さ（マス）
    if (total < 1) throw new Error('経路が短すぎます');
    const map = new Map();                  // "x,y,z" -> id
    const half = (F.W - 1) / 2;
    for (let i = 0; i <= total; i++) {
      // 経路上の位置と向き
      const a = path[Math.min(i, total)];
      const b = path[Math.min(i + 1, total)];
      let tx = b.x - a.x, tz = b.z - a.z;
      if (i === total) { tx = a.x - path[total - 1].x; tz = a.z - path[total - 1].z; }
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const nx = -tz, nz = tx;              // 進む向きの右（左の向きは符号を逆に）
      const l = i % F.L;                    // この位置で使う断面の「長さ」の位置
      for (let u = 0; u < F.W; u++) {
        const du = u - half;
        const wx = Math.round(a.x + nx * du);
        const wz = Math.round(a.z + nz * du);
        for (let y = 0; y < F.H; y++) {
          const id = F.at(u, y, l);
          const key = wx + ',' + (baseY + y) + ',' + wz;
          if (id === 0) { if (includeAir) map.set(key, 0); continue; }
          map.set(key, id);
        }
      }
      if (map.size > maxOps) throw new Error('生成するブロックが多すぎます（' + maxOps + '個まで）');
    }
    const ops = [];
    for (const [key, id] of map) {
      const [x, y, z] = key.split(',').map(Number);
      ops.push({ x, y, z, id });
    }
    return { ops, length: total, slices: total + 1 };
  }

  // ---------- 画面（道メーカーのパネル・ボタン・生成・元に戻す） ----------
  const T_ROAD_MAKER = 62;
  const st = { clip: null, points: [], front: 0, includeAir: false, open: false, busy: false, undo: null, panel: null, info: null, btn: null };
  function say(m) { try { if (typeof toast === 'function') toast(m); } catch (e) {} }

  // ステッキで選んだ範囲を、断面（ブロックの箱）として読む
  function clipFromWand() {
    const X = window.VoxelExt;
    const r = X && X.wandRange && X.wandRange();
    if (!r) return null;
    const sx = r.max[0] - r.min[0] + 1, sy = r.max[1] - r.min[1] + 1, sz = r.max[2] - r.min[2] + 1;
    if (sx * sy * sz > 262144) { say('範囲が大きすぎます（26万マスまで）'); return null; }
    const ids = new Uint16Array(sx * sy * sz);
    for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
      ids[x + z * sx + y * sx * sz] = getBlock(r.min[0] + x, r.min[1] + y, r.min[2] + z);
    }
    return { clip: { sx, sy, sz, ids }, baseY: r.min[1] };
  }

  function refreshInfo() {
    if (!st.panel) return;
    const c = st.clip && st.clip.clip;
    st.info.textContent = c
      ? `断面 ${c.sx}×${c.sy}×${c.sz}（奥行き ${c.sz}・幅 ${c.sx}）　点：${st.points.length}`
      : '断面が未選択です';
  }
  function setBusy(b) {
    if (!st.panel) return;
    st.panel.querySelectorAll('button').forEach(x => { x.disabled = b; });
  }

  function openPanel() {
    const got = clipFromWand();
    if (!got) { say('先にステッキで道の断面を範囲選択してください'); return; }
    st.clip = got; st.points = []; st.undo = null;
    buildPanel();
    st.panel.style.display = 'block';
    st.open = true;
    refreshInfo();
  }
  function closePanel() {
    st.open = false;
    if (st.panel) st.panel.style.display = 'none';
  }

  // 道メーカーを持って道をタップ：パネルが開いていれば経路の点を追加、閉じていれば開く
  function tap() {
    if (!st.open) { openPanel(); return; }
    if (typeof raycastBlock !== 'function') return;
    const h = raycastBlock(7);
    if (!h) { say('道の上をタップしてください'); return; }
    st.points.push({ x: h.x + h.nx, z: h.z + h.nz });
    say('経路の点を追加しました（' + st.points.length + '点）');
    refreshInfo();
  }

  function applyOps(ops) {
    st.busy = true; setBusy(true);
    const record = [];
    let i = 0;
    const CH = 1500;   // 一度に置く数（画面が止まらないように、数回に分ける）
    const step = () => {
      const end = Math.min(ops.length, i + CH);
      for (; i < end; i++) {
        const o = ops[i];
        record.push({ x: o.x, y: o.y, z: o.z, old: getBlock(o.x, o.y, o.z) });
        setBlock(o.x, o.y, o.z, o.id);
      }
      if (i < ops.length) { setTimeout(step, 0); return; }
      st.undo = record; st.busy = false; setBusy(false);
      say('道を生成しました（' + ops.length + '個）。「元に戻す」で取り消せます');
    };
    step();
  }

  function onGenerate() {
    if (st.busy || !st.clip) return;
    if (st.points.length < 2) { say('経路の点を2つ以上タップしてください'); return; }
    let r;
    try {
      r = generate({ clip: st.clip.clip, front: st.front, includeAir: st.includeAir, points: st.points, baseY: st.clip.baseY });
    } catch (e) { say(e.message); return; }
    applyOps(r.ops);
  }

  function onUndo() {
    if (st.busy || !st.undo) { say('元に戻せるものがありません'); return; }
    const rec = st.undo; st.undo = null;
    st.busy = true; setBusy(true);
    let i = rec.length - 1;
    const CH = 1500;
    const step = () => {
      const end = Math.max(-1, i - CH);
      for (; i > end; i--) setBlock(rec[i].x, rec[i].y, rec[i].z, rec[i].old);
      if (i >= 0) { setTimeout(step, 0); return; }
      st.busy = false; setBusy(false);
      say('元に戻しました');
    };
    step();
  }

  function buildPanel() {
    if (st.panel) { refreshInfo(); return; }
    const d = document.createElement('div');
    d.id = 'rmPanel';
    d.style.cssText = 'position:fixed;left:12px;top:150px;width:280px;max-height:70vh;overflow:auto;background:rgba(18,26,36,.96);color:#fff;border-radius:10px;padding:12px;z-index:60;font-size:14px;display:none;box-shadow:0 4px 16px rgba(0,0,0,.4)';
    d.innerHTML =
      '<div style="font-size:17px;font-weight:bold;margin-bottom:6px">道メーカー</div>' +
      '<div id="rmInfo" style="margin-bottom:8px;opacity:.9"></div>' +
      '<label style="display:block;margin:6px 0">正面（断面を回す）' +
      '<select id="rmFront" style="width:100%;margin-top:4px;padding:6px">' +
      '<option value="0">0°（そのまま）</option><option value="1">90°</option><option value="2">180°</option><option value="3">270°</option></select></label>' +
      '<label style="display:block;margin:6px 0"><input type="checkbox" id="rmAir"> 範囲内の空気も含める（空いたマスを消す）</label>' +
      '<label style="display:block;margin:6px 0;opacity:.45"><input type="checkbox" disabled> 道リストに登録（段階4で追加）</label>' +
      '<label style="display:block;margin:6px 0;opacity:.45"><input type="checkbox" disabled> 滑らか生成（斜め・傾き：段階3で追加）</label>' +
      '<div style="margin:8px 0;opacity:.85">道の上をタップして経路の点を追加します（中間点も同じ）。2点以上で生成できます。</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">' +
      '<button id="rmUndoPt">最後の点を取消</button>' +
      '<button id="rmResetPt">経路をリセット</button>' +
      '<button id="rmRecapture">範囲を取り直す</button>' +
      '<button id="rmGen" style="background:#2e6a9a">生成する</button>' +
      '<button id="rmUndo">元に戻す</button>' +
      '<button id="rmClose">閉じる</button></div>';
    document.body.appendChild(d);
    d.querySelectorAll('button').forEach(b => { b.style.cssText = 'padding:8px;border:none;border-radius:6px;background:#3a4a5a;color:#fff;font-size:14px'; });
    d.querySelector('#rmGen').style.background = '#2e6a9a';
    st.panel = d;
    st.info = d.querySelector('#rmInfo');
    d.querySelector('#rmFront').addEventListener('change', e => { st.front = Number(e.target.value) || 0; });
    d.querySelector('#rmAir').addEventListener('change', e => { st.includeAir = !!e.target.checked; });
    d.querySelector('#rmUndoPt').addEventListener('click', () => { st.points.pop(); refreshInfo(); });
    d.querySelector('#rmResetPt').addEventListener('click', () => { st.points = []; refreshInfo(); });
    d.querySelector('#rmRecapture').addEventListener('click', () => {
      const got = clipFromWand();
      if (!got) { say('先にステッキで道の断面を範囲選択してください'); return; }
      st.clip = got; st.points = []; refreshInfo();
    });
    d.querySelector('#rmGen').addEventListener('click', onGenerate);
    d.querySelector('#rmUndo').addEventListener('click', onUndo);
    d.querySelector('#rmClose').addEventListener('click', closePanel);

    // 道メーカーを持っている間だけ出る「道メーカーを開く」ボタン
    const b = document.createElement('button');
    b.id = 'rmOpenBtn';
    b.textContent = '🛣 道メーカー';
    b.style.cssText = 'position:fixed;right:12px;bottom:260px;padding:10px 14px;border:none;border-radius:8px;background:#2e6a9a;color:#fff;font-size:15px;z-index:55;display:none';
    b.addEventListener('click', e => { e.stopPropagation(); openPanel(); });
    document.body.appendChild(b);
    st.btn = b;
    setInterval(() => {
      const held = !!window.HOTBAR && typeof selIdx !== 'undefined' && HOTBAR[selIdx] === T_ROAD_MAKER;
      st.btn.style.display = held ? 'block' : 'none';
    }, 300);
  }

  if (typeof window !== 'undefined') window.VoxelRoadMaker = { tap, open: openPanel, undo: onUndo, core: { frameOf, resamplePath, generate }, T_ROAD_MAKER };

  const core = { frameOf, resamplePath, generate };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  if (typeof window !== 'undefined') window.VoxelRoadMakerCore = core;
})();
