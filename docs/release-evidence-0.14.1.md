# Drey Extension 0.14.1 release evidence

Status: audited local Chrome Web Store candidate; not uploaded or submitted

Prepared: 2026-08-21

This record covers the exact production extension package prepared for bounded
multiple-message signing. It records local implementation, security, build,
test, package, and user-interface evidence. It does not claim Chrome Web Store
processing, review, publication, or any real Bitcoin transaction.

## Source identity

- Workspace source commit/tag:
  `7eb45c7677bf5e4791a03a1687a12dea95825d67` /
  `production-v0.14.0`
- Extension source commit/tag:
  `4c9a8836cf17a87a450da50b23d175b127f83a0c` /
  `production-v0.14.1`
- Shared Core tag/commit: `v0.17.1` /
  `ba679e04aee463ae6026d0b457ce271bba8cc317`
- Gateway source commit/tag:
  `49a80586731276ff3bbb8971744f03d0c5371d87` /
  `production-v0.11.2`
- Extension version: `0.14.1`

The extension lockfile pins the exact `@drey/core` v0.17.1 release. The public
source mirrors were intentionally left unchanged. A public source release
remains a separate reviewed release-owner action.

## Feature boundary

The provider now supports the official Sats Connect `signMultipleMessages`
payload and result shape for one to ten BIP322 messages. Each message is bounded
to 4 KiB and the ordered batch to 32 KiB. One approval binds the exact origin,
browser authority, account, network, vault session, approval generation,
addresses, messages, and tagged message hashes.

Preparation and signing are all-or-nothing. Results retain request order and no
partial result is returned after rejection, closure, restart, or stale context.
Existing single-message and transaction-signing behavior remains available and
covered. Marketplace transaction templates, including linked ord.net batch
listings, remain disabled unless a future release adds an explicit compile-time
policy review.

## User experience review

The approval was rendered and inspected at an actual 420 by 680 extension
window. Both complete messages and their address purposes are visible at once;
one natural scroll reaches wallet context, technical details, and the Reject and
Sign actions. The screen uses one calm explanation that messages cannot spend
bitcoin, requires no extra password or typed phrase, and adds no separate warning
or confirmation step. Hidden bidirectional and zero-width formatting is exposed
as a compact `U+` marker instead of being silently rendered.

The packaged extension ceremony was also exercised from the page provider,
through the browser bridge and controller, into approval and wallet signing. It
returned two exact BIP322 results in order. Reject, close, restart, context
change, and atomic failure paths returned no signatures.

## Validation

- Extension unit/integration suite: 127 files passed and one expected live probe
  was skipped; 1,328 tests passed.
- Core focused and integration coverage passed for schema bounds, official
  adapter shape, order, atomic cancellation and failure, restart and stale state,
  signing equivalence, and unchanged single-message behavior. In the complete
  Core run, one existing cryptographic workload case exceeded its suite-load
  timeout and passed in isolation. Core typecheck, lint, fixture sync, vector
  generation, and reproducible Recovery Center verification passed.
- Extension typecheck, lint, Next build, production build, test build, production
  package audit, archive integrity, synthetic preview package, marketplace
  fixture, marketplace contract, and compile-time policy checks passed.
- Headless and headed packaged-browser runs each passed 14 ordinary flows and 25
  secret-safe flows; one toolbar geometry case was skipped where the suite could
  not make a browser toolbar assertion. Every run ended with a passing artifact
  privacy audit.
- The M9P preview gate passed its focused unit, Core, package, ordinary-browser,
  secret-safe browser, and privacy checks. The M9X launch gate passed its 46 Core
  tests, 145 extension tests, nine secret-safe browser flows, and privacy audit.
- All 16 marketplace contract tests and all three pinned fixture subsets passed.
- The production package audit reopened 66 files and verified the exact
  20-method provider surface.
- The release aggregate encountered one existing gateway lazy-preview timing
  assertion under the default parallel test load. That exact test passed in
  isolation, and the complete gateway suite passed all 441 tests with one worker;
  gateway typecheck and lint also passed. No production assertion was changed.
- Focused security and marketplace reviews found no remaining release blocker.
  Release-facing changes and commit messages passed the prohibited-reference
  scan.

No transaction was signed or broadcast and no funds were moved. This release
adds message signing, so it did not require a live Bitcoin or regtest broadcast.

## Supporting package evidence

- Synthetic preview package SHA-256:
  `314dcde3753e32794174adf2d9399928b8742b274e8fbc4f58e02884c6711666`
- Next unpacked build: `.output/next/chrome-mv3` (66 files)
- Production unpacked build: `.output/production/chrome-mv3` (66 files)

## Exact production artifact

- Filename: `.output/production/drey-extension-0.14.1-chrome.zip`
- Size: `1,525,816` bytes
- Entries: 66
- SHA-256:
  `c9cc70b3e2bb24089c112a3091d0d425a44a966a6548be0a17cc4a1c90d09e12`
- Normalized content digest:
  `b88f85730efebf09ab27dd39ed2d3b47986f4fdbb4fd3fd79e1ceb2ab6d409f6`
- Provenance sidecar SHA-256:
  `644d13040caac89828843f9b105ba72ccb1aa729994052cb147750fa9fb3cbe4`
- ZIP integrity: passed with no compressed-data errors.

The manifest identifies Chrome extension
`kngidlmmbfmnoeimngkajdlbdenlhgof`, version `0.14.1`, with the stable reviewed
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
