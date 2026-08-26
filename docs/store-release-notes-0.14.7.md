# Drey 0.14.7 Store notes

## What's new

Transaction review now recovers cleanly when network data updates during an
approval. Leaving an unsigned review also releases its reserved bitcoin right
away, and incorrect app-password feedback can be corrected without restarting
a website request.

App-password changes are more resilient, including for wallets using Community
Vault. Pending-transaction guidance is clearer and less visually repetitive.

This release adds no new permissions or user steps.

## Reviewer focus

- A refreshed transaction is shown for a new review and is never signed from
  the stale review.
- A second inconsistent refresh fails closed instead of looping.
- Leaving Send releases an unsigned transaction plan without affecting a
  signing or broadcast already in progress.
- Incorrect passwords remain rejected and can be retried only within the same
  still-valid website request.
- Existing send, receive, activity, Ordinals, provider, and batch flows remain
  unchanged.
