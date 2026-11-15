/**
 * Accounts + global leaderboards (Cloudflare Worker + Turso over its HTTP API, no npm packages).
 * Worker secrets: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN. Optional: PBKDF2_ITERS (default 20000).
 * Tables are created automatically on the first request.
 */
const enc = new TextEncoder();
const SESSION_MS = 90 * 24 * 3600 * 1000;
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const RESERVED = new Set(['system', 'admin', 'server', 'moderator', 'player', 'guest']);
const FLUSH_MS = 20000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

// ---------- Turso (libSQL over HTTP) ----------
const targ = (v) => (v === null || v === undefined ? { type: 'null' }
  : typeof v === 'number' ? (Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v })
    : { type: 'text', value: String(v) });
const cell = (c) => (c.type === 'null' ? null : c.type === 'integer' || c.type === 'float' ? Number(c.value) : c.value);

/** stmts: [[sql, args?], ...] -> [{ rows, lastId }, ...] */
async function sql(env, stmts) {
  const base = String(env.TURSO_DATABASE_URL || '').trim().replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
  if (!base || !env.TURSO_AUTH_TOKEN) throw new Error('db_not_configured');
  const requests = stmts.map(([q, args]) => ({ type: 'execute', stmt: { sql: q, args: (args || []).map(targ) } }));
  requests.push({ type: 'close' });
  const res = await fetch(base + '/v2/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.TURSO_AUTH_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error('db_http_' + res.status);
  const j = await res.json();
  return stmts.map((_, i) => {
    const r = j.results[i];
    if (!r || r.type !== 'ok') throw new Error((r && r.error && r.error.message) || 'sql_error');
    const out = r.response.result, cols = out.cols.map((c) => c.name);
    return {
      rows: out.rows.map((row) => Object.fromEntries(row.map((c, k) => [cols[k], cell(c)]))),
      lastId: out.last_insert_rowid != null ? Number(out.last_insert_rowid) : null,
    };
  });
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, username_lc TEXT NOT NULL UNIQUE, pw TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS stats (account_id INTEGER PRIMARY KEY, kills INTEGER NOT NULL DEFAULT 0, deaths INTEGER NOT NULL DEFAULT 0, headshots INTEGER NOT NULL DEFAULT 0, bot_kills INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, best_streak INTEGER NOT NULL DEFAULT 0, run_ms INTEGER, reflex INTEGER NOT NULL DEFAULT 0, dps INTEGER NOT NULL DEFAULT 0, secrets INTEGER NOT NULL DEFAULT 0, classified INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`,
];
let schemaReady = null;
const ensureSchema = (env) => (schemaReady ||= sql(env, SCHEMA.map((s) => [s])).catch((e) => { schemaReady = null; throw e; }));

// ---------- crypto ----------
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(String(s).match(/../g) || [], (h) => parseInt(h, 16));
const sha = async (s) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
const iterations = (env) => Math.max(1000, Math.min(100000, parseInt(env.PBKDF2_ITERS, 10) || 20000));
async function pbkdf2(pw, salt, n) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: n }, key, 256));
}
async function makePw(pw, env) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), n = iterations(env);
  return `pbkdf2$${n}$${hex(salt)}$${hex(await pbkdf2(pw, salt, n))}`;
}
async function checkPw(pw, rec) {
  const [kind, n, salt, h] = String(rec || '').split('$');
  if (kind !== 'pbkdf2') return false;
  const got = await pbkdf2(pw, unhex(salt), parseInt(n, 10) || 20000), want = unhex(h);
  if (got.length !== want.length) return false;
  let d = 0;
  for (let i = 0; i < got.length; i++) d |= got[i] ^ want[i];
  return d === 0;
}
const DUMMY_PW = `pbkdf2$20000$${'00'.repeat(16)}$${'00'.repeat(32)}`; // keeps "no such user" about as slow as "wrong password"

// best-effort per-isolate rate limit for sign-up / login
const tries = new Map();
function limited(ip, max = 12, windowMs = 10 * 60 * 1000) {
  const now = Date.now(), list = (tries.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now); tries.set(ip, list);
  if (tries.size > 500) for (const [k, v] of tries) if (!v.length || now - v[v.length - 1] > windowMs) tries.delete(k);
  return list.length > max;
}

// ---------- sessions ----------
async function newSession(env, id) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32))), now = Date.now();
  await sql(env, [
    [`DELETE FROM sessions WHERE expires_at < ?`, [now]],
    [`INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?,?,?,?)`, [await sha(token), id, now, now + SESSION_MS]],
  ]);
  return token;
}
/** -> { id, username } or null */
export async function authToken(env, token) {
  if (!token || token.length < 32 || token.length > 128) return null;
  await ensureSchema(env);
  const [r] = await sql(env, [[
    `SELECT a.id AS id, a.username AS username FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ?`,
    [await sha(token), Date.now()],
  ]]);
  return r.rows[0] || null;
}

// ---------- leaderboards ----------
const BOARDS = { // key: [column, direction, filter]
  run: ['run_ms', 'ASC', 'run_ms IS NOT NULL'],
  reflex: ['reflex', 'DESC', 'reflex > 0'],
  dps: ['dps', 'DESC', 'dps > 0'],
  kills: ['kills', 'DESC', 'kills > 0'],
  headshots: ['headshots', 'DESC', 'headshots > 0'],
  streak: ['best_streak', 'DESC', 'best_streak > 0'],
  wins: ['wins', 'DESC', 'wins > 0'],
  botKills: ['bot_kills', 'DESC', 'bot_kills > 0'],
  secrets: ['secrets', 'DESC', 'secrets > 0'],
  classified: ['classified', 'DESC', 'classified > 0'],
};
let boardCache = { t: 0, body: null };
async function boards(env) {
  if (boardCache.body && Date.now() - boardCache.t < 20000) return boardCache.body;
  const keys = Object.keys(BOARDS);
  const res = await sql(env, keys.map((k) => {
    const [col, dir, where] = BOARDS[k];
    return [`SELECT a.username AS n, s.${col} AS v FROM stats s JOIN accounts a ON a.id = s.account_id WHERE ${where} ORDER BY s.${col} ${dir}, a.id ASC LIMIT 10`];
  }));
  const out = {};
  keys.forEach((k, i) => { out[k] = res[i].rows; });
  boardCache = { t: Date.now(), body: { t: Date.now(), boards: out } };
  return boardCache.body;
}

// ---------- HTTP API ----------
const bodyOf = async (request) => {
  const t = await request.text();
  if (t.length > 2000) throw new Error('too_big');
  return t ? JSON.parse(t) : {};
};
const bearer = (request) => (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
const ME_SQL = `SELECT a.username AS username, s.kills AS kills, s.deaths AS deaths, s.headshots AS headshots, s.bot_kills AS botKills, s.wins AS wins, s.best_streak AS streak, s.run_ms AS runMs, s.reflex AS reflex, s.dps AS dps, s.secrets AS secrets, s.classified AS classified FROM accounts a LEFT JOIN stats s ON s.account_id = a.id WHERE a.id = ?`;
const clampInt = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };

export async function handleApi(request, env, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const path = url.pathname, post = request.method === 'POST';
  try {
    if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) return json({ error: 'accounts_offline' }, 503);
    await ensureSchema(env);

    if (path === '/api/lb' && request.method === 'GET') return json(await boards(env));

    if (post && (path === '/api/auth/signup' || path === '/api/auth/login')) {
      if (limited(request.headers.get('cf-connecting-ip') || 'unknown')) return json({ error: 'too_many_attempts' }, 429);
      const b = await bodyOf(request);
      const username = String(b.username || '').trim(), password = String(b.password || '');
      if (!NAME_RE.test(username)) return json({ error: 'bad_username' }, 400);
      if (password.length < 6 || password.length > 128) return json({ error: 'bad_password' }, 400);
      const lc = username.toLowerCase();

      if (path.endsWith('/signup')) {
        if (RESERVED.has(lc)) return json({ error: 'username_taken' }, 409);
        const rec = await makePw(password, env);
        let id;
        try {
          const [r] = await sql(env, [[`INSERT INTO accounts (username, username_lc, pw, created_at) VALUES (?,?,?,?)`, [username, lc, rec, Date.now()]]]);
          id = r.lastId;
        } catch (e) {
          if (/UNIQUE|constraint/i.test(String(e.message))) return json({ error: 'username_taken' }, 409);
          throw e;
        }
        await sql(env, [[`INSERT OR IGNORE INTO stats (account_id, updated_at) VALUES (?,?)`, [id, Date.now()]]]);
        return json({ ok: true, token: await newSession(env, id), user: { username } });
      }

      const [r] = await sql(env, [[`SELECT id, username, pw FROM accounts WHERE username_lc = ?`, [lc]]]);
      const row = r.rows[0];
      const ok = await checkPw(password, row ? row.pw : DUMMY_PW);
      if (!row || !ok) return json({ error: 'bad_login' }, 401);
      return json({ ok: true, token: await newSession(env, row.id), user: { username: row.username } });
    }

    if (path === '/api/auth/me' && request.method === 'GET') {
      const a = await authToken(env, bearer(request));
      if (!a) return json({ error: 'unauthorized' }, 401);
      const [r] = await sql(env, [[ME_SQL, [a.id]]]);
      return json({ ok: true, user: r.rows[0] });
    }

    if (post && path === '/api/auth/logout') {
      const t = bearer(request);
      if (t) await sql(env, [[`DELETE FROM sessions WHERE token_hash = ?`, [await sha(t)]]]);
      return json({ ok: true });
    }

    if (post && path === '/api/score') {
      const a = await authToken(env, bearer(request));
      if (!a) return json({ error: 'unauthorized' }, 401);
      const b = await bodyOf(request);
      // client-reported records: only plausible values get through, and only improvements are stored
      const run = clampInt(b.run_ms, 5000, 3600000);
      const reflex = clampInt(b.reflex, 0, 3000) || 0, dps = clampInt(b.dps, 0, 3000) || 0;
      const secrets = clampInt(b.secrets, 0, 8) || 0, classified = clampInt(b.classified, 0, 8) || 0;
      await sql(env, [[
        `UPDATE stats SET run_ms = CASE WHEN ?1 IS NOT NULL AND (run_ms IS NULL OR ?1 < run_ms) THEN ?1 ELSE run_ms END, reflex = MAX(reflex, ?2), dps = MAX(dps, ?3), secrets = MAX(secrets, ?4), classified = MAX(classified, ?5), updated_at = ?6 WHERE account_id = ?7`,
        [run, reflex, dps, secrets, classified, Date.now(), a.id],
      ]]);
      return json({ ok: true });
    }

    return json({ error: 'not_found' }, 404);
  } catch (e) {
    const m = String((e && e.message) || e);
    console.error('[accounts]', m);
    if (e instanceof SyntaxError || m === 'too_big') return json({ error: 'bad_request' }, 400);
    if (m.startsWith('db_')) return json({ error: 'accounts_offline' }, 503);
    return json({ error: 'server_error' }, 500);
  }
}

// ---------- in-match stat tracking (server-authoritative) ----------
const newSt = () => ({ kills: 0, deaths: 0, hs: 0, bots: 0, wins: 0, streak: 0, best: 0, timer: null });
const mark = (env, s) => { if (s.st && !s.st.timer) s.st.timer = setTimeout(() => flush(env, s), FLUSH_MS); };

async function flush(env, s) {
  const st = s.st;
  if (!st) return;
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  const d = { k: st.kills, d: st.deaths, h: st.hs, b: st.bots, w: st.wins };
  if (!(d.k || d.d || d.h || d.b || d.w)) return;
  st.kills = st.deaths = st.hs = st.bots = st.wins = 0;
  try {
    await sql(env, [[
      `UPDATE stats SET kills = kills + ?1, deaths = deaths + ?2, headshots = headshots + ?3, bot_kills = bot_kills + ?4, wins = wins + ?5, best_streak = MAX(best_streak, ?6), updated_at = ?7 WHERE account_id = ?8`,
      [d.k, d.d, d.h, d.b, d.w, st.best, Date.now(), s.aid],
    ]]);
  } catch (e) {
    st.kills += d.k; st.deaths += d.d; st.hs += d.h; st.bots += d.b; st.wins += d.w; // keep them for the next flush
    console.error('[stats]', e && e.message);
  }
}

export function installAccountHooks(GameRoom) {
  const P = GameRoom.prototype;

  // attach the verified account (entry.js put its id in ?aid=) to the new session
  const handleSession = P.handleSession;
  P.handleSession = function (ws, name, params) {
    handleSession.call(this, ws, name, params);
    const aid = parseInt(params.get('aid') || '', 10);
    if (!aid) return;
    let s = null;
    for (const x of this.sessions.values()) if (x.ws === ws) { s = x; break; }
    if (!s) return;
    s.aid = aid;
    s.st = newSt();
    const env = this.env, done = () => flush(env, s);
    ws.addEventListener('close', done);
    ws.addEventListener('error', done);
  };

  // player vs player kills (headshots, streaks, deaths)
  const kill = P.kill;
  P.kill = function (att, tgt, info) {
    kill.call(this, att, tgt, info);
    if (!this.cfg || this.cfg.social) return;
    if (att.st) {
      att.st.kills++;
      att.st.streak++;
      if (att.st.streak > att.st.best) att.st.best = att.st.streak;
      if (info && info.head) att.st.hs++;
      mark(this.env, att);
    }
    if (tgt.st) { tgt.st.deaths++; tgt.st.streak = 0; mark(this.env, tgt); }
  };

  // bot arena kills
  const hitBot = P.hitBot;
  P.hitBot = function (msg, attacker) {
    const b = this.bots && this.bots.find((x) => x.id === msg.id);
    const was = !!(b && b.alive);
    hitBot.call(this, msg, attacker);
    if (was && b && !b.alive && attacker && attacker.st) { attacker.st.bots++; mark(this.env, attacker); }
  };

  // match wins (needs 2+ players so nobody farms solo)
  const setPhase = P.setPhase;
  P.setPhase = function (p, secs, o) {
    if (p === 'ended' && this.phase !== 'ended' && this.cfg && !this.cfg.social && !this.cfg.botArena) {
      const list = [...this.sessions.values()];
      if (list.length >= 2) {
        let winners = [];
        if (this.cfg.rounds) {
          const t = this.wins.A >= this.cfg.win ? 'A' : this.wins.B >= this.cfg.win ? 'B' : null;
          if (t) winners = list.filter((s) => s.team === t);
        } else {
          let top = null;
          for (const s of list) if (!top || s.k > top.k) top = s;
          if (top) winners = [top];
        }
        for (const s of winners) if (s.st) { s.st.wins++; mark(this.env, s); }
      }
    }
    return setPhase.call(this, p, secs, o);
  };
}
