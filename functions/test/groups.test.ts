// Group membership requests and fences (decision 0023), against the Firestore
// emulator. Skipped when no emulator is running (plain `npm test`).
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { epochId, fenceAccount, handleAccountOp, handleGroupOp, MAX_MEMBERS } from '../lib/groups.ts';
import { handleGroupEvent } from '../lib/group-push.ts';
import type { GroupPushStore } from '../lib/group-push.ts';
import { INVITE_BODY, buildInviteMessage, handleGroupInvite } from '../lib/invite-push.ts';

const emulator = !!process.env.FIRESTORE_EMULATOR_HOST;
const projectId = 'fireplace-groups-fn-test';
const GID = 'AAECAwQFBgcICQoLDA0ODw';
let db;
const dev = (uid, n = 1) => `${uid}-device-0${n}`;
const ct = (n) => Buffer.alloc(n, 7);

before(() => {
  if (!emulator) return;
  db = getFirestore(initializeApp({ projectId }, 'groups-test'));
});
beforeEach(async () => {
  if (!emulator) return;
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
});
const etest = (name, fn) => test(name, { skip: !emulator && 'needs the Firestore emulator' }, fn);

async function account(uid, devices = 1) {
  await db.doc(`users/${uid}`).set({ username: uid, createdAt: new Date() });
  for (let i = 1; i <= devices; i++) {
    await db.doc(`users/${uid}/devices/${dev(uid, i)}`).set({ createdAt: new Date() });
    await db.doc(`users/${uid}/devices/${dev(uid, i)}/mlsPackages/0`).set({ kp: ct(100), createdAt: new Date() });
  }
}
/** An accepted 1:1 chat, which an invitation needs. */
async function contacts(a, b) {
  const [x, y] = [a, b].sort();
  await db.doc(`chats/${x}_${y}`).set({ participants: [x, y], accepted: true });
}
let opN = 0;
async function accountOp(uid, data) {
  const id = `op-${uid}-${++opN}`.padEnd(8, '0');
  await db.doc(`users/${uid}/groupOps/${id}`).set({ by: uid, at: new Date(), ...data });
  const result = await handleAccountOp({ uid, opId: id }, { db });
  return { result, op: (await db.doc(`users/${uid}/groupOps/${id}`).get()).data() };
}
async function groupOp(uid, data) {
  const id = `op-${uid}-${++opN}`.padEnd(8, '0');
  await db.doc(`groups/${GID}/ops/${id}`).set({ by: uid, at: new Date(), ...data });
  const result = await handleGroupOp({ gid: GID, opId: id }, { db });
  return { result, op: (await db.doc(`groups/${GID}/ops/${id}`).get()).data() };
}
const group = async () => (await db.doc(`groups/${GID}`).get()).data();

/** An invitation as the inviter's device sends it: the Add Commit, the Welcome and the packages. */
const inviteOp = (target, epoch, devices = [dev(target)], by = 'alice') => ({
  kind: 'invite', uid: target, epoch, device: dev(by), devices, commit: ct(1000), welcome: ct(5000),
  packages: devices.map((device) => ({ device, slot: '0' })),
});

/** Alice creates the group and invites Bob (two devices), who joins. */
async function bookClub() {
  await account('alice');
  await account('bob', 2);
  await contacts('alice', 'bob');
  assert.equal((await accountOp('alice', { kind: 'create', gid: GID, devices: [dev('alice')], epoch: 1 })).result, 'create');
  assert.equal((await groupOp('alice', inviteOp('bob', 1, [dev('bob', 1), dev('bob', 2)]))).result, 'invite');
  assert.equal((await accountOp('bob', { kind: 'accept', gid: GID })).result, 'accept');
}

etest('an invitation adds the devices at once, and joining needs nobody else', async () => {
  await account('alice');
  await account('bob', 2);
  await contacts('alice', 'bob');
  await accountOp('alice', { kind: 'create', gid: GID, devices: [dev('alice')], epoch: 1 });
  assert.equal((await groupOp('alice', inviteOp('bob', 1, [dev('bob', 1), dev('bob', 2)]))).result, 'invite');
  // Invited: the Commit and the Welcome exist, but Bob is not in the roster yet.
  let g = await group();
  assert.deepEqual(Object.keys(g.members), ['alice']);
  assert.deepEqual(g.invited.bob.devices, [dev('bob', 1), dev('bob', 2)]);
  assert.equal(g.invited.bob.by, 'alice');
  assert.equal(g.epoch, 2);
  assert.equal((await db.doc(`groups/${GID}/commits/${epochId(1)}`).get()).get('kind'), 'membership');
  assert.equal((await db.doc(`groups/${GID}/welcomes/bob_${epochId(2)}`).get()).get('uid'), 'bob');
  assert.equal((await db.doc(`users/bob/groupInvites/${GID}`).get()).get('by'), 'alice');
  assert.equal((await db.doc(`users/bob/groupRefs/${GID}`).get()).exists, false);
  assert.equal((await db.doc(`users/bob/devices/${dev('bob', 1)}/mlsPackages/0`).get()).exists, false);
  // The group moves on before Bob answers; his join is one request, with no Commit.
  await db.doc(`groups/${GID}`).update({ epoch: 5 });
  assert.equal((await accountOp('bob', { kind: 'accept', gid: GID })).result, 'accept');
  g = await group();
  assert.deepEqual(g.members.bob, { role: 'member', devices: [dev('bob', 1), dev('bob', 2)] });
  assert.deepEqual(g.invited, {});
  assert.equal(g.epoch, 5);
  const ref = await db.doc(`users/bob/groupRefs/${GID}`).get();
  assert.equal(ref.get('joinedEpoch'), 5);
  assert.ok(Math.abs(ref.get('joinedAt').toMillis() - Date.now()) < 60_000, 'when Bob joined');
  assert.equal((await db.doc(`users/bob/groupInvites/${GID}`).get()).exists, false);
  assert.equal((await accountOp('bob', { kind: 'accept', gid: GID })).result, 'refused:no invite');
});

etest('an invitation needs the Commit, real devices and a key package for each', async () => {
  await account('alice');
  await account('bob', 2);
  await contacts('alice', 'bob');
  await accountOp('alice', { kind: 'create', gid: GID, devices: [dev('alice')], epoch: 1 });
  assert.equal((await groupOp('alice', { kind: 'invite', uid: 'bob' })).result, 'refused:devices');
  assert.equal((await groupOp('alice', inviteOp('bob', 1, ['not-bobs-device']))).result, 'refused:devices');
  assert.equal((await groupOp('alice', inviteOp('bob', 4))).result, 'refused:epoch');
  assert.equal((await groupOp('alice', { ...inviteOp('bob', 1), commit: 'text' })).result, 'refused:commit');
  // The key packages ran out: the invitation is refused and nothing changes.
  await db.doc(`users/bob/devices/${dev('bob', 1)}/mlsPackages/0`).delete();
  assert.equal((await groupOp('alice', inviteOp('bob', 1))).result, 'refused:packages');
  const g = await group();
  assert.equal(g.epoch, 1);
  assert.deepEqual(g.invited, {});
  // Bob's other device still has one, so he can be invited with that device.
  assert.equal((await groupOp('alice', inviteOp('bob', 1, [dev('bob', 2)]))).result, 'invite');
  assert.equal((await groupOp('alice', inviteOp('bob', 2, [dev('bob', 2)]))).result, 'refused:already invited');
});

etest('declining, or seven days without an answer, fences the invited devices', async () => {
  await account('alice');
  await account('bob');
  await account('carol');
  await contacts('alice', 'bob');
  await contacts('alice', 'carol');
  await accountOp('alice', { kind: 'create', gid: GID, devices: [dev('alice')], epoch: 1 });
  await groupOp('alice', inviteOp('bob', 1));
  await groupOp('alice', inviteOp('carol', 2));
  assert.equal((await accountOp('bob', { kind: 'decline', gid: GID })).result, 'decline');
  let g = await group();
  assert.deepEqual(Object.keys(g.invited), ['carol']);
  assert.deepEqual(g.fence, [{ uid: 'bob', devices: [dev('bob')] }]);
  assert.equal((await db.doc(`users/bob/groupInvites/${GID}`).get()).exists, false);
  assert.equal((await groupOp('alice', { kind: 'finalize', epoch: 3, commit: ct(10) })).result, 'finalize');
  // Carol's invitation is still open: it cannot be expired early, and it can be late.
  assert.equal((await groupOp('alice', { kind: 'expire', uid: 'carol' })).result, 'refused:not expired');
  const later = Date.now() + 8 * 86_400_000;
  const id = 'op-expire-1';
  await db.doc(`groups/${GID}/ops/${id}`).set({ by: 'alice', at: new Date(), kind: 'expire', uid: 'carol' });
  assert.equal(await handleGroupOp({ gid: GID, opId: id }, { db, now: later }), 'expire');
  g = await group();
  assert.deepEqual(g.invited, {});
  assert.deepEqual(g.fence, [{ uid: 'carol', devices: [dev('carol')] }]);
  assert.equal((await db.doc(`users/carol/groupInvites/${GID}`).get()).exists, false);
  const late = 'op-accept-late';
  await db.doc(`users/carol/groupOps/${late}`).set({ by: 'carol', at: new Date(), kind: 'accept', gid: GID });
  assert.equal(await handleAccountOp({ uid: 'carol', opId: late }, { db, now: later }), 'refused:no invite');
});

etest('an administrator can remove someone invited, and deletion fences an invited account', async () => {
  await account('alice');
  await account('bob');
  await account('carol');
  await contacts('alice', 'bob');
  await contacts('alice', 'carol');
  await accountOp('alice', { kind: 'create', gid: GID, devices: [dev('alice')], epoch: 1 });
  await groupOp('alice', inviteOp('bob', 1));
  await groupOp('alice', inviteOp('carol', 2));
  assert.equal((await groupOp('alice', { kind: 'remove', uid: 'bob', epoch: 3, commit: ct(10) })).result, 'remove');
  let g = await group();
  assert.deepEqual(Object.keys(g.invited), ['carol']);
  assert.deepEqual(g.fence, []);
  assert.equal((await db.doc(`users/bob/groupInvites/${GID}`).get()).exists, false);
  assert.equal(await fenceAccount({ uid: 'carol' }, { db }), 1);
  g = await group();
  assert.deepEqual(g.invited, {});
  assert.deepEqual(g.fence, [{ uid: 'carol', devices: [dev('carol')] }]);
  assert.equal((await db.doc(`users/carol/groupInvites/${GID}`).get()).exists, false);
});

etest('a group is created, and an invited account joins in the epoch after the invitation', async () => {
  await bookClub();
  const g = await group();
  assert.deepEqual(Object.keys(g.members).sort(), ['alice', 'bob']);
  assert.equal(g.members.alice.role, 'admin');
  assert.deepEqual(g.members.bob.devices, [dev('bob', 1), dev('bob', 2)]);
  assert.equal(g.epoch, 2);
  const commit = await db.doc(`groups/${GID}/commits/${epochId(1)}`).get();
  assert.equal(commit.get('kind'), 'membership');
  assert.equal(commit.get('e'), 1);
  const welcome = await db.doc(`groups/${GID}/welcomes/bob_${epochId(2)}`).get();
  assert.equal(welcome.get('uid'), 'bob');
  assert.equal((await db.doc(`users/bob/groupRefs/${GID}`).get()).get('joinedEpoch'), 2);
  // Key packages were consumed, the invitation is gone, and the request keeps no ciphertext.
  assert.equal((await db.doc(`users/bob/devices/${dev('bob', 1)}/mlsPackages/0`).get()).exists, false);
  assert.deepEqual(g.invited, {});
  assert.equal((await db.doc(`users/bob/groupInvites/${GID}`).get()).exists, false);
});

etest('requests record their outcome and drop their ciphertext', async () => {
  await bookClub();
  const { op } = await groupOp('bob', { kind: 'remove', uid: 'alice', epoch: 2, commit: ct(10) });
  assert.equal(op.status, 'refused');
  assert.equal(op.reason, 'not an administrator');
  assert.equal('commit' in op, false);
});

etest('any member invites people they chat with; only administrators remove and change roles', async () => {
  await bookClub();
  await account('carol');
  assert.equal((await groupOp('bob', inviteOp('carol', 2, undefined, 'bob'))).result, 'refused:not a contact');
  await db.doc('chats/bob_carol').set({ participants: ['bob', 'carol'], accepted: false });
  assert.equal((await groupOp('bob', inviteOp('carol', 2, undefined, 'bob'))).result, 'refused:not a contact');
  await contacts('bob', 'carol');
  assert.equal((await groupOp('bob', inviteOp('carol', 2, undefined, 'bob'))).result, 'invite');
  assert.equal((await groupOp('bob', { kind: 'remove', uid: 'alice', epoch: 3, commit: ct(10) })).result, 'refused:not an administrator');
  assert.equal((await groupOp('bob', { kind: 'roles', epoch: 3, commit: ct(10), admins: ['bob'] })).result, 'refused:not an administrator');
  // Someone invited is not a member yet, so cannot be made an administrator.
  assert.equal((await groupOp('alice', { kind: 'roles', epoch: 3, commit: ct(10), admins: ['alice', 'carol'] })).result, 'refused:admins');
  assert.equal((await groupOp('alice', { kind: 'roles', epoch: 3, commit: ct(10), admins: ['alice', 'bob'] })).result, 'roles');
  assert.equal((await group()).members.bob.role, 'admin');
});

etest('a Commit must be for the current epoch and its slot must be free', async () => {
  await bookClub();
  assert.equal((await groupOp('alice', { kind: 'remove', uid: 'bob', epoch: 1, commit: ct(10) })).result, 'refused:epoch');
  await db.doc(`groups/${GID}/commits/${epochId(2)}`).set({ by: 'bob', kind: 'update' });
  assert.equal((await groupOp('alice', { kind: 'remove', uid: 'bob', epoch: 2, commit: ct(10) })).result, 'refused:epoch');
});

etest('blocked people cannot be invited, and declining removes the invitation', async () => {
  await bookClub();
  await account('carol');
  await contacts('alice', 'carol');
  await db.doc('users/carol/blocks/alice').set({ createdAt: new Date() });
  assert.equal((await groupOp('alice', inviteOp('carol', 2))).result, 'refused:refused');
  assert.equal((await db.doc(`users/carol/devices/${dev('carol')}/mlsPackages/0`).get()).exists, true, 'a refusal uses no key package');
  await db.doc('users/carol/blocks/alice').delete();
  assert.equal((await groupOp('alice', inviteOp('carol', 2))).result, 'invite');
  assert.equal((await accountOp('carol', { kind: 'decline', gid: GID })).result, 'decline');
  assert.equal((await group()).invited.carol, undefined);
});

etest('a group holds at most 16 accounts, counting pending invitations', async () => {
  await account('alice');
  await accountOp('alice', { kind: 'create', gid: GID, devices: [dev('alice')], epoch: 1 });
  for (let i = 1; i < MAX_MEMBERS; i++) {
    await account(`u${i}`);
    await contacts('alice', `u${i}`);
    assert.equal((await groupOp('alice', inviteOp(`u${i}`, i))).result, 'invite');
  }
  await account('late');
  await contacts('alice', 'late');
  assert.equal((await groupOp('alice', inviteOp('late', MAX_MEMBERS))).result, 'refused:full');
});

etest('leaving cuts access at once and fences the group until a member finalises', async () => {
  await bookClub();
  assert.equal((await groupOp('bob', { kind: 'leave' })).result, 'leave');
  let g = await group();
  assert.equal(g.members.bob, undefined);
  assert.deepEqual(g.fence, [{ uid: 'bob', devices: [dev('bob', 1), dev('bob', 2)] }]);
  assert.equal((await db.doc(`users/bob/groupRefs/${GID}`).get()).exists, false);
  assert.equal((await groupOp('alice', { kind: 'finalize', epoch: 2, commit: ct(10) })).result, 'finalize');
  g = await group();
  assert.deepEqual(g.fence, []);
  assert.equal(g.epoch, 3);
});

etest('when the last member leaves, the group and all its records are deleted', async () => {
  await bookClub();
  await groupOp('bob', { kind: 'leave' });
  await groupOp('alice', { kind: 'leave' });
  assert.equal((await db.doc(`groups/${GID}`).get()).exists, false);
  for (const sub of ['commits', 'welcomes', 'ops']) {
    assert.equal((await db.collection(`groups/${GID}/${sub}`).get()).size, 0, sub);
  }
  assert.equal((await db.doc(`users/alice/groupRefs/${GID}`).get()).exists, false);
});

etest('the last administrator leaving makes the others administrators', async () => {
  await bookClub();
  await groupOp('alice', { kind: 'leave' });
  assert.equal((await group()).members.bob.role, 'admin');
});

etest('deleting an account, or revoking a device, fences its groups', async () => {
  await bookClub();
  assert.equal(await fenceAccount({ uid: 'bob', device: dev('bob', 2) }, { db }), 1);
  let g = await group();
  assert.deepEqual(g.members.bob.devices, [dev('bob', 1)]);
  assert.deepEqual(g.fence, [{ uid: 'bob', devices: [dev('bob', 2)] }]);
  assert.equal(await fenceAccount({ uid: 'bob' }, { db }), 1);
  g = await group();
  assert.equal(g.members.bob, undefined);
  assert.equal((await db.doc(`users/bob/groupRefs/${GID}`).get()).exists, false);
});

etest('a banned or deleting account cannot make requests', async () => {
  await bookClub();
  await db.doc('bans/bob').set({ reason: 'test' });
  assert.equal((await groupOp('bob', { kind: 'leave' })).result, 'refused:account');
  await account('carol');
  await db.doc('users/carol').update({ deleting: true });
  assert.equal((await accountOp('carol', { kind: 'create', gid: 'BBECAwQFBgcICQoLDA0ODw', devices: [dev('carol')], epoch: 1 })).result, 'refused:account');
});

etest('an account creates at most five groups a day, with real devices', async () => {
  await account('alice');
  assert.equal((await accountOp('alice', { kind: 'create', gid: GID, devices: ['not-my-device-1'], epoch: 1 })).result, 'refused:devices');
  for (let i = 0; i < 5; i++) {
    const gid = `AAECAwQFBgcICQoLDA0OD${'ABCDE'[i]}`;
    assert.equal((await accountOp('alice', { kind: 'create', gid, devices: [dev('alice')], epoch: 1 })).result, 'create');
  }
  assert.equal((await accountOp('alice', { kind: 'create', gid: 'AAECAwQFBgcICQoLDA0OFg', devices: [dev('alice')], epoch: 1 })).result, 'refused:limit');
});

etest('a request is handled once', async () => {
  await account('alice');
  await db.doc('users/alice/groupOps/op-once-1').set({ by: 'alice', kind: 'create', gid: GID, devices: [dev('alice')], epoch: 1, at: new Date() });
  assert.equal(await handleAccountOp({ uid: 'alice', opId: 'op-once-1' }, { db }), 'create');
  assert.equal(await handleAccountOp({ uid: 'alice', opId: 'op-once-1' }, { db }), 'skipped');
});

// ---------------------------------------------------------------- push (no emulator)

function fakeStore(group, { blocked = [], tokens = {} }: any = {}): GroupPushStore {
  const throttled = new Set();
  return {
    async getGroup() { return group; },
    async getProfile(uid) { return { username: uid }; },
    async isBlocked(owner, other) { return blocked.includes(`${owner}>${other}`); },
    async listTokens(uid) { return tokens[uid] ?? []; },
    async claimThrottle(key, uid) { const k = `${key}/${uid}`; if (throttled.has(k)) return false; throttled.add(k); return true; },
    async deleteToken() {},
  };
}
const token = (deviceId) => ({ deviceId, token: `token-${deviceId}-0123456789`, platform: 'android', dataPush: true });

test('a group message alerts the other members, generically, on their group devices', async () => {
  const sent: any[] = [];
  const store = fakeStore(
    { members: { alice: { devices: ['alice-device-01'] }, bob: { devices: ['bob-device-01'] }, carol: { devices: ['carol-device-1'] } }, fence: [] },
    { blocked: ['carol>alice'], tokens: { bob: [token('bob-device-01'), token('bob-not-in-group')], carol: [token('carol-device-1')], alice: [token('alice-device-01')] } },
  );
  const result = await handleGroupEvent({ gid: GID, data: { by: 'alice', device: 'alice-device-01' } }, { store, messaging: { send: async (m) => sent.push(m) } });
  assert.equal(result, 'sent');
  assert.equal(sent.length, 1, 'only Bob\'s group device; Carol blocked Alice; never the sender');
  assert.equal(sent[0].token, 'token-bob-device-01-0123456789');
  assert.equal(sent[0].notification.title, 'Fireplace');
  assert.equal(sent[0].data, undefined, 'never a data push for groups');
  assert.ok(!JSON.stringify(sent[0]).includes(GID), 'no group id in the push');
});

test('a fenced group or an unknown sender sends nothing', async () => {
  const messaging = { send: async () => assert.fail('no push') };
  const fenced = fakeStore({ members: { alice: { devices: [] }, bob: { devices: ['bob-device-01'] } }, fence: [{ uid: 'carol' }] });
  assert.equal(await handleGroupEvent({ gid: GID, data: { by: 'alice', device: 'alice-device-01' } }, { store: fenced, messaging }), 'fenced');
  const stranger = fakeStore({ members: { bob: { devices: ['bob-device-01'] } }, fence: [] });
  assert.equal(await handleGroupEvent({ gid: GID, data: { by: 'mallory', device: 'mallory-dev-01' } }, { store: stranger, messaging }), 'no-group');
});

test('a quiet group message (a colour or a notice) alerts nobody and reads nothing', async () => {
  const store = new Proxy({}, { get: () => () => assert.fail('nothing is read for a quiet message') }) as GroupPushStore;
  const messaging = { send: async () => assert.fail('no push') };
  assert.equal(
    await handleGroupEvent({ gid: GID, data: { by: 'alice', device: 'alice-device-01', quiet: true } }, { store, messaging }),
    'quiet',
  );
});

// ---------------------------------------------------------------- invitation push

test('an invitation alerts the invited account once per device, following its name setting', async () => {
  const sent: any[] = [];
  const store = fakeStore(null, {
    tokens: { bob: [token('bob-device-01'), { ...token('bob-device-02'), showName: false, sound: false }], alice: [token('alice-device-01')] },
  });
  const result = await handleGroupInvite({ uid: 'bob', gid: GID, data: { by: 'alice' } }, { store, messaging: { send: async (m) => sent.push(m) } });
  assert.equal(result, 'sent');
  assert.equal(sent.length, 2, 'both of Bob\'s devices, nobody else');
  const [named, hidden] = ['token-bob-device-01-0123456789', 'token-bob-device-02-0123456789'].map((t) => sent.find((m) => m.token === t));
  assert.deepEqual(named.notification, { title: 'Fireplace', body: 'You were invited by alice.' });
  assert.deepEqual(hidden.notification, { title: 'Fireplace', body: INVITE_BODY });
  assert.equal(INVITE_BODY, 'New Invitation');
  assert.equal(hidden.android.notification.channelId, 'messages_silent');
  for (const m of sent) {
    assert.equal(m.data, undefined, 'never a data push');
    assert.ok(!JSON.stringify(m).includes(GID), 'no group id in the push');
  }
});

test('no invitation push from a blocked or missing inviter, and none without a device', async () => {
  const messaging = { send: async () => assert.fail('no push') };
  const tokens = { bob: [token('bob-device-01')] };
  assert.equal(await handleGroupInvite({ uid: 'bob', gid: GID, data: { by: 'alice' } }, { store: fakeStore(null, { blocked: ['bob>alice'], tokens }), messaging }), 'blocked');
  assert.equal(await handleGroupInvite({ uid: 'bob', gid: GID, data: {} }, { store: fakeStore(null, { tokens }), messaging }), 'malformed');
  assert.equal(await handleGroupInvite({ uid: 'bob', gid: GID, data: { by: 'alice' } }, { store: fakeStore(null), messaging }), 'no-tokens');
  const m = buildInviteMessage({ token: 't', gid: GID, username: 'alice' });
  assert.equal(m.apns.payload.aps.sound, 'notification_pop.wav');
});

test('the slot name matches the rules', () => {
  assert.equal(epochId(3), '000000000003');
  assert.equal(epochId(123456789012), '123456789012');
});
