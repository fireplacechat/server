// Group chat rules (backend decision 0023). Separate project id, so this file can run
// beside the other rules tests.
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, collection, query, where,
  serverTimestamp, increment, Bytes, Timestamp,
} from 'firebase/firestore';

const GID = 'AAECAwQFBgcICQoLDA0ODw';
const DAY = 86_400_000;
let env;

before(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
  env = await initializeTestEnvironment({
    projectId: 'fireplace-groups-test',
    firestore: { host, port: Number(port), rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
  });
});
after(async () => env.cleanup());
beforeEach(async () => env.clearFirestore());

const email = (u) => `${u}@users.fireplace.invalid`;
const ctx = (uid, claims = {}) => env.authenticatedContext(uid, { email: email(uid), ...claims }).firestore();
const bytes = (n) => Bytes.fromUint8Array(new Uint8Array(n).fill(7));
const pad = (e) => String(e).padStart(12, '0');
const dev = (uid) => `${uid}-device-01`;

async function admin(fn) {
  await env.withSecurityRulesDisabled(async (c) => fn(c.firestore()));
}
async function accounts(...uids) {
  await admin(async (db) => {
    for (const uid of uids) {
      await setDoc(doc(db, 'usernames', uid), { uid });
      await setDoc(doc(db, 'users', uid), { username: uid, displayName: uid, createdAt: new Date(), invite: 'f'.repeat(64) });
      await setDoc(doc(db, `users/${uid}/devices/${dev(uid)}`), { createdAt: new Date() });
    }
  });
}
/** Alice (administrator) and Bob in a group at epoch 3. */
async function seedGroup(extra = {}) {
  await accounts('alice', 'bob', 'carol');
  await admin((db) => setDoc(doc(db, `groups/${GID}`), {
    members: {
      alice: { role: 'admin', devices: [dev('alice')] },
      bob: { role: 'member', devices: [dev('bob')] },
    },
    epoch: 3,
    fence: [],
    createdAt: new Date(),
    ...extra,
  }));
}
/** A message batch with the account's send clock, as the app writes it. */
function event(db, uid, over: any = {}) {
  const n = over.n ?? 1;
  const device = over.device ?? dev(uid);
  const b = writeBatch(db);
  b.set(doc(db, `groups/${GID}/events/${over.id ?? `${device}-${n}`}`), {
    by: uid, device, n, epoch: over.epoch ?? 3, ct: over.ct ?? bytes(200),
    at: serverTimestamp(), expireAt: Timestamp.fromMillis(Date.now() + 30 * DAY), ...(over.fields ?? {}),
  });
  if (over.clock !== false) {
    const at = serverTimestamp();
    b.set(doc(db, `users/${uid}/limits/send`), { at, window: at, sent: 1, day: at, today: 1 });
  }
  return b;
}
/** A self-update Commit at the current epoch, raising the group's epoch. */
function commit(db, uid, over: any = {}) {
  const epoch = over.epoch ?? 3;
  const b = writeBatch(db);
  b.set(doc(db, `groups/${GID}/commits/${over.slot ?? pad(epoch)}`), {
    e: over.e ?? epoch,
    by: uid, device: over.device ?? dev(uid), kind: over.kind ?? 'update', ct: bytes(1000), at: serverTimestamp(),
  });
  if (over.bump !== false) b.update(doc(db, `groups/${GID}`), { epoch: over.to ?? epoch + 1 });
  return b;
}
function op(db, uid, data, path = `groups/${GID}/ops/op-${uid}-0001`) {
  const b = writeBatch(db);
  b.set(doc(db, path), { by: uid, at: serverTimestamp(), ...data });
  if (data.counter !== false) {
    const at = serverTimestamp();
    b.set(doc(db, `users/${uid}/limits/groupOps`), { at, day: at, today: 1 });
  }
  return b;
}

test('members read the group, its commits and events; others cannot', async () => {
  await seedGroup();
  await assertSucceeds(getDoc(doc(ctx('bob'), `groups/${GID}`)));
  await assertSucceeds(getDocs(collection(ctx('bob'), `groups/${GID}/events`)));
  await assertSucceeds(getDocs(collection(ctx('bob'), `groups/${GID}/commits`)));
  for (const outsider of ['carol', 'ghost']) {
    await assertFails(getDoc(doc(ctx(outsider), `groups/${GID}`)));
    await assertFails(getDocs(collection(ctx(outsider), `groups/${GID}/events`)));
  }
  // Someone invited holds the Welcome but is not in the roster: until they join
  // they read nothing of the group and send nothing to it (decision 0023).
  await admin((db) => updateDoc(doc(db, `groups/${GID}`), {
    invited: { carol: { by: 'alice', devices: [dev('carol')], expireAt: new Date(Date.now() + 86400e3) } },
  }));
  await assertFails(getDoc(doc(ctx('carol'), `groups/${GID}`)));
  await assertFails(getDocs(collection(ctx('carol'), `groups/${GID}/events`)));
  await assertFails(getDocs(collection(ctx('carol'), `groups/${GID}/commits`)));
  await assertFails(event(ctx('carol'), 'carol').commit());
  await assertFails(op(ctx('carol'), 'carol', { kind: 'leave' }).commit());
  await assertFails(updateDoc(doc(ctx('bob'), `groups/${GID}`), { invited: {} }));
  // A banned or deleting member is cut off at once.
  await assertFails(getDoc(doc(ctx('bob', { banned: true }), `groups/${GID}`)));
  await admin((db) => updateDoc(doc(db, 'users/bob'), { deleting: true }));
  await assertFails(getDocs(collection(ctx('bob'), `groups/${GID}/events`)));
});

test('a member sends a message from its own device, with the send clock, once', async () => {
  await seedGroup();
  const db = ctx('bob');
  await assertSucceeds(event(db, 'bob').commit());
  // The same id again is refused: a resend can never double a message.
  await assertFails(setDoc(doc(db, `groups/${GID}/events/${dev('bob')}-1`), {}));
});

test('a message needs the right device, id, epoch, size, expiry and clock', async () => {
  await seedGroup();
  const db = ctx('bob');
  const bad = [
    { device: 'someone-elses-01' },
    { id: 'made-up-id-0001' },
    { epoch: 1 }, // older than the one before
    { epoch: 4 }, // ahead of the group
    { ct: bytes(98305) },
    { clock: false },
    { fields: { expireAt: Timestamp.fromMillis(Date.now() + 90 * DAY) } },
    { fields: { name: 'Book club' } },
    { fields: { by: 'alice' } },
  ];
  for (const over of bad) await assertFails(event(db, 'bob', over).commit());
  await assertSucceeds(event(db, 'bob', { epoch: 2 }).commit()); // raced a Commit
  await assertFails(event(ctx('carol'), 'carol').commit());
});

test('a group message may be marked quiet, and only with true', async () => {
  await seedGroup();
  const db = ctx('bob');
  for (const bad of [false, 'true', 1]) {
    await assertFails(event(db, 'bob', { fields: { quiet: bad } }).commit());
  }
  await assertSucceeds(event(db, 'bob', { fields: { quiet: true } }).commit());
});

test('a fenced group takes no new messages', async () => {
  await seedGroup({ fence: [{ uid: 'carol', devices: [dev('carol')] }] });
  await assertFails(event(ctx('bob'), 'bob').commit());
});

test('one self-update Commit wins each epoch, and it must raise the epoch', async () => {
  await seedGroup();
  await assertFails(commit(ctx('bob'), 'bob', { bump: false }).commit());
  await assertFails(commit(ctx('bob'), 'bob', { to: 5 }).commit());
  await assertFails(commit(ctx('bob'), 'bob', { slot: pad(2) }).commit());
  await assertFails(commit(ctx('bob'), 'bob', { kind: 'membership' }).commit());
  await assertFails(commit(ctx('bob'), 'bob', { e: 7 }).commit());
  await assertFails(commit(ctx('carol'), 'carol').commit());
  // A valid Commit cannot carry a second one into another epoch's slot.
  const db = ctx('bob');
  const two = commit(db, 'bob');
  two.set(doc(db, `groups/${GID}/commits/${pad(9)}`), {
    e: 3,
    by: 'bob', device: dev('bob'), kind: 'update', ct: bytes(10), at: serverTimestamp(),
  });
  await assertFails(two.commit());
  await assertSucceeds(commit(ctx('bob'), 'bob').commit());
  // Alice's Commit for the same epoch now loses.
  await assertFails(commit(ctx('alice'), 'alice').commit());
  await assertSucceeds(commit(ctx('alice'), 'alice', { epoch: 4 }).commit());
});

test('nobody changes the roster, creates a group, or raises the epoch without a Commit', async () => {
  await seedGroup();
  const db = ctx('alice');
  await assertFails(updateDoc(doc(db, `groups/${GID}`), { 'members.carol': { role: 'member', devices: [dev('carol')] } }));
  await assertFails(updateDoc(doc(db, `groups/${GID}`), { epoch: 4 }));
  await assertFails(updateDoc(doc(db, `groups/${GID}`), { fence: [] }));
  await assertFails(setDoc(doc(ctx('carol'), 'groups/AAAAAAAAAAAAAAAAAAAAAA'), { members: { carol: { role: 'admin', devices: [] } }, epoch: 0, fence: [] }));
  await assertFails(deleteDoc(doc(db, `groups/${GID}`)));
  for (const path of [`groups/${GID}/welcomes/carol_1`, 'users/alice/groupRefs/x', 'users/alice/groupInvites/x']) {
    await assertFails(setDoc(doc(db, path), { uid: 'alice' }));
  }
});

test('membership requests are counted, by members, in a known form', async () => {
  await seedGroup();
  // An invitation carries the Add Commit, the Welcome and the key packages it used.
  await assertSucceeds(op(ctx('alice'), 'alice', {
    kind: 'invite', uid: 'carol', epoch: 3, device: dev('alice'), devices: [dev('carol')],
    commit: bytes(1000), welcome: bytes(5000), packages: [{ device: dev('carol'), slot: '0' }],
  }).commit());
  await assertSucceeds(getDoc(doc(ctx('alice'), `groups/${GID}/ops/op-alice-0001`)));
  await assertSucceeds(op(ctx('bob'), 'bob', { kind: 'expire', uid: 'carol' }, `groups/${GID}/ops/op-bob-00009`).commit());
  await assertFails(getDoc(doc(ctx('bob'), `groups/${GID}/ops/op-alice-0001`)));
  await assertFails(op(ctx('bob'), 'bob', { kind: 'invite', uid: 'carol', counter: false }).commit());
  await assertFails(op(ctx('bob'), 'bob', { kind: 'invite', uid: 'carol', status: 'done' }).commit());
  await assertFails(op(ctx('bob'), 'bob', { kind: 'promote' }).commit());
  await assertFails(op(ctx('bob'), 'bob', { kind: 'invite', welcome: bytes(786433) }).commit());
  // `add` is gone: the invitation does the adding.
  await assertFails(op(ctx('bob'), 'bob', { kind: 'add', uid: 'carol' }).commit());
  await assertFails(op(ctx('carol'), 'carol', { kind: 'leave' }).commit());
});

test('account requests: create a group or answer an invitation', async () => {
  await accounts('carol');
  const db = ctx('carol');
  const path = 'users/carol/groupOps/op-carol-0001';
  await assertSucceeds(op(db, 'carol', { kind: 'create', gid: GID, devices: [dev('carol')], epoch: 1 }, path).commit());
  await assertFails(op(db, 'carol', { kind: 'create', gid: 'short', devices: [] }, 'users/carol/groupOps/op-carol-0002').commit());
  await assertFails(op(ctx('bob'), 'bob', { kind: 'accept', gid: GID }, 'users/carol/groupOps/op-bob-00001').commit());
  await assertFails(op(db, 'carol', { kind: 'invite', gid: GID }, 'users/carol/groupOps/op-carol-0003').commit());
});

test('welcomes, invitations and group lists are readable only by their account', async () => {
  await seedGroup();
  await admin(async (db) => {
    await setDoc(doc(db, `groups/${GID}/welcomes/carol_${pad(4)}`), { uid: 'carol', epoch: 4, ct: bytes(10) });
    await setDoc(doc(db, `users/carol/groupInvites/${GID}`), { by: 'alice' });
    await setDoc(doc(db, `users/bob/groupRefs/${GID}`), { role: 'member' });
  });
  await assertSucceeds(getDoc(doc(ctx('carol'), `groups/${GID}/welcomes/carol_${pad(4)}`)));
  await assertSucceeds(getDocs(query(collection(ctx('carol'), `groups/${GID}/welcomes`), where('uid', '==', 'carol'))));
  await assertFails(getDoc(doc(ctx('bob'), `groups/${GID}/welcomes/carol_${pad(4)}`)));
  await assertSucceeds(getDocs(collection(ctx('carol'), 'users/carol/groupInvites')));
  await assertFails(getDocs(collection(ctx('bob'), 'users/carol/groupInvites')));
  await assertSucceeds(getDocs(collection(ctx('bob'), 'users/bob/groupRefs')));
  await assertFails(getDocs(collection(ctx('alice'), 'users/bob/groupRefs')));
});

test('a device keeps up to ten key packages that anyone signed in can read', async () => {
  await accounts('alice', 'bob');
  const pkg = (db, uid, slot, over = {}) =>
    setDoc(doc(db, `users/${uid}/devices/${dev(uid)}/mlsPackages/${slot}`), { kp: bytes(6000), createdAt: serverTimestamp(), ...over });
  await assertSucceeds(pkg(ctx('bob'), 'bob', '0'));
  await assertSucceeds(pkg(ctx('bob'), 'bob', '9'));
  await assertFails(pkg(ctx('bob'), 'bob', '10'));
  await assertFails(pkg(ctx('bob'), 'bob', '1', { kp: bytes(16385) }));
  await assertFails(pkg(ctx('alice'), 'bob', '2'));
  await assertSucceeds(getDocs(collection(ctx('alice'), `users/bob/devices/${dev('bob')}/mlsPackages`)));
  await assertFails(getDocs(collection(ctx('ghost'), `users/bob/devices/${dev('bob')}/mlsPackages`)));
  await assertSucceeds(deleteDoc(doc(ctx('bob'), `users/bob/devices/${dev('bob')}/mlsPackages/0`)));
});
