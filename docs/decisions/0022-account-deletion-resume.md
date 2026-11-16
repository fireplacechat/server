# 0022: Resume client account deletion after partial cleanup

Status: proposed; owner deploys rules. Companion mobile decision 0048.

The client incorrectly listed rate-limit documents. Listing counters remains
forbidden: the fixed client deletes `send`, `chats`, `claims` and the named
challenge proof explicitly, so no pacing bypass is added. It now scopes local
erasure to the confirmed account and signs out explicitly after Auth deletion.

An earlier client can remove its profile before a later step fails. Let that
owner read/list their own device and prekey paths to finish erasure without a
profile. Allow a synthetic-email owner to get their matching username record
or its absence, only if no other UID owns it. Reads of other usernames/devices
still require a valid profile. No new write or collection-list permission.

After an account is fenced as deleting, deny incoming ciphertext reads even
with a still-valid cached ID token. Retain sender-filtered reads of its own
remaining sent records, which the cleanup must enumerate and delete. Normal
active participants retain their existing access; ban semantics are unchanged.

The emulator test walks cleanup after the profile is gone, covers fixed
counter/proof deletion and repeat reads after a lost acknowledgement, and
asserts sibling-account data/access and stale-token denial. The full existing
rules suite must pass. No wire changes, crypto changes, new function/service,
background job or recurring cost. Additional profile/ownership checks use
existing documents and normal rule-read caching.

Deploy only reviewed `firestore:rules`. Do not deploy functions or run an
operator deletion of existing users as part of this source change. Phone-side
keys/settings/history require the corrected app; server cleanup cannot erase
an iPhone's local keychain/files remotely.
