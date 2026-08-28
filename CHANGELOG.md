# Changelog

Notable user-facing changes to Drey are recorded here. For earlier releases,
see the production release tags in the repository.

## 0.14.16

### Added

- Support atomic marketplace PSBT groups, including linked listing graphs,
  shared-funding alternatives, and exact sign-only zero-fee parents.
- Show concise signature rules, maximum debit, fee exposure, and mutually
  exclusive outcomes before signing.

### Security

- Validate and revalidate the complete group before releasing any signature,
  preserve marketplace replay/order records, and return every result or none.
- Consume `@drey/core` v0.19.1 and bind its reproducible recovery source digest.

## 0.14.12

### Changed

- Correct the public contributor setup to clone the exact `@drey/core` v0.17.6
  tag and make approval-window discovery resilient to unrelated transient pages.
  Wallet behavior and recovery artifact bytes are unchanged from v0.14.11.

## 0.14.11

### Changed

- Consume the corrective annotated `@drey/core` v0.17.6 release and bind its
  reproducible standalone-recovery source digest. Wallet behavior and recovery
  artifact bytes are unchanged from v0.14.10.

## 0.14.10

### Security

- Keep recovery words hidden during wallet creation and restoration until the
  user explicitly chooses to reveal them.

## 0.14.9

### Added

- Add one-unlock wallet profiles with password-free switching and passkey-backed profile sessions.
- Allow recovery backup to be deferred with persistent reminders until verification.

### Changed

- Move Community Vault into Advanced settings with clearer expert-use guidance.
- Improve wallet status recovery and synchronize wallet, account, and backup behavior with mobile.
- Consume `@drey/core` v0.17.5.

## 0.14.8

### Security

- Retain broadcast recovery whenever a gateway result does not match the exact
  submitted transaction, network, gateway identity, protocol, fee/status
  snapshot, or successful transaction ID.

### Changed

- Consume `@drey/core` v0.17.3.

## 0.14.7

### Fixed

- Keep a native transaction review usable when independently signed gateway
  data advances during approval: replace the review once with fresh bounded
  data, require the user to review it again, and fail closed if the sources do
  not converge.
- Release unsigned transaction input reservations when the user leaves Send or
  closes the review, including when an approval response arrives late.
- Show wrong app-password feedback directly in website approval windows and
  allow a safe retry while the original bounded request remains active.
- Change the app password for the wallet and Community Vault records in one
  validated storage operation so they cannot end up under different passwords.

### Changed

- Present pending-transaction speed-up guidance as supporting information and
  keep the recovery-word warning as a quieter safety note.
- Consume `@drey/core` v0.17.2.

### Security

- Rebind website approval authority after password verification and before any
  signing work.
- Retain strict transaction-byte, account, session, source, fee, input, and
  classification checks across every refreshed review.

## 0.14.2

### Fixed

- Keep sequential website approvals reliable when a completed review window
  closes or the approval page briefly reconnects, without weakening cancellation
  when an active review is closed.
- Use natural singular wording when a site asks to sign one transaction or one
  message through a batch-compatible request.

### Security

- Expand local regtest coverage for independent PSBT batches to verify exact
  result ordering, no wallet broadcast, duplicate and conflicting-input
  rejection, and atomic failure when an input becomes stale during review.
- Keep linked transaction graphs and linked ord.net batch listings disabled;
  enabling another marketplace shape still requires an explicit reviewed
  compile-time policy.

## 0.14.1

### Added

- Add the official Sats Connect multiple-message method for 1–10 bounded
  BIP322 address proofs, with one complete review and all-or-nothing results in
  request order.

### Security

- Bind every message, address, origin, browser document, account, network, and
  wallet session to the approval, and return no signatures after rejection,
  closure, restart, or stale context.

### Changed

- Consume `@drey/core` v0.17.1.

## 0.14.0

### Added

- Add Sats Connect-compatible independent PSBT batch signing for 1–41
  transactions, with one complete Advanced review and all-or-nothing ordered
  results.

### Security

- Bind the complete batch and approval context, reject duplicate, conflicting,
  or internally linked transactions, and keep marketplace batch activation
  outside the reviewed ord.net single-inscription allowlist.

### Changed

- Consume `@drey/core` v0.17.0.

## 0.13.1

### Added

- Add reviewed Community Vault approvals for transferring a complete owner
  position. The current owner and buyer each see the fixed units, payment,
  network fee, new owner keys, and replacement Vault before signing.

### Fixed

- Keep an eligible RBF speed-up available after the pending transaction has
  spent its original inputs, while requiring fresh signed proof that the exact
  parent transaction is still pending and replaceable.
- Mark the original transaction as replaced after Drey accepts its replacement,
  and stop offering another speed-up when the latest signed history says it is
  no longer available.
- Prevent quick repeated clicks from starting duplicate transaction planning or
  approval requests, and keep an uncertain broadcast result connected to
  Activity instead of returning to a new-send screen.

### Changed

- Make RBF and CPFP reviews explain what changes, what stays fixed, and which
  network fee will be signed.
- Consume `@drey/core` v0.16.1.

## 0.12.0

### Added

- Add Community Vault setup for OMB Group Buys. Every owner creates and verifies
  a separate campaign recovery key; Drey and the gallery receive no spending or
  recovery key.
- Let one clear Drey approval produce the signatures for every numbered unit an
  owner holds, while independently validating the frozen 69-of-100 policy,
  cap table, exact transaction, and Ordinal route.
- Add exact listed and creator-fronted acquisition approvals plus exact-funded
  sale-offer approvals with direct owner payouts.
- Expose versioned Community Vault capabilities to the connected OMB Gallery and
  report only confirmed clean spendable balance for its funding checks.

### Changed

- Simplify the guided Group Buy handoff so campaign and owner details open in
  Drey automatically, while retaining a manual public-package fallback.
- Consume `@drey/core` v0.14.4.

## 0.11.2

### Changed

- Keep routine balance refreshes focused on the account currently being viewed,
  avoiding hidden-account gateway work while preserving the last verified
  balances for quick account switching.
- Continue to scan the broader wallet only during restore, manual rescan,
  Extended scan, and exact conflict recovery.
- Consume `@drey/core` v0.11.0.

## 0.11.1

### Added

- Show safe static previews for AVIF inscriptions, including BTC Slugs, in the
  gallery and transaction review. The gateway converts source media and the
  extension accepts only the signed, verified PNG result.

### Changed

- Permit five consecutive explicitly created standard accounts without
  confirmed history, and use the same five-account buffer during recovery and
  manual rescans.
- Clarify Recovery Kit backup guidance.
- Consume `@drey/core` v0.10.1.

## 0.11.0

### Added

- Add exact-origin compatibility with the reviewed OMB Wiki buyer flow. Unknown
  or changed flexible marketplace requests continue to fail closed.

### Fixed

- Open the unlock screen before granting a site connection when the wallet is
  locked.
- Keep long message approvals readable instead of clipping their contents.
- Emit Vault PSBT QR handoffs using the device-compatible `crypto-psbt` format
  without changing transaction bytes, approval policy, or recovery behavior.

### Changed

- Consume `@drey/core` v0.9.1.

## 0.10.10

### Changed

- Label the primary balance as available to send only when the full amount is
  currently sendable.
- Replace the prominent protected-balance row with a compact Set aside
  disclosure that appears only when bitcoin is excluded from regular sends.

## 0.10.9

### Added

- Add a Recovery Center that summarizes locally verified Spending and Vault
  recovery readiness without revealing recovery material or adding a new
  recovery format or source of truth.

### Fixed

- Keep Recovery Center results visible while the app refreshes local evidence,
  and avoid restarting settings screens when the active wallet session has not
  actually changed.
- Guide Vault creation as a clear four-step setup, explain that role names are
  optional device labels, and keep the next required action prominent.
- Make Mobile B pairing resumable and explicit about both response scans and the
  final Vault-policy scan, without exposing the advanced signer fields by
  default.

## 0.10.8

### Changed

- Consume `@drey/core` v0.8.2, which corrects the public development lockfile
  without changing wallet behavior.
- Allow an inspectable build from the standalone public source mirror while
  keeping Store packaging bound to the reviewed private release workspace.

## 0.10.7

### Fixed

- Complete account discovery when an address has more activity than the
  history service can return in one bounded response.
- Keep a working Retry action after a scan fails to start, and distinguish a
  data-limit failure from a connection failure.

### Changed

- Keep balances and collectibles complete and independently verified while
  clearly marking older Activity as incomplete when history is bounded.
- Preserve partial-history status through restart and scan resume without
  weakening spending or collectible-classification checks.
- Consume `@drey/core` v0.8.1.

## 0.10.6

### Fixed

- Show a clear recovery mismatch when a complete phrase is malformed instead
  of reporting an internal error.
- Explain when recovering bitcoin from a collectible would cost at least as
  much as it returns.
- Label collectible postage changes correctly in Activity instead of showing
  them as ordinary bitcoin sends.
- Describe coin consolidation in terms of the selected economy fee without
  implying that Drey measured a separate network-fee condition.

## 0.10.5

### Added

- Send bitcoin to 2–20 recipients in one atomic transaction, with a separate
  address-book picker for each recipient, exact per-recipient review, and a
  clear privacy notice before batching payments.
- Manage the bitcoin kept with an eligible collectible. The screen shows the
  current amount, offers 330-sat, 546-sat, 10,000-sat, and custom targets, and
  reviews the amount recovered or added separately from the network fee.
- Test a complete recovery phrase locally from the Recovery center, including
  the BIP39 passphrase when one is used. The result reveals only whether the
  wallet matches and clears every entered secret after the attempt.
- Explain locally how a generated recovery phrase received its randomness,
  while distinguishing generated, imported, and older wallets whose origin is
  unknown.

### Changed

- Show one best available fee-bump action for a pending transaction instead of
  presenting RBF and CPFP as equivalent choices.
- Offer a dismissible review for combining clean coins, with the network cost
  and privacy linkage disclosed before review.
- Make collectible-postage management available from both compact protected-coin
  details and the full media viewer.
- Rename the three-word backup result to **Three-word spot check passed** and
  make clear that it is not a complete recovery test.
- Consume `@drey/core` v0.8.0.

## 0.10.4

### Added

- Send up to 16 eligible inscriptions atomically to one recipient, keeping
  inscriptions that share an output or sat together.
- Show verified inscription previews beside protected coins in Manage coins.

### Changed

- Consume `@drey/core` v0.7.16.

## 0.10.3

### Changed

- Housekeeping for the public source release: contribution and security
  policies, public repository metadata, and documentation cleanup. No
  functional changes.

## 0.10.2

### Added

- Page through older account activity without replacing the most recent
  history already on screen.

### Fixed

- Return to the last active wallet after unlocking.
- Keep cached collectibles visible while fresh gallery data loads, and discard
  stale media responses after the selected wallet or collectible changes.
- Enforce provider PSBT input bounds before analysis and signing.

### Changed

- Consume `@drey/core` v0.7.12.

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
