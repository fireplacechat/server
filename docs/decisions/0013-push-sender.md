# 0013: Push sender on Blaze

Date: 2026-11-11. Status: requested by the owner after moving the project to the
Blaze plan. Review before merge. Not deployed; the owner deploys.

## Decision

Add the `pushOnMessage` Cloud Function (`functions/`), triggered when a message
document is created. It sends one FCM alert to each of the recipient's devices
that received an envelope. The title is the sender's username (or "Fireplace"
when that device's `showName` is false) and the body is "New Message". It plays
the app's pop unless that device's `sound` is false: on iOS `aps.sound` is
`notification_pop.wav`, or absent; on Android the channel is `messages`, or
`messages_silent`. It sends
no message text, chat id, account id or badge. The app's decision 0026 covers
the client side.

## Rules

- `users/{uid}/pushTokens/{deviceId}` accepts optional booleans `showName` and
  `sound`.
  Everything else is unchanged: owner-only, active device, token shape,
  platform, server time.
- `pushThrottle/{chatId}`, which records when each recipient was last alerted,
  is closed to clients. Only the function writes it.

## Behaviour

Silent for unaccepted requests, blocked senders, and deleted or deleting
accounts. Never alerts the sender's own linked devices. At most one alert per
conversation per recipient every 20 s, and each alert replaces the previous one
on the phone. Dead tokens are deleted. Logs hold only an outcome word.
`maxInstances: 2`, 256 MiB, 20 s, `retry: false`: a repeated alert is worse
than a missed one.

Banned senders are not checked separately. The rules already refuse their
writes once their token refreshes, within the hour.

## Account deletion

`fp-ops delete` removes the deleted account's entry from `pushThrottle` for each
of its chats. Its `pushTokens` were already deleted.

## Supersedes

[0005](0005-invites-and-rate-limit.md): "Cloud Functions / Blaze remain off".
Costs: [COSTS.md](../push/COSTS.md). Tests: `functions/test/push-core.test.ts`,
rules tests for `showName`, `sound` and `pushThrottle`, and the operator deletion test.
Implementation assisted by Claude Code.
