// voxel-craft-server（Deno Deploy 版）
// ・部屋のデータは Deno の KV（永続保存）に保存する。ファイルには保存しない。
// ・変更の受け取りは「2秒ごとの問い合わせ（poll）」方式。Deploy のどの処理に当たっても届くようにするため。
// ・管理者はいない。部屋IDとパスワードを知っていれば誰でも参加・編集できる。

const PROTOCOL = 1;
const LOG_MAX = 5000;          // 変更の履歴を残す数（これより古い分は再読み込みが必要になる）
const MAX_KEY = 200;
const MAX_VALUE = 60 * 1024;   // 1つの値の大きさ上限（JSON文字数）
const MAX_OPS = 500;           // 1回の送信で受け付ける数

const kv = await Deno.openKv();

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

function randomId(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 同じ場所を同時に書いたら、時刻の新しい方が勝つ（同時刻なら peer の文字順）
function newer(a: any, b: any): boolean {
  if (!b) return true;
  if (a.ts !== b.ts) return a.ts > b.ts;
  return String(a.peer) > String(b.peer);
}

async function getRoom(id: string): Promise<any | null> {
  const r = await kv.get(['room', id]);
  return r.value ?? null;
}

async function checkPw(room: any, pw: unknown): Promise<boolean> {
  if (!room || typeof pw !== 'string') return false;
  return (await sha256Hex(room.salt + ':' + room.id + ':' + pw)) === room.pwHash;
}

// 変更を書き込む。同時書き込みと衝突したら、やり直す
async function applyOps(id: string, ops: any[]): Promise<number> {
  let applied = 0;
  for (const op of ops.slice(0, MAX_OPS)) {
    if (!op || typeof op.key !== 'string' || op.key.length > MAX_KEY || typeof op.ts !== 'number') continue;
    if (!op.del && JSON.stringify(op.v === undefined ? null : op.v).length > MAX_VALUE) continue;
    const peer = String(op.peer || '');
    const val = op.del ? { del: true, ts: op.ts, peer } : { v: op.v, ts: op.ts, peer };

    for (let tries = 0; tries < 5; tries++) {
      const cur = await kv.get(['kv', id, op.key]);
      if (cur.value && !newer(val, cur.value)) break;          // 新しい値が既にある
      const seqE = await kv.get(['seq', id]);
      const seq = ((seqE.value as number) ?? 0) + 1;
      const rec = { seq, key: op.key, ...val };
      const r = await kv.atomic()
        .check(cur)
        .check(seqE)
        .set(['kv', id, op.key], val)
        .set(['seq', id], seq)
        .set(['log', id, seq], rec)
        .commit();
      if (r.ok) {
        applied++;
        if (seq > LOG_MAX) await kv.delete(['log', id, seq - LOG_MAX]);
        break;
      }
    }
  }
  return applied;
}

async function pollOps(id: string, since: number) {
  const seqE = await kv.get(['seq', id]);
  const seq = (seqE.value as number) ?? 0;
  if (since < seq - LOG_MAX) return { seq, ops: [], resync: true };
  const ops: any[] = [];
  if (seq > since) {
    for await (const e of kv.list({ prefix: ['log', id], start: ['log', id, since + 1] }, { limit: 1000 })) {
      ops.push(e.value);
    }
  }
  return { seq, ops, resync: false };
}

async function joinData(id: string) {
  const seqE = await kv.get(['seq', id]);
  const kvs: [string, any][] = [];
  for await (const e of kv.list({ prefix: ['kv', id] })) {
    kvs.push([String(e.key[2]), e.value]);
  }
  return { seq: (seqE.value as number) ?? 0, kv: kvs };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  try {
    if (url.pathname === '/') {
      return new Response('voxel-craft server is running', { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS } });
    }
    if (url.pathname === '/api/health') return json({ ok: true, protocol: PROTOCOL });

    if (url.pathname === '/api/rooms' && req.method === 'POST') {
      const b = await req.json();
      if (typeof b.password !== 'string' || b.password.length < 4) {
        return json({ error: 'パスワードは4文字以上にしてください' }, 400);
      }
      const id = randomId(8);
      const salt = randomId(16);
      const room = {
        id,
        name: String(b.name || '共同都市').slice(0, 40),
        seed: b.seed ?? null,
        salt,
        pwHash: await sha256Hex(salt + ':' + id + ':' + b.password),
      };
      await kv.set(['room', id], room);
      await kv.set(['seq', id], 0);
      return json({ id, protocol: PROTOCOL });
    }

    const m = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/(join|ops|poll)$/);
    if (!m || req.method !== 'POST') return json({ error: 'not found' }, 404);

    const id = m[1];
    const body = await req.json();
    const room = await getRoom(id);
    if (!room || !(await checkPw(room, body.password))) {
      return json({ error: '部屋IDかパスワードが違います' }, 403);
    }

    if (m[2] === 'join') {
      const d = await joinData(id);
      return json({ id: room.id, name: room.name, seed: room.seed, seq: d.seq, protocol: PROTOCOL, kv: d.kv });
    }
    if (m[2] === 'ops') {
      const applied = await applyOps(id, Array.isArray(body.ops) ? body.ops : []);
      const seqE = await kv.get(['seq', id]);
      return json({ applied, seq: (seqE.value as number) ?? 0, protocol: PROTOCOL });
    }
    // poll：since より後の変更だけを返す
    const since = Number(body.since) || 0;
    const p = await pollOps(id, since);
    return json({ ...p, protocol: PROTOCOL });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 400);
  }
});
