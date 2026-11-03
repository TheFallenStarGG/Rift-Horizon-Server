import worker, { GameRoom } from './index.js';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const random = (lo, hi) => lo + Math.random() * (hi - lo);

/** Same points as index.js — must live here because BOT_SPAWNS is not exported from index. */
const BOT_SPAWNS = [
  { x: 320, y: 0, z: 280 }, { x: -340, y: 0, z: 260 }, { x: 300, y: 0, z: -310 }, { x: -290, y: 0, z: -330 },
  { x: 420, y: 0, z: 40 }, { x: -410, y: 0, z: -60 }, { x: 50, y: 0, z: 430 }, { x: -70, y: 0, z: -440 },
  { x: 380, y: 0, z: 180 }, { x: -360, y: 0, z: 200 }, { x: 200, y: 0, z: -390 }, { x: -220, y: 0, z: -370 },
  { x: 480, y: 0, z: -120 }, { x: -470, y: 0, z: 140 }, { x: 140, y: 0, z: 490 }, { x: -160, y: 0, z: -480 },
  { x: 250, y: 0, z: 400 }, { x: -270, y: 0, z: -410 }, { x: 400, y: 0, z: -280 }, { x: -390, y: 0, z: 300 },
];

function resetFollower(b, x, z) {
  b.x = x; b.y = 0; b.z = z;
  b.hp = 100; b.alive = true; b.respawnAt = 0; b.waitingForLeader = false;
  b.order = null;
  b.destX = x + random(-18, 18); b.destZ = z + random(-18, 18);
  b.ammo = b.mag || 30; b.reloading = false; b.reloadAt = 0;
  b.fireCd = random(0, 0.4); b.state = 'patrol'; b.ads = false; b.moving = false;
  b.freeWillUntil = 0; b.coverUntil = 0; b.lastHurtAt = 0;
  b.leaderThreatUntil = 0;
  b.strafeDir = Math.random() < 0.5 ? 1 : -1;
}

function botSnapshot(room) {
  room.broadcast({
    type: 'bots',
    list: room.bots.map((b) => ({
      id: b.id, team: b.team, name: b.name, x: b.x, z: b.z, yaw: b.yaw,
      hp: b.hp, alive: b.alive, moving: !!b.moving, ads: !!b.ads,
      reloading: !!b.reloading, ammo: b.ammo ?? 30, state: b.state || 'patrol',
    })),
  });
}

GameRoom.prototype.wipeBotTeam = function (team) {
  if (!this.cfg?.botArena) return;
  for (const b of this.bots) {
    if (b.team !== team) continue;
    b.hp = 0; b.alive = false; b.waitingForLeader = true; b.respawnAt = 0;
    b.order = null; b.state = 'waiting_for_leader'; b.ads = false; b.moving = false;
    b.reloading = false; b.freeWillUntil = 0; b.coverUntil = 0;
  }
  botSnapshot(this);
};

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

GameRoom.prototype.reactBotLeaderHit = function (team, x, z) {
  if (!this.cfg?.botArena) return;
  const now = Date.now();
  for (const b of this.bots) {
    if (b.team !== team || !b.alive) continue;
    b.leaderThreatUntil = now + 4500;
    b.leaderThreatX = x; b.leaderThreatZ = z;
    b.freeWillUntil = 0;
    b.state = 'protect_leader';
    b.order = { type: 'attack', x, z, targetId: 'player', t: now };
    b.strafeDir = Math.random() < 0.5 ? -1 : 1;
  }
};

// Accept both the dedicated event and the order-wrapped client protocol.
const onMessage = GameRoom.prototype.onMessage;
GameRoom.prototype.onMessage = function (session, msg) {
  if (msg?.type === 'bot_leader_hit') {
    this.reactBotLeaderHit(msg.team | 0, Number(msg.x) || 0, Number(msg.z) || 0);
    return;
  }
  if (msg?.type === 'bot_team_wipe') {
    this.wipeBotTeam(msg.team | 0);
    return;
  }
  return onMessage.call(this, session, msg);
};

const applyBotOrder = GameRoom.prototype.applyBotOrder;
GameRoom.prototype.applyBotOrder = function (msg) {
  const order = msg?.order;
  if (order?.type === 'leader_hit') {
    this.reactBotLeaderHit(msg.team | 0, Number(order.x) || 0, Number(order.z) || 0);
    return;
  }
  return applyBotOrder.call(this, msg);
};

const hitBot = GameRoom.prototype.hitBot;
GameRoom.prototype.hitBot = function (msg, attacker) {
  const b = this.bots.find((bot) => bot.id === msg.id);
  const wasAlive = !!b?.alive;
  hitBot.call(this, msg, attacker);
  if (!b || !wasAlive) return;

  const now = Date.now();
  if (b.alive) {
    b.lastHurtAt = now;
    b.coverUntil = now + random(1800, 3200);
    b.freeWillUntil = 0;
    b.strafeDir = Math.random() < 0.5 ? -1 : 1;
    b.state = 'under_fire';
    if (attacker && attacker.alive) {
      b.order = { type: 'attack', x: attacker.x, z: attacker.z, targetId: 'player', t: now };
      b.destX = attacker.x;
      b.destZ = attacker.z;
      // Squad reacts when one member is shot
      for (const mate of this.bots) {
        if (mate === b || mate.team !== b.team || !mate.alive) continue;
        if (Math.random() < 0.75) {
          mate.order = { type: 'attack', x: attacker.x, z: attacker.z, targetId: 'player', t: now };
          mate.state = 'engage';
          mate.freeWillUntil = 0;
          mate.lastHurtAt = mate.lastHurtAt || now;
        }
      }
    }
  }
};

function pickCover(room, bot, threatX, threatZ) {
  const dx = threatX - bot.x, dz = threatZ - bot.z, len2 = dx * dx + dz * dz;
  if (len2 < 1) return null;
  let best = null, bestScore = Infinity;
  const builds = room.builds;
  if (!builds || typeof builds.values !== 'function') return null;
  for (const piece of builds.values()) {
    const s = piece.spec;
    if (!s || s.type !== 'wall') continue;
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
    b.x += (dx / d) * step;
    b.z += (dz / d) * step;
    b.yaw = Math.atan2(-dx, -dz);
    b.moving = true;
  } else {
    b.moving = false;
  }
}

GameRoom.prototype.tickBots = function () {
  if (!this.cfg?.botArena || !this.bots.length) return;
  const now = Date.now();
  const dt = 0.2;

  let player = null;
  for (const s of this.sessions.values()) {
    if (s.alive) { player = s; break; }
  }

  for (const b of this.bots) {
    if (!b.alive) {
      if (b.waitingForLeader) continue;
      if (b.respawnAt && now >= b.respawnAt) {
        const sp = BOT_SPAWNS[Math.floor(Math.random() * BOT_SPAWNS.length)];
        resetFollower(
          b,
          sp.x + random(-20, 20),
          sp.z + random(-20, 20),
        );
      }
      continue;
    }

    b.fireCd = Math.max(0, (b.fireCd || 0) - dt);

    // Reload
    if (b.reloading) {
      if (now >= (b.reloadAt || 0)) {
        b.ammo = b.mag || 30;
        b.reloading = false;
      }
    } else if ((b.ammo ?? 0) <= 0) {
      b.reloading = true;
      b.reloadAt = now + 1800 + Math.floor(Math.random() * 600);
    }

    const pd = player ? dist(b.x, b.z, player.x, player.z) : 9999;
    const order = b.order;
    const free = now < (b.freeWillUntil || 0);
    const underFire = now < (b.coverUntil || 0);
    const protect = now < (b.leaderThreatUntil || 0);

    let tx = b.destX, tz = b.destZ, speed = 2.6;

    // --- priority: under fire / protect leader / engage player ---
    if (player && (underFire || protect || (order && order.targetId === 'player') || pd < 48)) {
      const threatX = player.x;
      const threatZ = player.z;
      const ang = Math.atan2(player.x - b.x, player.z - b.z);

      if (underFire || (b.hp < 45 && pd < 40)) {
        const cover = pickCover(this, b, threatX, threatZ);
        if (cover) {
          tx = cover.x; tz = cover.z; speed = 4.2;
          b.state = 'cover';
        } else {
          // peel away then re-engage
          tx = b.x - Math.sin(ang) * 16;
          tz = b.z - Math.cos(ang) * 16;
          speed = 4.0;
          b.state = 'under_fire';
        }
      } else if (protect) {
        // form on leader threat point, then push player
        const lx = b.leaderThreatX ?? threatX;
        const lz = b.leaderThreatZ ?? threatZ;
        if (dist(b.x, b.z, lx, lz) > 22) {
          tx = lx + random(-6, 6); tz = lz + random(-6, 6); speed = 4.0;
          b.state = 'protect_leader';
        } else {
          const radius = pd < 14 ? 16 : 12;
          tx = player.x + Math.cos(ang) * b.strafeDir * 7 - Math.sin(ang) * radius;
          tz = player.z - Math.sin(ang) * b.strafeDir * 7 - Math.cos(ang) * radius;
          speed = 3.6;
          b.state = 'engage';
        }
      } else {
        const radius = pd < 12 ? 17 : 12;
        tx = player.x + Math.cos(ang) * b.strafeDir * 8 - Math.sin(ang) * radius;
        tz = player.z - Math.sin(ang) * b.strafeDir * 8 - Math.cos(ang) * radius;
        speed = 3.6;
        b.state = 'engage';
      }
    } else {
      // free will / follow order / patrol
      if (!free && now > (b.freeWillUntil || 0) && Math.random() < 0.018) {
        b.freeWillUntil = now + random(1600, 3200);
        b.strafeDir = Math.random() < 0.5 ? -1 : 1;
        const ax = order ? order.x : b.destX;
        const az = order ? order.z : b.destZ;
        b.destX = ax + random(-12, 12);
        b.destZ = az + random(-12, 12);
        b.state = 'free_will';
      }
      if (order && free) {
        tx = b.destX; tz = b.destZ; speed = 2.8;
      } else if (order) {
        tx = order.x; tz = order.z; speed = 3.1;
        b.state = 'follow';
      } else {
        if (dist(b.x, b.z, b.destX || b.x, b.destZ || b.z) < 4) {
          const sp = BOT_SPAWNS[Math.floor(Math.random() * BOT_SPAWNS.length)];
          b.destX = sp.x + random(-28, 28);
          b.destZ = sp.z + random(-28, 28);
        }
        tx = b.destX; tz = b.destZ; speed = 2.9;
        b.state = 'patrol';
      }
    }

    if (b.reloading) {
      // keep moving to cover dest while reloading
      speed = Math.min(speed, 2.0);
    }

    moveBot(b, tx, tz, speed, dt);

    // Face + fire
    b.ads = false;
    const canShoot =
      player &&
      !b.reloading &&
      (b.ammo ?? 0) > 0 &&
      b.fireCd <= 0 &&
      pd > 3 &&
      pd < 45 &&
      (b.state === 'engage' || b.state === 'cover' || b.state === 'under_fire' || b.state === 'protect_leader');

    if (canShoot) {
      b.yaw = Math.atan2(-(player.x - b.x), -(player.z - b.z));
      b.ads = pd > 12;
      b.fireCd = 0.28 + Math.random() * 0.26;
      b.ammo = Math.max(0, (b.ammo ?? 30) - 1);

      const ordered = order && order.targetId === 'player';
      const spread = 0.04 + pd * 0.0025 + (b.moving ? 0.035 : 0);
      this.broadcast({
        type: 'bot_shoot',
        id: b.id,
        x: b.x, y: 1.4, z: b.z,
        dx: player.x - b.x + random(-spread * pd, spread * pd),
        dy: 1 + random(-0.15, 0.15),
        dz: player.z - b.z + random(-spread * pd, spread * pd),
      });

      const hitChance = Math.max(
        0.1,
        (ordered || protect ? 0.42 : 0.34) - pd / 150 - (b.moving ? 0.04 : 0),
      );
      if (Math.random() < hitChance) {
        const dmg = 8 + Math.floor(Math.random() * 8); // 8–15
        player.hp = Math.max(0, player.hp - dmg);
        this.send(player.ws, {
          type: 'damage',
          from: b.id,
          hp: player.hp,
          alive: player.hp > 0,
          dmg,
          weapon: 'stinger',
        });
        if (player.hp <= 0) {
          player.alive = false;
          player.d++;
          this.broadcast({
            type: 'kill',
            killer: b.id,
            kname: b.name,
            victim: player.id,
            vname: player.name,
            head: false,
          });
          player.respawnAt = now + 3500;
        }
      }
    }
  }

  botSnapshot(this);
};

export { GameRoom };
export default worker;
