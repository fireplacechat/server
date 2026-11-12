# What the Blaze plan and push cost

Updated 2026-11-11: the project is on **Blaze** (pay-as-you-go). The original
analysis was written on 2026-10-03, when the project was on Spark. **Prices
change; check the pages linked at the bottom.** Figures are estimates for Cloud
Firestore in **nam5 (US multi-region)**: about **$0.06 per 100,000 reads and
$0.18 per 100,000 writes**.

## The one fact that matters
- The free daily allowances still apply (50,000 reads, 20,000 writes, 20,000
  deletes). Past them, **everything is billed with no hard ceiling**.
- Budget *alerts* only send email; they do not stop spending.
- Firebase *spend caps* cover Cloud Functions, but **not Cloud Firestore**,
  which is where Fireplace's real cost would come from.

## Per message, with push
About **14 Firestore reads, 3 writes and 1 function call**:
- 3 reads for the security rules;
- the sender's and recipient's listeners;
- about 6 reads in `pushOnMessage`: chat, block, two profiles, tokens and the
  throttle record;
- 1 throttle write when an alert is sent.

FCM itself is free. Functions include 2 million calls, 400,000 GB-seconds and
200,000 vCPU-seconds a month for free, then about $0.40 per million calls.
`pushOnMessage` is small: 256 MiB, 20 s timeout, at most 2 instances, no
retries.

## Spam filter

`reviewOnReport` (decision 0018) runs once per spam report: one call, a few
reads and two or three writes. Reports are rare, so it stays inside the free
allowances; it is capped at 2 instances with no retries.

## Realistic usage
- **Friends and family:** 20 people × 100 messages a day = 2,000 messages
  ≈ 28,000 reads and 6,000 writes a day. **$0.**
- **Growth:** 200 people × 100 messages a day = 20,000 messages
  ≈ 280,000 reads and 60,000 writes a day ≈ $0.21/day ≈ **$6–7 a month**.

## The risk: abuse or a bug
The rules limit each account to 20 messages per 10 seconds and 2,000 a day
(decision 0015), sign-up needs an invite, and banned accounts are refused. A
cooperating pair of invitees on the current app can write about 4,000
messages a day between them ≈ 56,000 reads ≈ 3 cents a day; `fp-ops limited`
lists accounts at the cap. (An account that only uses the older send-clock
form has no daily cap yet: about 2 messages a second, ≈ $3–4 a day for a
pair, until that form is removed.) A bug in the
app, such as a retry loop or a listener that re-subscribes, could cost money
the same way.

## Guard rails to set now (owner)
1. **Budget alerts** in Google Cloud Billing at low amounts (for example $1,
   $5 and $20), sent to more than one address.
2. The function's own limits are already in code: `maxInstances: 2`, no
   retries.
3. **App Check enforcement** once monitoring shows real traffic passes (see
   the app's decision 0017). That stops scripts that are not the app.
4. Watch Firestore usage in the console during the first weeks.

## Sources
- Firebase spend caps: https://firebase.google.com/docs/projects/billing/spend-caps
- Firestore billing: https://firebase.google.com/docs/firestore/pricing
- Cloud Functions pricing: https://cloud.google.com/functions/pricing
- Budgets and alerts: https://cloud.google.com/billing/docs/how-to/budgets
