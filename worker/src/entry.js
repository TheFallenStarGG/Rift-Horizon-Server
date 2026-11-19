import baseWorker, { GameRoom } from './bot-lifecycle.js';
import { installAccountHooks, handleApi, authToken, assertNotBanned } from './accounts.js';
import { ClipStore, ClipIndex, handleClips } from './clips.js';

installAccountHooks(GameRoom);
export { GameRoom, ClipStore, ClipIndex };

const API_PATH = /^\/api\/(auth\/|lb$|score$|mod\/)/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/rec/') || url.pathname.startsWith('/rec/')) {
      const r = await handleClips(request, env);
      if (r) return r;
    }

    if (API_PATH.test(url.pathname)) return handleApi(request, env, url);

    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      url.searchParams.delete('aid');
      const tk = url.searchParams.get('tk');
      const did = (url.searchParams.get('did') || '').slice(0, 80);
      url.searchParams.delete('tk');
      // ban check for everyone (guests included) by IP + device
      const banned = await assertNotBanned(env, request, { device: did }).catch(() => null);
      if (banned) {
        return new Response(JSON.stringify({ error: 'banned', reason: banned.reason }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (tk) {
        const acct = await authToken(env, tk).catch(() => null);
        if (acct) {
          if (String(acct.username).toLowerCase() !== 'thefallenstargg') {
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
      return baseWorker.fetch(new Request(url.toString(), request), env, ctx);
    }
    return baseWorker.fetch(request, env, ctx);
  },
};
