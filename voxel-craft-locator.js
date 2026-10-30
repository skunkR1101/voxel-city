/* voxel-craft-locator.js  ロケーターバー（マイクラ風）
 *  ・アイテムスロット（ホットバー）の上に細いバーを出し、ほかのプレイヤーの方向と距離を示す
 *  ・バーの中央は、今見ている方向。左右の端は、見ている方向から90°ずれた位置
 *  ・各プレイヤーの色は、名前（ID）から決まる色（毎回同じ・人ごとに違う）
 *  ・設定パネルでオン／オフ（この端末だけの設定）
 *  ・読み込み順：players.js の後（VoxelPlayers.list を使う）
 */
(function () {
'use strict';
const KEY = 'voxelcraft_locator_v1';
const HALF_SPAN = Math.PI / 2;       // バーの端までの角度（中央から左右それぞれ）
const MAX_MARKS = 12;
const UPDATE_MS = 100;               // 表示の更新間隔（毎フレーム動かさず、軽くする）

let on = true;
try { if (localStorage.getItem(KEY) === '0') on = false; } catch (e) {}

// 名前から色を決める（同じ人は同じ色・人ごとに違う色）
function colorOf(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 'hsl(' + ((h >>> 0) % 360) + ', 85%, 60%)';
}

let bar = null, lastT = 0;
const marks = new Map();             // peer -> 要素
function build() {
  if (bar) return bar;
  const st = document.createElement('style');
  st.textContent =
    '#locBar{position:fixed;height:10px;background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.4);' +
    'border-radius:5px;z-index:40;pointer-events:none;display:none;box-sizing:border-box;overflow:visible}' +
    '#locBar .lm{position:absolute;top:-2px;bottom:-2px;width:8px;margin-left:-4px;border-radius:4px;' +
    'box-shadow:0 0 0 1px rgba(0,0,0,.5);transition:left .12s linear,opacity .2s}' +
    '#locBar .ln{position:absolute;bottom:14px;left:50%;transform:translateX(-50%);font:11px/1.2 sans-serif;' +
    'color:#fff;text-shadow:0 1px 2px #000,0 0 3px #000;white-space:nowrap}' +
    '#locBar .ln b{font-weight:normal;opacity:.85;margin-left:3px}';
  document.head.appendChild(st);
  bar = document.createElement('div');
  bar.id = 'locBar';
  document.body.appendChild(bar);
  return bar;
}
function hide() { if (bar) bar.style.display = 'none'; }

function update(now) {
  if (!on || typeof player === 'undefined' || !window.VoxelPlayers || !VoxelPlayers.list) return hide();
  if (now - lastT < UPDATE_MS) return;
  lastT = now;
  const list = VoxelPlayers.list().slice(0, MAX_MARKS);
  const hb = document.getElementById('hotbar');
  const hr = hb && hb.getBoundingClientRect();
  if (!list.length || !hr || hr.height === 0) return hide();   // 誰もいない・ホットバーが見えていないときは出さない

  const b = build();
  b.style.display = 'block';
  b.style.left = hr.left + 'px';
  b.style.width = hr.width + 'px';
  b.style.top = Math.max(4, hr.top - 22) + 'px';

  // 今見ている向き（前・右のベクトル）
  const yaw = player.yaw;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  const seen = new Set();
  for (const p of list) {
    seen.add(p.peer);
    let m = marks.get(p.peer);
    if (!m) {
      m = document.createElement('div');
      m.className = 'lm';
      m.style.background = colorOf(p.peer);
      const label = document.createElement('div');
      label.className = 'ln';
      m.appendChild(label);
      b.appendChild(m);
      marks.set(p.peer, m);
    }
    const dx = p.x - player.pos.x, dz = p.z - player.pos.z;
    const dist = Math.hypot(dx, dz);
    const ang = Math.atan2(rx * dx + rz * dz, fx * dx + fz * dz);   // 右がプラス・前が0
    const r = Math.max(-1, Math.min(1, ang / HALF_SPAN));
    m.style.left = ((0.5 + r * 0.5) * 100).toFixed(2) + '%';
    m.style.opacity = Math.abs(ang) > HALF_SPAN ? '0.5' : '1';
    m.firstChild.innerHTML = '';
    m.firstChild.textContent = p.name || 'プレイヤー';
    const d = document.createElement('b');
    d.textContent = Math.round(dist) + 'm';
    m.firstChild.appendChild(d);
  }
  for (const [peer, m] of [...marks]) {
    if (!seen.has(peer)) { m.remove(); marks.delete(peer); }
  }
}
function loop(now) {
  try { update(now); } catch (e) { console.error(e); }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// 設定パネルのスイッチ
function addSection() {
  const sbox = document.querySelector('#settings .sbox');
  const closeBtn = document.getElementById('settingsClose');
  if (!sbox || !closeBtn || document.getElementById('locToggle')) return;
  const sec = document.createElement('div');
  sec.innerHTML =
    '<h3>ロケーターバー</h3>' +
    '<label class="chk"><input type="checkbox" id="locToggle"> ほかの人の方向と距離を、アイテムの上に表示</label>' +
    '<p class="note">オフにすると、バーを出しません（この端末だけの設定です）。</p>';
  sbox.insertBefore(sec, closeBtn);
  const cb = document.getElementById('locToggle');
  cb.checked = on;
  cb.addEventListener('change', () => {
    on = cb.checked;
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) {}
    if (!on) hide();
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addSection);
else addSection();

window.VoxelLocator = {
  get: () => on,
  set: v => { on = !!v; try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) {} if (!on) hide(); }
};
})();
