# 0021: Invites from people

Date: 2026-11-14. Status: proposed (backend issue #31, mobile issue #115). Extends
[0005](0005-invites-and-rate-limit.md). App side: mobile decision 0049.

Sign-up stays invite-only. Until now only the operator could make a code. Every account
now gets invite rows of its own, on a schedule the operator controls and can change
at any time.

## Documents

| Path | Written by | Holds |
|---|---|---|
| `config/invites` | operator (Admin SDK) | `unlockAfter`: seconds after account creation, one per row; `paused` |
| `inviteAllowances/{uid}` | operator | the same, for one account, replacing the default |
| `users/{uid}/inviteSlots/{row}` | the account (rules) or the operator | `code`, `invite` (its SHA-256), `at`, `replacedAt`, `used` |
| `invites/{sha256(code)}` | as before, plus `by` and `slot` for a person's code | `usedBy`, `usedAt` after sign-up |

Without either operator document the default is `[0, 86400, 604800]`: one invite at
once, one after 24 hours, one after 7 days. At most ten rows (`row` is `0`-`9`).

## Rules

- **Make a code.** One batch: the row and its invite. Accepted only when the account has
  a profile, is not banned (claim or `bans/{uid}`), restricted, being deleted or a
  moderator; the row exists in its schedule and `createdAt + unlockAfter[row] <= request.time`
  (server time, so the phone clock cannot unlock a row); nothing is paused; the row is
  empty; the code is 16 characters of A-Z/2-7 and `sha256(code)` is the invite id; the
  invite names this account and row.
- **Replace a code.** Same checks; the old invite is unused and deleted in the same
  batch. The first replacement of a row is immediate, then once an hour (`replacedAt`).
- **Redeem.** The sign-up batch is unchanged for operator codes. For a person's code it
  also sets `used: true` on their row, and is refused if the inviter has no profile, is
  being deleted, or is banned. Anyone holding an *unused* person's code may `get` its
  invite to learn which row to mark. Used invites and operator invites stay unreadable.
- **Read.** Only the owner reads their rows; accounts read `config/invites` and their own
  allowance. Nobody can list invites, and the inviter never sees `usedBy`.
- **Delete.** A row is deleted only while its account is being deleted; an unused
  invite of your own may go then too.
- **The app chooses the code.** The rules check its format and hash, not its
  randomness. A weak code only exposes the person who shares it.

## Operator

`fp-ops invites schedule|pause|resume|user|grant|by`, `fp-ops invite revoke <@name> --row N`
and `fp-ops invite replace <@name> --row N`; the same in the dashboard's *From people* view.
The Admin SDK skips the rules, so these repeat the checks that matter: a used code is
never changed, ten rows at most, the app's code format. Phones with the page open see a
change at once. `fp-ops invites by @name` shows who joined with an account's codes, for
tracing abuse; the app never shows this.

## Growth and cost

- Accounts can only multiply through invites: the default lets each account add three
  more within a week, and those accounts can do the same. `invites pause` stops new codes
  for everyone at once; codes already made keep working until revoked.
- Making a code: 2 writes and about 5 rule reads, at most once per row, plus at most one
  replacement per row per hour (3 writes). Redeeming a person's code: one extra read
  (the invite) and one extra write (the row). The Invite page listens to 2 documents
  and the account's rows only while it is open.

## What this does not protect

- A leaked code works for whoever uses it first, as before.
- Codes are stored readable by their owner (the owner's choice, to show them on every
  device and let the operator swap them live). A database leak exposes unused codes;
  `fp-ops` can revoke them.
- Apps older than this change cannot redeem a person's code (their batch does not mark
  the row); they still redeem operator codes.

## Account deletion

Builds on [0022](0022-account-deletion-resume.md). The rules let a deleting (or
profile-less) owner list and delete their rows and their own unused invites, and refuse
redemption of a deleting or deleted account's codes, so a left-over code is inert.
The app's deletion (mobile decisions 0048 and 0049) deletes them after the fence;
`fp-ops delete` removes the rows with the rest of the profile and deletes unused codes
`where by == uid`. Used invites stay, as before.

## Deploy order

Deploy these rules before shipping the app page. Until then the page's writes are
refused.

## Tests

`firebase/tests/person_invites.test.ts` (18 tests: schedule, fourth row, hash, standing,
pause, allowance, reading, redeeming, used flag, banned/deleting/deleted inviter,
operator codes, replacement and its wait, deletion) and `tools/operator/test/person-invites.test.ts`.
Mutating the unlock time, hash, used-row, cooldown and ban checks each fails a test.

AI assistance: Claude Code.
