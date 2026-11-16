// Replays document shapes produced by the real Dart code (test/rules_fixture_test.dart)
// against the real rules, including the largest fields (ML-KEM / ML-DSA keys and certs).
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, writeBatch, serverTimestamp, getDoc } from 'firebase/firestore';

const fx = JSON.parse(readFileSync(new URL('./fixtures/app_docs.json', import.meta.url)) as unknown as string);
// honour FIRESTORE_EMULATOR_HOST (set by `firebase emulators:exec`) so other ports work
function emulatorHostPort() {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
  return { host, port: Number(port) };
}

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'fireplace-fixtures',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), ...emulatorHostPort() },
  });
});
after(async () => env.cleanup());
beforeEach(async () => env.clearFirestore());

import { createHash } from 'node:crypto';
const hashOf = (code) => createHash('sha256').update(code).digest('hex');
const ctx = (uid) => env.authenticatedContext(uid, { email: `${uid}@users.fireplace.invalid` }).firestore();
async function signUp(uid) {
  const code = `invite-${uid}`;
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'invites', hashOf(code)), { createdAt: new Date() });
  });
  const db = ctx(uid);
  const b = writeBatch(db);
  b.set(doc(db, 'usernames', uid), { uid });
  b.set(doc(db, 'users', uid), { username: uid, displayName: uid, createdAt: serverTimestamp(), invite: hashOf(code) });
  b.update(doc(db, 'invites', hashOf(code)), { usedBy: uid, usedAt: serverTimestamp() });
  await b.commit();
}

test('Dart-produced device document is accepted', async () => {
  await signUp('alice');
  await assertSucceeds(setDoc(doc(ctx('alice'), `users/alice/devices/${fx.deviceId}`),
    { ...fx.deviceDoc, createdAt: serverTimestamp() }));
});

test('Dart-produced message envelope is accepted, as the app writes it', async () => {
  await signUp('alice'); await signUp('bob');
  const db = ctx('alice');
  await assertSucceeds(setDoc(doc(db, `users/alice/devices/${fx.deviceId}`),
    { ...fx.deviceDoc, createdAt: serverTimestamp() }));
  // As the app writes them (decisions 0015 and 0017): the chat with its counter...
  const start = writeBatch(db);
  start.set(doc(db, 'chats', 'alice_bob'), {
    participants: ['alice', 'bob'], initiator: 'alice', accepted: false, requestCount: 0,
    createdAt: serverTimestamp(), lastMessageAt: serverTimestamp() });
  start.set(doc(db, 'users/alice/limits/chats'), { at: serverTimestamp(), day: serverTimestamp(), today: 1 });
  await assertSucceeds(start.commit());
  await assertSucceeds(setDoc(doc(ctx('bob'), 'users/bob/devices/zz-bob-0001'), { ...fx.deviceDoc, createdAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(ctx('bob'), 'chats', 'alice_bob'), { accepted: true, lastMessageAt: serverTimestamp() }));
  const send = writeBatch(db);
  send.set(doc(db, 'chats/alice_bob/messages/m1'), {
    senderUid: 'alice', senderDevice: fx.deviceId, ts: serverTimestamp(),
    envelopes: { [fx.deviceId]: fx.envelope }, expireAt: new Date(Date.now() + 30 * 86400e3) });
  // ...and the first message with its send clock opening a day.
  send.set(doc(db, 'users/alice/limits/send'), {
    at: serverTimestamp(), window: serverTimestamp(), sent: 1, day: serverTimestamp(), today: 1 });
  await assertSucceeds(send.commit());
  const back = await assertSucceeds(getDoc(doc(ctx('bob'), 'chats/alice_bob/messages/m1')));
  if (!back.exists()) throw new Error('bob cannot read');
});

test('Dart-produced signed and one-time prekey documents are accepted (largest real sizes)', async () => {
  await signUp('alice');
  const db = ctx('alice');
  await assertSucceeds(setDoc(doc(db, `users/alice/devices/${fx.deviceId}`),
    { ...fx.deviceDoc, createdAt: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(db, `users/alice/devices/${fx.deviceId}/prekeys/${fx.signedPreKeyId}`),
    { ...fx.signedPreKeyDoc, createdAt: serverTimestamp() }));
  await assertSucceeds(setDoc(doc(db, `users/alice/devices/${fx.deviceId}/prekeys/${fx.oneTimePreKeyId}`),
    { ...fx.oneTimePreKeyDoc, createdAt: serverTimestamp() }));
});
