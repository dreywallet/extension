# Drey Extension 0.14.2 release evidence

Status: audited local Chrome Web Store candidate; not uploaded or submitted

Prepared: 2026-08-22

This record covers the exact production extension package prepared for reliable
sequential provider approvals and expanded real-regtest coverage of independent
PSBT batches. It does not claim Chrome Web Store processing, review,
publication, or any public source release.

## Source identity

- Workspace source commit/tag:
  `70005ae63b1ff74ac91806cda3493b7d8bd3f760` /
  `production-v0.14.2`
- Extension source commit/tag:
  `e27db4d3e9fd072950307b798e33e1d21ebfe463` /
  `production-v0.14.2`
- Shared Core tag/commit: `v0.17.1` /
  `ba679e04aee463ae6026d0b457ce271bba8cc317`
- Gateway source commit/tag:
  `49a80586731276ff3bbb8971744f03d0c5371d87` /
  `production-v0.11.2`
- Extension version: `0.14.2`

The private workspace and extension tags were pushed and read back as annotated
tag objects whose peeled commits match the revisions above. The public source
mirrors were intentionally left unchanged.

## Feature boundary

The approval lifecycle now distinguishes a temporary page-port reconnect from a
real popup close while retaining exact window, tab, request, origin, account,
network, vault-session, and approval-generation binding. A completed approval
cannot invalidate the next queued request. A real close still rejects
immediately, and no detached or differently bound page can become approval
authority.

One-item message and transaction batches now use singular wording. The release
adds no permission, warning, confirmation, or user step. Existing single-item
signing and the official Sats Connect independent-batch result contract remain
unchanged.

The regtest harness now creates real independent P2WPKH PSBTs through Bitcoin
Core and verifies Drey's signed results through independent parsing, Core
finalization, and mempool preflight. It proves one complete two-transaction
review, exact ordered results, no wallet broadcast, pre-approval duplicate and
conflicting-input rejection, and no result when an input is spent while review
is open. Linked or prospective transaction graphs and linked ord.net batch
listings remain disabled.

## User experience review

The transaction batch review was exercised in an actual 420 by 680 extension
popup. It showed the transaction count, aggregate payment and fee exposure, and
both complete per-transaction reviews without horizontal overflow or clipped
buttons. The headed browser suite also exercised real toolbar sizing, compact
popup layout, focus behavior, and sequential provider approvals.

No additional warning screen or confirmation was introduced. A one-item batch
now reads `Sign this transaction?` or `Sign this message?`, with the existing
signing action immediately available under the same policy requirements.

## Validation

- Exact-tag extension suite: 127 files passed and one expected live probe was
  skipped; 1,328 tests passed.
- Exact-tag typecheck, lint, frozen-lockfile install, production build, and
  approval/gallery isolation check passed.
- Full real-regtest suite: 24 of 24 serial browser journeys passed, including
  payment, RBF, recovery, reorg, Ordinals, and the three new provider-batch
  cases. The final provider-batch-only run passed 3 of 3.
- Headless packaged-browser acceptance passed 39 cases with the one headed-only
  toolbar check skipped. Headed acceptance passed all 40 cases.
- Every E2E run completed with a passing artifact privacy audit.
- Gateway validation passed all 441 tests plus typecheck and lint.
- All 16 marketplace contract tests, three pinned marketplace fixture subsets,
  and the compile-time activation audit passed.
- M9P and M9X focused unit, Core, package, browser, and artifact-privacy gates
  passed.
- Branding, instruction parity, and all six repository whitespace checks
  passed.

No production or reused wallet material was used. Regtest broadcasts were
local, test-controlled, independently checked, and confined to disposable
funds. The local regtest containers were removed after validation.

## Local `next` track

- Unpacked path: `.output/next/chrome-mv3`
- Version: `0.14.2`
- The `next` and production unpacked trees and channel metadata compared
  byte-for-byte equal.
- Approval/gallery isolation passed. `next` remains an unpacked local testing
  track and is not represented as a Store package.

## Exact production artifact

- Filename: `.output/production/drey-extension-0.14.2-chrome.zip`
- Size: `1,525,994` bytes
- Entries: 66
- SHA-256:
  `23f65e8e8cede50549a67bd90f685dd36002de4fc8cb59aaa00bbe232747a7e2`
- Normalized content digest:
  `9eebd42899e9082d2879f8255f995fca9da2e260613bc060dbefe586f5bebc7c`
- Provenance sidecar SHA-256:
  `e66a4d48ab86ed050c3b7ef3e09baea554e448f080d606fb34a57c2b1ea6aa40`
- Manifest SHA-256:
  `f118084489fd38e2f811b8322bc81cc58a07ab4cb6cd222489caa1873f6364eb`
- ZIP integrity: passed with no compressed-data errors.

The production audit reopened all 66 entries and verified the exact 20-method
provider surface. The manifest identifies Chrome extension
`kngidlmmbfmnoeimngkajdlbdenlhgof`, version `0.14.2`, with permissions limited
to `storage`, `alarms`, `idle`, and `sidePanel`, and only
`https://wallet-api.squirrelsystems.net/*` as a host permission. The package
targets Bitcoin mainnet and the reviewed production gateway identity.

## Remaining Store actions

- Upload only the exact ZIP checksum above after confirming the Store item,
  release notes, permissions, rollout, and rollback candidate.
- Read back the Store-processed artifact identity before treating the local ZIP
  as the Store artifact.
- Verify the processed version, extension ID, permissions, signing identity, and
  clean-profile behavior before publication is considered complete.
