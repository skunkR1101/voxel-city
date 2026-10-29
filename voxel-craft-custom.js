/* voxel-craft-custom.js (v1)  カスタムブロックの修正と、マルチプレイでの共有
 *  ・面の描画の修正：ブロックの周りが透けて見える（X線）問題の原因（emitCubeFace が無かった）を直す
 *  ・共有：カスタムブロックの中身（テクスチャ・モデル）を部屋の中で送り、相手の端末にも同じブロックを作る
 * 読み込み順： … ext → … → save → net → multi → custom → players → ui
 */
(function () {
'use strict';
// ext.js の内部の名前を、window.VoxelExt から受け取る（ext.js は外から見えないため）
const { CUSTOM_BASE, ext, defRT, blockState, keyOf, nextId, saveExt, renderInventory, registerDef } = window.VoxelExt;

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

// 中身を、いつも同じ形の文字列にする（項目の順番・空の欄・再起動後の形の違いに左右されない）
function canonModel(m) {
  if (!m) return null;
  let images = m.images;
  if (typeof images === 'string') { try { images = JSON.parse(images); } catch (e) { images = null; } }
  let im = null;
  if (images && typeof images === 'object' && Object.keys(images).length) {
    im = {};
    for (const k of Object.keys(images).sort()) im[k] = images[k];
  }
  return { format: m.format ?? null, data: m.data ?? null, mtl: m.mtl ?? null, images: im };
}
function payloadOf(def) {
  const alpha = def.alpha || 'cut';
  return JSON.stringify({
    name: String(def.name || ''), kind: def.kind === 'model' ? 'model' : 'cube', colorable: !!def.colorable,
    texData: typeof def.texData === 'string' ? def.texData : null,
    model: canonModel(def.model),
    orient: def.orient ?? null,
    scale: def.scale ?? null,
    alpha,
    glow: alpha === 'glow' ? (def.glowPower ?? def.glow ?? 1.5) : null,
    mrot: (def.modelRot ?? def.mrot) || 0
  });
}
const hashCache = new WeakMap();   // 定義の物（オブジェクト）ごとに一度だけ計算
function defHash(def) {
  let h = hashCache.get(def);
  if (!h) { h = hashStr(payloadOf(def)); hashCache.set(def, h); }
  return h;
}
function defByHash(H) { return ext.defs.find(d => defHash(d) === H) || null; }

// 中身だけで同じかを判定する鍵（しるしと同じ元の形を使う）
const keyCache = new WeakMap();    // 中身の鍵も、物ごとに一度だけ作る（大きな中身を何度も作り直さない）
function contentKey(o) {
  let k = keyCache.get(o);
  if (k === undefined) { k = payloadOf(o); keyCache.set(o, k); }
  return k;
}
function defByContent(o) {
  const k = contentKey(o);
  return ext.defs.find(d => contentKey(d) === k) || null;
}

// 同じ中身のブロックが複数あれば1つにまとめる（先に作られた方を残す）
// 残した方のIDへ、ワールドの配置・ホットバーも付け替える
function dedupeDefs() {
  const keep = new Map();      // 中身の鍵 -> 残すID
  const remap = new Map();     // 消すID -> 残すID
  for (const d of ext.defs) {
    const k = contentKey(d);
    if (keep.has(k)) remap.set(d.id, keep.get(k));
    else keep.set(k, d.id);
  }
  if (!remap.size) return false;
  for (let i = ext.defs.length - 1; i >= 0; i--) {
    if (remap.has(ext.defs[i].id)) { const gone = ext.defs.splice(i, 1)[0]; if (defRT) defRT.delete(gone.id); }
  }
  if (typeof editsByChunk !== "undefined") {
    for (const ed of editsByChunk.values()) {
      for (const [i, t] of ed) if (remap.has(t)) ed.set(i, remap.get(t));
    }
  }
  if (typeof HOTBAR !== "undefined") for (let i = 0; i < HOTBAR.length; i++) if (remap.has(HOTBAR[i])) HOTBAR[i] = remap.get(HOTBAR[i]);
  saveExt();
  if (window.VoxelWorld && VoxelWorld.getSeed) VoxelWorld.applySeed(VoxelWorld.getSeed(), false);
  if (typeof renderInventory === 'function') renderInventory();
  return true;
}
setInterval(() => { try { dedupeDefs(); } catch (e) { console.error(e); } }, 2000);

// ============================================================
// 3. 送る側：定義（中身）を部屋へ送り、ブロックには「しるし＋状態」だけを載せる
// ============================================================
const published = new Set();
let publishedRoom = null;
// 自分で削除したカスタムブロック：部屋の記録や他の人の持ち物から戻ってこないように覚えておく
const FORGET_KEY = 'voxelcraft_defdel_v1';
const forgotten = new Set((() => { try { return JSON.parse(localStorage.getItem(FORGET_KEY) || '[]'); } catch (e) { return []; } })());
function saveForgotten() { try { localStorage.setItem(FORGET_KEY, JSON.stringify([...forgotten])); } catch (e) {} }
function forgetDef(H) {
  forgotten.add(H);
  saveForgotten();
  published.delete(H);
  waiting.delete(H);
  // 部屋の記録からも消す（つながっているときだけ。つながっていなくても、この端末では戻さない）
  if (VoxelMulti.connected() && window.VoxelNet && VoxelNet.kv) {
    const kv = VoxelNet.kv();
    for (const key of [...kv.keys()]) {
      if (key === 'cdm:' + H || key.startsWith('cdef:' + H + ':')) VoxelMulti.send(key, undefined, true);
    }
  }
}
function unforgetDef(H) {
  if (!forgotten.delete(H)) return;
  saveForgotten();
}
function publishDef(def) {
  if (!VoxelMulti.connected()) return defHash(def);   // 部屋に入るまで送らない（送ったことにしない）
  const H = defHash(def);                             // しるしは一度だけ計算（毎回作り直すと重くなる）
  if (forgotten.has(H)) return H;                     // 削除したものは送らない
  const room = VoxelMulti.roomId();
  if (room !== publishedRoom) { published.clear(); publishedRoom = room; }
  if (published.has(H)) return H;
  const s = payloadOf(def);                           // 送る中身は、しるしと同じ元の形
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
const giveUp = new Set();          // 上限などで受け取れなかったしるし（何度も試さない）
const adoptListeners = [];         // 定義が届いたときに呼ぶ関数（置き場所の再確認など）

// 持っているカスタムブロック（インベントリの分）を、部屋の保存データに全部入れる。
// 設置していなくても、後から入った人の端末のインベントリに届く
function publishAllDefs() {
  if (!VoxelMulti.connected()) return;
  for (const d of ext.defs) if (d.id >= CUSTOM_BASE) publishDef(d);
}
setInterval(() => { try { publishAllDefs(); } catch (e) { console.error(e); } }, 3000);

// 部屋の記録（kv）を見直して、定義が届いているのに使えていないもの・置き場所が反映されていないものを直す
let reconSig = '', reconFullAt = 0;
function reconcileDefs() {
  const kv = window.VoxelNet && VoxelNet.kv && VoxelNet.kv();
  if (!kv || !VoxelMulti.connected()) return;
  for (const [key, val] of kv) {                        // 1) 定義が届いているのに、まだ登録できていないもの
    if (!key.startsWith('cdm:') || !val || val.del) continue;
    const H = key.slice(4);
    if (defByHash(H) || giveUp.has(H) || adopting.has(H) || forgotten.has(H)) continue;
    const o = getIn(H);
    o.n = Math.max(0, Number(val.v && val.v.n) || 0);
    for (let i = 0; i < o.n; i++) {
      const c = kv.get('cdef:' + H + ':' + i);
      if (c && !c.del && c.v && typeof c.v.d === 'string') o.parts[i] = c.v.d;
    }
    tryAdopt(H);
  }
  if (typeof getBlock !== 'function') return;
  // 置き場所の見直しは、変わったときか10秒に1回だけ（毎回すべての置き場所を調べると、数秒おきに一瞬止まるため）
  const sig = kv.size + ':' + ext.defs.length;
  const t = Date.now();
  if (sig === reconSig && t - reconFullAt < 10000) return;
  reconSig = sig; reconFullAt = t;
  const byH = new Map(ext.defs.map(d => [defHash(d), d]));
  for (const [key, val] of kv) {                        // 2) 置き場所の記録があるのに、まだ見えていないもの
    if (!key.startsWith('b:') || !val || val.del || !val.v || typeof val.v.h !== 'string') continue;
    const def = byH.get(val.v.h);
    if (!def) continue;
    const p = key.slice(2).split(',').map(Number);
    if (p.length !== 3 || p.some(n => !Number.isInteger(n)) || p[1] <= -64) continue;
    if (getBlock(p[0], p[1], p[2]) === def.id) continue;
    setState(p[0], p[1], p[2], val.v.s || null);
    VoxelMulti.applyBlock(p[0], p[1], p[2], def.id);
  }
}
setInterval(() => { try { reconcileDefs(); } catch (e) { console.error(e); } }, 4000);

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
  if (!o || !o.n || adopting.has(H) || forgotten.has(H)) return;
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
  const have = defByHash(H) || defByContent(p);   // 同じ中身が既にあれば、新しく増やさない
  if (have) { hashCache.set(have, H); return have.id; }
  const id = nextId();
  if (id < 0) { if (window.VoxelWorld) VoxelWorld.toast('カスタムブロックの上限に達したため、受け取れませんでした'); giveUp.add(H); return -1; }
  const def = {
    id, name: String(p.name || 'カスタムブロック'), kind: p.kind === 'model' ? 'model' : 'cube',
    category: (ext.categories && ext.categories[0]) || '未分類', colorable: !!p.colorable,
    texData: p.texData || null, model: p.model || null,
    orient: p.orient ?? undefined, scale: p.scale ?? undefined, alpha: p.alpha || 'cut', glowPower: p.glow ?? undefined, modelRot: p.mrot || 0,
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
  onAdopt: fn => adoptListeners.push(fn),
  forget: forgetDef,                                        // 削除したとき（この端末・部屋の記録から外す）
  unforget: unforgetDef                                     // 同じ中身を新しく作ったとき
};
})();
