/**
 * FPS multiplayer + chat — Cloudflare Worker + Durable Object rooms
 * Client: wss://<worker>/ws?room=CODE&name=Player
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors() });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'fps-game-server' });
    }

    if (url.pathname === '/ws') {
      const room =
        (url.searchParams.get('room') || 'lobby')
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '')
          .slice(0, 24) || 'lobby';
      const id = env.ROOM.idFromName(room);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === '/api/create') {
      return json({ room: randomRoom() }, 200);
    }

    return json({ error: 'not_found' }, 404);
  },
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  });
}

function randomRoom() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.chat = [];
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const url = new URL(request.url);
    const name = (url.searchParams.get('name') || 'Player').slice(0, 20);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.handleSession(server, name);
    return new Response(null, { status: 101, webSocket: client });
  }

  handleSession(ws, name) {
    ws.accept();
    const id = crypto.randomUUID().slice(0, 8);
    const session = {
      id,
      ws,
      name,
      x: (Math.random() - 0.5) * 10,
      z: 6 + Math.random() * 4,
      yaw: 0,
      pitch: 0,
      hp: 100,
      alive: true,
      ads: false,
      thirdPerson: true,
    };
    this.sessions.set(id, session);

    this.send(ws, {
      type: 'welcome',
      id,
      name,
      players: this.snapshot(id),
      chat: this.chat.slice(-30),
    });

    this.broadcast({ type: 'join', player: this.publicPlayer(session) }, id);
    this.systemChat(`${name} joined`);

    ws.addEventListener('message', (evt) => {
      let msg;
      try {
        msg = JSON.parse(typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data));
      } catch {
        return;
      }
      this.onMessage(session, msg);
    });

    ws.addEventListener('close', () => {
      this.sessions.delete(id);
      this.broadcast({ type: 'leave', id });
      this.systemChat(`${name} left`);
    });

    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch (_) {}
      this.sessions.delete(id);
    });
  }

  onMessage(session, msg) {
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'state': {
        if (typeof msg.x === 'number') session.x = clamp(msg.x, -95, 95);
        if (typeof msg.z === 'number') session.z = clamp(msg.z, -95, 95);
        if (typeof msg.yaw === 'number') session.yaw = msg.yaw;
        if (typeof msg.pitch === 'number') session.pitch = clamp(msg.pitch, -1.2, 1.2);
        if (typeof msg.hp === 'number') session.hp = clamp(msg.hp, 0, 100);
        if (typeof msg.alive === 'boolean') session.alive = msg.alive;
        if (typeof msg.ads === 'boolean') session.ads = msg.ads;
        if (typeof msg.thirdPerson === 'boolean') session.thirdPerson = msg.thirdPerson;
        this.broadcast(
          {
            type: 'state',
            id: session.id,
            x: session.x,
            z: session.z,
            yaw: session.yaw,
            pitch: session.pitch,
            hp: session.hp,
            alive: session.alive,
            ads: session.ads,
            thirdPerson: session.thirdPerson,
          },
          session.id
        );
        break;
      }
      case 'shoot': {
        this.broadcast(
          {
            type: 'shoot',
            id: session.id,
            ox: msg.ox,
            oy: msg.oy,
            oz: msg.oz,
            dx: msg.dx,
            dy: msg.dy,
            dz: msg.dz,
          },
          session.id
        );
        if (msg.targetId && this.sessions.has(msg.targetId)) {
          const target = this.sessions.get(msg.targetId);
          if (target.alive) {
            const dmg = typeof msg.dmg === 'number' ? clamp(msg.dmg, 1, 40) : 16;
            target.hp = Math.max(0, target.hp - dmg);
            if (target.hp <= 0) {
              target.alive = false;
              target.hp = 0;
            }
            this.send(target.ws, {
              type: 'damage',
              from: session.id,
              hp: target.hp,
              alive: target.alive,
              dmg,
            });
            this.broadcast({
              type: 'hp',
              id: target.id,
              hp: target.hp,
              alive: target.alive,
            });
            if (!target.alive) {
              this.systemChat(`${session.name} eliminated ${target.name}`);
              this.send(target.ws, { type: 'respawn_in', ms: 2000 });
            }
          }
        }
        break;
      }
      case 'respawn': {
        session.alive = true;
        session.hp = 100;
        session.x = (Math.random() - 0.5) * 12;
        session.z = 4 + Math.random() * 8;
        this.broadcast({
          type: 'state',
          id: session.id,
          x: session.x,
          z: session.z,
          yaw: session.yaw,
          pitch: 0,
          hp: 100,
          alive: true,
          ads: false,
          thirdPerson: session.thirdPerson,
        });
        break;
      }
      case 'chat': {
        const text = String(msg.text || '').trim().slice(0, 200);
        if (!text) return;
        const entry = {
          type: 'chat',
          id: session.id,
          name: session.name,
          text,
          t: Date.now(),
        };
        this.chat.push(entry);
        if (this.chat.length > 40) this.chat.shift();
        this.broadcast(entry);
        break;
      }
      default:
        break;
    }
  }

  publicPlayer(s) {
    return {
      id: s.id,
      name: s.name,
      x: s.x,
      z: s.z,
      yaw: s.yaw,
      pitch: s.pitch,
      hp: s.hp,
      alive: s.alive,
      ads: s.ads,
      thirdPerson: s.thirdPerson,
    };
  }

  snapshot(exceptId) {
    const list = [];
    for (const s of this.sessions.values()) {
      if (s.id === exceptId) continue;
      list.push(this.publicPlayer(s));
    }
    return list;
  }

  systemChat(text) {
    const entry = { type: 'chat', id: 'system', name: 'System', text, t: Date.now() };
    this.chat.push(entry);
    if (this.chat.length > 40) this.chat.shift();
    this.broadcast(entry);
  }

  send(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (_) {}
  }

  broadcast(obj, exceptId = null) {
    const data = JSON.stringify(obj);
    for (const s of this.sessions.values()) {
      if (s.id === exceptId) continue;
      try {
        s.ws.send(data);
      } catch (_) {}
    }
  }
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
      }
