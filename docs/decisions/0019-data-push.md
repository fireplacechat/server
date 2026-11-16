# 0019: A push the phone can rewrite

Date: 2026-11-12. Status: requested by the owner for notification previews
(app issue #82, backend issue #22). Goes with the app's decision 0030. Review
before merge. Not deployed; the owner deploys.

## Decision

The phone, not the server, decides what a notification says: it decrypts the
message and shows the text, a reaction, or "New Message". The server still
only has ciphertext and adds nothing it does not send today.

- **Android apps that handle it** (v0.3.6 and later) get a high-priority
  **data** message and no notification block:
  `{fp: "1", k: <conversation key>, title: <username or "Fireplace">, ch: <channel>}`,
  with the conversation key as the collapse key. The app's background handler
  posts the notification itself. The push has no message text. The app
  decrypts the message on the phone and then shows the notification.
- **Everyone else** gets the notification payload as before (decision 0013):
  older Android apps have no background handler and would show nothing.
- **iOS** gets `mutable-content: 1` in `aps`, so a Notification Service
  Extension may rewrite the alert. None exists yet; until then iOS shows the
  alert as sent, which is also what shows if the extension fails.

`k` is the same opaque key as before (the first 32 hex characters of
`sha256("fireplace-push:" + chatId)`). The phone finds the chat by hashing its
own chat ids. The title and channel are what the notification payload already
gives Google today. No message text, chat id, message path, account id or
envelope is sent. `pushOnMessage` still cannot tell a reaction or an edit from
a message, and must not learn it.

## Rules

`users/{uid}/pushTokens/{deviceId}` accepts an optional boolean `dataPush`.
Everything else is unchanged (owner-only, active device, token shape,
platform, server time). It states what the app can do, not what the person
chose: a phone with previews off still gets the data push and shows "New
Message" itself. The server sends data only when `dataPush` is true and the
platform is `android`. Older apps rewrite the whole token document with
`set()` at each launch, so an app downgraded to an older version drops the
field by itself.

Another pending change (backend #11) also edits `firestore.rules`; this one
adds one field to `hasOnly` and one line.

## Unchanged

Who gets a push (recipient devices with an envelope, never the sender's own
devices; silent for requests, blocks and deleted accounts), the throttle (one
per conversation per recipient every 20 s, a reaction counts), dead-token
removal, logs.

## What it costs

Nothing on the server: the same lookups and the same one throttle write per
alert. `listTokens` already reads the whole token document; it now passes on
two more fields. On the phone, a data push with previews on costs about one
Firestore read per new message in that chat (app decision 0030).

## Deploy order

Deploy these rules **before** v0.3.6 reaches anyone. An app that writes
`dataPush` to the older rules is refused and that device gets no pushes until
the rules are live. The function can go out at the same time:
`firebase deploy --only firestore:rules,functions` from an up-to-date `main`.

## Tests

`functions/test/push-core.test.ts`: the data payload's shape and its string
values; no text, chat id, account id or envelope in it; the name and sound
choices kept; older apps and iOS keep the notification payload;
`mutable-content` on iOS with and without sound; the throttle shared. The
rules test for `dataPush` fails on the previous rules; the earlier 95 pass
unchanged. The new function tests fail on the previous sender.

Implementation assisted by Claude Code.
