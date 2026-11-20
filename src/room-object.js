// A shared project's room on Cloudflare (#4541): a Durable Object, one per room, that runs the room's logic of Silinx's
// relay (src/core/collab-room.js: core/'s, copied as it is) over the WebSockets its Worker (src/worker.js) gives it. It
// uses the WebSocket Hibernation API: a room whose participants send nothing for a while sleeps, its sockets kept open
// by Cloudflare, and costs no duration; what each socket is (its role, its room, its client id, the owner's secrets)
// is in the socket's attachment, and the room is made again from them when a message wakes it. What it checks, the
// room's checks besides:
// - frames: RELAY_LIMITS, by role (a follower's frame larger than theirs closes its connection, 1009); Cloudflare's own
//   limit on a message received (32 MiB) is past the owner's;
// - one room per object (its name, the room's id, which the Worker chose: an owner's open is its room's only one).
// An object named by a meeting point's topic (#4542, `meet.<topic>`) runs that meeting point instead
// (src/core/collab-meeting.js: a hosted room's owner's page and its followers, their signalling and their messages
// until a direct path connects).
import { collabRooms, ROOM_LIMITS } from './core/collab-room.js';
import { collabMeetings, MEET_LIMITS } from './core/collab-meeting.js';
import { SUBPROTOCOL } from './core/collab-wire.js';

/** The relay's limits: Silinx's relay's (server/collab-relay.js RELAY_LIMITS: the frames by role, an owner's room kept
 *  2 minutes for its resume), one room per object. */
export const RELAY_LIMITS = Object.freeze({ ownerFrame: 16 << 20, followerFrame: 64 << 10, ...ROOM_LIMITS, grace: 120_000, rooms: 1 });
const MEETING = new Set(['host', 'peer']);

// (a frame's size: a text's in UTF-8, as the WebSocket carried it)
const sizeOf = d => (typeof d === 'string' ? new TextEncoder().encode(d).length : d.byteLength);
// (bytes as a WebSocket sends them: a view's own bytes only)
const bytesOf = d => (typeof d === 'string' || (d.byteOffset === 0 && d.byteLength === d.buffer.byteLength) ? d : d.slice());

export class RelayRoom {
  constructor(ctx, env, { limits = RELAY_LIMITS } = {}) {
    this.ctx = ctx;
    this.limits = limits;
    this.room = null;
    this.ends = new Map();   // a socket's id (its attachment's) -> { id, role, ws (the latest object of it), p }
    this.host = collabRooms({
      limits,
      newRoom: () => this.room,
      keep: (s, state) => { s.ws.serializeAttachment({ ...s.ws.deserializeAttachment(), state }); },
    });
    this.meet = collabMeetings({ limits: { ...MEET_LIMITS, ...limits.meet }, keep: (s, state) => { s.ws.serializeAttachment({ ...s.ws.deserializeAttachment(), state }); } });
    // (awake again: the room made from what its sockets are; a socket with none, one whose first message had not
    // come, as new)
    const entries = [], meeting = [];
    for (const ws of ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (!a?.id) { ws.close(1011, 'lost'); continue; }
      this.room ??= a.room ?? null;
      const s = this.end(ws, a);
      if (a.state) (MEETING.has(a.role) ? meeting : entries).push([s, a.state]);
      else s.p = MEETING.has(a.role) ? this.meet.welcome(s, a.role, a.room) : this.host.welcome(s, a.role);
    }
    for (const [s, p] of [...this.host.restore(entries), ...this.meet.restore(meeting)]) s.p = p;
    for (const s of this.ends.values()) if (!s.p) { this.ends.delete(s.id); s.ws.close(1011, 'lost'); }
  }

  // a socket as the room's logic takes it: send(data), close(code, reason), readyState
  end(ws, { id, role }) {
    const s = {
      id, role, ws, p: null,
      get readyState() { return s.ws.readyState ?? 1; },
      send: d => { try { s.ws.send(bytesOf(d)); } catch { /* closed meanwhile */ } },
      close: (code, reason) => { try { s.ws.close(code, reason); } catch { /* closed already */ } },
    };
    this.ends.set(id, s);
    return s;
  }

  // the socket of an event (its object may be another than the one before a sleep)
  find(ws) {
    const s = this.ends.get(ws.deserializeAttachment()?.id);
    if (s) s.ws = ws;
    return s;
  }

  /** A participant's WebSocket, from the Worker: its role and room in its headers. */
  async fetch(req) {
    const role = req.headers.get('x-silinx-role');
    if (!['owner', 'follower', ...MEETING].includes(role)) return new Response('not found', { status: 404 });
    this.room ??= req.headers.get('x-silinx-room');
    const [client, server] = Object.values(new WebSocketPair());
    const id = crypto.randomUUID();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, role, room: this.room });
    const s = this.end(server, { id, role });
    s.p = MEETING.has(role) ? this.meet.welcome(s, role, this.room) : this.host.welcome(s, role);
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': SUBPROTOCOL } });
  }

  webSocketMessage(ws, data) {
    const s = this.find(ws);
    if (!s?.p) { ws.close(1011, 'lost'); return; }
    if (sizeOf(data) > (s.role === 'owner' || s.role === 'host' ? this.limits.ownerFrame : s.role === 'peer' ? MEET_LIMITS.peerFrame + 64 : this.limits.followerFrame)) {
      s.close(1009, 'a message too large');
      this.gone(s);
      return;
    }
    s.p.message(typeof data === 'string' ? data : new Uint8Array(data), typeof data !== 'string');
  }

  webSocketClose(ws) { const s = this.find(ws); if (s) this.gone(s); }

  webSocketError(ws) { this.webSocketClose(ws); }

  gone(s) {
    if (!this.ends.delete(s.id)) return;
    s.p?.close();
  }
}
