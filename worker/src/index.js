/**
 * Realm Range multiplayer — Cloudflare Worker + Durable Object rooms (class GameRoom, binding ROOM: unchanged).
 * Client: wss://<worker>/ws?room=CODE&name=Player&mode=ffa|duel|team|custom|lobby&lo=main.side.melee
 * The server owns health, damage, kills, rounds, respawns and builds.
 * KEEP the GUNS / MELEE tables in sync with lib/arsenal.js in the client repo.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, service: 'fps-game-server' });

    // Proxy recording upload — try several free hosts (no account / no card)
    if (url.pathname === '/api/rec' && request.method === 'PUT') {
      try {
        let name = (url.searchParams.get('name') || '').replace(/[^a-zA-Z0-9._-]/g, '');
        if (!name || name.length > 80) name = `rec-${Date.now()}.mp4`;
        if (!/\.(mp4|webm)$/i.test(name)) name += '.mp4';
        const buf = await request.arrayBuffer();
        if (!buf.byteLength) return json({ error: 'empty body' }, 400);
        if (buf.byteLength > 1024 * 1024 * 1024) return json({ error: 'file too large (max 1GB)' }, 413);
        const prefer = (url.searchParams.get('host') || 'auto').toLowerCase();
        const type = request.headers.get('Content-Type') || (name.endsWith('.webm') ? 'video/webm' : 'video/mp4');
        const blob = new Blob([buf], { type });
        const errors = [];

        async function tryGofile() {
          const srvRes = await fetch('https://api.gofile.io/servers');
          const srv = await srvRes.json();
          const server = srv?.data?.servers?.[0]?.name;
          if (!server) throw new Error('no gofile server');
          const form = new FormData();
          form.append('file', blob, name);
          const up = await fetch(`https://${server}.gofile.io/uploadFile`, { method: 'POST', body: form });
          const j = await up.json();
          const page = j?.data?.downloadPage || j?.data?.directLink;
          if (!page) throw new Error(JSON.stringify(j).slice(0, 120));
          return { ok: true, url: page, host: 'gofile', expires: '' };
        }

        async function try0x0() {
          const form = new FormData();
          form.append('file', blob, name);
          const up = await fetch('https://0x0.st', { method: 'POST', body: form });
          const text = (await up.text()).trim();
          if (!up.ok || !/^https?:\/\//i.test(text)) throw new Error(text.slice(0, 120) || '0x0 rejected');
          return { ok: true, url: text, host: '0x0', expires: '' };
        }

        async function tryTmpfiles() {
          const form = new FormData();
          form.append('file', blob, name);
          const up = await fetch('https://tmpfiles.org/api/v1/upload', { method: 'POST', body: form });
          const j = await up.json();
          let u = j?.data?.url;
          if (!u) throw new Error(JSON.stringify(j).slice(0, 120));
          u = String(u).replace('http://', 'https://');
          if (/tmpfiles\.org\/\d+\//.test(u)) u = u.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
          return { ok: true, url: u, host: 'tmpfiles', expires: '~1 hour' };
        }

        async function tryFileIo() {
          const form = new FormData();
          form.append('file', blob, name);
          const up = await fetch('https://file.io/?expires=7d', { method: 'POST', body: form });
          const j = await up.json();
          if (!j?.success || !j?.link) throw new Error(JSON.stringify(j).slice(0, 120));
          return { ok: true, url: j.link, host: 'file.io', expires: j.expiry || '7 days' };
        }

        async function tryCatbox(litter) {
          const form = new FormData();
          form.append('reqtype', 'fileupload');
          form.append('fileToUpload', blob, name);
          let endpoint;
          if (litter) {
            form.append('time', '72h');
            endpoint = 'https://litterbox.catbox.moe/resources/internals/api.php';
          } else {
            endpoint = 'https://catbox.moe/user/api.php';
          }
          const up = await fetch(endpoint, { method: 'POST', body: form });
          const text = (await up.text()).trim();
          if (!up.ok || !/^https?:\/\//i.test(text)) throw new Error(text.slice(0, 120) || 'catbox rejected');
          return {
            ok: true,
            url: text,
            host: litter ? 'litterbox' : 'catbox',
            expires: litter ? '72 hours' : '',
          };
        }

        const chain = [];
        // Discord needs a direct media URL that stays online.
        // Rank: catbox > 0x0 > tmpfiles > litterbox (flaky loads / weak embed) > gofile > file.io
        if (prefer === 'catbox') chain.push(['catbox', () => tryCatbox(false)]);
        else if (prefer === '0x0') chain.push(['0x0', try0x0]);
        else if (prefer === 'tmpfiles') chain.push(['tmpfiles', tryTmpfiles]);
        else if (prefer === 'litterbox') chain.push(['litterbox', () => tryCatbox(true)]);
        else if (prefer === 'gofile') chain.push(['gofile', tryGofile]);
        else if (prefer === 'fileio' || prefer === 'file.io') chain.push(['file.io', tryFileIo]);
        else {
          const big = body.byteLength > 200 * 1024 * 1024;
          if (!big) chain.push(['catbox', () => tryCatbox(false)]);
          chain.push(
            ['0x0', try0x0],
            ['tmpfiles', tryTmpfiles],
            ['litterbox', () => tryCatbox(true)],
            ['gofile', tryGofile],
            ['file.io', tryFileIo],
          );
        }

        for (const [label, fn] of chain) {
          try {
            return json(await fn());
          } catch (e) {
            errors.push(label + ': ' + String(e.message || e).slice(0, 80));
          }
        }
        return json({ error: errors.join(' | ') || 'all hosts failed' }, 502);
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
  }

    if (url.pathname === '/ws') {
      const room = (url.searchParams.get('room') || 'lobby').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'lobby';
      return env.ROOM.get(env.ROOM.idFromName(room)).fetch(request);
    }
    if (url.pathname === '/api/create') return json({ room: randomRoom() });
    return json({ error: 'not_found' }, 404);
  },
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors() } });
}
function randomRoom() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ---------- tables ----------
const G = (cd, head, body, limb, extra = {}) => ({ cd, head, body, limb, pellets: 1, fall: null, ...extra });
const GUNS = {
  vanguard: G(0.1, 40, 20, 14),
  stinger: G(0.067, 26, 13, 10, { fall: [12, 28, 0.5] }),
  breacher: G(0.9, 24, 12, 8, { pellets: 8, fall: [6, 20, 0.15] }),
  longbow: G(1.2, 200, 34, 34),
  ridgeback: G(0.6, 300, 300, 300),
  p9: G(0.14, 34, 17, 12, { fall: [20, 50, 0.55] }),
  marshal: G(0.5, 75, 38, 28, { fall: [20, 45, 0.6] }),
  spitfire: G(0.06, 18, 9, 7, { fall: [8, 20, 0.4] }),
  cutter: G(0.3, 20, 10, 7, { pellets: 10, fall: [4, 14, 0.1] }),
  whisper: G(0.9, 130, 75, 55),
};
const MELEE = {
  fists: { front: 18, head: 28, range: 1.7, cd: 0.34 },
  knife: { front: 30, head: 45, back: 200, range: 1.9, cd: 0.42 },
  machete: { front: 45, head: 65, range: 2.2, cd: 0.7, heal: 35 },
  tomahawk: { front: 40, head: 60, thrown: 120, range: 2.0, cd: 0.5, throwRange: 45, throwCd: 3.5 },
  sledge: { front: 80, head: 100, range: 2.5, cd: 1.1, demolish: true },
};
const SLOT_OF = {
  vanguard: 'main', stinger: 'main', breacher: 'main', longbow: 'main', ridgeback: 'main',
  p9: 'side', marshal: 'side', spitfire: 'side', cutter: 'side', whisper: 'side',
  fists: 'melee', knife: 'melee', machete: 'melee', tomahawk: 'melee', sledge: 'melee',
};
const SLOTS = ['main', 'side', 'melee'];
const DEFAULT_LO = ['vanguard', 'p9', 'knife'];

const MODES = {
  bots: { cap: 4, min: 1, teams: false, rounds: false, target: 999999, respawn: 3500, botArena: true },
  ffa: { cap: 8, min: 1, teams: false, rounds: false, target: 20, respawn: 3000 },
  custom: { cap: 12, min: 1, teams: false, rounds: false, target: 30, respawn: 3000 },
  duel: { cap: 2, min: 2, teams: true, rounds: true, win: 3, respawn: 0 },
  team: { cap: 4, min: 4, teams: true, rounds: true, win: 3, respawn: 0 },
  lobby: { cap: 60, min: 0, teams: false, rounds: false, target: 0, respawn: 0, social: true },
};

// spawn points (mirror lib/scene.js SPAWNS; the Pit arena is at x 220, z 170)
const FFA = [[-14, 14], [14, 14], [0, -12], [-120, -60], [-190, -60], [60, -60], [200, -60], [0, -120], [0, 100],
  [110, -20], [-60, 60], [-100, 120], [60, 120], [250, -60], [0, -262]].map(([x, z]) => ({ x, y: 0, z, yaw: 0 }));
const PIT = (pts, yaw) => pts.map(([x, z]) => ({ x, y: 0, z, yaw }));
const TEAM_A = PIT([[194, 165], [194, 175], [192, 158], [192, 182]], -Math.PI / 2);
const TEAM_B = PIT([[246, 165], [246, 175], [248, 158], [248, 182]], Math.PI / 2);
const DUEL = { A: { x: 194, y: 0, z: 170, yaw: -Math.PI / 2 }, B: { x: 246, y: 0, z: 170, yaw: Math.PI / 2 } };
// the shared lobby hall floats at y 400 (mirror LOBBY_SPAWN in lib/lobby.js)
const LOBBY_SPAWN = { x: -240, y: 400, z: 256, yaw: 0 };

const BOUND = 298;
const TIER_HP = [140, 280, 420];
const MAX_PIECES = 450;
const FROZEN = ['countdown', 'intermission', 'ended'];

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function parseLoadout(str) {
  const p = String(str || '').split('.');
  return SLOTS.map((slot, i) => (SLOT_OF[p[i]] === slot ? p[i] : DEFAULT_LO[i]));
}
function falloff(f, d) {
  if (!f || d <= f[0]) return 1;
  if (d >= f[1]) return f[2];
  return 1 + (f[2] - 1) * ((d - f[0]) / (f[1] - f[0]));
}
/** attacker is behind the target (target faces -Z at yaw 0) */
function isBehind(att, tgt) {
  const fx = -Math.sin(tgt.yaw), fz = -Math.cos(tgt.yaw);
  const dx = att.x - tgt.x, dz = att.z - tgt.z, l = Math.hypot(dx, dz) || 1;
  return (fx * dx + fz * dz) / l < -0.15;
}
function cleanSpec(sp) {
  if (!sp || typeof sp !== 'object') return null;
  const type = sp.type;
  if (type !== 'wall' && type !== 'floor' && type !== 'ramp') return null;
  const ix = Math.round(num(sp.ix, NaN)), iz = Math.round(num(sp.iz, NaN)), lv = Math.round(num(sp.lv, NaN));
  const o = Math.round(num(sp.o, NaN)), tier = Math.round(num(sp.tier, NaN));
  if (![ix, iz, lv, o, tier].every(Number.isFinite)) return null;
  if (Math.abs(ix) > 76 || Math.abs(iz) > 76 || lv < 0 || lv > 12 || tier < 0 || tier > 2) return null;
  if ((type === 'wall' && (o < 0 || o > 1)) || (type === 'floor' && o !== 0) || (type === 'ramp' && (o < 0 || o > 3))) return null;
  return { type, ix, iz, lv, o, tier };
}
const specKey = (s) => `${s.type}:${s.ix}:${s.iz}:${s.lv}:${s.o}`;

const BOT_SPAWNS = [
  { x: 320, y: 0, z: 280 }, { x: -340, y: 0, z: 260 }, { x: 300, y: 0, z: -310 }, { x: -290, y: 0, z: -330 },
  { x: 420, y: 0, z: 40 }, { x: -410, y: 0, z: -60 }, { x: 50, y: 0, z: 430 }, { x: -70, y: 0, z: -440 },
  { x: 380, y: 0, z: 180 }, { x: -360, y: 0, z: 200 }, { x: 200, y: 0, z: -390 }, { x: -220, y: 0, z: -370 },
  { x: 480, y: 0, z: -120 }, { x: -470, y: 0, z: 140 }, { x: 140, y: 0, z: 490 }, { x: -160, y: 0, z: -480 },
  { x: 250, y: 0, z: 400 }, { x: -270, y: 0, z: -410 }, { x: 400, y: 0, z: -280 }, { x: -390, y: 0, z: 300 },
];

export class GameRoom {

  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.chat = [];
    this.builds = new Map();
    this.cfg = null;
    this.mode = 'custom';
    this.phase = 'waiting';
    this.phaseEnd = 0;
    this.note = '';
    this.winner = '';
    this.round = 0;
    this.wins = { A: 0, B: 0 };
    this.timer = null;
    this.bots = [];
    this.botCfg = { teams: 2, size: 6, leaders: 1 };
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const url = new URL(request.url);
    const name = (url.searchParams.get('name') || 'Player').replace(/[^\w .\-]/g, '').trim().slice(0, 20) || 'Player';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.handleSession(server, name, url.searchParams);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- sessions ----------
  initRoom(modeParam) {
    this.mode = MODES[modeParam] ? modeParam : 'custom';
    this.cfg = MODES[this.mode];
    this.phase = 'waiting'; this.round = 0; this.wins = { A: 0, B: 0 }; this.note = ''; this.winner = '';
    this.timer = setInterval(() => this.tick(), 200);
  }

  shutdown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.cfg = null;
    this.builds.clear();
    this.chat = [];
    this.bots = [];
  }

handleSession(ws, name, params) {
    ws.accept();
    const modeParam = params.get('mode') || 'custom';
    const lo = parseLoadout(params.get('lo'));
    const lk = String(params.get('lk') || '').replace(/[^0-9.]/g, '').slice(0, 40);
    if (!this.cfg) {
      this.initRoom(modeParam);
      if (this.cfg.botArena) {
        this.botCfg = {
          teams: Math.max(2, Math.min(4, parseInt(params.get('teams') || '2', 10) || 2)),
          size: Math.max(4, Math.min(10, parseInt(params.get('size') || '6', 10) || 6)),
          leaders: Math.max(1, Math.min(3, parseInt(params.get('leaders') || '1', 10) || 1)),
        };
        this.spawnArenaBots();
        this.setPhase('live', 0);
      }
    }
    if (this.sessions.size >= this.cfg.cap) {
      this.send(ws, { type: 'full' });
      try { ws.close(1000, 'full'); } catch (_) {}
      if (!this.sessions.size) this.shutdown();
      return;
    }
    const id = crypto.randomUUID().slice(0, 8);
    const s = {
      id, ws, name, lk, team: this.cfg.teams ? this.pickTeam() : null,
      x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100, alive: true,
      ads: false, crouch: false, sprint: false, rl: false, lo, weapon: lo[0],
      k: 0, d: 0, protectUntil: 0, respawnAt: 0, lastShot: 0, lastMelee: 0, lastThrow: 0, lastBd: 0, buildTimes: [],
    };
    this.sessions.set(id, s);
    this.placePlayer(s, false, 0);

    this.send(ws, {
      type: 'welcome', id, name, team: s.team, mode: this.mode, cap: this.cfg.cap, target: this.cfg.target || this.cfg.win || 0,
      spawn: { x: s.x, y: s.y, z: s.z, yaw: s.yaw }, hp: s.hp,
      players: this.snapshot(id), chat: this.chat.slice(-30),
      builds: [...this.builds.values()].map((b) => b.spec),
      phase: this.phasePayload(), scores: this.scoreList(),
    });
    this.broadcast({ type: 'join', player: this.publicPlayer(s) }, id);
    if (!this.cfg.social) this.systemChat(`${name} joined`);
    this.broadcastScores();
    this.broadcastPhase();

    ws.addEventListener('message', (evt) => {
      if (typeof evt.data === 'string' && evt.data.length > 4000) return;
      let msg;
      try { msg = JSON.parse(typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data)); } catch { return; }
      this.onMessage(s, msg);
    });
    const leave = () => {
      if (!this.sessions.delete(id)) return;
      this.broadcast({ type: 'leave', id });
      if (!this.cfg.social) this.systemChat(`${name} left`);
      this.broadcastScores();
      if (!this.sessions.size) this.shutdown();
    };
    ws.addEventListener('close', leave);
    ws.addEventListener('error', () => { try { ws.close(); } catch (_) {} leave(); });
  }

  pickTeam() {
    let a = 0, b = 0;
    for (const s of this.sessions.values()) { if (s.team === 'A') a++; else if (s.team === 'B') b++; }
    return b < a ? 'B' : 'A';
  }

  spawnFor(s) {
    if (this.cfg.social) return LOBBY_SPAWN;
    if (this.cfg.teams) {
      if (this.mode === 'duel') return DUEL[s.team] || DUEL.A;
      const list = s.team === 'A' ? TEAM_A : TEAM_B;
      const idx = [...this.sessions.values()].filter((o) => o.team === s.team).indexOf(s);
      return list[Math.max(0, idx) % list.length];
    }
    const others = [...this.sessions.values()].filter((o) => o !== s && o.alive);
    let best = FFA[0], bd = -1;
    for (const sp of FFA) {
      let md = 1e9;
      for (const o of others) md = Math.min(md, Math.hypot(o.x - sp.x, o.z - sp.z));
      md += Math.random() * 25;
      if (md > bd) { bd = md; best = sp; }
    }
    return best;
  }

  placePlayer(s, notify, protectMs) {
    const sp = this.spawnFor(s);
    s.x = sp.x; s.y = sp.y; s.z = sp.z; s.yaw = sp.yaw; s.pitch = 0;
    s.hp = 100; s.alive = true; s.rl = false; s.respawnAt = 0;
    s.protectUntil = Date.now() + protectMs;
    if (!notify) return;
    this.send(s.ws, { type: 'spawn', x: s.x, y: s.y, z: s.z, yaw: s.yaw, hp: 100, protect: protectMs });
    this.broadcast({ ...this.stateMsg(s) }, s.id);
    this.broadcast({ type: 'hp', id: s.id, hp: 100, alive: true });
  }

  // ---------- messages ----------
  onMessage(s, msg) {
    if (!msg || typeof msg.type !== 'string') return;
    const now = Date.now();
    switch (msg.type) {
      case 'state': {
        if (!FROZEN.includes(this.phase) && s.alive) {
          s.x = clamp(num(msg.x, s.x), -BOUND, BOUND);
          s.y = clamp(num(msg.y, s.y), 0, this.cfg.social ? 500 : 80);
          s.z = clamp(num(msg.z, s.z), -BOUND, BOUND);
          s.yaw = num(msg.yaw, s.yaw);
          s.pitch = clamp(num(msg.pitch, s.pitch), -1.5, 1.5);
        }
        s.ads = !!msg.ads; s.crouch = !!msg.crouch; s.sprint = !!msg.sprint; s.rl = !!msg.rl;
        if (typeof msg.weapon === 'string' && s.lo.includes(msg.weapon)) s.weapon = msg.weapon;
        this.broadcast(this.stateMsg(s), s.id);
        break;
      }
      case 'shoot': {
        const gun = GUNS[msg.weapon];
        if (!gun || !s.alive || !s.lo.includes(msg.weapon)) break;
        if (now - s.lastShot < gun.cd * 550) break;
        s.lastShot = now;
        this.broadcast({
          type: 'shoot', id: s.id, weapon: msg.weapon,
          ox: num(msg.ox), oy: num(msg.oy), oz: num(msg.oz), dx: num(msg.dx), dy: num(msg.dy), dz: num(msg.dz),
        }, s.id);
        if (this.phase !== 'live' || !Array.isArray(msg.hits)) break;
        for (const h of msg.hits.slice(0, 12)) {
          const t = this.sessions.get(h && h.id);
          if (!t || t === s) continue;
          const n = clamp(Math.round(num(h.n, 1)), 1, gun.pellets);
          const zone = h.zone === 'head' ? 'head' : h.zone === 'limb' ? 'limb' : 'body';
          this.applyDamage(s, t, gun[zone] * falloff(gun.fall, dist3(s, t)) * n, { weapon: msg.weapon, head: zone === 'head' });
        }
        break;
      }
      case 'melee': {
        const m = MELEE[msg.weapon];
        if (!m || !s.alive || !s.lo.includes(msg.weapon)) break;
        const thrown = !!msg.thrown && !!m.thrown;
        if (thrown) { if (now - s.lastThrow < m.throwCd * 600) break; s.lastThrow = now; }
        else { if (now - s.lastMelee < m.cd * 600) break; s.lastMelee = now; }
        this.broadcast({ type: 'melee', id: s.id, weapon: msg.weapon, thrown }, s.id);
        const t = this.sessions.get(msg.id);
        if (this.phase !== 'live' || !t || t === s) break;
        if (dist3(s, t) > (thrown ? m.throwRange + 6 : m.range + 1.5)) break;
        let dmg;
        if (thrown) dmg = m.thrown;
        else if (m.back && isBehind(s, t)) dmg = m.back;
        else dmg = msg.zone === 'head' ? m.head : m.front;
        this.applyDamage(s, t, dmg, { weapon: msg.weapon, head: !thrown && msg.zone === 'head', heal: m.heal });
        break;
      }
      case 'loadout': {
        s.lo = parseLoadout(Array.isArray(msg.lo) ? msg.lo.join('.') : msg.lo);
        if (!s.lo.includes(s.weapon)) s.weapon = s.lo[0];
        break;
      }
      case 'build': {
        if (this.cfg.social) break;
        s.buildTimes = s.buildTimes.filter((t) => now - t < 1000);
        if (s.buildTimes.length >= 16 || !s.alive) break;
        s.buildTimes.push(now);
        const spec = cleanSpec(msg.spec);
        if (!spec) break;
        const key = specKey(spec);
        if (this.builds.has(key)) break;
        this.builds.set(key, { spec, hp: TIER_HP[spec.tier] });
        if (this.builds.size > MAX_PIECES) this.builds.delete(this.builds.keys().next().value);
        this.broadcast({ type: 'bplace', spec }, s.id);
        break;
      }
      case 'bdmg': {
        const piece = this.builds.get(String(msg.key));
        if (!piece) { this.send(s.ws, { type: 'bbreak', key: String(msg.key) }); break; }
        const g = GUNS[msg.weapon], m = MELEE[msg.weapon];
        if ((!g && !m) || !s.lo.includes(msg.weapon)) break;
        if (now - s.lastBd < ((g ? g.cd : m.cd) * 1000) * 0.5) break;
        s.lastBd = now;
        let dmg;
        if (g) dmg = g.body * clamp(Math.round(num(msg.n, 1)), 1, g.pellets);
        else {
          if (Math.hypot(s.x - piece.spec.ix * 4, s.z - piece.spec.iz * 4) > 11) break;
          dmg = m.demolish ? 99999 : m.front;
        }
        piece.hp -= dmg;
        this.broadcast({ type: 'bhit', key: String(msg.key), dmg });
        if (piece.hp <= 0) {
          this.builds.delete(String(msg.key));
          this.broadcast({ type: 'bbreak', key: String(msg.key) });
        }
        break;
      }
      case 'bot_order': this.applyBotOrder(msg); break;
      case 'bot_hit': this.hitBot(msg, s); break;
      case 'bot_team_wipe': this.wipeBotTeam(msg.team | 0); break;
      case 'bot_leader_spawn': this.spawnBotTeam(msg.team | 0, +msg.x || 0, +msg.z || 0); break;
      case 'respawn': break; // the server respawns players itself
      case 'chat': {
        const text = String(msg.text || '').trim().slice(0, 200);
        if (!text) return;
        const entry = { type: 'chat', id: s.id, name: s.name, text, t: now };
        this.chat.push(entry);
        if (this.chat.length > 40) this.chat.shift();
        this.broadcast(entry);
        break;
      }
      default: break;
    }
  }

  // ---------- combat ----------
  applyDamage(att, tgt, dmg, info) {
    if (this.phase !== 'live' || !tgt.alive || !att.alive || att === tgt) return;
    if (Date.now() < tgt.protectUntil) return;
    if (this.cfg.teams && att.team === tgt.team) return;
    dmg = Math.max(1, Math.round(dmg));
    tgt.hp = Math.max(0, tgt.hp - dmg);
    this.send(tgt.ws, { type: 'damage', from: att.id, hp: tgt.hp, alive: tgt.hp > 0, dmg, weapon: info.weapon });
    this.broadcast({ type: 'hp', id: tgt.id, hp: tgt.hp, alive: tgt.hp > 0 });
    if (tgt.hp <= 0) this.kill(att, tgt, info);
  }

  kill(att, tgt, info) {
    tgt.alive = false; tgt.hp = 0; tgt.d++; att.k++;
    this.broadcast({ type: 'kill', killer: att.id, kname: att.name, victim: tgt.id, vname: tgt.name, weapon: info.weapon || '', head: !!info.head });
    if (info.heal) {
      att.hp = Math.min(100, att.hp + info.heal);
      this.send(att.ws, { type: 'heal', hp: att.hp });
      this.broadcast({ type: 'hp', id: att.id, hp: att.hp, alive: true });
    }
    if (!this.cfg.rounds) {
      tgt.respawnAt = Date.now() + this.cfg.respawn;
      this.send(tgt.ws, { type: 'respawn_in', ms: this.cfg.respawn });
    }
    this.broadcastScores();
    this.checkEnd();
  }

  // ---------- match flow ----------
  phasePayload() {
    return {
      type: 'phase', phase: this.phase, round: this.round, wins: this.wins,
      t: Math.max(0, (this.phaseEnd - Date.now()) / 1000), note: this.note, winner: this.winner,
      have: this.sessions.size, need: this.cfg ? this.cfg.min : 1,
    };
  }
  broadcastPhase() { this.broadcast(this.phasePayload()); }
  setPhase(p, secs, o = {}) {
    this.phase = p;
    this.phaseEnd = Date.now() + secs * 1000;
    this.note = o.note || '';
    this.winner = o.winner || '';
    this.broadcastPhase();
  }

  resetScores() {
    for (const s of this.sessions.values()) { s.k = 0; s.d = 0; }
    this.wins = { A: 0, B: 0 };
    this.round = 0;
  }
  startMatch() { this.resetScores(); this.broadcastScores(); this.startRound(); }
  startRound() {
    this.round++;
    this.builds.clear();
    this.broadcast({ type: 'bclear' });
    for (const s of this.sessions.values()) this.placePlayer(s, true, 0);
    this.setPhase('countdown', 3);
  }
  toWaiting(note) {
    this.resetScores();
    this.broadcastScores();
    this.setPhase('waiting', 0, { note });
  }

  checkEnd() {
    if (this.phase !== 'live') return;
    const cfg = this.cfg;
    if (cfg.botArena) return;
    if (!cfg.rounds) {
      let top = null;
      for (const s of this.sessions.values()) if (!top || s.k > top.k) top = s;
      if (cfg.target > 0 && top && top.k >= cfg.target) this.setPhase('ended', 9, { winner: top.name });
      return;
    }
    const alive = { A: 0, B: 0 }, total = { A: 0, B: 0 };
    for (const s of this.sessions.values()) { total[s.team]++; if (s.alive) alive[s.team]++; }
    if (!total.A || !total.B) return;
    if (!alive.A && !alive.B) this.endRound(null);
    else if (!alive.A) this.endRound('B');
    else if (!alive.B) this.endRound('A');
  }

  endRound(team) {
    if (team) this.wins[team]++;
    const label = (t) => {
      if (this.mode === 'duel') { for (const s of this.sessions.values()) if (s.team === t) return s.name; }
      return `Team ${t}`;
    };
    if (team && this.wins[team] >= this.cfg.win) this.setPhase('ended', 9, { winner: label(team) });
    else this.setPhase('intermission', 4, { note: team ? `${label(team)} takes the round` : 'Draw' });
  }

  tick() {
    const cfg = this.cfg;
    if (!cfg || cfg.social) return;
    const now = Date.now(), n = this.sessions.size;
    if (cfg.botArena) {
      this.tickBots();
      for (const s of this.sessions.values()) {
        if (!s.alive && s.respawnAt && now >= s.respawnAt) this.placePlayer(s, true, 1500);
      }
      return;
    }
    if (!cfg.rounds && this.phase === 'live') {
      for (const s of this.sessions.values()) if (!s.alive && s.respawnAt && now >= s.respawnAt) this.placePlayer(s, true, 2000);
    }
    switch (this.phase) {
      case 'waiting': if (n >= cfg.min) this.startMatch(); break;
      case 'countdown':
        if (n < cfg.min) this.toWaiting('A player left');
        else if (now >= this.phaseEnd) this.setPhase('live', 0);
        break;
      case 'live': if (n < cfg.min) this.toWaiting('A player left'); else this.checkEnd(); break;
      case 'intermission':
        if (n < cfg.min) this.toWaiting('A player left');
        else if (now >= this.phaseEnd) this.startRound();
        break;
      case 'ended':
        if (now >= this.phaseEnd) { if (n >= cfg.min) this.startMatch(); else this.toWaiting(''); }
        break;
      default: break;
    }
  }

  // ---------- views ----------
  stateMsg(s) {
    return {
      type: 'state', id: s.id, x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch,
      ads: s.ads, crouch: s.crouch, sprint: s.sprint, rl: s.rl, weapon: s.weapon, hp: s.hp, alive: s.alive,
    };
  }
  publicPlayer(s) {
    return { ...this.stateMsg(s), type: undefined, name: s.name, team: s.team, k: s.k, d: s.d, lk: s.lk };
  }
  snapshot(exceptId) {
    const list = [];
    for (const s of this.sessions.values()) if (s.id !== exceptId) list.push(this.publicPlayer(s));
    return list;
  }
  scoreList() {
    return [...this.sessions.values()].map((s) => ({ id: s.id, name: s.name, k: s.k, d: s.d, team: s.team }));
  }
  broadcastScores() {
    if (!this.cfg) return;
    this.broadcast({ type: 'scores', list: this.scoreList(), target: this.cfg.target || this.cfg.win || 0 });
  }

  systemChat(text) {
    const entry = { type: 'chat', id: 'system', name: 'System', text, t: Date.now() };
    this.chat.push(entry);
    if (this.chat.length > 40) this.chat.shift();
    this.broadcast(entry);
  }

  // ---------- bot arena (server followers) ----------
  spawnArenaBots() {
    this.bots = [];
    const { teams, size, leaders } = this.botCfg;
    let n = 0;
    for (let t = 0; t < teams; t++) {
      for (let i = 0; i < size; i++) {
        if (i < leaders) continue; // leaders stay client-side
        const sp = BOT_SPAWNS[n % BOT_SPAWNS.length];
        this.bots.push({
          id: `b${t}_${i}`,
          team: t,
          name: `B${t}-${i}`,
          x: sp.x + (Math.random() - 0.5) * 8,
          y: sp.y,
          z: sp.z + (Math.random() - 0.5) * 8,
          yaw: Math.random() * Math.PI * 2,
          hp: 100,
          alive: true,
          destX: sp.x,
          destZ: sp.z,
          order: null,
          fireCd: 0,
          respawnAt: 0,
          deathX: sp.x,
          deathZ: sp.z,
          ammo: 30,
          mag: 30,
          reloading: false,
          reloadAt: 0,
          state: 'patrol',
          stateUntil: 0,
          strafeDir: Math.random() < 0.5 ? 1 : -1,
          coverX: sp.x,
          coverZ: sp.z,
          ads: false,
          moving: false,
          freeWillUntil: 0,
        });
        n++;
      }
    }
  }

  farSpawn(fromX, fromZ, avoidX, avoidZ) {
    let best = BOT_SPAWNS[0], bestScore = -1;
    for (const s of BOT_SPAWNS) {
      const d1 = Math.hypot(s.x - fromX, s.z - fromZ);
      const d2 = Math.hypot(s.x - avoidX, s.z - avoidZ);
      const score = d1 + d2;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  tickBots() {
    if (!this.cfg?.botArena || !this.bots.length) return;
    const now = Date.now();
    const dt = 0.2;
    let player = null;
    for (const s of this.sessions.values()) {
      if (s.alive) { player = s; break; }
    }

    for (const b of this.bots) {
      if (!b.alive) {
        if (b.respawnAt && now >= b.respawnAt) {
          const sp = this.farSpawn(player ? player.x : 0, player ? player.z : 0, b.deathX || 0, b.deathZ || 0);
          b.x = sp.x + (Math.random() - 0.5) * 24;
          b.z = sp.z + (Math.random() - 0.5) * 24;
          // y ignored by client — client snaps to floorAt
          b.y = 0;
          b.hp = 100;
          b.alive = true;
          b.order = null;
          b.destX = b.x + (Math.random() - 0.5) * 40;
          b.destZ = b.z + (Math.random() - 0.5) * 40;
          b.ammo = b.mag || 30;
          b.reloading = false;
          b.state = 'patrol';
          b.ads = false;
          b.moving = false;
          b.freeWillUntil = 0;
        }
        continue;
      }

      b.fireCd = Math.max(0, (b.fireCd || 0) - dt);
      const pd = player ? Math.hypot(player.x - b.x, player.z - b.z) : 999;
      const ox = b.order;

      if (b.reloading) {
        if (now >= b.reloadAt) {
          b.ammo = b.mag || 30;
          b.reloading = false;
          b.state = 'patrol';
        }
      } else if ((b.ammo ?? 30) <= 0) {
        b.reloading = true;
        b.reloadAt = now + 2000 + Math.floor(Math.random() * 800);
        b.ads = false;
        b.state = 'reload';
        if (player && pd < 50) {
          const ang = Math.atan2(b.x - player.x, b.z - player.z);
          b.destX = b.x + Math.sin(ang) * 12;
          b.destZ = b.z + Math.cos(ang) * 12;
        }
      }

      if (now > (b.freeWillUntil || 0) && Math.random() < 0.03) {
        b.freeWillUntil = now + 3000 + Math.floor(Math.random() * 4000);
        b.strafeDir = Math.random() < 0.5 ? 1 : -1;
        const sp = BOT_SPAWNS[Math.floor(Math.random() * BOT_SPAWNS.length)];
        b.destX = sp.x + (Math.random() - 0.5) * 40;
        b.destZ = sp.z + (Math.random() - 0.5) * 40;
        b.state = 'patrol';
      }

      let tx = b.destX, tz = b.destZ, spd = 3.0;
      const free = now < (b.freeWillUntil || 0);

      if (b.reloading) {
        tx = b.destX; tz = b.destZ; spd = 2.2;
      } else if (ox && !free && (ox.type === 'attack' || ox.targetId === 'player') && player && pd < 55) {
        const ang = Math.atan2(player.x - b.x, player.z - b.z);
        const side = (b.strafeDir || 1) * (10 + Math.random() * 8);
        tx = player.x + Math.cos(ang) * side - Math.sin(ang) * 22;
        tz = player.z - Math.sin(ang) * side - Math.cos(ang) * 22;
        spd = pd > 30 ? 4.2 : 2.8;
        b.state = 'engage';
      } else if (ox && !free && ox.type === 'hold') {
        tx = ox.x; tz = ox.z;
        spd = Math.hypot(b.x - tx, b.z - tz) > 3 ? 2.4 : 0;
      } else if (ox && !free && ox.type === 'move') {
        tx = ox.x; tz = ox.z; spd = 4.0;
      } else if (player && pd < 28) {
        const ang = Math.atan2(player.x - b.x, player.z - b.z);
        tx = player.x + Math.cos(ang) * (b.strafeDir || 1) * 14 - Math.sin(ang) * 16;
        tz = player.z - Math.sin(ang) * (b.strafeDir || 1) * 14 - Math.cos(ang) * 16;
        spd = 3.4;
        b.state = 'engage';
      } else {
        if (Math.hypot(b.x - (b.destX || b.x), b.z - (b.destZ || b.z)) < 4) {
          const sp = BOT_SPAWNS[Math.floor(Math.random() * BOT_SPAWNS.length)];
          b.destX = sp.x + (Math.random() - 0.5) * 50;
          b.destZ = sp.z + (Math.random() - 0.5) * 50;
        }
        tx = b.destX; tz = b.destZ; spd = 2.8;
        b.state = 'patrol';
      }

      const dx = tx - b.x, dz = tz - b.z, dist = Math.hypot(dx, dz);
      if (spd > 0 && dist > 0.7) {
        const step = Math.min(dist, spd * dt);
        b.x += (dx / dist) * step;
        b.z += (dz / dist) * step;
        b.moving = true;
        if (!(player && pd < 35 && !b.reloading && (b.ammo ?? 1) > 0 && b.state === 'engage')) {
          b.yaw = Math.atan2(-dx, -dz);
        }
      } else {
        b.moving = false;
      }

      b.ads = false;
      if (
        player && !b.reloading && (b.ammo ?? 0) > 0 && b.fireCd <= 0 &&
        pd > 4 && pd < 32 && b.state === 'engage'
      ) {
        b.yaw = Math.atan2(-(player.x - b.x), -(player.z - b.z));
        b.ads = pd > 14;
        b.fireCd = 0.45 + Math.random() * 0.35;
        b.ammo = Math.max(0, (b.ammo ?? 30) - 1);

        const spread = 0.08 + pd * 0.004 + (b.moving ? 0.06 : 0);
        const dxp = player.x - b.x + (Math.random() - 0.5) * spread * pd;
        const dzp = player.z - b.z + (Math.random() - 0.5) * spread * pd;
        const dyp = 1.0 + (Math.random() - 0.5) * 0.6;

        this.broadcast({
          type: 'bot_shoot',
          id: b.id,
          x: b.x, y: 0, z: b.z,
          dx: dxp, dy: dyp, dz: dzp,
        });

        const hitChance = Math.max(0.05, 0.28 - pd / 120 - (b.moving ? 0.08 : 0));
        if (Math.random() < hitChance) {
          const dmg = 5 + Math.floor(Math.random() * 5);
          player.hp = Math.max(0, player.hp - dmg);
          this.send(player.ws, {
            type: 'damage', from: b.id, hp: player.hp, alive: player.hp > 0, dmg, weapon: 'stinger',
          });
          if (player.hp <= 0) {
            player.alive = false;
            player.d++;
            this.broadcast({
              type: 'kill', killer: b.id, kname: b.name, victim: player.id, vname: player.name, head: false,
            });
            player.respawnAt = now + 3500;
          }
        }
      }
    }

    this.broadcast({
      type: 'bots',
      list: this.bots.map((b) => ({
        id: b.id, team: b.team, name: b.name,
        x: b.x, z: b.z, yaw: b.yaw,
        hp: b.hp, alive: b.alive,
        moving: !!b.moving, ads: !!b.ads, reloading: !!b.reloading,
        ammo: b.ammo ?? 30, state: b.state || 'patrol',
      })),
    });
  }

  applyBotOrder(msg) {
    if (!this.cfg?.botArena) return;
    const team = msg.team | 0;
    const order = msg.order;
    if (!order || typeof order !== 'object') return;
    for (const b of this.bots) {
      if (b.team !== team || !b.alive) continue;
      b.order = {
        type: order.type || 'move',
        x: +order.x || b.x,
        z: +order.z || b.z,
        targetId: order.targetId || null,
      };
      b.destX = b.order.x;
      b.destZ = b.order.z;
    }
  }

  hitBot(msg, attacker) {
    if (!this.cfg?.botArena) return;
    const b = this.bots.find((x) => x.id === msg.id);
    if (!b || !b.alive) return;
    const dmg = Math.min(80, Math.max(1, +msg.dmg || 10));
    b.hp -= dmg;
    if (b.hp <= 0) {
      b.hp = 0;
      b.alive = false;
      b.deathX = b.x;
      b.deathZ = b.z;
      b.respawnAt = Date.now() + 14000 + Math.floor(Math.random() * 8000);
      if (attacker) {
        attacker.k++;
        this.broadcast({ type: 'kill', killer: attacker.id, kname: attacker.name, victim: b.id, vname: b.name, head: !!msg.head });
        this.broadcastScores();
      }
    }
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
  broadcast(obj, exceptId = null) {
    const data = JSON.stringify(obj);
    for (const s of this.sessions.values()) {
      if (s.id === exceptId) continue;
      try { s.ws.send(data); } catch (_) {}
    }
  }
}
