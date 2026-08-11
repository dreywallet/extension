# Marketplace template architecture

M9 adds a compile-time signing-policy layer above the M8 provider registry. It
does not add marketplace HTTP clients, credentials, a gateway proxy, or remote
configuration. The requesting page remains responsible for marketplace API
communication and broadcast when the selected template says `site`.

## Resolution

`src/domain/marketplaces/registry.ts` contains exact HTTPS origins and versioned
action/role/asset/network templates. Activation is a per-template compile-time
literal: the ord.net single-inscription trading set is `enabled` (2026-08-10
review); every Satflow entry and the ord.net collection/trait funding-parent
entries remain `fixture_only`, for which the provider resolver returns a stable
unsupported template result even for an otherwise exact live request.
Registry integrity hard-fails any enabled entry outside the reviewed ord.net
inscription scope. `marketplaceContext` is a strict optional
extension of `signPsbt` and `signMessage`; it binds workflow state and supplies
review text, but never selects a marketplace by brand name or authorizes a
sighash. Resolution returns one of:

- `recognized`
- `unknown_marketplace`
- `known_marketplace_unknown_version`
- `known_template_mismatch`
- `unsupported_action`

An unrecognized request may use the existing Advanced review when every input
Drey is asked to sign is deterministic (`DEFAULT`/`ALL`). The plan binds the
exact requested input indexes. A flexible signature on an unselected external
input is analyzed but does not make Drey create or authorize that signature.
Unknown flexible wallet signatures, partial seller/listing requests, and
wallet-owned script paths still fail with a stable unsupported error. New
marketplaces and versions therefore fail gracefully without becoming signing
policy.

## Signing boundary

The wallet signing policy is unchanged: P2WPKH signs `ALL`; Taproot key path
signs `DEFAULT`/`ALL`. External inputs may carry the common, already-created
`ALL|ANYONECANPAY` or `SINGLE|ANYONECANPAY` marketplace signature, but Drey
never signs those inputs through the generic route. A recognized step can
additionally permit `0x81` or `0x83` only
for the template-selected input indexes. Before signing, the service verifies
current ownership and classification, every protected-sat route, corresponding
seller payout, approved economics, and that no extra wallet input is selected.

For a generic ordinal purchase, the external inscription input is permitted
only when authoritative classification identifies every inscription and FIFO
sat accounting proves each one lands at the active account's verified ordinals
receive script. Rare-sat ranges, unsupported assets, missing flows, another
destination, and any attempt to select the external input remain hard failures.

The ord.net sale path accepts only the exact pinned
`tr(seller,multi_a(2,seller,ordnet))` leaf. It recomputes the control block,
internal key, leaf hash, output key, seller key, and pinned ord.net key. The
signer temporarily disables key tweaking for the verified script leaf and then
cryptographically verifies the returned partial signature. Post-sign validation
allows signature-field additions only; transaction and other PSBT metadata must
remain byte-equivalent.

For incomplete seller PSBTs, analysis is exact over the wallet commitment domain:
wallet input, guaranteed payout, protected-sat route, wallet fee exposure, and
committed outputs. It labels external inputs and non-corresponding outputs as
uncommitted instead of claiming an unknowable final miner fee.

## Workflow and reservations

Encrypted cache records bind origin, template/version, network, vault/account,
workflow identifiers, request/PSBT/analysis/plan hashes, prior signed step,
revision/expiry, exact signed response, and broadcaster. Prepared or approved
unsigned records become `needs_reapproval` after restart. Pending approval
windows remain ephemeral. Signed bytes are never re-signed; they are releasable
only to the identical fresh workflow binding with explicit approval.

Inputs behind exported offers or funding transactions are reserved from ordinary
selection. A reservation is released only after independently observed
settlement, a proven conflicting spend/invalidation, or template-defined
cancellation proof—not a page success message or local TTL.

## Fixtures and release status

`tests/fixtures/marketplaces/manifest.json` pins provenance and reviewed contract
digests. `fixtures:marketplaces:check` is offline; the refresh command only emits
review candidates. `audit:marketplaces` rejects wildcard origins, runtime policy
fetches, environment activation, excluded actions, and registry/manifest drift.

The ord.net single-inscription trading set (auth, list, buy, offer, counter,
accept-offer, accept-counter) was enabled 2026-08-10 after re-derivation from
the published ORD.NET Trading API 1.0.0 OpenAPI 3.1 document
(`developers.ord.net/openapi.json`, byte-identical to the 2026-07-22 capture)
and its reference pages: per-step sighash tables, preflight handle plus
expected-txid echo binding (the retired preflight `revision` model was
replaced), 409 stale-state semantics, and self-service BIP-322 wallet auth.
Known residual risks, accepted for this release: the vendor publishes no
rotation or detection contract for the pinned sale co-signer key (rotation
therefore hard-fails signing until re-review), no live-trade evidence exists
yet, ord.net auth requires a payment address holding at least 0.01 BTC
confirmed, and batch listing preflights (2..20 items) are not represented and
fail closed. First live trades are manual operator actions with small amounts;
operator test-wallet procedures exclude inscription movement.

The ord.net v2 collection/trait funding-parent design (four-key fill gate,
zero-fee TRUC parents, enclave co-signer) remains `fixture_only` pending an
independent design review.

Satflow live activation remains blocked. Its OpenAPI (still 1.1.4-prod,
re-checked 2026-08-10) omits the response schema for `/intent/sell` and
`/intent/satflow-purchase` and provides only a partial response for
`/intent/secure-purchase`; the compact stage appears only as a request-side
flag; and the challenge lifecycle does not define expiry, one-time/replay
behavior, or how the challenge is bound to the specific ask being canceled.
Exact captured vendor fixtures, a complete challenge lifecycle contract, API
access, and disposable-wallet compatibility evidence are required before
changing Satflow's `fixture_only`. Its docs are rebranding to ordinals.market;
compile-time origins must be re-verified before any Satflow activation. Do not
enable a template from remote data or test with production credentials.

## Approval friction

Every signing or transfer request still receives a fresh, origin-bound approval.
Fully structured transfer plans and future recognized marketplace plans need one
approval click while the wallet is unlocked. Password reauthentication plus the
typed `SIGN PSBT` challenge is reserved for arbitrary Advanced PSBTs, where the
wallet cannot provide a recognized business-action template. Lock, navigation,
account/network/session changes, expiration, and approval-window closure still
invalidate the request.
