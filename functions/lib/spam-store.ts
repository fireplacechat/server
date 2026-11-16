// The `store` used by spam-filter.ts, backed by the Admin SDK. Kept thin on
// purpose: every decision is in spam-filter.ts and tested there.

import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

import { issueChallenge } from './challenge.ts';
import type { SpamStore } from './spam-filter.ts';

export function spamStore(db: Firestore, auth: Auth): SpamStore {
  return {
    async reportersSince(uid, sinceMs) {
      // One reports document per reporter (reports/{reporter}_{reported}), so
      // the documents are the distinct reporters. Reports are rare: this reads
      // a handful.
      const snap = await db.collection('reports').where('reported', '==', uid).get();
      return snap.docs.filter((d) => {
        const at = d.get('createdAt');
        return at && typeof at.toMillis === 'function' && at.toMillis() >= sinceMs;
      }).length;
    },
    async accountCreatedMs(uid) {
      const snap = await db.doc(`users/${uid}`).get();
      if (!snap.exists) return null;
      const at = snap.get('createdAt');
      return at && typeof at.toMillis === 'function' ? at.toMillis() : 0;
    },
    async restriction(uid) {
      const user = await auth.getUser(uid);
      const until = user.customClaims?.restrictedUntil;
      return typeof until === 'number' ? until : null;
    },
    async restrict(uid, untilMs) {
      const user = await auth.getUser(uid);
      // Merge: the claims also carry `banned` and others.
      await auth.setCustomUserClaims(uid, { ...(user.customClaims ?? {}), restrictedUntil: untilMs });
    },
    async challenge(uid, untilMs) {
      const snap = await db.collection(`users/${uid}/pushTokens`).get();
      const tokens = snap.docs
        .map((d) => d.get('token'))
        .filter((token): token is string => typeof token === 'string' && token.length > 0);
      return issueChallenge({ uid, untilMs, tokens }, {
        async save(id, token, until) {
          await db.doc(`challengeHolds/${id}`).set({ token, until: new Date(until) });
          const user = await auth.getUser(id);
          await auth.setCustomUserClaims(id, { ...(user.customClaims ?? {}), challengeUntil: until });
        },
        push: (message) => getMessaging().send(message),
        async clear(id) {
          await db.doc(`challengeHolds/${id}`).delete();
          const user = await auth.getUser(id);
          const claims: Record<string, unknown> = { ...(user.customClaims ?? {}) };
          delete claims.challengeUntil;
          await auth.setCustomUserClaims(id, claims);
        },
      });
    },
    async queue(uid, { action, reasons, untilMs }) {
      const now = new Date();
      await db.doc(`reviewQueue/${uid}`).set(
        { action, reasons, restrictedUntil: untilMs ? new Date(untilMs) : null, updatedAt: now },
        { merge: true },
      );
      await db.collection('moderationLog').add({
        action: `auto-${action}`, uid, reasons, at: now, by: 'spam-filter',
      });
    },
  };
}
