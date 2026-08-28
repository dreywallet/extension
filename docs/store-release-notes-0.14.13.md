# Drey 0.14.13 Store notes

Website transaction approvals are now clearer and more compatible. Ordinary
requests stay compact. When a site can still change inputs, outputs, or fees,
Drey shows a short summary up front and keeps technical details available on
demand.

This release also supports more safe marketplace and multi-transaction signing
flows while preserving strict wallet ownership, protected-asset, fee, and
final-transaction checks.

## Release check

- Confirm the extension identifies itself as version 0.14.13.
- Confirm ordinary approvals remain compact and flexible approvals show a
  concise “What the site can still change” section.
- Confirm blocked requests have no Sign action.
