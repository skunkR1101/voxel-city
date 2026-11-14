/* voxel-craft-cannon.js (v1)  大砲（段階3）
 * ・船メーカーで範囲を選び、大砲（道具）でタップ → その場所に大砲を置けます（「船にする」で船に付きます）
 * ・大砲のそばで H キー（または画面の「大砲を操作」ボタン）→ 照準モード
 *     A/D：左右  W/S：上下  Space またはクリック：発射  H：降りる（画面のボタンでも可）
 * ・砲弾は地形・海・他の船に当たると爆発します。ブロックは壊れません（見た目だけ）
 * ・大砲の見た目は簡単な箱と砲身です（反動つき）。カスタムモデルや可動パーツは次の段階です
 * ・他の人の発射は、同じ弾道で見えます（爆発の表示だけ同期。ブロックには影響しません）
 */
(function () {
  'use strict';
  if (!window.THREE) return;

  const GRAV = 14, SHELL_SPEED = 46, SHELL_LIFE = 7, AIM_RATE = 1.1, FIRE_COOL = 1.2;
  const AY_MAX = 2.6, AP_MIN = -0.05, AP_MAX = 1.2, BARREL_Z = 0.85, MUZZLE = 1.75;

  const S = () => window.VoxelShip;
  const angles = new Map();   // 大砲ごとの向き（キー → {ay, ap}）
  const groups = new Map();   // 画面の大砲（キー → {root, gun, barrel, recoil}）
  const shells = [];          // 飛んでいる砲弾
  const fx = [];              // 爆発・煙などの表示
  const down = {};            // 照準中に押しているキー
  let aim = null;             // {s, idx, key, saved:{pos, view}}
  let lastFire = -10, ui = null;

  // ---------- 純粋な計算（テストしやすいように分けています）----------
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function clampAim(a) { a.ay = clamp(a.ay, -AY_MAX, AY_MAX); a.ap = clamp(a.ap, AP_MIN, AP_MAX); return a; }
  // 大砲の向き（水平の角度 φ, 上向きの角度 ap）→ 弾の向き。水平向きは船の進む向きと同じ式
  function dirOf(phi, ap) {
    return { x: -Math.sin(phi) * Math.cos(ap), y: Math.sin(ap), z: -Math.cos(phi) * Math.cos(ap) };
  }
  // 砲弾を dt 秒進める（重力つき）。戻り値は新しい位置と速度
  function shellStep(p, h) {
    const vy = p.vy - GRAV * h;
    return { x: p.x + p.vx * h, y: p.y + ((p.vy + vy) / 2) * h, z: p.z + p.vz * h, vx: p.vx, vy, vz: p.vz };
  }
  // 砲弾の発射位置（砲身の先）
  function muzzleOf(root, ap, phi) {
    const d = dirOf(phi, ap);
    return { x: root.x + d.x * MUZZLE, y: root.y + 0.6 + d.y * MUZZLE, z: root.z + d.z * MUZZLE, d };
  }

  // ---------- 見た目 ----------
  const gBase = new THREE.BoxGeometry(0.9, 0.5, 0.9);
  const gBarrel = new THREE.CylinderGeometry(0.13, 0.17, 1.7, 10);
  gBarrel.rotateX(Math.PI / 2);                    // 砲身を +Z 向きにする
  const gSph = new THREE.SphereGeometry(1, 10, 8);
  const gRing = new THREE.RingGeometry(0.8, 1, 24);
  gRing.rotateX(-Math.PI / 2);
  const gDeb = new THREE.BoxGeometry(0.18, 0.18, 0.18);
  const matBase = new THREE.MeshLambertMaterial({ color: 0x5a4a3a });
  const matGun = new THREE.MeshLambertMaterial({ color: 0x2c3138 });

  function say(t) { if (!t) return; if (typeof toast === 'function') toast(t); else console.log(t); }
  function angleOf(key) {
    let a = angles.get(key);
    if (!a) { a = { ay: 0, ap: 0.35 }; angles.set(key, a); }
    return a;
  }
  function buildGroup() {
    const root = new THREE.Group();
    const base = new THREE.Mesh(gBase, matBase); base.position.y = 0.25; root.add(base);
    const gun = new THREE.Group(); gun.position.y = 0.6; root.add(gun);
    const barrel = new THREE.Mesh(gBarrel, matGun); barrel.position.z = BARREL_Z; gun.add(barrel);
    return { root, gun, barrel, recoil: 0 };
  }
  function disposeMat(m) { if (m && m.dispose) m.dispose(); }

  // 船に付いている大砲の見た目を、船の動きに合わせる
  function syncGroups(dt) {
    const live = new Set();
    for (const s of S().ships()) {
      (s.cannons || []).forEach((c, idx) => {
        const key = s.rec.id + ':' + idx;
        live.add(key);
        let g = groups.get(key);
        if (!g) { g = buildGroup(); scene.add(g.root); groups.set(key, g); }
        const w = S()._pure.seatWorld(s, c);
        const a = angleOf(key);
        g.root.position.set(w.x, w.y, w.z);
        g.root.rotation.order = 'YXZ';
        g.root.rotation.y = S().fwdAngle(s) + a.ay + Math.PI;
        g.gun.rotation.x = -a.ap;
        g.recoil = Math.max(0, g.recoil - dt * 3);
        g.barrel.position.z = BARREL_Z - g.recoil;
      });
    }
    for (const [k, g] of groups) {
      if (live.has(k)) continue;
      scene.remove(g.root);
      groups.delete(k);
    }
  }

  // ---------- 砲弾・爆発 ----------
  function smoke(x, y, z) {
    const m = new THREE.Mesh(gSph, new THREE.MeshBasicMaterial({ color: 0xb8b8b8, transparent: true, opacity: 0.6 }));
    m.position.set(x, y, z); scene.add(m);
    fx.push({ obj: m, life: 0.9, t: 0, update: k => { m.scale.setScalar(0.4 + 1.6 * k); m.material.opacity = 0.6 * (1 - k); } });
  }
  function explode(x, y, z, kind) {
    const water = kind === 'water';
    const ball = new THREE.Mesh(gSph, new THREE.MeshBasicMaterial({ color: water ? 0xcfeaff : 0xffa030, transparent: true, opacity: 0.9 }));
    ball.position.set(x, y, z); scene.add(ball);
    fx.push({ obj: ball, life: 0.5, t: 0, update: k => { ball.scale.setScalar(0.6 + 3 * k); ball.material.opacity = 0.9 * (1 - k); } });
    const ring = new THREE.Mesh(gRing, new THREE.MeshBasicMaterial({ color: water ? 0xffffff : 0xffd080, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
    ring.position.set(x, water ? SEA_Y() + 0.1 : y, z); scene.add(ring);
    fx.push({ obj: ring, life: 0.8, t: 0, update: k => { ring.scale.setScalar(1 + 6 * k); ring.material.opacity = 0.8 * (1 - k); } });
    const n = water ? 12 : 16;
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(gDeb, new THREE.MeshLambertMaterial({ color: water ? 0xdff4ff : (Math.random() < 0.5 ? 0x555555 : 0x8a6a40) }));
      m.position.set(x, y, z); scene.add(m);
      const a = Math.random() * Math.PI * 2, sp = 4 + Math.random() * 7, up = 3 + Math.random() * 6;
      const v = { x: Math.cos(a) * sp, y: up, z: Math.sin(a) * sp };
      fx.push({ obj: m, life: 1.1, t: 0, mat: m.material, update: (k, dt) => {
        v.y -= 14 * dt; m.position.x += v.x * dt; m.position.y += v.y * dt; m.position.z += v.z * dt;
      } });
    }
    if (!water) smoke(x, y + 0.3, z);
  }
  function SEA_Y() { return typeof SEA === 'number' ? SEA : 62; }

  function shellHit(p) {
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    const t = getBlock(bx, by, bz);
    if (t === WATER) return 'water';
    if (isSolid(t)) return 'block';
    for (const s of S().ships()) {
      if (s.rec.id !== p.owner && S()._pure.shipSolidAt(s, bx, by, bz)) return 'ship';
    }
    return null;
  }
  function shellsTick(dt) {
    for (let i = shells.length - 1; i >= 0; i--) {
      const p = shells[i];
      p.life += dt;
      let hit = null, left = dt;
      while (left > 1e-9 && !hit) {
        const h = Math.min(0.02, left); left -= h;
        const q = shellStep(p, h);
        Object.assign(p, q);
        hit = shellHit(p);
      }
      if (hit) { explode(p.x, p.y, p.z, hit); shells.splice(i, 1); continue; }
      if (p.life > SHELL_LIFE || p.y < SEA_Y() - 30) shells.splice(i, 1);
    }
  }
  function fxTick(dt) {
    for (let i = fx.length - 1; i >= 0; i--) {
      const e = fx[i];
      e.t += dt;
      const k = Math.min(1, e.t / e.life);
      e.update(k, dt);
      if (e.t >= e.life) {
        scene.remove(e.obj);
        if (e.mat) disposeMat(e.mat);
        else if (e.obj.material) disposeMat(e.obj.material);
        fx.splice(i, 1);
      }
    }
  }

  // ---------- 発射 ----------
  function launch(p) { shells.push({ x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, owner: p.owner, life: 0 }); }
  function fireAim() {
    if (!aim) return;
    const now = performance.now() / 1000;
    if (now - lastFire < FIRE_COOL) return;
    lastFire = now;
    const s = aim.s;
    const a = angleOf(aim.key);
    const g = groups.get(aim.key);
    if (g) g.recoil = 0.45;
    const phi = S().fwdAngle(s) + a.ay;
    const root = g ? g.root.position : { x: 0, y: 0, z: 0 };
    const m = muzzleOf({ x: root.x, y: root.y, z: root.z }, a.ap, phi);
    const v = { x: m.d.x * SHELL_SPEED, y: m.d.y * SHELL_SPEED, z: m.d.z * SHELL_SPEED };
    const shot = { x: m.x, y: m.y, z: m.z, vx: v.x, vy: v.y, vz: v.z, owner: s.rec.id };
    launch(shot);
    smoke(m.x, m.y, m.z);
    if (window.VoxelLive && VoxelLive.send) {
      try { VoxelLive.send('cshot:' + s.rec.id + ':' + Date.now(), { x: m.x, y: m.y, z: m.z, vx: v.x, vy: v.y, vz: v.z, o: s.rec.id }, false, true); } catch (e) { /* 送れなくても、自分の画面では撃てます */ }
    }
  }

  // ---------- 照準 ----------
  function nearestCannon() {
    if (!S() || !S()._pure) return null;
    let best = null, bd = Infinity;
    for (const s of S().ships()) (s.cannons || []).forEach((c, idx) => {
      const w = S()._pure.seatWorld(s, c);
      const d = Math.hypot(w.x - player.pos.x, w.z - player.pos.z);
      if (d < 4.5 && Math.abs(w.y - player.pos.y) < 3 && d < bd) { bd = d; best = { s, idx, key: s.rec.id + ':' + idx }; }
    });
    return best;
  }
  function startAim(n) {
    if (aim) return;
    if (S().isBusy && S().isBusy()) { say('船に乗っている間は大砲を操作できません'); return; }
    aim = { s: n.s, idx: n.idx, key: n.key, saved: { pos: player.pos.clone(), view: viewMode } };
    player.vel.set(0, 0, 0);
    viewMode = 0;
    if (ui) ui.box.style.display = 'flex';
    say('A/D：左右　W/S：上下　Space・クリック：発射　H：降りる');
  }
  function stopAim() {
    if (!aim) return;
    player.pos.copy(aim.saved.pos);
    player.vel.set(0, 0, 0);
    viewMode = aim.saved.view;
    aim = null;
    for (const k of Object.keys(down)) down[k] = false;
    if (ui) ui.box.style.display = 'none';
  }
  function aimTick(dt) {
    const s = aim.s;
    const c = s.cannons && s.cannons[aim.idx];
    if (!c || !S().ships().includes(s)) { stopAim(); say('大砲が見つからないため、照準を終えました'); return; }
    const w = S()._pure.seatWorld(s, c);
    player.pos.set(w.x, w.y, w.z);
    const a = angleOf(aim.key);
    if (down.KeyA || down.ArrowLeft) a.ay += AIM_RATE * dt;
    if (down.KeyD || down.ArrowRight) a.ay -= AIM_RATE * dt;
    if (down.KeyW || down.ArrowUp) a.ap += AIM_RATE * dt;
    if (down.KeyS || down.ArrowDown) a.ap -= AIM_RATE * dt;
    clampAim(a);
    player.yaw = S().fwdAngle(s) + a.ay;
    player.pitch = a.ap;
  }

  // 照準中は歩いたり乗ったりしない（凍結）。それ以外は元の処理
  const prevUpdatePhysics = window.updatePhysics;
  if (typeof prevUpdatePhysics === 'function') {
    window.updatePhysics = function (dt, inp) {
      if (aim) return;
      return prevUpdatePhysics.apply(this, arguments);
    };
  }
  // マウスの左クリック（壊す操作）は、照準中は発射にする（ブロックは壊れません）
  const prevDoBreak = window.doBreak;
  if (typeof prevDoBreak === 'function') {
    window.doBreak = function () {
      if (aim) { fireAim(); return; }
      return prevDoBreak.apply(this, arguments);
    };
  }

  // ---------- キー・画面のボタン ----------
  window.addEventListener('keydown', e => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (typeof menuOpen !== 'undefined' && menuOpen) return;
    if (aim) {
      if (['KeyA', 'KeyD', 'KeyW', 'KeyS', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) {
        down[e.code] = true;
        e.preventDefault();
      }
      if (e.code === 'Space' && !e.repeat) fireAim();
      if (e.code === 'KeyH' && !e.repeat) stopAim();
      return;
    }
    if (e.code === 'KeyH' && !e.repeat) {
      const n = nearestCannon();
      if (n) startAim(n);
    }
  }, true);
  window.addEventListener('keyup', e => { if (e.code in down) down[e.code] = false; });
  window.addEventListener('blur', () => { for (const k of Object.keys(down)) down[k] = false; });

  function buildUI() {
    const box = document.createElement('div');
    box.id = 'cannonUI';
    box.style.cssText = 'position:fixed;left:50%;bottom:150px;transform:translateX(-50%);display:none;gap:6px;z-index:60;touch-action:none;user-select:none';
    const btn = (label, code, extra) => `<button data-c="${code}" style="min-width:48px;min-height:44px;padding:6px 10px;border-radius:10px;border:0;background:rgba(20,30,40,.75);color:#fff;font-size:16px;${extra || ''}">${label}</button>`;
    box.innerHTML = btn('◀', 'KeyA') + btn('▼', 'KeyS') + btn('▲', 'KeyW') + btn('▶', 'KeyD')
      + btn('発射', 'Fire', 'background:#b3412e') + btn('降りる', 'Exit', 'background:#3a4a5a');
    document.body.appendChild(box);
    box.addEventListener('pointerdown', e => {
      const b = e.target.closest('button'); if (!b) return;
      e.preventDefault();
      const c = b.dataset.c;
      if (c === 'Fire') fireAim();
      else if (c === 'Exit') stopAim();
      else down[c] = true;
    });
    const release = () => { for (const k of ['KeyA', 'KeyD', 'KeyW', 'KeyS']) down[k] = false; };
    box.addEventListener('pointerup', release);
    box.addEventListener('pointercancel', release);

    const open = document.createElement('button');
    open.id = 'cannonBtn';
    open.textContent = '大砲を操作（H）';
    open.style.cssText = 'position:fixed;left:50%;bottom:210px;transform:translateX(-50%);display:none;padding:10px 16px;border-radius:12px;border:0;background:#b3412e;color:#fff;font-size:15px;z-index:60';
    open.addEventListener('click', () => { const n = nearestCannon(); if (n) startAim(n); });
    document.body.appendChild(open);
    ui = { box, open };
  }

  // ---------- 毎フレーム ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000)); last = now;
    try {
      if (window.VoxelShip && S()._pure && window.scene) {
        if (aim) aimTick(dt);
        syncGroups(dt);
        shellsTick(dt);
        fxTick(dt);
        if (ui) {
          const near = !aim && !!nearestCannon();
          ui.open.style.display = near ? 'block' : 'none';
        }
      }
    } catch (err) { console.warn('cannon', err); }
    requestAnimationFrame(frame);
  }

  // ---------- 他の人の発射（見た目だけ同期）----------
  function onRemoteShot(rec) {
    const v = rec && rec.v;
    if (!v || typeof v.x !== 'number') return;
    shells.push({ x: v.x, y: v.y, z: v.z, vx: v.vx, vy: v.vy, vz: v.vz, owner: v.o, life: 0 });
    smoke(v.x, v.y, v.z);
  }
  function registerShotHandler() {
    if (window.VoxelLive && VoxelLive.onOp) VoxelLive.onOp('cshot', onRemoteShot);
    else setTimeout(registerShotHandler, 500);
  }

  function init() {
    if (!document.body) { setTimeout(init, 50); return; }
    buildUI();
    registerShotHandler();
    requestAnimationFrame(frame);
  }
  init();

  window.VoxelCannon = {
    isAiming: () => !!aim,
    stop: stopAim,
    count: () => { let n = 0; for (const s of (S() && S().ships ? S().ships() : [])) n += (s.cannons || []).length; return n; },
    _pure: { dirOf, shellStep, muzzleOf, clampAim, AY_MAX, AP_MIN, AP_MAX, GRAV, SHELL_SPEED }
  };
})();
