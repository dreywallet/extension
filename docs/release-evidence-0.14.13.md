# Drey Extension 0.14.13 release evidence

Status: audited local Chrome Web Store candidate; ready for upload, not uploaded
or submitted

Prepared: 2026-08-26

## Source identity

- Extension source commit/tag:
  `3189e3291b310c3572727f5fda8ee791747fcb7d` /
  `production-v0.14.13`
- Private annotated tag object:
  `355e51fe3fc9ff4921a4ee14105aaaeaae2a5440`
- Shared Core tag/commit: `v0.18.0` /
  `f684662079528941459f6496c6916c3ad6402b04`
- Gateway tag/commit: `production-v0.14.8` /
  `111f042ba124dce6feed5799eaf2f348bd31e22d`
- Extension version: `0.14.13`

The private source tag was pushed and read back from the remote. The production
package was built from the exact clean tagged extension source and the existing
tagged workspace and gateway policy inputs. The public source mirrors were left
unchanged.

## Validation

- The extension suite passed all 1,359 active tests across 128 files, with only
  the expected live-gateway probe skipped; typecheck and lint passed.
- The gateway suite passed all 444 tests; its typecheck and lint passed.
- The complete real-regtest suite passed all 27 serial journeys against an
  isolated Bitcoin Core, ord, Fulcrum, and gateway project. It covered wallet
  funding, signing, broadcast, flexible sighash mutations, counterparty
  completion, mempool acceptance, batches, stale spends, Ordinals, coin control,
  and failure paths.
- The complete headless and headed packaged-browser suites, preview isolation,
  marketplace contract checks, M8T, M9, M9P, and M9X release gates passed.
- Every retained browser and regtest artifact passed the privacy audit. The
  isolated regtest services were stopped after validation.

## Exact artifact

- Filename: `.output/production/drey-extension-0.14.13-chrome.zip`
- Size: `1,535,673` bytes
- Entries: 66
- SHA-256:
  `c1f79524efb531c8c007ae68efb09a3180eac63324711721ab6a18b2f78c196b`
- Normalized content digest:
  `be7435651f591b9c61989ddea4794eb3a3785879f7843b5d1012b43dae8a8e66`
- Provenance sidecar SHA-256:
  `1eb723fa7157aed2fa141cfaf3d71f6303c6799dd5d3e7c3e3222d44ec10a2e6`
- Manifest SHA-256:
  `85e2670a5b5026e9c3c14ae7d07f192c2dc7e1eb1727bec9160909b684fe1686`
- Extension ID: `kngidlmmbfmnoeimngkajdlbdenlhgof`
- Manifest version: MV3
- Permissions: `storage`, `alarms`, `idle`, `sidePanel` (unchanged)

The production audit reopened all 66 files and verified the exact 20-method
provider surface, Store identity, source and provenance binding, content
security policies, recovery isolation, and absence of source maps and
development or test payloads. The package is bound to Bitcoin mainnet and the
reviewed production gateway identity.

## Remaining Store actions

- Publish the reviewed Core 0.18.0 public mirror and recovery artifact before
  distributing a consumer that identifies that release.
- Upload only the exact ZIP checksum above to the existing Chrome Web Store
  item.
- After Store processing, verify the processed package identity, permissions,
  version, review status, and rollback candidate.
