# Drey 0.15.8 Store notes

## What's new

Drey beta 0.15.8 improves coin control and transaction clarity. See the
holding address and spendable value of each coin, select specific coins to
send, and see returning payment change while a transaction is pending.

Imported Xverse wallets now identify compatible older Bitcoin funds as
recovery-only instead of presenting them as spendable. Transaction identifiers
and coin details are also clearer across screen sizes.

This update adds no browser permissions.

## Release check

- Confirm the extension identifies itself as version 0.15.8.
- Confirm one or more eligible selected coins can flow directly into Send.
- Confirm pending payment change remains visible while its transaction is
  unconfirmed.
- Confirm imported nested-SegWit recovery coins are labeled Recovered and
  cannot be selected for an unsupported spend.
- Confirm the transaction fingerprint is described as an identifier rather
  than unsigned transaction data.
