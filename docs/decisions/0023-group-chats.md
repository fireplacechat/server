# 0023: Group chats: rules, membership requests and fences

Date: 2026-11-14, amended the same day (the invitation now carries the Add; see
*Invitations*). Status: proposed; the owner deploys rules and functions.
Implements mobile decision 0050 and `docs/protocol/group-chats-v1.md` in the app
repository. The cryptography is MLS in `fireplace-crypto` (feature `groups`).

## What the server holds

| Path | Holds | Written by |
|---|---|---|
| `groups/{gid}` | `members: {uid: {role, devices}}`, `invited: {uid: {by, devices, expireAt}}`, `epoch`, `fence`, `createdAt` | the function; `epoch` also by a member's update Commit |
| `groups/{gid}/commits/{epoch}` | MLS Commit ciphertext, and `e`, its epoch as a number (for queries) | a member (update, rename) or the function (membership) |
| `groups/{gid}/events/{device}-{n}` | MLS application message ciphertext, 30-day expiry | a member device |
| `groups/{gid}/welcomes/{uid}_{epoch}` | the Welcome for an invited account | the function, from the invitation request |
| `users/{uid}/groupInvites/{gid}` | a pending invitation, for the invited account to list | the function |
| `groups/{gid}/ops/{opId}`, `users/{uid}/groupOps/{opId}` | membership requests and their outcome | members; the function completes them |
| `users/{uid}/groupRefs/{gid}` | the account's groups | the function |
| `users/{uid}/devices/{d}/mlsPackages/{0-9}` | up to ten public key packages | the owner; the function consumes them |

Group names, administrators as MLS sees them, colours and message text are encrypted:
the server never sees them.

## Rules

- **Reading** needs a live member (profile, not deleting, not banned). Someone
  invited is not a member: they can read their own Welcome and nothing else, and
  cannot send, until they join.
- **A message**:
  - is created once, at `{device}-{n}`, from one of the member's own group devices;
  - is for the current epoch or the one before;
  - is at most 96 KiB, with a 28–32 day expiry;
  - carries the account's send clock in the same batch, so groups and 1:1 chats share
    one allowance;
  - is refused while the group has a `fence`;
  - honours the push challenge.
- **A self-update or rename Commit** goes in the current epoch's slot, create-only,
  and the same batch raises `epoch` by exactly one. The first writer wins the epoch.
- **Everything else** about membership goes through a request. Requests are counted
  (`limits/groupOps`, 100 a day, 20 when restricted), so a flood of requests cannot
  run up function invocations.

## Function

`groupAccountOp` and `groupOp` run once per request (no retries), in one transaction
each, and record `done` or `refused(reason)`. They delete the request's ciphertext
afterwards. The Admin SDK skips the rules, so they check the account (profile, ban,
deletion), the role, the epoch and slot, and the limits:
- 16 accounts per group, counting pending invitations;
- 4 devices per account and 64 per group;
- 32 groups per account and 5 new groups a day;
- 20 pending invitations per account.

Who may do what (owner's choices, 2026-11-14):
- **Invite:** any member, but only someone they have an accepted 1:1 chat with
  (checked here, one extra read). The invitee must accept.
- **Remove** (a member, or someone invited), and change roles: administrators.
  **Leave:** anyone.
- **Rename:** administrators. Clients refuse other members' renames.
- **Ending a group:** only when its last member leaves. Then every record of the
  group is deleted. Members keep their own copies of past messages.

A block in either direction refuses an invitation, with no more detail.

When the last administrator leaves, everyone remaining becomes an administrator.

## Invitations (amended 2026-11-14, after the owner's emulator test)

The first version added an account only after it accepted, and the Add needed the
inviter's phone to be open at that moment. In testing the invitee tapped Join and
nothing happened until the inviter opened the app. The owner asked that sending the
invitation does all the work.

MLS still needs a member's device to add anyone, because the server has no group
keys. So the Add moves to the moment of the invitation, when the inviter's phone is
online by definition:

| Request | Who | What the transaction does |
|---|---|---|
| `invite(uid, devices, epoch, commit, welcome, packages)` | any member's device | checks the contact, blocks and limits as before; checks the devices are the invitee's and unrevoked; consumes one key package per device; writes the Commit at the epoch slot and the Welcome; records the account in `invited`; raises `epoch`; writes `users/{uid}/groupInvites/{gid}` |
| `accept` | the invited account | moves it from `invited` to `members` and writes its `groupRefs`. No Commit, and no other phone |
| `decline` | the invited account | removes it from `invited` and adds its devices to `fence` |
| `expire(uid)` | any member, after 7 days | the same as a decline. There is no scheduler: the first member's phone to notice asks |
| `remove(uid)` | an administrator | also accepts someone invited |

- **Joining is instant.** The invitee's phone already has the Welcome. It joins from
  it and the server only moves the account into the roster.
- **What the invitee holds before accepting.** From the invitation on, the invited
  devices are MLS members, so they hold the keys for messages sent afterwards, before
  the person has accepted. The rules still refuse them every read except their own
  Welcome, so they would need the ciphertext from elsewhere to use those keys. The
  group chose to invite them; the app shows people who are invited in *Group info*,
  so nobody is surprised. The account's `groupRefs` entry records `joinedAt`, and
  the app reads and shows nothing from before it.
- **Declining stays quiet.** A decline and an expiry look the same to the group: the
  devices are fenced and a member's `finalize` Commit removes them. Nothing says
  which it was. The inviter can still see that the person is no longer listed.
- **A fence stops messages** until a member finalises, as for a leave. The first
  member's phone to open the group does that before it sends.
- **Limits.** The 16 accounts and 64 devices count people invited. 20 pending
  invitations per account, as before.
- **Key packages.** The inviter picks the invitee's devices that have a key package.
  If none has one the invitation is refused (`packages`) and nothing changes. A
  device left out, or linked later, is added by `addDevice` from one of the account's
  devices that is in the group, after the account has joined.
- **`add` is gone**, and so is `groups/{gid}/invites`: the pending invitation is the
  `invited` entry.
- **Deletion and revocation** fence an invited account's devices too.

## Fences

- **`leave`** removes the account from the roster at once, so it can no longer read,
  and adds its devices to `fence`.
- **`fenceGroupsOnDeletion`** does the same for every group when an account's profile
  turns `deleting`, whether the app's deletion or `fp-ops delete` set it, and removes
  its invitations.
- **`fenceGroupsOnDevice`** fences a revoked or deleted device's groups.

A fenced group takes no messages until a remaining member's `finalize` Commit removes
those leaves, because the server cannot advance MLS itself.

## Push

`pushOnGroupEvent` alerts the other members' group devices with the generic
*Fireplace / New Message*, as a notification and never a data push. The Android
background handler decrypts 1:1 messages only. It skips members who blocked the
sender, deleting accounts and fenced groups, and is throttled per person per group
(20 s). Nothing about the group is in the push. People who are only invited get no
message pushes.

`pushOnGroupInvite` sends **one push per invitation, to the invited account
only** (owner's choice; the members get an in-chat line instead, built on their
phones). It follows the device's existing *Show sender's name* setting, as 1:1
alerts do:

| Setting | Title | Body |
|---|---|---|
| name shown | Fireplace | You were invited by *username*. |
| name hidden | Fireplace | New Invitation |

The owner asked for the group's name as the title when names are shown. The server
cannot do that: the name is encrypted and it never has it. Showing it needs the
phone to read the Welcome in the background handler (Android) or the notification
extension (iOS), which today handle 1:1 messages only; until then the title is
*Fireplace*. The push is a notification, never a data push, and carries no group id.

## Cost

| | Writes | Reads | Functions |
|---|---|---|---|
| A message | 2 (event, send clock) | about 3 rule reads | 1 push trigger |
| A self-update | 2 | about 3 | none |
| An invitation (it adds the account) | 5 + one delete per key package (≤4) | about 13 + one per device and package (≤8) | 1 request, 1 push trigger (3 reads + the token list) |
| Joining | 4 | 3 + the account's group list | 1 request |
| Declining, or an expiry | 3 | 4 | 1 request; then a `finalize` (4 writes, 5 reads, 1 request) |
| Push per message | ≤1 throttle write per recipient | 1 + 3 per recipient | (the trigger above) |

Every function has `maxInstances: 2` and `retry: false`.

## Tests

- `firebase/tests/groups.test.ts`: 10 rules tests. Removing the send-clock, fence or
  epoch-slot check each fails one. Someone invited reads and writes nothing.
- `functions/test/groups.test.ts`: 17 emulator tests for requests and fences
  (joining with no other request, key packages running out, decline, expiry,
  removing someone invited, deletion while invited), and 4 push tests.

AI assistance: Claude Code.
