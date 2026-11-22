import baseWorker, { GameRoom } from './bot-lifecycle.js';
import { installAccountHooks, handleApi, authToken, assertNotBanned } from './accounts.js';
import { ClipStore, ClipIndex, handleClips } from './clips.js';
import { installAntiCheat, handleAcApi, checkPass, gateMode } from './anticheat.js';

installAccountHooks(GameRoom);
installAntiCheat(GameRoom); // last: its onMessage wrapper runs first
export { GameRoom, ClipStore, ClipIndex };

const API_PATH = /^\/api\/(auth\/|lb$|score$|mod\/)/;
const OWNER_LC = 'thefallenstargg';

/** a websocket that says why it was refused and closes (a plain 403 gives the browser no readable reason) */
function denied(reason) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.send(JSON.stringify({ type: 'denied', reason }));
  server.close(4003, 'integrity');
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/rec/') || url.pathname.startsWith('/rec/')) {
      const r = await handleClips(request, env);
      if (r) return r;
    }

    if (url.pathname.startsWith('/api/ac/')) return handleAcApi(request, env, url);
    if (API_PATH.test(url.pathname)) return handleApi(request, env, url);

    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      url.searchParams.delete('aid');
      url.searchParams.delete('acx'); // only this file may set it
      const tk = url.searchParams.get('tk');
      const did = (url.searchParams.get('did') || '').slice(0, 80);
      const pass = url.searchParams.get('ac') || '';
      url.searchParams.delete('tk');
      url.searchParams.delete('ac');
      // ban check for everyone (guests included) by IP + device
      const banned = await assertNotBanned(env, request, { device: did }).catch(() => null);
      if (banned) {
        return new Response(JSON.stringify({ error: 'banned', reason: banned.reason }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      let owner = false;
      if (tk) {
        const acct = await authToken(env, tk).catch(() => null);
        if (acct) {
          owner = String(acct.username).toLowerCase() === OWNER_LC;
          if (!owner) {
            const b2 = await assertNotBanned(env, request, { device: did, username: acct.username }).catch(() => null);
            if (b2) {
              return new Response(JSON.stringify({ error: 'banned', reason: b2.reason }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' },
              });
            }
          }
          url.searchParams.set('name', acct.username);
          url.searchParams.set('aid', String(acct.id));
        }
      }
      // build signature: unmodified client files only (the owner account is exempt so dev tools keep working)
      if (owner) url.searchParams.set('acx', '1');
      else {
        const gate = gateMode(env);
        if (gate !== 'off') {
          const r = await checkPass(env, pass, did).catch(() => ({ ok: false, reason: 'error' }));
          if (!r.ok) {
            if (gate === 'enforce') return denied(r.reason);
            console.warn('[ac] join without a valid pass (warn mode):', r.reason, did);
          }
        }
      }
      return baseWorker.fetch(new Request(url.toString(), request), env, ctx);
    }
    return baseWorker.fetch(request, env, ctx);
  },
};
