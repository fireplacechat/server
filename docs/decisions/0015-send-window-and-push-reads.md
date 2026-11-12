# 0015: Send window and daily cap instead of a fixed gap; push lookups at once

*Update (issue #12): the older `{at}` form is no longer accepted; every app from v0.3.3 writes the window forms.*

Date: 2026-11-12. Status: requested by the owner to make sending faster. Goes
with app decision 0028. Partly supersedes 0005 (the 500 ms gap).

## Send window

**Before:** every message needed the sender's clock `users/{uid}/limits/send`
to be at least 500 ms old. The app waited 700 ms between sends to stay safely
under it, so a message right after a reaction, or two quick replies, waited.

**Now:** an account may send up to **20 messages in a 10-second window**. A
burst goes out at once; the average stays at the earlier 2 a second, so the
worst case for cost and abuse does not change.

**And at most 2,000 messages a day** (reactions included), counted over 24
hours from the first message of the day. Past that, sends are refused until the
day ends: an automatic, temporary block. It changes the worst case for one
account from about 170,000 messages a day (2 a second) to 2,000.

The clock is `{at, window, sent, day, today}`: the time of the last message,
the current window and its count, the current day and its count. The message
rule only checks that the clock was written at `request.time` in the same
batch; the clock's own rule decides. The app writes one of three forms, none of
which needs a read first:

| Form | Write | Allowed when |
|---|---|---|
| a new day | `set({at, window, sent: 1, day, today: 1})`, all times the server time | no day is running, and the window is over |
| a new window | `update({at, window, sent: 1, today: +1})` | the day runs and is under the cap, and the window is over |
| the next one | `update({at, sent: +1, today: +1})` | the window is under 10 s old with at most 20, and the day is under the cap |
| the older form (older apps) | `set({at})` | no day is running, and its 500 ms gap (or the window) has passed |

Counts can only go up by one: a skipped, rewound or left-out count is refused,
and so is a backdated window or day. When the app guesses wrong (another device
opened a window, or its clock is off), the write is refused and it retries with
another form.

**Older apps keep working**, with their 500 ms gap, as long as their account
has no running day. The older form cannot reset a day's count. It does allow an
account that only ever uses it to send 2 a second without a daily cap, as
before this change, so it is to be removed once every app has the new forms
(backend issue).

**Release order:** the app falls back to the older form when the server refuses
every new form, so either order works. Deploying these rules first is still the
plan.

## Who gets banned

The rules slow everyone down automatically (the window) and
block an account for the rest of its day at the cap. They do not ban: a rule
cannot ban, and an honest heavy user can reach the cap. `fp-ops limited` lists
the accounts at the cap in a running day, for review next to spam reports; a
ban is still `fp-ops ban`. It reads one index entry per listed account (a
collection-group index on `limits.today`, in `firestore.indexes.json`). Ban
rules stay in the private spam filter. Further cases are backend issues.

## Deleting the send clock

The owner could delete the clock at any time, and the next message then counted
as a first one. Alternating a delete and a send removed the limit entirely,
under both the old and the new rule. A delete is now allowed only while the
account is being deleted (the app marks the profile `deleting` first, and
`fp-ops delete` uses admin access) or once the profile is gone.

## Push lookups at once

`pushOnMessage` read the chat, then the block, then both profiles, then the
tokens: four rounds of reads in a row. It now starts all five lookups together.
A silent request or a blocked sender now reads a few documents it does not
need; a request allows three messages, so this costs fractions of a cent.

Memory stays at 256 MiB: `firebase-functions` v2 gives a function one full CPU
by default at that size, and each instance handles 80 requests at once. There
is still no minimum instance, so nothing is billed while idle.

## Tests

Eight new rules tests (bursts, the window and daily limits, opening windows
and days, forged counts and times, the older form, the first message, deleting
the clock) fail on the previous rules; the earlier 80 pass unchanged. A push
test checks that the lookups overlap and an operator test covers
`fp-ops limited`; both fail on the previous code.

Deploy: `firebase deploy --only firestore:rules,firestore:indexes,functions`
(owner).
AI assistance: Claude Code.
