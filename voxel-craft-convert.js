/* voxel-craft-convert.js  (v2)  ブロック→乗り物（段階3）
 *
 * ステッキで2点を選んで「この範囲を部品に追加」を、部品ごとに繰り返し、「車両を作る」で、
 *   ・車・バス：自分の車（traffic）として登録（OBJ・MTL・テクスチャを作り、既存の読み込みに渡す）
 *   ・電車：トレインの車両として登録（部品ごとのグループを作る。ドアなどは、部品名でアニメーションに使う）
 *
 * 取り込めるもの：
 *   ・標準ブロック：面ごとに、アトラスのタイル画像を切り出して貼る
 *   ・カスタムの絵のブロック：絵をそのまま貼る（色を付けたものは色も掛かる）
 *   ・カスタムのモデル（OBJ）のブロック：モデルの形・テクスチャ・色のまま取り込む（傾き・向きも含む）
 *   ・傾きブロック：中心と向きごと取り込む
 * マテリアルの接頭辞（車の判定に使う）：solid_（ふつう）・glow_（発光）・glass_（半透明）
 *
 * 読み込み：voxel-craft-ext.js が読み込む。窓口は voxel-craft-train.js・voxel-craft-traffic.js から使う。
 */
(function () {
  'use strict';
  if (window.VoxelConvert) return;

  // 標準ブロックの代表色（タイル画像が取れないときの色）
  const STD_COLOR = { 1: '#6a9f3e', 2: '#8a5a32', 3: '#8c8c8c', 4: '#e3d28c', 5: '#6e4b2a', 6: '#3f7d32', 8: '#b8895a', 9: '#7b7b7b', 10: '#3a3a3a', 11: '#f5f9ff', 12: '#9d9892' };
  // 6つの面（BoxGeometry と同じ順：+X, -X, +Y, -Y, +Z, -Z）。外向きの法線と、四隅（±0.5 の大きさ）
  const FACES = [
    { n: [1, 0, 0], v: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
    { n: [-1, 0, 0], v: [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]] },
    { n: [0, 1, 0], v: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]] },
    { n: [0, -1, 0], v: [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]] },
    { n: [0, 0, 1], v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { n: [0, 0, -1], v: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] }
  ];
  const UV4 = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const Qy90 = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

  const S = { parts: [], panel: null, list: null, msg: null, nameIn: null, lenIn: null, partIn: null, typeSel: null, atlasCache: new Map() };

  window.VoxelConvert = {
    open,
    // 電車の窓口：保存された車両（blocks の文字列）を読み取る（テクスチャは別に読み込んでから渡す）
    parseBlocks,
    buildRoot,
    _pure: { qrot, qmul, normalize, buildObj, buildMtl, cubeFaceTris }
  };

  // ============================================================
  // 小さな計算
  // ============================================================
  function qmul(a, b) {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
    ];
  }
  function qrot(q, v) {
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    const tx = 2 * (qy * v[2] - qz * v[1]), ty = 2 * (qz * v[0] - qx * v[2]), tz = 2 * (qx * v[1] - qy * v[0]);
    return [
      v[0] + qw * tx + (qy * tz - qz * ty),
      v[1] + qw * ty + (qz * tx - qx * tz),
      v[2] + qw * tz + (qx * ty - qy * tx)
    ];
  }
  const hexToRgb = h => { const n = parseInt(h.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
  const r3 = v => +v.toFixed(3), r4 = v => +v.toFixed(4);

  // ============================================================
  // 材料と三角形の集め場所（部品・材料ごとに、頂点の一覧を作る）
  // ============================================================
  // 材料：見た目の種類（f）・色（col）・テクスチャの名前（tk。なければ null）
  function newBuckets() { return { map: new Map(), tex: new Map() }; }
  function bucketOf(B, part, mat) {
    const key = part + '\u0001' + mat.f + '|' + mat.col + '|' + (mat.tk || '-');
    let b = B.map.get(key);
    if (!b) { b = { part, mat, P: [], N: [], U: [] }; B.map.set(key, b); }
    return b;
  }
  function pushVert(b, p, n, uv) {
    b.P.push(p[0], p[1], p[2]); b.N.push(n[0], n[1], n[2]); b.U.push(uv[0], uv[1]);
  }
  // 面を2つの三角形にして、材料の集めに入れる
  function pushQuad(b, corners, normal) {
    const idx = [[0, 1, 2], [0, 2, 3]];
    for (const t of idx) for (const i of t) pushVert(b, corners[i], normal, UV4[i]);
  }
  // 1つの立方体（傾き・大きさ込み）の面を、材料ごとに集める
  function cubeFaceTris(c, q, s, id, st, def, part, B) {
    const h = 0.5 * s;
    FACES.forEach((f, fi) => {
      const corners = f.v.map(p => {
        const w = qrot(q, [p[0] * h, p[1] * h, p[2] * h]);
        return [c[0] + w[0], c[1] + w[1], c[2] + w[2]];
      });
      const n = qrot(q, f.n);
      let mat;
      if (!def) {
        // 標準ブロック：面ごとのタイル画像
        const tile = tileIndex(id, fi);
        mat = { f: 'solid', col: '#ffffff', tk: 'a' + tile, tile };
        if (!B.tex.has(mat.tk)) B.tex.set(mat.tk, atlasTileUrl(tile));
      } else {
        const hasTex = typeof def.texData === 'string' && def.texData.indexOf('data:') === 0;
        mat = {
          f: def.alpha === 'glow' ? 'glow' : (def.alpha === 'blend' ? 'glass' : 'solid'),
          col: def.colorable ? ((st && st.color) || '#ffffff') : '#ffffff',
          tk: hasTex ? 'd' + id : null
        };
        if (hasTex && !B.tex.has(mat.tk)) B.tex.set(mat.tk, def.texData);
      }
      pushQuad(bucketOf(B, part, mat), corners, n);
    });
  }
  // アトラスのタイルを、1枚の画像（dataURL）に切り出す
  function atlasTileUrl(tile) {
    if (S.atlasCache.has(tile)) return S.atlasCache.get(tile);
    const src = atlasTex.image;
    const sz = Math.floor(src.width / 4);
    const col = tile % 4, row = Math.floor(tile / 4);
    const cv = document.createElement('canvas');
    cv.width = sz; cv.height = sz;
    cv.getContext('2d').drawImage(src, col * sz, row * sz, sz, sz, 0, 0, sz, sz);
    const url = cv.toDataURL('image/png');
    S.atlasCache.set(tile, url);
    return url;
  }
  function imageUrl(img) {
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    cv.getContext('2d').drawImage(img, 0, 0);
    return cv.toDataURL('image/png');
  }
  // モデル（OBJ）のブロック：世界の位置に置かれたオブジェクトの三角形を、そのまま集める
  function meshTris(root, def, st, part, B) {
    root.updateMatrixWorld(true);
    root.traverse(m => {
      if (!m.isMesh || !m.geometry || !m.geometry.attributes.position) return;
      const g = m.geometry, pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
      const idx = g.index ? g.index.array : null;
      const count = idx ? idx.length : pos.count;
      const mat0 = Array.isArray(m.material) ? m.material[0] : m.material;
      let tk = null;
      if (mat0 && mat0.map && mat0.map.image && (mat0.map.image.width || mat0.map.image.naturalWidth)) {
        tk = 'm' + mat0.map.uuid;
        if (!B.tex.has(tk)) B.tex.set(tk, imageUrl(mat0.map.image));
      }
      const colHex = (def.colorable && st && st.color) ? st.color : (mat0 && mat0.color ? '#' + mat0.color.getHexString() : '#ffffff');
      const mat = {
        f: def.alpha === 'glow' ? 'glow' : (def.alpha === 'blend' ? 'glass' : 'solid'),
        col: tk ? ((def.colorable && st && st.color) ? st.color : '#ffffff') : colHex,
        tk
      };
      const b = bucketOf(B, part, mat);
      const nm = new THREE.Matrix3().getNormalMatrix(m.matrixWorld);
      const v = new THREE.Vector3(), n = new THREE.Vector3();
      for (let i = 0; i < count; i++) {
        const k = idx ? idx[i] : i;
        v.fromBufferAttribute(pos, k).applyMatrix4(m.matrixWorld);
        if (nor) n.fromBufferAttribute(nor, k).applyMatrix3(nm).normalize(); else n.set(0, 1, 0);
        const u = uv ? [uv.getX(k), uv.getY(k)] : [0, 0];
        pushVert(b, [v.x, v.y, v.z], [n.x, n.y, n.z], u);
      }
    });
  }

  // 範囲の中のブロックを集める（部品の名前付き）
  function gatherRange(min, max, part, B, seen, out) {
    const X = window.VoxelExt;
    for (let x = min[0]; x <= max[0]; x++) for (let y = min[1]; y <= max[1]; y++) for (let z = min[2]; z <= max[2]; z++) {
      const id = getBlock(x, y, z);
      if (id === AIR || id === WATER) continue;
      const k = X.keyOf(x, y, z);
      if (seen.has(k)) continue;
      seen.add(k);
      const st = X.blockState.get(k) || null;
      const rt = id >= X.CUSTOM_BASE ? X.defRT.get(id) : null;
      const def = rt && rt.ready ? rt.def : null;
      if (id >= X.CUSTOM_BASE) {
        if (!def) { out.skipped++; continue; }
        if (def.kind === 'model') {
          const inst = X.makeModelInstance(id, x, y, z);
          if (!inst) { out.skipped++; continue; }
          meshTris(inst, def, st, part, B);
          out.count++;
          continue;
        }
      }
      cubeFaceTris([x + 0.5, y + 0.5, z + 0.5], [0, 0, 0, 1], 1, id, st, def, part, B);
      out.count++;
    }
    // 傾き・斜めのブロック（中心が範囲の中にあるもの）
    const X2 = window.VoxelExt;
    for (const e of X2.tiltList) {
      if (!e.obj || e.hideDraft || !e.c) continue;
      if (![0, 1, 2].every(i => e.c[i] >= min[i] && e.c[i] < max[i] + 1)) continue;
      const rt = e.id >= X2.CUSTOM_BASE ? X2.defRT.get(e.id) : null;
      const def = rt && rt.ready ? rt.def : null;
      if (e.isModel) {
        if (!def) { out.skipped++; continue; }
        meshTris(e.obj, def, e.st || null, part, B);
        out.count++;
        continue;
      }
      cubeFaceTris(e.c, [e.q.x, e.q.y, e.q.z, e.q.w], e.s || 1, e.id, e.st || null, def, part, B);
      out.count++;
    }
  }

  // 車両の向きと位置を整える：長い方を前後（+Z）にし、最小の角を原点に置く
  function normalize(B) {
    const all = [...B.map.values()];
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    const scan = (fn) => { for (const b of all) for (let i = 0; i < b.P.length; i += 3) fn([b.P[i], b.P[i + 1], b.P[i + 2]]); };
    scan(p => { for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], p[i]); mx[i] = Math.max(mx[i], p[i]); } });
    const turn = (mx[0] - mn[0]) > (mx[2] - mn[2]);
    if (turn) {
      for (const b of all) {
        for (let i = 0; i < b.P.length; i += 3) {
          const r = qrot(Qy90, [b.P[i], b.P[i + 1], b.P[i + 2]]); b.P[i] = r[0]; b.P[i + 1] = r[1]; b.P[i + 2] = r[2];
          const n = qrot(Qy90, [b.N[i], b.N[i + 1], b.N[i + 2]]); b.N[i] = n[0]; b.N[i + 1] = n[1]; b.N[i + 2] = n[2];
        }
      }
      mn.fill(Infinity); mx.fill(-Infinity);
      scan(p => { for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], p[i]); mx[i] = Math.max(mx[i], p[i]); } });
    }
    for (const b of all) for (let i = 0; i < b.P.length; i += 3) {
      b.P[i] -= mn[0]; b.P[i + 1] -= mn[1]; b.P[i + 2] -= mn[2];
    }
    return { buckets: all, length: Math.max(mx[2] - mn[2], 0.5) };
  }

  // 材料の一覧（車のマテリアル名。接頭辞で発光・半透明を判定する）
  function materialsOf(buckets) {
    const m = new Map();
    for (const b of buckets) {
      const k = b.mat.f + '|' + b.mat.col + '|' + (b.mat.tk || '-');
      if (!m.has(k)) m.set(k, { name: b.mat.f + '_m' + m.size, f: b.mat.f, col: b.mat.col, tk: b.mat.tk, k });
    }
    return m;
  }

  // ============================================================
  // OBJ と MTL（車・バス）
  // ============================================================
  const safe = s => String(s).replace(/[^\w぀-ヿ一-鿿-]/g, '_') || 'part';
  // parts: [{ name, buckets }]。頂点は、全部で1対1の番号（v・vt・vn の番号は同じ）
  function buildObj(parts, mats) {
    const L = ['# voxel-craft blocks'];
    let vc = 0;
    for (const p of parts) {
      L.push('o ' + safe(p.name));
      for (const b of p.buckets) {
        const mname = mats.get(b.mat.f + '|' + b.mat.col + '|' + (b.mat.tk || '-')).name;
        L.push('usemtl ' + mname);
        const n = b.P.length / 3;
        for (let i = 0; i < n; i++) {
          L.push('v ' + r4(b.P[i * 3]) + ' ' + r4(b.P[i * 3 + 1]) + ' ' + r4(b.P[i * 3 + 2]));
          L.push('vt ' + r4(b.U[i * 2]) + ' ' + r4(b.U[i * 2 + 1]));
          L.push('vn ' + r4(b.N[i * 3]) + ' ' + r4(b.N[i * 3 + 1]) + ' ' + r4(b.N[i * 3 + 2]));
        }
        for (let t = 0; t < n; t += 3) {
          const a = vc + t + 1;
          L.push('f ' + [a, a + 1, a + 2].map(x => x + '/' + x + '/' + x).join(' '));
        }
        vc += n;
      }
    }
    return L.join('\n') + '\n';
  }
  function texFile(tk) { return safe(tk) + '.png'; }
  function buildMtl(mats) {
    const L = [];
    for (const m of mats.values()) {
      L.push('newmtl ' + m.name);
      L.push('Kd ' + hexToRgb(m.col).map(v => v.toFixed(3)).join(' '));
      if (m.tk) L.push('map_Kd ' + texFile(m.tk));
      L.push('');
    }
    return L.join('\n');
  }

  // ============================================================
  // 電車：部品ごとのグループ（car.blocks の中身から作る）
  // ============================================================
  // 保存する形（JSON）：{ v:2, texs:{ tk: dataURL }, parts:[{ name, mats:[{f,col,tk,P,N,U}] }] }
  function parseBlocks(text) {
    return typeof text === 'string' ? JSON.parse(text) : text;
  }
  // texMap：テクスチャの名前 → THREE.Texture（呼び出し側で読み込んでおく）
  function buildRoot(data, texMap) {
    texMap = texMap || {};
    const root = new THREE.Group();
    for (const part of data.parts || []) {
      const grp = new THREE.Group();
      grp.name = part.name;
      for (const m of part.mats) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(m.P, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(m.N, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(m.U, 2));
        const tex = m.tk && texMap[m.tk] ? texMap[m.tk] : null;
        const color = (tex && m.col === '#ffffff') ? '#ffffff' : m.col;
        let mat;
        if (m.f === 'glow') mat = new THREE.MeshLambertMaterial({ color, map: tex, alphaTest: tex ? 0.3 : 0, emissive: new THREE.Color(color), emissiveMap: tex, emissiveIntensity: 1 });
        else if (m.f === 'glass') mat = new THREE.MeshLambertMaterial({ color, map: tex, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide });
        else mat = new THREE.MeshLambertMaterial({ color, map: tex, alphaTest: tex ? 0.3 : 0, side: tex ? THREE.DoubleSide : THREE.FrontSide });
        grp.add(new THREE.Mesh(geo, mat));
      }
      root.add(grp);
    }
    return root;
  }

  // ============================================================
  // 画面（パネル）
  // ============================================================
  function open(kind) {
    ensurePanel();
    S.typeSel.value = kind === 'train' ? 'train' : (kind === 'bus' ? 'bus' : 'car');
    S.panel.style.display = '';
    renderList();
  }
  function ensurePanel() {
    if (S.panel) return;
    const p = document.createElement('div');
    p.id = 'cvPanel';
    p.style.cssText = 'position:fixed;left:50%;top:5%;transform:translateX(-50%);z-index:60;width:min(440px,94vw);max-height:88vh;overflow:auto;background:#fff;color:#222;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);padding:12px;font-size:14px;display:none;box-sizing:border-box';
    p.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <b style="font-size:16px">ブロックで車両を作る</b>
        <button data-c="close" style="padding:4px 10px">閉じる</button>
      </div>
      <div style="margin:6px 0">種類 <select id="cvType" style="padding:4px"><option value="car">車</option><option value="bus">バス</option><option value="train">電車（トレイン）</option></select></div>
      <div style="margin:6px 0">名前 <input id="cvName" value="自作の車両" style="width:200px;padding:4px"></div>
      <div style="margin:6px 0">長さ（m・マス）<input id="cvLen" type="number" step="0.5" min="1" value="20" style="width:90px;padding:4px"></div>
      <hr>
      <p style="margin:4px 0;font-size:13px">ステッキで2点を選び、部品名を入れて「この範囲を部品に追加」を押します。部品は何個でも追加できます（例：本体・ドア・ライト）。</p>
      <div style="margin:6px 0">部品名 <input id="cvPart" value="本体" style="width:160px;padding:4px"></div>
      <div style="margin:6px 0"><button data-c="add" style="padding:6px 12px">この範囲を部品に追加</button></div>
      <div id="cvList" style="margin:8px 0;font-size:13px"></div>
      <div style="margin:10px 0"><button data-c="make" style="padding:8px 16px;background:#2e7d4f;color:#fff;border:0;border-radius:8px">車両を作る</button>
        <button data-c="clear" style="padding:6px 10px">部品をすべて消す</button></div>
      <div id="cvMsg" style="font-size:13px;color:#a33"></div>`;
    document.body.appendChild(p);
    S.panel = p;
    S.typeSel = p.querySelector('#cvType');
    S.nameIn = p.querySelector('#cvName');
    S.lenIn = p.querySelector('#cvLen');
    S.partIn = p.querySelector('#cvPart');
    S.list = p.querySelector('#cvList');
    S.msg = p.querySelector('#cvMsg');
    p.addEventListener('click', e => {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      const a = b.dataset.c;
      if (a === 'close') p.style.display = 'none';
      if (a === 'add') addPart();
      if (a === 'make') make();
      if (a === 'clear') { S.parts = []; renderList(); }
      if (a === 'del') { S.parts.splice(Number(b.dataset.i), 1); renderList(); }
    });
  }
  function msg(t) { if (S.msg) S.msg.textContent = t; }
  function uniqueName(base) {
    const used = new Set(S.parts.map(p => p.name));
    let k = base, i = 2;
    while (used.has(k)) k = base + i++;
    return k;
  }
  function addPart() {
    const X = window.VoxelExt;
    const r = X && X.wandRange ? X.wandRange() : null;
    if (!r) { msg('ステッキで2点を選んでから押してください'); return; }
    const name = uniqueName((S.partIn.value || '').trim() || 'パーツ');
    S.parts.push({ name, min: r.min.slice(), max: r.max.slice() });
    S.partIn.value = '';
    msg('');
    renderList();
  }
  function countPart(p) {
    const out = { count: 0, skipped: 0 };
    gatherRange(p.min, p.max, p.name, newBuckets(), new Set(), out);
    return out;
  }
  function renderList() {
    if (!S.list) return;
    if (!S.parts.length) { S.list.innerHTML = '<div style="color:#666">まだ部品がありません</div>'; return; }
    S.list.innerHTML = S.parts.map((p, i) => {
      const n = countPart(p);
      return `<div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #eee;padding:3px 0">
        <span><b>${esc(p.name)}</b>　${n.count}個${n.skipped ? '（取り込めないブロック ' + n.skipped + '個）' : ''}</span>
        <button data-c="del" data-i="${i}" style="padding:2px 8px">外す</button></div>`;
    }).join('');
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // 車両を作る
  async function make() {
    if (!S.parts.length) { msg('先に部品を追加してください'); return; }
    const B = newBuckets();
    const seen = new Set();
    const out = { count: 0, skipped: 0 };
    const partList = [];
    for (const p of S.parts) {
      gatherRange(p.min, p.max, p.name, B, seen, out);
      partList.push(p.name);
    }
    if (!out.count) { msg('範囲にブロックがありません'); return; }
    const norm = normalize(B);
    const type = S.typeSel.value;
    const name = (S.nameIn.value || '').trim() || '自作の車両';
    const len = Math.min(200, Math.max(1, Number(S.lenIn.value) || norm.length));
    msg('作っています…');
    try {
      const mats = materialsOf(norm.buckets);
      const usedTex = new Set([...mats.values()].map(m => m.tk).filter(Boolean));
      if (type === 'train') {
        if (!window.VoxelTrain || !VoxelTrain.addFromBlocks) { msg('電車の窓口が見つかりません'); return; }
        const texs = {};
        for (const tk of usedTex) texs[tk] = B.tex.get(tk);
        const parts = partList.map(pn => ({
          name: pn,
          mats: norm.buckets.filter(b => b.part === pn).map(b => {
            const m = mats.get(b.mat.f + '|' + b.mat.col + '|' + (b.mat.tk || '-'));
            return {
              f: b.mat.f, col: b.mat.col, tk: b.mat.tk,
              P: b.P.map(r3), N: b.N.map(r3), U: b.U.map(r4)
            };
          })
        }));
        const blocks = JSON.stringify({ v: 2, texs, parts });
        VoxelTrain.addFromBlocks({ name, length: len, blocks });
        msg('');
        toast('「' + name + '」を電車の車両に追加しました（ドアなどの部品は、編集画面で選べます）');
      } else {
        if (!window.VoxelTraffic || !VoxelTraffic.addCustom) { msg('車の窓口が見つかりません'); return; }
        const texs = [...usedTex].map(tk => ({ name: texFile(tk), data: B.tex.get(tk) }));
        const parts = partList.map(pn => ({ name: pn, buckets: norm.buckets.filter(b => b.part === pn) }));
        const rec = {
          id: Date.now() % 1000000000,
          name, bus: type === 'bus', len, scale: 1, front: 1, back: 0.5, alpha: 'cut', fmt: 'obj',
          model: buildObj(parts, mats), mtl: buildMtl(mats), texs
        };
        await VoxelTraffic.addCustom(rec);
        msg('');
        toast('「' + name + '」を' + (type === 'bus' ? 'バス' : '車') + 'として追加しました');
      }
    } catch (err) {
      console.error(err);
      msg('作れませんでした（ブロックの取り込みに失敗しました）');
    }
  }
  function toast(m) { msg(m); }
})();
