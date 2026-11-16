// Decides whether a new message document should produce a push, and builds it.
// Everything that touches Firebase is passed in as `store` and `messaging`, so
// this file is tested without the emulator.
//
// The server only ever sees ciphertext. A push therefore carries the sender's
// public username (already stored in `users/{uid}`) and a fixed body, or, for
// apps that decrypt it themselves, the same title as data. It never carries
// message text, the chat id or any envelope.

import { createHash } from 'node:crypto';

import type { ChatDoc, Coded, MessageDoc, ProfileDoc, PushTokenRecord, Untrusted } from './types.ts';

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

/**
 * What an app that posts its own notification receives (decision 0019). The
 * keys are part of the contract with the app: `fp` is DATA_MARKER, `k` the
 * conversation key, `ch` the Android channel. All values are strings.
 */
export interface DataPush {
  token: string;
  data: { fp: '1'; k: string; title: string; ch: string };
  android: { priority: 'high'; collapseKey: string };
}

/** What every other device receives: a notification the system shows as sent. */
export interface AlertPush {
  token: string;
  notification: { title: string; body: string };
  apns: {
    headers: { 'apns-collapse-id': string; 'apns-push-type': 'alert'; 'apns-priority': '10' };
    payload: { aps: { 'thread-id': string; 'mutable-content': 1; sound?: string } };
  };
  android: {
    priority: 'high';
    collapseKey: string;
    notification: { tag: string; channelId: string; color: string };
  };
}

/** One FCM message for one token. Neither form has message text, a chat id or an envelope. */
export type PushMessage = DataPush | AlertPush;

/** Why a message did or did not produce a push. Safe to log: no ids, usernames or tokens. */
export type PushOutcome =
  | 'malformed'
  | 'no-envelopes'
  | 'no-chat'
  | 'request'
  | 'blocked'
  | 'recipient-gone'
  | 'sender-gone'
  | 'no-tokens'
  | 'throttled'
  | 'quiet'
  | 'sent'
  | 'failed';

export interface PushStore {
  getChat(chatId: string): Promise<Untrusted<ChatDoc> | null>;
  isBlocked(ownerUid: string, blockedUid: string): Promise<boolean>;
  getProfile(uid: string): Promise<Untrusted<ProfileDoc> | null>;
  listTokens(uid: string): Promise<PushTokenRecord[]>;
  /**
   * Whether this conversation alerted this recipient within the window: one
   * read, checked before the other lookups so a burst costs one read a
   * message, not five. Optional; without it every message does the lookups.
   */
  peekThrottle?(chatId: string, recipientUid: string, nowMs: number, windowMs: number): Promise<boolean>;
  /** Transactional. */
  claimThrottle(chatId: string, recipientUid: string, nowMs: number, windowMs: number): Promise<boolean>;
  deleteToken(uid: string, deviceId: string): Promise<unknown>;
}

/** Rejects with `{code}` on failure. */
export interface PushMessaging {
  send(message: PushMessage): Promise<unknown>;
}

/** One device's registration and choices, already checked. */
export interface BuildInput {
  token: string;
  username: string;
  chatId: string;
  showName?: boolean;
  sound?: boolean;
  /** Read from the registration as written: only 'android' is tested for. */
  platform?: unknown;
  dataPush?: boolean;
}

/** Splits `uidA_uidB` and returns the recipient, or null if malformed. */
export function recipientOf(chatId: string, senderUid: string): string | null {
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
export function conversationKey(chatId: string): string {
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
export function buildMessage(input: BuildInput & { platform: 'android'; dataPush: true }): DataPush;
export function buildMessage(input: BuildInput & { dataPush?: false }): AlertPush;
export function buildMessage(input: BuildInput): PushMessage;
export function buildMessage({
  token,
  username,
  chatId,
  showName = true,
  sound = true,
  platform,
  dataPush = false,
}: BuildInput): PushMessage {
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
  const aps: AlertPush['apns']['payload']['aps'] = { 'thread-id': key, 'mutable-content': 1 };
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
export async function handleMessage(
  { chatId, data, now = Date.now() }: {
    chatId: string;
    data: Untrusted<MessageDoc> | null | undefined;
    now?: number;
  },
  { store, messaging }: { store: PushStore; messaging: PushMessaging },
): Promise<PushOutcome> {
  const senderUid = data?.senderUid;
  if (typeof senderUid !== 'string') return 'malformed';
  const recipientUid = recipientOf(chatId, senderUid);
  if (!recipientUid) return 'malformed';
  const envelopes = data!.envelopes;
  if (!envelopes || typeof envelopes !== 'object') return 'malformed';
  // Only the recipient's devices that actually got a copy. The sender's own
  // linked devices also receive envelopes; they never get a push.
  const reached = new Set(Object.keys(envelopes).filter((d) => DEVICE.test(d)));
  if (reached.size === 0) return 'no-envelopes';
  // A quiet message (an edit, a delete, a cleared reaction) is never an alert
  // (decision 0025). Android apps that post their own notifications still get
  // it as data, so they can update or remove the alert it is about; when the
  // recipient has no such device, that is one read and nothing else.
  const quiet = data!.quiet === true;
  if (quiet) {
    const own = (await store.listTokens(recipientUid)).some(
      (t) => reached.has(t.deviceId) && t.platform === 'android' && t.dataPush === true,
    );
    if (!own) return 'quiet';
  } else if (await store.peekThrottle?.(chatId, recipientUid, now, THROTTLE)) {
    return 'throttled';
  }

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
    (t): t is PushTokenRecord & { token: string } =>
      reached.has(t.deviceId) && typeof t.token === 'string' && t.token.length >= 20 &&
      (!quiet || (t.platform === 'android' && t.dataPush === true)),
  );
  if (tokens.length === 0) return quiet ? 'quiet' : 'no-tokens';

  // A quiet message neither uses nor waits for the alert allowance.
  if (!quiet && !(await store.claimThrottle(chatId, recipientUid, now, THROTTLE))) return 'throttled';

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
        if (DEAD_TOKEN.has((e as Coded)?.code)) {
          await store.deleteToken(recipientUid, deviceId).catch(() => {});
        }
      }
    }),
  );
  if (quiet) return 'quiet';
  return sent > 0 ? 'sent' : 'failed';
}
