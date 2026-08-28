# Drey Extension 0.14.12 release evidence

Status: public source mirrors published and read back; production package built
and audited; no Chrome Web Store action performed

Prepared: 2026-08-26

## Source identity

- Extension source commit/tag:
  `245da78bc16e80c764e1d4a7ee3f1df13d7d49b8` /
  `production-v0.14.12`
- Private annotated extension tag object:
  `0bfcd46d869160471d0dc0baeb35634bfca69427`
- Shared Core source commit/tag:
  `5f715f43fca06c7f9f35c528f1455a9d012858a1` / `v0.17.6`
- Private annotated Core tag object:
  `e3afb501926c64e5619b4e05a249062c0d119cf3`
- Core recovery-record commit:
  `c43c4b591d1da30bf66d0dcce1eea17226eb862c`
- Extension version: `0.14.12`

Both private annotated tags were pushed atomically with their source commits and
read back from the private remotes. The earlier private
`production-v0.14.11` candidate was not retagged or published: its public dry
run exposed a stale Core checkout example in the contributor README. Version
0.14.12 corrects that example and hardens test approval-window discovery.
Wallet behavior and recovery artifact bytes are unchanged.

## Public mirror identity

- Public Core commit/lightweight tag:
  `ced3ce64be5fdbd60129d1e3baafaa5832dd4ba9` / `v0.17.6`
- Public Extension commit/lightweight tag:
  `08f021b8bcde3b2a687636be64e087f0f39d3707` / `v0.14.12`

Each public mirror contains one new squashed release commit. Both public tags
resolve directly to their release commit and are lightweight. Author and
committer identity read back as Squirrel Systems LLC / drey@squirrelsystems.net.
No private history, branch, annotated tag object, personal identity, workspace
instruction file, local path, private repository URL, or credential file was
included. The public Extension package and lockfile point to
`github.com/dreywallet/core` v0.17.6 and the exact public Core commit above.

Fresh shallow clones of both public tags passed frozen-lockfile installation.
The public Core clone passed typecheck and lint. The public Extension clone
passed typecheck, lint, and its standalone inspectable production build.

## Completed validation

- Core passed all 978 tests in a clean one-worker run, followed by typecheck,
  lint, fixture synchronization, vector regeneration, and two reproducible
  recovery builds.
- Core recovery source SHA-256:
  `0ac081447d6e89776485bd770f03d9bba348c1aa43d1e5e6cd95cb82fede6332`
- Core recovery artifact SHA-256:
  `642ad7904dc16fefa81757ca6151d392464b0087de2e5044cbb7b6a66776d432`
- Gateway passed all 444 tests, typecheck, and lint with loopback-only test
  permissions.
- Extension passed all 1,357 active tests across 128 files, with only the
  expected live-gateway probe skipped. Typecheck and lint passed.
- Production build, ZIP creation, production audit, test build, test-package
  audit, preview fail-closed check, reproducible synthetic preview packaging,
  marketplace fixture/contract/activation-policy checks, instruction parity,
  and whitespace checks passed from the clean 0.14.12 tag.
- The complete headless browser run passed 14 normal scenarios (with the
  expected headless toolbar skip) and all 26 secret-safe scenarios. The final
  headed run passed 14 normal scenarios (with a host-focus policy toolbar skip)
  and all 26 secret-safe scenarios. An earlier headed run exercised the toolbar
  scenario successfully. Every retained browser artifact passed the privacy
  audit.
- Focused M9P and M9X gates passed during this release cycle. Their preview,
  Ordinals transfer, recovery, and privacy paths are also included in the final
  complete 0.14.12 browser run.
- Synthetic preview package SHA-256:
  `c6f5bc221b1939c563bf9ce748fd84fa969b978470b43611f4fdf90c343048ae`

## Exact production artifact

- Filename: `.output/production/drey-extension-0.14.12-chrome.zip`
- Size: `1,532,061` bytes
- Entries: 66
- SHA-256:
  `f259330224bee77379c18ecb37b93693261c1ac6d0a504acc5f3514ba808455a`
- Normalized content digest:
  `e40b58cf4980f922684f916cf84b39c743996673f8586933934b9d64ead7431c`
- Provenance sidecar SHA-256:
  `67cbb5a5fe5cc4afadab9999a2434e4217ff227b92f210bfb2aa88831f8f4a08`
- Manifest SHA-256:
  `172b1b08636c0e4d3d0aa94efb68a2cd271060102a8ea15077f6a0f3dcfe2d6c`
- ZIP integrity: passed with no compressed-data errors.

The production audit reopened all 66 entries and verified the exact 20-method
provider surface. The manifest identifies Chrome extension
`kngidlmmbfmnoeimngkajdlbdenlhgof`, version `0.14.12`, with permissions limited
to `storage`, `alarms`, `idle`, and `sidePanel`, and only
`https://wallet-api.squirrelsystems.net/*` as a host permission. The package
targets Bitcoin mainnet and the reviewed production gateway identity.

## Remaining external action

No Chrome Web Store upload, submission, rollout, deployment, or mainnet value
transfer was requested or performed. Any later Store action must use only the
exact ZIP checksum above after reconfirming the Store item, release notes,
permissions, rollout, rollback candidate, and Store-processed artifact identity.
