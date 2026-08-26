# Drey beta 0.14.2 Store notes

## What's new

Signing reviews now stay reliable when a site makes several approved requests
in sequence. Closing a completed review cannot interfere with the next request,
and closing an active review still rejects it immediately.

One-item transaction and message batches now use natural singular wording. This
release adds no new permissions, warnings, confirmations, or user steps.

## Reviewer focus

- Repeated connection, message, transaction, and batch requests each open the
  correct review without a blank or stale approval window.
- A one-item batch says `Sign this transaction?` or `Sign this message?`.
- Independent transaction batches still show every complete transaction in one
  review and return all signatures in order or none.
- Duplicate or conflicting inputs fail before approval, and a transaction spent
  while review is open returns no signatures.
- Drey never broadcasts a `signMultipleTransactions` result.
- Marketplace transaction templates and linked ord.net batch listings remain
  disabled unless a future release adds an explicit reviewed policy.
- No recovery words, passwords, private keys, funded wallet, or reviewer
  credential is required to inspect these changes.
