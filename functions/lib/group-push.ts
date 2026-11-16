// Push for a new group message (backend decision 0023). The server cannot read
// the group's name or the message, so the alert is always the generic
// "Fireplace / New Message", sent as a notification (never a data push: the
// Android background handler decrypts 1:1 messages only). Same `store` as
// push-core, plus `getGroup`.

import { HIDDEN_TITLE, THROTTLE, buildMessage } from './push-core.ts';
import type { PushMessaging, PushStore } from './push-core.ts';
import type { Coded, GroupDoc, GroupEventDoc, PushTokenRecord, Untrusted } from './types.ts';

/** What a group push needs from the push store, plus the group's roster. */
export interface GroupPushStore extends Omit<PushStore, 'getChat'> {
  getGroup(gid: string): Promise<Partial<GroupDoc> | null>;
}

/** What a group message did. Safe to log: no ids or tokens. */
export type GroupPushOutcome = 'malformed' | 'quiet' | 'no-group' | 'fenced' | 'alone' | 'sender-gone' | 'sent' | 'none';

const DEVICE = /^[A-Za-z0-9_-]{8,64}$/;
const DEAD_TOKEN = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/** Returns a short outcome for logs; never ids or tokens. */
export async function handleGroupEvent(
  { gid, data, now = Date.now() }: {
    gid: string;
    data: Untrusted<GroupEventDoc> | null | undefined;
    now?: number;
  },
  { store, messaging }: { store: GroupPushStore; messaging: PushMessaging },
): Promise<GroupPushOutcome> {
  const sender = data?.by;
  if (typeof sender !== 'string' || !DEVICE.test(String(data?.device))) return 'malformed';
  // A colour or notice message: nobody is alerted, and nothing is read.
  if (data?.quiet === true) return 'quiet';
  const group = await store.getGroup(gid);
  if (!group?.members?.[sender]) return 'no-group';
  // A fenced group accepts no new messages; one that raced the fence stays quiet.
  if ((group.fence ?? []).length) return 'fenced';
  const recipients = Object.entries(group.members).filter(([uid]) => uid !== sender);
  if (recipients.length === 0) return 'alone';
  const senderProfile = await store.getProfile(sender);
  if (!senderProfile || senderProfile.deleting === true) return 'sender-gone';

  let sent = 0;
  await Promise.all(
    recipients.map(async ([uid, member]) => {
      const [blocked, profile, tokens] = await Promise.all([
        store.isBlocked(uid, sender),
        store.getProfile(uid),
        store.listTokens(uid),
      ]);
      if (blocked || !profile || profile.deleting === true) return;
      const devices = new Set(member.devices ?? []);
      const usable = tokens.filter(
        (t): t is PushTokenRecord & { token: string } =>
          devices.has(t.deviceId) && typeof t.token === 'string' && t.token.length >= 20,
      );
      if (usable.length === 0) return;
      if (!(await store.claimThrottle(`g_${gid}`, uid, now, THROTTLE))) return;
      await Promise.all(
        usable.map(async ({ deviceId, token, platform, sound }) => {
          try {
            await messaging.send(
              buildMessage({
                token,
                username: HIDDEN_TITLE,
                chatId: `group:${gid}`,
                showName: false,
                sound: sound !== false,
                platform,
                dataPush: false,
              }),
            );
            sent++;
          } catch (e) {
            if (DEAD_TOKEN.has((e as Coded)?.code)) await store.deleteToken(uid, deviceId).catch(() => {});
          }
        }),
      );
    }),
  );
  return sent > 0 ? 'sent' : 'none';
}
