# 0011: Moderator dashboard (read-only reports)

Date: 2026-11-11. Status: accepted. Extends [0004](0004-abuse-controls.md).

Reports are written by the app and were only readable with Admin credentials (the Firebase console or `fp-ops`). Nothing emails them. The operator reviews them on a local page instead.

## Login
- One Firebase Auth user, created by `fp-ops moderator-create`. It is not a Fireplace account: no `users/{uid}` profile, and its email must not end in `@users.fireplace.invalid`.
- The custom claim `moderator: true` is set only by that command (Admin SDK, in the backend repo). The password is chosen by the operator and is not stored.
- The dashboard repository holds no service-account key. It signs in with the client SDK / REST API as that user. Admin credentials stay in `fp-ops`.

## Rules
- `get` and `list` on `reports` succeed only for `isModerator()`: the claim is true, the token is not banned, and the account has no profile.
- Create and update stay as they are (the reporter, who must have a profile). Delete stays denied. A moderator cannot file, edit, or remove a report.
- A real account that is also given the claim still cannot read reports, because it has a profile.
- Invite updates reject the claim. That is the one write a signed-in account with no profile could previously do, and claiming an invite is how an account gains a profile.
- Every other collection is unchanged. The moderator uid is not a chat participant and has no profile, so chats, messages, usernames, devices, blocks and backups stay denied.
- The owner deploys rules (`firebase deploy --only firestore:rules`). Until then the login can sign in and the read fails.

## What the page shows
- The report document as stored: account ids, reason, optional note, optional chat id, time, status (a missing status is open), any operator note, and context lines.
- Usernames are not on the report. The page does not read `usernames` or `users`. `fp-ops user <uid>` still resolves a name.
- Context is plaintext the reporter opted to attach. It is not verified. The page displays it locally and does not send it anywhere else.
- The page does not ban, resolve, or delete. Those remain `fp-ops` commands.

## Where it runs
- A private repository named Moderator. `npm start` serves it on `127.0.0.1` only. It is not hosted.
- The Firebase web client config in that repo is a client key, the same kind the app already ships. It grants nothing by itself.
