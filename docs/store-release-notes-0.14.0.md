# Drey beta 0.14.0 Store notes

## What's new

This beta adds independent batch signing for sites that use the official Sats
Connect multiple-transaction request. Drey checks every transaction before one
approval, keeps the original order, and returns either the complete signed batch
or no results.

Batch approval shows the transaction count, total wallet exposure when it can be
meaningfully combined, and a complete review for every transaction. Duplicate,
conflicting, linked, or stale requests are rejected. Existing single-transaction
signing is unchanged.

## Reviewer focus

- A supported independent batch opens one approval with a transaction selector
  and complete details for each transaction.
- Cancelling or closing the approval returns no signed results.
- Locking the wallet or changing the active account, network, or connection
  invalidates the entire request.
- Linked transaction chains remain unsupported, including requests where one
  transaction spends an output created by another transaction in the batch.
- The existing ord.net single-inscription listing ceremony remains available;
  linked ord.net batch listings are not enabled.
- No recovery words, passwords, private keys, funded wallet, or reviewer
  credential is required to inspect these changes.
