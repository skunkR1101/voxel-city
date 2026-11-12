/* voxel-craft-edit.js  (v2)  本格エディットモード（段階2：傾き・カスタムブロック＋標準ブロック）
 *
 * 操作：タップで選ぶ → 矢印キー（左右・奥手前）、PageUp/PageDown（上下）、またはボタンで操作。
 *   ・傾き・カスタムブロック：移動・四隅スナップ・拡大縮小・回転（X/Y/Z）・複製・削除
 *   ・標準ブロック：1マス単位で移動・複製・削除。0.5マス移動・回転・拡大縮小をすると、傾きブロックに変えて扱う
 * 保存：「エディット作業を保存」で、傾きブロックの記録と部屋に反映。
 *   標準ブロックの移動・削除は、ふだんの設置・破壊と同じく、その場でワールドに反映されます（取り消しで戻ります）。
 *
 * 表示：設定の「画面上に切り替えボタンを表示」をONにすると、画面左上に「エディット」ボタンが出ます。
 *   操作パネルは、エディットモード中で、設定画面を開いていないときだけ出ます。
 *
 * 読み込み：voxel-craft-ext.js が読み込む。voxel-craft-diag.js の後で、その外側から包む。
 */
(function () {
  'use strict';
  if (window.VoxelEdit) return;

  const BTN_KEY = 'voxelcraft_edit_btn_v1';
  const S = {
    on: false,            // エディットモード中か
    sel: null,            // { ent } 傾きブロック、または { cell: {x,y,z,id} } 標準ブロック
    dr: null,             // 下書き { orig: Map(ent -> 元の配置), dels: Set(ent), adds: [ent], log: [標準ブロックの操作履歴] }
    snap: true,           // 四隅スナップ
    rotStep: 15           // 回転の角度（度）
  };
  let X = null, D = null, T = null, keyOf = null, blockState = null, box = null, unitEdges = null, panel = null, panelShown = null, toastEl = null, toastT = 0, qBtn = null;

  window.VoxelEdit = {
    isOn: () => S.on,
    setOn: v => setOn(!!v)
  };

  // 外のファイル（diag.js・ext.js）が読み終わるまで待つ。設定画面の用意も、ここで待つ
  function tryInstall() {
    if (!window.VoxelExt || !window.VoxelDiag || !window.VoxelDiag.tilt || !document.getElementById('settingsClose')) {
      setTimeout(tryInstall, 200);
      return;
    }
    install();
  }

  function install() {
    X = window.VoxelExt; D = window.VoxelDiag; T = D.tilt;
    keyOf = X.keyOf; blockState = X.blockState;
    S.dr = newDraft();
    buildBox();
    buildPanel();
    buildToast();
    buildQuickButton();
    buildSetting();

    // 置く・壊すの操作を、エディット中だけ横取りする（ふだんの動きは、そのまま）
    const prevPlace = window.doPlace, prevBreak = window.doBreak;
    window.doPlace = function () { return S.on ? onTap() : prevPlace.apply(this, arguments); };
    window.doBreak = function () { return S.on ? onBreakKey() : prevBreak.apply(this, arguments); };

    window.addEventListener('keydown', onKey);
    requestAnimationFrame(frame);
    setOn(false);
  }

  function settingsOpen() {
    return !!document.querySelector('#settings.show');
  }

  // ============================================================
  // 下書き
  // ============================================================
  function newDraft() { return { orig: new Map(), dels: new Set(), adds: [], log: [] }; }

  // 標準ブロックを置く・消す（操作履歴に残す。取り消しで逆にたどる）
  function setCell(x, y, z, id, st) {
    const k = keyOf(x, y, z);
    const prevSt = blockState.get(k) || null;
    S.dr.log.push({ x, y, z, prevId: getBlock(x, y, z), prevSt: prevSt ? { ...prevSt } : null });
    window.setBlock(x, y, z, id);
    if (st && id !== AIR) blockState.set(k, { ...st }); else blockState.delete(k);
  }
  function undoLastCell() {
    const o = S.dr.log.pop();
    if (!o) return;
    window.setBlock(o.x, o.y, o.z, o.prevId);
    const k = keyOf(o.x, o.y, o.z);
    if (o.prevSt) blockState.set(k, { ...o.prevSt }); else blockState.delete(k);
  }
  function undoAllCells() { while (S.dr.log.length) undoLastCell(); }

  // 傾きブロックの、元の配置を覚えておく（取り消しで戻すため）
  function mark(e) {
    if (!S.dr.orig.has(e)) S.dr.orig.set(e, { c: e.c.slice(), q: e.q.clone(), s: e.s || 1 });
  }
  function setEnt(e, c, q, s) {
    mark(e);
    T.place(e, c, q, s);
  }
  function sameAsOrig(o, e) {
    return o.c.every((v, i) => Math.abs(v - e.c[i]) < 1e-6) && o.q.angleTo(e.q) < 1e-6 && Math.abs(o.s - (e.s || 1)) < 1e-6;
  }
  function isDirty() {
    const d = S.dr;
    if (d.dels.size || d.adds.length || d.log.length) return true;
    for (const [e, o] of d.orig) if (!d.dels.has(e) && e.tl && !sameAsOrig(o, e)) return true;
    return false;
  }

  // 保存：傾きブロックの記録と部屋へ反映する（標準ブロックは、すでにワールドに反映済み）
  function commit() {
    const d = S.dr;
    let n = 0, lost = 0;
    for (const e of d.dels) {
      if (e.tl) T.remove(e.tl); else X.removeTilt(e);
      n++;
    }
    for (const [e, o] of d.orig) {
      if (d.dels.has(e) || !e.tl || sameAsOrig(o, e)) continue;
      if (T.move(e.tl, e, e.c, e.q, e.s)) n++; else lost++;   // 相手の変更で記録が替わっていた場合は反映しない
    }
    for (const e of d.adds) { D.adoptTilt(e); n++; }
    S.dr = newDraft();
    select(null);
    toast(n ? `保存しました（${n}件）` + (lost ? `・${lost}件は相手の変更と重なったため反映できませんでした` : '') : '変更はありません');
  }

  // 取り消し：下書きを捨て、元の状態に戻す
  function cancel() {
    const d = S.dr;
    for (const e of d.adds) X.removeTilt(e);
    for (const e of d.dels) { e.hideDraft = false; e.obj.visible = true; }
    for (const [e, o] of d.orig) {
      if (d.adds.includes(e)) continue;
      T.place(e, o.c, o.q, o.s);
    }
    undoAllCells();
    S.dr = newDraft();
    select(null);
  }

  // ============================================================
  // 選ぶ・形を見せる
  // ============================================================
  function nameOf(e) {
    const rt = e.id >= X.CUSTOM_BASE ? X.defRT.get(e.id) : null;
    return rt && rt.def && rt.def.name ? rt.def.name : '傾きブロック';
  }
  function selName() {
    if (!S.sel) return '';
    if (S.sel.ent) return nameOf(S.sel.ent);
    return '標準ブロック（ID ' + S.sel.cell.id + '）';
  }
  function select(s) {
    S.sel = s || null;
    refreshBox();
    renderPanel();
  }
  function onTap() {
    const p = X.pickTarget();
    if (p && p.kind === 'tilt' && p.ent && p.ent.tl && !p.ent.hideDraft) { select({ ent: p.ent }); toast('選択：' + nameOf(p.ent)); return; }
    if (p && p.kind === 'vox' && p.h && p.h.b && p.h.b !== AIR && p.h.b !== WATER) {
      select({ cell: { x: p.h.x, y: p.h.y, z: p.h.z, id: p.h.b } });
      toast('選択：' + selName());
      return;
    }
    select(null);
  }
  // エディット中の「壊す」：選んでいるものを消す。選んでいなければ、狙っているものを選んで消す
  function onBreakKey() {
    if (!S.sel) {
      onTap();
      if (!S.sel) return;
    }
    removeSel();
  }

  // 選んだものの輪郭（黄色の線）
  function localBox(obj) {
    const q = obj.quaternion.clone(), p = obj.position.clone(), s = obj.scale.clone();
    obj.quaternion.identity(); obj.position.set(0, 0, 0); obj.scale.set(1, 1, 1);
    obj.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(obj);
    obj.quaternion.copy(q); obj.position.copy(p); obj.scale.copy(s);
    obj.updateMatrixWorld(true);
    return b;
  }
  function buildBox() {
    box = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd54f, depthTest: false, transparent: true }));
    box.renderOrder = 999;
    box.frustumCulled = false;
    box.visible = false;
    unitEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    scene.add(box);
  }
  function refreshBox() {
    if (!S.on || !S.sel) { box.visible = false; return; }
    if (S.sel.cell) {
      if (box.geometry !== unitEdges) { box.geometry.dispose(); box.geometry = unitEdges; }
      box.visible = true;
      syncBox();
      return;
    }
    const e = S.sel.ent;
    if (!e || !e.obj) { box.visible = false; return; }
    const b = localBox(e.obj);
    const size = b.getSize(new THREE.Vector3()), mid = b.getCenter(new THREE.Vector3());
    const g = new THREE.BoxGeometry(Math.max(size.x, 0.01), Math.max(size.y, 0.01), Math.max(size.z, 0.01));
    g.translate(mid.x, mid.y, mid.z);
    const edges = new THREE.EdgesGeometry(g);
    g.dispose();
    if (box.geometry !== unitEdges) box.geometry.dispose();
    box.geometry = edges;
    syncBox();
    box.visible = true;
  }
  // 毎フレーム、選んだものの位置・向き・大きさに合わせる
  function syncBox() {
    if (!S.sel) return;
    if (S.sel.cell) {
      const c = S.sel.cell;
      box.position.set(c.x + 0.5, c.y + 0.5, c.z + 0.5);
      box.quaternion.set(0, 0, 0, 1);
      box.scale.set(1, 1, 1);
      return;
    }
    const e = S.sel.ent;
    if (!e || !e.obj) return;
    box.position.copy(e.obj.position);
    box.quaternion.copy(e.obj.quaternion);
    box.scale.copy(e.obj.scale);
  }
  function frame() {
    requestAnimationFrame(frame);
    // 設定画面を開いている間は、操作パネルを隠す（閉じるボタンを押せるように）
    const want = S.on && !settingsOpen();
    if (panel && panelShown !== want) { panel.style.display = want ? '' : 'none'; panelShown = want; }
    if (S.on && S.sel && box.visible) syncBox();
  }

  // 四隅（傾いていても、実際の向きのまま）
  function cornersOf(e) {
    const b = localBox(e.obj);
    const pts = [];
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
      pts.push(new THREE.Vector3(x, y, z).applyMatrix4(e.obj.matrixWorld));
    }
    return pts;
  }
  // 近くの傾きブロックの四隅に合わせる（0.2マス以内のときだけ。離れれば自然に外れる）
  function snapEnt(e) {
    if (!e || !S.snap) return;
    const mine = cornersOf(e);
    let best = null, bd = 0.2;
    for (const o of X.tiltList) {
      if (o === e || !o.obj || o.hideDraft || !o.c) continue;
      const dx = o.c[0] - e.c[0], dy = o.c[1] - e.c[1], dz = o.c[2] - e.c[2];
      if (dx * dx + dy * dy + dz * dz > 36) continue;   // 6マス以上離れたものは見ない
      for (const t of cornersOf(o)) for (const p of mine) {
        const d = t.distanceTo(p);
        if (d < bd) { bd = d; best = t.clone().sub(p); }
      }
    }
    if (best) setEnt(e, [e.c[0] + best.x, e.c[1] + best.y, e.c[2] + best.z], e.q, e.s);
  }

  // ============================================================
  // 操作
  // ============================================================
  function stepNow() {
    const g = X.ext.grid;
    return g > 0 ? g : 0.25;     // 0（フリー）のときは 0.25 マスずつ
  }
  // 標準ブロックを、傾きブロックに変える（中心に置き、ふだんの配置と同じ見た目のまま扱える）
  function ensureEnt() {
    const s = S.sel;
    if (!s) return null;
    if (s.ent) return s.ent;
    const cell = s.cell;
    const k = keyOf(cell.x, cell.y, cell.z);
    const st = blockState.get(k);
    const stC = st ? { color: st.color ?? null, rot: st.rot ?? 0, qb: st.qb ?? null } : null;
    setCell(cell.x, cell.y, cell.z, AIR, null);
    const c = [cell.x + 0.5, cell.y + 0.5, cell.z + 0.5];
    if (!X.addTilt(cell.id, c, new THREE.Quaternion(), stC)) {
      undoLastCell();
      toast('この標準ブロックは、傾きブロックに変えられませんでした');
      return null;
    }
    const e = X.tiltList[X.tiltList.length - 1];
    S.dr.adds.push(e);
    S.sel = { ent: e };
    return e;
  }
  function nudge(dx, dy, dz) {
    const s = S.sel;
    if (!s) return;
    const k = stepNow();
    if (s.cell) {
      if (k !== 1) {                       // 0.5 マスなどは、傾きブロックにして動かす
        const e = ensureEnt();
        if (!e) return;
        return nudge(dx, dy, dz);
      }
      const c = s.cell;
      const nx = c.x + dx, ny = c.y + dy, nz = c.z + dz;
      const cur = getBlock(nx, ny, nz);
      if (cur !== AIR && cur !== WATER) { toast('そこには動かせません（ブロックがあります）'); return; }
      const st = blockState.get(keyOf(c.x, c.y, c.z));
      setCell(c.x, c.y, c.z, AIR, null);
      setCell(nx, ny, nz, c.id, st);
      S.sel = { cell: { x: nx, y: ny, z: nz, id: c.id } };
      refreshBox();
      renderPanel();
      return;
    }
    const e = s.ent;
    setEnt(e, [e.c[0] + dx * k, e.c[1] + dy * k, e.c[2] + dz * k], e.q, e.s);
    snapEnt(e);
    refreshBox();
  }
  // 回転：ワールドの軸まわりに、回転の角度ずつ回す（中心は動かさない）
  function turn(axis, sign) {
    const e = ensureEnt();
    if (!e) return;
    const ax = axis === 'x' ? new THREE.Vector3(1, 0, 0) : axis === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    const dq = new THREE.Quaternion().setFromAxisAngle(ax, sign * S.rotStep * Math.PI / 180);
    const q = dq.multiply(e.q);
    setEnt(e, e.c, q, e.s);
    snapEnt(e);
    refreshBox();
  }
  function scaleBy(f) {
    const e = ensureEnt();
    if (!e) return;
    const s = Math.min(4, Math.max(0.25, (e.s || 1) * f));
    setEnt(e, e.c, e.q, s);
    snapEnt(e);
    refreshBox();
  }
  // 複製：1マス右（+x）にずらして、同じものを作る
  function duplicate() {
    const s = S.sel;
    if (!s) return;
    if (s.cell) {
      const c = s.cell, nx = c.x + 1;
      const cur = getBlock(nx, c.y, c.z);
      if (cur !== AIR && cur !== WATER) { toast('右のマスにブロックがあるため、複製できません'); return; }
      const st = blockState.get(keyOf(c.x, c.y, c.z));
      setCell(nx, c.y, c.z, c.id, st);
      select({ cell: { x: nx, y: c.y, z: c.z, id: c.id } });
      toast('複製しました（すぐ反映）');
      return;
    }
    const e = s.ent;
    const c = [e.c[0] + 1, e.c[1], e.c[2]];
    const st = e.st ? { ...e.st } : null;
    if (!X.addTilt(e.id, c, e.q.clone(), st)) { toast('複製できませんでした'); return; }
    const n = X.tiltList[X.tiltList.length - 1];
    T.place(n, c, e.q, e.s);
    S.dr.adds.push(n);
    select({ ent: n });
    toast('複製しました（保存で反映）');
  }
  function removeSel() {
    const s = S.sel;
    if (!s) return;
    if (s.cell) {
      const c = s.cell;
      setCell(c.x, c.y, c.z, AIR, null);
      select(null);
      toast('削除しました（すぐ反映）');
      return;
    }
    const e = s.ent;
    const i = S.dr.adds.indexOf(e);
    if (i >= 0) { S.dr.adds.splice(i, 1); X.removeTilt(e); }
    else { mark(e); S.dr.dels.add(e); e.hideDraft = true; e.obj.visible = false; }
    select(null);
    toast('削除しました（保存で反映）');
  }

  function act(a) {
    if (!S.on) return;
    switch (a) {
      case 'mx-': return nudge(-1, 0, 0);
      case 'mx+': return nudge(1, 0, 0);
      case 'mz-': return nudge(0, 0, -1);
      case 'mz+': return nudge(0, 0, 1);
      case 'my+': return nudge(0, 1, 0);
      case 'my-': return nudge(0, -1, 0);
      case 'ty+': return turn('y', 1);
      case 'ty-': return turn('y', -1);
      case 'tx+': return turn('x', 1);
      case 'tx-': return turn('x', -1);
      case 'tz+': return turn('z', 1);
      case 'tz-': return turn('z', -1);
      case 'sc+': return scaleBy(1.25);
      case 'sc-': return scaleBy(0.8);
      case 'dup': return duplicate();
      case 'del': return removeSel();
      case 'snap': S.snap = !S.snap; renderPanel(); return toast('四隅スナップ：' + (S.snap ? 'ON' : 'OFF'));
      case 'save': return commit();
      case 'cancel': return cancel();
    }
  }
  function onKey(ev) {
    if (!S.on || !S.sel || settingsOpen()) return;
    const t = document.activeElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    const map = { ArrowLeft: 'mx-', ArrowRight: 'mx+', ArrowUp: 'mz-', ArrowDown: 'mz+', PageUp: 'my+', PageDown: 'my-' };
    const a = map[ev.code];
    if (!a) return;
    ev.preventDefault();
    act(a);
  }

  // ============================================================
  // 画面（操作パネル・切り替えボタン・設定・通知）
  // ============================================================
  const BTN = 'padding:6px 9px;margin:2px;border-radius:8px;border:1px solid #5a6c86;background:#26344a;color:#fff;font-size:13px;cursor:pointer;touch-action:manipulation';
  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'edtPanel';
    panel.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:8px;z-index:40;background:rgba(20,28,40,.92);color:#fff;border-radius:12px;padding:8px 10px;max-width:96vw;display:none;text-align:center;box-sizing:border-box';
    panel.innerHTML = `
      <div id="edtInfo" style="margin-bottom:4px"></div>
      <div>
        <button data-e="mx-" style="${BTN}">◀ 左</button><button data-e="mx+" style="${BTN}">右 ▶</button>
        <button data-e="mz-" style="${BTN}">▲ 奥</button><button data-e="mz+" style="${BTN}">手前 ▼</button>
        <button data-e="my+" style="${BTN}">上</button><button data-e="my-" style="${BTN}">下</button>
      </div>
      <div>
        <button data-e="ty-" style="${BTN}">Y ↺</button><button data-e="ty+" style="${BTN}">Y ↻</button>
        <button data-e="tx-" style="${BTN}">X ↺</button><button data-e="tx+" style="${BTN}">X ↻</button>
        <button data-e="tz-" style="${BTN}">Z ↺</button><button data-e="tz+" style="${BTN}">Z ↻</button>
        <select id="edtRot" style="${BTN};padding:5px">
          <option value="15">15°</option><option value="45">45°</option><option value="90">90°</option>
        </select>
      </div>
      <div>
        <button data-e="sc+" style="${BTN}">拡大</button><button data-e="sc-" style="${BTN}">縮小</button>
        <button data-e="dup" style="${BTN}">複製</button><button data-e="del" style="${BTN}">削除</button>
        <button data-e="snap" id="edtSnap" style="${BTN}">スナップ</button>
      </div>
      <div>
        <button data-e="save" style="${BTN};background:#2e7d4f">エディット作業を保存</button>
        <button data-e="cancel" style="${BTN};background:#7a3434">取り消し</button>
      </div>`;
    document.body.appendChild(panel);
    panel.addEventListener('click', e => {
      const b = e.target.closest('[data-e]');
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      act(b.dataset.e);
    });
    document.getElementById('edtRot').addEventListener('change', e => { S.rotStep = Number(e.target.value) || 15; });
  }
  function renderPanel() {
    if (!panel) return;
    const info = document.getElementById('edtInfo');
    info.textContent = (S.sel ? '選択中：' + selName() + (S.sel.ent ? '（' + (S.sel.ent.s || 1).toFixed(2) + '倍）' : '') : '選択なし（タップで選ぶ）')
      + '　未保存の変更：' + (isDirty() ? 'あり' : 'なし');
    const sn = document.getElementById('edtSnap');
    if (sn) sn.textContent = 'スナップ：' + (S.snap ? 'ON' : 'OFF');
    if (qBtn) qBtn.textContent = 'エディット：' + (S.on ? 'ON' : 'OFF');
  }
  function buildToast() {
    toastEl = document.createElement('div');
    toastEl.style.cssText = 'position:fixed;left:50%;top:14%;transform:translateX(-50%);z-index:45;background:rgba(0,0,0,.78);color:#fff;padding:8px 14px;border-radius:10px;font-size:13px;pointer-events:none;display:none;max-width:90vw;text-align:center';
    document.body.appendChild(toastEl);
  }
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.style.display = '';
    clearTimeout(toastT);
    toastT = setTimeout(() => { toastEl.style.display = 'none'; }, 2200);
  }
  // 画面上の切り替えボタン（設定でONにしたときだけ表示。0.5マス・傾きのクイックバーと同じ考え方）
  function btnOn() { try { return localStorage.getItem(BTN_KEY) === '1'; } catch (e) { return false; } }
  function setBtnOn(v) {
    try { localStorage.setItem(BTN_KEY, v ? '1' : '0'); } catch (e) {}
    const el = document.getElementById('edtQuick');
    if (el) el.style.display = v ? 'block' : 'none';
  }
  function buildQuickButton() {
    const wrap = document.createElement('div');
    wrap.id = 'edtQuick';
    wrap.style.cssText = 'position:fixed;left:8px;top:146px;z-index:6;display:none;background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.35);border-radius:8px;padding:4px;touch-action:manipulation';
    wrap.innerHTML = `<button id="edtQBtn" style="${BTN};margin:0">エディット：OFF</button>`;
    document.body.appendChild(wrap);
    qBtn = document.getElementById('edtQBtn');
    qBtn.addEventListener('pointerdown', e => e.stopPropagation());
    qBtn.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
    qBtn.addEventListener('click', e => { e.stopPropagation(); setOn(!S.on); });
    setBtnOn(btnOn());
  }
  function buildSetting() {
    const close = document.getElementById('settingsClose');
    if (!close || document.getElementById('edtSec')) return;
    const sec = document.createElement('div');
    sec.id = 'edtSec';
    sec.style.cssText = 'margin:10px 0;padding:8px;border:1px solid #3a4a60;border-radius:8px';
    sec.innerHTML = `
      <div style="font-weight:bold;margin-bottom:6px">本格エディットモード</div>
      <label style="display:flex;gap:8px;align-items:center;margin:4px 0">
        <input type="checkbox" id="edtOn">
        <span><b>エディットモードを使う</b><br><span style="font-size:11px;opacity:.75">傾き・カスタムブロックと、標準ブロックを選んで、移動・拡大・回転・複製・削除ができます。傾きブロックの編集は「エディット作業を保存」を押すまで反映されません。</span></span>
      </label>
      <label style="display:flex;gap:8px;align-items:center;margin:4px 0">
        <input type="checkbox" id="edtBtnOn">
        <span><b>画面上に切り替えボタンを表示</b><br><span style="font-size:11px;opacity:.75">画面左上に「エディット」ボタンを出します（格子・傾きの表示と同じ考え方）。</span></span>
      </label>`;
    close.parentNode.insertBefore(sec, close);
    document.getElementById('edtOn').addEventListener('change', e => setOn(e.target.checked));
    const b = document.getElementById('edtBtnOn');
    b.checked = btnOn();
    b.addEventListener('change', () => setBtnOn(b.checked));
  }

  // エディットモードの切り替え。未保存の変更があれば、保存するかを聞く（そうでなければ取り消す）
  function setOn(v) {
    if (v === S.on) return;
    if (!v) {
      if (isDirty() && confirm('未保存のエディット作業があります。保存しますか？\nOK：保存する　キャンセル：取り消す')) commit();
      else cancel();
    }
    S.on = v;
    const cb = document.getElementById('edtOn');
    if (cb) cb.checked = v;
    select(null);
    renderPanel();
    toast(v ? 'エディットモード：ブロックをタップで選んでください' : 'エディットモードを終了しました');
  }

  tryInstall();
})();
