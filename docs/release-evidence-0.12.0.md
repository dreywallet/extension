# Drey Extension 0.12.0 release evidence

Status: audited Chrome Web Store candidate; not uploaded or submitted

Prepared: 2026-08-19

This record covers the exact production extension package prepared for the
Community Vault and group-buy release. It records local build and test evidence
plus the public source mirror. It does not claim Chrome Web Store processing,
review acceptance, publication, or any real Bitcoin transaction.

## Source identity

- Workspace source commit/tag:
  `9a5d3b025c9631c7222bb5ca3b69499810b3029c` /
  `production-v0.12.0`
- Extension source commit/tag:
  `cea00922a18a4e5e14dd6d6182115874c99840d9` /
  `production-v0.12.0`
- Shared core tag/commit: `v0.14.4` /
  `04507440dce468d9f32c1a0f65ec48f2204d83cd`
- Gateway source commit/tag:
  `1ee93e36827b2c8c3dd512549f0390018a421a29` /
  `production-v0.11.1`
- Extension version: `0.12.0`
- Public extension mirror tag/commit: `v0.12.0` /
  `a749a630c9657963d10a98d3ccd8a6830606182b`
- Public core mirror tag: `v0.14.4`

The public extension mirror was produced only by the reviewed publisher from
the private release tag. Its dry-run export passed the public-content audit,
and the published snapshot was read back as a lightweight `v0.12.0` tag with
commit author `Squirrel Systems LLC`, README present, and AGPL-3.0 license
detected.

## Validation

- Extension unit/integration suite: 125 files passed, 1 skipped; 1,301 tests
  passed and 1 separately gated live-gateway test was skipped.
- Core suite: 94 files and 920 tests passed. Typecheck, lint, canonical fixture
  sync, policy-vector generation, and deterministic standalone recovery
  verification passed.
- Gateway suite: 30 files and 439 tests passed; typecheck and lint passed.
- Mobile suite: 139 files and 1,007 tests passed; typecheck and lint passed.
- Extension typecheck, lint, production build, test build, package creation,
  production audit, preview-package audit, and archive integrity checks passed.
- Headless browser E2E: 14 normal tests and 25 secret-safe tests passed; one
  toolbar-size check was skipped because it requires a visible browser.
- Headed browser E2E: all 15 normal tests and 25 secret-safe tests passed,
  including toolbar sizing. The corrected Hide/Unhide navigation scenario then
  passed five consecutive runs.
- M8T, M9, M9P, and M9X aggregate gates passed. These covered marketplace
  fixtures/contracts, provider and transaction boundaries, native Ordinals
  transfer, preview isolation, signed-preview mismatch handling, service-worker
  restart recovery, gallery caching, and launch UX.
- Marketplace checks passed for three pinned fixture subsets and 15 core
  contract tests. The compile-time marketplace policy audit passed.
- Every E2E run used disposable profiles and ended with a passing artifact
  privacy audit.
- The production package audit reopened 66 files and verified all 17 provider
  methods, including `drey_openCommunityVault`.

No real transaction was signed or broadcast and no real funds were moved.
External security review remains a separate owner-run workstream and was not
treated as an implementation or packaging gate.

## Deterministic recovery evidence

- Recovery source digest:
  `d40603d037cdbdcfa434dfaa4bac3c72e0c2c18a952e45db3df3d6120f3ad96e`
- Recovery artifact digest:
  `e9b46a159b22b7d1498ecc421cc621f4e0f5b20b76ec94d0272f1b4f2f82faaa`
- Recovery artifact size: `558,210` bytes
- Synthetic preview package SHA-256:
  `1ebfeee1a20792a73be374d93f22680a08fe1eb58db6920bcf971c3dd9b263a1`

## Exact artifact

- Filename: `.output/production/drey-extension-0.12.0-chrome.zip`
- Size: `1,486,071` bytes
- Entries: 66
- SHA-256:
  `8ac94ff1a398c08d7a358ea63e6ef98ceaea646084ec2efdbeb1151fb31bf926`
- Normalized content digest:
  `51e6f1410eb40037c6a4c278adb47a8800937a2c73611b1c3b6585653435f86a`
- Provenance sidecar SHA-256:
  `5a210ab248c56b381a19b09d098a5552454f42213a9ca91a41618a346db7d4d3`
- ZIP integrity: passed with no compressed-data errors.
- Reproducibility: two clean production build/package/audit runs produced the
  same ZIP SHA-256 and the same provenance SHA-256.

The manifest identifies Chrome extension
`kngidlmmbfmnoeimngkajdlbdenlhgof`, version `0.12.0`, with the stable reviewed
manifest key and only `https://wallet-api.squirrelsystems.net/*` as a host
permission. The package targets Bitcoin mainnet and enables the reviewed live
gateway and production Community Vault coordination surfaces.

## Remaining Store actions

- The ZIP has not been uploaded or submitted. Dashboard access reached Google's
  account re-verification step, so no Store item or review state was changed.
- Before upload, independently confirm the target item ID, ZIP SHA-256, release
  notes, publication setting, production gateway health, and rollback package.
- The exact Store-accepted `0.10.1` artifact remains the documented rollback
  candidate until `0.12.0` is accepted and live.
- After Store processing, verify the processed version, extension ID,
  permissions, signing identity, rollout state, and clean-profile installed
  behavior before publication is considered complete.
