# 0027: Starting fresh waits; device requests are proven

Date: 2026-11-15. Status: proposed for review. App side: mobile decision 0063.

## Problem

Everything an account owns was writable by any session signed in to it. A
session that has only the password (no device keys) could delete the account's
device records and publish a new identity ("start fresh"), or mark the
person's phone removed. The rules could not tell such a session from a device.

## Decision

1. **Starting fresh waits.** `users/{uid}/private/startFresh` records a start:
   `startedAt` (the server's time), `waitDays` (must equal the account's wait)
   and `session` (the asker's sign-in time). Device records and the recovery
   backup can be deleted only when a start exists and
   `startedAt + waitDays` has passed, or when the account is being deleted.
2. **The wait** is `users/{uid}/private/security.waitDays`: 1, 3, 7, 14 or 30;
   3 when absent. A client may create it only while the profile is under ten
   minutes old (sign-up). Later only the function writes it.
3. **Device requests.** `users/{uid}/accountOps/{id}` with `kind` in `setWait`,
   `stop`, `removeDevice`, `resetNow`, and a `proof`. The function
   `accountDeviceOp` checks the proof and acts; clients cannot write the
   outcome. A device's `revokedAt` is no longer client-writable.
4. **Stopping needs the password again.** The rules accept a `stop` request
   only when `request.auth.token.auth_time` is within five minutes.
5. **Withdrawing.** Only the sign-in that asked (`session == auth_time`) may
   delete a waiting start. A phone that was signed in before cannot cancel it.

## The proof

`HMAC-SHA-256(key, lp("fireplace/v1/device-proof", uid, device, opId, kind, args...))`
with `key = HKDF-SHA-256(X25519(deviceKey, serverKey), salt = empty,
info = lp(label, devicePub, serverPub))`. The device uses its long-term X25519
secret and the server's public key; the function uses the server's secret and
the device's published `x25519Pub`. An all-zero shared secret is refused. The
device must exist and not be removed. The request id is part of the message, so
a proof is good for one request.

The server's key is made by the function on first use. The secret half is in
`private/deviceProof` (no client can read `private/**`); the public half is
`config/deviceProof`, readable by signed-in accounts.

A proof shows possession of a device key the account's identity certified. It
is not a signature and is checkable only by the server; that is enough, because
the server is the one deciding.

## What a password-only session can still do

Sign in; ask to start fresh and wait; withdraw its own asking; delete the
account (unchanged, and outside this decision); delete prekeys (sessions fall
back to the signed prekey). It can no longer remove a device, change the wait,
stop a start, delete the devices or the backup before the wait is over.

## Deploying

The rules refuse what older app versions do directly: marking a device removed
and deleting devices for a reset. Deploy together with the app version that
uses these requests, and require that version.

The app tells the two servers apart by reading its own
`private/security`: these rules allow the read (the record may be absent), the
older rules refuse it. Against the older rules the app does what it did
before, so the app can ship first. The first device request finds no
`config/deviceProof`, sends a `key` request (no proof, changes nothing), and
the function makes the key.

## Cost

One function run per device request (rare: a setting change, a removal, a
stop). One extra document read in the rules when a device or the backup is
deleted, and when a start is created.

## Tests

Rules (`firebase/tests/rules.test.ts`): deleting devices and the backup with no
start, a waiting start, and one over its wait; the shape of a start, the wait
it must carry, and who may withdraw it; choosing the wait only at sign-up;
device requests, and `stop` only from a fresh sign-in; the server key.
Function (`functions/test/account-ops.test.ts`): a known answer shared with the
app's implementation; each request with a valid proof, a forged one, another
device's, a removed device's; the key is made once.

To verify on a real project before relying on it: that production ID tokens
carry `auth_time` in `request.auth.token` as the emulator's do.
