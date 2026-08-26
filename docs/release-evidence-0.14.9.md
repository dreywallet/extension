# Drey Extension 0.14.9 release evidence

Status: audited local Chrome Web Store candidate; ready for upload, not uploaded
or submitted

Prepared: 2026-08-25

## Source identity

- Extension source commit/tag:
  `ba5f5880953027acad7e32359142a868f4e8dab7` /
  `production-v0.14.9`
- Private annotated tag object:
  `402b6a6d318592540d820668d46383126a4e849a`
- Shared Core tag/commit: `v0.17.5` /
  `280251adbd1cbf0eafaeebc8fc13a7d9adcd7216`
- Extension version: `0.14.9`

The private source tag was pushed and read back from the remote. The production
package was built from the exact clean tagged extension source and the existing
tagged workspace and gateway policy inputs. The public source mirrors were left
unchanged.

## Validation

- The extension suite passed all 1,357 active tests across 128 files, with only
  the expected live-gateway probe skipped; typecheck and lint passed.
- Frozen-lockfile installation, production build, ZIP creation, and production
  package audit passed.
- The complete real-regtest suite passed all 26 serial journeys against an
  isolated Bitcoin Core, ord, Fulcrum, and gateway project. It covered funding,
  signing, broadcast and confirmation, Ordinals, coin control, failure paths,
  and the extension's Receive behavior.
- The complete headless and headed packaged-browser suites, recovery and
  preview isolation gates, marketplace contract checks, and current aggregate
  release gates passed during this release cycle.
- Every retained browser and regtest artifact passed the privacy audit and was
  deleted. The isolated regtest services were stopped after validation.

## Exact artifact

- Filename: `.output/production/drey-extension-0.14.9-chrome.zip`
- Size: `1,532,056` bytes
- Entries: 66
- SHA-256:
  `b6aa82d7dd6a73fb7e450035f604ea16dac105211b37a793846fb59c71da7cd4`
- Normalized content digest:
  `d4005bf53036535bc3ca9ea24acfa411cc130d1a9fe2c84bf76df59c350e6cf9`
- Provenance sidecar SHA-256:
  `15bd26d81b7c8fefb113bd44d67ac93c9d667f8616f092b5381e9ca1a7ed2de8`
- Manifest SHA-256:
  `2bb07e34cc0a2b2c17a3db85f967227f68e022896133996da21c74ec3f97944d`
- Extension ID: `kngidlmmbfmnoeimngkajdlbdenlhgof`
- Manifest version: MV3
- Permissions: `storage`, `alarms`, `idle`, `sidePanel` (unchanged)

The production audit reopened all 66 files and verified the exact 20-method
provider surface, Store identity, source and provenance binding, content
security policies, recovery isolation, and absence of source maps and
development or test payloads. The package is bound to Bitcoin mainnet and the
reviewed production gateway identity.

## Remaining Store actions

- Upload only the exact ZIP checksum above to the existing Chrome Web Store
  item.
- After Store processing, verify the processed package identity, permissions,
  version, review status, and rollback candidate.
