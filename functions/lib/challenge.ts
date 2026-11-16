// A push challenge for a suspicious sender (decision 0020).
//
// A random token is stored where clients cannot read it, then sent to the
// account's own devices. The app sends the same token back. There is no
// captcha: that would be a third-party service.
//
// The token is server-generated. It is not message text, a contact or a key.

import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { ChallengeHold, Untrusted } from './types.ts';

export const CHALLENGE_BYTES = 32;

/** The FCM message that carries a challenge: data only. */
export interface ChallengeMessage {
  token: string;
  data: { type: 'rateLimitChallenge'; challenge: string };
  /** Never set: a notification would make an old app show "New Message". */
  notification?: never;
  android: { priority: 'high' };
  apns: {
    headers: { 'apns-push-type': 'background'; 'apns-priority': '5' };
    payload: { aps: { 'content-available': 1 } };
  };
}

export interface IssueChallengeDeps {
  /** Writes the hold and the claim. */
  save(uid: string, token: string, until: number): Promise<unknown>;
  /** Sends one FCM message. */
  push(message: ChallengeMessage): Promise<unknown>;
  /** Removes the hold and the claim when nothing could be sent. */
  clear(uid: string): Promise<unknown>;
}

export interface ClearChallengeDeps {
  read(uid: string): Promise<Untrusted<ChallengeHold> | null | undefined>;
  clear(uid: string): Promise<unknown>;
}

/** Data-only push. No title and no body, so an old app does not show "New Message". */
export function challengeMessage(fcmToken: string, challenge: string): ChallengeMessage {
  return {
    token: fcmToken,
    data: { type: 'rateLimitChallenge', challenge },
    android: { priority: 'high' },
    apns: {
      headers: { 'apns-push-type': 'background', 'apns-priority': '5' },
      payload: { aps: { 'content-available': 1 } },
    },
  };
}

function sameToken(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Stores a challenge and pushes it. `tokens` are the account's FCM tokens.
 * Returns 'sent', or 'no-push' when there is nowhere to send it (the caller
 * then queues a review instead of pausing the account).
 *
 * deps.save(uid, token, until) writes the hold and the claim.
 * deps.push(message) sends one FCM message.
 * deps.clear() removes the hold and the claim when nothing could be sent.
 */
export async function issueChallenge(
  { uid, untilMs, tokens, random = randomBytes }: {
    uid: string;
    untilMs: number;
    tokens: string[];
    random?: (size: number) => Buffer;
  },
  deps: IssueChallengeDeps,
): Promise<'sent' | 'no-push'> {
  if (!Array.isArray(tokens) || tokens.length === 0) return 'no-push';
  const token = random(CHALLENGE_BYTES).toString('hex');
  await deps.save(uid, token, untilMs);
  let sent = 0;
  for (const fcmToken of tokens) {
    try {
      await deps.push(challengeMessage(fcmToken, token));
      sent += 1;
    } catch {
      // A dead token is skipped. The token itself is never logged.
    }
  }
  if (sent === 0) {
    await deps.clear(uid);
    return 'no-push';
  }
  return 'sent';
}

/**
 * Checks a token the app sent back and clears the challenge.
 * Returns 'cleared', 'wrong' or 'none'.
 */
export async function clearAnsweredChallenge(
  { uid, token }: { uid: string; token: unknown },
  { read, clear }: ClearChallengeDeps,
): Promise<'cleared' | 'wrong' | 'none'> {
  const hold = await read(uid);
  if (!hold || typeof hold.token !== 'string') return 'none';
  if (!sameToken(hold.token, token)) return 'wrong';
  await clear(uid);
  return 'cleared';
}
