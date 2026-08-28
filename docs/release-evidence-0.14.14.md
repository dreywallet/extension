# Drey Extension 0.14.14 release evidence

Status: audited local Chrome Web Store candidate; ready for upload, not uploaded
or submitted

Prepared: 2026-08-27

## Source identity

- Extension source commit/tag:
  `7bde46d54c88e0846451f7eaa3eed71eb03b61e9` /
  `production-v0.14.14`
- Private annotated tag object:
  `30431bbb0644f3b242b08b676d94936611291ef3`
- Shared Core tag/commit: `v0.18.0` /
  `f684662079528941459f6496c6916c3ad6402b04`
- Gateway tag/commit: `production-v0.14.8` /
  `111f042ba124dce6feed5799eaf2f348bd31e22d`
- Extension version: `0.14.14`

The private source commit and annotated tag were pushed and read back from the
remote. The production package was built from the exact clean tagged extension
source and the existing tagged workspace and gateway policy inputs. The public
source mirrors were left unchanged.

## Validation

- The extension suite passed all 1,360 active tests across 128 files, with only
  the expected live-gateway probe skipped; typecheck and lint passed.
- The gateway suite passed all 444 tests; its typecheck and lint passed.
- The headed packaged-browser suite passed 41 journeys. It covered toolbar
  sizing, 320 px, 392 px, and 520 px responsive surfaces, horizontal-overflow
  checks, wallet creation and restore, provider approvals, passkeys, previews,
  recovery, restart handling, and privacy-safe secret-visible states.
- The isolated real-regtest smoke suite passed all eight serial journeys against
  Bitcoin Core, ord, Fulcrum, and the loopback gateway. It covered create,
  fund, spend, confirm, high-fee review, abandoned unsigned review, incoming
  payments, multi-input selection, RBF, BIP-321, and shallow-reorg recovery.
- M8T, M9, M9P, and M9X passed, including pinned marketplace fixtures, 16 Core
  marketplace-contract tests, exact-origin policy auditing, signed preview
  isolation, native Ordinals review, and launch-UX checks.
- Production and `next` unpacked trees and their channel metadata compared
  byte-for-byte equal. Every browser and regtest artifact privacy audit passed.
  The isolated regtest services were stopped after validation.

Two repeated aggregate runs surfaced timing-only diagnostics: one gateway
loopback test reached its 5 s harness timeout, and one gallery stability sample
observed a 2 px font-settling difference. Each passed immediately in isolation,
the full gateway suite passed afterward, and clean complete M9, M9P, and M9X
runs passed without changing production code or assertions.

## Exact artifact

- Filename: `.output/production/drey-extension-0.14.14-chrome.zip`
- Size: `1,535,934` bytes
- Entries: 66
- SHA-256:
  `77c7ff023801abcb2f624a02c308b8a6370bbe0ffe4101a9f5546eb7c0f5073d`
- Normalized content digest:
  `7f7dffcd1515c13797db2c8cd8322055740747bdea9a3fa3291f3ba91fa1fde3`
- Provenance sidecar SHA-256:
  `4ff24de4fa21cb21094ed225095460730b066e7080b5ed8abd44e8998ab71435`
- Manifest SHA-256:
  `66df6066e4f33214124bbc655e324bb8cdda229f19fd8407a03d283250329920`
- Extension ID: `kngidlmmbfmnoeimngkajdlbdenlhgof`
- Manifest version: MV3
- Permissions: `storage`, `alarms`, `idle`, `sidePanel` (unchanged)

The production audit reopened all 66 files and verified the exact 20-method
provider surface, Store identity, source and provenance binding, content
security policies, recovery isolation, and absence of source maps and
development or test payloads. The package is bound to Bitcoin mainnet and the
reviewed production gateway identity. The archive's compressed data also
passed an independent ZIP integrity check.

## Remaining Store actions

- Upload only the exact ZIP checksum above to the existing Chrome Web Store
  item when release review is authorized.
- After Store processing, verify the processed package identity, permissions,
  version, review status, and rollback candidate.
