// A relay of Silinx's shared projects on Cloudflare Workers (#4541): the endpoints of Silinx's own relay
// (server/collab-relay.js), /api/collab/share (the owner) and /api/collab/follow (a follower), each room's WebSockets
// given to that room's Durable Object (src/room-object.js), which runs the room's logic of Silinx's relay. It reads
// none of a room's messages (they are encrypted with the link's key, which it never sees). What it checks, before a
// WebSocket reaches a room:
// - the page's origin: one of ORIGINS (the Silinx sites whose pages use it; a WebSocket with no origin, a program's,
//   as the MCP server's, let in), as a Silinx server's relay.origins;
// - opening a room needs the relay's key (its secret RELAY_KEY, in the subprotocols: `silinx-collab`, `token.<key>`),
//   as a Silinx server's relay.key; joining one needs its room's id (`?room=`, core/collab-wire.js roomUrl);
// - the subprotocol, `silinx-collab`.
// Its root (GET /) answers what it is to any page, with the origins it lets in (#4574).
// The owner's open gets a new room (its id chosen here: the Durable Object's name); its resume (#3835) names its room.
// Its meeting points (#4542): /api/collab/meet/host (a hosted room's owner's page: the relay's key, as an owner's) and
// /api/collab/meet/peer (a follower), with their topic (`?topic=`, TOPIC_RE), each topic's sockets to the object
// `meet.<topic>`; an owner or a follower names a room's id only (#4736: never a `meet.` object).
import { RelayRoom, RELAY_LIMITS } from './room-object.js';
import { SUBPROTOCOL, ROOM_RE, NOT_SHARED } from './core/collab-wire.js';
import { TOPIC_RE } from './core/collab-meeting.js';
import { b64url } from './core/collab-crypto.js';

export { RelayRoom, RELAY_LIMITS };
const ROLES = { '/api/collab/share': 'owner', '/api/collab/follow': 'follower', '/api/collab/meet/host': 'host', '/api/collab/meet/peer': 'peer' };
/** What an owner without the relay's key is told (its socket closed, 1008). */
export const NEEDS_KEY = 'sharing a project needs this relay\'s key';
export const NO_KEY = 'this relay has no key (its RELAY_KEY secret, 24 characters at least): it opens no room';
const KEY_MIN = 24;   // (a Silinx server's relay.key's minimum)
/** What its root answers, to any page (#4574: Silinx's check of a relay, core/relay-setup.js), with the origins it lets in
 *  (`Silinx-Origins`), so that a page refused can say why. */
export const ABOUT = 'A relay of Silinx\'s shared projects (live sharing): https://github.com/pmnmalo/Silinx\n';

/** The origins a relay lets in: its ORIGINS, separated by commas or spaces. */
export const originsOf = text => String(text || '').split(/[\s,]+/).filter(Boolean).map(o => o.replace(/\/+$/, ''));

// (two keys compared in a time that does not depend on where they differ: their hashes, byte by byte)
async function sameKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  const h = async t => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)));
  const [x, y] = [await h(a), await h(b)];
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

// a participant refused once its WebSocket is open: the reason said, its connection closed, as Silinx's relay does
function refused(message) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.send(JSON.stringify({ type: 'error', message }));
  server.close(1008, 'refused');
  return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': SUBPROTOCOL } });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/' && req.method === 'GET') {
      return new Response(ABOUT, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Silinx-Origins', 'Silinx-Origins': originsOf(env.ORIGINS).join(' '), 'Cache-Control': 'no-store' } });
    }
    const role = Object.hasOwn(ROLES, url.pathname) ? ROLES[url.pathname] : null;
    if (!role) return new Response('not found', { status: 404 });
    if (String(req.headers.get('Upgrade')).toLowerCase() !== 'websocket') return new Response('a WebSocket only', { status: 426 });
    const origin = req.headers.get('Origin');
    if (origin && !originsOf(env.ORIGINS).includes(origin)) return new Response('cross-origin request refused', { status: 403 });
    const protocols = String(req.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(s => s.trim());
    if (!protocols.includes(SUBPROTOCOL)) return new Response('not a Silinx participant', { status: 400 });
    let room = url.searchParams.get('room');
    if (role === 'host' || role === 'peer') {
      const topic = url.searchParams.get('topic');
      if (!TOPIC_RE.test(String(topic))) return new Response('not found', { status: 404 });
      if (role === 'host' && String(env.RELAY_KEY || '').length < KEY_MIN) return refused(NO_KEY);
      if (role === 'host' && !await sameKey(protocols.find(p => p.startsWith('token.'))?.slice(6), env.RELAY_KEY)) return refused(NEEDS_KEY);
      room = `meet.${topic}`;
    } else if (role === 'owner') {
      if (String(env.RELAY_KEY || '').length < KEY_MIN) return refused(NO_KEY);
      if (!await sameKey(protocols.find(p => p.startsWith('token.'))?.slice(6), env.RELAY_KEY)) return refused(NEEDS_KEY);
      // (an open: a new room; a resume: its own)
      if (room === null) room = b64url(crypto.getRandomValues(new Uint8Array(16)));
    }
    // (#4736: an owner's or a follower's room is a room's id, never a meeting point's object, which only its host and
    // peers reach, by their checked topic)
    if (role !== 'host' && role !== 'peer' && !ROOM_RE.test(String(room))) return refused(NOT_SHARED);
    const headers = new Headers(req.headers);
    headers.set('x-silinx-role', role);
    headers.set('x-silinx-room', room);
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(new Request(req.url, { headers }));
  },
};
