# Drey Extension 0.16.0 release evidence

Status: audited local Chrome Web Store candidate; package not uploaded or
submitted by this release work; public source mirrors not published

Prepared: 2026-09-28

## Source identity

- Extension source commit/tag:
  `3df45a64c3b4c26d03e69777a736ef5e90ef573a` /
  `production-v0.16.0`
- Private annotated Extension tag object:
  `66190285d97e4abb6bef51c66fecab1c0cc8eec8`
- Workspace source commit/tag:
  `57f0bb11b62486e23949e7e0e886d4b7615b9c38` /
  `production-v0.16.0`
- Private annotated workspace tag object:
  `98d7eb04d60fe333849366b7bf306afae3d096ed`
- Gateway source commit/tag:
  `da11791bb28177a863c91c378aedbed29cfaeaa3` /
  `production-v0.16.0`
- Private annotated Gateway tag object:
  `786b7146b0dd37b0c05376cf3ff613fc7aa2cb47`
- Shared Core source commit/tag:
  `c0876cd73bc4c1a149beca747be2383a15b0792a` / `v0.20.8`
- Private annotated Core tag object:
  `252fc30b170f8d4f406f26f196c435cd4b3eba9d`

The Gateway revision is the already-deployed audit-hardening release; this
extension release does not change or redeploy the production gateway.

## Artifact identity

- ZIP: `.output/production/drey-extension-0.16.0-chrome.zip`
- ZIP bytes: `1599422`
- ZIP SHA-256:
  `78c29142e7daa53b00dcc45870e1cd4bf38bdd30e5dc1a37100625a5a110230c`
- ZIP content digest:
  `d434bb8108c61811a42337013b6e9335ddc591b319f6baab065e75315ad57fa7`
- ZIP entries: `66`
- Provenance: `.output/production/drey-extension-0.16.0-chrome.zip.provenance.json`
- Provenance SHA-256:
  `ebfb208d37a3dd46932a9d7bbb6bba9db4f6db01c0925a62b9800ded549265cb`
- Manifest SHA-256:
  `ebe822a03880d6c19cd08ff774c280ae55a6f4b236c543a0045a805e21ff0345`
- Lockfile SHA-256:
  `ed7470099d96143d1ec244bc3f008c5cf99e273ce4afe4dd2d63f2e46b59ebcd`
- Build-output content digest:
  `d434bb8108c61811a42337013b6e9335ddc591b319f6baab065e75315ad57fa7`
- Standalone recovery tool (Core `v0.20.8`, recorded in Core
  `recovery/RELEASES.md`): source digest
  `d0fd66275e89818c179e61e1d62834d99eda230554d04255280cd53373a5035c`, artifact
  digest `ca61941830fb1a33a142da8551604e66239c4adb5b68ba8900923ec5beb9162f`,
  matching the extension's pinned kit binding.

The production package and provenance audits passed (66 files, 20 provider
methods). The ZIP contains the reviewed production manifest for Store item
`kngidlmmbfmnoeimngkajdlbdenlhgof` and uses the existing production gateway
origin and public verification key. Its manifest and channel configuration
differ from 0.15.9 only in `version`: no permission, host,
content-security-policy, or identity change. The archived 0.15.9 ZIP remains
unchanged at SHA-256
`c4db97a4133c1c620800704eba474952099ab55f02dca975848ba21c604850b0`.

## User-facing changes

See `CHANGELOG.md` 0.16.0 and `docs/store-release-notes-0.16.0.md`. In short:
first-run onboarding on install, direct backup resume, send available
balance with Max, sealed per-account send drafts, inline send errors, fee
choices shown as estimated cost and minutes, a review that leads with amount
and destination, a forgotten-password explanation (no data deletion), one
Back control and button style, and popup links that reuse an open wallet tab.
It also packages the unreleased core v0.20.8 adoption and the added-wallet
password and accepted-broadcast reporting fixes.

## Validation

- `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`: passed.
- `pnpm test`: 1,512 passed, 1 skipped live-gateway probe.
- `pnpm build`, `pnpm zip`, `pnpm audit:production`: passed.
- `pnpm test:e2e` on the release UI: 14 extension and 26 secret-safe tests
  passed, followed by a passing `pnpm audit:e2e-artifacts`. One earlier run had
  a single secret-safe provider-approval failure that did not reproduce alone
  or in the next full run.
- Mobile shared-catalog mirror: 1,190 tests passed.
- Regtest suites were not run for this release; the two regtest specs updated
  for the new send review layout are unexecuted.

## Rollback

The Store-accepted 0.10.1 artifact remains the documented rollback candidate
until this release is accepted; archived 0.15.9 is the previous candidate.
