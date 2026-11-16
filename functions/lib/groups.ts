// Group membership (backend decision 0023, mobile decision 0050). Members write
// requests to `users/{uid}/groupOps/{opId}` (create, accept, decline) and
// `groups/{gid}/ops/{opId}` (invite, expire, addDevice, remove, leave, finalize,
// roles); a trigger runs `handleAccountOp` or `handleGroupOp` once per request.
//
// An invitation carries the MLS Add: the inviter's device, which is online when
// it invites, sends the Commit and the Welcome with the request. The invitee is
// then in `invited` (in MLS, not yet in the roster) until they join, decline or
// the invitation expires. Joining needs no other phone.
//
// The Admin SDK skips the security rules, so every check the rules would make is
// made here: the account is live and not banned, the roles allow the change, the
// epoch is current, limits hold. Each request is one transaction. The server never
// sees group names, roles in MLS, or message text; it keeps the public roster that
// the rules need, and clients check it against the authenticated MLS state.

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import type { DocumentData, DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';

import type { GroupFence, GroupInvited, GroupMembers } from './types.ts';

/** What a handler runs against. `now` is set by tests. */
export interface GroupDeps {
  db: Firestore;
  now?: number;
}

export const MAX_MEMBERS = 16;
export const MAX_DEVICES_PER_ACCOUNT = 4;
export const MAX_DEVICES = 64;
export const MAX_GROUPS_PER_ACCOUNT = 32;
export const MAX_CREATES_PER_DAY = 5;
export const MAX_PENDING_INVITES = 20;
export const INVITE_DAYS = 7;
const DAY_MS = 86_400_000;

const GID = /^[A-Za-z0-9_-]{22}$/;
const UID = /^[^_/]{1,128}$/;
const DEVICE = /^[A-Za-z0-9_-]{8,64}$/;

export class Refused extends Error {
  declare reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}
const refuse: (reason: string) => never = (reason) => {
  throw new Refused(reason);
};

/** Commit slots are named by their starting epoch, padded to 12 digits (as the rules). */
export const epochId = (epoch: number): string => String(epoch).padStart(12, '0');

async function liveAccount(tx: Transaction, db: Firestore, uid: unknown): Promise<void> {
  if (!UID.test(String(uid))) refuse('account');
  const [profile, ban] = await Promise.all([
    tx.get(db.doc(`users/${uid}`)),
    tx.get(db.doc(`bans/${uid}`)),
  ]);
  if (!profile.exists || profile.get('deleting') === true || ban.exists) refuse('account');
}

/** Devices the account really has (and has not revoked), 1-4 of them. */
async function ownDevices(tx: Transaction, db: Firestore, uid: string, devices: unknown): Promise<string[]> {
  if (!Array.isArray(devices) || devices.length < 1 || devices.length > MAX_DEVICES_PER_ACCOUNT) {
    refuse('devices');
  }
  if (new Set(devices).size !== devices.length || !devices.every((d) => DEVICE.test(String(d)))) {
    refuse('devices');
  }
  const snaps = await Promise.all(devices.map((d) => tx.get(db.doc(`users/${uid}/devices/${d}`))));
  if (!snaps.every((s) => s.exists && s.get('revokedAt') == null)) refuse('devices');
  return devices;
}

const deviceCount = (members: GroupMembers | GroupInvited): number =>
  Object.values<{ devices?: string[] }>(members).reduce((n, m) => n + (m.devices?.length ?? 0), 0);

function role(group: DocumentData, uid: string): string | null {
  return group.members?.[uid]?.role ?? null;
}

/** When nobody administers a group any more, everybody left does (as the app). */
function keepAnAdmin(members: GroupMembers): GroupMembers {
  if (Object.values(members).some((m) => m.role === 'admin')) return members;
  return Object.fromEntries(Object.entries(members).map(([u, m]) => [u, { ...m, role: 'admin' }]));
}

function commitBytes(op: DocumentData): Uint8Array {
  const ct = op.commit;
  if (!(ct instanceof Uint8Array) && !Buffer.isBuffer(ct)) refuse('commit');
  return ct;
}

// ---------------------------------------------------------------- account requests

export async function handleAccountOp(
  { uid, opId }: { uid: string; opId: string },
  { db, now = Date.now() }: GroupDeps,
): Promise<string> {
  const opRef = db.doc(`users/${uid}/groupOps/${opId}`);
  return finish(opRef, () =>
    db.runTransaction(async (tx) => {
      const opSnap = await tx.get(opRef);
      const op = opSnap.data();
      if (!op || op.status) return null; // already handled
      if (op.by !== uid || !GID.test(String(op.gid))) refuse('request');
      await liveAccount(tx, db, uid);
      const groupRef = db.doc(`groups/${op.gid}`);
      switch (op.kind) {
        case 'create': {
          const devices = await ownDevices(tx, db, uid, op.devices);
          if (!Number.isInteger(op.epoch) || op.epoch < 0 || op.epoch > 4) refuse('epoch');
          const [group, refs, limitSnap] = await Promise.all([
            tx.get(groupRef),
            tx.get(db.collection(`users/${uid}/groupRefs`).limit(MAX_GROUPS_PER_ACCOUNT)),
            tx.get(db.doc(`users/${uid}/limits/groupCreates`)),
          ]);
          if (group.exists) refuse('exists');
          if (refs.size >= MAX_GROUPS_PER_ACCOUNT) refuse('too many groups');
          const day = limitSnap.get('day')?.toMillis?.() ?? 0;
          const today = now - day < DAY_MS ? limitSnap.get('today') ?? 0 : 0;
          if (today >= MAX_CREATES_PER_DAY) refuse('limit');
          tx.set(db.doc(`users/${uid}/limits/groupCreates`), {
            day: today === 0 ? Timestamp.fromMillis(now) : limitSnap.get('day'),
            today: today + 1,
          });
          tx.create(groupRef, {
            members: { [uid]: { role: 'admin', devices } },
            epoch: op.epoch,
            fence: [],
            invited: {},
            createdAt: Timestamp.fromMillis(now),
          });
          tx.set(db.doc(`users/${uid}/groupRefs/${op.gid}`), {
            role: 'admin',
            joinedEpoch: op.epoch,
            joinedAt: Timestamp.fromMillis(now),
          });
          break;
        }
        case 'accept': {
          // The account's devices are already MLS members (the invitation added
          // them), so joining only moves it into the roster.
          const [group, refs] = await Promise.all([
            tx.get(groupRef),
            tx.get(db.collection(`users/${uid}/groupRefs`).limit(MAX_GROUPS_PER_ACCOUNT)),
          ]);
          const invite = group.data()?.invited?.[uid];
          if (!invite) refuse('no invite');
          if (invite.expireAt.toMillis() < now) refuse('expired');
          if (refs.size >= MAX_GROUPS_PER_ACCOUNT) refuse('too many groups');
          const invited = { ...group.data()!.invited };
          delete invited[uid];
          tx.update(groupRef, {
            members: { ...group.data()!.members, [uid]: { role: 'member', devices: invite.devices } },
            invited,
          });
          // The app shows the newcomer nothing from before `joinedAt`.
          tx.set(db.doc(`users/${uid}/groupRefs/${op.gid}`), {
            role: 'member',
            joinedEpoch: group.get('epoch'),
            joinedAt: Timestamp.fromMillis(now),
          });
          tx.delete(db.doc(`users/${uid}/groupInvites/${op.gid}`));
          break;
        }
        case 'decline': {
          // The devices are MLS leaves since the invitation: fence them, and a
          // member's Commit removes them. Nothing tells the inviter why.
          const group = await tx.get(groupRef);
          const invite = group.data()?.invited?.[uid];
          if (invite) {
            const invited = { ...group.data()!.invited };
            delete invited[uid];
            tx.update(groupRef, {
              invited,
              fence: [...(group.data()!.fence ?? []), { uid, devices: invite.devices }],
            });
          }
          tx.delete(db.doc(`users/${uid}/groupInvites/${op.gid}`));
          break;
        }
        default:
          refuse('kind');
      }
      return op.kind;
    }),
  );
}

// ---------------------------------------------------------------- group requests

export async function handleGroupOp(
  { gid, opId }: { gid: string; opId: string },
  { db, now = Date.now() }: GroupDeps,
): Promise<string> {
  const opRef = db.doc(`groups/${gid}/ops/${opId}`);
  let emptied = false;
  const result = await finish(opRef, () =>
    db.runTransaction(async (tx) => {
      const opSnap = await tx.get(opRef);
      const op = opSnap.data();
      if (!op || op.status) return null;
      const groupRef = db.doc(`groups/${gid}`);
      const groupSnap = await tx.get(groupRef);
      if (!groupSnap.exists) refuse('no group');
      const group = groupSnap.data()!;
      const by = op.by;
      await liveAccount(tx, db, by);
      if (!role(group, by)) refuse('not a member');
      const isAdmin = role(group, by) === 'admin';
      const members: GroupMembers = { ...group.members };
      // Invited accounts: in the MLS group since the invitation, not yet in the roster.
      const invited: GroupInvited = { ...(group.invited ?? {}) };

      // The Commit that moves the group to the next epoch, at its slot.
      const writeCommit = async (kind: string) => {
        if (op.epoch !== group.epoch) refuse('epoch');
        const slot = db.doc(`groups/${gid}/commits/${epochId(group.epoch)}`);
        if ((await tx.get(slot)).exists) refuse('epoch');
        return () =>
          tx.create(slot, {
            e: group.epoch,
            by,
            device: String(op.device ?? ''),
            kind,
            ct: commitBytes(op),
            at: Timestamp.fromMillis(now),
          });
      };
      const writeWelcome = (uid: string) => {
        const ct = op.welcome;
        if (!(ct instanceof Uint8Array) && !Buffer.isBuffer(ct)) refuse('welcome');
        return () =>
          tx.set(db.doc(`groups/${gid}/welcomes/${uid}_${epochId(group.epoch + 1)}`), {
            uid,
            epoch: group.epoch + 1,
            ct,
            at: Timestamp.fromMillis(now),
          });
      };
      const consume = async (uid: string, packages: unknown, devices: string[]) => {
        if (!Array.isArray(packages) || packages.length !== devices.length) refuse('packages');
        const refs = packages.map((p) => {
          if (!devices.includes(p?.device) || !/^[0-9]$/.test(String(p?.slot))) refuse('packages');
          return db.doc(`users/${uid}/devices/${p.device}/mlsPackages/${p.slot}`);
        });
        if (new Set(packages.map((p) => p.device)).size !== devices.length) refuse('packages');
        const snaps = await Promise.all(refs.map((r) => tx.get(r)));
        if (!snaps.every((s) => s.exists)) refuse('packages');
        return () => refs.forEach((r) => tx.delete(r));
      };

      switch (op.kind) {
        case 'invite': {
          // Any member may invite (owner's choice), but only someone they already
          // chat with: an accepted 1:1 chat must exist between the two. The request
          // carries the Add Commit, the Welcome and the key packages it used, so
          // the invitee can join later without anyone else's phone.
          const target = op.uid;
          if (!UID.test(String(target)) || target === by || members[target]) refuse('account');
          if (invited[target]) refuse('already invited');
          await liveAccount(tx, db, target);
          const devices = await ownDevices(tx, db, target, op.devices);
          const [chat, mine, theirs, theirInvites] = await Promise.all([
            tx.get(db.doc(`chats/${[by, target].sort().join('_')}`)),
            tx.get(db.doc(`users/${by}/blocks/${target}`)),
            tx.get(db.doc(`users/${target}/blocks/${by}`)),
            tx.get(db.collection(`users/${target}/groupInvites`).limit(MAX_PENDING_INVITES)),
          ]);
          // A block either way refuses quietly: the inviter learns no more than "refused".
          if (mine.exists || theirs.exists) refuse('refused');
          if (!chat.exists || chat.get('accepted') === false) refuse('not a contact');
          if (Object.keys(members).length + Object.keys(invited).length >= MAX_MEMBERS) refuse('full');
          if (deviceCount(members) + deviceCount(invited) + devices.length > MAX_DEVICES) refuse('full');
          if (theirInvites.size >= MAX_PENDING_INVITES) refuse('refused');
          const commit = await writeCommit('membership');
          const welcome = writeWelcome(target);
          const used = await consume(target, op.packages, devices);
          commit();
          welcome();
          used();
          const expireAt = Timestamp.fromMillis(now + INVITE_DAYS * DAY_MS);
          tx.update(groupRef, {
            invited: { ...invited, [target]: { by, devices, expireAt } },
            epoch: group.epoch + 1,
          });
          tx.set(db.doc(`users/${target}/groupInvites/${gid}`), { by, at: Timestamp.fromMillis(now), expireAt });
          break;
        }
        case 'expire': {
          // Nobody answered within seven days. There is no scheduler: the first
          // member's phone to notice asks, and the devices are fenced like a decline.
          const target = op.uid;
          const invite = invited[target];
          if (!invite) refuse('no invite');
          if (invite.expireAt.toMillis() >= now) refuse('not expired');
          delete invited[target];
          tx.update(groupRef, {
            invited,
            fence: [...(group.fence ?? []), { uid: target, devices: invite.devices }],
          });
          tx.delete(db.doc(`users/${target}/groupInvites/${gid}`));
          break;
        }
        case 'addDevice': {
          const device = op.device;
          const mine = members[by].devices;
          if (mine.includes(device)) refuse('device');
          await ownDevices(tx, db, by, [device]);
          if (mine.length >= MAX_DEVICES_PER_ACCOUNT || deviceCount(members) + deviceCount(invited) >= MAX_DEVICES) {
            refuse('full');
          }
          const commit = await writeCommit('membership');
          const welcome = writeWelcome(by);
          const used = await consume(by, op.packages, [device]);
          commit();
          welcome();
          used();
          members[by] = { ...members[by], devices: [...mine, device] };
          tx.update(groupRef, { members, epoch: group.epoch + 1 });
          break;
        }
        case 'remove': {
          if (!isAdmin) refuse('not an administrator');
          // A member, or someone invited who has not answered yet.
          const target = op.uid;
          if ((!members[target] && !invited[target]) || target === by) refuse('account');
          (await writeCommit('membership'))();
          delete members[target];
          delete invited[target];
          tx.update(groupRef, {
            members: keepAnAdmin(members),
            invited,
            epoch: group.epoch + 1,
            fence: (group.fence ?? []).filter((f: GroupFence) => f.uid !== target),
          });
          tx.delete(db.doc(`users/${target}/groupRefs/${gid}`));
          tx.delete(db.doc(`users/${target}/groupInvites/${gid}`));
          break;
        }
        case 'leave': {
          // Reading stops at once; a remaining member's Commit removes the leaves later.
          const leaving = members[by];
          delete members[by];
          tx.delete(db.doc(`users/${by}/groupRefs/${gid}`));
          if (Object.keys(members).length === 0) {
            // Nobody is left to join: open invitations go with the group.
            for (const u of Object.keys(invited)) tx.delete(db.doc(`users/${u}/groupInvites/${gid}`));
            tx.delete(groupRef);
            emptied = true;
          } else {
            tx.update(groupRef, {
              members: keepAnAdmin(members),
              fence: [...(group.fence ?? []), { uid: by, devices: leaving.devices }],
            });
          }
          break;
        }
        case 'finalize': {
          if (!(group.fence ?? []).length) refuse('nothing to remove');
          (await writeCommit('membership'))();
          tx.update(groupRef, { fence: [], epoch: group.epoch + 1 });
          break;
        }
        case 'roles': {
          if (!isAdmin) refuse('not an administrator');
          const admins = op.admins;
          if (!Array.isArray(admins) || admins.length === 0 || !admins.every((a) => members[a])) {
            refuse('admins');
          }
          (await writeCommit('meta'))();
          for (const u of Object.keys(members)) {
            members[u] = { ...members[u], role: admins.includes(u) ? 'admin' : 'member' };
          }
          tx.update(groupRef, { members, epoch: group.epoch + 1 });
          break;
        }
        default:
          refuse('kind');
      }
      return op.kind;
    }),
  );
  // The last member left: the group ends, and every record of it goes.
  if (emptied) await removeGroup(db, gid);
  return result;
}

/** Deletes everything stored for a group that nobody is in any more. */
export async function removeGroup(db: Firestore, gid: string): Promise<void> {
  await db.recursiveDelete(db.doc(`groups/${gid}`));
}


/** Runs a request and records its outcome on the request document. */
async function finish(opRef: DocumentReference, run: () => Promise<string | null>): Promise<string> {
  try {
    const kind = await run();
    if (kind === null) return 'skipped';
    await opRef.update({ status: 'done', commit: FieldValue.delete(), welcome: FieldValue.delete() });
    return kind;
  } catch (e) {
    const reason = e instanceof Refused ? e.reason : 'error';
    await opRef
      .update({ status: 'refused', reason, commit: FieldValue.delete(), welcome: FieldValue.delete() })
      .catch(() => {});
    if (!(e instanceof Refused)) throw e;
    return `refused:${reason}`;
  }
}

// ---------------------------------------------------------------- fences

/**
 * An account began deleting, or one of its devices was revoked (`device` set).
 * Takes it out of every group's roster at once, and fences the group: no new
 * messages until a remaining member's Commit removes the leaves.
 */
export async function fenceAccount(
  { uid, device = null }: { uid: string; device?: string | null },
  { db }: { db: Firestore },
): Promise<number> {
  const refs = await db.collection(`users/${uid}/groupRefs`).limit(MAX_GROUPS_PER_ACCOUNT).get();
  let fenced = 0;
  const emptied: string[] = [];
  for (const ref of refs.docs) {
    const gid = ref.id;
    await db.runTransaction(async (tx) => {
      const groupRef = db.doc(`groups/${gid}`);
      const snap = await tx.get(groupRef);
      const me = snap.data()?.members?.[uid];
      if (!me) {
        if (!device) tx.delete(ref.ref);
        return;
      }
      const group = snap.data()!;
      const members: GroupMembers = { ...group.members };
      let leaves: string[];
      if (device) {
        if (!me.devices.includes(device)) return;
        leaves = [device];
        members[uid] = { ...me, devices: me.devices.filter((d: string) => d !== device) };
        if (members[uid].devices.length === 0) delete members[uid];
      } else {
        leaves = me.devices;
        delete members[uid];
      }
      if (!members[uid]) tx.delete(ref.ref);
      if (Object.keys(members).length === 0) {
        for (const u of Object.keys(group.invited ?? {})) tx.delete(db.doc(`users/${u}/groupInvites/${gid}`));
        tx.delete(groupRef);
        emptied.push(gid);
      } else {
        tx.update(groupRef, {
          members: keepAnAdmin(members),
          fence: [...(group.fence ?? []), { uid, devices: leaves }],
        });
      }
      fenced++;
    });
  }
  for (const gid of emptied) await removeGroup(db, gid);
  // Invitations: the account's devices are MLS leaves there too, so they are fenced.
  const invites = await db.collection(`users/${uid}/groupInvites`).limit(MAX_PENDING_INVITES).get();
  for (const inv of invites.docs) {
    await db.runTransaction(async (tx) => {
      const groupRef = db.doc(`groups/${inv.id}`);
      const snap = await tx.get(groupRef);
      const invite = snap.data()?.invited?.[uid];
      if (!invite) {
        if (!device) tx.delete(inv.ref);
        return;
      }
      if (device && !invite.devices.includes(device)) return;
      const invited = { ...snap.data()!.invited };
      const left = device ? invite.devices.filter((d: string) => d !== device) : [];
      if (left.length === 0) {
        delete invited[uid];
        tx.delete(inv.ref);
      } else {
        invited[uid] = { ...invite, devices: left };
      }
      tx.update(groupRef, {
        invited,
        fence: [...(snap.data()!.fence ?? []), { uid, devices: device ? [device] : invite.devices }],
      });
      fenced++;
    });
  }
  return fenced;
}
