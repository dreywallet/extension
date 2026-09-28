# Drey Extension 0.15.9 release evidence

Status: audited local Chrome Web Store candidate; package not uploaded or
submitted by this release work; public source mirrors not published

Prepared: 2026-09-26

## Source identity

- Extension source commit/tag:
  `04f066edac904a185083c636924899bb365be143` /
  `production-v0.15.9`
- Private annotated Extension tag object:
  `071273f2e5efa29c67b942e972e8fce270b61d39`
- Workspace source commit/tag:
  `33d6443288407207d5aa27b5540b1d451187472a` /
  `production-v0.15.9`
- Private annotated workspace tag object:
  `116dd6f87d4a65c3458492cae2fe5350690c6323`
- Gateway source commit/tag:
  `cf4cb60e3df3ce9a2e76dd271f973599e5b0d41a` /
  `production-v0.15.9`
- Private annotated Gateway tag object:
  `9e1e942d57ea7e2787abe241780b1f89786dbf30`
- Shared Core source commit/tag:
  `616a106e2947c85a4d3e472745ec5b06f71b80b5` / `v0.20.6`
- Private annotated Core tag object:
  `c88a19d23c27a5d38391e7b9d9d663386b8def1b`

Core `v0.20.6` and its recovery digest record were pushed to the private Core
remote. The Gateway revision changes only the loopback fixture server; the
deployed production gateway is unchanged by this release.

## Artifact identity

- ZIP: `.output/production/drey-extension-0.15.9-chrome.zip`
- ZIP bytes: `1594673`
- ZIP SHA-256:
  `c4db97a4133c1c620800704eba474952099ab55f02dca975848ba21c604850b0`
- ZIP content digest:
  `6696f3ab37a540d0bda5c558302729905947aa90b0ff81e0f809cbd7ad097b9f`
- ZIP entries: `66`
- Provenance: `.output/production/drey-extension-0.15.9-chrome.zip.provenance.json`
- Provenance SHA-256:
  `d6783d41783a56f7ed3e438154e8937c647b3466023fdb726d96114c3b23d73e`
- Manifest SHA-256:
  `ce5b509a1c7897dfd77defbe6d1a43a82ca7b35e455c0bd7a16058d960c99d29`
- Lockfile SHA-256:
  `3f3bb28bcd31e69e389e804e6e45244c228ca555c06d515a24de3095e053f182`
- Build-output content digest:
  `6696f3ab37a540d0bda5c558302729905947aa90b0ff81e0f809cbd7ad097b9f`
- Standalone recovery tool: source digest
  `e5edf253c90eb8ceb411d2b7cf95748bdc1c722fcd6ef29eaacfbf04bb8bc00a`, artifact
  digest `ac5b7efbd241fa7ca0e3b88e2780165e847a2ca3c4f1b5243b829d9a737d23a8`
  (reproducible across two builds under Node 25.8.1).

The production package and provenance audits passed. The ZIP contains the
reviewed production manifest for Store item `kngidlmmbfmnoeimngkajdlbdenlhgof`
and uses the existing production gateway origin and public verification key.
Its manifest differs from 0.15.8 only in `version`: no permission, host,
content-security-policy, or identity change. The archived 0.15.8 ZIP remains
unchanged at SHA-256
`1a3996aa39e64a7c3646fdce47ddff5c5730224d77378c73ad5a2451d25c4be3`.

## User-facing changes

- A tester holding UNCOMMON•GOODS saw "Runes – Balance unavailable" while a
  second mint was unconfirmed. The production gateway reports every mempool
  output as incomplete, and Core refused the whole account's Rune evidence on
  any incomplete output, so one pending transaction (even unrelated Bitcoin or
  wallet change) hid every Rune balance and blocked Rune transfers until it
  confirmed.
- Unconfirmed outputs now bind as unknown content that can never be selected
  as a Rune input or fee funding; confirmed outputs still require complete
  evidence. Confirmed balances stay visible and sendable, with a note that
  unconfirmed transactions may hold Runes.
- Bitcoin available for Rune fees counts only confirmed outputs, matching the
  transfer planner.
- When Rune balances are unavailable, the service worker logs one bounded,
  data-free reason per change (for example
  `ERR_DATA_STALE/classification_mismatch`).

## Validation

- Diagnosis: the failing behavior was reproduced against the live production
  gateway and through the extension worker's `runeList`; the tester's address
  confirmed a Rune output that was still unconfirmed at the time of the report.
- Core: 112 files and 1,220 tests passed; typecheck and lint passed;
  reproducible recovery verification passed.
- Extension: 137 files and 1,475 tests passed; the one live-gateway probe was
  skipped as expected. Typecheck, lint, production build, package, and audit
  passed. New unit tests fail on the previous Core and pass on v0.20.6.
- Browser E2E: 14 ordinary journeys and 26 secret-safe journeys passed in the
  headed run, with the expected toolbar-platform skip. In the headless run,
  one passkey journey timed out opening its settings page; it passed 6/6 on
  immediate rerun. The E2E artifact privacy audit passed after each run and
  removed the failed journey's trace, which contained the public fixture
  password.
- Real regtest Runes (local Core, ord 0.27.1, Fulcrum, and gateway): the full
  lifecycle journey passed, including a new check that an unrelated
  unconfirmed Bitcoin payment leaves confirmed Rune balances ready, reports
  the unconfirmed output, and is not counted as fee funding. 9 of 13 Rune
  journeys passed. The 4 failures are pre-existing and not release blockers:
  - lost broadcast reconciliation remains `indeterminate` after confirmation
    and fails identically on the pre-fix 0.15.8 source;
  - rediscovery and warm-balance journeys assert the pre-0.15.7 token layout
    and "1 assets" wording changed in `1cd08e8`;
  - the negative-control journey is intermittent (passed on 0.15.8 source and
    2 of 3 fixed-build reruns); the one failure's logged reason was
    `classification_mismatch` after the fixture mined a block with no
    subsequent wallet scan inside the test's 90-second wait.
- Gateway: 39 files and 529 tests passed; two expected probes were skipped.
- Marketplace fixtures, marketplace contracts, marketplace audit, synthetic
  preview packaging, branding, shared-message mirror, and repository
  whitespace checks passed.

## Remaining external gate

The release work did not open, upload to, or submit through the Chrome Web
Store. The release owner must upload only the exact ZIP checksum above, confirm
Store decoding as version 0.15.9 and the existing item identity, review the
listing and permissions, and record the resulting Store state separately.
Public Core and Extension mirrors were not published.
