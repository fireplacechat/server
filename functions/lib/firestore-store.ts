// The `store` used by push-core, backed by the Admin SDK. Kept thin on purpose:
// every decision is in push-core.ts and tested there.

import { Timestamp } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';

import type { GroupPushStore } from './group-push.ts';
import type { PushStore } from './push-core.ts';
import type { ChatDoc, GroupDoc, ProfileDoc, Untrusted } from './types.ts';

export function firestoreStore(db: Firestore): PushStore & GroupPushStore {
  return {
    async getChat(chatId) {
      const snap = await db.doc(`chats/${chatId}`).get();
      return snap.exists ? (snap.data() as Untrusted<ChatDoc>) : null;
    },
    async isBlocked(ownerUid, blockedUid) {
      return (await db.doc(`users/${ownerUid}/blocks/${blockedUid}`).get()).exists;
    },
    async getGroup(gid) {
      const snap = await db.doc(`groups/${gid}`).get();
      return snap.exists ? (snap.data() as GroupDoc) : null;
    },
    async getProfile(uid) {
      const snap = await db.doc(`users/${uid}`).get();
      return snap.exists ? (snap.data() as Untrusted<ProfileDoc>) : null;
    },
    async listTokens(uid) {
      const snap = await db.collection(`users/${uid}/pushTokens`).get();
      return snap.docs.map((d) => ({
        deviceId: d.id,
        token: d.get('token'),
        platform: d.get('platform'),
        showName: d.get('showName'),
        sound: d.get('sound'),
        dataPush: d.get('dataPush'),
      }));
    },
    // `pushThrottle/{chatId}` holds, per recipient, when that person was last
    // alerted about this conversation. Only the server reads or writes it
    // (the rules' catch-all denies clients). It holds no read state: it changes
    // only when a message arrives, which the message's own `ts` already shows.
    async peekThrottle(chatId, recipientUid, nowMs, windowMs) {
      const last = (await db.doc(`pushThrottle/${chatId}`).get()).get(recipientUid);
      return last instanceof Timestamp && nowMs - last.toMillis() < windowMs;
    },
    async claimThrottle(chatId, recipientUid, nowMs, windowMs) {
      const ref = db.doc(`pushThrottle/${chatId}`);
      return db.runTransaction(async (tx) => {
        const last = (await tx.get(ref)).get(recipientUid);
        if (last instanceof Timestamp && nowMs - last.toMillis() < windowMs) return false;
        tx.set(ref, { [recipientUid]: Timestamp.fromMillis(nowMs) }, { merge: true });
        return true;
      });
    },
    async deleteToken(uid, deviceId) {
      await db.doc(`users/${uid}/pushTokens/${deviceId}`).delete();
    },
  };
}
