# Drey Extension 0.14.7 release evidence

Status: audited local Chrome Web Store candidate; not uploaded or submitted

Prepared: 2026-08-22

This record covers the exact production extension package prepared after the
transaction-review and password-recovery fixes. It does not claim Chrome Web
Store processing, review, publication, or a public source release.

## Source identity

- Workspace source commit/tag:
  `70005ae63b1ff74ac91806cda3493b7d8bd3f760` /
  `production-v0.14.7`
- Workspace tag object:
  `25e1bc7a8defa09d90c02864ccf2bc596fa1dabc`
- Extension source commit/tag:
  `1a2381af164496cbdac37e14c083dceb1b32a4a4` /
  `production-v0.14.7`
- Extension tag object:
  `194d7f82c829627fad623005f0a6f73db6e885c1`
- Shared Core tag/commit: `v0.17.2` /
  `fd84d9212a8221690c376071591a0473c577c286`
- Gateway source commit/tag:
  `8ad12712a4050cbddd92156a5dd97faf0156f548` /
  `production-v0.14.7`
- Gateway tag object:
  `faf5d02f4f6f70097b2aa0625217ad080a1dd492`
- Extension version: `0.14.7`

The three private annotated release tags were pushed and read back. Each peeled
to the exact revision recorded above. The public source mirrors were
intentionally left unchanged.

## Release boundary

A native transaction approval now reconciles signed status and classification
evidence once when normal tip propagation makes them arrive out of step. If the
data still does not converge, the approval fails closed. If a fee or source
change requires a replacement, Drey returns a fresh complete review, clears the
password and acknowledgements, and requires another deliberate approval. No
stale review can sign the replacement.

Leaving Send or closing an unsigned review now cancels its ephemeral plan and
releases the reserved inputs. A late replacement response is also cancelled,
while a signed, broadcast, or indeterminate result remains attached to its
recovery record.

Website approvals now report an incorrect app password inside the approval
window and permit another attempt while the same time-bounded request remains
active. Password verification is followed by a fresh authority and permission
check before signing. App-password rotation validates and writes the Spending
wallet and Community Vault owner records together.

The pending-transaction screen retains both pieces of guidance but removes the
duplicated warning-box treatment: the fee explanation is ordinary supporting
text, and the recovery-word warning is a quieter safety note after the Speed Up
action. No permission, confirmation, or user step was added.

## Validation

- Extension suite: 127 files passed, one expected live probe was skipped, and
  all 1,345 active tests passed.
- TypeScript typecheck, repository lint, frozen-lockfile install, production
  build, ZIP creation, and production package audit passed.
- The headless packaged-browser suite passed 39 cases with one expected
  headed-only toolbar check skipped. The headed suite passed all 40 cases.
- The full real-regtest suite passed all 26 serial journeys against Bitcoin Core
  31.1, ord 0.27.1, Fulcrum 2.1.1, and the real gateway. It included the exact
  two-recipient high-fee approval and abandoned-review input-release cases.
- Gateway validation passed all 444 tests plus typecheck and lint. One preview
  timing case failed once under aggregate load, then passed in isolation, in a
  complete serial gateway run, and in the repeated aggregate gate; no product
  or test assertion was changed.
- M9, M9P, and M9X release gates passed, including transaction recovery,
  preview isolation, native Ordinals transfer, rapid navigation, package
  auditing, and artifact privacy checks.
- Marketplace validation passed all 16 Core contract tests, three pinned
  fixture subsets, and the compile-time activation audit.
- The E2E artifact privacy audit passed after every browser and regtest run.
- A 24-sample live production-gateway probe remained connected with fresh
  wallet data, spending ready, active classification, and no readiness reason.

The disposable regtest services were stopped after validation. No production or
reused wallet material was used.

## Exact production artifact

- Filename: `.output/production/drey-extension-0.14.7-chrome.zip`
- Size: `1,527,068` bytes
- Entries: 66
- SHA-256:
  `09f5c2dbcd8cdd839023ab8d05fc3e29a1b8cad4095f21390fc654b9c538d68c`
- Normalized content digest:
  `d1fbc07981ddddb9f38268aafaad4f7a8e2c90b2ca5e299bbbc84fb4cc9fc4cf`
- Provenance sidecar SHA-256:
  `b0f1c49594f14cb64d87c50f96d5cddc77045da072f3696add2588da427158a4`
- Manifest SHA-256:
  `46e7ce8c12de8b33d4e830802cec64e165c7528e8967839e92bbbe45e58cb870`
- ZIP integrity and production audit: passed.

The audit reopened all 66 entries and verified the exact 20-method provider
surface. The manifest identifies Chrome extension
`kngidlmmbfmnoeimngkajdlbdenlhgof`, version `0.14.7`, with permissions limited
to `storage`, `alarms`, `idle`, and `sidePanel`, and only
`https://wallet-api.squirrelsystems.net/*` as a host permission. The package is
bound to Bitcoin mainnet and the reviewed production gateway identity.

## Remaining Store actions

- Upload only the exact ZIP checksum above after confirming the Chrome Web
  Store item, release notes, permissions, rollout, and rollback candidate.
- Read back the Store-processed artifact identity before treating the local ZIP
  as the Store artifact.
- Verify the processed version, extension ID, permissions, signing identity,
  and clean-profile behavior before publication is considered complete.
