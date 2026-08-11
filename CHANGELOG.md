# Changelog

Notable user-facing changes to Drey are recorded here. For earlier releases,
see the production release tags in the repository.

## 0.10.3

### Changed

- Housekeeping for the public source release: contribution and security
  policies, public repository metadata, and documentation cleanup. No
  functional changes.

## 0.10.1

### Changed

- Sign a one-click inscription listing on any HTTPS origin. A flexible
  `signPsbt` that carries no marketplace context now reaches core analysis
  instead of failing closed, and core either proves the listing invariants —
  every `SINGLE` payout returns to the active account at no less than the
  listed input value, wallet-owned outputs cover the full wallet input value,
  and no rare-sat or unsupported inputs, script paths, or mixed deterministic
  wallet signatures are present — or rejects the request. Every other flexible
  shape still fails closed.
- Gate the Advanced-signing setting on the plan's computed requirement instead
  of on the absence of a marketplace, so proven generic listings and recognized
  templates no longer need the Advanced ceremony while an arbitrary PSBT still
  does.
- Price sanity remains disclosed rather than enforced: approval shows the exact
  payout.
- Consume `@drey/core` v0.7.6.

## 0.10.0

### Added

- Enable ord.net single-inscription trading, re-derived from the vendor's
  published Trading API 1.0.0 contract with preflight handle and expected-txid
  echo binding. This covers the template-backed flows — authentication,
  purchase, offer, cancellation, and transfer — that a generic listing does not.

### Changed

- Consume `@drey/core` v0.7.5 and scope the marketplace activation gate to the
  reviewed ord.net inscription set. Satflow and the ord.net v2
  collection/trait funding-parent design stay fixture-backed and blocked, batch
  listings fail closed, and the pinned sale co-signer key hard-fails on
  rotation because the vendor publishes no rotation contract.

## 0.9.6

### Changed

- Open wallet and account controls together in a focused **Wallets & accounts**
  page, directly from the account menu.
- Keep the active wallet and account visually grouped, with clearer paths to
  manage accounts, switch or remove wallets, and add another wallet.
- Explain the coin-freezing control where it is used.

## 0.9.5

### Added

- Browse verified collectibles through compact collection shelves before
  opening the existing two-column collection view.
- Share a locally generated Bitcoin payment-request image without uploading
  wallet information.
- Follow transaction progress through a compact, status-aware Block Trail.

### Changed

- Keep Receive focused on its QR code and exact address; the richer payment
  card is generated only when **Share request** is used.

## 0.9.4

### Fixed

- Keep a collectible's full-screen media bound to the item it was opened from.
  A media response that arrives after the viewer was closed, or after the
  active wallet or session changed, is now discarded, and the media frame is
  re-keyed per lease so it cannot briefly show the previously opened
  inscription.
- Wait for the IndexedDB transaction to commit before treating a wallet-cache
  write or delete as complete, so cached wallet data is not lost when the popup
  closes immediately afterwards.

## 0.9.3

### Fixed

- Paint locally cached collectible previews immediately after reopening Home,
  once their account, ownership location, classification, and visibility have
  been revalidated against current encrypted wallet state.
- Show a settled unavailable preview as unavailable instead of continuing to
  describe it as rendering while the live gallery refresh completes.

## 0.9.2

### Changed

- Made wrong-address collectible warnings explicit and actionable without adding
  another permanent home-screen control.
- Renamed the UTXO surface to **Manage coins** in user-facing navigation.
- Masked optional BIP39 passphrases by default and added a compact show control.
- Added a clear onboarding action when a full-page wallet view is opened before
  any wallet exists.

## 0.9.1

### Changed

- Simplified the multi-wallet account picker so wallet management opens directly
  instead of expanding a second menu.

## 0.9.0

### Added

- Hold several wallets at once, each with its own recovery phrase. Add, switch
  between, and remove wallets from Settings. Removing one deletes local wallet
  data only, locks the whole app first, and requires confirming that its
  recovery phrase is backed up. Accounts inside a wallet continue to share that
  wallet's phrase.
- Offer optional passkey unlock at the end of wallet creation and restore, once
  the backup check has passed. The password still works, and a passkey cannot
  recover a wallet.
- Name Runes and other unsupported assets in activity where their identity can
  be verified, and state plainly that sending them is not supported. An
  unidentifiable one is labelled as such rather than shown as ordinary bitcoin.

### Changed

- Renamed **Protected sats** to **Protected & reserved**, and explained the
  plain bitcoin held at the collectibles address that is excluded from the
  amount available now and from ordinary sends.
- Grouped the account selector into the active wallet and the accounts inside
  it, and showed the wallet cue only when more than one wallet exists.

## 0.8.1

### Fixed

- Retained settled text and badge previews when the gallery re-lists, instead
  of dropping them back to a loading state.

## 0.8.0

### Added

- Show a verified preview for inscription kinds that previously had none. Text
  inscriptions render a bounded excerpt, marked when it is truncated; audio and
  video render a labelled badge with the content size; and an inscription whose
  preview is still being produced reads **Preview rendering…** rather than
  unavailable. Excerpts and badges arrive inside the signed envelope as bounded
  plain text and enum fields, so no sandbox frame and no untrusted bytes are
  involved. These tiles are shared by the gallery, home, activity, and approval
  surfaces.
- Open a JSON inscription in the media viewer, validated as UTF-8 and parsed
  before display, then pretty-printed for reading only.

### Changed

- Restricted the provider content script to HTTPS pages plus `localhost` and
  `127.0.0.1`. A site served over plain HTTP at any other address can no longer
  reach the wallet.
- Pinned provider `postMessage` traffic to the page's own origin in both
  directions instead of accepting or posting with a wildcard.
- Capped a page at 32 in-flight provider requests, answering further ones with
  `ERR_QUEUE_FULL`.
- Required an approval port's tab URL to match its sender URL exactly rather
  than accepting an absent tab URL.
- Consume `@drey/core` v0.6.2.

## 0.7.3

### Changed

- Present an imported payment request's label and message as read-only
  **Recipient name** and **Payment purpose** context rather than editable
  sender fields. They are shown beside the resolved request and again during
  exact review, stay on this device, and are never transmitted on-chain.
- Clear that imported context when the recipient is replaced by hand, so
  merchant text from one request cannot accompany a different address.

## 0.7.2

### Added

- Import BIP-321 payment instructions in Send. Paste either a plain address or
  a payment URI; Drey resolves it in the unlocked worker, selects only the
  ordinary on-chain path, revalidates it while planning, and stores just the
  canonical address.
- Show a requested amount, label, and message when the request carries them.
  Existing entries are preserved and a conflicting requested amount must be
  accepted explicitly.

### Changed

- Consume `@drey/core` v0.5.9, whose bounded payment-instruction parser fails
  closed on malformed requests, unsupported required parameters, and requests
  with no ordinary on-chain address. Proof-of-payment callbacks are never
  opened.

## 0.7.1

### Fixed

- Cache the verified BTC/USD display quote in session storage so a reopened
  popup or restarted worker paints without another round trip, while rejecting
  quotes that are stale, future-dated, or from a different gateway endpoint.
- Hardened the shared Ordinals preview cache against an out-of-range entry when
  trimming to its size budget.

## 0.7.0

### Added

- Show a collectibles carousel on the wallet home, with quieter warmup and
  clearer pending and empty states.
- Save recipients in an encrypted, on-device address book, with recent
  recipients and a one-time QR transfer that moves saved recipients directly
  between Drey devices. Recents are never included, conflicts are previewed,
  and an accepted import is applied all at once.
- Sign a message manually from Advanced settings: BIP-322 Simple over exact
  reviewed text and address, behind fresh password reauthentication, with a
  copyable signature and message hash.
- Speed up a pending Vault withdrawal with CPFP. Drey builds a child that
  spends only that withdrawal's freshly verified Vault change, targets a fee
  rate for the parent and child together, and routes it through the ordinary
  Vault approval lifecycle. Vault RBF is deliberately still unavailable.

### Changed

- Put anti-phishing guidance at the moments where it matters — an empty
  restore, a stuck transaction, a missing collectible — instead of only in
  Recovery. Drey support never asks for recovery words.
- Reworded the non-Taproot recipient and unavailable-preview confirmations to
  state exactly what Drey verified and what the user is confirming.

### Fixed

- Bounded the home activity preview and stabilized home collectibles loading.

## 0.6.0

### Added

- Coordinate a mainnet Drey Vault: 2-of-3 custody with a Desktop A role, an
  independently paired Mobile B, and authenticated QR transport for policy,
  plans, and signatures. Every movement is rebuilt from fresh signed evidence
  and checked for exact fee, inputs, outputs, change ownership, inscriptions,
  and signature policy.
- Establish Recovery C entirely offline. Drey downloads a public challenge,
  the separately downloaded standalone tool answers it on a disconnected
  computer, and only the public response returns. Drey never creates,
  receives, or stores the 12 Recovery C words, and Vault funding stays blocked
  until the offline paper-backup check passes.
- Export Desktop A as a passkey-encrypted recovery file for the offline
  recovery page. It still requires that exact passkey and recovers only one of
  the two signatures needed to spend.

### Changed

- Renamed the wallet and all product interfaces to Drey.
- Moved the provider namespace, local storage identities, shared wallet core,
  and recovery tooling to their Drey identities, including `@drey/core` v0.5.4.
- Refreshed protected-sats review, Store imagery, documentation, and website
  links for Drey.
- Made the rename an intentional clean break: existing testers must remove the
  old test build and install Drey as a fresh wallet.
- Redesigned public account transfer and polished watch-account import, the
  advanced import fields, and the public account export flow.

### Fixed

- Hardened approval and inactivity behavior, and stopped a refresh loop in the
  account manager.

## 0.5.0

### Added

- Unlock with a passkey as a convenience alternative to the app password,
  using WebAuthn PRF.
- Added a recovery hub with a backup check, and restore of a Vault role from
  its recovery words.
- Added download, QR, and print transport for the public recovery kit.
- Added exact fee entry and public watch-only accounts.

### Changed

- Refined the wallet interface and settings navigation.
- Moved platform-free wallet logic into the shared wallet-core package,
  consumed by exact release tag.

## 0.4.0

### Added

- Open Drey in an optional persistent browser side panel on Chrome 116 and
  later. The toolbar popup remains the default.
- Show bounded, verified on-chain inscription titles and curated collection
  grouping when that signed metadata is available.
- Show clearer Bitcoin and Ordinals activity, including verified inscription
  identity and public-ledger source or destination context where available.
- Allow an explicitly entered custom fee when recommended fee presets are
  unavailable, while retaining signed-status, transaction, and broadcast
  safety checks.

### Changed

- Improved pending and unavailable states in the Ordinals gallery, including
  quieter refresh behavior and more stable preview loading.
- Refined transaction receipts, receive QR presentation, wallet-history
  wording, and routine gateway synchronization feedback.

### Fixed

- Corrected fee-selection, RBF, and CPFP arithmetic, including exact sat/kvB
  handling.
- Fixed gateway refresh races, older-gateway snapshot compatibility, and edge
  cases that could obscure or misidentify inscription activity.
