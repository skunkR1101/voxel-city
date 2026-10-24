/* voxel-craft-custom.js (v1)  カスタムブロックの修正と、マルチプレイでの共有
 *  ・面の描画の修正：ブロックの周りが透けて見える（X線）問題の原因（emitCubeFace が無かった）を直す
 *  ・共有：カスタムブロックの中身（テクスチャ・モデル）を部屋の中で送り、相手の端末にも同じブロックを作る
 * 読み込み順： … ext → … → save → net → multi → custom → players → ui
 */
(function () {
'use strict';
// ext.js の内部の名前を、window.VoxelExt から受け取る（ext.js は外から見えないため）
const { CUSTOM_BASE, ext, blockState, keyOf, nextId, saveExt, renderInventory, registerDef } = window.VoxelExt;

const CHUNK = 16000;               // 定義を分けて送る1かけらの文字数（1通の上限に収まる大きさ）
const AIR_ = 0;

// ============================================================
// 1. 面の描画（X線の修正）
// ============================================================
window.emitCubeFace = function (buf, x, y, z, f, ao, tint) {
  const nd = FACES[f];
  const v0 = buf.p.length / 3;
  const uvs = [0, 0, 1, 0, 1, 1, 0, 1];
  const t = tint || [1, 1, 1];
  for (let i = 0; i < 4; i++) {
    const c = nd.corners[i];
    buf.p.push(x + c[0], y + c[1], z + c[2]);
    buf.n.push(nd.n[0], nd.n[1], nd.n[2]);
    buf.uv.push(uvs[i * 2], uvs[i * 2 + 1]);
    buf.c.push(ao[i] * t[0], ao[i] * t[1], ao[i] * t[2]);
  }
  if (ao[0] + ao[2] > ao[1] + ao[3]) buf.i.push(v0, v0 + 1, v0 + 3, v0 + 1, v0 + 2, v0 + 3);
  else buf.i.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
};

// ============================================================
// 2. 定義のしるし（ハッシュ）：同じ中身のブロックは、どの端末でも同じしるしになる
// ============================================================
function fnv(s, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
function hashStr(s) { return fnv(s, 0x811c9dc5) + fnv(s, 0x12345679); }

function payloadOf(def) {
  return JSON.stringify({
    name: def.name, kind: def.kind, colorable: !!def.colorable,
    texData: def.texData || null,
    model: def.model || null,
    orient: def.orient ?? null,
    scale: def.scale ?? null,
    alpha: def.alpha || 'cut'
  });
}
const hashCache = new WeakMap();   // 定義の物（オブジェクト）ごとに一度だけ計算
function defHash(def) {
  let h = hashCache.get(def);
  if (!h) { h = hashStr(payloadOf(def)); hashCache.set(def, h); }
  return h;
}
function defByHash(H) { return ext.defs.find(d => defHash(d) === H) || null; }

// ============================================================
// 3. 送る側：定義（中身）を部屋へ送り、ブロックには「しるし＋状態」だけを載せる
// ============================================================
const published = new Set();
let publishedRoom = null;
function publishDef(def) {
  const H = defHash(def);
  const room = VoxelMulti.roomId();
  if (room !== publishedRoom) { published.clear(); publishedRoom = room; }
  if (published.has(H)) return H;
  const s = payloadOf(def);
  const n = Math.max(1, Math.ceil(s.length / CHUNK));
  VoxelMulti.send('cdm:' + H, { n: n });
  for (let i = 0; i < n; i++) VoxelMulti.send('cdef:' + H + ':' + i, { d: s.slice(i * CHUNK, (i + 1) * CHUNK) });
  published.add(H);
  return H;
}
function stateOf(x, y, z) {
  const st = blockState.get(keyOf(x, y, z));
  return st ? { color: st.color ?? null, rot: st.rot ?? 0, qb: st.qb ?? null } : null;
}
function setState(x, y, z, s) {
  if (s) blockState.set(keyOf(x, y, z), { color: s.color ?? null, rot: s.rot ?? 0, qb: s.qb ?? null });
  else blockState.delete(keyOf(x, y, z));
}

VoxelMulti.setStateGetter(stateOf);
VoxelMulti.setBlockEncoder((x, y, z, t) => {
  if (t < CUSTOM_BASE) return t;
  const def = ext.defs.find(d => d.id === t);
  if (!def) return AIR_;
  return { h: publishDef(def), s: stateOf(x, y, z) };
});

// ============================================================
// 4. 受け取る側：定義が届いたら、この端末でも同じブロックとして登録する
// ============================================================
const incoming = new Map();        // しるし -> { n, parts[] }
const waiting = new Map();         // しるし -> [{x,y,z,s}]  定義がまだ届いていない置き場所
const adopting = new Set();
const adoptListeners = [];         // 定義が届いたときに呼ぶ関数（置き場所の再確認など）

function getIn(H) {
  let o = incoming.get(H);
  if (!o) { o = { n: 0, parts: [] }; incoming.set(H, o); }
  return o;
}

VoxelMulti.onOp('cdm', rec => {
  if (rec.del || typeof rec.key !== 'string') return;
  const H = rec.key.slice(4);
  getIn(H).n = Math.max(0, Number(rec.v && rec.v.n) || 0);
  tryAdopt(H);
});
VoxelMulti.onOp('cdef', rec => {
  const m = /^cdef:([^:]+):(\d+)$/.exec(rec.key || '');
  if (!m || !rec.v || typeof rec.v.d !== 'string') return;
  getIn(m[1]).parts[Number(m[2])] = rec.v.d;
  tryAdopt(m[1]);
});

async function tryAdopt(H) {
  const o = incoming.get(H);
  if (!o || !o.n || adopting.has(H)) return;
  for (let i = 0; i < o.n; i++) if (typeof o.parts[i] !== 'string') return;   // まだ全部届いていない
  adopting.add(H);
  try {
    const s = o.parts.slice(0, o.n).join('');
    if (hashStr(s) !== H) { console.error('カスタムブロックの確認に失敗しました'); return; }
    const id = await adoptDef(H, JSON.parse(s));
    if (id < 0) return;
    const cells = waiting.get(H) || [];
    waiting.delete(H);
    for (const c of cells) {
      setState(c.x, c.y, c.z, c.s);
      VoxelMulti.applyBlock(c.x, c.y, c.z, id);
    }
    incoming.delete(H);
    for (const f of adoptListeners) { try { f(H); } catch (e) { console.error(e); } }
  } catch (e) {
    console.error(e);
  } finally {
    adopting.delete(H);
  }
}

async function adoptDef(H, p) {
  const have = defByHash(H);
  if (have) return have.id;
  const id = nextId();
  if (id < 0) { if (window.VoxelWorld) VoxelWorld.toast('カスタムブロックの上限に達したため、受け取れませんでした'); return -1; }
  const def = {
    id, name: String(p.name || 'カスタムブロック'), kind: p.kind === 'model' ? 'model' : 'cube',
    category: (ext.categories && ext.categories[0]) || '未分類', colorable: !!p.colorable,
    texData: p.texData || null, model: p.model || null,
    orient: p.orient ?? undefined, scale: p.scale ?? undefined, alpha: p.alpha || 'cut',
    sounds: { break: { type: 'none' }, place: { type: 'none' } }
  };
  ext.defs.push(def);
  hashCache.set(def, H);             // 送る側と同じしるしを、そのまま使う
  saveExt();
  await registerDef(def);
  if (window.VoxelFx) VoxelFx.apply(def);
  if (typeof renderInventory === 'function') renderInventory();
  if (window.VoxelWorld) VoxelWorld.toast('「' + def.name + '」を受け取りました');
  return id;
}

// 届いたブロックの変更を、ワールドへ反映する（まだ定義がなければ、届くまで待つ）
VoxelMulti.setBlockResolver((x, y, z, rec) => {
  if (rec.del) { blockState.delete(keyOf(x, y, z)); return AIR_; }
  const v = rec.v;
  if (typeof v === 'number') return v;
  if (v && typeof v.h === 'string') {
    const def = defByHash(v.h);
    if (def) { setState(x, y, z, v.s); return def.id; }
    const list = waiting.get(v.h) || [];
    list.push({ x, y, z, s: v.s || null });
    waiting.set(v.h, list);
    return null;
  }
  return null;
});

window.VoxelCustom = {
  defHash, publishDef,
  invalidate: def => hashCache.delete(def),                 // 中身を変えたあとに呼ぶ
  localIdFor: H => { const d = defByHash(H); return d ? d.id : null; },
  onAdopt: fn => adoptListeners.push(fn)
};
})();
