# Drey 0.14.16 Store notes

This update expands compatibility with Bitcoin marketplaces that request more
than one related PSBT. Drey can now review and sign linked listing/recovery
transactions and mutually exclusive offers that share funding, while returning
every requested signature together or none.

The approval keeps the important information up front: the signature rules,
maximum amount that can leave the wallet, maximum network-fee exposure, and
whether transaction options share the same funds. Technical details stay
collapsed by default, and raw PSBT bytes are never shown.

## Release check

- Confirm the extension identifies itself as version 0.14.16.
- Confirm standard, flexible, linked, shared-funding, and zero-fee requests use
  a clear single approval with visible signature rules.
- Confirm linked and shared-funding requests return all signatures or none.
- Confirm rejection, stale wallet state, invalid sighashes, changed transaction
  IDs, and unsafe or ambiguous graphs fail before any result is returned.
- Confirm action buttons remain visible at narrow and wide approval widths.
