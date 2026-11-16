// Person-to-person invites (decision 0021): every account has invite rows that unlock
// over time; the operator sets the schedule. Separate project id, so this file can run
// beside rules.test.ts.
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash, randomInt } from 'node:crypto';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, collection, getDocs,
  serverTimestamp,
} from 'firebase/firestore';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
let env;

before(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
  env = await initializeTestEnvironment({
    projectId: 'fireplace-invites-test',
    firestore: { host, port: Number(port), rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
  });
});
after(async () => env.cleanup());
beforeEach(async () => env.clearFirestore());

const email = (u) => `${u}@users.fireplace.invalid`;
const hashOf = (code) => createHash('sha256').update(code).digest('hex');
const ctx = (uid, claims = {}) => env.authenticatedContext(uid, { email: email(uid), ...claims }).firestore();
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const newCode = () => Array.from({ length: 16 }, () => alphabet[randomInt(32)]).join('');

async function admin(fn) {
  await env.withSecurityRulesDisabled(async (c) => fn(c.firestore()));
}
/** An account that signed up `age` milliseconds ago. */
async function account(uid, age = 0, extra = {}) {
  await admin(async (db) => {
    await setDoc(doc(db, 'usernames', uid), { uid });
    await setDoc(doc(db, 'users', uid), {
      username: uid, displayName: uid, createdAt: new Date(Date.now() - age), invite: 'f'.repeat(64), ...extra,
    });
  });
}
/** The app's create batch: the row and its invite, together. */
function createBatch(db, uid, row, code = newCode(), over: any = {}) {
  const b = writeBatch(db);
  b.set(doc(db, `users/${uid}/inviteSlots/${row}`), {
    code, invite: hashOf(code), at: serverTimestamp(), ...(over.slot ?? {}),
  });
  b.set(doc(db, 'invites', over.hash ?? hashOf(code)), {
    by: uid, slot: Number(row), createdAt: serverTimestamp(), ...(over.invite ?? {}),
  });
  return b;
}
async function makeCode(uid, row, claims?) {
  const code = newCode();
  await createBatch(ctx(uid, claims), uid, row, code).commit();
  return code;
}
/** The app's replace batch: the old invite goes, the row points at a new one. */
function replaceBatch(db, uid, row, oldCode, code = newCode()) {
  const b = writeBatch(db);
  b.delete(doc(db, 'invites', hashOf(oldCode)));
  b.set(doc(db, `users/${uid}/inviteSlots/${row}`), {
    code, invite: hashOf(code), at: serverTimestamp(), replacedAt: serverTimestamp(),
  });
  b.set(doc(db, 'invites', hashOf(code)), { by: uid, slot: Number(row), createdAt: serverTimestamp() });
  return b;
}
/** The sign-up batch; with `row`, also marks that person's row used (new apps do). */
function signUpBatch(db, uid, code, row?) {
  const b = writeBatch(db);
  b.set(doc(db, 'usernames', uid), { uid });
  b.set(doc(db, 'users', uid), { username: uid, displayName: uid, createdAt: serverTimestamp(), invite: hashOf(code) });
  b.update(doc(db, 'invites', hashOf(code)), { usedBy: uid, usedAt: serverTimestamp() });
  if (row) b.update(doc(db, `users/${row.by}/inviteSlots/${row.row}`), { used: true });
  return b;
}

// ---------- the schedule ----------
test('row 1 is ready at once; rows 2 and 3 wait 24 hours and 7 days', async () => {
  await account('alice');
  await assertSucceeds(makeCode('alice', '0'));
  await assertFails(makeCode('alice', '1'));
  await assertFails(makeCode('alice', '2'));
  await account('bob', DAY + HOUR);
  await assertSucceeds(makeCode('bob', '1'));
  await assertFails(makeCode('bob', '2'));
  await account('carol', 7 * DAY + HOUR);
  await assertSucceeds(makeCode('carol', '0'));
  await assertSucceeds(makeCode('carol', '1'));
  await assertSucceeds(makeCode('carol', '2'));
});

test('a fourth code, or a row that is not a number, is refused', async () => {
  await account('alice', 30 * DAY);
  for (const row of ['3', '9', 'x', '00']) await assertFails(makeCode('alice', row));
});

test('each row holds one code; a second create in the same row is refused', async () => {
  await account('alice');
  await makeCode('alice', '0');
  await assertFails(makeCode('alice', '0'));
});

test('the code must be well formed, hash to the invite id, and be written with its invite', async () => {
  await account('alice');
  const db = ctx('alice');
  const code = newCode();
  // Row and invite agree on an id that is not the code's hash.
  const other = hashOf(newCode());
  await assertFails(createBatch(db, 'alice', '0', code, { hash: other, slot: { invite: other } }).commit());
  await assertFails(createBatch(db, 'alice', '0', code, { slot: { invite: hashOf(code).toUpperCase() } }).commit());
  await assertFails(createBatch(db, 'alice', '0', 'abcdefghijklmnop').commit());
  await assertFails(createBatch(db, 'alice', '0', 'ABCDEFGH1JKLMNOP').commit());
  await assertFails(createBatch(db, 'alice', '0', code, { slot: { at: new Date() } }).commit());
  await assertFails(createBatch(db, 'alice', '0', code, { slot: { note: 'x' } }).commit());
  await assertFails(createBatch(db, 'alice', '0', code, { invite: { slot: 1 } }).commit());
  await assertFails(createBatch(db, 'alice', '0', code, { invite: { by: 'bob' } }).commit());
  await assertFails(createBatch(db, 'alice', '0', code, { invite: { usedBy: 'alice' } }).commit());
  // the row alone, or the invite alone
  await assertFails(setDoc(doc(db, 'users/alice/inviteSlots/0'), { code, invite: hashOf(code), at: serverTimestamp() }));
  await assertFails(setDoc(doc(db, 'invites', hashOf(code)), { by: 'alice', slot: 0, createdAt: serverTimestamp() }));
  await assertSucceeds(createBatch(db, 'alice', '0', code).commit());
});

test('nobody can make a code in another account\'s row', async () => {
  await account('alice'); await account('bob');
  await assertFails(createBatch(ctx('bob'), 'alice', '0').commit());
  await assertFails(createBatch(ctx('bob'), 'alice', '0', newCode(), { invite: { by: 'bob' } }).commit());
});

test('banned, restricted, deleting, profile-less and moderator accounts cannot make codes', async () => {
  await account('alice');
  await assertFails(makeCode('alice', '0', { banned: true }));
  await assertFails(makeCode('alice', '0', { restrictedUntil: Date.now() + HOUR }));
  await admin((db) => setDoc(doc(db, 'bans/alice'), { reason: 'test' }));
  await assertFails(makeCode('alice', '0'));
  await account('bob', 0, { deleting: true });
  await assertFails(makeCode('bob', '0'));
  await assertFails(makeCode('ghost', '0'));
  await assertFails(makeCode('mod-1', '0', { moderator: true }));
});

// ---------- the operator's schedule ----------
test('the operator schedule in config/invites changes every account; pausing it stops new codes', async () => {
  await account('alice');
  await admin((db) => setDoc(doc(db, 'config/invites'), { unlockAfter: [0, 0, 0, 0, 0] }));
  for (const row of ['0', '1', '2', '3', '4']) await assertSucceeds(makeCode('alice', row));
  await assertFails(makeCode('alice', '5'));
  await account('bob');
  await admin((db) => setDoc(doc(db, 'config/invites'), { unlockAfter: [0, 0, 0], paused: true }));
  await assertFails(makeCode('bob', '0'));
});

test('a per-account allowance replaces the default and can pause one account', async () => {
  await account('alice'); await account('bob');
  await admin((db) => setDoc(doc(db, 'inviteAllowances/alice'), { unlockAfter: [0, 0] }));
  await assertSucceeds(makeCode('alice', '1'));
  await assertFails(makeCode('alice', '2'));
  await assertFails(makeCode('bob', '1'));
  await admin((db) => setDoc(doc(db, 'inviteAllowances/bob'), { unlockAfter: [0, 0, 0], paused: true }));
  await assertFails(makeCode('bob', '0'));
  // a global pause wins over an allowance
  await admin((db) => setDoc(doc(db, 'config/invites'), { paused: true }));
  await assertFails(makeCode('alice', '0'));
});

test('accounts read the schedule and their own allowance, and cannot write either', async () => {
  await account('alice'); await account('bob');
  await admin(async (db) => {
    await setDoc(doc(db, 'config/invites'), { unlockAfter: [0] });
    await setDoc(doc(db, 'inviteAllowances/alice'), { unlockAfter: [0, 0] });
  });
  const db = ctx('alice');
  await assertSucceeds(getDoc(doc(db, 'config/invites')));
  await assertSucceeds(getDoc(doc(db, 'inviteAllowances/alice')));
  await assertFails(getDoc(doc(db, 'inviteAllowances/bob')));
  await assertFails(getDoc(doc(ctx('ghost'), 'config/invites')));
  await assertFails(getDocs(collection(db, 'inviteAllowances')));
  await assertFails(setDoc(doc(db, 'config/invites'), { unlockAfter: [0, 0, 0, 0] }));
  await assertFails(setDoc(doc(db, 'inviteAllowances/alice'), { unlockAfter: [0, 0, 0, 0] }));
  await assertFails(setDoc(doc(db, 'config/other'), { x: 1 }));
});

// ---------- reading ----------
test('only the owner reads their rows', async () => {
  await account('alice'); await account('bob');
  await makeCode('alice', '0');
  await assertSucceeds(getDocs(collection(ctx('alice'), 'users/alice/inviteSlots')));
  await assertFails(getDocs(collection(ctx('bob'), 'users/alice/inviteSlots')));
  await assertFails(getDoc(doc(ctx('bob'), 'users/alice/inviteSlots/0')));
});

// ---------- redeeming ----------
test('a person\'s code signs someone up once and marks the row used, not who used it', async () => {
  await account('alice');
  const code = await makeCode('alice', '0');
  const dan = ctx('dan');
  // The holder of the unused code can see whose row it is, to mark it.
  const seen = await assertSucceeds(getDoc(doc(dan, 'invites', hashOf(code))));
  const row = { by: seen.data()!.by, row: String(seen.data()!.slot) };
  // A sign-up that does not mark the row (an older app) is refused.
  await assertFails(signUpBatch(dan, 'dan', code).commit());
  await assertSucceeds(signUpBatch(dan, 'dan', code, row).commit());
  const slot = await getDoc(doc(ctx('alice'), 'users/alice/inviteSlots/0'));
  if (slot.data()!.used !== true) throw new Error('row not marked used');
  // Once used, nobody reads the invite, so the inviter cannot see usedBy.
  await assertFails(getDoc(doc(ctx('alice'), 'invites', hashOf(code))));
  await assertFails(getDoc(doc(dan, 'invites', hashOf(code))));
  await assertFails(getDocs(collection(ctx('alice'), 'invites')));
  // single use
  await assertFails(signUpBatch(ctx('erin'), 'erin', code, row).commit());
});

test('a row cannot be marked used without claiming its invite, nor usedBy set for someone else', async () => {
  await account('alice'); await account('bob');
  const code = await makeCode('alice', '0');
  await assertFails(updateDoc(doc(ctx('bob'), 'users/alice/inviteSlots/0'), { used: true }));
  await assertFails(updateDoc(doc(ctx('alice'), 'users/alice/inviteSlots/0'), { used: true }));
  const dan = ctx('dan');
  const b = writeBatch(dan);
  b.set(doc(dan, 'usernames', 'dan'), { uid: 'dan' });
  b.set(doc(dan, 'users', 'dan'), { username: 'dan', displayName: 'dan', createdAt: serverTimestamp(), invite: hashOf(code) });
  b.update(doc(dan, 'invites', hashOf(code)), { usedBy: 'bob', usedAt: serverTimestamp() });
  b.update(doc(dan, 'users/alice/inviteSlots/0'), { used: true });
  await assertFails(b.commit());
  // marking with an extra field
  const b2 = signUpBatch(dan, 'dan', code);
  b2.update(doc(dan, 'users/alice/inviteSlots/0'), { used: true, code: 'AAAAAAAAAAAAAAAA' });
  await assertFails(b2.commit());
});

test('a code stops working when its owner is banned, being deleted, or gone', async () => {
  const row = { by: 'alice', row: '0' };
  await account('alice');
  let code = await makeCode('alice', '0');
  await admin((db) => setDoc(doc(db, 'bans/alice'), { reason: 'test' }));
  await assertFails(signUpBatch(ctx('dan'), 'dan', code, row).commit());
  await env.clearFirestore();
  await account('alice');
  code = await makeCode('alice', '0');
  await admin((db) => updateDoc(doc(db, 'users/alice'), { deleting: true }));
  await assertFails(signUpBatch(ctx('dan'), 'dan', code, row).commit());
  await admin((db) => deleteDoc(doc(db, 'users/alice')));
  await assertFails(signUpBatch(ctx('dan'), 'dan', code, row).commit());
});

test('an operator invite still works, is not readable, and uses no row', async () => {
  const code = newCode();
  await admin((db) => setDoc(doc(db, 'invites', hashOf(code)), { createdAt: new Date(), note: 'ops' }));
  const dan = ctx('dan');
  await assertFails(getDoc(doc(dan, 'invites', hashOf(code))));
  await assertSucceeds(signUpBatch(dan, 'dan', code).commit());
  await assertSucceeds(makeCode('dan', '0'));
});

// ---------- replacing ----------
test('an unused code can be replaced; the old one stops working; the next swap waits an hour', async () => {
  await account('alice');
  const first = await makeCode('alice', '0');
  const second = newCode();
  await assertSucceeds(replaceBatch(ctx('alice'), 'alice', '0', first, second).commit());
  await assertFails(signUpBatch(ctx('dan'), 'dan', first, { by: 'alice', row: '0' }).commit());
  await assertFails(replaceBatch(ctx('alice'), 'alice', '0', second).commit());
  await admin((db) => updateDoc(doc(db, 'users/alice/inviteSlots/0'), { replacedAt: new Date(Date.now() - HOUR - 1000) }));
  const third = newCode();
  await assertSucceeds(replaceBatch(ctx('alice'), 'alice', '0', second, third).commit());
  await assertSucceeds(signUpBatch(ctx('dan'), 'dan', third, { by: 'alice', row: '0' }).commit());
});

test('a used code cannot be replaced, and an invite cannot be deleted on its own', async () => {
  await account('alice'); await account('bob');
  const code = await makeCode('alice', '0');
  await assertFails(deleteDoc(doc(ctx('alice'), 'invites', hashOf(code))));
  await assertFails(deleteDoc(doc(ctx('bob'), 'invites', hashOf(code))));
  await signUpBatch(ctx('dan'), 'dan', code, { by: 'alice', row: '0' }).commit();
  await assertFails(replaceBatch(ctx('alice'), 'alice', '0', code).commit());
});

test('replacing keeps the old invite unless it is deleted in the same batch', async () => {
  await account('alice');
  const first = await makeCode('alice', '0');
  const db = ctx('alice');
  const code = newCode();
  const b = writeBatch(db);
  b.set(doc(db, 'users/alice/inviteSlots/0'), { code, invite: hashOf(code), at: serverTimestamp(), replacedAt: serverTimestamp() });
  b.set(doc(db, 'invites', hashOf(code)), { by: 'alice', slot: 0, createdAt: serverTimestamp() });
  await assertFails(b.commit());
  await assertSucceeds(signUpBatch(ctx('dan'), 'dan', first, { by: 'alice', row: '0' }).commit());
});

// ---------- account deletion ----------
test('rows are deleted only while the account is being deleted', async () => {
  await account('alice');
  const code = await makeCode('alice', '0');
  await assertFails(deleteDoc(doc(ctx('alice'), 'users/alice/inviteSlots/0')));
  await admin((db) => updateDoc(doc(db, 'users/alice'), { deleting: true }));
  await assertSucceeds(deleteDoc(doc(ctx('alice'), 'invites', hashOf(code))));
  await assertSucceeds(deleteDoc(doc(ctx('alice'), 'users/alice/inviteSlots/0')));
});

test('a deletion resumed after the profile is gone can still list and remove rows (decision 0022)', async () => {
  await account('alice');
  const code = await makeCode('alice', '0');
  await admin((db) => deleteDoc(doc(db, 'users/alice')));
  const db = ctx('alice');
  await assertSucceeds(getDocs(collection(db, 'users/alice/inviteSlots')));
  await assertSucceeds(deleteDoc(doc(db, 'invites', hashOf(code))));
  await assertSucceeds(deleteDoc(doc(db, 'users/alice/inviteSlots/0')));
  // Nobody else may remove them.
  await account('bob');
  const other = await makeCode('bob', '0');
  await assertFails(deleteDoc(doc(db, 'invites', hashOf(other))));
  await assertFails(deleteDoc(doc(db, 'users/bob/inviteSlots/0')));
});
