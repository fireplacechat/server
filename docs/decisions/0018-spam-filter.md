# 0018: A spam filter that restricts and queues, but does not ban

Date: 2026-11-12. Status: requested by the owner (issue #9). The hook is
public. The filter's rules are kept private.

## What it does

`reviewOnReport` runs when a report is written (`reports/{reporter}_{reported}`,
created or renewed). It counts the different people who reported the account
in the last 7 days and looks at the account's age, then:

- **queues** the account for review (`reviewQueue/{uid}`, with its reasons), on
  any report;
- **restricts** it for a while when several different people reported it, or
  fewer if the account is new. A longer restriction already set is kept.

It never bans; a person does, with `fp-ops ban`. The server code is only the
hook: `spam-filter.js` gathers what the filter may look
at, asks the policy, and applies its decision (and refuses anything but a
review, a time-limited restriction, or a challenge (0020)). The policy that decides,
`functions/lib/spam-policy.js`, stays private; the public code carries
`spam-policy.example.js`, a stand-in with the same shape and no threshold.

## What it looks at

Only metadata the server already holds: who reported whom, when, and the
account's creation time. Never message content, which the server does not have.
Reports hold account ids only (0014).

## What a restriction does

The custom claim `restrictedUntil` (milliseconds) on the account's sign-in. The
rules read it from the ID token, so it costs no reads, and lower the account's
daily caps while it lasts: 200 messages instead of 2,000, 5 new chats instead of
50, 20 prekey claims instead of 200. The account keeps working; the app's usual
refusal wording applies. Like a ban, it takes effect when the ID token next
refreshes, within the hour.

## Operator

- `fp-ops review`: the queue, with reasons and any running restriction.
- `fp-ops restrict <@name> --reason "..." [--days 7] --yes` and
  `fp-ops unrestrict <@name> --yes`.
- `fp-ops ban` now also clears the account's queue entry.
- **Fixed:** `ban` and `unban` replaced all custom claims, so they would have
  erased a restriction or any other claim. They merge now, as `restrict` does.

The moderator login can read the queue (rules); nobody else can, and only the
server writes it.

## Cost

Reports are rare. Each one costs one function call, a read per report about the
account, one profile read, an Auth lookup, and two writes (queue entry and
moderation log), plus a claims update when it restricts. All inside the free
allowances. The function is capped at 2 instances with no retries, and has no
minimum instance.

## Not yet

- Daily-cap hits (`fp-ops limited`) and unanswered message requests are not
  inputs yet: they change with every message, and a trigger on them would run
  per message. A scheduled run would suit them; it needs Cloud Scheduler, which
  is a new service for the owner to approve.
- Challenges are decision 0020. The private policy does not ask for one yet.

## Tests

Six function tests of the hook with stand-in policies (what the policy is asked,
a restriction applied, a longer one kept, no ban or open-ended restriction
whatever the policy says, deleted or malformed reports, the stand-in's shape),
four private tests of the deployed policy, and two further hook tests for a
challenge (0020). Three rules tests cover restricted caps for messages and new
chats, and the queue's access. Two operator tests cover restrict and
unrestrict keeping other claims, and ban and unban merging claims and clearing
the queue.

AI assistance: Claude Code.
