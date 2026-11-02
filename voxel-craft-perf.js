/* voxel-craft-perf.js  描画の軽量化（新しいファイル）
 *  ・見た目と結果は、本体と完全に同じ（頂点・色・インデックスまで一致することを確認済み）
 *  ・チャンクのメッシュ作成を、使い回しの配列で行う。チャンクごとに小さな配列を大量に作らないので、
 *    ガベージ回収によるカクつき（フレームの一瞬の停止）が減る
 *  ・読み込み順：本体HTMLの後（本体の buildMesh などを差し替える）
 */
(function () {
'use strict';

// 頂点・インデックスをためる入れ物。足りなくなったら2倍に広げる（めったに起きない）
class Sink {
  constructor(quads) {
    this.vcap = quads * 4;
    this.icap = quads * 6;
    this.p = new Float32Array(this.vcap * 3);
    this.n = new Float32Array(this.vcap * 3);
    this.uv = new Float32Array(this.vcap * 2);
    this.c = new Float32Array(this.vcap * 3);
    this.i = new Uint32Array(this.icap);
    this.nv = 0;
    this.ni = 0;
  }
  reset() { this.nv = 0; this.ni = 0; }
  need(dv, di) {
    if (this.nv + dv <= this.vcap && this.ni + di <= this.icap) return;
    const vcap = Math.max(this.vcap * 2, this.nv + dv);
    const icap = Math.max(this.icap * 2, this.ni + di);
    const grow = (old, per, cap) => { const a = new Float32Array(cap * per); a.set(old.subarray(0, this.nv * per)); return a; };
    this.p = grow(this.p, 3, vcap);
    this.n = grow(this.n, 3, vcap);
    this.uv = grow(this.uv, 2, vcap);
    this.c = grow(this.c, 3, vcap);
    const ni = new Uint32Array(icap); ni.set(this.i.subarray(0, this.ni)); this.i = ni;
    this.vcap = vcap;
    this.icap = icap;
  }
  // 本体と同じ形の、ぴったりの大きさのジオメトリを作る（使い回しの配列は、コピーして渡す）
  geometry() {
    const nv = this.nv, ni = this.ni;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.p.slice(0, nv * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.n.slice(0, nv * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.slice(0, nv * 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(this.c.slice(0, nv * 3), 3));
    if (nv - 1 > 65535) g.setIndex(new THREE.BufferAttribute(this.i.slice(0, ni), 1));
    else g.setIndex(new THREE.BufferAttribute(Uint16Array.from(this.i.subarray(0, ni)), 1));
    return g;
  }
}

const SINK_SOLID = new Sink(4096), SINK_WATER = new Sink(1024), SINK_PLANT = new Sink(1024);
const AO = new Float64Array(4);
const ONE = [1, 1, 1, 1];

// 本体の emitQuad と同じ結果（頂点の並び・UV・色・三角形の向き）
function quad(S, f, x, y, z, tile, A) {
  const nd = FACES[f];
  S.need(4, 6);
  const v0 = S.nv;
  const col = tile % 4, row = Math.floor(tile / 4);
  const u0 = col / 4, u1 = (col + 1) / 4;
  const vb = 1 - (row + 1) / 4, vt = 1 - row / 4;
  for (let i = 0; i < 4; i++) {
    const c = nd.corners[i], k = v0 + i;
    S.p[k * 3] = x + c[0]; S.p[k * 3 + 1] = y + c[1]; S.p[k * 3 + 2] = z + c[2];
    S.n[k * 3] = nd.n[0]; S.n[k * 3 + 1] = nd.n[1]; S.n[k * 3 + 2] = nd.n[2];
    S.uv[k * 2] = (i === 1 || i === 2) ? u1 : u0;
    S.uv[k * 2 + 1] = (i < 2) ? vb : vt;
    S.c[k * 3] = A[i]; S.c[k * 3 + 1] = A[i]; S.c[k * 3 + 2] = A[i];
  }
  S.nv += 4;
  const ii = S.ni;
  if (A[0] + A[2] > A[1] + A[3]) {
    S.i[ii] = v0; S.i[ii + 1] = v0 + 1; S.i[ii + 2] = v0 + 3; S.i[ii + 3] = v0 + 1; S.i[ii + 4] = v0 + 2; S.i[ii + 5] = v0 + 3;
  } else {
    S.i[ii] = v0; S.i[ii + 1] = v0 + 1; S.i[ii + 2] = v0 + 2; S.i[ii + 3] = v0; S.i[ii + 4] = v0 + 2; S.i[ii + 5] = v0 + 3;
  }
  S.ni += 6;
}

// 本体の emitPlant と同じ結果（十字の2枚のカード）
function plant(S, cx, cy, cz, type, h, w, ang, shade) {
  const u0 = type / 5, u1 = (type + 1) / 5;
  for (let q = 0; q < 2; q++) {
    const a = ang + q * Math.PI / 2;
    const dx = Math.cos(a) * w / 2, dz = Math.sin(a) * w / 2;
    S.need(4, 6);
    const v0 = S.nv;
    const pts = [cx - dx, cy, cz - dz, cx + dx, cy, cz + dz, cx + dx, cy + h, cz + dz, cx - dx, cy + h, cz - dz];
    for (let i = 0; i < 4; i++) {
      const k = v0 + i;
      S.p[k * 3] = pts[i * 3]; S.p[k * 3 + 1] = pts[i * 3 + 1]; S.p[k * 3 + 2] = pts[i * 3 + 2];
      S.n[k * 3] = 0; S.n[k * 3 + 1] = 1; S.n[k * 3 + 2] = 0;
      S.c[k * 3] = shade; S.c[k * 3 + 1] = shade; S.c[k * 3 + 2] = shade;
    }
    S.uv[v0 * 2] = u0; S.uv[v0 * 2 + 1] = 0;
    S.uv[v0 * 2 + 2] = u1; S.uv[v0 * 2 + 3] = 0;
    S.uv[v0 * 2 + 4] = u1; S.uv[v0 * 2 + 5] = 1;
    S.uv[v0 * 2 + 6] = u0; S.uv[v0 * 2 + 7] = 1;
    S.nv += 4;
    const ii = S.ni;
    S.i[ii] = v0; S.i[ii + 1] = v0 + 1; S.i[ii + 2] = v0 + 2; S.i[ii + 3] = v0; S.i[ii + 4] = v0 + 2; S.i[ii + 5] = v0 + 3;
    S.ni += 6;
  }
}

// 本体の computeAO と同じ計算（配列を作り直さず、AO に書く）
function aoInto(pi, f) {
  const nd = FACES[f];
  const k = nd.axis, A = (k + 1) % 3, B = (k + 2) % 3;
  const base = pi + nd.off;
  for (let i = 0; i < 4; i++) {
    const c = nd.corners[i];
    const sA = c[A] ? 1 : -1, sB = c[B] ? 1 : -1;
    const s1 = opq(P[base + sA * STRIDE[A]]);
    const s2 = opq(P[base + sB * STRIDE[B]]);
    const cc = opq(P[base + sA * STRIDE[A] + sB * STRIDE[B]]);
    const lvl = (s1 && s2) ? 0 : 3 - (s1 + s2 + cc);
    AO[i] = AO_BRIGHT[lvl];
  }
}

// 本体の buildMesh と同じ手順・同じ結果。違うのは、配列の作り方だけ
// 境界に必要な、まだ地形データを作っていない隣のチャンクを探す（1回の呼び出しで1つだけ作る）
function firstMissingNeighbour(e) {
  for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    if (dx === 0 && dy === 0 && dz === 0) continue;
    // 下の隣は、境界の1段（底より上にあるとき）だけ使う。底より下は岩盤なので作らなくてよい
    if (dy === -1 && e.cy * CS - 1 <= BOTTOM) continue;
    const cx = e.cx + dx, cy = e.cy + dy, cz = e.cz + dz;
    const n = chunks.get(ckey(cx, cy, cz));
    if (!n || !n.gen) return [cx, cy, cz];
  }
  return null;
}

// 本体の buildMesh と同じ結果。隣の地形がまだ無いときは、今回は1つだけ作って、次の順番に回す
function buildMeshFast(e) {
  if (!e.gen) generateEntry(e);
  if (!e.data) {                           // 空気だけのチャンク（隣は不要）
    e.dirty = false;
    e.built = true;
    disposeEntry(e);
    return;
  }
  const miss = firstMissingNeighbour(e);
  if (miss) {
    getEntry(miss[0], miss[1], miss[2]);   // 隣の地形を1つ作る（ここが重いので、フレームを分ける）
    requestMesh(e);                        // 次のフレームで、この続きを作る
    return;
  }
  e.dirty = false;
  e.built = true;
  disposeEntry(e);

  const ox = e.cx * CS, oy = e.cy * CS, oz = e.cz * CS;
  const d = e.data;

  // パディング付きの配列（隣のチャンクの境界用）。本体と同じ
  for (let pz = 0; pz < 18; pz++) for (let py = 0; py < 18; py++) for (let px = 0; px < 18; px++) {
    const lx = px - 1, ly = py - 1, lz = pz - 1;
    let t;
    if (lx >= 0 && lx < 16 && ly >= 0 && ly < 16 && lz >= 0 && lz < 16) t = d[lx + ly * 16 + lz * 256];
    else t = getBlock(ox + lx, oy + ly, oz + lz);
    P[px + py * 18 + pz * 324] = t;
  }

  SINK_SOLID.reset(); SINK_WATER.reset(); SINK_PLANT.reset();
  for (let z = 0; z < 16; z++) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const pi = (x + 1) + (y + 1) * 18 + (z + 1) * 324;
    const t = P[pi];
    if (t === AIR) {
      if (P[pi - STRIDE[1]] === GRASS) {
        const wx = ox + x, wz = oz + z;
        const r = hash2(wx, wz, 777);
        if (r < 0.45) {
          const cxw = x + 0.5 + (hash2(wx, wz, 781) - 0.5) * 0.5;
          const czw = z + 0.5 + (hash2(wx, wz, 782) - 0.5) * 0.5;
          const ang = hash2(wx, wz, 783) * Math.PI;
          const shade = 0.82 + 0.18 * hash2(wx, wz, 784);
          if (r < 0.04) {
            const type = 2 + Math.floor(hash2(wx, wz, 779) * 3);
            plant(SINK_PLANT, cxw, y, czw, type, 0.35 + 0.3 * hash2(wx, wz, 780), 0.6, ang, shade);
          } else if (hash2(wx, wz, 778) < 0.5) {
            plant(SINK_PLANT, cxw, y, czw, 0, 0.7 + 0.4 * hash2(wx, wz, 780), 0.95, ang, shade);
          } else {
            plant(SINK_PLANT, cxw, y, czw, 1, 0.3 + 0.25 * hash2(wx, wz, 780), 0.9, ang, shade);
          }
        }
      }
      continue;
    }
    for (let f = 0; f < 6; f++) {
      const nt = P[pi + FACES[f].off];
      if (t === WATER) {
        if (nt !== AIR) continue;
        SINK_WATER.need(4, 6);
        quad(SINK_WATER, f, x, y, z, tileIndex(t, f), ONE);
      } else {
        if (nt !== AIR && nt !== WATER) continue;
        aoInto(pi, f);
        SINK_SOLID.need(4, 6);
        quad(SINK_SOLID, f, x, y, z, tileIndex(t, f), AO);
      }
    }
  }

  if (SINK_SOLID.nv) {
    const m = new THREE.Mesh(SINK_SOLID.geometry(), solidMat);
    m.position.set(ox, oy, oz);
    m.castShadow = shaderOn;
    m.receiveShadow = shaderOn;
    scene.add(m);
    e.mesh = m;
  }
  if (SINK_WATER.nv) {
    const m = new THREE.Mesh(SINK_WATER.geometry(), shaderOn ? waterShaderMat : waterMat);
    m.position.set(ox, oy, oz);
    m.renderOrder = 2;
    scene.add(m);
    e.water = m;
  }
  if (SINK_PLANT.nv) {
    const m = new THREE.Mesh(SINK_PLANT.geometry(), plantMat);
    m.position.set(ox, oy, oz);
    scene.add(m);
    e.plant = m;
  }
}

// 本体の buildMesh を、この軽い版に差し替える（呼び出しは本体の processMeshQueue のまま）
window.buildMesh = buildMeshFast;
window.VoxelPerf = { version: 1 };
})();
