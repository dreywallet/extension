# Drey extension 0.11.1 Store notes

## What's new

Drey now previews AVIF inscriptions, including BTC Slugs, as safe static images
in the Ordinals gallery and transaction review. Preview loading and failure
states use the existing gallery experience.

## Reviewer focus

- Confirm that AVIF-backed inscriptions appear as static previews in the
  Ordinals gallery and transaction review.
- Confirm that a missing or failed preview leaves the inscription visible and
  does not weaken transaction checks.
- AVIF source bytes are converted by the gateway; the extension receives only
  a signed, verified PNG and never executes inscription content.
- No recovery words, passwords, private keys, funded wallet, or reviewer
  credential is required to review these changes.
