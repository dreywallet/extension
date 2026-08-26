# Drey

A non-custodial Bitcoin L1 and Ordinals browser extension (Chrome MV3), built with
[WXT](https://wxt.dev) and React.

Drey holds keys locally, never transmits recovery material, and talks to a signing-aware
API gateway that returns **signed** chain snapshots the extension verifies independently.
The gateway is a separate service; its repository is not published yet.

This repository is the public release mirror of a private working repository: history
here is one squashed commit per release. See `CONTRIBUTING.md` before opening a pull
request.

## Status

Published to the Chrome Web Store as item `kngidlmmbfmnoeimngkajdlbdenlhgof`.
The current source adds native Bitcoin batching, atomic one-recipient
inscription transfers, and deliberate collectible-postage management. Reviewed
ord.net single-inscription flows are enabled; unknown or unsupported
marketplace shapes still fail closed. See `docs/marketplace-templates.md`.

Web applications can integrate the promise-based JSON-RPC provider at
`window.drey` through WBIP004 discovery or Sats Connect Core. See
[`docs/wallet-provider.md`](docs/wallet-provider.md) for the public contract,
examples, and capability matrix.

## Optional side panel

Chrome 116 and later can keep the full wallet open in the browser side panel.
The toolbar button still opens the fixed `392 × 600` popup by default; use the
split-panel button in a stable popup screen to open the persistent surface. The
panel always starts on the Bitcoin dashboard, so receive/send drafts and dapp
approval state are never transferred. Settings and advanced transaction pages
continue to open as full pages, and website approvals continue to use their
dedicated review window.

An open panel does not keep an unlocked wallet alive. It follows the configured
idle deadline, clears sensitive content immediately on lock, pauses routine work
while hidden, and refreshes wallet data only for navigation, explicit actions,
or wallet events. Chromium variants that do not expose the side-panel API simply
omit the launcher; the toolbar popup remains fully functional.

## Build channels

The build channel is compile-time policy, pinned in `src/build/channel.ts` — not
configuration. Remote metadata and environment variables can never activate an origin,
key, or allowance.

| Channel | Network | Gateway |
| --- | --- | --- |
| `build` (production) | mainnet | `https://wallet-api.squirrelsystems.net` |
| `build:test` | signet | loopback `127.0.0.1:18080` |
| `build:preview` | signet | dedicated preview origin (source-gated) |
| `dev` | signet | loopback `127.0.0.1:8080` |

`zip`, `audit:production`, and `zip:preview` fail closed until the reviewed release gates
(response public key, Store manifest key, item ID, clean worktrees, exact release tags) are
all present. That is intentional: a clone cannot accidentally produce something that looks
like a signed release.

## Getting started

Requires Node 22+ and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm dev            # signet, loopback gateway
pnpm test           # unit + integration (vitest)
pnpm typecheck
pnpm lint
pnpm build          # production build, inspectable output in .output/production
```

`@drey/core` is pinned by exact git tag. A few checks compare this repository against a
sibling core checkout and skip themselves when one is not present; to run them, clone
the core repository next to this one at the pinned tag:

```bash
git clone --branch v0.17.6 https://github.com/dreywallet/core.git ../core
```

`pnpm test:marketplace-contracts` runs the marketplace contract suite from that sibling
checkout and fails without it.

A standalone public clone can run `pnpm build` for an inspectable unpacked
extension. Its build metadata records the unavailable private workspace and
gateway provenance explicitly. `pnpm zip` and `pnpm audit:production` remain
release-only commands and fail closed without the exact reviewed private tags
and source bindings.

### End-to-end tests

`pnpm test:e2e` drives a real Chromium profile with the unpacked `build:test` output. It
requires the gateway repository checked out **as a sibling directory** (`../gateway`),
because Playwright starts the gateway's loopback fixture server:

```
parent/
├── extension/   ← this repo
└── gateway/     ← gateway repository (not yet published)
```

Without that sibling, `pnpm test` still passes in full — the fixture-drift test detects the
missing checkout and skips — but `pnpm test:e2e` will not start.

Always run `pnpm audit:e2e-artifacts` after an E2E run and before viewing or copying any
artifact. It scans reports and nested traces for BIP-39 sequences, passwords, and key
material, and its failure is meant to block artifact upload. Browser profiles are created
under the OS temp directory and deleted afterwards; never commit or upload them.

## A note on committed keys and test vectors

This repository contains **no secrets**. Automated secret scanners flag three things here,
and all three are intentional and safe:

- **`src/build/channel.ts`** pins an Ed25519 gateway response key, an RSA Store manifest
  key, and the Store item ID. These are **public halves** used to *verify* signatures and
  to derive a stable extension ID. The corresponding private keys exist only in protected
  gateway storage and in the Chrome Web Store, never in source. The item ID is derivable
  from the manifest key and is public by construction.
- **`tests/fixtures/bip39-trezor-vectors.json`** contains `abandon abandon … about` — BIP-39
  Trezor test vector #1, the most widely published mnemonic in existence, holding no funds.
  It is loaded from JSON at runtime so that not even this non-secret phrase is bundled into
  test report source.
- **`tests/transactions/bip322.test.ts`** contains WIF private keys taken verbatim from the
  [BIP-322 specification](https://github.com/bitcoin/bips/tree/master/bip-0322) test
  vectors. They are published, unfunded, and held by no one.

Real wallet recovery material is only ever handled through the wallet's user-facing
ceremony. It is never accepted in tests, fixtures, command arguments, or logs.

## Security

Please report suspected vulnerabilities privately rather than opening a public issue —
see [`SECURITY.md`](SECURITY.md).

## License

[GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`).
