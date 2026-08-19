# Drey Extension 0.11.2 release evidence

Status: audited local Chrome Web Store candidate; not uploaded or submitted

Prepared: 2026-08-17

This record covers the exact production extension package prepared for
selected-account routine refresh. It does not claim Chrome Web Store processing
or review acceptance, and the version already under review was not changed.

## Source identity

- Workspace source commit/tag:
  `443e92787d676d2a2ddcd80967b2bc765094b09f` /
  `production-v0.11.2`
- Extension source commit/tag:
  `d411b18082f640ac9529359fc766b83c72670301` /
  `production-v0.11.2`
- Shared core tag/commit: `v0.11.0` /
  `5ab4dd62d02b8914bd519d645a4d6eb5936c01b5`
- Gateway source commit/tag:
  `1ee93e36827b2c8c3dd512549f0390018a421a29` /
  `production-v0.11.1`
- Extension version: `0.11.2`

## Validation

- Unit/integration suite: 123 files passed, 1 skipped; 1,283 tests passed and
  the separately gated live-gateway probe was skipped.
- TypeScript typecheck, lint, production build, test build, ZIP creation, and
  production package audit: passed.
- Required headless and headed browser E2E suites passed, followed by passing
  E2E artifact privacy audits. The headed pass exercised the visible extension
  surfaces and account interactions in a clean Chromium profile.
- M8T, M9, M9P, and M9X aggregate gates passed, including marketplace fixture,
  contract, package, and preview audits.
- Branding and all workspace/repository whitespace checks passed.

One restore-refresh test exceeded its setup timeout once during an aggregate
run. The same test had already passed in both headless and headed suites, then
passed in isolation and in the complete aggregate rerun. No assertion or
production behavior was changed for the rerun.

## Exact artifact

- Filename: `.output/production/drey-extension-0.11.2-chrome.zip`
- Size: `1,441,548` bytes
- Entries: 65
- SHA-256:
  `15e542af078feafd6ac78b687e09221fa7572c0b19e88a36f7a7f50c9c740943`
- Normalized content digest:
  `d6091943bc5f2a673146256b355a83243cce1174b1231eba8da0007975b2395d`
- Provenance sidecar SHA-256:
  `d86e059a539f0fbabe0b2fc6cd7214f26f6954b0f4b185cf2fe559c511ebf93d`
- ZIP integrity: passed with no compressed-data errors.

The production audit reopened all archive entries and verified the source/tag
bindings, deterministic build-output digest, Store identity, manifest public
key, Store item ID, gateway origin/key, permissions, host permissions, content
security policy, and production channel configuration. The manifest identifies
Chrome extension `kngidlmmbfmnoeimngkajdlbdenlhgof`, version `0.11.2`, with
only the reviewed production gateway host permission.

## Remaining release gates

- Do not disturb the version currently under review. Upload or submit 0.11.2
  only after that version is approved and live.
- Immediately before upload, re-read the Web Store target, artifact hash,
  listing/release notes, publication setting, monitoring, and rollback package.
- After Store processing, verify the processed package version, extension ID,
  permissions, signing identity, rollout state, and clean-profile installed
  behavior before publication is considered complete.
