// A push challenge for a suspicious sender (decision 0020).
//
// A random token is stored where clients cannot read it, then sent to the
// account's own devices. The app sends the same token back. There is no
// captcha: that would be a third-party service.
//
// The token is server-generated. It is not message text, a contact or a key.

import { randomBytes, timingSafeEqual } from 'node:crypto';

export const CHALLENGE_BYTES = 32;

/** Data-only push. No title and no body, so an old app does not show "New Message". */
export function challengeMessage(fcmToken, challenge) {
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

function sameToken(a, b) {
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
export async function issueChallenge({ uid, untilMs, tokens, random = randomBytes }, deps) {
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
export async function clearAnsweredChallenge({ uid, token }, { read, clear }) {
  const hold = await read(uid);
  if (!hold || typeof hold.token !== 'string') return 'none';
  if (!sameToken(hold.token, token)) return 'wrong';
  await clear(uid);
  return 'cleared';
}
