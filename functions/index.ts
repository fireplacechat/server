// Cloud Functions: a push when a message document is created, and the spam
// filter when an account is reported.
// Deployed by the owner only: `firebase deploy --only functions`.

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { getAuth } from 'firebase-admin/auth';
import { onDocumentCreated, onDocumentUpdated, onDocumentWritten } from 'firebase-functions/v2/firestore';
import type { DocumentOptions } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions';

import { handleMessage } from './lib/push-core.ts';
import { firestoreStore } from './lib/firestore-store.ts';
import { handleReport } from './lib/spam-filter.ts';
import { spamStore } from './lib/spam-store.ts';
import { POLICY } from './lib/spam-policy.ts';
import { fenceAccount, handleAccountOp, handleGroupOp } from './lib/groups.ts';
import { handleGroupEvent } from './lib/group-push.ts';
import type { Coded } from './lib/types.ts';
import { handleGroupInvite } from './lib/invite-push.ts';
import { handleAccountDeviceOp } from './lib/account-ops.ts';

initializeApp();
const store = firestoreStore(getFirestore());
const messaging = getMessaging();

export const pushOnMessage = onDocumentCreated(
  {
    document: 'chats/{chatId}/messages/{msgId}',
    region: 'us-central1', // matches the nam5 Firestore location
    memory: '256MiB',
    timeoutSeconds: 20,
    // Caps what a burst (or a bug) can cost. Spare events wait; none retry.
    maxInstances: 2,
    retry: false, // a repeated push is worse than a missed one
  },
  async (event) => {
    const data = event.data?.data();
    try {
      const result = await handleMessage(
        { chatId: event.params.chatId, data },
        { store, messaging },
      );
      // Only the outcome is logged: never ids, usernames or tokens.
      logger.info('push', { result });
    } catch (e) {
      logger.warn('push failed', { code: (e as Coded)?.code ?? 'unknown' });
    }
  },
);

export const reviewOnReport = onDocumentWritten(
  {
    document: 'reports/{reportId}',
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 20,
    maxInstances: 2, // reports are rare; this caps what a burst could cost
    retry: false,
  },
  async (event) => {
    const data = event.data?.after?.data();
    if (!data) return; // a report was removed (operator only)
    try {
      const result = await handleReport(
        { data },
        { store: spamStore(getFirestore(), getAuth()), policy: POLICY },
      );
      // Only the outcome is logged: never ids or usernames.
      logger.info('spam filter', { result });
    } catch (e) {
      logger.warn('spam filter failed', { code: (e as Coded)?.code ?? 'unknown' });
    }
  },
);

// ---------------------------------------------------------------- groups (decision 0023)
// Each trigger runs once per request; none retries, so a repeat cannot double a change.
const groupOptions = (document: string): DocumentOptions => ({
  document,
  region: 'us-central1',
  memory: '256MiB',
  timeoutSeconds: 30,
  maxInstances: 2,
  retry: false,
});
const outcome = (name: string) => (result: unknown) => logger.info(name, { result });
const failure = (name: string) => (e: unknown) => logger.warn(`${name} failed`, { code: (e as Coded)?.code ?? 'unknown' });

export const groupAccountOp = onDocumentCreated(groupOptions('users/{uid}/groupOps/{opId}'), (event) =>
  handleAccountOp({ uid: event.params.uid, opId: event.params.opId }, { db: getFirestore() })
    .then(outcome('group account op'), failure('group account op')),
);

export const groupOp = onDocumentCreated(groupOptions('groups/{gid}/ops/{opId}'), (event) =>
  handleGroupOp({ gid: event.params.gid, opId: event.params.opId }, { db: getFirestore() })
    .then(outcome('group op'), failure('group op')),
);

export const pushOnGroupEvent = onDocumentCreated(groupOptions('groups/{gid}/events/{eventId}'), (event) =>
  handleGroupEvent({ gid: event.params.gid, data: event.data?.data() }, { store, messaging })
    .then(outcome('group push'), failure('group push')),
);

// One push to the invited account, when the invitation is written.
export const pushOnGroupInvite = onDocumentCreated(groupOptions('users/{uid}/groupInvites/{gid}'), (event) =>
  handleGroupInvite(
    { uid: event.params.uid, gid: event.params.gid, data: event.data?.data() },
    { store, messaging },
  ).then(outcome('group invite push'), failure('group invite push')),
);

// A request only a device of the account may make (decision 0027): the proof
// is checked before anything is done.
export const accountDeviceOp = onDocumentCreated(groupOptions('users/{uid}/accountOps/{opId}'), (event) =>
  handleAccountDeviceOp({ uid: event.params.uid, opId: event.params.opId }, { db: getFirestore() })
    .then(outcome('account device op'), failure('account device op')),
);

// Account deletion (the profile turns `deleting`) takes the account out of its groups.
export const fenceGroupsOnDeletion = onDocumentUpdated(groupOptions('users/{uid}'), (event) => {
  const before = event.data?.before?.data();
  const after = event.data?.after?.data();
  if (before?.deleting === true || after?.deleting !== true) return null;
  return fenceAccount({ uid: event.params.uid }, { db: getFirestore() })
    .then(outcome('group fence'), failure('group fence'));
});

// A revoked or deleted device leaves every group it was in.
export const fenceGroupsOnDevice = onDocumentWritten(
  groupOptions('users/{uid}/devices/{deviceId}'),
  (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before) return null; // a new device
    const revoked = !after || (before.revokedAt == null && after.revokedAt != null);
    if (!revoked) return null;
    return fenceAccount({ uid: event.params.uid, device: event.params.deviceId }, { db: getFirestore() })
      .then(outcome('group device fence'), failure('group device fence'));
  },
);
