/**
 * Accounts + global leaderboards (Cloudflare Worker + Turso over its HTTP API, no npm packages).
 * Worker secrets: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN. Optional: PBKDF2_ITERS (default 20000).
 * Owner account (TheFallenStarGG) can ban / delete via /api/mod/* — never bannable itself.
 */
const enc = new TextEncoder();
const SESSION_MS = 90 * 24 * 3600 * 1000;
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const RESERVED = new Set(['system', 'admin', 'server', 'moderator', 'player', 'guest']);
const OWNER_LC = 'thefallenstargg';
const FLUSH_MS = 20000;
const IMPERSONATION_MSG = 'Your account was deleted for impersonating the owner.';

export function isReservedUsername(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!s) return false;
  if (s === OWNER_LC) return false;
  if (s.includes('fallenstar') || s.includes('fallenstarg')) return true;
  if (s.startsWith('thefallen')) return true;
  return false;
}

function isInvalidNameAccount(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return s === 'invalidname' || /^invalidname\d+$/.test(s);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Id',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

const clientIp = (request) =>
  (request.headers.get('cf-connecting-ip')
    || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || request.headers.get('x-real-ip')
    || 'unknown').slice(0, 64);

const deviceOf = (request, body) => {
  const h = (request.headers.get('X-Device-Id') || '').trim();
  const b = body && body.device ? String(body.device).trim() : '';
  const d = (h || b).slice(0, 80);
  return /^[A-Za-z0-9_-]{8,80}$/.test(d) ? d : '';
};

// ---------- Turso ----------
const targ = (v) => (v === null || v === undefined ? { type: 'null' }
  : typeof v === 'number' ? (Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v })
    : { type: 'text', value: String(v) });
const cell = (c) => (c.type === 'null' ? null : c.type === 'integer' || c.type === 'float' ? Number(c.value) : c.value);

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
  `CREATE TABLE IF NOT EXISTS account_meta (account_id INTEGER PRIMARY KEY, last_ip TEXT, last_device TEXT, updated_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS bans (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, value TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL, UNIQUE(kind, value))`,
  `CREATE TABLE IF NOT EXISTS tombstones (username_lc TEXT PRIMARY KEY, pw TEXT NOT NULL, reason TEXT NOT NULL, deleted_at INTEGER NOT NULL)`,
];
let schemaReady = null;

async function touchMeta(env, accountId, ip, device) {
  if (!accountId) return;
  await sql(env, [[
    `INSERT INTO account_meta (account_id, last_ip, last_device, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(account_id) DO UPDATE SET
       last_ip = COALESCE(excluded.last_ip, account_meta.last_ip),
       last_device = COALESCE(excluded.last_device, account_meta.last_device),
       updated_at = excluded.updated_at`,
    [accountId, ip || null, device || null, Date.now()],
  ]]);
}

/** Delete impersonation + invalidName* accounts; keep tombstones so next login can show a message. */
async function purgeImpersonators(env) {
  const [r] = await sql(env, [['SELECT id, username, username_lc, pw FROM accounts', []]]);
  for (const row of r.rows || []) {
    const kill = isReservedUsername(row.username) || isReservedUsername(row.username_lc) || isInvalidNameAccount(row.username) || isInvalidNameAccount(row.username_lc);
    if (!kill) continue;
    if (String(row.username_lc).toLowerCase() === OWNER_LC) continue;
    const lc = String(row.username_lc).toLowerCase();
    await sql(env, [
      [`INSERT INTO tombstones (username_lc, pw, reason, deleted_at) VALUES (?,?,?,?)
        ON CONFLICT(username_lc) DO UPDATE SET pw = excluded.pw, reason = excluded.reason, deleted_at = excluded.deleted_at`,
        [lc, row.pw, 'impersonation', Date.now()]],
      [`DELETE FROM sessions WHERE account_id = ?`, [row.id]],
      [`DELETE FROM stats WHERE account_id = ?`, [row.id]],
      [`DELETE FROM account_meta WHERE account_id = ?`, [row.id]],
      [`DELETE FROM accounts WHERE id = ?`, [row.id]],
    ]);
    console.log('[accounts] deleted impersonation account', row.username);
  }
}

const ensureSchema = (env) => (schemaReady ||= (async () => {
  await sql(env, SCHEMA.map((s) => [s]));
  await purgeImpersonators(env);
})().catch((e) => { schemaReady = null; throw e; }));

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
const DUMMY_PW = `pbkdf2$20000$${'00'.repeat(16)}$${'00'.repeat(32)}`;

const tries = new Map();
function limited(ip, max = 12, windowMs = 10 * 60 * 1000) {
  const now = Date.now(), list = (tries.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now); tries.set(ip, list);
  if (tries.size > 500) for (const [k, v] of tries) if (!v.length || now - v[v.length - 1] > windowMs) tries.delete(k);
  return list.length > max;
}

async function newSession(env, id) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32))), now = Date.now();
  await sql(env, [
    [`DELETE FROM sessions WHERE expires_at < ?`, [now]],
    [`INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?,?,?,?)`, [await sha(token), id, now, now + SESSION_MS]],
  ]);
  return token;
}

export async function authToken(env, token) {
  if (!token || token.length < 32 || token.length > 128) return null;
  await ensureSchema(env);
  const [r] = await sql(env, [[
    `SELECT a.id AS id, a.username AS username FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ?`,
    [await sha(token), Date.now()],
  ]]);
  return r.rows[0] || null;
}

async function isBanned(env, { ip, device, username }) {
  const checks = [];
  if (ip && ip !== 'unknown') checks.push(['ip', ip]);
  if (device) checks.push(['device', device]);
  if (username) checks.push(['username', String(username).toLowerCase()]);
  for (const [kind, value] of checks) {
    const [r] = await sql(env, [[`SELECT id, reason FROM bans WHERE kind = ? AND value = ?`, [kind, value]]]);
    if (r.rows[0]) return { kind, value, reason: r.rows[0].reason || 'banned' };
  }
  return null;
}

/** Used by entry.js for guest + logged-in WS joins */
export async function assertNotBanned(env, request, opts = {}) {
  await ensureSchema(env);
  const ip = clientIp(request);
  const device = opts.device || deviceOf(request, opts.body || {});
  const username = opts.username || '';
  if (String(username).toLowerCase() === OWNER_LC) return null;
  return isBanned(env, { ip, device, username });
}

async function requireOwner(env, request) {
  const a = await authToken(env, bearer(request));
  if (!a || String(a.username).toLowerCase() !== OWNER_LC) return null;
  return a;
}

async function deleteAccountById(env, id, { tombstonePw, reason } = {}) {
  if (tombstonePw && reason) {
    const [u] = await sql(env, [[`SELECT username_lc FROM accounts WHERE id = ?`, [id]]]);
    const lc = u.rows[0] && u.rows[0].username_lc;
    if (lc) {
      await sql(env, [[
        `INSERT INTO tombstones (username_lc, pw, reason, deleted_at) VALUES (?,?,?,?)
         ON CONFLICT(username_lc) DO UPDATE SET pw = excluded.pw, reason = excluded.reason, deleted_at = excluded.deleted_at`,
        [String(lc).toLowerCase(), tombstonePw, reason, Date.now()],
      ]]);
    }
  }
  await sql(env, [
    [`DELETE FROM sessions WHERE account_id = ?`, [id]],
    [`DELETE FROM stats WHERE account_id = ?`, [id]],
    [`DELETE FROM account_meta WHERE account_id = ?`, [id]],
    [`DELETE FROM accounts WHERE id = ?`, [id]],
  ]);
}

async function banValue(env, kind, value, reason) {
  if (!value) return;
  await sql(env, [[
    `INSERT INTO bans (kind, value, reason, created_at) VALUES (?,?,?,?)
     ON CONFLICT(kind, value) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at`,
    [kind, value, reason || 'banned', Date.now()],
  ]]);
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
      const ip = clientIp(request);
      if (limited(ip)) return json({ error: 'too_many_attempts' }, 429);
      const b = await bodyOf(request);
      const username = String(b.username || '').trim(), password = String(b.password || '');
      const device = deviceOf(request, b);
      if (!NAME_RE.test(username)) return json({ error: 'bad_username' }, 400);
      if (password.length < 6 || password.length > 128) return json({ error: 'bad_password' }, 400);
      const lc = username.toLowerCase();

      const ban = await isBanned(env, { ip, device, username: lc });
      if (ban) return json({ error: 'banned', reason: ban.reason, kind: ban.kind }, 403);

      if (path.endsWith('/signup')) {
        if (RESERVED.has(lc) || isReservedUsername(username) || isInvalidNameAccount(username)) {
          return json({ error: 'username_taken' }, 409);
        }
        try {
          const rec = await makePw(password, env);
          const [r] = await sql(env, [[`INSERT INTO accounts (username, username_lc, pw, created_at) VALUES (?,?,?,?)`, [username, lc, rec, Date.now()]]]);
          const id = r.lastId;
          await sql(env, [[`INSERT OR IGNORE INTO stats (account_id, updated_at) VALUES (?,?)`, [id, Date.now()]]]);
          await touchMeta(env, id, ip, device);
          return json({ ok: true, token: await newSession(env, id), user: { username } });
        } catch (e) {
          if (/UNIQUE|constraint/i.test(String(e.message))) return json({ error: 'username_taken' }, 409);
          throw e;
        }
      }

      // login — tombstone (deleted for impersonation)
      const [tomb] = await sql(env, [[`SELECT pw, reason FROM tombstones WHERE username_lc = ?`, [lc]]]);
      if (tomb.rows[0]) {
        const okT = await checkPw(password, tomb.rows[0].pw);
        if (okT && tomb.rows[0].reason === 'impersonation') {
          return json({ error: 'account_deleted_impersonation', message: IMPERSONATION_MSG }, 403);
        }
      }

      const [r] = await sql(env, [[`SELECT id, username, pw FROM accounts WHERE username_lc = ?`, [lc]]]);
      const row = r.rows[0];
      const ok = await checkPw(password, row ? row.pw : DUMMY_PW);
      if (!row || !ok) return json({ error: 'bad_login' }, 401);
      if (String(row.username).toLowerCase() !== OWNER_LC) {
        const ban2 = await isBanned(env, { ip, device, username: String(row.username).toLowerCase() });
        if (ban2) return json({ error: 'banned', reason: ban2.reason, kind: ban2.kind }, 403);
      }
      await touchMeta(env, row.id, ip, device);
      return json({ ok: true, token: await newSession(env, row.id), user: { username: row.username } });
    }

    if (path === '/api/auth/me' && request.method === 'GET') {
      const a = await authToken(env, bearer(request));
      if (!a) return json({ error: 'unauthorized' }, 401);
      const ban = await isBanned(env, { ip: clientIp(request), device: deviceOf(request, {}), username: a.username });
      if (ban && String(a.username).toLowerCase() !== OWNER_LC) {
        await sql(env, [[`DELETE FROM sessions WHERE account_id = ?`, [a.id]]]);
        return json({ error: 'banned', reason: ban.reason }, 403);
      }
      await touchMeta(env, a.id, clientIp(request), deviceOf(request, {}));
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
      const run = clampInt(b.run_ms, 5000, 3600000);
      const reflex = clampInt(b.reflex, 0, 3000) || 0, dps = clampInt(b.dps, 0, 3000) || 0;
      const secrets = clampInt(b.secrets, 0, 8) || 0, classified = clampInt(b.classified, 0, 8) || 0;
      await sql(env, [[
        `UPDATE stats SET run_ms = CASE WHEN ?1 IS NOT NULL AND (run_ms IS NULL OR ?1 < run_ms) THEN ?1 ELSE run_ms END, reflex = MAX(reflex, ?2), dps = MAX(dps, ?3), secrets = MAX(secrets, ?4), classified = MAX(classified, ?5), updated_at = ?6 WHERE account_id = ?7`,
        [run, reflex, dps, secrets, classified, Date.now(), a.id],
      ]]);
      return json({ ok: true });
    }

    // ---------- owner moderation ----------
    if (path.startsWith('/api/mod/')) {
      const owner = await requireOwner(env, request);
      if (!owner) return json({ error: 'unauthorized' }, 401);

      if (path === '/api/mod/lookup' && request.method === 'GET') {
        const q = String(url.searchParams.get('username') || '').trim().toLowerCase();
        if (!q) return json({ error: 'bad_username' }, 400);
        const [r] = await sql(env, [[
          `SELECT a.id AS id, a.username AS username, m.last_ip AS lastIp, m.last_device AS lastDevice
           FROM accounts a LEFT JOIN account_meta m ON m.account_id = a.id WHERE a.username_lc = ?`, [q],
        ]]);
        return json({ ok: true, user: r.rows[0] || null });
      }

      if (path === '/api/mod/bans' && request.method === 'GET') {
        const [r] = await sql(env, [[`SELECT id, kind, value, reason, created_at AS createdAt FROM bans ORDER BY id DESC LIMIT 200`, []]]);
        return json({ ok: true, bans: r.rows });
      }

      if (post && path === '/api/mod/ban') {
        const b = await bodyOf(request);
        const reason = String(b.reason || 'banned').slice(0, 200);
        let username = String(b.username || '').trim();
        let ip = String(b.ip || '').trim().slice(0, 64);
        let device = String(b.device || '').trim().slice(0, 80);
        if (username) {
          const lc = username.toLowerCase();
          if (lc === OWNER_LC) return json({ error: 'cannot_ban_owner' }, 403);
          const [r] = await sql(env, [[
            `SELECT a.id AS id, a.username AS username, a.pw AS pw, m.last_ip AS lastIp, m.last_device AS lastDevice
             FROM accounts a LEFT JOIN account_meta m ON m.account_id = a.id WHERE a.username_lc = ?`, [lc],
          ]]);
          const row = r.rows[0];
          if (row) {
            username = row.username;
            if (!ip && row.lastIp) ip = row.lastIp;
            if (!device && row.lastDevice) device = row.lastDevice;
            await banValue(env, 'username', lc, reason);
            await deleteAccountById(env, row.id, {}); // banned: no re-login message needed beyond ban
          } else {
            await banValue(env, 'username', lc, reason);
          }
        }
        if (ip && ip !== 'unknown') await banValue(env, 'ip', ip, reason);
        if (device) await banValue(env, 'device', device, reason);
        if (!username && !ip && !device) return json({ error: 'bad_request' }, 400);
        return json({ ok: true, banned: { username: username || null, ip: ip || null, device: device || null, reason } });
      }

      if (post && path === '/api/mod/delete') {
        const b = await bodyOf(request);
        const username = String(b.username || '').trim();
        if (!NAME_RE.test(username) && !username) return json({ error: 'bad_username' }, 400);
        const lc = username.toLowerCase();
        if (lc === OWNER_LC) return json({ error: 'cannot_ban_owner' }, 403);
        const [r] = await sql(env, [[`SELECT id, pw FROM accounts WHERE username_lc = ?`, [lc]]]);
        if (!r.rows[0]) return json({ error: 'not_found' }, 404);
        await deleteAccountById(env, r.rows[0].id, {});
        return json({ ok: true, deleted: username });
      }

      if (post && path === '/api/mod/unban') {
        const b = await bodyOf(request);
        const kind = String(b.kind || '').trim();
        const value = String(b.value || '').trim();
        if (!['ip', 'device', 'username'].includes(kind) || !value) return json({ error: 'bad_request' }, 400);
        await sql(env, [[`DELETE FROM bans WHERE kind = ? AND value = ?`, [kind, value]]]);
        return json({ ok: true });
      }

      return json({ error: 'not_found' }, 404);
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
