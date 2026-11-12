// Decides whether a new message document should produce a push, and builds it.
// Everything that touches Firebase is passed in as `store` and `messaging`, so
// this file is tested without the emulator.
//
// The server only ever sees ciphertext. A push therefore carries the sender's
// public username (already stored in `users/{uid}`) and a fixed body, or, for
// apps that decrypt it themselves, the same title as data. It never carries
// message text, the chat id or any envelope.

import { createHash } from 'node:crypto';

export const PUSH_BODY = 'New Message';
// Title on devices that turned off "Show sender's name" in the app.
export const HIDDEN_TITLE = 'Fireplace';
// One alert per conversation per this window. Reactions, edits and deletes
// are ordinary encrypted messages too, so bursts are common.
export const THROTTLE = 20_000; // ms
// Bundled with the app (iOS: Library/Sounds, copied from the Flutter asset).
export const IOS_SOUND = 'notification_pop.wav';
// Android channels created by the app's MainActivity: a channel's sound is
// fixed once created, so "Notification sound" off uses a second channel.
export const ANDROID_CHANNEL = 'messages';
export const ANDROID_SILENT_CHANNEL = 'messages_silent';
export const BRAND_COLOR = '#BF5700';
// Marks a data push as Fireplace's, so the app's handler ignores anything else.
export const DATA_MARKER = 'fp';

const UID = /^[^_/]{1,128}$/;
const DEVICE = /^[A-Za-z0-9_-]{8,64}$/;
const USERNAME = /^[a-z0-9_]{3,20}$/;
// FCM reports these when a token will never work again.
const DEAD_TOKEN = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/** Splits `uidA_uidB` and returns the recipient, or null if malformed. */
export function recipientOf(chatId, senderUid) {
  const parts = String(chatId).split('_');
  if (parts.length !== 2 || !parts.every((p) => UID.test(p))) return null;
  if (parts[0] === parts[1]) return null;
  if (parts[0] === senderUid) return parts[1];
  if (parts[1] === senderUid) return parts[0];
  return null;
}

/**
 * A stable, opaque per-conversation key. Used as the APNs collapse id, the iOS
 * thread id and the Android tag, so a conversation keeps one alert that
 * replaces itself. Hashed so Apple and Google do not see account ids in it.
 */
export function conversationKey(chatId) {
  return createHash('sha256').update(`fireplace-push:${chatId}`).digest('hex').slice(0, 32);
}

/**
 * The FCM message for one token.
 *
 * Android apps from v0.3.6 mark their registration `dataPush` (backend
 * decision 0019): they get a high-priority data message and post the
 * notification themselves, after decrypting the message on the phone. The
 * data holds only what the notification payload already
 * shows Google: the conversation key, the title and the channel. Everyone else
 * gets the notification payload. iOS adds `mutable-content`, so a Notification
 * Service Extension may rewrite the alert; without one iOS shows it as sent.
 */
export function buildMessage({
  token,
  username,
  chatId,
  showName = true,
  sound = true,
  platform,
  dataPush = false,
}) {
  const key = conversationKey(chatId);
  const title = showName ? username : HIDDEN_TITLE;
  const channelId = sound ? ANDROID_CHANNEL : ANDROID_SILENT_CHANNEL;
  if (dataPush && platform === 'android') {
    return {
      token,
      // All values are strings, as FCM requires.
      data: { [DATA_MARKER]: '1', k: key, title, ch: channelId },
      android: { priority: 'high', collapseKey: key },
    };
  }
  const aps = { 'thread-id': key, 'mutable-content': 1 };
  if (sound) aps.sound = IOS_SOUND;
  return {
    token,
    notification: { title, body: PUSH_BODY },
    apns: {
      headers: { 'apns-collapse-id': key, 'apns-push-type': 'alert', 'apns-priority': '10' },
      // No `badge`: the unread count lives only on the phone (see the app's
      // AppBadge). Sending one would need read state on the server.
      payload: { aps },
    },
    android: {
      priority: 'high',
      collapseKey: key,
      notification: {
        tag: key,
        channelId,
        color: BRAND_COLOR,
      },
    },
  };
}

/**
 * Handles one created message. Returns a short reason string for logs and
 * tests; it never contains usernames, ids or tokens.
 *
 * store: {
 *   getChat(chatId) -> {accepted?, initiator?} | null
 *   isBlocked(ownerUid, blockedUid) -> bool
 *   getProfile(uid) -> {username?, deleting?} | null
 *   listTokens(uid) -> [{deviceId, token, platform?, showName?, sound?, dataPush?}]
 *   claimThrottle(chatId, recipientUid, nowMs, windowMs) -> bool   (transactional)
 *   deleteToken(uid, deviceId)
 * }
 * messaging: { send(message) -> Promise }   (rejects with {code} on failure)
 */
export async function handleMessage({ chatId, data, now = Date.now() }, { store, messaging }) {
  const senderUid = data?.senderUid;
  if (typeof senderUid !== 'string') return 'malformed';
  const recipientUid = recipientOf(chatId, senderUid);
  if (!recipientUid) return 'malformed';
  const envelopes = data.envelopes;
  if (!envelopes || typeof envelopes !== 'object') return 'malformed';
  // Only the recipient's devices that actually got a copy. The sender's own
  // linked devices also receive envelopes; they never get a push.
  const reached = new Set(Object.keys(envelopes).filter((d) => DEVICE.test(d)));
  if (reached.size === 0) return 'no-envelopes';

  // Every lookup at once: one round of reads instead of four in a row. A
  // silent request or a block now reads a few documents it does not need,
  // which is rare (a request allows three messages) and costs fractions of
  // a cent.
  const [chat, blocked, recipient, sender, allTokens] = await Promise.all([
    store.getChat(chatId),
    store.isBlocked(recipientUid, senderUid),
    store.getProfile(recipientUid),
    store.getProfile(senderUid),
    store.listTokens(recipientUid),
  ]);
  if (!chat) return 'no-chat';
  // Message requests from people you have not accepted stay silent; the app
  // does not even decrypt them until you open Requests. Chats from before
  // requests existed have no `accepted` field and count as accepted.
  if (chat.accepted === false) return 'request';
  if (blocked) return 'blocked';
  if (!recipient || recipient.deleting === true) return 'recipient-gone';
  if (!sender || sender.deleting === true) return 'sender-gone';
  const username = sender.username;
  if (typeof username !== 'string' || !USERNAME.test(username)) return 'sender-gone';

  const tokens = allTokens.filter(
    (t) => reached.has(t.deviceId) && typeof t.token === 'string' && t.token.length >= 20,
  );
  if (tokens.length === 0) return 'no-tokens';

  if (!(await store.claimThrottle(chatId, recipientUid, now, THROTTLE))) return 'throttled';

  let sent = 0;
  await Promise.all(
    tokens.map(async ({ deviceId, token, platform, showName, sound, dataPush }) => {
      try {
        // Older app versions write neither field; they get the defaults.
        await messaging.send(
          buildMessage({
            token,
            username,
            chatId,
            showName: showName !== false,
            sound: sound !== false,
            platform,
            dataPush: dataPush === true,
          }),
        );
        sent++;
      } catch (e) {
        if (DEAD_TOKEN.has(e?.code)) {
          await store.deleteToken(recipientUid, deviceId).catch(() => {});
        }
      }
    }),
  );
  return sent > 0 ? 'sent' : 'failed';
}
