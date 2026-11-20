// A shared project's wire (#4541: out of core/collab-client.js, so that the room's logic, core/collab-room.js, imports
// nothing but WebCrypto's modules and runs as it is in the Cloudflare relay, packages/silinx-relay-cloudflare/): the
// protocol's version, the WebSockets' subprotocol, the binary frames' kinds and the frames the room marks with a
// participant's client id. The protocol itself: core/collab-client.js.

export const PROTOCOL = 4;   // (2: an editor's signed edits, #3182; 3: a follower's awareness marked with its sender, #3360; 4: the owner's frame for one follower, #3529)
export const SUBPROTOCOL = 'silinx-collab';   // (the WebSockets', server/collab-relay.js's)
/** A room's id (128 bits, base64url). */
export const ROOM_RE = /^[A-Za-z0-9_-]{22}$/;
export const KIND = Object.freeze({ update: 1, awareness: 2, edit: 3, from: 4, to: 5, role: 6, activity: 7 });

/** A follower's frame as the room forwards it (#3360): marked with the client id it joined with. */
export function fromFrame(client, frame) {
  const out = new Uint8Array(frame.length + 5);
  out[0] = KIND.from;
  new DataView(out.buffer).setUint32(1, client);
  out.set(frame, 5);
  return out;
}

/** The owner's frame for one follower (#3529): the room gives `frame` to the follower of that client id only. */
export function toFrame(client, frame) {
  const out = fromFrame(client, frame);
  out[0] = KIND.to;
  return out;
}

/** A frame the room marked: { client, frame } (null: not one); kind KIND.to: the owner's frame for one follower. */
export function senderOf(frame, kind = KIND.from) {
  if (frame[0] !== kind || frame.length < 6) return null;
  return { client: new DataView(frame.buffer, frame.byteOffset).getUint32(1), frame: frame.subarray(5) };
}

/** A room its owner no longer shares, as the room says it to a follower that joins (core/collab-room.js). */
export const NOT_SHARED = 'this shared project is no longer shared (its owner stopped sharing it)';

/** A relay's WebSocket address with the room it reaches (#4541: `?room=`, a follower's join and the owner's resume):
 *  the Cloudflare relay's Worker gives each room's sockets to that room's Durable Object; Silinx's relay reads the room
 *  from the first message, as before. Another address (a hosted room's, `silinx-host:`): as it is. */
export function roomUrl(url, room) {
  if (!/^wss?:/i.test(String(url))) return url;
  const u = new URL(url);
  u.searchParams.set('room', room);
  return u.href;
}
