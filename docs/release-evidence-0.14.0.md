# Drey Extension 0.14.0 release evidence

Status: audited local Chrome Web Store candidate; not uploaded or submitted

Prepared: 2026-08-21

This record covers the exact production extension package prepared for generic,
independent batch PSBT signing. It records local implementation, security,
build, test, and package evidence. It does not claim Chrome Web Store processing,
review, publication, or any real Bitcoin transaction.

## Source identity

- Workspace source commit/tag:
  `7eb45c7677bf5e4791a03a1687a12dea95825d67` /
  `production-v0.14.0`
- Extension source commit/tag:
  `018b3fbf20506d701203697df570a9ef368c2044` /
  `production-v0.14.0`
- Shared Core tag/commit: `v0.17.0` /
  `7034bb0466a0755f3bf58a08d69bc524d2328222`
- Gateway source commit/tag:
  `49a80586731276ff3bbb8971744f03d0c5371d87` /
  `production-v0.11.2`
- Extension version: `0.14.0`

The private annotated release tags were pushed and read back from their remotes.
Each peeled tag resolves to the exact commit listed above. The extension lockfile
pins the exact `@drey/core` v0.17.0 release.

The public source mirrors were intentionally left unchanged. A public source
release remains a separate reviewed release-owner action.

## Feature boundary

The provider now supports the official Sats Connect
`signMultipleTransactions` payload and result shape for one to 41 independent
PSBTs. One approval binds the exact ordered batch, signing indexes, origin,
account, network, vault session, analyses, and approval generation. Every item
is fully analyzed before approval and remains subject to the existing Advanced
PSBT, ownership, sighash, asset, and transaction checks.

Duplicate PSBTs, conflicting wallet inputs, and transactions that spend another
batch item's output fail closed. Signing is all-or-nothing and returns results in
request order. Linked or prospective transaction graphs, including the shared
ord.net recovery flow, remain disabled pending a separate compile-time policy
review. Existing single-PSBT behavior remains available and covered.

## Validation

- Extension unit/integration suite: 127 files passed, 1 skipped; 1,322 tests
  passed and 1 separately gated live-gateway probe was skipped.
- Core batch tests passed. In the complete Core run, 936 tests passed and two
  existing five-second cryptographic workload cases timed out under full-suite
  load; both cases passed in isolation. Core typecheck, lint, fixture sync,
  vector generation, and reproducible Recovery Center verification passed.
- Extension typecheck, lint, Next build, production build, test build,
  production package audit, and archive integrity checks passed.
- The complete gateway suite passed all 441 tests during the release aggregate.
- Headless browser coverage passed 14 normal tests and 25 secret-safe tests; one
  toolbar-size check was skipped because it requires a visible browser.
- The headed browser run passed all 15 normal tests. Its secret-safe run passed
  24 of 25 tests, with one gallery geometry check failing under combined-run
  load; that exact test passed in an isolated headed rerun and had already passed
  in both headless release aggregates.
- Every browser run and rerun ended with a passing artifact privacy audit.
- Marketplace checks passed for all three pinned fixture subsets, all 16 Core
  contract tests, and the compile-time policy audit.
- The production package audit reopened 66 files and verified all 18 provider
  methods. Repackaging from the same clean tagged sources reproduced the exact
  archive and provenance hashes below.
- A focused security review found no remaining reportable issue after adding an
  event-loop checkpoint before each signature and a final lifecycle guard.
- Release-facing changes and commit messages passed the prohibited-reference
  scan.

No real transaction was signed or broadcast and no real funds were moved. The
regtest-network integration coverage was deterministic; no disposable live
regtest node was available for this release run.

## Supporting package evidence

- Synthetic preview package SHA-256:
  `4a5d3a9234a610b769456868d45fd242b27e6fe9d16bec9f06be2e778a523360`
- Next unpacked build: `.output/next/chrome-mv3` (66 files)
- Production unpacked build: `.output/production/chrome-mv3` (66 files)

## Exact production artifact

- Filename: `.output/production/drey-extension-0.14.0-chrome.zip`
- Size: `1,522,385` bytes
- Entries: 66
- SHA-256:
  `1031ad8f1c290be825f22eaf94a0153bcf593a59cfac772fc573afa064de47a4`
- Normalized content digest:
  `73433159bb39361b4756b5e8fea8268131f28182a480552b8ae8f49e33424f36`
- Provenance sidecar SHA-256:
  `e6e7fa05cc680012422b06acae2ec1671ed2948788917f1b79a815b2a97e0929`
- ZIP integrity: passed with no compressed-data errors.

The manifest identifies Chrome extension
`kngidlmmbfmnoeimngkajdlbdenlhgof`, version `0.14.0`, with the stable reviewed
manifest key and only `https://wallet-api.squirrelsystems.net/*` as a host
permission. The package targets Bitcoin mainnet and enables the reviewed live
gateway and production Community Vault surfaces.

## Remaining Store actions

- Upload only the exact ZIP checksum above after confirming the Store item,
  release notes, permissions, rollout, and rollback candidate.
- Read back the Store-processed artifact identity before treating the local ZIP
  as the Store artifact.
- Verify the processed version, extension ID, permissions, signing identity, and
  clean-profile behavior before publication is considered complete.
