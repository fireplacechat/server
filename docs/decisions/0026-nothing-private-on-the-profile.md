# 0026: Nothing private on the public profile

Status: accepted by the owner (2026-11-15, "absolutely must-fix"). Companion
mobile decision 0055.

## The problem

`users/{uid}` is readable by every signed-in account that has a profile: names
and colours are read from it. The same document carried two things that are not
for other people:

- `lastActiveAt`: when the account was last in use, refreshed at most every 12
  hours, for the 13-month inactivity deletion. Any account that knew another's id
  could read it: a "last seen", which the app's own rules forbid.
- `invite`: the hash of the invite the account joined with.

## What changes

- **`lastActiveAt` is no longer written anywhere.** The rules refuse it on a
  profile. One left from before may stay untouched or be removed, never set.
- **`invite` is needed only while the account is created** (the rules use it to
  find the invite and check it was claimed in the same batch). After that it may
  be removed, never changed; the app removes it.
- **Inactivity is judged from the sign-in account's own times**: last sign-in and
  last token refresh, which an app in use renews about hourly, and which only the
  server can read. The inactivity tool already used these; it now relies on them.
  It still reads a stamp where a profile has one, so nothing is judged staler
  than before.
- **`fp-ops tidy-profiles`** removes both fields from every existing profile.
  Safe to run again.

## Older app versions

An older app still tries to write the stamp. The write is refused and the app
ignores the refusal, as it always did for this write. It leaves its invite hash
on the profile until it updates, or until the next `tidy-profiles`.

## Order of deployment

Run `tidy-profiles`, deploy the rules, run `tidy-profiles` again (an older app
may have written a stamp in between).

## Cost

One write fewer per account every 13 hours. No function, no new document.

## Tests

`firebase/tests/rules.test.ts`: "the public profile holds no activity stamp".
`tools/operator/test/ops.test.ts`: "tidy-profiles".
