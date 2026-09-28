# Drey Extension 0.15.8 release evidence

Status: audited local Chrome Web Store candidate; public source mirrors
published; package not uploaded or submitted by this release work

Prepared: 2026-09-19

## Source identity

- Extension source commit/tag:
  `219068d5a5629080e44702514ffebee2cf44ed1a` /
  `production-v0.15.8`
- Private annotated Extension tag object:
  `c0c7fae52c459d27df6561730f519f054bad8693`
- Workspace source commit/tag:
  `a3e1f5adc2a166361880f6381ca43c6ba2ec65cc` /
  `production-v0.15.8`
- Private annotated workspace tag object:
  `253fefcaff47423ed3b5018e8f9cb1cd0737cf0a`
- Gateway source commit/tag:
  `2c83ffd0e2f065986e2f5ab2086a08b77cd91a51` /
  `production-v0.15.8`
- Private annotated Gateway tag object:
  `9c79f47fea24e9cfff85b41fd33f8a525a9ea524`
- Shared Core source commit/tag:
  `9e4c2c1bca9edbec230eb26425e5fb6865c106c1` / `v0.20.5`
- Private annotated Core tag object:
  `1b85da1847e7fa7d36e633affee30bd388fe36e1`
- Public Core `v0.20.5` commit:
  `c562ece031330176fe6e074b7ed6b9fff85003ea`
- Public Extension `v0.15.8` commit:
  `2de52d4575b700f53f2ed19278a8189c57996a0f`

The private source tags were pushed and read back. Core was published first,
then Extension was exported and published only through the audited public
release tool. Each public lightweight tag points directly to its one squashed
release commit. The public Extension dependency and lockfile resolve Core to
the public Core commit above.

## Artifact identity

- ZIP: `.output/production/drey-extension-0.15.8-chrome.zip`
- ZIP bytes: `1594164`
- ZIP SHA-256:
  `1a3996aa39e64a7c3646fdce47ddff5c5730224d77378c73ad5a2451d25c4be3`
- ZIP content digest:
  `71d1d3f0e2ef6edd9152346acaa6d4e1f1d589835e500ad2737a6bdb5bd4a2f1`
- ZIP entries: `66`
- Provenance: `.output/production/drey-extension-0.15.8-chrome.zip.provenance.json`
- Provenance SHA-256:
  `5e91a53b1d3ca871c8f0dc2fdce9e41e388b6da787dff272b0496b821887ba03`
- Manifest SHA-256:
  `a8cdd93ea44b20ac07291034dae730f51e13ea5f9791c0b576196b67348372c4`
- Lockfile SHA-256:
  `3753cc2e4b3153bdd89079f5dc2e08a1433e6ed6ead5c5d76563914907080185`
- Build-output content digest:
  `71d1d3f0e2ef6edd9152346acaa6d4e1f1d589835e500ad2737a6bdb5bd4a2f1`

The production package and provenance audits passed. The ZIP contains the
reviewed production manifest for Store item `kngidlmmbfmnoeimngkajdlbdenlhgof`
and uses the existing production gateway origin and public verification key.

## User-facing changes

- Exact wallet-created payment change remains visible while its transaction is
  unconfirmed without trusting unrelated mempool outputs.
- Coin control shows the verified address, role, and effective value of each
  coin and can send one or more explicitly selected eligible coins.
- Transaction review labels the PSBT fingerprint as an identifier rather than
  transaction data and shows recipient and change addresses.
- Compatible Xverse nested-SegWit holdings are discovered and shown as
  recovery-only instead of being misclassified as spendable.

## Validation

- Core: 112 files and 1,200 tests passed; typecheck, lint, fixtures, vectors,
  and reproducible recovery verification passed.
- Extension: 137 files and 1,469 tests passed; the one live-gateway probe was
  skipped as expected. Typecheck, lint, production build, package, and audit
  passed.
- Browser E2E: 14 ordinary journeys and 26 secret-safe journeys passed in both
  headless and headed runs, with the expected toolbar-platform skip. The E2E
  artifact privacy audit passed.
- Real regtest: ordinary payment with pending change and an exact manually
  selected UTXO spend passed against an isolated Docker project.
- Gateway: 39 files and 526 tests passed; two expected probes were skipped.
- Marketplace, preview-isolation, production-bundle, branding, shared-message,
  instruction-parity, and all repository whitespace checks passed.

## Remaining external gate

The release work did not open, upload to, or submit through the Chrome Web
Store. The release owner must upload only the exact ZIP checksum above, confirm
Store decoding as version 0.15.8 and the existing item identity, review the
listing and permissions, and record the resulting Store state separately.
