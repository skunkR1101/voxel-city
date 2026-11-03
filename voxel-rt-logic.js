/* voxel-rt-logic.js  マルチ通信の、画面に依存しない部分（自動テストできる）
 *  ・ゲーマータグの整形（すべての文字に対応。制御文字と改行だけ取り除く）
 *  ・招待リンクの作成・読み取り（パスワードは「#」の後ろに入るので、サーバーには送られない）
 *  ・ロケーターバーの位置の計算（見ている向きを中央に、左右は90度まで）
 */
(function (root) {
'use strict';

const NAME_MAX = 16;            // 16文字（文字の数え方は、絵文字などを1文字として数える）
const DEFAULT_NAME = 'プレイヤー';

// 制御文字（改行・タブなど）と、行区切り（U+2028/2029）を取り除く。エスケープで書いて、ファイルに直接の文字を入れない
const STRIP_RE = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g");
function sanitizeName(raw) {
  const s = String(raw == null ? "" : raw).replace(STRIP_RE, "").trim();
  const chars = Array.from(s);                                 // コードポイント単位で数える
  const out = chars.slice(0, NAME_MAX).join("");
  return out || DEFAULT_NAME;
}

function b64urlEnc(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDec(s) {
  const b = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b + '==='.slice((b.length + 3) % 4);
  const bin = atob(pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// 招待リンク：ページのアドレス＋「#vcjoin=」＋部屋ID・パスワード
function makeInvite(base, roomId, password) {
  const payload = b64urlEnc(JSON.stringify({ r: String(roomId), p: String(password) }));
  return base.replace(/#.*$/, '') + '#vcjoin=' + payload;
}
// リンクから部屋ID・パスワードを取り出す（違う形なら null）
function parseInvite(hash) {
  const m = /^#?vcjoin=([A-Za-z0-9_\-]+)$/.exec(String(hash || ''));
  if (!m) return null;
  try {
    const o = JSON.parse(b64urlDec(m[1]));
    if (!o || typeof o.r !== 'string' || typeof o.p !== 'string' || !o.r || !o.p) return null;
    return { roomId: o.r, password: o.p };
  } catch (e) { return null; }
}

// ロケーターバー：見ている向き（yaw）から、相手の方向を 0〜1 の位置にする
//  0.5 が真正面、0 と 1 が左右の端（90度）。真後ろに近いと、薄く表示する（visible=false）
function locatorPos(player, target, yaw) {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);      // 前
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);       // 右
  const dx = target.x - player.x, dz = target.z - player.z;
  const dist = Math.hypot(dx, dz);
  const ang = Math.atan2(rx * dx + rz * dz, fx * dx + fz * dz);   // 右がプラス・前が0
  const r = Math.max(-1, Math.min(1, ang / (Math.PI / 2)));
  return { pos: 0.5 + r * 0.5, behind: Math.abs(ang) > Math.PI / 2, dist };
}

// 名前から色を決める（同じ人は、いつも同じ色）
function colorOf(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 'hsl(' + ((h >>> 0) % 360) + ', 85%, 60%)';
}

// 入退室のお知らせ（黄色で表示する文字）
function joinText(name) { return name + 'が参加しました'; }
function leaveText(name) { return name + 'が退出しました'; }

const api = { NAME_MAX, DEFAULT_NAME, sanitizeName, makeInvite, parseInvite, locatorPos, colorOf, joinText, leaveText, b64urlEnc, b64urlDec };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.VoxelRTLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
