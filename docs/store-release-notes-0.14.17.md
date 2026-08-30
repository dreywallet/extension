# Drey 0.14.17 Store notes

This update strengthens transaction and vault safety checks while keeping the
wallet's existing screens and approval flow unchanged. It improves validation
of fees, destinations, signatures, transaction inputs, signed data freshness,
and marketplace previews.

The update also makes address scanning and fragmented-input fee selection more
reliable, and prevents simultaneous website-permission changes from overwriting
one another. It adds no permissions, warnings, confirmations, or user steps.

## Release check

- Confirm the extension identifies itself as version 0.14.17.
- Confirm ordinary payments and vault transactions retain their existing review
  and approval flow.
- Confirm marketplace previews and transaction groups display normally.
- Confirm invalid signatures, duplicate inputs, excessive fees, stale data, and
  changed destinations fail before signing.
