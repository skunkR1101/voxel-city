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

  // 通る点（[{x,z,y}, ...]）を、なめらかな曲線（Catmull-Rom）で結び、1マスごとの等間隔の点に分ける
  // 戻り値：path（各点 {x,z,s}：s は始点からの長さ）と、元の点ごとの長さ位置 ctrlS
  function resamplePath(points, step = 1) {
    if (points.length < 2) throw new Error('経路の点が2つ以上必要です');
    const P = points, N = 24;
    const dense = [];
    for (let k = 0; k < P.length - 1; k++) {
      const p0 = P[Math.max(0, k - 1)], p1 = P[k], p2 = P[k + 1], p3 = P[Math.min(P.length - 1, k + 2)];
      for (let j = 0; j < N; j++) {
        const t = j / N, t2 = t * t, t3 = t2 * t;
        const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
        dense.push({ x: f(p0.x, p1.x, p2.x, p3.x), z: f(p0.z, p1.z, p2.z, p3.z) });
      }
    }
    const last = P[P.length - 1];
    dense.push({ x: last.x, z: last.z });
    // 累積の長さ
    const cum = [0];
    for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + Math.hypot(dense[i].x - dense[i - 1].x, dense[i].z - dense[i - 1].z));
    const total = cum[cum.length - 1];
    const ctrlS = P.map((_, k) => (k < P.length - 1 ? cum[k * N] : total));
    // 1マスごとに取り直す
    const path = [];
    let j = 0;
    const count = Math.floor(total / step + 1e-9);
    for (let k = 0; k <= count; k++) {
      const target = k * step;
      while (j < dense.length - 2 && cum[j + 1] < target) j++;
      const A = dense[j], B = dense[j + 1];
      const seg = (cum[j + 1] - cum[j]) || 1e-9;
      const t = Math.min(1, Math.max(0, (target - cum[j]) / seg));
      path.push({ x: A.x + (B.x - A.x) * t, z: A.z + (B.z - A.z) * t, s: target });
    }
    if (total - count * step > 1e-6) path.push({ x: last.x, z: last.z, s: total });
    return { path, ctrlS, total };
  }

  // 元の点の高さを、長さの位置で直線につなぐ
  function heightAt(ctrlS, ys, s) {
    if (s <= ctrlS[0]) return ys[0];
    for (let k = 0; k < ctrlS.length - 1; k++) {
      if (s <= ctrlS[k + 1]) {
        const span = ctrlS[k + 1] - ctrlS[k] || 1e-9;
        return ys[k] + (ys[k + 1] - ys[k]) * ((s - ctrlS[k]) / span);
      }
    }
    return ys[ys.length - 1];
  }

  const SUPPORT_DEPTH = 8;   // 坂の下の支え（空気のところだけ、この深さまで埋める）

  // 経路と断面から、生成するブロックを計算する
  // opts: { clip:{sx,sy,sz,ids}, front:0-3, includeAir, points:[{x,z,y}], baseY, maxOps, isAir:(x,y,z)=>bool（支えを埋める判定。省略可） }
  // 戻り値：{ ops:[{x,y,z,id}], length, slices }   （id が 0 のものは「空気＝消す」）
  function generate(opts) {
    const { clip, front = 0, includeAir = false, points, baseY, maxOps = 300000, isAir = null } = opts;
    const F = frameOf(clip, front);
    const SUB = 0.25;                          // 経路の刻み（斜めでも隙間が空かないように細かく置く）
    const { path, ctrlS, total } = resamplePath(points, SUB);
    if (total < 1) throw new Error('経路が短すぎます');
    // 高さはタップした面の高さをそのまま使う（点に高さが無いときだけ baseY）
    const ys = points.map(p => (typeof p.y === 'number' && isFinite(p.y)) ? p.y : baseY);
    const hasRamp = ys.some(v => v !== ys[0]);
    const map = new Map();                     // "x,y,z" -> id
    const colLow = new Map();                  // "x,z" -> { minY, id }（その場所で一番低い固体）
    const half = (F.W - 1) / 2;
    const put = (wx, wy, wz, id) => {
      const key = wx + ',' + wy + ',' + wz;
      map.set(key, id);
      const ck = wx + ',' + wz;
      const cur = colLow.get(ck);
      if (!cur || wy < cur.minY) colLow.set(ck, { minY: wy, id });
    };
    for (let i = 0; i < path.length; i++) {
      const a = path[i];
      const b = path[Math.min(i + 1, path.length - 1)];
      let tx = b.x - a.x, tz = b.z - a.z;
      if (i === path.length - 1) { tx = a.x - path[i - 1].x; tz = a.z - path[i - 1].z; }
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const nx = -tz, nz = tx;
      const yb = Math.round(heightAt(ctrlS, ys, a.s));   // この位置の断面の底の高さ（タップした面の高さ）
      const l = Math.floor(a.s) % F.L;                   // 断面の「長さ」の位置（経路1マスごとに1つ進む）
      for (let u = 0; u < F.W; u++) {
        const du = u - half;
        const wx = Math.round(a.x + nx * du);
        const wz = Math.round(a.z + nz * du);
        for (let y = 0; y < F.H; y++) {
          const id = F.at(u, y, l);
          if (id === 0) { if (includeAir) map.set(wx + ',' + (yb + y) + ',' + wz, 0); continue; }
          put(wx, yb + y, wz, id);
        }
        // 幅の中間（隣との間）も、どちらかが固体なら埋める（斜めの隙間を防ぐ）
        if (u + 1 < F.W) {
          const mx = Math.round(a.x + nx * (du + 0.5)), mz = Math.round(a.z + nz * (du + 0.5));
          for (let y = 0; y < F.H; y++) {
            const id = F.at(u, y, l) || F.at(u + 1, y, l);
            if (id) put(mx, yb + y, mz, id);
          }
        }
      }
      if (map.size > maxOps) throw new Error('生成するブロックが多すぎます（' + maxOps + '個まで）');
    }
    // 坂：一番低いところより高い場所の下は、空気のところだけ支えを埋める
    if (hasRamp && isAir) {
      let low = Infinity;
      for (const v of colLow.values()) low = Math.min(low, v.minY);
      for (const [ck, v] of colLow) {
        if (v.minY <= low) continue;
        const [wx, wz] = ck.split(',').map(Number);
        for (let d = 1; d <= SUPPORT_DEPTH; d++) {
          const y = v.minY - d;
          const key = wx + ',' + y + ',' + wz;
          if (map.has(key) || !isAir(wx, y, wz)) break;
          map.set(key, v.id);
        }
      }
    }
    const ops = [];
    for (const [key, id] of map) {
      const [x, y, z] = key.split(',').map(Number);
      ops.push({ x, y, z, id });
    }
    return { ops, length: total, slices: path.length };
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

  // ---------- プレビュー（生成される形を、設置する前に見せる） ----------
  let prevMesh = null;
  const PREVIEW_MAX = 20000;
  const airAt = (x, y, z) => getBlock(x, y, z) === 0;
  function clearPreview() {
    if (!prevMesh) return;
    try { scene.remove(prevMesh); prevMesh.geometry.dispose(); prevMesh.material.dispose(); } catch (e) {}
    prevMesh = null;
  }
  // 道路と同じ設定（端末ごと）：オン＝設置される通りの見た目（色は近似）、オフ＝白い四角
  function realPreviewOn() {
    try { return localStorage.getItem('vcrt_rd_preview_v1') !== '0'; } catch (e) { return true; }
  }
  function updatePreview() {
    clearPreview();
    if (!st.open || !st.clip || st.points.length < 2 || st.busy) return;
    if (typeof THREE === 'undefined' || typeof scene === 'undefined') return;
    let r;
    try {
      r = generate({ clip: st.clip.clip, front: st.front, includeAir: st.includeAir, points: st.points, baseY: st.clip.baseY, isAir: airAt });
    } catch (e) { return; }
    const ops = r.ops.filter(o => o.id !== 0).slice(0, PREVIEW_MAX);
    if (!ops.length) return;
    const real = realPreviewOn();
    const mat = real
      ? new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })
      : new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false });
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, ops.length);
    const m = new THREE.Matrix4(), c = new THREE.Color();
    ops.forEach((o, i) => {
      m.makeTranslation(o.x + 0.5, o.y + 0.5, o.z + 0.5);
      mesh.setMatrixAt(i, m);
      if (real) { c.setHSL((o.id * 0.618) % 1, 0.25, 0.62); mesh.setColorAt(i, c); }
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (real && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    scene.add(mesh);
    prevMesh = mesh;
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
    clearPreview();
  }
  function closePanel() {
    st.open = false;
    clearPreview();
    if (st.panel) st.panel.style.display = 'none';
  }

  // 道メーカーを持って道をタップ：パネルが開いていれば経路の点を追加、閉じていれば開く
  function tap() {
    if (!st.open) { openPanel(); return; }
    if (typeof raycastBlock !== 'function') return;
    const h = raycastBlock(7);
    if (!h) { say('道の上をタップしてください'); return; }
    st.points.push({ x: h.x + h.nx, z: h.z + h.nz, y: h.y + h.ny });
    say('経路の点を追加しました（' + st.points.length + '点）');
    refreshInfo();
    updatePreview();
  }

  function applyOps(ops) {
    clearPreview();
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
      r = generate({ clip: st.clip.clip, front: st.front, includeAir: st.includeAir, points: st.points, baseY: st.clip.baseY, isAir: airAt });
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
    d.querySelector('#rmFront').addEventListener('change', e => { st.front = Number(e.target.value) || 0; updatePreview(); });
    d.querySelector('#rmAir').addEventListener('change', e => { st.includeAir = !!e.target.checked; updatePreview(); });
    d.querySelector('#rmUndoPt').addEventListener('click', () => { st.points.pop(); refreshInfo(); updatePreview(); });
    d.querySelector('#rmResetPt').addEventListener('click', () => { st.points = []; refreshInfo(); clearPreview(); });
    d.querySelector('#rmRecapture').addEventListener('click', () => {
      const got = clipFromWand();
      if (!got) { say('先にステッキで道の断面を範囲選択してください'); return; }
      st.clip = got; st.points = []; refreshInfo(); clearPreview();
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
