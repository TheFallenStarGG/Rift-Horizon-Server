import baseWorker, { GameRoom } from './bot-lifecycle.js';
import { installAccountHooks, handleApi, authToken } from './accounts.js';

installAccountHooks(GameRoom);
export { GameRoom };

const API_PATH = /^\/api\/(auth\/|lb$|score$)/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (API_PATH.test(url.pathname)) return handleApi(request, env, url);

    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      // never trust a client-supplied account id; only a verified token sets it
      url.searchParams.delete('aid');
      const tk = url.searchParams.get('tk');
      url.searchParams.delete('tk');
      if (tk) {
        const acct = await authToken(env, tk).catch(() => null);
        if (acct) {
          url.searchParams.set('name', acct.username);
          url.searchParams.set('aid', String(acct.id));
        }
      }
      return baseWorker.fetch(new Request(url.toString(), request), env, ctx);
    }
    return baseWorker.fetch(request, env, ctx);
  },
};
