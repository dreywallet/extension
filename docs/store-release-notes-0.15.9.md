# Drey 0.15.9 Store notes

## What's new

Drey beta 0.15.9 keeps your Runes visible while a transaction is pending.
Previously, any unconfirmed transaction in the wallet could make every Rune
balance show as unavailable until it confirmed. Confirmed Runes now stay
visible and can be sent, and Drey explains when unconfirmed transactions may
hold Runes that will appear after confirmation.

This update adds no browser permissions.

## Release check

- Confirm the extension identifies itself as version 0.15.9.
- With an unconfirmed transaction in the wallet, confirm confirmed Rune
  balances stay visible and the unconfirmed-transactions note appears.
- Confirm Bitcoin available for Rune fees excludes unconfirmed change.
- Confirm Rune activity no longer says sending is unsupported.
