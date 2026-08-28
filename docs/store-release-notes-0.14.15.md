# Drey 0.14.15 Store notes

This update improves compatibility with Bitcoin marketplaces that use current
or callback-based PSBT signing. Drey now accepts the single-transaction
callback and the current PSBT request alias while keeping one consistent
review and signing flow.

Requested signing inputs and sighashes are checked against the transaction
before approval. The review continues to show what the signature commits to,
with no added confirmation step for valid requests.

## Release check

- Confirm the extension identifies itself as version 0.14.15.
- Confirm supported marketplace requests reach the normal transaction review.
- Confirm the effective sighash and committed outputs are clear in Advanced
  details.
- Confirm invalid or conflicting signing declarations fail before approval.
- Confirm rejection returns to the marketplace without a partial result.
