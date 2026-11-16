// Push for a group invitation (backend decision 0023). One push per
// invitation, to the invited account only. The server cannot read the group's
// name, so the title is always "Fireplace". The body follows the device's
// "Show sender's name" choice, as 1:1 alerts do: the inviter's public username,
// or nothing about who invited. Same `store` as push-core.

import {
  ANDROID_CHANNEL,
  ANDROID_SILENT_CHANNEL,
  BRAND_COLOR,
  HIDDEN_TITLE,
  IOS_SOUND,
  conversationKey,
} from './push-core.ts';
import type { AlertPush, PushStore } from './push-core.ts';
import type { Coded, GroupInviteRef, PushTokenRecord, Untrusted } from './types.ts';

/** What an invitation push needs from the push store. */
export type InvitePushStore = Pick<PushStore, 'isBlocked' | 'getProfile' | 'listTokens' | 'deleteToken'>;

/** Sends one invitation alert. Rejects with `{code}` on failure. */
export interface InviteMessaging {
  send(message: AlertPush): Promise<unknown>;
}

/** What an invitation did. Safe to log: no ids, usernames or tokens. */
export type InvitePushOutcome =
  | 'malformed'
  | 'blocked'
  | 'recipient-gone'
  | 'sender-gone'
  | 'no-tokens'
  | 'sent'
  | 'failed';

export const INVITE_BODY = 'New Invitation';
export const invitedBy = (username: string): string => `You were invited by ${username}.`;

const GID = /^[A-Za-z0-9_-]{22}$/;
const USERNAME = /^[a-z0-9_]{3,20}$/;
const DEAD_TOKEN = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/**
 * The FCM message for one token. Always a notification, never a data push: the
 * Android background handler decrypts 1:1 messages only. It carries no group
 * id: the collapse key is the same opaque hash that message alerts use.
 */
export function buildInviteMessage(
  { token, gid, username, showName = true, sound = true }: {
    token: string;
    gid: string;
    username: string;
    showName?: boolean;
    sound?: boolean;
  },
): AlertPush {
  const key = conversationKey(`invite:${gid}`);
  const channelId = sound ? ANDROID_CHANNEL : ANDROID_SILENT_CHANNEL;
  const aps: AlertPush['apns']['payload']['aps'] = { 'thread-id': key, 'mutable-content': 1 };
  if (sound) aps.sound = IOS_SOUND;
  return {
    token,
    notification: { title: HIDDEN_TITLE, body: showName ? invitedBy(username) : INVITE_BODY },
    apns: {
      headers: { 'apns-collapse-id': key, 'apns-push-type': 'alert', 'apns-priority': '10' },
      payload: { aps },
    },
    android: {
      priority: 'high',
      collapseKey: key,
      notification: { tag: key, channelId, color: BRAND_COLOR },
    },
  };
}

/**
 * Handles one created `users/{uid}/groupInvites/{gid}`. Returns a short outcome
 * for logs; never ids, usernames or tokens.
 */
export async function handleGroupInvite(
  { uid, gid, data }: { uid: string; gid: string; data: Untrusted<GroupInviteRef> | null | undefined },
  { store, messaging }: { store: InvitePushStore; messaging: InviteMessaging },
): Promise<InvitePushOutcome> {
  const inviter = data?.by;
  if (typeof inviter !== 'string' || !GID.test(String(gid))) return 'malformed';
  const [blocked, recipient, sender, allTokens] = await Promise.all([
    store.isBlocked(uid, inviter),
    store.getProfile(uid),
    store.getProfile(inviter),
    store.listTokens(uid),
  ]);
  if (blocked) return 'blocked';
  if (!recipient || recipient.deleting === true) return 'recipient-gone';
  if (!sender || sender.deleting === true) return 'sender-gone';
  const username = sender.username;
  if (typeof username !== 'string' || !USERNAME.test(username)) return 'sender-gone';
  const tokens = allTokens.filter(
    (t): t is PushTokenRecord & { token: string } => typeof t.token === 'string' && t.token.length >= 20,
  );
  if (tokens.length === 0) return 'no-tokens';

  let sent = 0;
  await Promise.all(
    tokens.map(async ({ deviceId, token, showName, sound }) => {
      try {
        await messaging.send(
          buildInviteMessage({ token, gid, username, showName: showName !== false, sound: sound !== false }),
        );
        sent++;
      } catch (e) {
        if (DEAD_TOKEN.has((e as Coded)?.code)) await store.deleteToken(uid, deviceId).catch(() => {});
      }
    }),
  );
  return sent > 0 ? 'sent' : 'failed';
}
