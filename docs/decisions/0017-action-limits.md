# 0017: Daily limits on new chats and one-time prekey claims

*Update (issue #12): the counters are required; leaving one out is refused for every account. Apps from v0.3.4 write them.*

Date: 2026-11-12. Status: requested by the owner (issue #13). Each action
has its own daily cap. Goes with app decision 0029.

## Why

Messages are limited (0015). Two other actions could be repeated without limit:

- **New chats.** A script could open message requests to many people.
- **One-time prekey claims.** Anyone with a profile may delete another device's
  one-time prekey, because that is how a claim works. A script could drain a
  pool, so new sessions fall back to the signed prekey alone. A per-account
  cap stops that.

## Decision

Each is counted per account in `users/{uid}/limits/{name}` as
`{at, day, today}`, written in the same batch (new chat) or transaction (claim)
as the action, so counting needs no read. Same two forms as the send clock:
`update({at, today: +1})` in a running day, `set({at, day, today: 1})` for a new
one. Counts only go up by one, nothing can be backdated, and only account
deletion may delete a counter.

| Counter | Per day (24 h from the first) | Past the limit |
|---|---|---|
| `chats` | 50 new chats | the chat is not created; the app says to try tomorrow |
| `claims` | 200 one-time prekeys | the claim is refused; the app starts the session with the signed prekey alone |

50 new conversations a day, and 200 claims (each new session claims one per
device of the other person, a few per chat), leave honest use far below the
limits.

**Older apps** (before v0.3.4) do not write the counters. That stays allowed
only for an account that has never written a counter, and goes when the older
send-clock form goes (#12).

## Not limited by rules

- **Device linking** is owner-only and needs the account password; a message
  reaches at most 40 devices (envelope limit), so extra devices gain nothing.
- **Lookups** (usernames, profiles, devices) are reads, which rules cannot
  count. App Check enforcement (app decision 0017) is the step for those,
  then the spam filter (#9).

## Cost

No extra reads; the counter is one extra write per new chat or claim.

## Tests

Four rules tests: counting and the cap for new chats, leaving the counter out,
forged counts and deletion, and prekey claims with their cap. They fail on the
previous rules.

AI assistance: Claude Code.
