// An editor's signature (#3182, shared projects, phase 2: the roles enforced by keys). The owner's page makes a signing
// key pair per room (ECDSA P-256: Web Crypto has it in every browser and in Node); an editor's link carries its private
// half (core/collab-link.js), the room's owner gives its public half to the relay or host that runs the room
// (core/collab-room.js) and to every participant (in the project's document: core/collab-doc.js). An editor's change
// is a sealed frame (core/collab-crypto.js) with its signature after it, over the frame and the room: the relay or
// host forwards it, and each participant applies it, only when the signature is the room's.
//   signed frame = [kind][iv][ciphertext][signature (64 bytes)]
import { b64url } from './collab-crypto.js';

const subtle = () => globalThis.crypto.subtle;
const ALG = { name: 'ECDSA', namedCurve: 'P-256' }, HASH = { name: 'ECDSA', hash: 'SHA-256' };
export const SIG = 64;
export const SIGN_RE = /^[A-Za-z0-9_-]{129}$/;   // (the link's: the private scalar, then the public point's x and y)
export const PUB_RE = /^[A-Za-z0-9_-]{86}$/;     // (the public point's x and y)
const part = (t, i) => t.slice(43 * i, 43 * (i + 1));
const message = (room, frame) => {
  const head = new TextEncoder().encode(`silinx-collab:edit:${room}:`);
  const out = new Uint8Array(head.length + frame.length);
  out.set(head);
  out.set(frame, head.length);
  return out;
};

/** A room's new signing key: { key (to sign), text (the editor link's), pub (its public half's text) }. */
export async function newSigner() {
  const pair = await subtle().generateKey(ALG, true, ['sign', 'verify']);
  const j = await subtle().exportKey('jwk', pair.privateKey);
  return { key: pair.privateKey, text: `${j.d}${j.x}${j.y}`, pub: `${j.x}${j.y}` };
}

/** The public half of an editor link's key. */
export const pubOf = text => (SIGN_RE.test(String(text)) ? text.slice(43) : null);

/** The signing key of an editor link's text (an error for one that is not). */
export async function signerOf(text) {
  if (!SIGN_RE.test(String(text))) throw new Error('the editor link\'s key is not valid');
  return subtle().importKey('jwk', { kty: 'EC', crv: 'P-256', d: part(text, 0), x: part(text, 1), y: part(text, 2), ext: false }, ALG, false, ['sign']);
}

/** The key that checks a room's signatures (an error for a public half that is not one). */
export async function verifierOf(pub) {
  if (!PUB_RE.test(String(pub))) throw new Error('the room\'s editors\' key is not valid');
  try { return await subtle().importKey('jwk', { kty: 'EC', crv: 'P-256', x: part(pub, 0), y: part(pub, 1), ext: true }, ALG, false, ['verify']); }
  catch { throw new Error('the room\'s editors\' key is not valid'); }
}

/** A sealed frame signed: the frame and its signature. */
export async function signFrame(key, room, frame) {
  const sig = new Uint8Array(await subtle().sign(HASH, key, message(room, frame)));
  const out = new Uint8Array(frame.length + SIG);
  out.set(frame);
  out.set(sig, frame.length);
  return out;
}

/** A signed frame checked: the frame without its signature, or null when the signature is not the room's. */
export async function verifyFrame(key, room, signed) {
  const s = signed instanceof Uint8Array ? signed : new Uint8Array(signed);
  if (s.length <= SIG) return null;
  const frame = s.subarray(0, s.length - SIG);
  try { return (await subtle().verify(HASH, key, s.subarray(s.length - SIG), message(room, frame))) ? frame : null; } catch { return null; }
}

// An editor's frames in order (#4736): each editor's sealed frames have an IV of their own kind, 8 random bytes of the
// editor's session then a 32-bit counter (a deterministic IV: unique under the room's key as the random ones are, the
// session's part being random), signed with the frame. The relay or host remembers the last counter of each session
// whose signed frames it forwarded and drops one at or below it: a frame replayed, by whoever saw it, goes no further.
// An older page's random IV is a session of its own (never dropped but replayed); a rekey (#3997) changes nothing.
const SESSION = 8, IV = 12;

/** The IVs of an editor's session: a function giving the next one ([8 random bytes][counter, 32 bits, big-endian]). */
export function editIvs() {
  const session = globalThis.crypto.getRandomValues(new Uint8Array(SESSION));
  let n = 0;
  return () => {
    if (n > 0xFFFFFFFF) throw new Error('an editor\'s session sent 2^32 edits: share the project again');
    const iv = new Uint8Array(IV);
    iv.set(session);
    new DataView(iv.buffer).setUint32(SESSION, n++);
    return iv;
  };
}

/** A sealed frame's session and counter (its IV's): { session (text), n }, or null for a frame too short. */
export function editSeq(frame) {
  const f = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (f.length < 1 + IV) return null;
  return { session: b64url(f.subarray(1, 1 + SESSION)), n: new DataView(f.buffer, f.byteOffset + 1 + SESSION, 4).getUint32(0) };
}

/** A room's filter of its editors' frames (#4736): fresh(frame) says whether a frame whose signature is the room's comes
 *  after the last one of its session (then remembered), false for one already passed (a replay). `sessions` most
 *  recently seen remembered. */
export function editsSeen(sessions = 1024) {
  const last = new Map();
  return frame => {
    const s = editSeq(frame);
    if (!s) return false;
    const was = last.get(s.session);
    if (was !== undefined && s.n <= was) return false;
    last.delete(s.session);
    last.set(s.session, s.n);
    if (last.size > sessions) last.delete(last.keys().next().value);
    return true;
  };
}

export { b64url };
