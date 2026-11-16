# Account deletion

Apple's App Review Guideline 5.1.1(v) requires apps that let people create an account to let them delete it **inside the app**. In Fireplace: **Settings → Delete account**. It asks the user to type their username and re-enter their password, then runs `AccountService.deleteAccount` (`lib/src/services/account_service.dart`).

## What is deleted
| Data | Where | How |
|---|---|---|
| Sign-in account (synthetic email + password hash) | Firebase Auth | `User.delete()`, then explicit local signout |
| Username claim, public profile | Firestore `usernames/{name}`, `users/{uid}` | deleted; the username becomes available again |
| Devices, public keys, certificates, prekeys | `users/{uid}/devices/*` and `.../prekeys/*` | deleted |
| Recovery-key backup, link requests, block list | `users/{uid}/private`, `linkRequests`, `blocks` | deleted |
| Every message the user sent | `chats/*/messages` where `senderUid == uid` | deleted in batches |
| Group memberships, group lists, invitations and MLS key packages | `groups/*` rosters, `users/{uid}/groupRefs`, `groupInvites`, `devices/*/mlsPackages` | removed from every group at once when deletion starts ([decision 0023](decisions/0023-group-chats.md)); the group is fenced until a member's Commit removes the devices |
| Invite codes the user made for other people, unused | `users/{uid}/inviteSlots/*`, `invites/*` where `by == uid` | deleted ([decision 0021](decisions/0021-person-invites.md)) |
| Keys, sessions, message history, settings on the phone | Keychain / Keystore, encrypted message files | erased only for the confirmed account; other local accounts are preserved |

## What remains, and why
- **Messages other people sent to this account** remain encrypted until the sender explicitly removes the conversation, deletes their own account, or the server's message expiry removes them. The sender's local history is preserved.
- **Messages already delivered** to other people's devices stay on those devices; the sender cannot remove them (same as every encrypted messenger).
- **Spam reports** remain so abuse can be handled. They name accounts and do not include message text.
- **Used invites**, the account's own and those it gave out, remain so the operator can trace who invited whom. They hold no code, only account ids. An unused code left behind by an older app is refused at sign-up once the account is being deleted or gone.
- Firebase may keep routine infrastructure logs and backups for a limited time under its own policies.

## Failure handling
The client deletes named `limits/send`, `limits/chats`, `limits/claims` and `challengeProof/current` documents; it must never list those collections. Owner device/prekey reads and the matching username read remain available when an earlier deletion already removed the profile. Incoming ciphertext reads stop at the deletion fence; only the account's own sent records remain readable for cleanup. See [decision 0022](decisions/0022-account-deletion-resume.md).

Deletion is a sequence of idempotent steps. Before deleting anything the profile is flagged `deleting: true`; if the app is closed or loses network mid-way, the next sign-in shows **Finish deleting** instead of the normal app, and the same steps run again. If only the final sign-in-account removal fails, the data is already gone and the user is told to sign in again and retry.

## For App Review notes
"Account deletion: open Settings (gear icon) → Delete account → type your username and password → Delete my account. This removes your account and data immediately."

## When the person cannot sign in (operator-assisted)
Someone who lost both their phone and their password cannot use the in-app flow. The operator tool does the same deletion from the server: `fp-ops delete <name> --dry-run` to preview, then `fp-ops delete <name> --reason "..." --yes` (see `tools/operator/README.md`). Because accounts have no email or phone, the operator must decide whether the requester owns the account before running it; the tool records the reason in the moderation log. The public instructions are on `/delete-account/` (site/pages/delete-account.md).
