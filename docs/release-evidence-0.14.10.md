# Drey Extension 0.14.10 release evidence

Status: production package and local `next` candidate built and audited; final
packaged-browser acceptance pending

Prepared: 2026-08-25

## Source identity

- Extension source commit/tag:
  `b80eaa8b855530d00793b3b6c825ddc9a28f0a88` /
  `production-v0.14.10`
- Private annotated tag object:
  `fc2305567524e3d3b8c06234a28bdff30cda8259`
- Shared Core tag/commit: `v0.17.5` /
  `280251adbd1cbf0eafaeebc8fc13a7d9adcd7216`
- Extension version: `0.14.10`

The private source tag was pushed and read back from the remote. The production
package was built from the exact clean tagged extension source and the existing
tagged workspace and gateway policy inputs. The public source mirrors were left
unchanged.

## Change evidence and completed validation

- Wallet creation begins with recovery words hidden and requires an explicit
  reveal action. Wallet restoration masks entered recovery words unless the
  user selects the existing reveal control.
- Focused component tests cover the create and restore boundaries. Packaged
  onboarding spot checks passed for both paths, including the hidden initial
  state and explicit reveal behavior.
- The complete extension suite passed all 1,357 active tests across 128 files,
  with only the expected live-gateway probe skipped. Typecheck and lint passed.
- Frozen-lockfile installation, production build, ZIP creation, production
  package audit, test build, test-package audit, and synthetic preview package
  verification passed.
- Marketplace fixture, contract, and activation-policy checks passed. Every
  retained browser artifact passed the privacy audit.
- The shared Core suite passed all 978 tests in a clean one-worker run, followed
  by typecheck, lint, fixture synchronization, vector regeneration, and the
  reproducible standalone recovery build. The unchanged gateway passed all 444
  tests, typecheck, and lint with its required loopback permissions.
- The full packaged-browser suite has not been rerun because an unrelated local
  dashboard owns its fixed loopback port `4173`. That service has not been
  interrupted without approval. The current package is not marked ready for
  Store upload until the headless and headed suites pass.
- The isolated real-regtest stack was started for additional coverage, but its
  Fulcrum service never opened its Electrum listener after establishing Bitcoin
  RPC connections. A service restart reproduced the same infrastructure
  failure. The stack was stopped without deleting its retained test-chain data;
  no regtest result is claimed for this release cycle.

## Local `next` track

- Unpacked path: `.output/next/chrome-mv3`
- Version: `0.14.10`
- Files: 66
- The `next` and production unpacked trees and channel metadata compare
  byte-for-byte equal.
- Approval/gallery isolation passed. `next` remains an unpacked local testing
  track and is not represented as a Chrome Web Store package.

## Exact production artifact

- Filename: `.output/production/drey-extension-0.14.10-chrome.zip`
- Size: `1,532,062` bytes
- Entries: 66
- SHA-256:
  `1f4c3d82908e3e0aa1a791a14f84cee20e049d5877856a386de9d5315807b0e9`
- Normalized content digest:
  `8f49bae06e8cb7daed4b7e8c29d19af3dbd794f1c36f97b6ecd69884705a2770`
- Provenance sidecar SHA-256:
  `6f0bb29241573b7a6badffe934b1196a0ce4e25dd1c48a68c8351cde8d0939e5`
- Manifest SHA-256:
  `d07b277bb69c63518bea66165e2172bf832c60c9bb356f6cd1850cbd3fc7e4c0`
- ZIP integrity: passed with no compressed-data errors.

The production audit reopened all 66 entries and verified the exact 20-method
provider surface. The manifest identifies Chrome extension
`kngidlmmbfmnoeimngkajdlbdenlhgof`, version `0.14.10`, with permissions limited
to `storage`, `alarms`, `idle`, and `sidePanel`, and only
`https://wallet-api.squirrelsystems.net/*` as a host permission. The package
targets Bitcoin mainnet and the reviewed production gateway identity.

## Remaining release gates

- Temporarily release loopback port `4173`, run the complete headless and headed
  packaged-browser suites and aggregate release gates, then repeat the artifact
  privacy audit.
- Restore the local real-regtest stack if additional real-chain acceptance is
  required; do not count the failed infrastructure startup as a product test.
- Upload only the exact ZIP checksum above after the browser gate passes and
  the Store item, release notes, permissions, rollout, and rollback candidate
  have been reconfirmed.
- Read back the Store-processed artifact identity before treating the local ZIP
  as the Store artifact.
