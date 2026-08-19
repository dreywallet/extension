# Drey extension 0.11.0 Store notes

## What's new

Drey beta now supports the reviewed OMB Wiki buyer flow. Connecting to a site
guides you to unlock first, and long message approvals remain readable before
you decide whether to continue.

Vault PSBT QR handoffs now use the device-compatible `crypto-psbt` format. The
transaction and approval checks are unchanged.

## Reviewer focus

- Confirm that connecting while locked opens the normal unlock flow before any
  site permission is granted.
- Confirm that long message approvals wrap without hiding content or approval
  controls.
- Confirm that only the exact compiled OMB Wiki origin and buyer contract receive
  named compatibility; unknown or changed flexible requests fail closed.
- No recovery words, passwords, private keys, funded wallet, or reviewer
  credential is required to review these changes.
