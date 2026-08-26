# Drey Extension 0.14.8 release evidence

Status: audited local Chrome Web Store candidate; ready for upload, not uploaded
or submitted

Prepared: 2026-08-23

## Source identity

- Extension source commit/tag:
  `110d79251ba9e644e56198cfe1a27849cd1fd53e` /
  `production-v0.14.8`
- Private annotated tag object:
  `e89390f9128a361ad264736f9b796ecc0650e124`
- Shared Core tag/commit: `v0.17.3` /
  `a77e6b0962d94888520e176c50e86b29b17d3492`
- Extension version: `0.14.8`

The private source tag was pushed and read back from the remote. The production
package was built from the exact clean tagged extension source and the existing
tagged workspace/gateway policy inputs.

## Validation

- Extension suite: 127 files and all 1,345 active tests passed, with only the
  expected live-gateway probe skipped; typecheck and lint passed.
- Gateway compatibility: all 444 tests, typecheck, and lint passed.
- Production and test builds passed their channel audits. The clean-tag M8T
  release gate rebuilt and audited this exact production package successfully.
- The complete headless browser suite passed. The complete headed normal suite
  passed, and all secret-safe scenarios passed either in the full run or an
  immediate isolated rerun after a concurrent native build finished.
- Preview isolation, recovery, and M9X launch/Ordinals browser gates passed.
  The aggregate M9 run reached its browser phase but could not bind hard-coded
  port 4173 because an unrelated local service owns it; the same browser suites
  passed exclusively on temporary port 4174 with no source change retained.
- Every retained E2E artifact was privacy-audited and deleted.
- The security change adds no permission, prompt, or user step.

## Exact artifact

- Filename: `.output/production/drey-extension-0.14.8-chrome.zip`
- Size: `1,527,391` bytes
- SHA-256:
  `15b25fd7dc79c51365a89b9dfa7fd932613e90c8a603291cec1ca1a67ae58f9a`
- Provenance SHA-256:
  `b6a081a2913cf2dcb95f8c017a27cd2a903b7b41f30c34f203e646528cf507ed`
- Extension ID: `kngidlmmbfmnoeimngkajdlbdenlhgof`
- Manifest version: MV3
- Permissions: `storage`, `alarms`, `idle`, `sidePanel` (unchanged)
- Packaged files: 66

The production audit verified the Store manifest identity, source/provenance
binding, content security policies, provider surface, recovery isolation,
absence of source maps and development/test payloads, and the established
production gateway authority.

## Remaining release gates

- Upload only the exact ZIP checksum above to the existing Chrome Web Store
  item.
- After Store processing, verify the processed package identity, permissions,
  version, review status, and rollback candidate.
