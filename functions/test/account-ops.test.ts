// Requests only a device may make (decision 0027). The proof arithmetic runs
// anywhere; the handler runs against the Firestore emulator and is skipped
// without one (plain `npm test`).
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  DEFAULT_WAIT_DAYS, expectedProof, handleAccountDeviceOp, lp, proofMessage, publicOf, serverSeed,
} from '../lib/account-ops.ts';

// The same inputs as the app's test: byte i of the device key is i*7+1, of the
// server key 250-i*3.
const deviceSeed = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff));
const fixedServerSeed = Buffer.from(Array.from({ length: 32 }, (_, i) => (250 - i * 3) & 0xff));

test('lp is the length-prefixed form the app uses', () => {
  assert.equal(lp(['ab', Buffer.from([1])]).toString('hex'), '0000000261620000000101');
  assert.notDeepEqual(lp(['set', 'Wait']), lp(['setWait']));
});

test('the proof equals what the app computes from the same keys', () => {
  assert.equal(publicOf(deviceSeed).toString('base64'), 'yP7Kgb4ZbN8sreq/E8SQPXYy3OSVWqaLbl2a3vVOJhY=');
  assert.equal(publicOf(fixedServerSeed).toString('base64'), '94Tr5DFXDoQ2JBMRBlsuwo4XK5ZC1Qs4GS/zDNYsQzA=');
  const proof = expectedProof(
    fixedServerSeed,
    publicOf(deviceSeed),
    proofMessage('alice', 'device-0001', 'request-1', 'setWait', ['7']),
  );
  assert.equal(proof.toString('base64'), 'PfgiTepHml37W63C0sOo3nir6HWb/m5qY/wjN2IXgwM=');
});

test('a device key that contributes nothing is refused', () => {
  assert.throws(() => expectedProof(fixedServerSeed, Buffer.alloc(32), proofMessage('a', 'b', 'c', 'stop', [])));
  assert.throws(() => expectedProof(fixedServerSeed, Buffer.alloc(31, 9), proofMessage('a', 'b', 'c', 'stop', [])));
});

const emulator = !!process.env.FIRESTORE_EMULATOR_HOST;
const projectId = 'fireplace-account-fn-test';
let db;
before(() => {
  if (!emulator) return;
  db = getFirestore(initializeApp({ projectId }, 'account-ops-test'));
});
beforeEach(async () => {
  if (!emulator) return;
  await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
});
const etest = (name, fn) => test(name, { skip: !emulator && 'needs the Firestore emulator' }, fn);

const DEVICE = 'alice-device-01';
async function account() {
  await db.doc('users/alice').set({ username: 'alice', createdAt: new Date() });
  await db.doc(`users/alice/devices/${DEVICE}`).set({
    x25519Pub: publicOf(deviceSeed).toString('base64'), createdAt: new Date(),
  });
  await db.doc('users/alice/devices/alice-device-02').set({
    x25519Pub: publicOf(Buffer.alloc(32, 5)).toString('base64'), createdAt: new Date(),
  });
}
let n = 0;
/** Writes a request as a device holding `seed` would, and runs the function. */
async function request(kind, fields = {}, { seed = deviceSeed, device = DEVICE, args = [] as string[], tamper = false } = {}) {
  const id = `request-${String(++n).padStart(4, '0')}`;
  const server = await serverSeed(db);
  const proof = expectedProof(server, publicOf(seed), proofMessage('alice', device, id, kind, args));
  if (tamper) proof[0] ^= 1;
  await db.doc(`users/alice/accountOps/${id}`).set({
    kind, device, proof: proof.toString('base64'), at: new Date(), ...fields,
  });
  const result = await handleAccountDeviceOp({ uid: 'alice', opId: id }, { db });
  return { result, op: (await db.doc(`users/alice/accountOps/${id}`).get()).data() };
}
const security = async () => (await db.doc('users/alice/private/security').get()).data();
const pending = () => db.doc('users/alice/private/startFresh');

etest('the server key is made once and its public half published', async () => {
  const first = await serverSeed(db);
  assert.equal(first.length, 32);
  assert.deepEqual(await serverSeed(db), first);
  assert.equal(
    (await db.doc('config/deviceProof').get()).get('x25519Pub'),
    publicOf(first).toString('base64'),
  );
});

etest('asking for the key makes it and needs no device', async () => {
  await db.doc('users/alice').set({ username: 'alice', createdAt: new Date() });
  await db.doc('users/alice/accountOps/request-key1').set({ kind: 'key', at: new Date() });
  assert.equal(await handleAccountDeviceOp({ uid: 'alice', opId: 'request-key1' }, { db }), 'key');
  assert.equal((await db.doc('users/alice/accountOps/request-key1').get()).get('status'), 'done');
  assert.equal(typeof (await db.doc('config/deviceProof').get()).get('x25519Pub'), 'string');
  // It changed nothing about the account.
  assert.equal((await db.doc('users/alice/private/security').get()).exists, false);
});

etest('a device changes the wait; the proof is removed from the finished request', async () => {
  await account();
  const { result, op } = await request('setWait', { waitDays: 7 }, { args: ['7'] });
  assert.equal(result, 'setWait');
  assert.equal(op.status, 'done');
  assert.equal(op.proof, undefined);
  assert.equal((await security()).waitDays, 7);
  // Handled once.
  assert.equal(await handleAccountDeviceOp({ uid: 'alice', opId: 'request-0001' }, { db }), 'skipped');
});

etest('without a valid proof nothing happens', async () => {
  await account();
  // Someone with only the password: no device key.
  assert.equal((await request('setWait', { waitDays: 1 }, { args: ['1'], seed: Buffer.alloc(32, 77) })).result, 'refused:proof');
  // A proof for another value, device, or a damaged one.
  assert.equal((await request('setWait', { waitDays: 1 }, { args: ['7'] })).result, 'refused:proof');
  assert.equal((await request('setWait', { waitDays: 1 }, { args: ['1'], tamper: true })).result, 'refused:proof');
  assert.equal((await request('setWait', { waitDays: 1 }, { args: ['1'], device: 'alice-device-02' })).result, 'refused:proof');
  assert.equal((await request('setWait', { waitDays: 1 }, { args: ['1'], device: 'no-such-device' })).result, 'refused:device');
  assert.equal(await security(), undefined);
  // A wait outside the offered lengths, properly proven, is still refused.
  assert.equal((await request('setWait', { waitDays: 2 }, { args: ['2'] })).result, 'refused:wait');
  assert.equal((await request('promote')).result, 'refused:request');
});

etest('a removed device can prove nothing', async () => {
  await account();
  await db.doc(`users/alice/devices/${DEVICE}`).update({ revokedAt: new Date() });
  assert.equal((await request('setWait', { waitDays: 7 }, { args: ['7'] })).result, 'refused:device');
});

etest('a device stops a waiting start', async () => {
  await account();
  await pending().set({ startedAt: new Date(), waitDays: 3, session: 1 });
  assert.equal((await request('stop', {}, { seed: Buffer.alloc(32, 77) })).result, 'refused:proof');
  assert.ok((await pending().get()).exists);
  assert.equal((await request('stop')).result, 'stop');
  assert.equal((await pending().get()).exists, false);
});

etest('a device removes another device, not itself and not with a forged proof', async () => {
  await account();
  const other = db.doc('users/alice/devices/alice-device-02');
  assert.equal((await request('removeDevice', { target: DEVICE }, { args: [DEVICE] })).result, 'refused:target');
  assert.equal(
    (await request('removeDevice', { target: 'alice-device-02' }, { args: ['alice-device-02'], seed: Buffer.alloc(32, 77) })).result,
    'refused:proof',
  );
  assert.equal((await other.get()).get('revokedAt'), undefined);
  assert.equal((await request('removeDevice', { target: 'alice-device-02' }, { args: ['alice-device-02'] })).result, 'removeDevice');
  assert.ok((await other.get()).get('revokedAt'));
});

etest('a device may replace the identity at once', async () => {
  await account();
  assert.equal((await request('resetNow')).result, 'resetNow');
  const start = (await pending().get()).data();
  assert.equal(start.by, 'device');
  assert.equal(start.waitDays, DEFAULT_WAIT_DAYS);
  // Already over its wait, whatever the wait is.
  assert.ok(start.startedAt.toMillis() + 30 * 86_400_000 < Date.now());
});

etest('an account being deleted takes no requests', async () => {
  await account();
  await db.doc('users/alice').update({ deleting: true });
  assert.equal((await request('setWait', { waitDays: 7 }, { args: ['7'] })).result, 'refused:account');
});
