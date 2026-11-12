# Push notifications

**Status:** built, not deployed. The project is on the **Blaze** plan. The
owner deploys (`firebase deploy --only firestore:rules,functions`). See the
app's decision 0026 and [decision 0013](../decisions/0013-push-sender.md).

## What a notification shows

```
[Fireplace icon]  alice                 now
                  New Message
```

Title: the sender's username, or **Fireplace** if the recipient turned off
"Show sender's name" on that device. Body: always **New Message**. Sound: the
Fireplace pop (`notification_pop.wav` on iOS, the "messages" channel on
Android), or none (no `aps.sound`, the "messages_silent" channel) if that
device turned off "Notification sound". No message text, chat id, account id
or badge number is sent; the server only has ciphertext.

Android apps from v0.3.6 mark their registration `dataPush`. They get the same
title and channel as a data message instead, decrypt the message on the phone
and show the preview themselves (or "New Message"); see
[decision 0019](../decisions/0019-data-push.md). iOS alerts carry
`mutable-content` for a future Notification Service Extension.

## Pieces

- **App** (mobile repository): `lib/src/model/push/push_notification_service.dart`
  asks for permission on the first signed-in launch, stores the FCM token at
  `users/{uid}/pushTokens/{deviceId}` (`token`, `platform`, `showName`,
  `sound`, `dataPush`, `updatedAt`), refreshes it, and deletes it on sign-out, when turned off, and
  on account deletion. The app sets the icon badge itself from local unread
  counts.
- **Sender:** `functions/` holds the `pushOnMessage` Cloud Function, triggered
  by `chats/{chatId}/messages/{msgId}` creates. The decisions are in
  `functions/lib/push-core.js`:
  - alerts only the recipient's devices that received an envelope, never the
    sender's own devices;
  - skips unaccepted message requests, blocked senders, and deleted or
    deleting accounts;
  - one alert per conversation per recipient every 20 s (`pushThrottle/{chatId}`,
    server-only), and the alert replaces the previous one on the phone;
  - deletes tokens FCM reports as dead;
  - logs only an outcome word, never ids, usernames or tokens.
- **Rules:** `pushTokens` are owner-only and require an active device;
  `showName`, `sound` and `dataPush` must be booleans; `pushThrottle` is closed to clients.

## Tests

```sh
npm ci --prefix functions && npm test --prefix functions   # sender logic, no emulator
```

The rules and operator tests run under the emulator as described in the
README.

## Owner checklist (once)

1. Apple: enable **Push Notifications** on `com.fireplacechat.app`, create an
   APNs auth key and upload it in Firebase → Project settings → Cloud Messaging.
   Regenerate the App Store profile (the app's **iOS signing setup** workflow).
2. Google Cloud Billing: budget alerts at low amounts (see [COSTS.md](COSTS.md)).
3. `firebase deploy --only firestore:rules,functions` (the project is the default in `.firebaserc`, which is not published).
4. Privacy policy and store privacy answers: push token, sender username in
   alerts, Apple and Google as processors.
