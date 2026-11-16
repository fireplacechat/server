// Shapes shared by the functions: the Firestore documents they read, as the
// app writes them, and how unchecked data is typed. Types only: nothing here
// exists at runtime.

/**
 * A document read from Firestore, before any check. The rules constrain what
 * clients can write, but the functions still test every field they use, so
 * each field is `unknown` (and may be missing) until tested.
 */
export type Untrusted<T> = { [K in keyof T]?: unknown };

/** `chats/{uidA_uidB}`. */
export interface ChatDoc {
  /** `false` while a message request is waiting. Missing on chats older than requests. */
  accepted?: boolean;
  initiator?: string;
}

/** `chats/{chatId}/messages/{msgId}`. The server only ever holds ciphertext. */
export interface MessageDoc {
  senderUid: string;
  /** One sealed copy per device id, for the recipient's and the sender's own devices. */
  envelopes: Record<string, unknown>;
  /** Set by the sender on a message nobody reads as one (decision 0025): no alert. */
  quiet?: boolean;
}

/** One account in a group's public roster. */
export interface GroupMember {
  role: 'admin' | 'member';
  /** The account's devices that are in the group: 1 to 4. */
  devices: string[];
}

/** A group's roster, by account id. */
export type GroupMembers = Record<string, GroupMember>;

/** Someone invited: their devices are in the MLS group, and they are not in the roster yet. */
export interface GroupInvite {
  /** Who invited them. */
  by: string;
  devices: string[];
  /** A Firestore Timestamp: seven days after the invitation. */
  expireAt: { toMillis(): number };
}

/** People invited to a group, by account id. */
export type GroupInvited = Record<string, GroupInvite>;

/** `users/{uid}/groupInvites/{gid}`: an open invitation, as the invited account lists it. */
export interface GroupInviteRef {
  by: string;
}

/** Devices that left and are still in the MLS state, until a member's Commit removes them. */
export interface GroupFence {
  uid: string;
  devices: string[];
}

/**
 * `groups/{gid}` (decision 0023). The server keeps the roster the rules need. It
 * never holds the group's name, its MLS roles or message text.
 */
export interface GroupDoc {
  members: GroupMembers;
  /** People invited: added to MLS by the invitation, waiting to join. */
  invited?: GroupInvited;
  epoch: number;
  /** Not empty: no new messages until a Commit removes the leaves. */
  fence: GroupFence[];
}

/** `groups/{gid}/events/{eventId}`: one group message. Ciphertext, plus who sent it. */
export interface GroupEventDoc {
  by: string;
  device: string;
  /** Set by the sender on a colour or notice message (decision 0025): no alert. */
  quiet?: boolean;
}

/** `users/{uid}`: the public profile. */
export interface ProfileDoc {
  username?: string;
  /** Set by account deletion; the rules refuse writes from such an account. */
  deleting?: boolean;
}

/** `users/{uid}/pushTokens/{deviceId}`: one device's FCM registration. */
export interface PushTokenDoc {
  token: string;
  platform?: 'android' | 'ios';
  /** "Show sender's name" in the app. Missing on older apps: treated as on. */
  showName?: boolean;
  /** "Notification sound" in the app. Missing on older apps: treated as on. */
  sound?: boolean;
  /** Android apps from v0.3.6 (decision 0019): they post the notification themselves. */
  dataPush?: boolean;
}

/** A push registration as listed for one account: its document id and unchecked fields. */
export type PushTokenRecord = { deviceId: string } & Untrusted<PushTokenDoc>;

/** `reports/{reporter_reported}`. Ids only (decision 0014). */
export interface ReportDoc {
  reporter: string;
  reported: string;
  reason: string;
}

/** `challengeHolds/{uid}` (decision 0020). Clients cannot read it. */
export interface ChallengeHold {
  token: string;
}

/** A rejected Firebase call, as far as this code looks at it: only `code` is read. */
export type Coded = { code?: any } | null | undefined;
