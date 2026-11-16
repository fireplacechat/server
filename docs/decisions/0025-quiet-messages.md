# 0025: Quiet messages cause no alert

Status: accepted by the owner (2026-11-14: "do what you can" after the audit of
that date). Companion mobile decision 0054.

## Why

The push functions cannot read a message, so they alerted for every message
document. An edit, a delete, a reaction taken back, and in groups the colour and
notice messages phones send each other, all showed as "New Message" on an
iPhone, and every one of them cost the lookups of a real message and started
the iPhone's notification extension.

Measured over two days of production logs: 202 of 468 1:1 pushes were inside
the 20-second throttle window. Each had done five lookups before the throttle
refused it.

## What changes

- **A message document may carry `quiet: true`**, in `chats/{id}/messages` and
  in `groups/{gid}/events`. The sender sets it. Only `true` is allowed; the
  field is otherwise absent. It is the only thing the server learns: that this
  document is not a message a person reads.
- **1:1, quiet:** no alert. The function reads the recipient's push tokens; if
  one of the reached devices is an Android app that posts its own notifications
  (decision 0019), that device gets the usual data message, so it can update or
  remove the alert the edit or delete is about. Nobody else gets anything. A
  quiet message does not use the alert throttle and is not held back by it.
- **Groups, quiet:** nothing is sent and nothing is read.
- **1:1, not quiet:** the function first reads the throttle document (one
  read). Inside the window it stops there. Outside it, it does the lookups and
  claims the throttle in a transaction, as before.

## What it does not change

- A reaction is still a message for this purpose: it has its own alert.
- An older app sets no mark; its edits and deletes alert as they did.
- The block, request and deleted-account checks still apply to a quiet message
  that is sent on as data.

## Cost

Fewer reads than before in every case but one: a message outside the throttle
window costs one more read (the peek). With the measured share of throttled
messages that is about a quarter fewer function reads for 1:1 messages, and
one read or none for each quiet message, where it was five and a push.

## Abuse

A modified app can mark an ordinary message quiet. The recipient then gets no
alert and finds the message when they open the app. It cannot be used to send
more, or to anyone new: every other rule still applies.

## Tests

`functions/test/push-core.test.ts` (quiet, data-only delivery, the peek),
`functions/test/groups.test.ts` (quiet group message), and the rules tests
"a message may be marked quiet" in `rules.test.ts` and `groups.test.ts`.
