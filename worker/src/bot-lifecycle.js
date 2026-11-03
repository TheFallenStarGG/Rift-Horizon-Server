import worker, { GameRoom } from './index.js';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const random = (lo, hi) => lo + Math.random() * (hi - lo);

function resetFollower(b, x, z) {
  b.x = x;
  b.y = 0;
  b.z = z;
  b.hp = 100;
  b.alive = true;
  b.respawnAt = 0;
  b.waitingForLeader = false;
  b.order = null;
  b.destX = x + random(-18, 18);
  b.destZ = z + random(-18, 18);
  b.ammo = b.mag || 30;
  b.reloading = false;
  b.reloadAt = 0;
  b.fireCd = random(0, 0.4);
  b.state = 'patrol';
  b.ads = false;
  b.moving = false;
  b.freeWillUntil = 0;
  b.coverUntil = 0;
  b.lastHurtAt = 0;
  b.strafeDir = Math.random() < 0.5 ? 1 : -1;
}

function botSnapshot(room) {
  room.broadcast({
    type: 'bots',
    list: room.bots.map((b) => ({
      id: b.id, team: b.team, name: b.name,
      x: b.x, z: b.z, yaw: b.yaw,
      hp: b.hp, alive: b.alive,
      moving: !!b.moving, ads: !!b.ads, reloading: !!b.reloading,
      ammo: b.ammo ?? 30, state: b.state || 'patrol',
    })),
  });
}

/** A squad wipe is a wait state, not normal follower deaths/respawns. */
GameRoom.prototype.wipeBotTeam = function (team) {
  if (!this.cfg?.botArena) return;
  for (const b of this.bots) {
    if (b.team !== team) continue;
    b.hp = 0;
    b.alive = false;
    b.waitingForLeader = true;
    b.respawnAt = 0;
    b.order = null;
    b.state = 'waiting_for_leader';
    b.ads = false;
    b.moving = false;
    b.reloading = false;
    b.freeWillUntil = 0;
    b.coverUntil = 0;
  }
  botSnapshot(this);
};

/** Revive the wiped squad together when its client-side leader returns. */
GameRoom.prototype.spawnBotTeam = function (team, leaderX, leaderZ) {
  if (!this.cfg?.botArena) return;
  const squad = this.bots.filter((b) => b.team === team);
  const count = Math.max(1, squad.length);
  squad.forEach((b, i) => {
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.25;
    const radius = 4 + Math.random() * 3;
    resetFollower(b, leaderX + Math.cos(angle) * radius, leaderZ + Math.sin(angle) * radius);
  });
  botSnapshot(this);
};

/** The client may send this order when its client-side leader is hit. */
GameRoom.prototype.reactBotLeaderHit = function (team, x, z) {
  if (!this.cfg?.botArena) return;
  const now = Date.now();
  for (const b of this.bots) {
    if (b.team !== team || !b.alive) continue;
    b.leaderThreatUntil = now + 2500;
    b.leaderThreatX = x;
    b.leaderThreatZ = z;
    b.freeWillUntil = 0;
    b.state = 'protect_leader';
    b.strafeDir = Math.random() < 0.5 ? -1 : 1;
  }
};

// Keep the existing order protocol; leader-hit is a special event rather than a movement order.
const applyBotOrder = GameRoom.prototype.applyBotOrder;
GameRoom.prototype.applyBotOrder = function (msg) {
  const order = msg?.order;
  if (order?.type === 'leader_hit') {
    this.reactBotLeaderHit(msg.team | 0, Number(order.x) || 0, Number(order.z) || 0);
    return;
  }
  return applyBotOrder.call(this, msg);
};

// Preserve normal hit/kill scoring while making a surviving follower take cover and fight back.
const hitBot = GameRoom.prototype.hitBot;
GameRoom.prototype.hitBot = function (msg, attacker) {
  const b = this.bots.find((bot) => bot.id === msg.id);
  const wasAlive = !!b?.alive;
  hitBot.call(this, msg, attacker);
  if (!b || !wasAlive || !b.alive) return;
  const now = Date.now();
  b.lastHurtAt = now;
  b.coverUntil = now + random(1800, 3200);
  b.freeWillUntil = 0;
  b.strafeDir = Math.random() < 0.5 ? -1 : 1;
  b.state = 'under_fire';
};

function pickCover(room, bot, threatX, threatZ) {
  const dx = threatX - bot.x, dz = threatZ - bot.z;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1) return null;
  let best = null, bestScore = Infinity;
  for (const piece of room.builds.values()) {
    const s = piece.spec;
    if (s.type !== 'wall') continue;
    const wx = s.ix * 4, wz = s.iz * 4;
    const t = ((wx - bot.x) * dx + (wz - bot.z) * dz) / len2;
    if (t <= 0.08 || t >= 0.95) continue;
    const lateral = Math.abs((wx - bot.x) * dz - (wz - bot.z) * dx) / Math.sqrt(len2);
    if (lateral > 5.5) continue;
    const away = Math.hypot(wx - threatX, wz - threatZ) || 1;
    const x = wx + ((wx - threatX) / away) * 3.2;
    const z = wz + ((wz - threatZ) / away) * 3.2;
    const score = dist(bot.x, bot.z, x, z) + lateral * 2;
    if (score < bestScore) { bestScore = score; best = { x, z }; }
  }
  return best;
}

function moveBot(b, x, z, speed, dt) {
  const dx = x - b.x, dz = z - b.z, d = Math.hypot(dx, dz);
  if (speed > 0 && d > 0.7) {
    const step = Math.min(d, speed * dt);
    b.x += dx / d * step;
    b.z += dz / d * step;
    b.yaw = Math.atan2(-dx, -dz);
    b.moving = true;
  } else {
    b.moving = false;
  }
}

/**
 * Server-owned follower steering/combat. Leaders remain client-side; followers get short,
 * bounded tactical autonomy so stale orders do not leave them stationary or helpless.
 */
GameRoom.prototype.tickBots = function () {
  if (!this.cfg?.botArena || !this.bots.length) return;
  const now = Date.now(), dt = 0.2;
  let player = null;
  for (const s of this.sessions.values()) if (s.alive) { player = s; break; }

  for (const b of this.bots) {
    if (!b.alive) {
      // A wiped follower has no timer: only bot_leader_spawn may revive it.
      if (!b.waitingForLeader && b.respawnAt && now >= b.respawnAt) {
        const sp = this.farSpawn(player?.x || 0, player?.z || 0, b.deathX || 0, b.deathZ || 0);
        resetFollower(b, sp.x + random(-12, 12), sp.z + random(-12, 12));
      }
      continue;
    }

    b.fireCd = Math.max(0, (b.fireCd || 0) - dt);
    if (b.reloading) {
      if (now >= b.reloadAt) { b.ammo = b.mag || 30; b.reloading = false; b.state = 'patrol'; }
    } else if ((b.ammo ?? 30) <= 0) {
      b.reloading = true;
      b.reloadAt = now + 1900 + Math.floor(Math.random() * 700);
      b.ads = false;
      b.state = 'reload';
    }

    const pd = player ? dist(player.x, player.z, b.x, b.z) : Infinity;
    const order = b.order;
    const threatX = player?.x ?? b.leaderThreatX ?? b.x;
    const threatZ = player?.z ?? b.leaderThreatZ ?? b.z;
    let tx = b.destX, tz = b.destZ, speed = 2.8;
    const underFire = b.coverUntil > now;
    const protecting = (b.leaderThreatUntil || 0) > now;
    const free = b.freeWillUntil > now;

    if (!free && !b.reloading && (underFire || protecting)) {
      const cover = pickCover(this, b, threatX, threatZ);
      if (cover) {
        tx = cover.x; tz = cover.z; speed = 3.6;
        b.state = protecting ? 'protect_leader' : 'cover';
      } else {
        // No built wall nearby: break line and strafe rather than standing still.
        const away = Math.atan2(b.x - threatX, b.z - threatZ);
        const side = b.strafeDir * (8 + (protecting ? 5 : 0));
        tx = b.x + Math.sin(away) * 10 + Math.cos(away) * side;
        tz = b.z + Math.cos(away) * 10 - Math.sin(away) * side;
        speed = 3.7;
        b.state = protecting ? 'protect_leader' : 'evade';
      }
    } else if (!free && order && order.type === 'hold') {
      tx = order.x; tz = order.z; speed = dist(b.x, b.z, tx, tz) > 3 ? 2.4 : 0;
    } else if (!free && order && order.type === 'move') {
      tx = order.x + (b.team % 2 ? 1 : -1) * 2; tz = order.z; speed = 3.8;
      b.state = 'follow';
    } else if (!free && order && (order.type === 'attack' || order.targetId === 'player') && player && pd < 70) {
      const ang = Math.atan2(player.x - b.x, player.z - b.z);
      const side = (b.strafeDir || 1) * (8 + (b.id.charCodeAt(1) % 4));
      tx = player.x + Math.cos(ang) * side - Math.sin(ang) * 18;
      tz = player.z - Math.sin(ang) * side - Math.cos(ang) * 18;
      speed = pd > 28 ? 4.1 : 2.6;
      b.state = 'engage';
    } else if (player && pd < 30) {
      const ang = Math.atan2(player.x - b.x, player.z - b.z);
      const radius = pd < 12 ? 18 : 13;
      tx = player.x + Math.cos(ang) * b.strafeDir * 8 - Math.sin(ang) * radius;
      tz = player.z - Math.sin(ang) * b.strafeDir * 8 - Math.cos(ang) * radius;
      speed = 3.2;
      b.state = 'engage';
    } else {
      // Small, intermittent deviations from the leader's order give followers bounded free will.
      if (!free && now > (b.freeWillUntil || 0) && Math.random() < 0.012) {
        b.freeWillUntil = now + random(1400, 2600);
        b.strafeDir = Math.random() < 0.5 ? -1 : 1;
        const ax = order ? order.x : b.destX;
        const az = order ? order.z : b.destZ;
        b.destX = ax + random(-9, 9);
        b.destZ = az + random(-9, 9);
        b.state = 'free_will';
      }
      if (order && free) { tx = b.destX; tz = b.destZ; speed = 2.7; }
      else if (order) { tx = order.x; tz = order.z; speed = 3.0; b.state = 'follow'; }
      else {
        if (dist(b.x, b.z, b.destX, b.destZ) < 4) {
          const sp = BOT_SPAWNS[Math.floor(Math.random() * BOT_SPAWNS.length)];
          b.destX = sp.x + random(-24, 24); b.destZ = sp.z + random(-24, 24);
        }
        tx = b.destX; tz = b.destZ; speed = 2.8; b.state = 'patrol';
      }
    }

    if (b.reloading) { tx = b.destX; tz = b.destZ; speed = 1.8; }
    moveBot(b, tx, tz, speed, dt);
    b.ads = false;

    if (player && !b.reloading && (b.ammo ?? 0) > 0 && b.fireCd <= 0 && pd > 4 && pd < 34 && b.state === 'engage') {
      b.yaw = Math.atan2(-(player.x - b.x), -(player.z - b.z));
      b.ads = pd > 14;
      b.fireCd = 0.42 + Math.random() * 0.38;
      b.ammo = Math.max(0, (b.ammo ?? 30) - 1);
      const spread = 0.07 + pd * 0.003 + (b.moving ? 0.07 : 0);
      this.broadcast({ type: 'bot_shoot', id: b.id, x: b.x, y: 1.4, z: b.z,
        dx: player.x - b.x + random(-spread * pd, spread * pd),
        dy: 1 + random(-0.2, 0.2), dz: player.z - b.z + random(-spread * pd, spread * pd) });
      if (Math.random() < Math.max(0.06, 0.31 - pd / 130 - (b.moving ? 0.08 : 0))) {
        const dmg = 5 + Math.floor(Math.random() * 5);
        player.hp = Math.max(0, player.hp - dmg);
        this.send(player.ws, { type: 'damage', from: b.id, hp: player.hp, alive: player.hp > 0, dmg, weapon: 'stinger' });
        if (player.hp <= 0) {
          player.alive = false; player.d++;
          this.broadcast({ type: 'kill', killer: b.id, kname: b.name, victim: player.id, vname: player.name, head: false });
          player.respawnAt = now + 3500;
        }
      }
    }
  }
  botSnapshot(this);
};

export { GameRoom };
export default worker;
