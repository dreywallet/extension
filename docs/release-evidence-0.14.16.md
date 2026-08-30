# Drey Extension 0.14.16 release evidence

Status: audited local Chrome Web Store candidate; package verified, not uploaded
or submitted

Prepared: 2026-08-28

## Source identity

- Extension source commit/tag:
  `c58f613f013d43a8bdc9b63c5ac6560a0fc766cb` /
  `production-v0.14.16`
- Private annotated Extension tag object:
  `153cf376b02ab101a6004c6a6e4df347744e4872`
- Workspace source commit/tag:
  `70005ae63b1ff74ac91806cda3493b7d8bd3f760` /
  `production-v0.14.7`
- Private annotated workspace tag object:
  `25e1bc7a8defa09d90c02864ccf2bc596fa1dabc`
- Gateway source commit/tag:
  `111f042ba124dce6feed5799eaf2f348bd31e22d` /
  `production-v0.14.8`
- Private annotated Gateway tag object:
  `61a758702406898e1aea80b69ede4babbffafa59`
- Shared Core source commit/tag:
  `964755a7e99d11ddc285c567eea02c62d22d5770` /
  `v0.19.1`
- Private annotated Core tag object:
  `98de47b9b9da06fbaf2f7061942d054d55f50079`
- Extension version: `0.14.16`

The Extension worktree was clean at the exact annotated source tag. The private
Extension, workspace, Gateway, and Core tag objects and their peeled commits
were read back from their private remotes and matched the local objects. The
production package provenance binds the exact clean workspace, Extension, and
Gateway revisions above. The public Core `v0.19.1` and Extension `v0.14.16`
mirror tags were not present when this evidence was prepared.

## Compatibility and validation

- The provider path now accepts bounded linked multi-PSBT groups in addition to
  independent batches. Core proves the linked topology, child provenance,
  shared external-input alternatives, and branch-aware maximum wallet debit
  and fee exposure before one approval is shown.
- The approval presents linked versus independent transaction groups,
  signature rules, deferred zero-fee behavior, shared-funding conflicts, and
  conservative branch limits. Per-transaction details remain lazy, and raw
  unsigned PSBT bytes are excluded from approval technical details.
- The controller binds the ordered PSBT set, declared input indexes, effective
  sighashes, expected transaction IDs, authority, wallet context, topology, and
  approval generation. It signs and returns the complete ordered result or
  none, and never broadcasts this method.
- A fresh single-worker release run passed all 1,391 active tests across 130
  files, with only the expected live-gateway probe skipped. This clean serial
  run avoided the worker-RPC and 5 s load noise observed during earlier
  four-worker attempts.
- Typecheck and lint passed against the exact source.
- The packaged browser suites passed 14 ordinary headless journeys plus 26
  secret-safe journeys; the one skipped case is the expected browser-toolbar
  size limitation. Earlier headed checks passed all 15 ordinary and 26
  secret-safe journeys. Approval action visibility, scrolling, compact widths,
  rejection, and secret-safe states were inspected, and the artifact privacy
  audit passed after each run.
- Real Bitcoin Core regtest passed all 15 extended marketplace scenarios,
  including independent batches, linked groups, exact zero-fee alternatives,
  shared funding, mutations verified by Bitcoin Core, duplicate rejection,
  stale-input rejection, payment, and recovery.
- All 17 marketplace-contract tests, the three pinned marketplace fixture
  subsets, exact-origin policy audit, and twice-built synthetic preview-package
  audit passed.
- The production package audit passed all 66 packaged files and the exact
  20-method provider surface. It verified Store identity, source/provenance
  binding, production channel configuration, content security policies,
  recovery isolation, and absence of development and test payloads.
- An independent ZIP integrity check reopened all 66 entries without error.

Collection and trait offer semantics are displayed only when the marketplace
context is cryptographically bound and verified. A context-free callback still
works and receives an honest structural review; it is not blocked merely because
the wallet cannot safely claim an unverified marketplace label.

## Exact artifact

- Filename: `.output/production/drey-extension-0.14.16-chrome.zip`
- Size: `1,555,681` bytes
- Entries: 66
- SHA-256:
  `29ad3ea97dcaf4ceba5bc9fcb1b9981de2208c288086e2f2cdb304c04ecc7fa6`
- Normalized content digest:
  `281f2d0829a30761ee5d9901ad99bbfc42929d362955fa391bc7e9ad3294f6c9`
- Provenance sidecar:
  `.output/production/drey-extension-0.14.16-chrome.zip.provenance.json`
- Provenance sidecar SHA-256:
  `0c72bd15d832e1cc2599482f27267c667bdde0dbd62092591c544a72d1dd1cc4`
- Manifest SHA-256:
  `2c86c0a38b4a38700df2b0759529eb2ab65df22d73b41b21cf22298803457fe4`
- Extension lockfile SHA-256:
  `cb5c99ab464dd60dd944d278b5680dd00d9ae3685bd7d209bd91ade195d04110`
- Extension source content digest:
  `bb0f0358e2e737ec2badf11533c34dd783602ca94655921c7fa9a835d15aec94`
- Workspace source content digest:
  `41219cbe57993ff9b8808df522b5f42fc3034945765f9963d9e6b92eefd2ea1d`
- Gateway source content digest:
  `942d7cce9a17c6e94c59fa059009e4bad2dc818f05a733175563a9a37b775d47`
- Store manifest public-key SHA-256:
  `ad683bcc15cde48cd6a093b134db76e5fa4b44da0f2bfa9b99c23839c9b1a839`
- Extension ID: `kngidlmmbfmnoeimngkajdlbdenlhgof`
- Manifest version: MV3
- Permissions: `storage`, `alarms`, `idle`, `sidePanel` (unchanged)
- Production gateway origin:
  `https://wallet-api.squirrelsystems.net`
- Production response public key:
  `daabf22693c9b33b7d541877468e200110c2303847fb173bd07c90054852177f`

The ZIP timestamps are normalized to `1980-01-01T00:00:00.000Z`. The archive
and provenance agree on the ZIP hash, content digest, size, entry count,
manifest, Store identity, production mainnet channel, and exact source
bindings. The exact `0.10.1` Store-accepted artifact remains the documented
rollback candidate until this release is accepted.

## Remaining release gates

- Publish and read back Core `v0.19.1` on its public mirror, then dry-run,
  publish, and spot-check the Extension `v0.14.16` public mirror using only the
  approved public-release publisher.
- Archive this exact ZIP and provenance sidecar together in approved release
  storage without changing either file.
- Upload only the ZIP checksum above to Chrome Web Store item
  `kngidlmmbfmnoeimngkajdlbdenlhgof` when that exact Store action is authorized.
- After Store processing, verify the processed package identity, permissions,
  version, review status, release notes, rollout visibility, and rollback
  candidate before distribution.
