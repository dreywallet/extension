# Drey beta 0.13.1 Store notes

## What's new

This beta update adds complete-position transfer reviews for supported
Community Vault flows. The current owner and buyer each see the exact units,
payment, new owner keys, replacement Vault, and network fee before signing.
Drey signs only the approved inputs and does not broadcast Community Vault
approvals.

Pending Bitcoin transaction speed-ups are clearer and more reliable. Drey now
checks fresh signed history before offering RBF, keeps the recipient and amount
fixed, shows the replacement fee before signing, and stops offering another
speed-up once a replacement is accepted.

## Reviewer focus

- Open a replaceable pending Bitcoin transaction from **Activity**, choose
  **Speed up transaction**, and review the unchanged recipient and amount plus
  the new network fee.
- The original transaction is labeled **Replaced** after its accepted
  replacement appears in signed wallet history.
- Supported Community Vault position transfers show separate buyer and current
  owner reviews. Each review displays the complete position and fixed transfer
  terms before signing.
- Community Vault approvals never broadcast from the approval window. The
  connected flow receives only the signed transaction data required for its
  next step.
- No recovery words, passwords, private keys, funded wallet, or reviewer
  credential is required to inspect these changes.
