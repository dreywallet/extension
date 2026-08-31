# Drey Extension 0.14.17 release evidence

Status: audited local Chrome Web Store candidate; package verified, not uploaded
or submitted

Prepared: 2026-08-30

## Source identity

- Extension source commit/tag:
  `4972a510993f4bfedcd1beac4cd6fa0d4ae7832f` /
  `production-v0.14.17`
- Private annotated Extension tag object:
  `754ef4487166ab629e8d30f09757e38738068ee5`
- Workspace source commit/tag:
  `1e93d03bfd9ad9de2e36672ee23ec7a61eca5fe9` /
  `production-v0.14.17`
- Private annotated workspace tag object:
  `034e70278e6ddc7f9964a0b1a748f3622c6d1c21`
- Gateway source commit/tag:
  `111f042ba124dce6feed5799eaf2f348bd31e22d` /
  `production-v0.14.8`
- Private annotated Gateway tag object:
  `61a758702406898e1aea80b69ede4babbffafa59`
- Shared Core source commit/tag:
  `4f923355e59faa559e342eb34cbbb9cbfc5eaca9` / `v0.19.2`
- Private annotated Core tag object:
  `e17f5eb1b4c28e7bd32c12da3c4ae71ff08ca343`
- Public Core `v0.19.2` commit:
  `3808938dd56a8577b22dcb1a6585614193fa1f60`
- Public Extension `v0.14.17` commit:
  `3385d579a6c616457e4b6d21fdee48932d166e92`

The private source tags were pushed and read back. Core was published first,
then Extension was exported and published only through the audited public
release tool. Each public lightweight tag points directly to its single
squashed release commit; the public Extension lock resolves Core to the public
Core commit above.

## Validation

- All 1,391 active Extension tests passed across 130 files; only the expected
  live-gateway probe was skipped. Typecheck and lint passed.
- The packaged browser suite passed 14 ordinary journeys and 26 secret-safe
  journeys. The browser-toolbar size case was the single expected skip.
- The E2E artifact privacy audit passed after the packaged tests.
- The production package audit passed all 66 packaged files and the exact
  20-method provider surface. ZIP integrity passed independently.
- Core v0.19.2 tightens fee, destination, signature, freshness, permission,
  scan-history, preview, duplicate-input, and fragmented-input selection checks
  without adding a new user step or permission.

## Exact artifact

- Filename: `.output/production/drey-extension-0.14.17-chrome.zip`
- Size: `1,556,446` bytes; entries: 66
- SHA-256:
  `def4e0884d4ee5fd5fef79e9e4647a9d65db894fcc819d93e9255c233286d5f1`
- Normalized content digest:
  `24f3827d8d648286aa9f738ad373c9dd1c89823c21899f16c89177cd16c0bbed`
- Provenance sidecar:
  `.output/production/drey-extension-0.14.17-chrome.zip.provenance.json`
- Provenance sidecar SHA-256:
  `e27c9f282269c7e035a60de218feab5f570bdb89daf995c0614f986b18a0d107`
- Manifest SHA-256:
  `a6f028b85fcfd2e45bc0156a89b5d9edc08e90111421019ba2d53da21aefe8d4`
- Extension lockfile SHA-256:
  `114c386c6cd99998d913c41d1ddbbd225ab0bc39bf88f8563561cb145a5e5bea`
- Extension source content digest:
  `c9db45b500f02bc0481af5e4c6d94c39d14da6c67c9ddd65d67c95b1a2e20acb`
- Workspace source content digest:
  `8f560eacc0b481ecb8250d2257e3f0b954de44cdc47a0b9635c871c9c0b3e196`
- Gateway source content digest:
  `942d7cce9a17c6e94c59fa059009e4bad2dc818f05a733175563a9a37b775d47`
- Extension ID: `kngidlmmbfmnoeimngkajdlbdenlhgof`
- Manifest version: MV3
- Permissions: `storage`, `alarms`, `idle`, `sidePanel` (unchanged)
- Production gateway origin: `https://wallet-api.squirrelsystems.net`

The archive and provenance agree on the ZIP hash, normalized timestamp,
content digest, entry count, Store identity, production channel, and exact
source bindings.

## Remaining Store gates

- Archive this exact ZIP and sidecar together in approved release storage.
- Upload only this ZIP to Chrome Web Store item
  `kngidlmmbfmnoeimngkajdlbdenlhgof` after that Store action is authorized.
- Verify the processed package, permissions, review status, release notes,
  rollout visibility, and rollback candidate before distribution.
