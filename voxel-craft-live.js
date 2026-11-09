/* voxel-craft-live.js  斜め・0.5マス・傾き・音声ブロックの通信を、部屋の通信（voxel-rt）へつなぐ
 *
 *  背景：通常ブロックは voxel-rt（「オンライン（みんなで遊ぶ）」の部屋）で同期されている。
 *        斜め・傾き・音声は、古い通信（voxel-craft-multi.js）の部屋にしか届かず、
 *        その部屋には入っていなかったため、相手に一切届いていなかった。
 *  この File は、斜め・傾き・音声が使う窓口（VoxelLive）を、部屋の通信（voxel-rt）に結びつける。
 *
 *  窓口の形は、古い VoxelMulti と同じ（send / onOp / connected / roomId）。
 *  加えて、保存された記録を読むための kv() と、時刻の nowTs() を持つ。
 *
 *  読み込み順：voxel-rt-ui.js の後、voxel-craft-diag.js と voxel-craft-sound.js の前
 */
(function () {
'use strict';

// この窓口で扱う通信名（接頭語）。ほかの仕組みの接頭語とは重ならない
const PREFIXES = ['dg', 'tl', 'snd', 'sndf', 'sndc', 'sndp'];

const handlers = new Map();      // 接頭語 -> fn(rec)  rec = { key, v, del, ts }
let room = null;                 // 今いる部屋（voxel-rt の Room）。入っていなければ null
let unsub = null;                // 部屋の変更通知の解除

function isOurs(key) { return PREFIXES.includes(String(key).split(':')[0]); }
function dbgCount(kind, prefix) {
  try {
    const st = window.VoxelDebug && VoxelDebug.state;
    if (!st) return;
    st[kind][prefix] = (st[kind][prefix] || 0) + 1;
  } catch (e) {}
}
function dbgLog(t) { try { if (window.VoxelDebug) VoxelDebug.log('通信（斜め・傾き・音声）', t); } catch (e) {} }

// 部屋の変更（相手からのもの・保存からのものを含む）を、受け取り先へ渡す
// voxel-rt の Room.onEvent は fn(name, data) の形で、name が 'change' のとき data = { key, value, meta }
function onRoomEvent(name, data) {
  if (name !== 'change' || !room || !data || !isOurs(data.key)) return;
  const meta = data.meta || {};
  const e = room.kv.get(data.key);
  const ts = !meta.stored ? Date.now() : (e && typeof e.ts === 'number' ? e.ts : Date.now());
  deliver({ key: data.key, v: data.value, del: !!meta.del, ts });
}
function deliver(rec) {
  const p = String(rec.key).split(':')[0];
  dbgCount('recv', p);
  const fn = handlers.get(p);
  if (!fn) { dbgCount('unhandled', p); return; }
  try { fn(rec); } catch (e) { console.error(e); dbgLog('受け取りエラー ' + p + '：' + (e && e.message)); }
}

// 部屋に入った・出たときに呼ばれる（voxel-rt-ui.js の通知）
function attach(rm) {
  if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
  room = rm || null;
  if (room) {
    unsub = room.onEvent(onRoomEvent);
    dbgLog('部屋に入った：' + room.roomId);
  } else {
    dbgLog('部屋から出た');
  }
}

// 送る（古い VoxelMulti.send と同じ形）
//  del = 削除（記録から消す）、eph = 記録に残さず、今いる人にだけ送る
function send(key, value, del, eph) {
  if (!room || !room.active) { try { if (VoxelDebug.state) VoxelDebug.state.dropped++; } catch (e) {} return; }
  const p = String(key).split(':')[0];
  dbgCount('sent', p);
  if (eph) room.ephemeral(key, value);
  else if (del) room.del(key);
  else room.set(key, value);
}

const VoxelLive = {
  // 受け取り先の登録（古い VoxelMulti.onOp と同じ形）
  onOp: (prefix, fn) => { handlers.set(prefix, fn); },
  send,
  connected: () => !!room && !!room.active,
  roomId: () => (room && room.active ? room.roomId : null),
  // 保存された記録（key -> { v, ts, peer, del }）。部屋に入っていなければ null
  kv: () => (room ? room.kv : null),
  nowTs: () => (room ? room.nowTs() : Date.now()),
  status: () => ({
    roomId: room ? room.roomId : null,
    active: !!(room && room.active),
    links: room ? room.linkCount() : 0,
    records: room ? room.kv.size : 0
  })
};
window.VoxelLive = VoxelLive;

// 部屋の通信（voxel-rt）の、部屋に入った・出た通知に登録する
if (window.VoxelRTUI && VoxelRTUI.onRoom) VoxelRTUI.onRoom(attach);
})();
