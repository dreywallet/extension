# M8T local E2E harness

This harness validates the unpacked **test-channel** extension against a
loopback-only dapp and gateway. It is not a deployment test and does not create a
distributable preview. Use only the committed public signet fixture mnemonic or a
new disposable signet wallet.

## Prerequisites and quick start

- Install the repository's pinned dependencies with the lockfile.
- Install the Playwright Chromium version associated with the pinned
  `@playwright/test` package. Do not substitute a system browser for automated
  acceptance.
- Ensure no real wallet profile or credentials are present in the test workspace.
- Do not make the fixture servers remotely reachable.

From `extension/`:

```bash
pnpm build:test
pnpm test:e2e
pnpm audit:e2e-artifacts
```

The normal run is headless and single-worker. For a visible acceptance pass:

```bash
pnpm test:e2e:headed
pnpm audit:e2e-artifacts
```

For interactive diagnosis only:

```bash
pnpm test:e2e:ui
```

Do not use UI mode as acceptance evidence. Reproduce the result with the headed or
headless command and re-run the artifact scanner.

## What the harness starts

The documented commands build `.output/test/chrome-mv3`; the harness then requires,
loads, and audits that directory as an unpacked MV3 extension in a temporary
persistent Chromium context. It discovers the
extension ID and worker rather than assuming a transient URL, listens for real
approval windows, and can terminate the service worker through CDP. Every test
gets a fresh persistent profile that is removed in fixture teardown. Playwright
still uses one worker because fixture state, ports, and approval windows are
process-scoped within each test.

Two dependency-free local services are test infrastructure only:

1. The dapp serves provider-discovery/connect/deny/read/disconnect/reload,
   BIP322-signing, and `sendTransfer` exercises, including a same-origin iframe.
2. The E2E gateway entrypoint serves resettable healthy, full-safety,
   converging, stale, wrong-network, invalid-signature, unavailable,
   recoverable-broadcast, and same-txid incoming mempool-to-confirmed scenarios.

Both services must bind to loopback. The fixture control surface is allowed only
on the E2E gateway entrypoint; the ordinary gateway server must return no test
controls. Never deploy either service or its committed public signing key.

M9P adds deterministic signed inscription metadata and inert-preview scenarios
to that same loopback gateway. The ordinary gateway remains fixed: mismatch,
stale-revision, failed-preview, and cache-substitution controls exist only on the
E2E entrypoint. Approval preview bytes are rendered in the manifest sandbox page,
which has an opaque origin, no extension APIs or storage, and a CSP that prohibits
all networking. The approval and full-page surfaces never load an inscription,
marketplace, IPFS, or renderer URL.

The pulled-forward gallery uses the same signed identity and inert-preview
contract. Active media is opened only by user action in a second opaque-origin
manifest sandbox. Its bytes are content-addressed, size/MIME/magic checked,
never persisted, and guarded by a worker-memory lease that becomes invalid
after service-worker restart. It has no extension/provider APIs, storage,
opener, navigation, or network access.

The gallery paint-ahead caches are covered at both boundaries. Reopening the
popup destroys its document while the 4 MiB `chrome.storage.session` L1
survives. Reloading the extension ends that unlock and clears L1; after a new
unlock, the 32 MiB DEK-sealed IndexedDB L2 supplies only exact current
identities and repopulates L1. `galleryBatchAttempts()` covers request counts,
and the E2E-only ordered request log proves that an exact settled preview is not
requested again even when genuinely pending placeholders retry; current
ownership/classification still comes from the worker.
`galleryBatchDelayMs` (E2E control only, cleared by reset, alongside
`snapshotDelayMs`) widens the window in which a surface has painted but no
batch has answered, because a loopback fixture answers far faster than any real
gateway.

## Acceptance coverage

The automated suite covers:

- Create-wallet with mandatory randomized backup verification, plus
  public-fixture restore and account scan; secret-visible steps use the
  restricted artifact policy below.
- Lock, unlock, worker-restart persistence, and locked-screen privacy.
- Receive QR rendering under the packaged extension CSP, compact-layout asset,
  overflow, clipping, and console-error checks; primary navigation, accounts,
  profile-wide accent, and language preferences.
- Side-panel packaging and sender authority; responsive layout at 320, 392, and
  wider widths; and a headed trusted-click launch from the real toolbar popup.
  The same check proves the toolbar action remains the fixed popup by default.
- Native send review, cancel, approve, sign, broadcast, and recoverable failure.
- Provider discovery, connect approval/denial, account/network reads, permission
  revocation, reload, BIP322 signing, and transaction approval.
- Provider injection and request recovery in both the top frame and iframe.
- M9 unknown/new marketplace behavior: deterministic requests retain the
  existing Advanced route, while the loopback dapp's flexible marketplace
  request is rejected with the stable unsupported-marketplace error. This proves
  fail-closed discovery only; pinned Satflow/ord.net templates are mainnet-only
  and are not activated by the signet harness.
- Worker termination during unlocked sessions, scanning checkpoints, permission
  grant/revoke, same-document provider reconnection, reviewed transactions,
  failed-broadcast recovery, and pending approvals. A pending approval must fail
  stale after the worker that created it is terminated.
- Live wallet synchronization with a signed incoming payment that appears once
  as pending, keeps the same txid after fixture confirmation, and updates
  Activity, Recent Activity, and balance after the popup is hidden and resumed.
- Signed pending-Ordinal synchronization: a degraded classification carries an
  inscription identity only after verified sat flow, displays separately from
  generic pending bitcoin, remains outside Available and gallery inventory, and
  becomes authoritative Protected inventory under the same txid after fixture
  confirmation.
- Transient gateway convergence UX: ordinary signed tip/classification
  convergence stays hidden for ten seconds while retrying every second, then
  appears as a compact `Syncing` status without moving the balance card or
  following content. Stale heartbeats and other non-routine failures appear
  immediately and continue retrying until recovery.
- M9P signed raster and signed-placeholder approvals; received, sent, retained,
  multi-inscription, and co-located presentation; explicit unavailable-preview
  acknowledgement; identity/provenance mismatch blocking; sandbox capability and
  network denial; and preview invalidation/refetch behavior after worker restart.
- Gallery All/Hidden state; Hide/Unhide persistence; signed
  gallery ordering; hostile active-media rejection; valid media rendering in
  the separate sandbox; and lease invalidation across forced MV3 restart.
- Locked-wallet heap hygiene: after a public-fixture restore and lock, neither
  the recovery phrase nor the app password remains reachable in the MV3 service
  worker heap or in the renderer that previously hosted onboarding.

Tests select deterministic fixture scenarios through the harness, not through
production code or environment fallbacks. External balance, scanning, fee, send,
and broadcast remain disabled for a local preview build until G2/G3 supplies the
approved remote signet gateway.

## Heap hygiene suite

`tests/e2e/heap-secrets.spec.ts` proves that locking actually releases secrets,
rather than only hiding them. It restores the public signet fixture, locks, and
then takes a V8 heap snapshot of both the MV3 service worker and the extension
renderer, asserting that neither the fixture phrase nor the test password is
still present.

Three properties keep it trustworthy:

- **Snapshots never reach disk.** Chunks are scanned as they stream and
  discarded; `tests/e2e/heap-scanner.ts` carries a bounded tail between chunks
  so a value split across a boundary is still found. `audit:e2e-artifacts`
  independently rejects any retained `.heapsnapshot`, `.heapprofile`, or
  `.heaptimeline` file, whatever it contains.
- **Findings are labels, never values.** A failure names the secret that leaked;
  it never prints it, so the failure report cannot become the leak.
- **Every run carries a positive control.** A sentinel string is planted
  immediately before each snapshot and must be reported by the same scan that
  reports the secrets absent. A scanner that silently matched nothing would fail
  the run instead of passing it.

Because Playwright's `newCDPSession` accepts only a Page or Frame, the service
worker — the heap that holds the unlocked DEK — is unreachable through the
normal API. This suite therefore launches its **own** disposable context with an
ephemeral loopback `--remote-debugging-port` and opens a DevTools socket onto
the worker target. No other suite opens a debugging port, the profile is removed
even when the browser or the test fails, and the wallet involved is always the
disposable signet fixture. The suite runs under the `secret-safe` project, so
traces, video, and screenshots stay disabled for it.

## Artifact safety

For non-secret tests, screenshots, video, and traces are retained only on failure.
The create/restore and heap-hygiene projects run separately with list-only
reporting and disable trace, video, and screenshots. The wrapper runs the scanner
even when a browser test fails and deletes the full artifact set if privacy
cannot be proven.

The scanner is a release gate:

```bash
pnpm audit:e2e-artifacts
```

It scans reports and nested trace contents for BIP39 sequences, passwords,
private-key/entropy/DEK field names and values, OCR text from images/video, and
wallet data or inscription IDs outside the explicit public-fixture allowlist. It
also rejects raw inscription source media and serialized preview byte payloads in
reports or nested traces, and rejects any retained V8 heap dump outright. A
scanner failure means the artifact set is unsafe:

1. Do not open it in an external viewer, attach it to an issue, copy it to shared
   storage, or upload it.
2. Find and fix the capture source.
3. Remove the unsafe local output through the harness cleanup path.
4. Re-run the affected test and scanner.

Persistent browser profiles are never evidence and must never be retained. Test
output, reports, profiles, screenshots, traces, and videos must stay ignored by
Git. Redaction is not permission to use a real seed or password.

The packaged Recovery Center overview has one additional safe presentation path:

```bash
pnpm exec playwright test tests/e2e/recovery-center.spec.ts --project extension
pnpm audit:e2e-artifacts
```

It opens the real full-page Recovery Center with fixed, non-secret test-channel
status responses for Spending and Vault readiness. The fixture accepts only the
named overview scenarios and the expected synthetic session; ceremonies and
mutations fail closed. Its deliberate screenshots stay below
`test-results/e2e/extension/`. Run the artifact audit before opening any image.
The matrix covers English and Spanish, all three accents, narrow and desktop
sizes, and the product's intentionally dark-only theme.
The compile-time test branch and fixture marker are absent from production,
next-version, preview, and pilot artifacts.

## Preview and production checks

Keep channel checks distinct:

```bash
pnpm build
pnpm zip
pnpm audit:production
pnpm build:test
pnpm test:e2e
pnpm audit:e2e-artifacts
pnpm build:preview
pnpm test:preview-package
```

For manual next-version UI work that must exercise the live mainnet production
gateway without changing the submitted Store artifact, use:

```bash
pnpm build:next
```

This writes an unpacked production-channel build to
`.output/next/chrome-mv3`. It is mainnet-only, uses the reviewed production
gateway origin, response public key, and Store manifest identity, and therefore
must be loaded only in a separate local browser profile. It is not an audited
release artifact: do not package, distribute, or represent it as the submitted
Store version. The command never overwrites `.output/production` or the
deterministic release ZIP. Any mainnet wallet ceremony remains manual and no
recovery material may enter automation, screenshots, traces, logs, or chat.

The site-request approval surface can also be reviewed without a supported
site, wallet, gateway, or funds:

```bash
pnpm approval:gallery
```

Open the printed loopback URL and switch among the synthetic connection,
payment, marketplace, fee-warning, and Advanced PSBT requests. The gallery
imports the real approval component but lives outside `src/entrypoints`, builds
only to `.output/approval-gallery`, and replaces approval actions with local
status messages. `build` and `build:next` scan their output and fail if the
gallery's isolation marker or path appears in the extension artifact.

The first group verifies that production remains mainnet and retains its existing
identity and security checks. The test build drives the local harness. The final
preview command must fail closed while the dedicated HTTPS preview origin,
Ed25519 public key, and preview Store manifest public key are absent. Do not reuse
the production origin, production identity, or public fixture key to make it pass.

`pnpm test:preview-package` builds a marked synthetic preview, packages it twice,
compares the hashes, runs the byte-level fixture audit, deletes both ZIP/sidecar,
and restores the test build. The real `zip:preview`/`audit:preview` path stays
source-gated until G2/G3 and Store ownership are approved. When a real preview
artifact is eventually authorized, it must prove beta identity and
icons/banner, signet lock, exactly one HTTPS preview origin/key, live gateway
disablement, distinct manifest identity/storage, exact permissions/provider
surface, no development/production fallback, no remote/HMR code, no source maps,
and no private keys. The deterministic ZIP must have sorted entries and normalized
timestamps; its sidecar binds the ZIP SHA-256 to extension revision/content digest,
lockfile hash, manifest, gateway fixture revision, and channel configuration.

## Full local gate

Run the aggregate single-worker gate when making a handoff:

```bash
pnpm ci:m8t
```

For M9 work, first validate the pinned offline contracts and then retain the
complete M8T gate:

```bash
pnpm fixtures:marketplaces:check
pnpm test:marketplace-contracts
pnpm audit:marketplaces
pnpm ci:m9
```

The focused M9P gate also carries the pulled-forward gallery/media boundary. It
runs gateway/analysis/worker/UI/privacy tests, typecheck, lint, test-channel
build and audit, both actual-extension sandbox suites, and the artifact privacy
audit:

```bash
pnpm ci:m9p
```

M9X extends the same loopback-only harness with native single-inscription Send,
wrong-lane Rescue, and one-outpoint Sweep entry points. It covers co-located
target rejection, non-Taproot acknowledgement, immutable-plan restart/refetch,
preview and fee replacement boundaries, accepted and indeterminate broadcast,
and action-specific activity without adding gateway control routes.

Native multi-inscription transfer builds on that boundary without widening the
provider dapp. The popup gallery has a temporary selection mode, requires all
inscriptions from every selected output, confirms co-located IDs as one atomic
group, and caps a request at 16 inscription IDs. Focused worker tests prove the
ordered protected inputs and postage outputs, clean fee-only funding, compact
review model, immutable v4 plan, final-byte validation, and fail-closed
incomplete selection. Focused UI tests cover the same-sat prompt, explicit
`Select all from this output` repair, 16-ID cap, and session clearing.

The current loopback snapshot fixture exposes one three-inscription protected
output, so browser acceptance can exercise the gallery entry and one-source
atomic transaction only. A truthful 16-item multi-source signet E2E requires a
new signed gateway snapshot/classification fixture plus sixteen allowlisted inert
previews. Until that fixture lands, maximum-batch, changed-source replacement,
multiple-top-up rejection, and insufficient-clean-fee coverage remain shared
core/worker tests rather than being mislabeled as browser E2E evidence.

Run the focused launch-UX gate with:

```bash
pnpm ci:m9x
```

The gate runs the inherited M9P checks, focused M9X unit/UI suites, the
secret-safe `@m9x` browser scenarios, and the artifact privacy audit. Store
publication and real mainnet transfer/rescue/sweep confirmation remain manual
production-checklist evidence.

This focused gate supplements rather than replaces the complete
production-package, headed, and headless commands.

The marketplace result is fixture-backed. It must not be described as live
Satflow or ord.net interoperability until the vendor/test-environment gates in
[`marketplace-templates.md`](marketplace-templates.md) pass.

Record headless and headed outcomes, approval-window behavior, scanner outcome,
and any safe failure artifact inspected. Automation covers Playwright Chromium.

For the audited disposable mainnet pilot on macOS, the no-wallet portion of the
current-browser lifecycle matrix is automated separately:

```bash
pnpm build:pilot
pnpm audit:pilot
pnpm test:pilot:browsers
pnpm audit:pilot
```

`test:pilot:browsers` fails unless `.output/chrome-mv3` is the canonical
`Drey PILOT` mainnet artifact bound to the current extension and gateway heads.
It creates and deletes dedicated Chrome and Brave profiles, uses Chromium's
unpacked-extension debugging protocol, opens the real action-popup target,
checks its 392×600 layout, verifies the packaged side-panel capability without
changing the toolbar default, probes signed gateway readiness, rebuilds and reloads
only the pilot channel, verifies local/session storage lifecycle, and exercises
provider removal plus uninstall/reinstall. It records no screenshots, traces,
videos, wallet data, or profile.

Chrome 116+ is the required side-panel acceptance browser. Brave is best-effort:
when its Chromium build exposes `chrome.sidePanel.open`, the harness records it;
when the API differs, the popup lifecycle must still pass and is the supported
fallback. A missing local Brave installation is reported as a skip rather than
blocking the required Chrome result.

The protocol loader is session-scoped in current branded Chrome, so the harness
must reload the exact audited path after a full Chrome process restart. It
therefore does not prove that a hand-loaded Developer Mode card or toolbar pin
persists. Real wallet create/restore, lock/unlock, locked-state restart privacy,
the visible Developer Mode reload button, pin placement, reset, and recovery
remain manual clean-profile gates. Never put pilot recovery material into this
or any other automation.
