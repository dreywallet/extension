# Drey beta 0.14.1 Store notes

## What's new

Sites can now request payment and Ordinals address proofs together through the
official Sats Connect multiple-message method. Drey shows every message and
address in one review, then returns all signatures in the original order or no
results.

The review uses plain language, requires no extra password or typed phrase, and
makes hidden text formatting visible without adding another confirmation step.
Existing single-message and transaction signing are unchanged.

## Reviewer focus

- A two-message address-proof request opens one approval and shows both complete
  messages before the signing action.
- Rejecting or closing the approval returns no signatures.
- Locking the wallet or changing the active account, network, connection, or
  browser authority invalidates the complete request.
- Message batches cannot spend bitcoin and never broadcast a transaction.
- Marketplace transaction templates and linked ord.net batch listings remain
  disabled unless a future release adds an explicit reviewed policy.
- No recovery words, passwords, private keys, funded wallet, or reviewer
  credential is required to inspect these changes.
