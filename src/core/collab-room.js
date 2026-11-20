// A shared project's rooms (#3180, #3181, #3227: out of server/collab-relay.js, the server's relay, so that the owner's
// page can host its room too, the browser edition's): who owns each room, its followers, and what passes between them.
// It reads no message (they are sealed with the link's key, which it never sees). What it checks:
// - a participant's first message: an owner's `open` (a new room), a follower's `join` (a room's id), of this version,
//   with a client id of its own (#3360: not the owner's nor another follower's);
// - the owner's frames go to every follower, but one it addresses to a follower (#3529: the whole document a join asks
//   for), which goes to that follower only;
// - only the owner's updates are forwarded: a follower's are dropped and answered with an error (read only), only
//   their awareness (who they are, what they look at) goes through, marked with the client id they joined with (#3360:
//   a follower's awareness speaks for that follower only, never for the owner nor another); and, when the owner lets editors in (its open
//   gives the room's public key, #3182), an editor's edits whose signature is the room's (core/collab-sign.js),
//   each sender's in its order; the owner's rekey (#3997: an editor demoted) makes another key the room's;
// - followers per room, rooms per host, the time to the first message, a follower's awareness's size and rate (#4173);
// - an editor's edits (#4736): their rate (a token bucket), the ones waiting for their signature's check, the signatures
//   that are not the room's (past `editsBad`, or `editsPending` waiting, or faster than the bucket: closed, 1008); a
//   follower's frames in a room without editors dropped at once (the follower told once); an edit already passed (the
//   same session's counter, core/collab-sign.js editsSeen) dropped: a replay goes no further;
// - a room ends with its owner: at once when it stops sharing; its connection lost, after `limits.grace` (#3835: 0, at
//   once, but on the relay), in which the owner resumes it with the secret its open was answered with (`resume`, a
//   connection of its own, the relay's token again): its followers stay, and each is a join again for the owner (the
//   whole document sent again); past it, its followers are told and closed. Its followers are told it is away
//   (#4850: { type: 'away', grace }, a follower joining meanwhile too) and back ({ type: 'back' }) once it resumed.
// A participant is a socket: send(data, { binary }), close(code, reason), readyState (1: open), as a WebSocket of
// `ws`; its transport gives each message to `message(data, binary)` (binary: a Uint8Array, or a Buffer) and its end to
// `close()`. A platform whose rooms sleep (#4541: the Cloudflare relay's Durable Objects, whose memory is lost while
// their sockets stay open) keeps what each socket is (`keep(socket, state)`, at each change: { role, room, client }, and
// the owner's { editors, resume }) and gives it back when it wakes (`restore([[socket, state], …])`); it names its room
// (`newRoom()`: the one id its rooms open with).
import { KIND, PROTOCOL, NOT_SHARED, fromFrame, senderOf } from './collab-wire.js';
import { b64url } from './collab-crypto.js';
import { verifierOf, verifyFrame, editsSeen, PUB_RE } from './collab-sign.js';

// (a follower's awareness, #4173: a frame of `awarenessFrame` bytes at most, `awarenessRate` a second after a burst of
// `awarenessBurst`; who they are and what they look at is a few hundred bytes, renewed every 15 s and at each move)
// (an editor's edits, #4736: `editRate` a second after a burst of `editBurst`, a typist's or a paste's far below;
// `editsPending` waiting for their check at most, `editsBad` signatures not the room's at most)
export const ROOM_LIMITS = Object.freeze({ followers: 64, rooms: 32, helloWait: 10_000, grace: 0, awarenessFrame: 8 << 10, awarenessRate: 10, awarenessBurst: 40,
  editRate: 50, editBurst: 200, editsPending: 64, editsBad: 8 });
/** What a follower whose awareness is over the limits is told, once (its frames dropped). */
export const AWARENESS_DROPPED = 'this follower\'s cursor and view come too fast or too large: some were not passed on';
/** A room its owner's connection left (#3835), as its followers are told when it ends. */
export const OWNER_LOST = 'the owner\'s connection was lost';
/** A follower's frames in a room without editors, as it is told once (#4736: dropped). */
export const READ_ONLY = 'read only: a follower cannot change the shared project';
/** What a participant whose edits come too fast, too many at once, or too often not signed with the room's key is told
 *  (its connection closed, #4736). */
export const EDITS_REFUSED = 'too many edits too fast, or not signed with the room\'s key: this connection is closed';

const json = (ws, msg) => { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); };
// (two secrets compared in a time that does not depend on where they differ)
const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
/** A participant refused: the reason said, its connection closed. */
export const fail = (ws, message) => { json(ws, { type: 'error', message }); ws.close(1008, 'refused'); };
const clientId = v => (Number.isSafeInteger(v) && v >= 0 && v <= 0xFFFFFFFF ? v : null);   // (Yjs's: 32 bits)

/** Rooms: { rooms (Map: room -> { owner (null: its connection lost, #3835), ownerClient, followers: Map<socket,
 *  client>, editors (the editors' public key, or null), verify (a promise of the editors' key, or null), resume (its
 *  secret), grace (its timer while lost) }), welcome(socket, role) -> { message(data, binary), close() },
 *  restore([[socket, state], …]) -> Map<socket, { message, close }>, closeRoom(id, reason) }. role: 'owner' |
 *  'follower'. */
export function collabRooms({ limits = ROOM_LIMITS, now = Date.now, newRoom = null, keep = () => {} } = {}) {
  limits = { ...ROOM_LIMITS, ...limits };
  const rooms = new Map();   // room -> { owner, ownerClient, followers: Map<ws, client> }
  const randomId = () => b64url(crypto.getRandomValues(new Uint8Array(16)));
  const verifierFor = pub => { const v = verifierOf(pub); v.catch(() => {}); return v; };
  // (what a socket is, for a platform whose rooms sleep: the owner's with its room's secrets)
  const kept = (ws, me) => { const r = rooms.get(me.room); keep(ws, me.role === 'owner' ? { ...me, editors: r.editors, resume: r.resume } : { ...me }); };

  function closeRoom(id, reason) {
    const r = rooms.get(id);
    if (!r) return;
    rooms.delete(id);
    clearTimeout(r.grace);
    for (const ws of r.followers.keys()) { json(ws, { type: 'closed', reason }); ws.close(1000, 'closed'); }
    // (the owner told why too: its connection's end is no loss to resume, #3835)
    if (r.owner?.readyState === 1) { json(r.owner, { type: 'closed', reason }); r.owner.close(1000, 'closed'); }
  }

  function welcome(ws, role, state = null) {
    let me = state && { role: state.role, room: state.room, client: state.client };   // { role: 'owner' | 'follower', room, client }
    // (a follower's awareness: a token bucket, #4173)
    let tokens = limits.awarenessBurst, filled = now(), dropped = false;
    const awarenessOk = size => {
      const t = now();
      tokens = Math.min(limits.awarenessBurst, tokens + Math.max(0, t - filled) * limits.awarenessRate / 1000);
      filled = t;
      const ok = size <= limits.awarenessFrame && tokens >= 1;
      if (ok) tokens--;
      else if (!dropped) { dropped = true; json(ws, { type: 'error', message: AWARENESS_DROPPED }); }
      return ok;
    };
    // (an editor's edits, #4736: a token bucket, the ones waiting for their check, the signatures refused)
    let editTokens = limits.editBurst, editFilled = now(), pending = 0, bad = 0, toldReadOnly = false;
    const editOk = () => {
      const t = now();
      editTokens = Math.min(limits.editBurst, editTokens + Math.max(0, t - editFilled) * limits.editRate / 1000);
      editFilled = t;
      if (editTokens < 1 || pending >= limits.editsPending) return false;
      editTokens--;
      return true;
    };
    let chain = Promise.resolve();   // (an editor's edits, checked in their order)
    const hello = me ? null : setTimeout(() => { if (!me) fail(ws, 'no open nor join'); }, limits.helloWait);
    const message = (data, binary) => {
      if (!me) {
        let msg = null;
        if (!binary) { try { msg = JSON.parse(String(data)); } catch { /* below */ } }
        if (!msg || msg.v !== PROTOCOL || clientId(msg.client) === null) return fail(ws, 'not a Silinx participant of this version');
        clearTimeout(hello);
        if (!(role === 'owner' ? ['open', 'resume'] : ['join']).includes(msg.type)) return fail(ws, 'not a Silinx participant of this version');
        if (msg.type === 'open') {
          if (rooms.size >= limits.rooms) return fail(ws, `this Silinx server shares ${limits.rooms} projects already`);
          if (msg.editors !== undefined && !PUB_RE.test(String(msg.editors))) return fail(ws, 'not a Silinx participant of this version');
          const editors = msg.editors === undefined ? null : String(msg.editors);
          const room = newRoom ? newRoom() : randomId();
          const resume = randomId();
          rooms.set(room, { owner: ws, ownerClient: msg.client, followers: new Map(), editors, verify: editors && verifierFor(editors), seen: editsSeen(), resume, grace: null });
          me = { role: 'owner', room, client: msg.client };
          kept(ws, me);
          return json(ws, { type: 'opened', room, resume });
        }
        if (msg.type === 'resume') {
          // (#3835: the owner's room resumed, its secret and its client id the open's; a connection of the owner's
          // that the relay has not seen lost yet, replaced; every follower a join again)
          const r = typeof msg.room === 'string' ? rooms.get(msg.room) : null;
          if (!r || !same(msg.resume, r.resume) || msg.client !== r.ownerClient) return fail(ws, NOT_SHARED);
          clearTimeout(r.grace);
          r.grace = null;
          const old = r.owner;
          r.owner = ws;
          if (old?.readyState === 1) old.close(1000, 'resumed');
          me = { role: 'owner', room: msg.room, client: msg.client };
          kept(ws, me);
          json(ws, { type: 'opened', room: msg.room, resume: r.resume });
          // (#4850: the followers told it was away, told it is back)
          for (const [f, client] of r.followers) { if (!old) json(f, { type: 'back' }); json(ws, { type: 'join', client }); }
          return;
        }
        if (msg.type === 'join') {
          const r = typeof msg.room === 'string' ? rooms.get(msg.room) : null;
          if (!r) return fail(ws, NOT_SHARED);
          if (r.followers.size >= limits.followers) return fail(ws, `this shared project has ${limits.followers} followers already`);
          if (msg.client === r.ownerClient || [...r.followers.values()].includes(msg.client)) return fail(ws, 'another participant of this shared project has this client id');
          r.followers.set(ws, msg.client);
          me = { role: 'follower', room: msg.room, client: msg.client };
          kept(ws, me);
          json(ws, { type: 'joined', owner: r.ownerClient });
          // (#4850: a room whose owner is away, its follower told so: the project comes once it is back)
          if (!r.owner) return json(ws, { type: 'away', grace: limits.grace });
          return json(r.owner, { type: 'join', client: msg.client });
        }
        return fail(ws, 'not a Silinx participant of this version');
      }
      const r = rooms.get(me.room);
      if (!r || (me.role === 'owner' && r.owner !== ws)) return;
      if (me.role === 'owner') {
        if (!binary) {
          let msg = null;
          try { msg = JSON.parse(String(data)); } catch { /* ignored */ }
          if (msg?.type === 'close') closeRoom(me.room, 'the owner stopped sharing');
          // (#3997: the editors' key renewed, an editor demoted: the old key's edits refused from now)
          else if (msg?.type === 'rekey' && r.verify && PUB_RE.test(String(msg.editors))) { r.editors = msg.editors; r.verify = verifierFor(msg.editors); kept(ws, me); }
          return;
        }
        // (a frame for one follower: to it only, its mark taken off; to no one when it has left, #3529)
        if (data[0] === KIND.to) {
          const to = senderOf(new Uint8Array(data), KIND.to);
          const f = to && [...r.followers].find(([, c]) => c === to.client)?.[0];
          if (f?.readyState === 1) f.send(to.frame, { binary: true });
          return;
        }
        for (const f of r.followers.keys()) if (f.readyState === 1) f.send(data, { binary: true });
        return;
      }
      if (!binary) return;
      // a follower: their awareness only (small, and not too often: #4173); an edit is refused (read only, #3181)
      const others = () => [r.owner, ...r.followers.keys()].filter(o => o && o !== ws && o.readyState === 1);
      if (data[0] === KIND.awareness) {
        const bytes = new Uint8Array(data);
        if (!awarenessOk(bytes.length)) return;
        const f = fromFrame(me.client, bytes);
        for (const o of others()) o.send(f, { binary: true });
        return;
      }
      // (#4736: in a room without editors, dropped at once, the follower told once)
      if (data[0] !== KIND.edit || !r.verify) { if (!toldReadOnly) { toldReadOnly = true; json(ws, { type: 'error', message: READ_ONLY }); } return; }
      // an editor's edit: forwarded once its signature is the room's (in the order they came), and once only (#4736: a
      // replay dropped); too fast, too many waiting: the connection closed
      if (!editOk()) return fail(ws, EDITS_REFUSED);
      const frame = new Uint8Array(data);
      pending++;
      chain = chain.then(async () => {
        const ok = await verifyFrame(await r.verify, me.room, frame).catch(() => null);
        pending--;
        if (!ok) {
          if (++bad >= limits.editsBad) return fail(ws, EDITS_REFUSED);
          return json(ws, { type: 'error', message: 'read only: this link cannot change the shared project (not an editor\'s)' });
        }
        if (rooms.get(me.room) !== r || !r.seen(ok)) return;
        for (const o of others()) o.send(frame, { binary: true });
      });
    };
    const close = () => {
      clearTimeout(hello);
      if (!me) return;
      if (me.role === 'owner') {
        const r = rooms.get(me.room);
        if (!r || r.owner !== ws) return;   // (a connection the owner's resume replaced)
        if (!limits.grace) return closeRoom(me.room, 'the owner stopped sharing');
        // (#3835: kept for the owner's resume, its followers with it; #4850: told it is away, and for how long at most)
        r.owner = null;
        r.grace = setTimeout(() => closeRoom(me.room, OWNER_LOST), limits.grace);
        r.grace.unref?.();
        for (const f of r.followers.keys()) json(f, { type: 'away', grace: limits.grace });
        return;
      }
      const r = rooms.get(me.room);
      if (!r || !r.followers.delete(ws)) return;
      for (const other of [r.owner, ...r.followers.keys()]) json(other, { type: 'leave', client: me.client });
    };
    return { message, close };
  }

  // the rooms again, from what their sockets are (a platform's rooms awake, #4541): each owner's room, then its
  // followers; a follower whose owner is not among them told the room ended (an owner lost does not sleep: its grace's
  // timer keeps the room awake)
  function restore(entries) {
    const out = new Map();
    for (const [ws, s] of entries) {
      if (s?.role !== 'owner' || rooms.has(s.room)) continue;
      rooms.set(s.room, { owner: ws, ownerClient: s.client, followers: new Map(), editors: s.editors ?? null, verify: s.editors ? verifierFor(s.editors) : null, seen: editsSeen(), resume: s.resume, grace: null });
      out.set(ws, welcome(ws, 'owner', s));
    }
    for (const [ws, s] of entries) {
      if (s?.role !== 'follower') continue;
      const r = rooms.get(s.room);
      if (!r) { json(ws, { type: 'closed', reason: OWNER_LOST }); ws.close(1000, 'closed'); continue; }
      r.followers.set(ws, s.client);
      out.set(ws, welcome(ws, 'follower', s));
    }
    return out;
  }

  return { rooms, welcome, restore, closeRoom };
}
