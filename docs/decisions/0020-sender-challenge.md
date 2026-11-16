# 0020: Challenge a suspicious sender before pausing them

Date: 2026-11-12. Status: requested by the owner (issue #11). The mechanism
is in place. The private spam policy does not ask for a challenge yet, so
nobody is challenged until that policy says so and the app can answer
(fireplacechat/mobile#96).

## How a challenge works

The server makes a random token, stores it where clients cannot read it, and
sends it to that account's own devices. The app sends the same token back.
That shows the caller holds a push token this server already registered. A
script talking to the server directly does not.

There is no captcha. That would be a third-party service. An account with no
push token is queued for a person to review, and is not paused.

## What it does

The spam filter's policy may return `action: 'challenge'` and an `until`
time, the same shape as a restriction (0018). The hook then:

1. Reads that account's `pushTokens`. If there are none, it queues a review
   and does not pause the account.
2. Otherwise it stores `challengeHolds/{uid}` (`token`, `until`) and sets the
   custom claim `challengeUntil` (milliseconds). Clients cannot read or write
   the hold. The rules deny it.
3. Sends a data-only push to those devices: `{ type: 'rateLimitChallenge', challenge }`.
   No title, no body, no message text, no chat id. A dead token is skipped.
   If every send fails, the hold and the claim are removed and the account is
   queued for review instead.
4. Writes the usual review-queue entry, with `action: 'challenge'`.

The private policy is unchanged, so this does not run in production yet.

While the claim is in the future, the rules refuse new messages, new chats
and one-time prekey claims. Reads, reports, blocks, push-token updates and
account deletion still work. The claim is on the ID token, so it starts
applying when the token refreshes, within the hour, same as a ban or a
restriction (0018).

The account continues once it writes `users/{uid}/challengeProof/current`
with `{ token }` equal to the hold. The rules compare the two. A later
challenge is answered by writing that document again with the new token. The
proof is the token the push already delivered to that account; it is not
message text. A wrong token is refused. After `until`, the claim no longer
matches and
sending works again even without an answer, so the policy should set `until`
far enough out that waiting is not useful. A person clears a stuck account
by removing the claim and the hold (the console, until `fp-ops` grows a
command for it).

`clearAnsweredChallenge` in `functions/lib/challenge.ts` checks a token and
removes the claim and the hold, which stops the extra reads below. It is not
deployed: wiring it is one export in `functions/index.ts`, and that file is
being edited for notification previews (issue #22). Until that export exists,
a solved challenge still allows sends, and the extra reads last until `until`.

## What the app must do

Not in this repository. The app, when it receives that data push, writes
`users/{uid}/challengeProof/current` as `{ token: <the challenge> }`,
replacing it if a proof is already there, and retries the send. It must not
put the token on a message. An old app that
ignores the push cannot answer, which is why the private policy stays off
until the app does this. See fireplacechat/mobile#96.

## Cost

Nothing while nobody is challenged. The rules read the claim from the ID
token and do not touch the hold.

Issuing one challenge: one read per push-token document, one write of the
hold, one claim update, the queue write and the moderation-log write that
0018 already does, and one FCM send per device. One function invocation, the
existing `reviewOnReport`. No new Firebase product.

While a challenge is open, each refused or accepted message, new chat or
prekey claim reads the proof and the hold (two reads). `||` in the rules
skips those reads when the claim is absent. Writing the proof is one write
plus the hold read the rule does. Clearing the claim later is one claim
update and one hold delete, after which the reads stop.

No minimum instances, and `reviewOnReport` stays capped at 2 instances with
no retries.

## Tests

Function tests with a stand-in policy: a challenge is stored and queued, a
missing or dead push token becomes a review, and the push has no visible
text. Rules tests: a challenged account cannot send, open a chat or claim a
prekey; the right proof lets it send; a wrong proof is refused; a later token
replaces the proof; the hold is not readable; another account is unaffected.
They fail on the previous rules.

AI assistance: Grok.
