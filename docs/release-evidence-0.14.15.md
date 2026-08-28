# Drey Extension 0.14.15 release evidence

Status: audited local Chrome Web Store candidate; ready for upload, not uploaded
or submitted

Prepared: 2026-08-28

## Source identity

- Extension source commit/tag:
  `5d02cddf31f8beb948e915650486653ab56fdf0a` /
  `production-v0.14.15`
- Private annotated tag object:
  `c4c41fdf2f472aa020af57d6e01b78d78595c09a`
- Shared Core tag/commit: `v0.18.3` /
  `cff779fe7d785d00cb6800f125e54bd3835a09f5`
- Gateway tag/commit: `production-v0.14.8` /
  `111f042ba124dce6feed5799eaf2f348bd31e22d`
- Extension version: `0.14.15`

The private source commit and annotated tag were pushed and read back from the
remote. The production package was built from the exact clean tagged extension
source and the existing tagged workspace and gateway policy inputs. The public
source mirrors were left unchanged.

## Compatibility and validation

- Callback-era single-transaction signing and the current PSBT V2 alias now
  normalize into Drey's existing canonical review and signing flow. Independent
  multi-transaction batches retain atomic cancellation and result behavior.
- Declared input indexes and sighashes are checked against the actual PSBT
  before approval. Drey derives the effective sighash itself and surfaces what
  each signature commits to in the existing concise review; valid requests do
  not gain another confirmation step.
- The extension suite passed 1,367 active tests across 129 files, with only the
  expected live-gateway probe skipped. Typecheck and lint passed. Focused and
  independent compatibility regressions passed 115 and 92 tests respectively.
- The headed packaged-browser suite passed all 41 journeys at 320 px, 392 px,
  and 520 px widths. Provider approval, scroll/action visibility, overflow,
  rejection, and privacy-safe secret-visible states passed visual and behavior
  checks.
- The shared Core/provider path passed 27 real Bitcoin and Ordinals regtest
  scenarios. It covered signing, counterparty completion, finalization, mempool
  acceptance, permitted sighash mutations, PSBTv0/v2, mixed scripts,
  `OP_RETURN`, protected assets, independent batches, and negative cases.
- The pinned marketplace fixtures and all 16 marketplace-contract tests passed.
  Exact-origin auditing and the synthetic preview package audit also passed.
- Production package auditing reopened all 66 files and verified the exact
  20-method provider surface, Store identity, source/provenance binding,
  content security policies, recovery isolation, and absence of source maps or
  development and test payloads.

This release does not enable internally linked multi-PSBT groups in the client,
and the ord.net collection/trait V2 funding-parent templates remain fixture-only.
Those requests continue to fail closed rather than being represented as fully
supported.

## Exact artifact

- Filename: `.output/production/drey-extension-0.14.15-chrome.zip`
- Size: `1,537,691` bytes
- Entries: 66
- SHA-256:
  `317140143d864ea3c8c21b9c868afa1969d05525b5a0140c7a5fc24fd4cfc146`
- Normalized content digest:
  `ac95ef79638076438b102a71a3aab42b7b91c55ecadb4e09b39a924e067853d3`
- Provenance sidecar SHA-256:
  `54ac4a2c3279b3a3fdbffb30ba926d7cc416238ee82eecb0ff4d646032ea6d9d`
- Manifest SHA-256:
  `aaed5e4dcba529a009afdf9b067f48188cd9e1bbe1ecea5297aad1747b0ea3af`
- Extension ID: `kngidlmmbfmnoeimngkajdlbdenlhgof`
- Manifest version: MV3
- Permissions: `storage`, `alarms`, `idle`, `sidePanel` (unchanged)

The archive passed an independent ZIP integrity check. The package is bound to
Bitcoin mainnet and the reviewed production gateway identity.

## Remaining Store actions

- Publish the required Core source release to its public mirror before
  distributing a consumer that resolves the public tag.
- Upload only the exact ZIP checksum above to the existing Chrome Web Store
  item when release review is authorized.
- After Store processing, verify the processed package identity, permissions,
  version, review status, and rollback candidate.
