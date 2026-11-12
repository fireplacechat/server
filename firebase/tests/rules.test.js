import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, collection,
  getDocs, query, where, orderBy, serverTimestamp, increment, runTransaction,
} from 'firebase/firestore';

// honour FIRESTORE_EMULATOR_HOST (set by `firebase emulators:exec`) so other ports work
function emulatorHostPort() {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
  return { host, port: Number(port) };
}

let env;
const email = (u) => `${u}@users.fireplace.invalid`;
const uidByApp = new Map(); // firebase app name -> authenticated uid
const ctx = (uid, username) => {
  const db = env.authenticatedContext(uid, { email: email(username ?? uid) }).firestore();
  uidByApp.set(db.app.name, uid);
  return db;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hashOf = (code) => createHash('sha256').update(code).digest('hex');
const lastSend = new Map(); // uid -> ms; keeps ordinary tests under the 500 ms pacing rule
async function pace(uid) {
  const wait = 560 - (Date.now() - (lastSend.get(uid) ?? 0));
  if (wait > 0) await sleep(wait);
  lastSend.set(uid, Date.now());
}
async function makeInvite(code, extra = {}) {
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'invites', hashOf(code)), { createdAt: new Date(), note: 'test', ...extra });
  });
}
/** The app's send-clock forms (decision 0015): 'day', 'window' or 'next'. */
function addClock(b, db, uid, form) {
  const clock = doc(db, `users/${uid}/limits/send`);
  const at = serverTimestamp();
  if (form === 'day') b.set(clock, { at, window: at, sent: 1, day: at, today: 1 });
  else if (form === 'window') b.update(clock, { at, window: at, sent: 1, today: increment(1) });
  else b.update(clock, { at, sent: increment(1), today: increment(1) });
}
/**
 * Commits a batch that `build` fills, with the send clock, trying the clock's
 * forms as the app does after a refused guess. A refusal in every form is
 * passed on.
 */
async function withClock(db, uid, build) {
  let last;
  for (const form of ['next', 'window', 'day']) {
    const b = writeBatch(db);
    build(b);
    addClock(b, db, uid, form);
    try {
      return await b.commit();
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
/** Writes a message together with the sender's send clock, as the app does. */
async function setMsg(ref, data) {
  const uid = uidByApp.get(ref.firestore.app.name);
  if (!uid) throw new Error('setMsg needs a reference made from ctx()');
  return withClock(ref.firestore, uid, (b) => b.set(ref, data));
}
/** Creates a chat with its daily counter (decision 0017), as the app does. */
async function newChat(db, uid, chatId, data) {
  let last;
  for (const form of ['count', 'day']) {
    const b = writeBatch(db);
    b.set(doc(db, 'chats', chatId), data);
    const counter = doc(db, `users/${uid}/limits/chats`);
    const at = serverTimestamp();
    if (form === 'day') b.set(counter, { at, day: at, today: 1 });
    else b.update(counter, { at, today: increment(1) });
    try {
      return await b.commit();
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'fireplace-rules-test',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), ...emulatorHostPort() },
  });
});
after(async () => env.cleanup());
beforeEach(async () => { lastSend.clear(); await env.clearFirestore(); });

/** Builds the sign-up batch: username + profile + claiming an invite. */
function signUpBatch(db, uid, username, code) {
  const b = writeBatch(db);
  b.set(doc(db, 'usernames', username), { uid });
  b.set(doc(db, 'users', uid), {
    username, displayName: username, createdAt: serverTimestamp(), invite: hashOf(code),
  });
  b.update(doc(db, 'invites', hashOf(code)), { usedBy: uid, usedAt: serverTimestamp() });
  return b;
}
async function signUp(uid, username) {
  const code = `invite-for-${uid}-${username}`;
  await makeInvite(code);
  return signUpBatch(ctx(uid, username), uid, username, code).commit();
}
const deviceDoc = () => ({
  x25519Pub: 'a'.repeat(44), kemPub: 'b'.repeat(1580), sigPub: 'c'.repeat(100),
  deviceCert: 'd'.repeat(200), createdAt: serverTimestamp(),
});
const DAY = 86400e3;
const msg = (uid, extra = {}) => ({
  senderUid: uid, senderDevice: `dev-of-${uid}`, ts: serverTimestamp(),
  envelopes: { devB: { ct: 'x', nonce: 'y' } }, expireAt: new Date(Date.now() + 30 * DAY), ...extra,
});

const chatDoc = (initiator, participants) => ({
  participants, initiator, accepted: false, requestCount: 0,
  createdAt: serverTimestamp(), lastMessageAt: serverTimestamp(),
});

async function setupChat() {
  await signUp('alice', 'alice'); await signUp('bob', 'bob'); await signUp('eve', 'eve');
  for (const u of ['alice', 'bob', 'eve']) {
    await setDoc(doc(ctx(u), `users/${u}/devices/dev-of-${u}`), deviceDoc());
  }
  await assertSucceeds(newChat(ctx('alice'), 'alice', 'alice_bob', chatDoc('alice', ['alice', 'bob'])));
  // bob accepts the request, so ordinary messaging tests start from an accepted chat
  await assertSucceeds(updateDoc(doc(ctx('bob'), 'chats', 'alice_bob'),
    { accepted: true, lastMessageAt: serverTimestamp() }));
}
async function setupRequestChat() {
  await signUp('alice', 'alice'); await signUp('bob', 'bob'); await signUp('eve', 'eve');
  for (const u of ['alice', 'bob', 'eve']) {
    await setDoc(doc(ctx(u), `users/${u}/devices/dev-of-${u}`), deviceDoc());
  }
  await assertSucceeds(newChat(ctx('alice'), 'alice', 'alice_bob', chatDoc('alice', ['alice', 'bob'])));
}

// ---------- sign-up ----------
test('sign-up batch (username + profile) succeeds', async () => {
  await assertSucceeds(signUp('alice', 'alice'));
});
test('username is unique; only its owner can release it', async () => {
  await signUp('alice', 'alice');
  await assertFails(signUp('mallory', 'alice'));
  await assertFails(deleteDoc(doc(ctx('mallory'), 'usernames', 'alice'))); // only the owner can release it
});
test('cannot claim a username without matching synthetic email', async () => {
  await makeInvite('inv-1');
  const db = env.authenticatedContext('x', { email: 'other@users.fireplace.invalid' }).firestore();
  await assertFails(signUpBatch(db, 'x', 'wanted', 'inv-1').commit());
  await assertSucceeds(signUpBatch(env.authenticatedContext('x', { email: email('wanted') }).firestore(), 'x', 'wanted', 'inv-1').commit());
});
test('cannot claim username for another uid', async () => {
  await makeInvite('inv-2');
  const db = ctx('mallory', 'mallory');
  const b = writeBatch(db);
  b.set(doc(db, 'usernames', 'mallory'), { uid: 'alice' });
  b.set(doc(db, 'users', 'mallory'), { username: 'mallory', displayName: 'm', createdAt: serverTimestamp(), invite: hashOf('inv-2') });
  b.update(doc(db, 'invites', hashOf('inv-2')), { usedBy: 'mallory', usedAt: serverTimestamp() });
  await assertFails(b.commit());
});
test('invalid usernames rejected', async () => {
  let n = 0;
  for (const bad of ['ab', 'Has Caps', 'a'.repeat(21), 'bad-char']) {
    await makeInvite(`bad-${n}`);
    const db = env.authenticatedContext('u', { email: email(bad) }).firestore();
    await assertFails(signUpBatch(db, 'u', bad, `bad-${n++}`).commit());
  }
});

// ---------- invite-only sign-up ----------
test('invites: sign-up needs an existing, unused invite claimed by the new account', async () => {
  const db = ctx('alice', 'alice');
  // no invite document at all
  await assertFails(signUpBatch(db, 'alice', 'alice', 'never-created').commit());
  // profile without claiming (no invite update in the batch)
  await makeInvite('inv-a');
  const b = writeBatch(db);
  b.set(doc(db, 'usernames', 'alice'), { uid: 'alice' });
  b.set(doc(db, 'users', 'alice'), { username: 'alice', displayName: 'a', createdAt: serverTimestamp(), invite: hashOf('inv-a') });
  await assertFails(b.commit());
  // missing invite field on the profile
  const b2 = writeBatch(db);
  b2.set(doc(db, 'usernames', 'alice'), { uid: 'alice' });
  b2.set(doc(db, 'users', 'alice'), { username: 'alice', displayName: 'a', createdAt: serverTimestamp() });
  b2.update(doc(db, 'invites', hashOf('inv-a')), { usedBy: 'alice', usedAt: serverTimestamp() });
  await assertFails(b2.commit());
  await assertSucceeds(signUpBatch(db, 'alice', 'alice', 'inv-a').commit());
});
test('invites: single use - a used invite cannot create a second account', async () => {
  await makeInvite('inv-once');
  await assertSucceeds(signUpBatch(ctx('alice', 'alice'), 'alice', 'alice', 'inv-once').commit());
  await assertFails(signUpBatch(ctx('bob', 'bob'), 'bob', 'bob', 'inv-once').commit());
});
test('invites: cannot claim an invite for somebody else, or with a forged usedAt', async () => {
  await makeInvite('inv-x');
  const db = ctx('mallory', 'mallory');
  const b = writeBatch(db);
  b.set(doc(db, 'usernames', 'mallory'), { uid: 'mallory' });
  b.set(doc(db, 'users', 'mallory'), { username: 'mallory', displayName: 'm', createdAt: serverTimestamp(), invite: hashOf('inv-x') });
  b.update(doc(db, 'invites', hashOf('inv-x')), { usedBy: 'someone-else', usedAt: serverTimestamp() });
  await assertFails(b.commit());
  const b2 = writeBatch(db);
  b2.set(doc(db, 'usernames', 'mallory'), { uid: 'mallory' });
  b2.set(doc(db, 'users', 'mallory'), { username: 'mallory', displayName: 'm', createdAt: serverTimestamp(), invite: hashOf('inv-x') });
  b2.update(doc(db, 'invites', hashOf('inv-x')), { usedBy: 'mallory', usedAt: new Date('2020-01-01') });
  await assertFails(b2.commit());
});
test('invites: clients can neither read, list, create, change, nor delete invites', async () => {
  await makeInvite('inv-r');
  await signUp('alice', 'alice');
  const db = ctx('alice');
  await assertFails(getDoc(doc(db, 'invites', hashOf('inv-r'))));
  await assertFails(getDocs(collection(db, 'invites')));
  await assertFails(setDoc(doc(db, 'invites', hashOf('self-made')), { createdAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, 'invites', hashOf('inv-r')), { usedBy: 'alice', usedAt: serverTimestamp(), note: 'x' }));
  await assertFails(deleteDoc(doc(db, 'invites', hashOf('inv-r'))));
});
test('invites: the profile invite field cannot be changed later', async () => {
  await signUp('alice', 'alice');
  const ref = doc(ctx('alice'), 'users', 'alice');
  await assertFails(updateDoc(ref, { invite: hashOf('other') }));
  await assertSucceeds(updateDoc(ref, { displayName: 'Still Alice' }));
});
test('accounts without a profile (no invite) are inert: no devices, backups, blocks, reports, lookups', async () => {
  await signUp('bob', 'bob');
  const ghost = ctx('ghost', 'ghost'); // signed in, never got a profile
  await assertFails(setDoc(doc(ghost, 'users/ghost/devices/device-0001'), deviceDoc()));
  await assertFails(setDoc(doc(ghost, 'users/ghost/private/backup'), { blob: 'x', v: 1, createdAt: serverTimestamp() }));
  await assertFails(setDoc(doc(ghost, 'users/ghost/blocks/bob'), { createdAt: serverTimestamp() }));
  await assertFails(setDoc(doc(ghost, 'reports/ghost_bob'), { reporter: 'ghost', reported: 'bob', reason: 'spam', createdAt: serverTimestamp() }));
  await assertFails(getDoc(doc(ghost, 'usernames', 'bob')));
  await assertFails(getDoc(doc(ghost, 'users', 'bob')));
  await assertFails(getDocs(collection(ghost, 'users/bob/devices')));
  await assertFails(setDoc(doc(ghost, 'users/ghost/limits/send'), { at: serverTimestamp() }));
  // ...but it can look at its own (absent) profile without an error, which sign-up relies on
  await assertSucceeds(getDoc(doc(ghost, 'users', 'ghost')));
});

// ---------- send pacing ----------
test('pacing: a message must come with the sender\'s send clock', async () => {
  await setupChat();
  await assertFails(setDoc(doc(ctx('alice'), 'chats/alice_bob/messages/nolimit'), msg('alice')));
  await assertSucceeds(setMsg(doc(ctx('alice'), 'chats/alice_bob/messages/ok'), msg('alice')));
});
test('pacing: the older one-gap form is no longer accepted (#12)', async () => {
  await setupChat();
  const a = ctx('alice');
  const older = () => {
    const b = writeBatch(a);
    b.set(doc(a, 'chats/alice_bob/messages/old'), msg('alice'));
    b.set(doc(a, 'users/alice/limits/send'), { at: serverTimestamp() });
    return b.commit();
  };
  await assertFails(older()); // the first message ever
  await assertSucceeds(setMsg(doc(a, 'chats/alice_bob/messages/new'), msg('alice')));
  await sleep(600);
  await assertFails(older()); // after a message in the window form
});
test('pacing: the limit is per account across all chats, not per chat', async () => {
  await setupChat();
  await assertSucceeds(newChat(ctx('eve'), 'eve', 'alice_eve', chatDoc('eve', ['alice', 'eve'])));
  await assertSucceeds(updateDoc(doc(ctx('alice'), 'chats', 'alice_eve'), { accepted: true, lastMessageAt: serverTimestamp() }));
  const a = ctx('alice');
  await assertSucceeds(setMsg(doc(a, 'chats/alice_bob/messages/c1'), msg('alice')));
  await assertSucceeds(setMsg(doc(a, 'chats/alice_eve/messages/c2'), msg('alice')));
  let clock;
  await env.withSecurityRulesDisabled(async (c) => {
    clock = (await getDoc(doc(c.firestore(), 'users/alice/limits/send'))).data();
  });
  assert.equal(clock.sent, 2, 'one window for both chats');
});
test('pacing: nobody can touch another account\'s send clock, or rewind their own', async () => {
  await setupChat();
  await setMsg(doc(ctx('alice'), 'chats/alice_bob/messages/first'), msg('alice'));
  await assertFails(setDoc(doc(ctx('bob'), 'users/alice/limits/send'), { at: serverTimestamp() }));
  await assertFails(getDoc(doc(ctx('bob'), 'users/alice/limits/send')));
  await assertFails(updateDoc(doc(ctx('alice'), 'users/alice/limits/send'), { at: new Date('2020-01-01') }));
  await assertFails(setDoc(doc(ctx('alice'), 'users/alice/limits/other'), { at: serverTimestamp() }));
  await sleep(600);
  await assertFails(updateDoc(doc(ctx('alice'), 'users/alice/limits/send'), { at: serverTimestamp() }));
});
test('pacing: another account is not slowed down by alice', async () => {
  await setupChat();
  await setMsg(doc(ctx('alice'), 'chats/alice_bob/messages/a1'), msg('alice'));
  await assertSucceeds(setMsg(doc(ctx('bob'), 'chats/alice_bob/messages/b1'), msg('bob')));
});
// ---------- send window and daily cap (decision 0015) ----------
/** A message with the send clock in one of the app's forms: 'day', 'window' or 'next'. */
function windowSend(db, uid, id, form) {
  const b = writeBatch(db);
  b.set(doc(db, `chats/alice_bob/messages/${id}`), msg(uid));
  const clock = doc(db, `users/${uid}/limits/send`);
  const at = serverTimestamp();
  if (form === 'day') b.set(clock, { at, window: at, sent: 1, day: at, today: 1 });
  else if (form === 'window') b.update(clock, { at, window: at, sent: 1, today: increment(1) });
  else b.update(clock, { at, sent: increment(1), today: increment(1) });
  return b.commit();
}
/** Sets alice's clock directly, for example to a window that ended a while ago. */
async function seedClock(data) {
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'users/alice/limits/send'), data);
  });
}
const ago = (ms) => new Date(Date.now() - ms);
const HOUR = 3600e3;

test('window: a burst goes out with no gap, up to 20 in a window', async () => {
  await setupChat();
  const a = ctx('alice');
  await assertSucceeds(windowSend(a, 'alice', 'w1', 'day'));
  for (let i = 2; i <= 20; i++) await assertSucceeds(windowSend(a, 'alice', `w${i}`, 'next'));
  await assertFails(windowSend(a, 'alice', 'w21', 'next'));
  // ...and a new window or day cannot be opened while this one runs
  await assertFails(windowSend(a, 'alice', 'w22', 'window'));
  await assertFails(windowSend(a, 'alice', 'w23', 'day'));
});
test('window: a new window opens once the last one is over, and an old one cannot be continued', async () => {
  await setupChat();
  await seedClock({ at: ago(10_500), window: ago(11_000), sent: 20, day: ago(HOUR), today: 40 });
  const a = ctx('alice');
  await assertFails(windowSend(a, 'alice', 'late', 'next'));
  await assertFails(windowSend(a, 'alice', 'reset', 'day')); // the day is still running
  await assertSucceeds(windowSend(a, 'alice', 'fresh', 'window'));
  await assertSucceeds(windowSend(a, 'alice', 'next', 'next'));
});
test('daily cap: 2,000 a day, then nothing until the day is over', async () => {
  await setupChat();
  await seedClock({ at: ago(20_000), window: ago(20_000), sent: 20, day: ago(HOUR), today: 2000 });
  const a = ctx('alice');
  await assertFails(windowSend(a, 'alice', 'c1', 'window'));
  await assertFails(windowSend(a, 'alice', 'c2', 'day'));
  await assertFails(setMsg(doc(a, 'chats/alice_bob/messages/c3'), msg('alice'))); // every form
  await seedClock({ at: ago(20_000), window: ago(20_000), sent: 20, day: ago(25 * HOUR), today: 2000 });
  await assertSucceeds(windowSend(a, 'alice', 'c4', 'day'));
});
test('daily cap: counts and times cannot be forged', async () => {
  await setupChat();
  const a = ctx('alice');
  await assertSucceeds(windowSend(a, 'alice', 'f1', 'day'));
  const forge = (clock) => {
    const b = writeBatch(a);
    b.set(doc(a, 'chats/alice_bob/messages/forged'), msg('alice'));
    b.update(doc(a, 'users/alice/limits/send'), clock);
    return b.commit();
  };
  const at = serverTimestamp();
  await assertFails(forge({ at, sent: increment(2), today: increment(1) })); // skips a count
  await assertFails(forge({ at, sent: increment(1), today: increment(2) }));
  await assertFails(forge({ at, sent: increment(1) })); // leaves the day count out
  await assertFails(forge({ at, sent: 0, today: increment(1) })); // rewinds the window count
  await assertFails(forge({ at, sent: increment(1), today: 1 })); // rewinds the day count
  await assertFails(forge({ at, window: ago(60_000), sent: 1, today: increment(1) })); // backdated
  await assertFails(forge({ at, sent: increment(1), today: increment(1), day: ago(25 * HOUR) }));
  await assertFails(forge({ at: ago(1000), sent: increment(1), today: increment(1) }));
  await assertFails(forge({ at, sent: increment(1), today: increment(1), extra: true }));
  await assertSucceeds(forge({ at, sent: increment(1), today: increment(1) }));
});
test('window: the older form cannot be used, even with a day running', async () => {
  await setupChat();
  const a = ctx('alice');
  await assertSucceeds(windowSend(a, 'alice', 's1', 'day'));
  await sleep(600);
  const b = writeBatch(a);
  b.set(doc(a, 'chats/alice_bob/messages/s2'), msg('alice'));
  b.set(doc(a, 'users/alice/limits/send'), { at: serverTimestamp() });
  await assertFails(b.commit());
});
test('window: after the older form, a day opens only after its 500 ms gap', async () => {
  await setupChat();
  await seedClock({ at: ago(100) });
  const a = ctx('alice');
  await assertFails(windowSend(a, 'alice', 'o1', 'day'));
  await sleep(600);
  await assertSucceeds(windowSend(a, 'alice', 'o2', 'day'));
});
test('window: the first message ever opens a day', async () => {
  await setupChat();
  await assertFails(windowSend(ctx('alice'), 'alice', 'first', 'next'));
  await assertSucceeds(windowSend(ctx('alice'), 'alice', 'first', 'day'));
});
test('send clock: only account deletion may delete it, so the counts cannot be reset', async () => {
  await setupChat();
  const a = ctx('alice');
  await assertSucceeds(windowSend(a, 'alice', 'd1', 'day'));
  await assertFails(deleteDoc(doc(a, 'users/alice/limits/send')));
  await assertSucceeds(updateDoc(doc(a, 'users/alice'), { deleting: true }));
  await assertSucceeds(deleteDoc(doc(a, 'users/alice/limits/send')));
});
// ---------- daily counters for new chats and prekey claims (decision 0017) ----------
/** The counter write the app adds to an action: 'day' opens a day, 'count' adds one. */
function addCount(b, db, uid, name, form) {
  const ref = doc(db, `users/${uid}/limits/${name}`);
  const at = serverTimestamp();
  if (form === 'day') b.set(ref, { at, day: at, today: 1 });
  else b.update(ref, { at, today: increment(1) });
}
async function seedCount(uid, name, data) {
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), `users/${uid}/limits/${name}`), data);
  });
}
async function signUpMany(...names) {
  for (const n of names) await signUp(n, n);
}
function startChat(db, me, peer, form) {
  const ids = [me, peer].sort();
  const b = writeBatch(db);
  b.set(doc(db, 'chats', ids.join('_')), chatDoc(me, ids));
  if (form) addCount(b, db, me, 'chats', form);
  return b.commit();
}

test('new chats: counted, up to 50 a day', async () => {
  await signUpMany('alice', 'bob', 'carol', 'dave');
  const a = ctx('alice');
  await assertSucceeds(startChat(a, 'alice', 'bob', 'day'));
  await assertSucceeds(startChat(a, 'alice', 'carol', 'count'));
  await seedCount('alice', 'chats', { at: ago(1000), day: ago(HOUR), today: 50 });
  await assertFails(startChat(a, 'alice', 'dave', 'count'));
  await assertFails(startChat(a, 'alice', 'dave', 'day')); // the day is still running
  await seedCount('alice', 'chats', { at: ago(1000), day: ago(25 * HOUR), today: 50 });
  await assertSucceeds(startChat(a, 'alice', 'dave', 'day'));
});
test('new chats: the counter cannot be left out (#12)', async () => {
  await signUpMany('alice', 'bob');
  await assertFails(startChat(ctx('alice'), 'alice', 'bob', null)); // as apps before v0.3.4 did
  await assertSucceeds(startChat(ctx('alice'), 'alice', 'bob', 'day'));
});
test('daily counters: counts and times cannot be forged, and only account deletion removes them', async () => {
  await signUpMany('alice', 'bob');
  const a = ctx('alice');
  await assertSucceeds(startChat(a, 'alice', 'bob', 'day'));
  const counter = doc(a, 'users/alice/limits/chats');
  const at = serverTimestamp();
  await assertFails(updateDoc(counter, { at, today: increment(2) }));
  await assertFails(updateDoc(counter, { at, today: 0 }));
  await assertFails(updateDoc(counter, { at, day: ago(25 * HOUR), today: 1 }));
  await assertFails(updateDoc(counter, { at: ago(1000), today: increment(1) }));
  await assertFails(setDoc(doc(a, 'users/alice/limits/other'), { at, day: at, today: 1 }));
  await assertFails(setDoc(doc(ctx('bob'), 'users/alice/limits/chats'), { at, day: at, today: 1 }));
  await assertFails(deleteDoc(counter));
  await assertSucceeds(updateDoc(doc(a, 'users/alice'), { deleting: true }));
  await assertSucceeds(deleteDoc(counter));
});
test('prekey claims: counted, up to 200 a day; past that the claim is refused', async () => {
  await signUpMany('alice', 'bob');
  await setDoc(doc(ctx('alice'), 'users/alice/devices/device-0001'), deviceDoc());
  const pk = (id) => `users/alice/devices/device-0001/prekeys/${id}`;
  for (const id of ['opk-000001', 'opk-000002', 'opk-000003']) {
    await setDoc(doc(ctx('alice'), pk(id)), pkDoc('onetime'));
  }
  const b = ctx('bob');
  const claim = (id, form) => runTransaction(b, async (tx) => {
    const ref = doc(b, pk(id));
    await tx.get(ref);
    tx.delete(ref);
    const counter = doc(b, 'users/bob/limits/claims');
    const at = serverTimestamp();
    if (form === 'day') tx.set(counter, { at, day: at, today: 1 });
    else if (form === 'count') tx.update(counter, { at, today: increment(1) });
  });
  await assertSucceeds(claim('opk-000001', 'day'));
  await assertSucceeds(claim('opk-000002', 'count'));
  await seedCount('bob', 'claims', { at: ago(1000), day: ago(HOUR), today: 200 });
  await assertFails(claim('opk-000003', 'count'));
  await assertFails(claim('opk-000003', null)); // nor without a counter
  await assertSucceeds(deleteDoc(doc(ctx('alice'), pk('opk-000003')))); // the owner is not counted
});
test('unauthenticated cannot read or write anything', async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(db, 'users', 'alice')));
  await assertFails(setDoc(doc(db, 'users', 'alice'), { username: 'alice' }));
});
test('no enumeration of users or usernames', async () => {
  await signUp('alice', 'alice'); await signUp('bob', 'bob');
  await assertFails(getDocs(collection(ctx('bob'), 'users')));
  await assertFails(getDocs(collection(ctx('bob'), 'usernames')));
  await assertSucceeds(getDoc(doc(ctx('bob'), 'usernames', 'alice')));
});
test('profile: owner can rename display only; username immutable; others cannot write', async () => {
  await signUp('alice', 'alice'); await signUp('bob', 'bob');
  await assertSucceeds(updateDoc(doc(ctx('alice'), 'users', 'alice'), { displayName: 'Al' }));
  await assertFails(updateDoc(doc(ctx('alice'), 'users', 'alice'), { username: 'bob' }));
  await assertFails(updateDoc(doc(ctx('bob'), 'users', 'alice'), { displayName: 'pwned' }));
  await assertFails(updateDoc(doc(ctx('alice'), 'users', 'alice'), { email: 'a@b.c' }));
});

// ---------- devices ----------
test('devices: owner creates, others read, others cannot write', async () => {
  await signUp('alice', 'alice'); await signUp('bob', 'bob');
  await assertSucceeds(setDoc(doc(ctx('alice'), 'users/alice/devices/device-0001'), deviceDoc()));
  await assertSucceeds(getDoc(doc(ctx('bob'), 'users/alice/devices/device-0001')));
  await assertSucceeds(getDocs(collection(ctx('bob'), 'users/alice/devices')));
  await assertFails(setDoc(doc(ctx('bob'), 'users/alice/devices/device-0002'), deviceDoc()));
  await assertFails(setDoc(doc(ctx('alice'), 'users/alice/devices/x'), deviceDoc())); // bad id
  await assertFails(setDoc(doc(ctx('alice'), 'users/alice/devices/device-0003'), { ...deviceDoc(), extra: 1 }));
});
test('devices: keys immutable, revoke allowed', async () => {
  await signUp('alice', 'alice');
  const ref = doc(ctx('alice'), 'users/alice/devices/device-0001');
  await setDoc(ref, deviceDoc());
  await assertFails(updateDoc(ref, { x25519Pub: 'z'.repeat(44) }));
  await assertSucceeds(updateDoc(ref, { revokedAt: serverTimestamp() }));
});

// ---------- chats ----------
test('chat create: participant with canonical id succeeds', async () => {
  await setupChat();
});
test('chat create: non-canonical id, wrong order, third-party, missing user rejected', async () => {
  await signUp('alice', 'alice'); await signUp('bob', 'bob'); await signUp('eve', 'eve');
  const base = { initiator: 'alice', accepted: false, requestCount: 0, createdAt: serverTimestamp(), lastMessageAt: serverTimestamp() };
  await assertFails(newChat(ctx('alice'), 'alice', 'bob_alice', { participants: ['bob', 'alice'], ...base }));
  await assertFails(newChat(ctx('alice'), 'alice', 'weird', { participants: ['alice', 'bob'], ...base }));
  await assertFails(newChat(ctx('eve'), 'eve', 'alice_bob', { participants: ['alice', 'bob'], ...base }));
  await assertFails(newChat(ctx('alice'), 'alice', 'alice_ghost', { participants: ['alice', 'ghost'], ...base }));
  await assertFails(newChat(ctx('alice'), 'alice', 'alice_alice', { participants: ['alice', 'alice'], ...base }));
});
test('chat read: participants only', async () => {
  await setupChat();
  await assertSucceeds(getDoc(doc(ctx('bob'), 'chats', 'alice_bob')));
  await assertFails(getDoc(doc(ctx('eve'), 'chats', 'alice_bob')));
});
test('chat list: must be filtered by own uid', async () => {
  await setupChat();
  const c = collection(ctx('alice'), 'chats');
  await assertSucceeds(getDocs(query(c, where('participants', 'array-contains', 'alice'))));
  await assertFails(getDocs(c));
  await assertFails(getDocs(query(collection(ctx('eve'), 'chats'), where('participants', 'array-contains', 'alice'))));
});
test('chat update: only lastMessageAt; no participants change; no delete', async () => {
  await setupChat();
  await assertSucceeds(updateDoc(doc(ctx('bob'), 'chats', 'alice_bob'), { lastMessageAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(ctx('bob'), 'chats', 'alice_bob'), { participants: ['alice', 'eve'] }));
  await assertFails(deleteDoc(doc(ctx('bob'), 'chats', 'alice_bob')));
});

// ---------- messages ----------
test('message: participant sends valid envelope, both read', async () => {
  await setupChat();
  await assertSucceeds(setMsg(doc(ctx('alice'), 'chats/alice_bob/messages/m1'), msg('alice')));
  await assertSucceeds(getDoc(doc(ctx('bob'), 'chats/alice_bob/messages/m1')));
  await assertSucceeds(getDocs(collection(ctx('bob'), 'chats/alice_bob/messages')));
});
test('message: spoofed sender, outsider, plaintext field, fake timestamp, empty envelopes rejected', async () => {
  await setupChat();
  const m = (c) => doc(ctx(c), 'chats/alice_bob/messages/m1');
  await assertFails(setMsg(m('alice'), msg('bob')));
  await assertFails(setMsg(m('eve'), msg('eve')));
  await assertFails(setMsg(m('alice'), msg('alice', { text: 'hello in plaintext' })));
  await assertFails(setMsg(m('alice'), msg('alice', { ts: new Date('2020-01-01') })));
  await assertFails(setMsg(m('alice'), msg('alice', { envelopes: {} })));
  await assertFails(setMsg(m('alice'), msg('alice', { envelopes: 'str' })));
});
test('message: outsider cannot read; messages immutable; no message in nonexistent chat', async () => {
  await setupChat();
  await setMsg(doc(ctx('alice'), 'chats/alice_bob/messages/m1'), msg('alice'));
  await assertFails(getDoc(doc(ctx('eve'), 'chats/alice_bob/messages/m1')));
  await assertFails(getDocs(collection(ctx('eve'), 'chats/alice_bob/messages')));
  await assertFails(updateDoc(doc(ctx('alice'), 'chats/alice_bob/messages/m1'), { senderDevice: 'x' }));
  await assertFails(deleteDoc(doc(ctx('bob'), 'chats/alice_bob/messages/m1'))); // not the sender
  await assertFails(setMsg(doc(ctx('alice'), 'chats/alice_carol/messages/m1'), msg('alice')));
});
test('unknown collections are denied', async () => {
  await signUp('alice', 'alice');
  await assertFails(setDoc(doc(ctx('alice'), 'misc/x'), { a: 1 }));
});

// ---------- recovery backup & device linking ----------
const backupDoc = () => ({ blob: 'x'.repeat(9000), v: 1, createdAt: serverTimestamp() });

test('backup: owner creates/reads/replaces/deletes; nobody else can read or write', async () => {
  await signUp('alice', 'alice'); await signUp('bob', 'bob');
  const ref = (c) => doc(ctx(c), 'users/alice/private/backup');
  await assertSucceeds(setDoc(ref('alice'), backupDoc()));
  await assertSucceeds(getDoc(ref('alice')));
  await assertSucceeds(setDoc(ref('alice'), backupDoc()));
  await assertFails(getDoc(ref('bob')));
  await assertFails(setDoc(ref('bob'), backupDoc()));
  await assertFails(deleteDoc(ref('bob')));
  await assertSucceeds(deleteDoc(ref('alice')));
});
test('backup: shape validated (other doc ids, extra fields, wrong version, oversize, fake time)', async () => {
  await signUp('alice', 'alice');
  const d = (id) => doc(ctx('alice'), `users/alice/private/${id}`);
  await assertFails(setDoc(d('other'), backupDoc()));
  await assertFails(setDoc(d('backup'), { ...backupDoc(), extra: 1 }));
  await assertFails(setDoc(d('backup'), { ...backupDoc(), v: 2 }));
  await assertFails(setDoc(d('backup'), { ...backupDoc(), blob: 'x'.repeat(40000) }));
  await assertFails(setDoc(d('backup'), { ...backupDoc(), createdAt: new Date('2020-01-01') }));
});

const linkReq = () => ({ x25519Pub: 'a'.repeat(44), kemPub: 'b'.repeat(1580), createdAt: serverTimestamp() });
const sealed = () => ({ ek: 'a', kemCt: 'b', nonce: 'c', ct: 'd', mac: 'e' });

test('link request: owner-only lifecycle; response can be added once, strictly shaped', async () => {
  await signUp('alice', 'alice'); await signUp('bob', 'bob');
  const r = (c) => doc(ctx(c), 'users/alice/linkRequests/newdevice-0001');
  await assertSucceeds(setDoc(r('alice'), linkReq()));
  await assertFails(getDoc(r('bob')));
  await assertFails(setDoc(doc(ctx('bob'), 'users/alice/linkRequests/evil-device-1'), linkReq()));
  await assertFails(updateDoc(r('bob'), { response: sealed() }));
  await assertFails(updateDoc(r('alice'), { response: { ...sealed(), extra: 'x' } }));
  await assertFails(updateDoc(r('alice'), { response: 'string' }));
  await assertFails(updateDoc(r('alice'), { kemPub: 'swapped' }));
  await assertSucceeds(updateDoc(r('alice'), { response: sealed() }));
  await assertFails(updateDoc(r('alice'), { response: sealed() })); // no overwrite
  await assertSucceeds(getDoc(r('alice')));
  await assertSucceeds(deleteDoc(r('alice')));
});
test('link request: bad id / extra fields rejected', async () => {
  await signUp('alice', 'alice');
  await assertFails(setDoc(doc(ctx('alice'), 'users/alice/linkRequests/x'), linkReq()));
  await assertFails(setDoc(doc(ctx('alice'), 'users/alice/linkRequests/newdevice-0002'), { ...linkReq(), response: sealed() }));
});
test('owner may delete own device docs (identity reset); others may not', async () => {
  await signUp('alice', 'alice'); await signUp('bob', 'bob');
  await setDoc(doc(ctx('alice'), 'users/alice/devices/device-0001'), deviceDoc());
  await assertFails(deleteDoc(doc(ctx('bob'), 'users/alice/devices/device-0001')));
  await assertSucceeds(deleteDoc(doc(ctx('alice'), 'users/alice/devices/device-0001')));
});

// ---------- hardening from the review ----------
test('message: sender device must exist, belong to the sender, and not be revoked', async () => {
  await setupChat();
  const m = (c, id) => doc(ctx(c), `chats/alice_bob/messages/${id}`);
  await assertSucceeds(setMsg(m('alice', 'ok'), msg('alice')));
  await assertFails(setMsg(m('alice', 'ghost'), msg('alice', { senderDevice: 'no-such-device' })));
  await assertFails(setMsg(m('alice', 'stolen'), msg('alice', { senderDevice: 'dev-of-bob' })));
  await updateDoc(doc(ctx('alice'), 'users/alice/devices/dev-of-alice'), { revokedAt: serverTimestamp() });
  await assertFails(setMsg(m('alice', 'revoked'), msg('alice')));
});
test('chat: uids containing underscores cannot form a chat', async () => {
  await signUp('a_b', 'a_b'); await signUp('zed', 'zed');
  await assertFails(newChat(ctx('a_b'), 'a_b', 'a_b_zed', {
    ...chatDoc('a_b', ['a_b', 'zed']) }));
});
test('message: envelope map size boundaries 0/1/40/41', async () => {
  await setupChat();
  const env = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`d${i}`, { ct: 'x' }]));
  const m = (id) => doc(ctx('alice'), `chats/alice_bob/messages/${id}`);
  await assertFails(setMsg(m('e0'), msg('alice', { envelopes: env(0) })));
  await assertSucceeds(setMsg(m('e1'), msg('alice', { envelopes: env(1) })));
  await assertSucceeds(setMsg(m('e40'), msg('alice', { envelopes: env(40) })));
  await assertFails(setMsg(m('e41'), msg('alice', { envelopes: env(41) })));
});

// ---------- prekeys ----------
const pkDoc = (kind = 'onetime') => ({
  kind, x25519Pub: 'a'.repeat(44), kemPub: 'b'.repeat(1580), createdAt: serverTimestamp(),
  ...(kind === 'signed' ? { sig: 's'.repeat(4500) } : {}),
});
test('prekeys: owner publishes and deletes; everyone signed-in reads; others cannot write', async () => {
  await signUp('alice', 'alice'); await signUp('bob', 'bob');
  await setDoc(doc(ctx('alice'), 'users/alice/devices/device-0001'), deviceDoc());
  const p = (c, id) => doc(ctx(c), `users/alice/devices/device-0001/prekeys/${id}`);
  await assertSucceeds(setDoc(p('alice', 'spk-000001'), pkDoc('signed')));
  await assertSucceeds(setDoc(p('alice', 'opk-000001'), pkDoc('onetime')));
  await assertSucceeds(getDoc(p('bob', 'opk-000001')));
  await assertSucceeds(getDocs(query(collection(ctx('bob'), 'users/alice/devices/device-0001/prekeys'), where('kind', '==', 'onetime'))));
  await assertFails(setDoc(p('bob', 'opk-evil001'), pkDoc('onetime')));
  await assertFails(deleteDoc(p('bob', 'spk-000001'))); // others may only claim one-time prekeys
  await assertSucceeds(deleteDoc(p('alice', 'opk-000001')));
});
test('prekeys: shape is validated (kind, signature rules, extra fields, update, unauthenticated)', async () => {
  await signUp('alice', 'alice');
  const p = (id) => doc(ctx('alice'), `users/alice/devices/device-0001/prekeys/${id}`);
  const noSig = pkDoc('signed'); delete noSig.sig;
  await assertFails(setDoc(p('spk-bad-001'), noSig));
  await assertFails(setDoc(p('opk-bad-001'), { ...pkDoc('onetime'), sig: 'x' }));
  await assertFails(setDoc(p('bad-kind-01'), { ...pkDoc('onetime'), kind: 'weird' }));
  await assertFails(setDoc(p('extra-0001'), { ...pkDoc('onetime'), extra: 1 }));
  await assertFails(setDoc(p('big-key-01'), { ...pkDoc('onetime'), kemPub: 'b'.repeat(5000) }));
  await assertFails(setDoc(p('bad'), pkDoc('onetime'))); // id too short
  await assertSucceeds(setDoc(p('good-key-01'), pkDoc('onetime')));
  await assertFails(updateDoc(p('good-key-01'), { x25519Pub: 'z'.repeat(44) }));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'users/alice/devices/device-0001/prekeys/good-key-01')));
});

// ---------- message requests ----------
async function sendBatch(user, id, extraChat = {}, msgExtra = {}) {
  const db = ctx(user);
  return withClock(db, user, (b) => {
    b.set(doc(db, `chats/alice_bob/messages/${id}`), msg(user, msgExtra));
    b.update(doc(db, 'chats', 'alice_bob'), { lastMessageAt: serverTimestamp(), ...extraChat });
  });
}

test('requests: chat must be created unaccepted, by its initiator, with a zero counter', async () => {
  await signUp('alice', 'alice'); await signUp('bob', 'bob');
  const c = (data) => newChat(ctx('alice'), 'alice', 'alice_bob', data);
  await assertFails(c({ ...chatDoc('alice', ['alice', 'bob']), accepted: true }));
  await assertFails(c({ ...chatDoc('alice', ['alice', 'bob']), requestCount: 2 }));
  await assertFails(c({ ...chatDoc('bob', ['alice', 'bob']) })); // wrong initiator
  const legacy = chatDoc('alice', ['alice', 'bob']); delete legacy.initiator;
  await assertFails(c(legacy));
  await assertSucceeds(c(chatDoc('alice', ['alice', 'bob'])));
});

test('requests: initiator gets exactly 3 messages before the other person accepts', async () => {
  await setupRequestChat();
  await assertSucceeds(sendBatch('alice', 'r1', { requestCount: increment(1) }));
  await assertSucceeds(sendBatch('alice', 'r2', { requestCount: increment(1) }));
  await assertSucceeds(sendBatch('alice', 'r3', { requestCount: increment(1) }));
  await assertFails(sendBatch('alice', 'r4', { requestCount: increment(1) }));
});
test('requests: a message without bumping the counter, or bumping by more than one, is refused', async () => {
  await setupRequestChat();
  const db = ctx('alice');
  await assertFails(setDoc(doc(db, 'chats/alice_bob/messages/x1'), msg('alice'))); // no batch update
  await assertFails(sendBatch('alice', 'x2', { requestCount: increment(2) }));
  await assertFails(sendBatch('alice', 'x3', {})); // lastMessageAt only, counter not bumped
});
test('requests: the recipient cannot send until accepting; replying accepts', async () => {
  await setupRequestChat();
  const db = ctx('bob');
  await assertFails(setMsg(doc(db, 'chats/alice_bob/messages/b0'), msg('bob')));
  await assertFails(sendBatch('bob', 'b1', {})); // batch without acceptance
  await assertSucceeds(sendBatch('bob', 'b2', { accepted: true }));
  // now accepted: both send freely, no counters
  await assertSucceeds(setMsg(doc(ctx('alice'), 'chats/alice_bob/messages/a-free'), msg('alice')));
  await assertSucceeds(setMsg(doc(ctx('bob'), 'chats/alice_bob/messages/b-free'), msg('bob')));
});
test('requests: only the recipient can accept; acceptance cannot be undone; fields are protected', async () => {
  await setupRequestChat();
  const a = doc(ctx('alice'), 'chats', 'alice_bob');
  const b = doc(ctx('bob'), 'chats', 'alice_bob');
  await assertFails(updateDoc(a, { accepted: true, lastMessageAt: serverTimestamp() })); // self-accept
  await assertFails(updateDoc(b, { accepted: true, initiator: 'bob', lastMessageAt: serverTimestamp() }));
  await assertFails(updateDoc(b, { accepted: true, requestCount: 1, lastMessageAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(b, { accepted: true, lastMessageAt: serverTimestamp() }));
  await assertFails(updateDoc(b, { accepted: false, lastMessageAt: serverTimestamp() }));
  await assertFails(updateDoc(a, { requestCount: 2, lastMessageAt: serverTimestamp() }));
});
test('requests: outsiders cannot touch the chat or its counters', async () => {
  await setupRequestChat();
  const e = doc(ctx('eve'), 'chats', 'alice_bob');
  await assertFails(updateDoc(e, { accepted: true, lastMessageAt: serverTimestamp() }));
  await assertFails(setMsg(doc(ctx('eve'), 'chats/alice_bob/messages/e1'), msg('eve')));
});
test('legacy chats without request fields still allow messaging (migration safety)', async () => {
  await signUp('alice', 'alice'); await signUp('bob', 'bob');
  await setDoc(doc(ctx('alice'), 'users/alice/devices/dev-of-alice'), deviceDoc());
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'chats', 'alice_bob'),
      { participants: ['alice', 'bob'], createdAt: new Date(), lastMessageAt: new Date() });
  });
  await assertSucceeds(setMsg(doc(ctx('alice'), 'chats/alice_bob/messages/l1'), msg('alice')));
});

// ---------- blocking ----------
test('blocks: owner-only, shape validated, cannot block yourself', async () => {
  await signUp('alice', 'alice'); await signUp('bob', 'bob');
  const mine = (id) => doc(ctx('alice'), `users/alice/blocks/${id}`);
  await assertSucceeds(setDoc(mine('bob'), { createdAt: serverTimestamp() }));
  await assertSucceeds(getDoc(mine('bob')));
  await assertFails(getDoc(doc(ctx('bob'), 'users/alice/blocks/bob'))); // blocked person can't see it
  await assertFails(setDoc(doc(ctx('bob'), 'users/alice/blocks/eve'), { createdAt: serverTimestamp() }));
  await assertFails(setDoc(mine('alice'), { createdAt: serverTimestamp() }));
  await assertFails(setDoc(mine('eve'), { createdAt: serverTimestamp(), why: 'x' }));
  await assertFails(updateDoc(mine('bob'), { createdAt: serverTimestamp() }));
  await assertSucceeds(deleteDoc(mine('bob')));
});
test('blocks: a blocked person cannot start a chat or send messages; unblocking restores access', async () => {
  await signUp('alice', 'alice'); await signUp('bob', 'bob');
  await setDoc(doc(ctx('alice'), 'users/alice/devices/dev-of-alice'), deviceDoc());
  await setDoc(doc(ctx('bob'), 'users/bob/devices/dev-of-bob'), deviceDoc());
  await setDoc(doc(ctx('bob'), 'users/bob/blocks/alice'), { createdAt: serverTimestamp() });
  await assertFails(newChat(ctx('alice'), 'alice', 'alice_bob', chatDoc('alice', ['alice', 'bob'])));
  await deleteDoc(doc(ctx('bob'), 'users/bob/blocks/alice'));
  await assertSucceeds(newChat(ctx('alice'), 'alice', 'alice_bob', chatDoc('alice', ['alice', 'bob'])));
  await assertSucceeds(sendBatch('alice', 'ok1', { requestCount: increment(1) }));
  await setDoc(doc(ctx('bob'), 'users/bob/blocks/alice'), { createdAt: serverTimestamp() });
  await assertFails(sendBatch('alice', 'blocked1', { requestCount: increment(1) }));
  await assertSucceeds(getDocs(collection(ctx('alice'), 'chats/alice_bob/messages'))); // history stays readable
  await deleteDoc(doc(ctx('bob'), 'users/bob/blocks/alice'));
  await assertSucceeds(sendBatch('alice', 'again', { requestCount: increment(1) }));
});
test('blocks: blocking also stops an accepted conversation (both directions are separate blocks)', async () => {
  await setupChat();
  await setDoc(doc(ctx('bob'), 'users/bob/blocks/alice'), { createdAt: serverTimestamp() });
  await assertFails(setMsg(doc(ctx('alice'), 'chats/alice_bob/messages/z1'), msg('alice')));
  await assertSucceeds(setMsg(doc(ctx('bob'), 'chats/alice_bob/messages/z2'), msg('bob'))); // blocker may still write
});

// ---------- reports ----------
const report = (over = {}) => ({
  reporter: 'alice', reported: 'bob', reason: 'spam', createdAt: serverTimestamp(), ...over,
});
test('reports: the app spam report is accepted; nobody can read it; one per pair', async () => {
  await signUp('alice', 'alice'); await signUp('bob', 'bob');
  const r = (u, id) => doc(ctx(u), 'reports', id);
  // Exactly what the app's SafetyService.reportSpam writes.
  await assertSucceeds(setDoc(r('alice', 'alice_bob'), report()));
  await assertFails(getDoc(r('alice', 'alice_bob')));
  await assertFails(getDocs(collection(ctx('alice'), 'reports')));
  await assertFails(getDoc(r('bob', 'alice_bob')));
  await assertFails(deleteDoc(r('alice', 'alice_bob')));
  // Reporting again replaces the report (the app uses set, not create).
  await assertSucceeds(setDoc(r('alice', 'alice_bob'), report()));
  await assertFails(updateDoc(r('bob', 'alice_bob'), { reason: 'spam', createdAt: serverTimestamp() }));
});
test('reports: no field can carry message text', async () => {
  await signUp('alice', 'alice'); await signUp('bob', 'bob');
  const r = doc(ctx('alice'), 'reports', 'alice_bob');
  await assertFails(setDoc(r, report({ note: 'unsolicited links' })));
  await assertFails(setDoc(r, report({ context: ['hi', 'buy now'] })));
  await assertFails(setDoc(r, report({ chatId: 'alice_bob' })));
  await assertSucceeds(setDoc(r, report()));
  await assertFails(updateDoc(r, { note: 'added later' }));
  await assertFails(updateDoc(r, { context: ['added later'], createdAt: serverTimestamp() }));
});
test('reports: shape validation (impersonated reporter, self report, id, reason, sizes, extra fields)', async () => {
  await signUp('alice', 'alice'); await signUp('bob', 'bob');
  const r = (id) => doc(ctx('alice'), 'reports', id);
  await assertFails(setDoc(r('alice_bob'), report({ reporter: 'bob' })));
  await assertFails(setDoc(r('alice_alice'), report({ reported: 'alice' })));
  await assertFails(setDoc(r('wrong-id'), report()));
  await assertFails(setDoc(r('alice_bob'), report({ reason: 'because' })));
  await assertFails(setDoc(r('alice_bob'), report({ reason: 'harassment' }))); // spam only
  await assertFails(setDoc(r('alice_bob'), report({ extra: 1 })));
  await assertFails(setDoc(r('alice_bob'), report({ createdAt: new Date('2020-01-01') })));
  await assertFails(setDoc(doc(env.unauthenticatedContext().firestore(), 'reports', 'alice_bob'), report()));
  await assertSucceeds(setDoc(r('alice_bob'), report()));
});

// The moderator login is an Auth account with the custom claim and no profile.
// authenticatedContext's second argument is the token claims.
const moderatorDb = (uid = 'mod-1', claims = {}) => env.authenticatedContext(uid, {
  moderator: true,
  email: 'moderator@fireplacechat.com',
  ...claims,
}).firestore();

test('reports: a profile-less moderator can read reports, and cannot write or read anything else', async () => {
  await signUp('alice', 'alice');
  await signUp('bob', 'bob');
  await assertSucceeds(setDoc(doc(ctx('alice'), 'reports', 'alice_bob'), report()));
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await updateDoc(doc(db, 'reports', 'alice_bob'), { status: 'open', operatorNote: 'kept' });
    await setDoc(doc(db, 'chats', 'alice_bob'), { participants: ['alice', 'bob'] });
    await setDoc(doc(db, 'chats/alice_bob/messages/m1'), { senderUid: 'alice', envelopes: { x: 'cipher' } });
    await setDoc(doc(db, 'users/alice/private/backup'), { blob: 'sealed' });
    await setDoc(doc(db, 'users/alice/blocks/bob'), { createdAt: new Date() });
    await setDoc(doc(db, 'moderationLog', 'entry'), { action: 'ban' });
  });

  const db = moderatorDb();
  const snap = await assertSucceeds(getDoc(doc(db, 'reports', 'alice_bob')));
  assert.equal(snap.data().reason, 'spam');
  assert.equal(snap.data().note, undefined, 'no text field exists on a report');
  assert.equal(snap.data().operatorNote, 'kept');
  const listed = await assertSucceeds(
    getDocs(query(collection(db, 'reports'), orderBy('createdAt', 'desc'))),
  );
  assert.equal(listed.size, 1);
  await assertFails(deleteDoc(doc(db, 'reports', 'alice_bob')));
  await assertFails(updateDoc(doc(db, 'reports', 'alice_bob'), { reason: 'spam', createdAt: serverTimestamp() }));
  await assertFails(setDoc(doc(db, 'reports', 'mod-1_bob'), {
    reporter: 'mod-1', reported: 'bob', reason: 'spam', createdAt: serverTimestamp(),
  }));

  await assertFails(getDoc(doc(db, 'users', 'alice')));
  await assertFails(getDoc(doc(db, 'usernames', 'alice')));
  await assertFails(getDocs(collection(db, 'users')));
  await assertFails(getDoc(doc(db, 'chats', 'alice_bob')));
  await assertFails(getDoc(doc(db, 'chats/alice_bob/messages/m1')));
  await assertFails(getDocs(collection(db, 'chats/alice_bob/messages')));
  await assertFails(getDoc(doc(db, 'users/alice/private/backup')));
  await assertFails(getDoc(doc(db, 'users/alice/blocks/bob')));
  await assertFails(getDocs(collection(db, 'users/alice/devices')));
  await assertFails(getDoc(doc(db, 'moderationLog', 'entry')));

  // A real account, even with the claim, still cannot read the queue.
  const claimedUser = env.authenticatedContext('alice', {
    moderator: true, email: email('alice'),
  }).firestore();
  await assertFails(getDoc(doc(claimedUser, 'reports', 'alice_bob')));
  await assertFails(getDocs(collection(claimedUser, 'reports')));

  const banned = moderatorDb('mod-banned', { banned: true });
  await assertFails(getDocs(collection(banned, 'reports')));
  await assertFails(getDocs(collection(env.unauthenticatedContext().firestore(), 'reports')));
  // The reporter still cannot read their own report back.
  await assertFails(getDoc(doc(ctx('alice'), 'reports', 'alice_bob')));
});

test('invites: a moderator claim cannot claim an invite; a normal sign-up still can', async () => {
  await makeInvite('for-mod');
  await assertFails(updateDoc(doc(moderatorDb(), 'invites', hashOf('for-mod')), {
    usedBy: 'mod-1', usedAt: serverTimestamp(),
  }));
  const code = 'invite-for-ghost-ghost';
  await makeInvite(code);
  await assertSucceeds(signUpBatch(ctx('ghost', 'ghost'), 'ghost', 'ghost', code).commit());
});

// ---------- account deletion ----------
test('deletion: owner can release username and delete profile; others cannot', async () => {
  await signUp('alice', 'alice'); await signUp('bob', 'bob');
  await assertFails(deleteDoc(doc(ctx('bob'), 'usernames', 'alice')));
  await assertFails(deleteDoc(doc(ctx('bob'), 'users', 'alice')));
  await assertSucceeds(deleteDoc(doc(ctx('alice'), 'usernames', 'alice')));
  await assertSucceeds(deleteDoc(doc(ctx('alice'), 'users', 'alice')));
  // the name can be claimed again afterwards
  await assertSucceeds(signUp('newalice', 'alice'));
});
test('deletion: profile can be flagged as deleting, only to true, and the flag cannot be removed', async () => {
  await signUp('alice', 'alice');
  const ref = doc(ctx('alice'), 'users', 'alice');
  await assertFails(updateDoc(ref, { deleting: false }));
  await assertFails(updateDoc(ref, { deleting: 'yes' }));
  await assertSucceeds(updateDoc(ref, { deleting: true }));
  await assertFails(updateDoc(doc(ctx('alice'), 'users', 'alice'), { displayName: 'x', deleting: false }));
  // The fence: once flagged, the account can no longer change its profile either.
  await assertFails(updateDoc(ref, { displayName: 'Still me' }));
  await assertFails(updateDoc(doc(ctx('bob'), 'users', 'alice'), { deleting: true }));
});
test('deletion: you can delete only the messages you sent', async () => {
  await setupChat();
  await setMsg(doc(ctx('alice'), 'chats/alice_bob/messages/a1'), msg('alice'));
  await setMsg(doc(ctx('bob'), 'chats/alice_bob/messages/b1'), msg('bob'));
  await assertFails(deleteDoc(doc(ctx('bob'), 'chats/alice_bob/messages/a1')));
  await assertFails(deleteDoc(doc(ctx('eve'), 'chats/alice_bob/messages/a1')));
  await assertSucceeds(deleteDoc(doc(ctx('alice'), 'chats/alice_bob/messages/a1')));
  // your own sent messages can be listed with a filter, for bulk deletion
  const q = query(collection(ctx('bob'), 'chats/alice_bob/messages'), where('senderUid', '==', 'bob'));
  await assertSucceeds(getDocs(q));
});
test('deletion: a chat document can be removed only once the other person is gone', async () => {
  await setupChat();
  await assertFails(deleteDoc(doc(ctx('bob'), 'chats', 'alice_bob'))); // alice still exists
  await assertFails(deleteDoc(doc(ctx('eve'), 'chats', 'alice_bob'))); // not a participant
  await deleteDoc(doc(ctx('alice'), 'users', 'alice'));               // alice deletes her account
  await assertSucceeds(deleteDoc(doc(ctx('bob'), 'chats', 'alice_bob')));
});
test('deletion: all of an owner\'s private documents can be removed', async () => {
  await signUp('alice', 'alice');
  const a = (path) => doc(ctx('alice'), path);
  await setDoc(a('users/alice/devices/device-0001'), deviceDoc());
  await setDoc(a('users/alice/devices/device-0001/prekeys/opk-000001'), pkDoc('onetime'));
  await setDoc(a('users/alice/private/backup'), backupDoc());
  await setDoc(a('users/alice/linkRequests/newdevice-0001'), linkReq());
  await setDoc(a('users/alice/blocks/bob'), { createdAt: serverTimestamp() });
  for (const path of [
    'users/alice/devices/device-0001/prekeys/opk-000001', 'users/alice/devices/device-0001',
    'users/alice/private/backup', 'users/alice/linkRequests/newdevice-0001', 'users/alice/blocks/bob',
  ]) await assertSucceeds(deleteDoc(a(path)));
});

// ---------- bans (set by the operator tooling as a custom claim) ----------
const bannedCtx = (uid) => {
  const db = env.authenticatedContext(uid, { email: `${uid}@users.fireplace.invalid`, banned: true }).firestore();
  uidByApp.set(db.app.name, uid);
  return db;
};

test('bans: a banned account cannot start chats, send, or accept', async () => {
  await setupChat();
  await assertSucceeds(setMsg(doc(ctx('alice'), 'chats/alice_bob/messages/pre'), msg('alice')));
  const db = bannedCtx('alice');
  await assertFails(setMsg(doc(db, 'chats/alice_bob/messages/post'), msg('alice')));
  await assertFails(updateDoc(doc(db, 'chats', 'alice_bob'), { lastMessageAt: serverTimestamp() }));
  // reading and cleanup still work, and other people are unaffected
  await assertSucceeds(getDoc(doc(db, 'chats', 'alice_bob')));
  await assertSucceeds(setMsg(doc(ctx('bob'), 'chats/alice_bob/messages/b1'), msg('bob')));
});
test('bans: a banned account cannot create a chat', async () => {
  await signUp('alice', 'alice'); await signUp('bob', 'bob');
  await assertFails(newChat(bannedCtx('alice'), 'alice', 'alice_bob', chatDoc('alice', ['alice', 'bob'])));
  await assertSucceeds(newChat(ctx('alice'), 'alice', 'alice_bob', chatDoc('alice', ['alice', 'bob'])));
});
test('bans: banned=false behaves like no claim; a banned account can still delete itself', async () => {
  await signUp('alice', 'alice');
  const db = env.authenticatedContext('alice', { email: 'alice@users.fireplace.invalid', banned: false }).firestore();
  await assertSucceeds(updateDoc(doc(db, 'users', 'alice'), { displayName: 'ok' }));
  await assertSucceeds(deleteDoc(doc(bannedCtx('alice'), 'users', 'alice')));
});

// ---------- atomic one-time prekey claims ----------
test('prekeys: a signed-up person can claim (delete) someone else\'s one-time prekey, never the signed one', async () => {
  await signUp('alice', 'alice'); await signUp('bob', 'bob');
  await setDoc(doc(ctx('alice'), 'users/alice/devices/device-0001'), deviceDoc());
  const p = (c, id) => doc(ctx(c), `users/alice/devices/device-0001/prekeys/${id}`);
  await setDoc(p('alice', 'spk-000001'), pkDoc('signed'));
  await setDoc(p('alice', 'opk-000001'), pkDoc('onetime'));
  await assertFails(deleteDoc(p('bob', 'spk-000001')));
  await assertFails(deleteDoc(p('bob', 'opk-000001'))); // a claim must be counted
  const bob = ctx('bob');
  const b = writeBatch(bob);
  b.delete(doc(bob, 'users/alice/devices/device-0001/prekeys/opk-000001'));
  b.set(doc(bob, 'users/bob/limits/claims'), { at: serverTimestamp(), day: serverTimestamp(), today: 1 });
  await assertSucceeds(b.commit());
  await assertSucceeds(deleteDoc(p('alice', 'spk-000001'))); // owner can
});
test('prekeys: claiming works as a read+delete transaction and a second claimer finds it gone', async () => {
  await signUp('alice', 'alice'); await signUp('bob', 'bob'); await signUp('eve', 'eve');
  await setDoc(doc(ctx('alice'), 'users/alice/devices/device-0001'), deviceDoc());
  await setDoc(doc(ctx('alice'), 'users/alice/devices/device-0001/prekeys/opk-000001'), pkDoc('onetime'));
  const claim = (who) => { const db = ctx(who); return runTransaction(db, async (tx) => {
    const ref = doc(db, 'users/alice/devices/device-0001/prekeys/opk-000001');
    const snap = await tx.get(ref);
    if (!snap.exists()) return false;
    tx.delete(ref);
    const counter = doc(db, `users/${who}/limits/claims`);
    tx.set(counter, { at: serverTimestamp(), day: serverTimestamp(), today: 1 });
    return true;
  }); };
  assert.equal(await claim('bob'), true);
  assert.equal(await claim('eve'), false);
});
test('prekeys: accounts without a profile cannot claim', async () => {
  await signUp('alice', 'alice');
  await setDoc(doc(ctx('alice'), 'users/alice/devices/device-0001'), deviceDoc());
  await setDoc(doc(ctx('alice'), 'users/alice/devices/device-0001/prekeys/opk-000001'), pkDoc('onetime'));
  await assertFails(deleteDoc(doc(ctx('ghost'), 'users/alice/devices/device-0001/prekeys/opk-000001')));
});
test('prekeys: two people claiming the same one-time prekey AT THE SAME TIME - exactly one wins', async () => {
  for (const u of ['alice', 'bob', 'eve']) await signUp(u, u);
  await setDoc(doc(ctx('alice'), 'users/alice/devices/device-0001'), deviceDoc());
  await setDoc(doc(ctx('alice'), 'users/alice/devices/device-0001/prekeys/opk-000001'), pkDoc('onetime'));
  const claim = (who) => { const db = ctx(who); return runTransaction(db, async (tx) => {
    const ref = doc(db, 'users/alice/devices/device-0001/prekeys/opk-000001');
    const snap = await tx.get(ref);
    if (!snap.exists()) return false;
    await new Promise((r) => setTimeout(r, 150)); // widen the race window
    tx.delete(ref);
    const counter = doc(db, `users/${who}/limits/claims`);
    tx.set(counter, { at: serverTimestamp(), day: serverTimestamp(), today: 1 });
    return true;
  }); };
  // the loser either sees the document gone or is aborted by Firestore; the app treats both as "taken"
  const results = await Promise.all([claim('bob').catch(() => false), claim('eve').catch(() => false)]);
  assert.equal(results.filter(Boolean).length, 1, `results: ${results}`);
});

// ---------- push tokens ----------
const pushToken = (over = {}) => ({
  token: 'fcm-registration-token-0123456789abcdef',
  platform: 'ios',
  updatedAt: serverTimestamp(),
  ...over,
});
test('push tokens: only an owner with an active device can register a private token', async () => {
  await signUp('alice', 'alice'); await signUp('bob', 'bob');
  await setDoc(doc(ctx('alice'), 'users/alice/devices/device-0001'), deviceDoc());
  const token = doc(ctx('alice'), 'users/alice/pushTokens/device-0001');
  await assertSucceeds(setDoc(token, pushToken()));
  await assertSucceeds(updateDoc(token, pushToken({ token: 'fcm-refreshed-token-0123456789' })));
  await assertSucceeds(getDoc(token));
  await assertFails(getDoc(doc(ctx('bob'), 'users/alice/pushTokens/device-0001')));
  await assertFails(setDoc(doc(ctx('bob'), 'users/alice/pushTokens/device-0001'), pushToken()));
  await assertSucceeds(deleteDoc(token));
});
test('push tokens: token shape and device status are validated', async () => {
  await signUp('alice', 'alice');
  const ref = (id) => doc(ctx('alice'), `users/alice/pushTokens/${id}`);
  await assertFails(setDoc(ref('device-0001'), pushToken())); // no matching device
  await setDoc(doc(ctx('alice'), 'users/alice/devices/device-0001'), deviceDoc());
  await assertFails(setDoc(ref('device-0001'), pushToken({ platform: 'web' })));
  await assertFails(setDoc(ref('device-0001'), pushToken({ token: 'short' })));
  await assertFails(setDoc(ref('device-0001'), pushToken({ extra: true })));
  await assertSucceeds(setDoc(ref('device-0001'), pushToken()));
  await updateDoc(doc(ctx('alice'), 'users/alice/devices/device-0001'), {
    revokedAt: serverTimestamp(),
  });
  await assertFails(setDoc(ref('device-0001'), pushToken({ token: 'fcm-token-after-revoke-0123456789' })));
});
test('push tokens: a profile is required too (device alone is not enough)', async () => {
  await signUp('alice', 'alice');
  await setDoc(doc(ctx('alice'), 'users/alice/devices/device-0001'), deviceDoc());
  await deleteDoc(doc(ctx('alice'), 'users', 'alice')); // profile gone (deletion in progress)
  await assertFails(setDoc(doc(ctx('alice'), 'users/alice/pushTokens/device-0001'), pushToken()));
});

test('push tokens: the optional name preference must be a boolean', async () => {
  await signUp('alice', 'alice');
  await setDoc(doc(ctx('alice'), 'users/alice/devices/device-0001'), deviceDoc());
  const ref = doc(ctx('alice'), 'users/alice/pushTokens/device-0001');
  await assertSucceeds(setDoc(ref, pushToken({ showName: false })));
  await assertSucceeds(setDoc(ref, pushToken({ showName: true })));
  await assertSucceeds(setDoc(ref, pushToken())); // older apps omit it
  await assertFails(setDoc(ref, pushToken({ showName: 'no' })));
  await assertFails(setDoc(ref, pushToken({ showName: null })));
});
test('push tokens: the optional sound preference must be a boolean', async () => {
  await signUp('alice', 'alice');
  await setDoc(doc(ctx('alice'), 'users/alice/devices/device-0001'), deviceDoc());
  const ref = doc(ctx('alice'), 'users/alice/pushTokens/device-0001');
  await assertSucceeds(setDoc(ref, pushToken({ sound: false, showName: true })));
  await assertSucceeds(setDoc(ref, pushToken({ sound: true })));
  await assertFails(setDoc(ref, pushToken({ sound: 'pop' })));
  await assertFails(setDoc(ref, pushToken({ sound: 1 })));
});
test('push tokens: the optional data-push capability must be a boolean', async () => {
  await signUp('alice', 'alice');
  await setDoc(doc(ctx('alice'), 'users/alice/devices/device-0001'), deviceDoc());
  const ref = doc(ctx('alice'), 'users/alice/pushTokens/device-0001');
  const android = (over) => pushToken({ platform: 'android', ...over });
  await assertSucceeds(setDoc(ref, android({ dataPush: true, showName: false, sound: true })));
  await assertSucceeds(updateDoc(ref, android({ dataPush: false })));
  await assertSucceeds(setDoc(ref, android())); // older apps omit it
  await assertFails(setDoc(ref, android({ dataPush: 'yes' })));
  await assertFails(setDoc(ref, android({ dataPush: 1 })));
  await assertFails(setDoc(ref, android({ dataPush: null })));
  // Still only the owner.
  await signUp('bob', 'bob');
  await assertFails(setDoc(doc(ctx('bob'), 'users/alice/pushTokens/device-0001'), android({ dataPush: true })));
});
test('push throttle: clients can neither read nor write it', async () => {
  await signUp('alice', 'alice'); await signUp('bob', 'bob');
  const ref = doc(ctx('alice'), 'pushThrottle/alice_bob');
  await assertFails(getDoc(ref));
  await assertFails(setDoc(ref, { bob: serverTimestamp() }));
});

// ---------- retention: message expiry and account activity ----------
test('retention: a message must carry an expireAt about 30 days out (28 to 32 days)', async () => {
  await setupChat();
  const ref = (id) => doc(ctx('alice'), `chats/alice_bob/messages/${id}`);
  const { expireAt, ...noExpiry } = msg('alice');
  await assertFails(setMsg(ref('none'), noExpiry));
  await assertFails(setMsg(ref('soon'), msg('alice', { expireAt: new Date(Date.now() + 10 * DAY) })));
  await assertFails(setMsg(ref('forever'), msg('alice', { expireAt: new Date(Date.now() + 90 * DAY) })));
  await assertFails(setMsg(ref('past'), msg('alice', { expireAt: new Date(Date.now() - DAY) })));
  await assertFails(setMsg(ref('text'), msg('alice', { expireAt: 'tomorrow' })));
  await assertSucceeds(setMsg(ref('ok29'), msg('alice', { expireAt: new Date(Date.now() + 29 * DAY) })));
  await assertSucceeds(setMsg(ref('ok31'), msg('alice', { expireAt: new Date(Date.now() + 31 * DAY) })));
});

test('retention: lastActiveAt can only be set to the server time, and at most every 12 hours', async () => {
  await signUp('alice', 'alice'); await signUp('bob', 'bob');
  const mine = () => doc(ctx('alice'), 'users', 'alice');
  await assertFails(updateDoc(mine(), { lastActiveAt: new Date() }));                 // client clock refused
  await assertFails(updateDoc(doc(ctx('bob'), 'users', 'alice'), { lastActiveAt: serverTimestamp() })); // not yours
  await assertSucceeds(updateDoc(mine(), { lastActiveAt: serverTimestamp() }));       // first stamp
  await assertFails(updateDoc(mine(), { lastActiveAt: serverTimestamp() }));          // too soon
  await assertSucceeds(updateDoc(mine(), { displayName: 'Al' }));                     // other edits unaffected
  await env.withSecurityRulesDisabled(async (c) => {
    await updateDoc(doc(c.firestore(), 'users', 'alice'), { lastActiveAt: new Date(Date.now() - 13 * 3600e3) });
  });
  await assertSucceeds(updateDoc(mine(), { lastActiveAt: serverTimestamp() }));       // 13 h later is fine
});

// ---------- deletion fence ----------
test('deletion fence: a deleting account cannot create or change anything, but can still delete what it owns', async () => {
  await setupChat();                                                   // alice, bob, eve; chat alice_bob (accepted)
  const a = ctx('alice');
  const dev = (id) => doc(a, `users/alice/devices/${id}`);
  await setDoc(dev('device-0001'), deviceDoc());
  await setDoc(doc(a, 'users/alice/devices/device-0001/prekeys/opk-000001'), pkDoc('onetime'));
  await setDoc(doc(a, 'users/alice/pushTokens/device-0001'), pushToken());
  await setDoc(doc(a, 'users/alice/private/backup'), { blob: 'x', v: 1, createdAt: serverTimestamp() });
  await setDoc(doc(a, 'users/alice/linkRequests/newdevice-0001'), linkReq());
  await setDoc(doc(a, 'users/alice/blocks/eve'), { createdAt: serverTimestamp() });
  await setMsg(doc(a, 'chats/alice_bob/messages/m1'), msg('alice'));

  // The operator (or the app) flags the account.
  await env.withSecurityRulesDisabled(async (c) => {
    await updateDoc(doc(c.firestore(), 'users', 'alice'), { deleting: true });
  });

  // Nothing new can be created or changed by any of alice's devices ...
  await assertFails(setDoc(dev('device-0002'), deviceDoc()));
  await assertFails(updateDoc(dev('device-0001'), { revokedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(a, 'users/alice/devices/device-0001/prekeys/opk-000002'), pkDoc('onetime')));
  await assertFails(setDoc(doc(a, 'users/alice/pushTokens/device-0001'), pushToken()));
  await assertFails(setDoc(doc(a, 'users/alice/private/backup'), { blob: 'y', v: 1, createdAt: serverTimestamp() }));
  await assertFails(setDoc(doc(a, 'users/alice/linkRequests/newdevice-0002'), linkReq()));
  await assertFails(setDoc(doc(a, 'users/alice/blocks/bob'), { createdAt: serverTimestamp() }));
  await assertFails(setDoc(doc(a, 'reports/alice_eve'), { reporter: 'alice', reported: 'eve', reason: 'spam', createdAt: serverTimestamp() }));
  await assertFails(newChat(a, 'alice', 'alice_eve', chatDoc('alice', ['alice', 'eve'])));
  await assertFails(setMsg(doc(a, 'chats/alice_bob/messages/m2'), msg('alice')));
  await assertFails(updateDoc(doc(a, 'users', 'alice'), { displayName: 'sneaky' }));

  // ... other people are not affected ...
  await assertSucceeds(updateDoc(doc(ctx('bob'), 'users', 'bob'), { displayName: 'Bob' }));
  await assertSucceeds(setMsg(doc(ctx('bob'), 'chats/alice_bob/messages/b1'), msg('bob')));

  // ... and everything alice owns can still be deleted, so the clean-up can always finish.
  await assertSucceeds(deleteDoc(doc(a, 'chats/alice_bob/messages/m1')));
  await assertSucceeds(deleteDoc(doc(a, 'users/alice/devices/device-0001/prekeys/opk-000001')));
  await assertSucceeds(deleteDoc(doc(a, 'users/alice/pushTokens/device-0001')));
  await assertSucceeds(deleteDoc(doc(a, 'users/alice/private/backup')));
  await assertSucceeds(deleteDoc(doc(a, 'users/alice/linkRequests/newdevice-0001')));
  await assertSucceeds(deleteDoc(doc(a, 'users/alice/blocks/eve')));
  await assertSucceeds(deleteDoc(dev('device-0001')));
  await assertSucceeds(deleteDoc(doc(a, 'users', 'alice')));
});

test('deletion fence: an account that was never flagged is unaffected, and a missing profile cannot write', async () => {
  await setupChat();
  await assertSucceeds(updateDoc(doc(ctx('alice'), 'users', 'alice'), { displayName: 'Al' }));
  await assertSucceeds(setMsg(doc(ctx('alice'), 'chats/alice_bob/messages/ok'), msg('alice')));
  await env.withSecurityRulesDisabled(async (c) => { await deleteDoc(doc(c.firestore(), 'users', 'alice')); });
  await assertFails(setMsg(doc(ctx('alice'), 'chats/alice_bob/messages/gone'), msg('alice')));
});

// ---------- restrictions from the spam filter (decision 0018) ----------
/** A signed-in context whose ID token carries `restrictedUntil`. */
const restrictedCtx = (uid, until) =>
  env.authenticatedContext(uid, { email: email(uid), restrictedUntil: until }).firestore();

test('restricted: an account gets lower daily caps while the restriction lasts', async () => {
  await setupChat();
  const until = Date.now() + HOUR;
  await seedClock({ at: ago(20_000), window: ago(20_000), sent: 20, day: ago(HOUR), today: 200 });
  await assertFails(windowSend(restrictedCtx('alice', until), 'alice', 'r1', 'window'));
  await assertSucceeds(windowSend(ctx('alice'), 'alice', 'r2', 'window')); // not restricted
  await seedClock({ at: ago(20_000), window: ago(20_000), sent: 20, day: ago(HOUR), today: 200 });
  await assertSucceeds(windowSend(restrictedCtx('alice', Date.now() - 1000), 'alice', 'r3', 'window')); // over
});
test('restricted: new chats are limited to 5 a day', async () => {
  await signUpMany('alice', 'bob', 'carol');
  const until = Date.now() + HOUR;
  await seedCount('alice', 'chats', { at: ago(1000), day: ago(HOUR), today: 5 });
  await assertFails(startChat(restrictedCtx('alice', until), 'alice', 'bob', 'count'));
  await assertSucceeds(startChat(ctx('alice'), 'alice', 'carol', 'count'));
});
test('review queue: only the moderator login reads it, and nobody writes it', async () => {
  await signUp('alice', 'alice');
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'reviewQueue/alice'), { action: 'review', reasons: ['x'] });
  });
  await assertSucceeds(getDoc(doc(moderatorDb(), 'reviewQueue/alice')));
  await assertFails(getDoc(doc(ctx('alice'), 'reviewQueue/alice')));
  await assertFails(setDoc(doc(ctx('alice'), 'reviewQueue/alice'), { action: 'none' }));
  await assertFails(setDoc(doc(moderatorDb(), 'reviewQueue/alice'), { action: 'none' }));
});

// ---------- push challenge (decision 0020) ----------
const challengedCtx = (uid, until) =>
  env.authenticatedContext(uid, { email: email(uid), challengeUntil: until }).firestore();
const challengeToken = 'ab'.repeat(32);

async function seedHold(uid, token) {
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), `challengeHolds/${uid}`), { token });
  });
}

test('challenge: a paused account cannot send, and another account can', async () => {
  await setupChat();
  await seedClock({ at: ago(20_000), window: ago(20_000), sent: 20, day: ago(HOUR), today: 200 });
  const until = Date.now() + HOUR;
  await assertFails(windowSend(challengedCtx('alice', until), 'alice', 'held', 'window'));
  await assertSucceeds(windowSend(challengedCtx('alice', Date.now() - 1000), 'alice', 'over', 'window'));
  await assertSucceeds(setMsg(doc(ctx('bob'), 'chats/alice_bob/messages/bob-ok'), msg('bob')));
});

test('challenge: the right proof lets the account send, and a wrong one is refused', async () => {
  await setupChat();
  await seedHold('alice', challengeToken);
  const until = Date.now() + HOUR;
  const alice = challengedCtx('alice', until);
  await assertFails(setDoc(doc(alice, 'users/alice/challengeProof/current'), { token: 'cd'.repeat(32) }));
  await assertFails(setDoc(doc(ctx('bob'), 'users/alice/challengeProof/current'), { token: challengeToken }));
  await assertSucceeds(setDoc(doc(alice, 'users/alice/challengeProof/current'), { token: challengeToken }));
  await assertFails(getDoc(doc(ctx('bob'), 'challengeHolds/alice')));
  await assertFails(getDoc(doc(alice, 'challengeHolds/alice')));
  await seedClock({ at: ago(20_000), window: ago(20_000), sent: 20, day: ago(HOUR), today: 200 });
  await assertSucceeds(windowSend(alice, 'alice', 'answered', 'window'));
});

test('challenge: a paused account cannot open a chat or claim a one-time prekey', async () => {
  await signUpMany('alice', 'bob');
  await setDoc(doc(ctx('alice'), 'users/alice/devices/device-0001'), deviceDoc());
  await setDoc(doc(ctx('alice'), 'users/alice/devices/device-0001/prekeys/opk-000001'), pkDoc('onetime'));
  const until = Date.now() + HOUR;
  await assertFails(startChat(challengedCtx('bob', until), 'bob', 'alice', 'day'));
  const bob = challengedCtx('bob', until);
  const claim = writeBatch(bob);
  claim.delete(doc(bob, 'users/alice/devices/device-0001/prekeys/opk-000001'));
  claim.set(doc(bob, 'users/bob/limits/claims'), { at: serverTimestamp(), day: serverTimestamp(), today: 1 });
  await assertFails(claim.commit());
  await assertSucceeds(startChat(ctx('bob'), 'bob', 'alice', 'day'));
});

test('challenge: a later token replaces the proof', async () => {
  await setupChat();
  await seedHold('alice', challengeToken);
  const until = Date.now() + HOUR;
  const alice = challengedCtx('alice', until);
  const proof = doc(alice, 'users/alice/challengeProof/current');
  await assertSucceeds(setDoc(proof, { token: challengeToken }));
  const next = 'cd'.repeat(32);
  await seedHold('alice', next);
  await assertFails(setDoc(proof, { token: challengeToken }));
  await assertFails(setDoc(proof, { token: next, extra: 1 }));
  await assertFails(setDoc(doc(ctx('bob'), 'users/alice/challengeProof/current'), { token: next }));
  await assertSucceeds(setDoc(proof, { token: next }));
  await seedClock({ at: ago(20_000), window: ago(20_000), sent: 20, day: ago(HOUR), today: 200 });
  await assertSucceeds(windowSend(alice, 'alice', 'again', 'window'));
});
