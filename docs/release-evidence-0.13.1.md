# Drey Extension 0.13.1 release evidence

Status: audited Chrome Web Store candidate and published public source mirrors;
submitted for Chrome Web Store review, acceptance pending

Prepared: 2026-08-20

This record covers the exact production extension package prepared for the RBF
reliability and Community Vault position-transfer update. It records local build
and test evidence plus the published public source snapshots. The release owner
reported on 2026-08-20 that version 0.13.1 is in Chrome Web Store review. This
record does not yet claim review acceptance, Store publication, processed-package
identity, or any real Bitcoin transaction.

## Source identity

- Workspace source commit/tag:
  `c8ca663e73d0d163dd8e73a4864ce3821cfdb8cf` /
  `production-v0.13.1`
- Extension source commit/tag:
  `fc517189a59731e66d64fa5ffd103ccdb3ced044` /
  `production-v0.13.1`
- Shared core tag/commit: `v0.16.1` /
  `78791714f4f3ac511addea446bcfe7ddd6acbe4f`
- Gateway source commit/tag:
  `49a80586731276ff3bbb8971744f03d0c5371d87` /
  `production-v0.11.2`
- Extension version: `0.13.1`
- Public core mirror tag/commit: `v0.16.1` /
  `e2c70025012b7104b3a2d2e1a6c8b2397d38036d`
- Public extension mirror tag/commit: `v0.13.1` /
  `c86cd0ced4d28fc8769f2c869aa3a38a46d33f61`

The private annotated release tags were pushed and read back from all three
remotes. Each peeled tag resolves to the exact commit listed above. The extension
lockfile pins the exact `@drey/core` v0.16.1 release commit.

The public core and extension mirrors were produced only by the reviewed
publisher from their private release tags. Both dry-run exports passed the
public-content audit before publication. The resulting lightweight tags and
`main` branches were read back at the commits listed above, with company commit
identity, README files present, and AGPL-3.0 licenses detected. The public
extension lockfile resolves core v0.16.1 to the public core mirror commit.

## Validation

- Extension unit/integration suite: 126 files passed, 1 skipped; 1,314 tests
  passed and 1 separately gated live-gateway test was skipped.
- Extension typecheck, lint, production build, test build, production package
  audit, preview-package audit, and archive integrity checks passed.
- Headless browser E2E: 14 normal tests and 25 secret-safe tests passed; one
  toolbar-size check was skipped because it requires a visible browser.
- The headed browser run passed 12 normal tests and all 25 secret-safe tests.
  Three browser-startup or focus-sensitive checks failed in that combined run,
  then all three passed together in an isolated headed rerun.
- Marketplace checks passed for three pinned fixture subsets and 15 core
  contract tests. The compile-time marketplace policy audit passed.
- Every E2E run ended with a passing artifact privacy audit.
- The production package audit reopened 66 files and verified all 17 provider
  methods.
- Release-facing copy and the packaged extension passed the prohibited-tooling
  reference scan.
- The public publisher policy tests, dry-run audits, atomic pushes, and
  independent GitHub readback checks passed for both mirrors.

No real transaction was signed or broadcast and no real funds were moved.
External security review remains a separate owner-run workstream and was not
treated as an implementation or packaging gate.

## Supporting package evidence

- Synthetic preview package SHA-256:
  `493a9867c9f7485023ca9d2f218196d426163877b3097c3b316453db1e128840`

## Exact artifact

- Filename: `.output/production/drey-extension-0.13.1-chrome.zip`
- Size: `1,516,668` bytes
- Entries: 66
- SHA-256:
  `92f03d862e7dcc481a2bfd12e16e9c574ffc651e4546190b1e0d5c7199539755`
- Normalized content digest:
  `ec2fbcf127d005282cf79088337b6dc1fe1e1f71fb35b9cfb14e19b50d9b7a67`
- Provenance sidecar SHA-256:
  `748dd21bff21f82fdbaa79de78f520625f4ab422cadf6dbfdca53459176df94b`
- ZIP integrity: passed with no compressed-data errors.
- Reproducibility: two clean production build/package/audit runs produced the
  same ZIP SHA-256 and the same provenance SHA-256.

The manifest identifies Chrome extension
`kngidlmmbfmnoeimngkajdlbdenlhgof`, version `0.13.1`, with the stable reviewed
manifest key and only `https://wallet-api.squirrelsystems.net/*` as a host
permission. The package targets Bitcoin mainnet and enables the reviewed live
gateway and production Community Vault coordination surfaces.

## Remaining Store actions

- Wait for Chrome Web Store review of version 0.13.1. The exact processed archive
  identity must be read back before the local ZIP is treated as the Store artifact.
- The exact Store-accepted `0.10.1` artifact remains the documented rollback
  candidate until `0.13.1` is accepted and live.
- After review and Store processing, verify the processed version, extension ID,
  permissions, signing identity, rollout state, and clean-profile installed
  behavior before publication is considered complete.
