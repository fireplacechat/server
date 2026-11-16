# 0024: A chat colour on the profile

Status: accepted by the owner. Companion mobile decision 0053.

Each person chooses one chat colour in the app. Until now it travelled inside
their encrypted 1:1 messages, so the server never saw it, and it showed only
after they had sent a message. The owner decided that the colour is public, like
the username, so that a chat shows it from the moment it is accepted.

## What changes

- `users/{uid}` may carry `color`: a string of 1 to 24 lower-case letters (a
  colour's name; the app has five). It is optional.
- Only the account itself can write it, in an update, under the conditions that
  already apply to its profile (not while deleting). It is not part of sign-up.
- **Rate limit.** A change of colour must also set `colorAt` to the server time,
  and is refused within 5 seconds of the last one. The app saves a colour only
  after it has been held for 10 seconds, so trying several sends one write. A
  modified app is held to one change every 5 seconds; refused writes are not
  stored.
- It is read as the profile is: by the owner and by any signed-in account that
  has a profile.
- Nothing else changes: no function, no index, no new document.

## Cost

One profile write for each colour change, and one for each account the first time
it opens the version that publishes it. The app reads the colour in the profile
read it already makes for the username, plus at most one read when a chat is
opened (none within 15 minutes of the last).

## Privacy

The server now stores each account's colour in clear. It is one of five names
and says nothing about who the account talks to. Account deletion removes it
with the profile.

## Tests

`firebase/tests/rules.test.ts`: "profile colour".
