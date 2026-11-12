# 0014: Spam reports hold account ids only

Date: 2026-11-11. Status: requested by the owner. Supersedes PR #5 (decision
0012 there), which closed reports entirely before the app shipped Report Spam.

## Decision

`reports/{reporter}_{reported}` accepts exactly what the app's Report Spam
writes (app decision 0024): `reporter`, `reported`, `reason: 'spam'` and
`createdAt` (server time). No `note`, `context` or `chatId`, so a client cannot
upload message text into a report. Reporting the same person again replaces the
time. Clients cannot read reports, not even their own; a moderator login may
read them, as in [0011](0011-moderator-dashboard.md), and now they hold only ids.
Nobody can delete them from a client.

## Why

Production ran the #5 rules, which refuse every report, so the app's Report
Spam failed ("Could not send the spam report"). The earlier rules on `main`
accepted free text in `note` and `context`.

## Tests

Rules tests: the app's report is accepted and can be repeated; `note`,
`context` and `chatId` are refused on create and update; other reasons are
refused; the moderator reads a report without any text field.
Implementation assisted by Claude Code.
