// Requests that only a device of the account may make (decision 0027): change
// the lost-phone wait, stop a waiting "start fresh", remove a device, and
// replace the identity at once from a device.
//
// A session that has only the password can write the same documents a device
// can, so each request carries a proof made with the device's long-term X25519
// key, which this function checks against the device's published key before
// it acts. The rules let nobody but this function do what these requests do.
import {
  createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes, timingSafeEqual,
} from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

export const WAIT_DAYS = [1, 3, 7, 14, 30];
export const DEFAULT_WAIT_DAYS = 3;
const LABEL = 'fireplace/v1/device-proof';
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const OP_ID = /^[A-Za-z0-9_-]{8,64}$/;
const KINDS = ['setWait', 'stop', 'removeDevice', 'resetNow'];

// DER wrappers for a raw X25519 key (RFC 8410).
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');

export interface AccountOpDeps {
  db: Firestore;
  now?: number;
}

class Refused extends Error {
  declare reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}
const refuse: (reason: string) => never = (reason) => {
  throw new Refused(reason);
};

/** Length-prefixed (u32 big-endian) concatenation, as the app's `lp`. */
export function lp(parts: (Buffer | string)[]): Buffer {
  const out: Buffer[] = [];
  for (const part of parts) {
    const bytes = typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    out.push(length, bytes);
  }
  return Buffer.concat(out);
}

export function publicOf(seed: Buffer): Buffer {
  const key = createPublicKey(createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: 'der', type: 'pkcs8' }));
  return key.export({ format: 'der', type: 'spki' }).subarray(SPKI.length);
}

/** What a device signs for: who asks, for what, under which request id. */
export function proofMessage(uid: string, device: string, opId: string, kind: string, args: string[]): Buffer {
  return lp([LABEL, uid, device, opId, kind, ...args]);
}

/** The MAC the device must have sent, from the server's key and the device's published key. */
export function expectedProof(serverSeed: Buffer, devicePub: Buffer, message: Buffer): Buffer {
  if (devicePub.length !== 32) refuse('device key');
  const shared = diffieHellman({
    privateKey: createPrivateKey({ key: Buffer.concat([PKCS8, serverSeed]), format: 'der', type: 'pkcs8' }),
    publicKey: createPublicKey({ key: Buffer.concat([SPKI, devicePub]), format: 'der', type: 'spki' }),
  });
  // A key that contributes nothing gives an all-zero secret anyone can compute.
  if (shared.every((b) => b === 0)) refuse('device key');
  const key = Buffer.from(
    hkdfSync('sha256', shared, Buffer.alloc(0), lp([LABEL, devicePub, publicOf(serverSeed)]), 32),
  );
  return createHmac('sha256', key).update(message).digest();
}

/**
 * The server's key. Made on first use and kept where no client can read it;
 * the public half is published for the app.
 */
export async function serverSeed(db: Firestore): Promise<Buffer> {
  const ref = db.doc('private/deviceProof');
  return db.runTransaction(async (tx) => {
    const stored = (await tx.get(ref)).get('x25519Seed');
    if (typeof stored === 'string') return Buffer.from(stored, 'base64');
    const seed = randomBytes(32);
    tx.set(ref, { x25519Seed: seed.toString('base64'), createdAt: FieldValue.serverTimestamp() });
    tx.set(db.doc('config/deviceProof'), { x25519Pub: publicOf(seed).toString('base64') });
    return seed;
  });
}

/** The arguments of a request, in the order the proof covers them. */
function argumentsOf(op: DocumentData): string[] {
  switch (op.kind) {
    case 'setWait':
      return [String(op.waitDays)];
    case 'removeDevice':
      return [String(op.target)];
    default:
      return [];
  }
}

export async function handleAccountDeviceOp(
  { uid, opId }: { uid: string; opId: string },
  { db, now = Date.now() }: AccountOpDeps,
): Promise<string> {
  const opRef = db.doc(`users/${uid}/accountOps/${opId}`);
  const seed = await serverSeed(db);
  try {
    const kind = await db.runTransaction(async (tx) => {
      const op = (await tx.get(opRef)).data();
      if (!op || op.status) return null; // already handled
      // Only asks for the key to exist, which it now does.
      if (op.kind === 'key') return 'key';
      if (!OP_ID.test(opId) || !KINDS.includes(op.kind)) refuse('request');
      if (typeof op.device !== 'string' || !DEVICE_ID.test(op.device)) refuse('device');
      if (typeof op.proof !== 'string') refuse('proof');

      const user = await tx.get(db.doc(`users/${uid}`));
      if (!user.exists || user.get('deleting') === true) refuse('account');
      const device = await tx.get(db.doc(`users/${uid}/devices/${op.device}`));
      // A removed device proves nothing any more.
      if (!device.exists || device.get('revokedAt') != null) refuse('device');
      const devicePub = Buffer.from(String(device.get('x25519Pub') ?? ''), 'base64');
      const sent = Buffer.from(op.proof, 'base64');
      const expected = expectedProof(seed, devicePub, proofMessage(uid, op.device, opId, op.kind, argumentsOf(op)));
      if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) refuse('proof');

      const pending = db.doc(`users/${uid}/private/startFresh`);
      switch (op.kind) {
        case 'setWait':
          if (!WAIT_DAYS.includes(op.waitDays)) refuse('wait');
          tx.set(db.doc(`users/${uid}/private/security`), {
            waitDays: op.waitDays,
            updatedAt: Timestamp.fromMillis(now),
          });
          break;
        case 'stop':
          // The rules accepted this request only from a sign-in a few minutes
          // old: the person typed the password again.
          tx.delete(pending);
          break;
        case 'removeDevice': {
          if (typeof op.target !== 'string' || !DEVICE_ID.test(op.target) || op.target === op.device) refuse('target');
          const target = db.doc(`users/${uid}/devices/${op.target}`);
          if (!(await tx.get(target)).exists) refuse('target');
          tx.update(target, { revokedAt: Timestamp.fromMillis(now) });
          break;
        }
        case 'resetNow':
          // A device replaces the identity at once: a start that is already
          // over its wait, which the rules then let the device carry out.
          tx.set(pending, { startedAt: Timestamp.fromMillis(0), waitDays: DEFAULT_WAIT_DAYS, by: 'device' });
          break;
      }
      return op.kind as string;
    });
    if (kind === null) return 'skipped';
    await opRef.update({ status: 'done', proof: FieldValue.delete() });
    return kind;
  } catch (e) {
    const reason = e instanceof Refused ? e.reason : 'error';
    await opRef.update({ status: 'refused', reason, proof: FieldValue.delete() }).catch(() => {});
    if (!(e instanceof Refused)) throw e;
    return `refused:${reason}`;
  }
}
