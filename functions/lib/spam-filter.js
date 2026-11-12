// The spam filter's hook (decision 0018). The server code
// only gathers what the filter may look at and applies what it decides; the
// deciding itself is in spam-policy.js, which is kept private. The public code
// carries spam-policy.example.js in its place.
//
// The filter looks only at metadata the server already holds: who reported an
// account and when, and how old the account is. Never message content, which
// the server does not have. It can restrict an account for a while (the rules
// give it lower daily caps) and queue it for review. It never bans: a person
// does, with `fp-ops ban`.
//
// Everything that touches Firebase is passed in as `store`, so this is tested
// without the emulator.

/**
 * Handles one written report. Returns a short outcome for logs and tests; it
 * never contains ids or usernames.
 *
 * policy: {
 *   reportWindowMs                                    how far back reports count
 *   assess({ reporters, accountAgeMs, now })
 *     -> { action: 'restrict' | 'review' | 'challenge', reasons: string[], until?: number }
 * }
 * A 'challenge' (decision 0020) asks the store to push a token and set
 * `challengeUntil`. 'no-push' falls through to a review: an account we cannot
 * reach is not paused.
 * store: {
 *   reportersSince(uid, sinceMs) -> number   distinct reporters since then
 *   accountCreatedMs(uid) -> number | null   null when the account is gone
 *   restriction(uid) -> number | null        current restrictedUntil, if any
 *   restrict(uid, untilMs)                   merges the claim, keeps others
 *   queue(uid, { action, reasons, untilMs }) review queue entry
 *   challenge(uid, untilMs) -> 'sent' | 'no-push'
 * }
 */
export async function handleReport({ data, now = Date.now() }, { store, policy }) {
  const reported = data?.reported;
  if (typeof reported !== 'string' || reported.length === 0) return 'malformed';
  const created = await store.accountCreatedMs(reported);
  if (created === null) return 'account-gone';
  const reporters = await store.reportersSince(reported, now - policy.reportWindowMs);
  const decision = policy.assess({ reporters, accountAgeMs: now - created, now });
  // The hook never bans, whatever a policy returns.
  const challenge = decision.action === 'challenge' && Number.isFinite(decision.until) && decision.until > now;
  if (challenge) {
    const outcome = await store.challenge(reported, decision.until);
    if (outcome === 'sent') {
      await store.queue(reported, {
        action: 'challenge',
        reasons: Array.isArray(decision.reasons) ? decision.reasons.map(String) : [],
        untilMs: decision.until,
      });
      return 'challenged';
    }
  }
  // A challenge we could not deliver is a review, not a restriction.
  const restrict = !challenge && decision.action === 'restrict' && Number.isFinite(decision.until) && decision.until > now;
  if (restrict) {
    const current = await store.restriction(reported);
    // Never shorten a restriction someone already set.
    if (current === null || current < decision.until) await store.restrict(reported, decision.until);
  }
  await store.queue(reported, {
    action: restrict ? 'restrict' : 'review',
    reasons: Array.isArray(decision.reasons) ? decision.reasons.map(String) : [],
    untilMs: restrict ? decision.until : null,
  });
  return restrict ? 'restricted' : 'queued';
}
