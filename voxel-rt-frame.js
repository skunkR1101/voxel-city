/* voxel-rt-frame.js  列車・車・人混みのフレーム同期（ホストなしで動く）
 *  ・部屋の中で一番小さい席番号の人（持ち主）が、列車・車・人混みを計算し、100msごとに位置を送る
 *  ・ほかの人は計算せず、受け取った位置をそのまま表示する（画面の更新は要らない）
 *  ・持ち主が部屋を出たら、残っている人で一番小さい席番号の人が持ち主になる（そこから計算を続ける）
 *  ・1人だけのときは、今までどおり自分で計算する（mode は 'local'）
 *  読み込み順：voxel-rt-ui.js と voxel-rt-state.js の後、各機能（列車・車・人混み）の前
 */
(function () {
'use strict';

const SEND_MS = 100;                       // 位置を送る間隔（ms）
const STALE_MS = 3000;                     // これより古い位置は、持ち主がいないものとして扱う

let rm = null;
const lastSent = new Map();                // kind -> 最後に送った時刻
const latest = new Map();                  // kind -> { slot, at, d }

function slotOf(pid) {
  const n = Number(String(pid || '').split('-').pop());
  return Number.isInteger(n) ? n : null;
}

// いま部屋にいる人のうち、一番小さい席番号（持ち主）
function ownerSlot() {
  if (!rm) return null;
  let best = rm.slot;
  for (const L of rm.links.values()) {
    if (!L.ok) continue;
    const s = slotOf(L.pid);
    if (s !== null && s < best) best = s;
  }
  return best;
}

// 'local'：部屋にいない・1人だけ（自分で計算する）
// 'owner'：持ち主（計算して送る）
// 'remote'：ほかの人が持ち主（送られてきた位置を表示する）
function mode(kind) {
  if (!rm || rm.linkCount() === 0) return 'local';
  return ownerSlot() === rm.slot ? 'owner' : 'remote';
}

// 持ち主のとき、計算した状態を送る（送る間隔はこの中で決める）
function publish(kind, makeState) {
  if (mode(kind) !== 'owner' || !rm) return;
  const now = Date.now();
  if (now - (lastSent.get(kind) || 0) < SEND_MS) return;
  lastSent.set(kind, now);
  try { rm.ephemeral('frm:' + kind, { slot: rm.slot, at: now, d: makeState() }); } catch (e) { console.error(e); }
}

// 持ち主から受け取った、いちばん新しい状態（無ければ null）
function remote(kind) {
  const r = latest.get(kind);
  if (!r || Date.now() - r.at > STALE_MS) return null;
  return r.d;
}

// 受け取り：持ち主の席番号と同じものだけ使う（古い持ち主からの送信は捨てる）
function onFrame(key, value) {
  const kind = String(key).split(':')[1];
  if (!kind || !value || typeof value !== 'object') return;
  if (value.slot !== ownerSlot()) return;
  latest.set(kind, { slot: value.slot, at: Date.now(), d: value.d });
}

function attach(room) {
  rm = room || null;
  lastSent.clear();
  latest.clear();
  if (!rm) return;
  rm.on('frm', onFrame);
}

if (window.VoxelRTUI && window.VoxelRTUI.onRoom) window.VoxelRTUI.onRoom(attach);
window.VoxelFrame = { mode, publish, remote, ownerSlot };
})();
