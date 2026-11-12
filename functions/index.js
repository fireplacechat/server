// Cloud Functions: a push when a message document is created, and the spam
// filter when an account is reported.
// Deployed by the owner only: `firebase deploy --only functions`.

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { getAuth } from 'firebase-admin/auth';
import { onDocumentCreated, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions';

import { handleMessage } from './lib/push-core.js';
import { firestoreStore } from './lib/firestore-store.js';
import { handleReport } from './lib/spam-filter.js';
import { spamStore } from './lib/spam-store.js';
import { POLICY } from './lib/spam-policy.js';

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
      logger.warn('push failed', { code: e?.code ?? 'unknown' });
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
      logger.warn('spam filter failed', { code: e?.code ?? 'unknown' });
    }
  },
);
