/*
 * voxel-craft-imgconv.js — ブロック画像コンバータ（段階2：設定メニュー・位置プレビュー）
 * 段階2では、画像の読み込み・サイズ・位置・向きを決めて、白い半透明の枠で生成範囲を見せるところまで。
 * 生成（ブロック化・新しい64色のブロック・部屋への送信）は段階3で追加する。
 * 読み込み：voxel-craft-ext.js が読み込む（window.VoxelImgConv）。
 */
(function () {
  'use strict';

  const T_IMG_CONV = 63;
  const st = {
    open: false, panel: null, btn: null,
    img: null,                  // { name, w, h, thumb }（段階3で色の変換に使う）
    W: 64, H: 64, sizeTouched: false,
    planeMode: 'flat',          // 'flat' = 地面に平行, 'wall' = 垂直の壁
    ax: 0, ay: 0,               // 横軸の角度（X）・縦軸の角度（Y）、度
    posMode: 'auto',            // 'auto' = 自分の足元, 'manual' = 座標指定
    pos: { x: 0, y: 0, z: 0 },
    prev: null,                 // 位置プレビューの表示（THREE.Group）
    prev_on: false,             // プレビューを表示中か
  };

  function say(m) { try { if (typeof toast === 'function') toast(m); } catch (e) {} }
  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
  function rad(d) { return d * Math.PI / 180; }

  // ---------- 色（段階3で使う：64色＝RGBそれぞれ4段階。端末によらず同じ計算になる） ----------
  // 色は「r*16 + g*4 + b」（0〜63）の番号で表す
  function quantize(r, g, b) {
    const q = v => Math.min(3, v >> 6);
    return q(r) * 16 + q(g) * 4 + q(b);
  }
  function paletteRGB(idx) {
    const r = (idx >> 4) & 3, g = (idx >> 2) & 3, b = idx & 3;
    return [r * 64 + 32, g * 64 + 32, b * 64 + 32];
  }

  // ---------- 画像の読み込み（どの大きさでも受け付ける。表示用の小さな見本だけを作る） ----------
  async function loadFile(file) {
    let bmp;
    try {
      bmp = await createImageBitmap(file);
    } catch (e) {
      say('この画像は読み込めませんでした');
      return null;
    }
    const k = Math.min(1, 256 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const w = bmp.width, h = bmp.height;
    if (bmp.close) bmp.close();
    return { name: file.name, w, h, thumb: c };
  }

  // ---------- 生成範囲の位置と向き ----------
  // 中心の座標（ブロックの番号）。自動なら自分の足元
  function centerCell() {
    if (st.posMode === 'manual') return { x: Math.floor(st.pos.x), y: Math.floor(st.pos.y), z: Math.floor(st.pos.z) };
    const p = player.pos;
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  }
  // 生成範囲の中心（3D の点）と、向き（回転）
  function placement() {
    const c = centerCell();
    const flat = st.planeMode === 'flat';
    // 地面に平行なら、足元のブロックの上面に置く。垂直なら、ブロックの中心に置く
    const base = flat ? new THREE.Vector3(c.x + 0.5, c.y + 1.02, c.z + 0.5)
                      : new THREE.Vector3(c.x + 0.5, c.y + 0.5, c.z + 0.5);
    const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), rad(st.ax));
    const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rad(st.ay));
    const q = qy.multiply(qx);
    return { base, q, flat };
  }

  // ---------- 位置プレビュー（白い半透明の枠。何も生成しない・通信もしない） ----------
  function clearPreview() {
    if (!st.prev) return;
    try {
      scene.remove(st.prev);
      st.prev.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    } catch (e) {}
    st.prev = null;
  }
  function updatePreview() {
    clearPreview();
    if (!st.open || !st.prev_on) return;
    if (typeof THREE === 'undefined' || typeof scene === 'undefined') return;
    const W = Math.max(1, st.W), H = Math.max(1, st.H);
    const pl = placement();
    let geo = new THREE.PlaneGeometry(W, H);
    if (pl.flat) geo.rotateX(-Math.PI / 2);     // 地面に平行：XZ 面
    const group = new THREE.Group();
    const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide
    }));
    const line = new THREE.LineSegments(new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0xffffff }));
    group.add(fill, line);
    group.position.copy(pl.base);
    group.quaternion.copy(pl.q);
    scene.add(group);
    st.prev = group;
  }

  // ---------- 画面（設定メニュー） ----------
  function readInputs() {
    if (!st.panel) return;
    const $ = id => st.panel.querySelector('#' + id);
    st.W = Math.max(1, Math.floor(num($('icW').value, 64)));
    st.H = Math.max(1, Math.floor(num($('icH').value, 64)));
    st.planeMode = $('icPlane').value === 'wall' ? 'wall' : 'flat';
    st.ax = num($('icAX').value, 0);
    st.ay = num($('icAY').value, 0);
    st.posMode = $('icPosMode').value === 'manual' ? 'manual' : 'auto';
    st.pos.x = num($('icX').value, 0);
    st.pos.y = num($('icY').value, 0);
    st.pos.z = num($('icZ').value, 0);
    $('icManual').style.display = st.posMode === 'manual' ? 'block' : 'none';
  }
  function writePos(c) {
    const $ = id => st.panel.querySelector('#' + id);
    $('icX').value = c.x; $('icY').value = c.y; $('icZ').value = c.z;
  }
  function refreshInfo() {
    if (!st.panel) return;
    const info = st.panel.querySelector('#icInfo');
    if (!st.img) { info.textContent = '画像を選んでください（どの大きさでも選べます）'; return; }
    info.textContent = '画像：' + st.img.name + '（元の大きさ ' + st.img.w + ' × ' + st.img.h + ' px）';
    const thumb = st.panel.querySelector('#icThumb');
    thumb.innerHTML = '';
    const pic = document.createElement('canvas');
    pic.width = st.img.thumb.width; pic.height = st.img.thumb.height;
    pic.getContext('2d').drawImage(st.img.thumb, 0, 0);
    pic.style.cssText = 'max-width:100%;max-height:120px;image-rendering:pixelated;border-radius:6px';
    thumb.appendChild(pic);
  }

  function buildPanel() {
    if (st.panel) return;
    const d = document.createElement('div');
    d.id = 'icPanel';
    d.style.cssText = 'position:fixed;left:12px;top:108px;width:300px;max-height:min(74vh,calc(100vh - 124px));overflow:auto;' +
      'overscroll-behavior:contain;touch-action:pan-y;-webkit-overflow-scrolling:touch;z-index:2147483000;' +
      'background:rgba(18,26,36,.96);color:#fff;border-radius:10px;padding:12px;box-shadow:0 4px 16px rgba(0,0,0,.4);' +
      'font-size:14px;display:none;box-sizing:border-box';
    const inp = 'style="width:100%;box-sizing:border-box;padding:6px;margin-top:3px"';
    d.innerHTML =
      '<div id="icHead" style="font-size:17px;font-weight:bold;margin-bottom:6px;user-select:none">ブロック画像コンバータ</div>' +
      '<div id="icInfo" style="margin-bottom:6px;opacity:.9"></div>' +
      '<div id="icThumb" style="margin-bottom:8px;text-align:center"></div>' +
      '<label style="display:block;margin:6px 0">画像をアップロード<input type="file" id="icFile" accept="image/*" style="width:100%;margin-top:3px"></label>' +
      '<label style="display:block;margin:6px 0">幅（ブロック数）<input type="number" id="icW" min="1" value="64" ' + inp + '></label>' +
      '<label style="display:block;margin:6px 0">高さ（ブロック数）<input type="number" id="icH" min="1" value="64" ' + inp + '></label>' +
      '<div style="font-size:12px;opacity:.7;margin-bottom:6px">大きさの上限はありません（大きいほど重くなります。自己責任でお使いください）</div>' +
      '<label style="display:block;margin:6px 0">向き' +
      '<select id="icPlane" ' + inp + '><option value="flat">地面に平行</option><option value="wall">垂直（壁状）</option></select></label>' +
      '<label style="display:block;margin:6px 0">横軸の角度（度）<input type="number" id="icAX" step="1" value="0" ' + inp + '></label>' +
      '<label style="display:block;margin:6px 0">縦軸の角度（度）<input type="number" id="icAY" step="1" value="0" ' + inp + '></label>' +
      '<label style="display:block;margin:6px 0">中心の位置' +
      '<select id="icPosMode" ' + inp + '><option value="auto">自動（自分の足元）</option><option value="manual">座標を指定</option></select></label>' +
      '<div id="icManual" style="display:none;margin:4px 0 6px">' +
      '<div style="display:flex;gap:4px"><label style="flex:1">X<input type="number" id="icX" value="0" ' + inp + '></label>' +
      '<label style="flex:1">Y<input type="number" id="icY" value="0" ' + inp + '></label>' +
      '<label style="flex:1">Z<input type="number" id="icZ" value="0" ' + inp + '></label></div>' +
      '<button id="icUseMe" style="margin-top:6px;padding:6px 10px;width:100%">今の位置を入れる</button>' +
      '<div style="font-size:12px;opacity:.7;margin-top:4px">持っている間に地面をタップすると、その場所が入ります</div></div>' +
      '<div style="display:flex;gap:6px;margin-top:10px">' +
      '<button id="icPrev" style="flex:1;padding:8px">位置プレビュー表示</button>' +
      '<button id="icGen" style="flex:1;padding:8px" disabled>生成（段階3で有効）</button></div>' +
      '<div style="display:flex;gap:6px;margin-top:6px">' +
      '<button id="icHide" style="flex:1;padding:8px">プレビューを消す</button>' +
      '<button id="icClose" style="flex:1;padding:8px">閉じる</button></div>';
    document.body.appendChild(d);
    st.panel = d;

    const $ = id => d.querySelector('#' + id);
    $('icFile').addEventListener('change', async e => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const img = await loadFile(f);
      if (!img) return;
      st.img = img;
      // 向きの比率に合わせて、幅 64 を基準に高さを決める（変更されていれば、そのまま）
      const ratio = img.h / img.w;
      $('icW').value = 64;
      $('icH').value = Math.max(1, Math.round(64 * ratio));
      refreshInfo();
      readInputs();
      updatePreview();
    });
    ['icW', 'icH', 'icPlane', 'icAX', 'icAY', 'icPosMode', 'icX', 'icY', 'icZ'].forEach(id => {
      $(id).addEventListener('change', () => { readInputs(); updatePreview(); });
      $(id).addEventListener('input', () => { readInputs(); updatePreview(); });
    });
    $('icUseMe').addEventListener('click', () => {
      writePos(centerCell());
      $('icPosMode').value = 'manual';
      readInputs(); updatePreview();
    });
    $('icPrev').addEventListener('click', () => {
      if (!st.img) { say('先に画像を選んでください'); return; }
      readInputs();
      st.prev_on = true;
      updatePreview();
      say('白い枠が生成される範囲です');
    });
    $('icHide').addEventListener('click', () => { st.prev_on = false; clearPreview(); });
    $('icClose').addEventListener('click', closePanel);

    // 画面の下側に隠れても、このメニューは見切れずにスクロールできる（上の style の overflow:auto）
    const b = document.createElement('button');
    b.id = 'icOpenBtn';
    b.textContent = '🖼 画像変換を開く';
    b.style.cssText = 'position:fixed;right:12px;bottom:300px;padding:10px 14px;border:none;border-radius:8px;' +
      'background:#6a3e9a;color:#fff;font-size:15px;z-index:55;display:none';
    b.addEventListener('click', e => { e.stopPropagation(); openPanel(); });
    document.body.appendChild(b);
    st.btn = b;
    setInterval(() => {
      const held = !!window.HOTBAR && typeof selIdx !== 'undefined' && HOTBAR[selIdx] === T_IMG_CONV;
      st.btn.style.display = held ? 'block' : 'none';
    }, 300);
  }

  function openPanel() {
    buildPanel();
    st.open = true;
    st.panel.style.display = 'block';
    refreshInfo();
    readInputs();
  }
  function closePanel() {
    st.open = false;
    st.prev_on = false;
    clearPreview();
    if (st.panel) st.panel.style.display = 'none';
  }

  // 画像変換を持って地面をタップ：パネルが閉じていれば開く。開いていれば、タップした場所を中心にする
  function tap() {
    if (!st.open) { openPanel(); return; }
    if (typeof raycastBlock !== 'function') return;
    const h = raycastBlock(7);
    if (!h) { say('地面をタップしてください'); return; }
    const c = { x: h.x + h.nx, y: h.y + h.ny, z: h.z + h.nz };
    st.posMode = 'manual';
    st.pos = c;
    writePos(c);
    st.panel.querySelector('#icPosMode').value = 'manual';
    readInputs();
    updatePreview();
    say('中心を（' + c.x + ', ' + c.y + ', ' + c.z + '）にしました');
  }

  window.VoxelImgConv = { tap, open: openPanel, close: closePanel, T_IMG_CONV };
})();
