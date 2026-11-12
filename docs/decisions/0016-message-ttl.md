# 0016: Expired messages are deleted automatically

Date: 2026-11-12. Status: requested by the owner (issue #14). Updates 0010,
which avoided TTL because it needed billing; the project is now on Blaze.

## Decision

A Firestore TTL policy on `chats/{chatId}/messages.expireAt` deletes the server
copy of a message once its `expireAt` has passed. The rules already require
`expireAt` to be 28 to 32 days after sending (0010), so server copies now go
away about 30 days after they were sent without anyone running a sweep.
Messages stay in the recipients' own encrypted history on their phones.

The same field override exempts `expireAt` from single-field indexing. Nothing
queries by it (`fp-ops purge-messages` orders by document path), and an index
on a timestamp written with every message only costs storage.

## What it costs

TTL itself has no fee. Each expired message is one billed delete, about $0.02
per 100,000 in nam5, inside the free 20,000 deletes a day first. These are the
same deletes the manual purge already made; the push cost estimate (0013,
`docs/push/COSTS.md`) does not change.

## What it does not do

- Deletion is not instant: Firestore deletes expired documents typically within
  24 hours after they expire, so the promise stays "about 30 days".
- A message without a valid `expireAt` (written before 0010) is not deleted.
  `fp-ops expire-messages` gives those one, after which TTL deletes them, and
  `fp-ops purge-messages` stays for a one-off sweep.
- Nothing else expires: chats, profiles, devices and send clocks stay until
  their account is deleted.

## To operate (owner)

`firebase deploy --only firestore:indexes` creates the policy; it can take a
while to become active. Check it under Firestore → TTL in the console. To turn
it off, remove the field override and deploy again.

AI assistance: Claude Code.
