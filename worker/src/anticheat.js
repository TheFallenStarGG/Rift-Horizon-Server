/**
 * Rift Horizon anti-cheat (Cloudflare Worker side).
 *
 *  1. SIGNATURE GATE   /api/ac/status + /api/ac/verify: the client hashes its own files, the worker compares them with
 *                      manifest.js and hands back a signed, short-lived "pass". entry.js refuses /ws joins without a valid
 *                      pass, so a modified client can't enter the lobby or any game.
 *  2. AUTHORITATIVE    installAntiCheat(GameRoom) wraps the room: movement speed / jump / flight, fire rate, magazines +
 *     CHECKS           reload times, pellet counts, hit geometry, bot hits, vehicles, building range, message flooding.
 *  3. ENFORCEMENT      every failed check adds violation points (they decay). Over KICK_VL -> kick.
 *  4. ALERTS           flags, kicks and signature problems are posted to a Discord webhook (rate limited + grouped), and logged to the worker log.
 *
 * Env: AC_SECRET (secret, signs passes) | AC_MODE = off | warn (default: log only) | enforce
 *      AC_WEBHOOK_URL (optional, its own channel; falls back to DISCORD_WEBHOOK_URL / DISCORD_REC_WEBHOOK, the recordings webhook)
 *      AC_AUTOBAN_KICKS (optional number: ban the device after that many kicks in 24 h; uses the Turso database)
 * KEEP the W / MW tables in sync with lib/arsenal.js + lib/pack*.js and with GUNS / MELEE in index.js.
 */
import { BUILDS } from './manifest.js';

const enc = new TextEncoder();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const BOUND = 5990;
const FROZEN = ['countdown', 'intermission', 'ended'];

export const CFG = {
  kickVl: 100, decay: 5,                 // violation points: kick at kickVl, lose `decay` per second
  msgRate: 90, msgBurst: 180,            // messages per second per player (state is ~20/s)
  // ---- movement, m/s (lib/player.js: WALK 5.4, SPRINT 8.4, hop cap 16, slide cap 17.5, weapon move <= 1.08) ----
  walkCap: 10.4,                         // sprint * 1.08 + tolerance: the most anyone can do without hopping / sliding / an ability
  hopCap: 20,                            // bunny hop / slide / blast jump ceiling (17.5 + tolerance)
  slideMin: 12, slideMs: 2800, hopCtxMs: 1400,
  upCap: 17,                             // fastest legit upward speed (blast jump 14.5)
  slope: 1.15,                           // free climb per metre walked (ramps, stairs, hills)
  airCap: 8.5,                           // climb that is NOT explained by walking: jump + double jump + blast jump apex
  slack: 1.8, slackY: 0.8, maxDt: 3,
  vehDefault: 150, vehMul: 1.35, vehSlack: 4,
  vehCaps: { sedan: 42 },                // vehicle type (substring of the vehicle id) -> max speed m/s. Fill the rest from vehicles.js / aircraft.js
  // ---- combat ----
  shotMin: 0.8, shotBurst: 2.5,          // fire-rate token bucket (1 token = one cooldown)
  rlTol: 0.88, rlLead: 100,              // reload must last >= 88% of the real duration
  swapGraceMs: 400, maxRange: 215, hitTol: 2.2, originXZ: 8, originY: 6,
  buildReach: 30, rangedPieceReach: 215,
};

// id: [cooldown s, pellets, max single hit, magazine, (unused), reload s, shell reload [start, per shell, end]?]
const W = {
  vanguard: [0.1, 1, 40, 30, 0, 2.85], stinger: [0.067, 1, 26, 35, 0, 1.95], breacher: [0.9, 8, 24, 6, 0, 0, [0.5, 0.62, 0.6]],
  longbow: [1.2, 1, 200, 4, 0, 3.0], ridgeback: [0.6, 1, 300, 1, 0, 4.0],
  p9: [0.14, 1, 34, 15, 0, 1.5], marshal: [0.5, 1, 75, 6, 0, 3.2], spitfire: [0.06, 1, 18, 20, 0, 1.65],
  cutter: [0.3, 10, 20, 2, 0, 2.4], whisper: [0.9, 1, 130, 1, 0, 2.6],
  hailstorm: [0.085, 1, 30, 75, 0, 4.4], aegis: [0.105, 1, 38, 28, 0, 2.6], spectre: [0.36, 1, 90, 10, 0, 3.1],
  sentinel: [0.18, 1, 56, 20, 0, 2.9], gale: [0.6, 7, 17, 6, 0, 0, [0.45, 0.5, 0.5]],
  cinder: [0.35, 1, 55, 8, 0, 1.9], lifeline: [0.16, 1, 36, 12, 0, 1.6], wisp: [0.075, 1, 22, 24, 0, 1.7],
  snare: [0.3, 1, 60, 7, 0, 2.0], beacon: [0.22, 1, 44, 10, 0, 1.8],
};
// melee id: [cooldown s, max hit, throw cooldown s]
const MW = {
  fists: [0.34, 28], knife: [0.42, 200], machete: [0.7, 65], tomahawk: [0.5, 120, 3.5], sledge: [1.1, 100],
  katana: [0.34, 55], maul: [1.0, 90], hookblade: [0.4, 48], rapier: [0.4, 50], riftblade: [0.62, 68],
};
// Movement abilities. The current client doesn't tell the server about them, so the worker "explains" a burst of movement
// with a READY ability from the player's loadout (one use per cooldown). w: the weapon that carries it.
const MOVE_AB = {
  dash: { w: 'wisp', cd: 7000, tp: 11, ms: 500 },
  blink: { w: 'katana', cd: 9000, tp: 10, ms: 900 },
  blast: { w: 'gale', cd: 10000, hop: 1700 },
  grapple: { w: 'hookblade', cd: 8000, h: 28, up: 30, air: 36, ms: 1000 },
  recall: { w: 'beacon', cd: 14000, tp: 520, ms: 1500 },
};
const MOVE_ORDER = ['dash', 'blink', 'blast', 'grapple', 'recall'];
const KNOWN = new Set(['state', 'shoot', 'melee', 'ability', 'ahit', 'loadout', 'build', 'bdmg', 'bot_order', 'bot_hit', 'bot_leader_hit',
  'bot_team_wipe', 'bot_leader_spawn', 'veh_claim', 'veh', 'veh_exit', 'respawn', 'chat']);

// ---------- config helpers ----------
export const acMode = (env) => { const m = String((env && env.AC_MODE) || 'warn').toLowerCase(); return m === 'off' || m === 'enforce' ? m : 'warn'; };
/** join gate: 'enforce' only when it can actually work (secret + at least one build in manifest.js), else it falls back to 'warn' */
export const gateMode = (env) => {
  const m = acMode(env);
  if (m === 'enforce' && !(env.AC_SECRET && Object.keys(BUILDS).length)) { console.error('[ac] AC_MODE=enforce but AC_SECRET or manifest.js is missing: running in warn mode'); return 'warn'; }
  return m;
};

// ================================================================== signature gate
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });
const PASS_MS = 30 * 60 * 1000;

const b64u = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const hmacKey = (env, use) => crypto.subtle.importKey('raw', enc.encode(String(env.AC_SECRET)), { name: 'HMAC', hash: 'SHA-256' }, false, [use]);

async function signPass(env, p) {
  const body = b64u(enc.encode(JSON.stringify(p)));
  return body + '.' + b64u(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env, 'sign'), enc.encode(body))));
}
/** validates a pass for this device. -> { ok, reason?, build? } */
export async function checkPass(env, token, did) {
  if (!env.AC_SECRET) return { ok: false, reason: 'not_configured' };
  const t = String(token || '');
  const [body, sig] = t.split('.');
  if (!body || !sig || t.length > 600) return { ok: false, reason: 'missing' };
  let good = false;
  try { good = await crypto.subtle.verify('HMAC', await hmacKey(env, 'verify'), unb64u(sig), enc.encode(body)); } catch (_) { /* bad base64 */ }
  if (!good) return { ok: false, reason: 'bad_signature' };
  let p;
  try { p = JSON.parse(new TextDecoder().decode(unb64u(body))); } catch (_) { return { ok: false, reason: 'bad_signature' }; }
  if (!p || !(p.e > Date.now())) return { ok: false, reason: 'expired' };
  if (!did || p.d !== did) return { ok: false, reason: 'wrong_device' };
  if (!BUILDS[p.b]) return { ok: false, reason: 'build_retired' };
  return { ok: true, build: p.b };
}

function compare(hashes) {
  let best = null;
  for (const [id, files] of Object.entries(BUILDS)) {
    const bad = [];
    for (const [path, h] of Object.entries(files)) if (hashes[path] !== h) bad.push(path);
    if (!bad.length) return { build: id, bad };
    if (!best || bad.length < best.bad.length) best = { build: id, bad };
  }
  return best || { build: null, bad: [] };
}
const allFiles = () => [...new Set(Object.values(BUILDS).flatMap((f) => Object.keys(f)))];

const tries = new Map();
const limited = (ip, max = 40, win = 10 * 60 * 1000) => {
  const now = Date.now(), list = (tries.get(ip) || []).filter((t) => now - t < win);
  list.push(now); tries.set(ip, list);
  if (tries.size > 500) for (const [k, v] of tries) if (!v.length || now - v[v.length - 1] > win) tries.delete(k);
  return list.length > max;
};

/** /api/ac/status (GET) and /api/ac/verify (POST) */
export async function handleAcApi(request, env, url, ctx) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const mode = gateMode(env);
  if (url.pathname === '/api/ac/status') return json({ mode, builds: Object.keys(BUILDS), files: mode === 'off' ? [] : allFiles() });
  if (url.pathname === '/api/ac/verify' && request.method === 'POST') {
    if (mode === 'off') return json({ ok: true, mode });
    if (!env.AC_SECRET) return json({ error: 'not_configured' }, 503);
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    if (limited(ip)) return json({ error: 'too_many_attempts' }, 429);
    let b;
    try { const t = await request.text(); if (t.length > 60000) throw new Error('big'); b = JSON.parse(t); } catch (_) { return json({ error: 'bad_request' }, 400); }
    const did = String((b && b.did) || '').slice(0, 80);
    const hashes = b && typeof b.hashes === 'object' && b.hashes ? b.hashes : null;
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(did) || !hashes) return json({ error: 'bad_request' }, 400);
    const clean = {};
    for (const [k, v] of Object.entries(hashes).slice(0, 600)) if (typeof v === 'string' && /^([0-9a-f]{64}|missing)$/.test(v)) clean[k] = v;
    const r = compare(clean);
    if (r.bad.length) {
      console.warn('[ac] signature mismatch', did, r.build, r.bad.slice(0, 8).join(','));
      if (once('sig:' + did, 10 * 60 * 1000)) {
        notify(env, ctx, { kind: 'signature', title: mode === 'enforce' ? '🧩 Modified files: join blocked' : '🧩 File signature mismatch (warn mode, allowed in)',
          detail: r.bad.slice(0, 8).join('\n'), fields: [['Device', did], ['Closest build', r.build], ['Files differing', r.bad.length]] });
      }
    }
    if (r.bad.length && mode === 'enforce') return json({ ok: false, error: 'modified', bad: r.bad.slice(0, 8) }, 403);
    const exp = Date.now() + PASS_MS;
    return json({ ok: true, warn: r.bad.length > 0, token: await signPass(env, { b: r.build || 'warn', d: did, e: exp }), exp });
  }
  return json({ error: 'not_found' }, 404);
}

// ================================================================== alerts (Discord webhook)
const hookUrl = (env) => {
  const h = env.AC_WEBHOOK_URL || env.DISCORD_WEBHOOK_URL || env.DISCORD_REC_WEBHOOK || '';
  return /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//i.test(h) ? h : '';
};
const COLORS = { flag: 0xf1c40f, kick: 0xe74c3c, ban: 0x992d22, signature: 0x9b59b6, join: 0x95a5a6 };
const hookState = { until: 0, n: 0, at: 0 };
const clip = (v, n = 200) => String(v == null ? '' : v).slice(0, n) || '-';

/** posts one embed to the webhook. Never throws. Soft cap 20 / minute (kicks and bans 40), and it backs off when Discord says 429. ctx: anything with waitUntil */
export function notify(env, ctx, ev) {
  const hook = hookUrl(env), now = Date.now();
  if (!hook || now < hookState.until) return;
  if (now - hookState.at > 60000) { hookState.at = now; hookState.n = 0; }
  if (hookState.n >= (ev.kind === 'kick' || ev.kind === 'ban' ? 40 : 20)) return;
  hookState.n++;
  const fields = (ev.fields || []).filter(([, v]) => v !== undefined && v !== '').slice(0, 10).map(([name, value]) => ({ name, value: clip(value), inline: true }));
  const body = {
    username: 'Anti-Cheat', allowed_mentions: { parse: [] },
    embeds: [{ title: clip(ev.title, 250), description: ev.detail ? clip(ev.detail, 800) : undefined, color: COLORS[ev.kind] || COLORS.flag, fields, timestamp: new Date(now).toISOString() }],
  };
  const p = fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => { if (r.status === 429) { let s = 5; try { s = Number((await r.json()).retry_after) || 5; } catch (_) { /* default */ } hookState.until = Date.now() + s * 1000; } })
    .catch((e) => console.error('[ac] webhook failed', e && e.message));
  try { ctx.waitUntil(p); } catch (_) { /* no ctx: the fetch still runs */ }
}

/** "once per window per key" for the join / signature alerts (a player retrying must not spam the channel) */
const seen = new Map();
function once(key, ms) {
  const now = Date.now();
  if ((seen.get(key) || 0) > now) return false;
  if (seen.size > 500) for (const [k, v] of seen) if (v < now) seen.delete(k);
  seen.set(key, now + ms);
  return true;
}
/** entry.js: someone joined without a valid pass (warn mode lets them in, enforce mode refused them) */
export function notifyJoin(env, ctx, did, reason, blocked) {
  if (!once('join:' + did, 30 * 60 * 1000)) return;
  notify(env, ctx, { kind: 'join', title: blocked ? '🚫 Join refused: no valid pass' : 'Joined without a valid pass (warn mode)', fields: [['Device', did], ['Reason', reason]] });
}

const playerFields = (room, s) => [['Player', s.name], ['Account', s.aid ? 'logged in' : 'guest'], ['Device', s.did], ['Mode', room.mode], ['Violation', Math.round(s.ac.vl)]];

// optional auto-ban: only used when AC_AUTOBAN_KICKS is set. It needs the Turso database (same one accounts.js uses) to count kicks.
async function tsql(env, stmts) {
  const base = String(env.TURSO_DATABASE_URL || '').trim().replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
  if (!base || !env.TURSO_AUTH_TOKEN) return null;
  const arg = (v) => (v == null ? { type: 'null' } : typeof v === 'number' ? { type: 'integer', value: String(Math.round(v)) } : { type: 'text', value: String(v) });
  const requests = stmts.map(([q, a]) => ({ type: 'execute', stmt: { sql: q, args: (a || []).map(arg) } }));
  requests.push({ type: 'close' });
  const res = await fetch(base + '/v2/pipeline', {
    method: 'POST', headers: { Authorization: 'Bearer ' + env.TURSO_AUTH_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error('db_http_' + res.status);
  const j = await res.json();
  return stmts.map((_, i) => {
    const r = j.results[i];
    if (!r || r.type !== 'ok') throw new Error((r && r.error && r.error.message) || 'sql_error');
    return r.response.result.rows;
  });
}
async function autoBan(room, s) {
  const n = parseInt(room.env.AC_AUTOBAN_KICKS, 10) || 0;
  if (n <= 0 || !s.did) return;
  const now = Date.now();
  const ok = await tsql(room.env, [
    [`CREATE TABLE IF NOT EXISTS ac_kicks (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, device TEXT NOT NULL)`],
    [`CREATE TABLE IF NOT EXISTS bans (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, value TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL, UNIQUE(kind, value))`],
    [`INSERT INTO ac_kicks (at, device) VALUES (?, ?)`, [now, s.did]],
  ]);
  if (!ok) return;
  const [r] = await tsql(room.env, [[`SELECT COUNT(*) FROM ac_kicks WHERE device = ? AND at > ?`, [s.did, now - 24 * 3600 * 1000]]]);
  if (Number(r[0][0].value) < n) return;
  const ban = (kind, value) => [`INSERT INTO bans (kind, value, reason, created_at) VALUES (?,?,?,?) ON CONFLICT(kind, value) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at`, [kind, value, 'anticheat', now]];
  const stmts = [ban('device', s.did)];
  if (s.aid && s.name) stmts.push(ban('username', String(s.name).toLowerCase()));
  await tsql(room.env, stmts);
  notify(room.env, room.state, { kind: 'ban', title: '⛔ Auto-banned', detail: `${n} anti-cheat kicks in 24 hours`, fields: playerFields(room, s) });
}

// ================================================================== per-player state
const newAc = (now) => ({
  vl: 0, vlAt: now, kicked: false, exempt: false, bucket: CFG.msgBurst, bucketAt: now, flagged: 0,
  mvAt: now, bankH: CFG.slack, bankV: CFG.slackY, speed: 0, crouch: false, up: false, upY: 0, peakY: 0, hopUntil: 0, slideUntil: 0, slideCap: 0,
  boostUntil: 0, boostH: 0, boostUp: 0, tp: 0, tpUntil: 0, air: CFG.airCap, airCap: CFG.airCap, abReady: {}, overUntil: 0,
  wpn: '', wpnAt: 0, shotCredit: 1, shotAt: now, meleeCredit: 1, meleeAt: now, throwAt: 0, ammo: {}, rl: null,
  botTok: 12, botAt: now, vp: null, times: {}, alerts: {}, wouldAt: 0,
});
const acOf = (s) => s.ac || (s.ac = newAc(Date.now()));
/** new life / spawn: movement baseline + full magazines (the client restocks on every respawn) */
function resetLife(ac, now) {
  ac.mvAt = now; ac.speed = 0; ac.bankH = CFG.slack; ac.bankV = CFG.slackY; ac.up = false; ac.hopUntil = ac.slideUntil = ac.boostUntil = ac.tpUntil = 0; ac.tp = 0;
  ac.air = ac.airCap = CFG.airCap; ac.ammo = {}; ac.rl = null; ac.shotCredit = 1; ac.shotAt = now; ac.vp = null; ac.overUntil = 0; ac.abReady = {};
}

function flag(room, s, check, w, detail) {
  const ac = s.ac, now = Date.now();
  ac.vl = Math.max(0, ac.vl - ((now - ac.vlAt) / 1000) * CFG.decay) + w;
  ac.vlAt = now; ac.flagged++;
  console.warn('[ac]', JSON.stringify({ room: room.mode, name: s.name, did: s.did, check, vl: Math.round(ac.vl), detail: detail || '' }));
  // one alert per player + check per minute, with a count of what was held back
  const al = ac.alerts[check] || (ac.alerts[check] = { at: 0, n: 0 });
  al.n++;
  if (now - al.at >= 60000) {
    const more = al.n - 1;
    al.at = now; al.n = 0;
    notify(room.env, room.state, { kind: 'flag', title: '⚠️ ' + check, detail: (detail || '') + (more ? ` (+${more} more since the last alert)` : ''), fields: playerFields(room, s) });
  }
  if (ac.vl >= CFG.kickVl) {
    if (String(room.env.AC_MODE || '').toLowerCase() === 'enforce') kick(room, s, check, detail);
    else if (now - ac.wouldAt > 120000) { // warn mode: tell the owner what enforce mode would have done
      ac.wouldAt = now;
      notify(room.env, room.state, { kind: 'kick', title: '🔨 Would be kicked (warn mode): ' + check, detail, fields: playerFields(room, s) });
    }
  }
}
function kick(room, s, check, detail) {
  const ac = s.ac;
  if (ac.kicked) return;
  ac.kicked = true;
  room.send(s.ws, { type: 'kicked', reason: 'anticheat' });
  try { s.ws.close(4001, 'anticheat'); } catch (_) { /* already closed */ }
  notify(room.env, room.state, { kind: 'kick', title: '🔨 Kicked: ' + check, detail, fields: playerFields(room, s) });
  const p = autoBan(room, s).catch((e) => console.error('[ac] auto-ban failed', e && e.message));
  try { room.state.waitUntil(p); } catch (_) { /* not in a DO */ }
}
/** simple per-type rate limiter. true = allowed */
function every(ac, key, now, gapMs, count = 1, winMs = 0) {
  if (!winMs) { if (now - (ac.times[key] || 0) < gapMs) return false; ac.times[key] = now; return true; }
  const l = (ac.times[key] || []).filter((t) => now - t < winMs);
  if (l.length >= count) { ac.times[key] = l; return false; }
  l.push(now); ac.times[key] = l;
  return true;
}

// ================================================================== movement
function vehCap(id) {
  const k = String(id).toLowerCase();
  for (const [t, v] of Object.entries(CFG.vehCaps)) if (k.includes(t)) return v * CFG.vehMul + CFG.vehSlack;
  return CFG.vehDefault;
}
function limits(ac, crouch, now, veh) {
  let h = CFG.walkCap, up = CFG.upCap;
  if (now < ac.hopUntil) h = CFG.hopCap;
  if (crouch && now < ac.slideUntil) h = Math.max(h, ac.slideCap);
  if (now < ac.boostUntil) { h = Math.max(h, ac.boostH); up = Math.max(up, ac.boostUp); }
  if (veh) h = veh;
  return { h, up };
}
function applyEffect(ac, ab, now) {
  const m = MOVE_AB[ab];
  if (!m) return;
  if (m.tp) { ac.tp += m.tp; ac.tpUntil = now + m.ms; }
  if (m.hop) ac.hopUntil = Math.max(ac.hopUntil, now + m.hop);
  if (m.h) { ac.boostUntil = now + m.ms; ac.boostH = m.h; ac.boostUp = m.up; }
  if (m.air) ac.air = ac.airCap + m.air;
  if (ab === 'recall') ac.air = ac.airCap;
  ac.abReady[ab] = now + m.cd * 0.85;
}
/** a movement burst that normal movement can't explain: is there a ready ability in the loadout that covers it? */
function explainWithAbility(s, ac, now, hd, dy, dt, L) {
  for (const ab of MOVE_ORDER) {
    const m = MOVE_AB[ab];
    if (!s.lo.includes(m.w) || now < (ac.abReady[ab] || 0)) continue;
    const h = Math.max(L.h, m.h || 0, m.hop ? CFG.hopCap : 0), up = Math.max(L.up, m.up || 0), tp = ac.tp + (m.tp || 0);
    if (hd <= Math.min(CFG.slack + h * 0.25, ac.bankH + h * dt) + tp && dy <= Math.min(CFG.slackY + up * 0.15, ac.bankV + up * dt) + tp) { applyEffect(ac, ab, now); return true; }
  }
  return false;
}

/** validates + clips a position update. returns the accepted { x, y, z } */
function checkMove(room, s, msg, now) {
  const ac = s.ac, social = !!room.cfg.social;
  const dt = clamp((now - ac.mvAt) / 1000, 0.001, CFG.maxDt);
  ac.mvAt = now;
  const crouch = !!msg.crouch;
  const nx = clamp(num(msg.x, s.x), -BOUND, BOUND), nz = clamp(num(msg.z, s.z), -BOUND, BOUND), ny = clamp(num(msg.y, s.y), 0, social ? 500 : 1000);
  let dx = nx - s.x, dz = nz - s.z, dy = ny - s.y, hd = Math.hypot(dx, dz), bad = '';
  if (now > ac.tpUntil) ac.tp = 0;
  const veh = s.vehId ? vehCap(s.vehId) : 0;
  let L = limits(ac, crouch, now, veh);
  if (!veh && (hd > Math.min(CFG.slack + L.h * 0.25, ac.bankH + L.h * dt) + ac.tp || dy > Math.min(CFG.slackY + L.up * 0.15, ac.bankV + L.up * dt) + ac.tp) && explainWithAbility(s, ac, now, hd, dy, dt, L)) L = limits(ac, crouch, now, veh);

  // allowance is a small bank (speed * elapsed time, capped) so network bunching is tolerated but the slack can't be farmed every update
  ac.bankH = Math.min(CFG.slack + L.h * 0.25, ac.bankH + L.h * dt);
  const allowH = ac.bankH + ac.tp;
  if (hd > allowH) { bad = `speed ${(hd / dt).toFixed(1)} m/s (cap ${L.h})`; const k = allowH / hd; dx *= k; dz *= k; hd = allowH; }
  { const used = Math.min(hd, ac.bankH); ac.bankH -= used; ac.tp = Math.max(0, ac.tp - (hd - used)); }

  if (!veh) {
    ac.bankV = Math.min(CFG.slackY + L.up * 0.15, ac.bankV + L.up * dt);
    if (dy > ac.bankV + ac.tp) { bad = bad || `rise ${(dy / dt).toFixed(1)} m/s (cap ${L.up})`; dy = ac.bankV + ac.tp; }
    if (dy > 0) ac.bankV = Math.max(0, ac.bankV - dy);
    if (ac.tp <= 0) {
      if (dy > 0) { // climbing that walking up a slope doesn't explain must come out of the jump budget (flight / super jump)
        const need = Math.max(0, dy - CFG.slope * hd);
        if (need > ac.air) { bad = bad || `climb +${dy.toFixed(1)} m, budget ${ac.air.toFixed(1)}`; dy = CFG.slope * hd + ac.air; ac.air = 0; } else ac.air -= need;
      } else if (dy < 0 && ac.air < ac.airCap) ac.air = Math.min(ac.airCap, ac.air - dy);
    } else ac.air = ac.airCap;
  } else ac.air = ac.airCap;

  // hop context: an arc (rise >= 0.5 m, then descent) means the player is jumping, which unlocks the higher speed cap for a moment
  if (dy > 0.02) { if (!ac.up) { ac.up = true; ac.upY = s.y; } ac.peakY = s.y + dy; }
  else if (dy < -0.02 && ac.up) { ac.up = false; if (ac.peakY - ac.upY >= 0.5 && ac.peakY - ac.upY <= 14) ac.hopUntil = now + CFG.hopCtxMs; }
  // slide: crouching while already moving fast
  if (crouch && !ac.crouch && ac.speed >= 5) { ac.slideUntil = now + CFG.slideMs; ac.slideCap = clamp(ac.speed * 1.15 + 1.2, CFG.slideMin, CFG.hopCap); }
  ac.crouch = crouch;
  if (dt >= 0.02) ac.speed = ac.speed * 0.6 + (hd / dt) * 0.4;

  if (bad) flag(room, s, veh ? 'vehicle_move' : 'move', 5, bad);
  return { x: s.x + dx, y: s.y + dy, z: s.z + dz };
}

// ================================================================== reloads / magazines
const AM = (ac, id) => ac.ammo[id] || (ac.ammo[id] = { mag: W[id][3] });
function settle(ac, now) {
  const r = ac.rl;
  if (!r) return;
  const a = AM(ac, r.id);
  if (r.shells) {
    const el = (now - r.t0) / 1000 / CFG.rlTol;
    const n = clamp(Math.floor((el - r.sh[0]) / r.sh[1]), 0, r.missing);
    if (n > r.done) { a.mag += n - r.done; r.done = n; }
    if (r.done >= r.missing) ac.rl = null;
  } else if (now >= r.end) { a.mag += r.missing; ac.rl = null; }
}
function startReload(ac, id, now) {
  const w = W[id];
  if (!w || ac.rl) return;
  const a = AM(ac, id), missing = w[3] - a.mag;
  if (missing <= 0) return;
  const sh = w[6], dur = sh ? sh[0] + missing * sh[1] + sh[2] : w[5];
  ac.rl = { id, t0: now - CFG.rlLead, end: now - CFG.rlLead + dur * 1000 * CFG.rlTol, missing, sh, shells: !!sh, done: 0 };
}
function trackReload(room, s, msg, now) {
  if (room.cfg.botArena) return;
  const ac = s.ac;
  settle(ac, now);
  if (ac.rl && ac.rl.id !== ac.wpn) ac.rl = null; // swapped away mid-reload
  if (msg.rl && !ac.rl && W[ac.wpn]) startReload(ac, ac.wpn, now);
  else if (!msg.rl && ac.rl && now < ac.rl.end && !ac.rl.shells) ac.rl = null; // cancelled
}

// ================================================================== combat
function cleanHits(room, s, msg, w) {
  const hits = Array.isArray(msg.hits) ? msg.hits.slice(0, 12) : [];
  if (!hits.length) return [];
  const claimed = hits.reduce((n, h) => n + clamp(Math.round(num(h && h.n, 1)), 1, 99), 0);
  if (claimed > w[1]) flag(room, s, 'pellets', 15, `${claimed} pellets claimed, gun has ${w[1]}`);
  const o = { x: num(msg.ox), y: num(msg.oy), z: num(msg.oz) };
  let d = { x: num(msg.dx), y: num(msg.dy), z: num(msg.dz) };
  const dl = Math.hypot(d.x, d.y, d.z);
  if (!(dl > 0.8 && dl < 1.25) || Math.hypot(o.x - s.x, o.z - s.z) > CFG.originXZ || Math.abs(o.y - (s.y + 1.6)) > CFG.originY) {
    flag(room, s, 'hit_origin', 6, 'shot origin / direction does not match the player');
    return [];
  }
  d = { x: d.x / dl, y: d.y / dl, z: d.z / dl };
  const out = [];
  let left = w[1], bad = 0;
  for (const h of hits) {
    if (left <= 0) break;
    const t = room.sessions.get(h && h.id);
    if (!t || t === s || !t.alive) continue;
    const n = clamp(Math.round(num(h.n, 1)), 1, left);
    const wx = t.x - o.x, wy = t.y + 1.1 - o.y, wz = t.z - o.z, dist = Math.hypot(wx, wy, wz), along = wx * d.x + wy * d.y + wz * d.z;
    const perp = Math.sqrt(Math.max(0, dist * dist - along * along)), tol = CFG.hitTol + 0.05 * dist + (w[1] > 1 ? 0.12 * dist : 0);
    if (along < -1 || dist > CFG.maxRange || perp > tol) { bad++; continue; }
    out.push({ id: t.id, zone: h.zone, n });
    left -= n;
  }
  if (bad) flag(room, s, 'hit_geometry', Math.min(3, bad) * 2, `${bad} hit(s) not along the shot ray`);
  return out;
}

function onShoot(room, s, msg, now, enforce) {
  const ac = s.ac, id = String(msg.weapon || ''), w = W[id];
  if (!w || !s.alive) return true; // index.js drops these itself
  const lot = msg.lottery === true && id === 'ridgeback' && !s.lotUsed;
  if (!lot) {
    if (!s.lo.includes(id)) return true;
    if (ac.wpn && ac.wpn !== id && now - ac.wpnAt > CFG.swapGraceMs) { flag(room, s, 'weapon', 2, `shot ${id} while holding ${ac.wpn}`); if (enforce) return false; }
    let over = (s.fx && s.fx.overUntil > now) || ac.overUntil > now;
    ac.shotCredit = Math.min(CFG.shotBurst, ac.shotCredit + (now - ac.shotAt) / (w[0] * 1000 * (over ? 0.6 : 1)));
    ac.shotAt = now;
    if (ac.shotCredit < CFG.shotMin) {
      if (id === 'hailstorm' && !over && now >= (ac.abReady.overdrive || 0)) { // Overdrive: 0.6x cooldown, no ammo, 4.5 s
        ac.overUntil = now + 4800; ac.abReady.overdrive = now + 22000 * 0.85; over = true; ac.shotCredit = 1;
      } else { flag(room, s, 'fire_rate', 3, `${id} fired too fast`); if (enforce) return false; ac.shotCredit = 0.8; }
    }
    ac.shotCredit -= 1;
    if (!room.cfg.botArena) { // bot arena refills ammo from client-side boss kills, so magazines are only tracked in PvP modes
      settle(ac, now);
      const a = AM(ac, id), r = ac.rl;
      if (r && r.id === id && !r.shells && now < r.end) { flag(room, s, 'reload', 4, `${id} fired during reload`); if (enforce) return false; }
      else if (r && r.id === id && r.shells) ac.rl = null; // firing interrupts a shell reload (keeps the shells loaded so far)
      if (!over) {
        if (a.mag <= 0) { flag(room, s, 'ammo', 6, `${id} fired with an empty magazine`); if (enforce) return false; }
        else a.mag--;
        if (a.mag <= 0) startReload(ac, id, now);
      }
    }
    s.lastShot = 0; // our token bucket is the cooldown authority (index.js would double-check at 0.55x)
  }
  const hits = cleanHits(room, s, msg, w);
  if (enforce) msg.hits = hits;
  return true;
}

function onMelee(room, s, msg, now, enforce) {
  const ac = s.ac, m = MW[msg.weapon];
  if (!m || !s.alive || !s.lo.includes(msg.weapon)) return true;
  if (!!msg.thrown && m[2]) {
    if (now - ac.throwAt < m[2] * 850) { flag(room, s, 'melee_rate', 3, 'throw cooldown'); if (enforce) return false; } else ac.throwAt = now;
    s.lastThrow = 0;
  } else {
    ac.meleeCredit = Math.min(2.5, ac.meleeCredit + (now - ac.meleeAt) / (m[0] * 1000)); ac.meleeAt = now;
    if (ac.meleeCredit < CFG.shotMin) { flag(room, s, 'melee_rate', 3, `${msg.weapon} swung too fast`); if (enforce) return false; ac.meleeCredit = 0.8; }
    ac.meleeCredit -= 1;
    s.lastMelee = 0;
  }
  return true;
}

function onBotHit(room, s, msg, now, enforce) {
  if (!room.cfg.botArena) return true;
  const ac = s.ac;
  let rate = 0, maxHit = 0;
  for (const id of s.lo) {
    if (W[id]) { rate = Math.max(rate, W[id][1] / (W[id][0] * 0.6)); maxHit = Math.max(maxHit, W[id][2]); }
    else if (MW[id]) { rate = Math.max(rate, 1 / (MW[id][0] * 0.6)); maxHit = Math.max(maxHit, MW[id][1]); }
  }
  ac.botTok = Math.min(14, ac.botTok + ((now - ac.botAt) / 1000) * rate); ac.botAt = now;
  if (ac.botTok < 1) { flag(room, s, 'bot_hit_rate', 3, 'more bot hits than the loadout can fire'); return !enforce; }
  ac.botTok -= 1;
  const b = room.bots.find((x) => x.id === msg.id);
  if (b && Math.hypot(b.x - s.x, b.z - s.z) > CFG.maxRange) { flag(room, s, 'bot_hit_range', 3, 'bot out of range'); return !enforce; }
  if (num(msg.dmg, 10) > maxHit) { flag(room, s, 'bot_hit_dmg', 3, `dmg ${msg.dmg} > ${maxHit}`); if (enforce) msg.dmg = maxHit; }
  return true;
}

function onBuild(room, s, msg, now, enforce) {
  const sp = msg.spec;
  if (msg.type === 'build' && sp && Math.hypot(num(sp.ix) * 4 - s.x, num(sp.iz) * 4 - s.z) > CFG.buildReach) {
    flag(room, s, 'build_reach', 3, 'piece placed out of reach');
    return !enforce;
  }
  if (msg.type === 'bdmg') {
    const p = String(msg.key || '').split(':'); // type:ix:iz:lv:o
    if (!MW[msg.weapon] && Math.hypot(num(p[1]) * 4 - s.x, num(p[2]) * 4 - s.z) > CFG.rangedPieceReach) { flag(room, s, 'build_reach', 3, 'piece damaged from too far'); return !enforce; }
  }
  return true;
}

// ================================================================== install
export function installAntiCheat(GameRoom) {
  const P = GameRoom.prototype;

  const handleSession = P.handleSession;
  P.handleSession = function (ws, name, params) {
    handleSession.call(this, ws, name, params);
    let s = null;
    for (const x of this.sessions.values()) if (x.ws === ws) { s = x; break; }
    if (!s) return;
    acOf(s).exempt = params.get('acx') === '1'; // entry.js sets this only for the verified owner account
    s.did = String(params.get('did') || '').slice(0, 80);
  };

  const placePlayer = P.placePlayer;
  P.placePlayer = function (s, notify, ms) {
    placePlayer.call(this, s, notify, ms);
    resetLife(acOf(s), Date.now());
  };

  // ability messages (if the client sends them) also open the matching movement / overdrive window
  const onAbility = P.onAbility;
  if (onAbility) {
    P.onAbility = function (s, msg, now) {
      const ab = String((msg && msg.ability) || ''), before = s.cdUntil && s.cdUntil[ab];
      onAbility.call(this, s, msg, now);
      if (!s.cdUntil || s.cdUntil[ab] === before) return;
      const ac = acOf(s);
      if (MOVE_AB[ab]) applyEffect(ac, ab, now);
      else if (ab === 'overdrive') { ac.overUntil = now + 4800; ac.abReady.overdrive = now + 22000 * 0.85; }
    };
  }

  const onMessage = P.onMessage;
  P.onMessage = function (s, msg) {
    if (!msg || typeof msg.type !== 'string') return;
    const ac = acOf(s), mode = acMode(this.env);
    if (ac.kicked) return;
    if (ac.exempt || mode === 'off') return onMessage.call(this, s, msg);
    const enforce = mode === 'enforce', now = Date.now();
    ac.bucket = Math.min(CFG.msgBurst, ac.bucket + ((now - ac.bucketAt) / 1000) * CFG.msgRate); ac.bucketAt = now;
    if (ac.bucket < 1) { flag(this, s, 'flood', 1, msg.type); if (enforce) return; } else ac.bucket -= 1;
    if (!KNOWN.has(msg.type)) return; // index.js ignores unknown types anyway
    let ok = true;
    try {
      switch (msg.type) {
        case 'state':
          if (FROZEN.includes(this.phase) || !s.alive) { ac.mvAt = now; break; } // index.js ignores the position now
          if (typeof msg.weapon === 'string' && s.lo.includes(msg.weapon) && msg.weapon !== ac.wpn) { ac.wpn = msg.weapon; ac.wpnAt = now; }
          trackReload(this, s, msg, now);
          { const r = checkMove(this, s, msg, now); if (enforce) { msg.x = r.x; msg.y = r.y; msg.z = r.z; } }
          break;
        case 'shoot': ok = onShoot(this, s, msg, now, enforce); break;
        case 'melee': ok = onMelee(this, s, msg, now, enforce); break;
        case 'bot_hit': ok = onBotHit(this, s, msg, now, enforce); break;
        case 'build': case 'bdmg': ok = onBuild(this, s, msg, now, enforce); break;
        case 'chat': ok = every(ac, 'chat', now, 0, 4, 6000); break;
        case 'loadout': {
          if (!every(ac, 'loadout', now, 0, 6, 10000)) { ok = false; break; }
          const prev = s.lo.slice();
          onMessage.call(this, s, msg);
          s.lo.forEach((id, i) => { if (id !== prev[i]) delete ac.ammo[id]; }); // the client restocks a slot when its weapon changes
          if (ac.rl && !s.lo.includes(ac.rl.id)) ac.rl = null;
          return;
        }
        case 'bot_order': case 'bot_leader_hit': ok = every(ac, msg.type, now, 0, 8, 1000); break;
        case 'bot_team_wipe': case 'bot_leader_spawn': ok = every(ac, msg.type, now, 1500); break;
        default: break;
      }
    } catch (e) { console.error('[ac] check failed', e && e.stack); ok = true; } // a bug here must never block play
    if (ok || !enforce) return onMessage.call(this, s, msg);
  };

  // vehicles: speed + teleport checks on the owner's updates
  const vehClaim = P.vehClaim, vehState = P.vehState, vehExit = P.vehExit;
  P.vehClaim = function (s, msg) { acOf(s).vp = null; return vehClaim.call(this, s, msg); };
  P.vehState = function (s, msg) {
    const ac = acOf(s);
    if (ac.exempt || ac.kicked || acMode(this.env) === 'off') return vehState.call(this, s, msg);
    const enforce = acMode(this.env) === 'enforce', now = Date.now(), id = String(msg.id ?? s.vehId ?? '');
    const x = num(msg.x), y = num(msg.y), z = num(msg.z), cap = vehCap(id);
    if (!ac.vp || ac.vp.id !== id) {
      if (Math.hypot(x - s.x, z - s.z) > 120 && ac.vp !== null) { flag(this, s, 'vehicle_teleport', 8, 'vehicle far from its driver'); if (enforce) return; }
      ac.vp = { id, x, y, z, at: now };
    } else {
      const dt = clamp((now - ac.vp.at) / 1000, 0.001, CFG.maxDt), dd = Math.hypot(x - ac.vp.x, y - ac.vp.y, z - ac.vp.z), allow = cap * dt + CFG.slack;
      let nx = x, ny = y, nz = z;
      if (dd > allow) {
        flag(this, s, 'vehicle_move', 5, `vehicle ${(dd / dt).toFixed(0)} m/s (cap ${cap.toFixed(0)})`);
        const k = allow / dd; nx = ac.vp.x + (x - ac.vp.x) * k; ny = ac.vp.y + (y - ac.vp.y) * k; nz = ac.vp.z + (z - ac.vp.z) * k;
        if (enforce) { msg.x = nx; msg.y = ny; msg.z = nz; }
      }
      if (enforce && num(msg.spd) > cap * 1.3) msg.spd = cap;
      ac.vp = { id, x: enforce ? nx : x, y: enforce ? ny : y, z: enforce ? nz : z, at: now };
    }
    return vehState.call(this, s, msg);
  };
  P.vehExit = function (s, msg) {
    const ac = acOf(s);
    ac.vp = null; ac.air = ac.airCap; ac.mvAt = Date.now();
    if (!ac.exempt && acMode(this.env) === 'enforce' && Math.hypot(num(msg.x) - s.x, num(msg.z) - s.z) > 30) { msg.x = s.x; msg.z = s.z; } // no teleporting via the exit message
    return vehExit.call(this, s, msg);
  };
}
