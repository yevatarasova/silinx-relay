// A relay's meeting points (#4542): where the page that hosts a shared project (#3227, core/collab-loop.js) and its
// followers find each other through a relay (Silinx's, server/collab-relay.js, or the Cloudflare relay), as at the
// public trackers' meeting point (core/collab-meet.js) but on a relay of the user's settings; the relay carries their
// WebRTC signalling, and their messages as long as no direct path connects (core/collab-meet-relay.js, the
// participants' side). Like a room (core/collab-room.js), it reads no message: each is sealed with the link's key.
// What it checks:
// - a topic (a hash of the room's id, core/collab-meet.js meetTopic) has one host, the owner's page, whose socket came
//   with the relay's token or key (checked by its platform); a peer joins a topic that has a host only;
// - a peer's messages go to the host only, marked with the peer's id; the host's go to the peer it names;
// - the first message (`hello`, this version), its time; peers per topic; a peer's message's size and rate.
// The messages: text, JSON: a participant's { type: 'hello', v } -> { type: 'welcome', self, host } (ids); the host is
// told { type: 'peer', id } and { type: 'leave', id }; a peer { type: 'leave', id } when the host leaves (and is closed);
// { type: 'error', message }. Binary: [id, 16 bytes][a sealed message]: the host's to that peer, a peer's to the host
// (its id field ignored), each delivered with the sender's id in it.
// A participant is a socket, as a room's; `keep(socket, state)` and `restore([[socket, state], …])` as a room's (a
// platform whose meeting points sleep: the Cloudflare relay's Durable Objects).
import { b64url } from './collab-crypto.js';

export const MEET_PROTOCOL = 1;
export const ID_BYTES = 16;
/** A meeting point's topic (core/collab-meet.js meetTopic: 32 characters of base64url). */
export const TOPIC_RE = /^[A-Za-z0-9_-]{32}$/;
/** The limits: peers per topic, a peer's message (a hosted room's follower frame, sealed, in parts or whole: its
 *  room's own limit), its rate after a burst, the time to the first message. */
export const MEET_LIMITS = Object.freeze({ peers: 64, peerFrame: (64 << 10) + 1024, peerRate: 50, peerBurst: 200, helloWait: 10_000 });
export const NO_HOST = 'the owner was not found at the relay\'s meeting point (is the project still shared?)';
export const HOST_THERE = 'this project has a host at the relay\'s meeting point already';
export const NOT_MEETING = 'not a Silinx meeting point\'s participant of this version';
export const PEER_DROPPED = 'this follower\'s messages come too fast: some were not passed on';

const json = (ws, msg) => { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); };
const refuse = (ws, message) => { json(ws, { type: 'error', message }); ws.close(1008, 'refused'); };
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

/** Meeting points: { topics (Map: topic -> { host, hostId, peers: Map<id, socket> }), welcome(socket, role, topic)
 *  -> { message(data, binary), close() }, restore(entries) -> Map<socket, handlers> }. role: 'host' | 'peer'. */
export function collabMeetings({ limits = MEET_LIMITS, now = Date.now, keep = () => {} } = {}) {
  limits = { ...MEET_LIMITS, ...limits };
  const topics = new Map();
  const newId = () => b64url(crypto.getRandomValues(new Uint8Array(ID_BYTES)));
  const stamped = (id, payload) => { const out = new Uint8Array(ID_BYTES + payload.length); out.set(unb64(id)); out.set(payload, ID_BYTES); return out; };

  function welcome(ws, role, topic, state = null) {
    let me = state && { role: state.role, topic: state.topic, id: state.id };
    let tokens = limits.peerBurst, filled = now(), dropped = false;
    const rateOk = () => {
      const t = now();
      tokens = Math.min(limits.peerBurst, tokens + Math.max(0, t - filled) * limits.peerRate / 1000);
      filled = t;
      if (tokens >= 1) { tokens--; return true; }
      if (!dropped) { dropped = true; json(ws, { type: 'error', message: PEER_DROPPED }); }
      return false;
    };
    const hello = me ? null : setTimeout(() => { if (!me) refuse(ws, NOT_MEETING); }, limits.helloWait);
    const message = (data, binary) => {
      if (!me) {
        let msg = null;
        if (!binary) { try { msg = JSON.parse(String(data)); } catch { /* below */ } }
        clearTimeout(hello);
        if (msg?.type !== 'hello' || msg.v !== MEET_PROTOCOL) return refuse(ws, NOT_MEETING);
        const t = topics.get(topic);
        if (role === 'host') {
          if (t) return refuse(ws, HOST_THERE);
          me = { role, topic, id: newId() };
          topics.set(topic, { host: ws, hostId: me.id, peers: new Map() });
          keep(ws, me);
          return json(ws, { type: 'welcome', self: me.id, host: me.id });
        }
        if (!t?.host) return refuse(ws, NO_HOST);
        if (t.peers.size >= limits.peers) return refuse(ws, `this shared project has ${limits.peers} followers already`);
        me = { role, topic, id: newId() };
        t.peers.set(me.id, ws);
        keep(ws, me);
        json(ws, { type: 'welcome', self: me.id, host: t.hostId });
        return json(t.host, { type: 'peer', id: me.id });
      }
      const t = topics.get(me.topic);
      if (!binary || !t) return;
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (bytes.length <= ID_BYTES) return;
      if (me.role === 'host') {
        if (t.host !== ws) return;
        const to = t.peers.get(b64url(bytes.subarray(0, ID_BYTES)));
        if (to?.readyState === 1) to.send(stamped(t.hostId, bytes.subarray(ID_BYTES)), { binary: true });
        return;
      }
      if (bytes.length > limits.peerFrame || !rateOk()) return;
      if (t.host?.readyState === 1) t.host.send(stamped(me.id, bytes.subarray(ID_BYTES)), { binary: true });
    };
    const close = () => {
      clearTimeout(hello);
      if (!me) return;
      const t = topics.get(me.topic);
      if (!t) return;
      if (me.role === 'host') {
        if (t.host !== ws) return;
        topics.delete(me.topic);
        for (const p of t.peers.values()) { json(p, { type: 'leave', id: t.hostId }); p.close(1000, 'closed'); }
        return;
      }
      if (t.peers.get(me.id) === ws && t.peers.delete(me.id)) json(t.host, { type: 'leave', id: me.id });
    };
    return { message, close };
  }

  // the meeting points again from what their sockets are (a platform's, awake): each host's, then its peers; a peer
  // whose host is not among them told it left
  function restore(entries) {
    const out = new Map();
    for (const [ws, s] of entries) {
      if (s?.role !== 'host' || topics.has(s.topic)) continue;
      topics.set(s.topic, { host: ws, hostId: s.id, peers: new Map() });
      out.set(ws, welcome(ws, 'host', s.topic, s));
    }
    for (const [ws, s] of entries) {
      if (s?.role !== 'peer') continue;
      const t = topics.get(s.topic);
      if (!t) { json(ws, { type: 'leave', id: null }); ws.close(1000, 'closed'); continue; }
      t.peers.set(s.id, ws);
      out.set(ws, welcome(ws, 'peer', s.topic, s));
    }
    return out;
  }

  return { topics, welcome, restore };
}
