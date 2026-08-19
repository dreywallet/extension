# Drey extension 0.12.0 Store notes

## What's new

Drey now supports Community Vaults for OMB Group Buys. Each owner keeps a
separate recovery key, can approve every unit they own in one review, and sees
the exact purchase or funded sale before signing. Drey and the OMB Gallery
cannot spend or recover the shared OMB.

The guided OMB Gallery handoff now opens the matching campaign directly in
Drey. A manual public-package fallback remains available.

## Reviewer focus

- Open **Settings → Community Vault** to inspect the campaign-key setup and
  recovery-verification flow.
- The OMB Gallery can open Drey with the campaign and owner identifiers already
  filled. No private key or recovery word is sent to the website.
- Drey exposes only public enrollment details to the gallery after recovery is
  verified.
- Acquisition and sale approval screens show the exact OMB, amounts, owner
  share, outputs, network fee, expiry, and policy before signing.
- One owner approval signs only that owner's assigned units. The gallery and
  Drey have no additional Community Vault key.
- Existing personal Drey Vaults and ordinary BTC and inscription sends are
  unchanged.
- No recovery words, passwords, private keys, funded wallet, or reviewer
  credential is required to inspect these changes.
