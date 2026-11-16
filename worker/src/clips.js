/**
 * Clip storage for the in-game recorder. Runs on Durable Objects (SQLite), so it needs no R2 bucket and no card:
 * the Workers Free plan includes 5 GB of Durable Object storage.
 *
 * Only the owner account (TheFallenStarGG, or the REC_OWNER secret) may use /api/rec/*; the login token is checked
 * on every request. Playback links (/rec/<id>.mp4) are public so a clip can be shared or embedded.
 *
 *   POST /api/rec/start?ext=&label=   -> { id, key, url }       opens an upload
 *   PUT  /api/rec/part?id=&key=&n=    body = bytes (<= 16 MB)    parts go in order; resending the last one is safe
 *   POST /api/rec/finish?id=&key=     -> { url, size, expires }
 *   GET  /api/rec/list                -> { clips, total, max }   every stored clip, newest first
 *   POST /api/rec/delete?id=          -> { ok }
 *   GET  /rec/<id>.mp4|.webm          streams the clip (Range works, so it plays in a browser and embeds)
 *
 * Every clip is its own Durable Object (ClipStore). ClipIndex keeps the clip list + the account-wide byte total and,
 * when the pool is full, deletes the oldest clips to make room, so uploads keep working.
 */
import { authToken } from './accounts.js';

const ROW = 1_000_000;                    // bytes per SQLite row (a row may hold at most 2 MB)
const PART_MAX = 16 * ROW;                // largest single upload request
const CLIP_MAX = 900_000_000;             // free plan: 1 GB per Durable Object
const POOL_MAX = 4_500_000_000;           // free plan: 5 GB per account (headroom left for the rest of the worker)
const KEEP_MS = 14 * 24 * 3600 * 1000;    // finished clips are kept this long (or until the pool needs the room)
const OPEN_MS = 24 * 3600 * 1000;         // an upload that is never finished is dropped after a day
const DEFAULT_OWNER = 'TheFallenStarGG';  // account username (not the callsign); override with the REC_OWNER secret

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range, Authorization',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  'Access-Control-Max-Age': '86400',
};
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---------- owner check ----------
const okTokens = new Map(); // token -> expiry; only successful checks are cached, so the DB is not hit for every part
async function isOwner(request, env) {
  const tok = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!tok) return false;
  const hit = okTokens.get(tok);
  if (hit && hit > Date.now()) return true;
  let acct = null;
  try { acct = await authToken(env, tok); } catch (_) { return false; }
  const ok = !!acct && String(acct.username).toLowerCase() === String(env.REC_OWNER || DEFAULT_OWNER).toLowerCase();
  if (ok) {
    if (okTokens.size > 20) okTokens.clear();
    okTokens.set(tok, Date.now() + 60_000);
  }
  return ok;
}

/** one instance ('pool'): the clip list, how many bytes are stored, and who is oldest */
export class ClipIndex {
  constructor(state, env) {
    this.env = env;
    this.sql = state.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS clips (id TEXT PRIMARY KEY, bytes INTEGER NOT NULL DEFAULT 0, born INTEGER NOT NULL)');
    // columns added later; older deployments get them here
    const have = new Set(this.sql.exec('PRAGMA table_info(clips)').toArray().map((r) => r.name));
    for (const [col, def] of [
      ['ext', "TEXT NOT NULL DEFAULT 'mp4'"],
      ['label', "TEXT NOT NULL DEFAULT ''"],
      ['done', 'INTEGER NOT NULL DEFAULT 0'],
      ['exp', 'INTEGER NOT NULL DEFAULT 0'],
    ]) {
      if (!have.has(col)) this.sql.exec(`ALTER TABLE clips ADD COLUMN ${col} ${def}`);
    }
  }
  total() {
    return this.sql.exec('SELECT COALESCE(SUM(bytes), 0) AS t FROM clips').one().t;
  }
  async fetch(req) {
    const u = new URL(req.url);
    const id = u.searchParams.get('id') || '';
    if (u.pathname === '/add') {
      const n = Number(u.searchParams.get('n')) || 0;
      const ext = u.searchParams.get('ext') === 'webm' ? 'webm' : 'mp4';
      const label = (u.searchParams.get('label') || '').slice(0, 60);
      this.sql.exec('INSERT OR IGNORE INTO clips (id, bytes, born, ext, label) VALUES (?, 0, ?, ?, ?)', id, Date.now(), ext, label);
      while (n > 0 && this.total() + n > POOL_MAX) {
        const old = this.sql.exec('SELECT id FROM clips WHERE id != ? ORDER BY born ASC LIMIT 1', id).toArray()[0];
        if (!old) return json({ error: 'storage full' }, 507);
        this.sql.exec('DELETE FROM clips WHERE id = ?', old.id);
        try {
          await this.env.CLIP.get(this.env.CLIP.idFromName(old.id)).fetch('https://clip/purge?quiet=1', { method: 'POST' });
        } catch (_) {}
      }
      this.sql.exec('UPDATE clips SET bytes = MAX(0, bytes + ?) WHERE id = ?', n, id);
      return json({ ok: true });
    }
    if (u.pathname === '/done') {
      const size = Number(u.searchParams.get('n')) || 0;
      this.sql.exec('UPDATE clips SET done = 1, exp = ?, bytes = ? WHERE id = ?', Date.now() + KEEP_MS, size, id);
      return json({ ok: true });
    }
    if (u.pathname === '/list') {
      const clips = this.sql.exec('SELECT id, bytes, born, ext, label, done, exp FROM clips ORDER BY born DESC').toArray();
      return json({ clips, total: this.total(), max: POOL_MAX });
    }
    if (u.pathname === '/remove') {
      this.sql.exec('DELETE FROM clips WHERE id = ?', id);
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  }
}

/** one instance per clip: the bytes live in 1 MB rows keyed by their absolute offset */
export class ClipStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
  }
  init() {
    this.sql.exec('CREATE TABLE IF NOT EXISTS chunks (off INTEGER PRIMARY KEY, data BLOB NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS parts (n INTEGER PRIMARY KEY, start INTEGER NOT NULL, len INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  }
  m(k) {
    const r = this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0];
    return r ? r.v : null;
  }
  setM(k, v) {
    this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', k, String(v));
  }
  index() {
    return this.env.CLIPS_INDEX.get(this.env.CLIPS_INDEX.idFromName('pool'));
  }

  async fetch(req) {
    this.init();
    const u = new URL(req.url);
    const p = u.pathname;
    const id = u.searchParams.get('id') || '';
    const key = u.searchParams.get('key') || '';

    if (p === '/start') {
      if (this.m('key')) return json({ error: 'exists' }, 409);
      const ext = u.searchParams.get('ext') === 'webm' ? 'webm' : 'mp4';
      this.setM('key', key);
      this.setM('id', id);
      this.setM('ext', ext);
      this.setM('size', 0);
      this.setM('next', 0);
      this.setM('done', 0);
      await this.state.storage.setAlarm(Date.now() + OPEN_MS);
      // show up in the clip list right away (as "uploading")
      try {
        await this.index().fetch(`https://idx/add?id=${id}&n=0&ext=${ext}&label=${encodeURIComponent(u.searchParams.get('label') || '')}`);
      } catch (_) {}
      return json({ ok: true });
    }
    if (p === '/part') return this.part(req, u, id, key);
    if (p === '/finish') {
      if (!this.m('key') || this.m('key') !== key) return json({ error: 'bad key' }, 403);
      const size = Number(this.m('size'));
      if (!size) return json({ error: 'empty clip' }, 400);
      this.setM('done', 1);
      await this.state.storage.setAlarm(Date.now() + KEEP_MS);
      try { await this.index().fetch(`https://idx/done?id=${this.m('id')}&n=${size}`); } catch (_) {}
      return json({ ok: true, size, ext: this.m('ext') });
    }
    if (p === '/get') return this.serve(req);
    if (p === '/purge') {
      await this.purge(u.searchParams.get('quiet') === '1');
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  }

  async part(req, u, id, key) {
    if (!this.m('key') || this.m('key') !== key) return json({ error: 'bad key' }, 403);
    if (this.m('done') === '1') return json({ error: 'already finished' }, 409);
    const n = Number(u.searchParams.get('n'));
    if (!Number.isInteger(n) || n < 0) return json({ error: 'bad part number' }, 400);
    const next = Number(this.m('next'));
    const buf = new Uint8Array(await req.arrayBuffer());
    if (!buf.length) return json({ error: 'empty part' }, 400);
    if (buf.length > PART_MAX) return json({ error: 'part too large' }, 413);

    let start;
    let old = 0;
    if (n === next) start = Number(this.m('size'));
    else if (n === next - 1) {
      // the previous answer got lost and the client is resending: replace that part
      const row = this.sql.exec('SELECT start, len FROM parts WHERE n = ?', n).one();
      start = row.start;
      old = row.len;
    } else return json({ error: 'part out of order' }, 409);
    if (start + buf.length > CLIP_MAX) return json({ error: 'clip too large' }, 413);

    const r = await this.index().fetch(`https://idx/add?id=${id}&n=${buf.length - old}`);
    if (!r.ok) return json({ error: 'storage full' }, 507);

    this.state.storage.transactionSync(() => {
      if (old) this.sql.exec('DELETE FROM chunks WHERE off >= ? AND off < ?', start, start + old);
      for (let i = 0; i < buf.length; i += ROW) {
        this.sql.exec('INSERT INTO chunks (off, data) VALUES (?, ?)', start + i, buf.slice(i, i + ROW).buffer);
      }
      this.sql.exec('INSERT OR REPLACE INTO parts (n, start, len) VALUES (?, ?, ?)', n, start, buf.length);
      this.setM('size', start + buf.length);
      this.setM('next', n + 1);
    });
    return json({ ok: true, size: start + buf.length });
  }

  serve(req) {
    if (this.m('done') !== '1') return json({ error: 'not found' }, 404);
    const size = Number(this.m('size'));
    const mp4 = this.m('ext') === 'mp4';
    let a = 0;
    let b = size - 1;
    let status = 200;
    const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('Range') || '');
    if (rg && (rg[1] || rg[2])) {
      if (rg[1]) {
        a = +rg[1];
        if (rg[2]) b = Math.min(b, +rg[2]);
      } else a = Math.max(0, size - +rg[2]);
      if (a > b || a >= size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, ...CORS } });
      }
      status = 206;
    }
    const headers = {
      'Content-Type': mp4 ? 'video/mp4' : 'video/webm',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(b - a + 1),
      'Cache-Control': 'public, max-age=3600',
      'Content-Disposition': 'inline',
      ...CORS,
    };
    if (status === 206) headers['Content-Range'] = `bytes ${a}-${b}/${size}`;
    if (req.method === 'HEAD') return new Response(null, { status, headers });
    return new Response(this.stream(a, b), { status, headers });
  }

  /** reads one row per pull, so a 150 MB clip never sits in memory */
  stream(a, b) {
    const sql = this.sql;
    let pos = a;
    return new ReadableStream({
      pull(ctl) {
        if (pos > b) {
          ctl.close();
          return;
        }
        try {
          const r = sql.exec('SELECT off, data FROM chunks WHERE off <= ? ORDER BY off DESC LIMIT 1', pos).toArray()[0];
          if (!r) throw new Error('gap');
          const d = new Uint8Array(r.data);
          if (pos - r.off >= d.length) throw new Error('gap');
          const e = Math.min(d.length, b - r.off + 1);
          ctl.enqueue(d.subarray(pos - r.off, e));
          pos = r.off + e;
        } catch (err) {
          ctl.error(err);
        }
      },
    });
  }

  async purge(quiet) {
    const id = this.m('id');
    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
    if (id && !quiet) {
      try { await this.index().fetch('https://idx/remove?id=' + id); } catch (_) {}
    }
  }
  async alarm() {
    this.init();
    await this.purge(false);
  }
}

/** routes /api/rec/* (owner only) and /rec/* (public playback); returns null for anything else */
export async function handleClips(request, env) {
  const url = new URL(request.url);
  const p = url.pathname;
  const m = request.method;
  if (!p.startsWith('/api/rec/') && !p.startsWith('/rec/')) return null;
  if (m === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!env.CLIP || !env.CLIPS_INDEX) return json({ error: 'clip storage is not set up on this worker' }, 503);
  if (p.startsWith('/api/rec/') && !(await isOwner(request, env))) return json({ error: 'not_allowed' }, 403);

  const stub = (id) => env.CLIP.get(env.CLIP.idFromName(id));
  const idx = () => env.CLIPS_INDEX.get(env.CLIPS_INDEX.idFromName('pool'));
  const pass = async (id, path, init) => {
    const r = await stub(id).fetch('https://clip' + path, init);
    const h = new Headers(r.headers);
    for (const [k, v] of Object.entries(CORS)) h.set(k, v);
    return new Response(r.body, { status: r.status, headers: h });
  };
  const q = url.searchParams;
  const id = q.get('id') || '';
  const key = encodeURIComponent(q.get('key') || '');
  const okId = /^[0-9a-f]{32}$/.test(id);

  if (p === '/api/rec/start' && m === 'POST') {
    const ext = q.get('ext') === 'webm' ? 'webm' : 'mp4';
    const label = (q.get('label') || '').replace(/[^\w .:-]/g, '').slice(0, 60);
    const nid = hex(16);
    const nkey = hex(16);
    const r = await stub(nid).fetch(`https://clip/start?id=${nid}&key=${nkey}&ext=${ext}&label=${encodeURIComponent(label)}`, { method: 'POST' });
    if (!r.ok) return json({ error: 'could not open an upload' }, 500);
    return json({ id: nid, key: nkey, url: `${url.origin}/rec/${nid}.${ext}` });
  }
  if (p === '/api/rec/part' && m === 'PUT' && okId) {
    if (Number(request.headers.get('Content-Length') || 0) > PART_MAX) return json({ error: 'part too large' }, 413);
    const body = await request.arrayBuffer();
    return pass(id, `/part?id=${id}&key=${key}&n=${encodeURIComponent(q.get('n') || '')}`, { method: 'PUT', body });
  }
  if (p === '/api/rec/finish' && m === 'POST' && okId) {
    const r = await pass(id, `/finish?id=${id}&key=${key}`, { method: 'POST' });
    if (!r.ok) return r;
    const d = await r.json();
    return json({ url: `${url.origin}/rec/${id}.${d.ext}`, size: d.size, expires: '14 days' });
  }
  if (p === '/api/rec/list' && m === 'GET') {
    const d = await (await idx().fetch('https://idx/list')).json();
    return json({
      max: d.max,
      total: d.total,
      clips: d.clips.map((c) => ({
        id: c.id,
        url: `${url.origin}/rec/${c.id}.${c.ext}`,
        ext: c.ext,
        label: c.label,
        bytes: c.bytes,
        born: c.born,
        exp: c.exp,
        done: !!c.done,
      })),
    });
  }
  if (p === '/api/rec/delete' && m === 'POST' && okId) {
    try { await stub(id).fetch('https://clip/purge?quiet=1', { method: 'POST' }); } catch (_) {}
    await idx().fetch('https://idx/remove?id=' + id);
    return json({ ok: true });
  }
  const g = /^\/rec\/([0-9a-f]{32})\.(mp4|webm)$/.exec(p);
  if (g && (m === 'GET' || m === 'HEAD')) {
    const headers = {};
    const rg = request.headers.get('Range');
    if (rg) headers.Range = rg;
    return pass(g[1], '/get', { method: m, headers });
  }
  return json({ error: 'not found' }, 404);
}
