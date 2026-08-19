# Drey wallet provider

Drey exposes one Bitcoin wallet provider at `window.drey`. The provider follows
the promise-based JSON-RPC contract used by Sats Connect 4.x and registers
WBIP004 discovery metadata in both `window.btc_providers` and
`window.wbip_providers`.

Version `0.3.0` corrects the previously published experimental provider shape:
direct calls now resolve JSON-RPC response envelopes and listeners use the
standard listener object. No compatibility shim is retained because there were
no known external integrations using the experimental shape.

## Discover Drey

The discovery entry has this shape:

```ts
{
  id: 'drey', // object path: window.drey
  name: 'Drey',
  icon: 'data:image/...',
  webUrl: 'https://squirrelsystems.net',
  chromeWebStoreUrl:
    'https://chromewebstore.google.com/detail/drey/kngidlmmbfmnoeimngkajdlbdenlhgof',
  methods: ['getInfo', 'wallet_connect', /* ... */],
}
```

Applications using Sats Connect Core can discover and call Drey without a
wallet-specific SDK:

```ts
import { getProviders, request } from '@sats-connect/core';

const drey = getProviders().find((provider) => provider.id === 'drey');
if (!drey) throw new Error('Drey is not installed');

const response = await request(
  'wallet_connect',
  {
    addresses: ['payment', 'ordinals'],
    message: 'Connect to Example',
  },
  drey.id,
);

if (response.status === 'error') throw new Error(response.error.message);
console.log(response.result.addresses);
```

Until the default Sats Connect wallet selector includes arbitrary WBIP004
providers, applications can use `getProviders()` as above or pass the provider
ID directly.

## Direct JSON-RPC calls

Direct calls always resolve to a JSON-RPC 2.0 response. Wallet and validation
errors are returned in `error`; they are not thrown across the page boundary.

```ts
const response = await window.drey.request('getBalance');
if ('error' in response) {
  console.error(response.error.code, response.error.message);
} else {
  console.log(response.result.total);
}
```

Listeners use the standard listener object and return an unsubscribe function:

```ts
const unsubscribe = window.drey.addListener({
  eventName: 'accountChange',
  cb(event) {
    console.log(event.addresses);
  },
});

unsubscribe();
```

## Capability matrix

| Capability | Method | Notes |
| --- | --- | --- |
| Provider information | `getInfo` | Available while locked |
| Connection and permissions | `wallet_connect`, `wallet_disconnect`, `wallet_renouncePermissions`, `wallet_getCurrentPermissions`, `wallet_requestPermissions` | Origin- and document-bound |
| Account and network reads | `wallet_getAccount`, `wallet_getNetwork`, `getAddresses`, `getAccounts`, `getBalance` | Bitcoin payment and Ordinals addresses only |
| Message signing | `signMessage` | BIP322 simple only; fresh approval required |
| PSBT signing | `signPsbt` | Returns the signed PSBT and optional broadcast txid |
| BTC transfer | `sendTransfer` | Fresh transaction review required |
| Ordinals | `ord_getInscriptions`, `ord_sendInscriptions` | Single inscription transfer |

Before `sendTransfer` creates a transaction plan, Drey checks the selected
account against the gateway's active revision. If the gateway is healthy but
the local cache is behind, Drey joins or starts one bounded selected-account
refresh and continues only if the original document, session, account, and
permissions are still exact. Failure to restore freshness returns
`ERR_DATA_STALE` (`-32009`); it is never reported as stale document authority.

`ERR_STALE_CONTEXT` (`-32004`) is reserved for a request invalidated by its
document, navigation, connection, session, account, permission, or plan. If a
broadcast may have been dispatched but no definitive response is available,
Drey returns `ERR_BROADCAST_OUTCOME_UNKNOWN` (`-32010`) when the transport still
exists and retains manual-reconciliation evidence. Sites must not automatically
retry either condition; after an interrupted result they should ask the user to
check Drey Activity before starting another payment.

Drey does not expose Stacks, Spark, Starknet, Runes, ECDSA message signing, or
another wallet's legacy namespace. Requests for unsupported methods or address
purposes return a JSON-RPC error.

## Privacy and lifecycle boundaries

- Discovery metadata, the frozen method list, the initialization event, and
  `getInfo` remain available while the wallet is locked. They disclose that
  Drey is installed and its static version/capabilities, but no wallet, account,
  permission, balance, address, or inscription state. Unconnected read methods
  return the same not-connected result without consulting lock-sensitive account
  state. A locked `wallet_connect` request opens Drey's trusted unlock surface;
  after a successful unlock, the original document-bound request continues into
  connection approval without the site resending it. Closing the unlock surface
  rejects the request.
- The provider is injected into supported top-level pages and frames for
  embedded-dApp compatibility. Chrome's sender origin, tab, frame, document ID,
  and active lifecycle are the authority. Each document must connect; an origin
  string or frame identity supplied by the page grants nothing.
- Account and disconnect events are emitted only to documents with an exact
  live connection. Merely discovering Drey, sharing an origin with another
  connected frame, or holding a permission previously used by another document
  does not expose account/session transition timing.
- Connections are session-bound and document-bound. Lock, vault/session change,
  revocation, frame destruction, and full-document replacement invalidate live
  authority. Same-document History API navigation rotates the runtime port while
  retaining the same browser document binding; an MV3 worker restart restores
  only that exact binding from extension-only session storage.
- Permission grants are encrypted and scoped to origin, network, vault, account,
  and data category. They persist until the site disconnects/renounces, the user
  revokes the site, or the vault is removed. Drey deliberately does not apply an
  arbitrary time-based expiry to non-address categories: reconnect still requires
  a live unlocked session and exact category set, and the connected-sites screen
  gives the user explicit revocation control. Address purpose is narrower than
  the interoperable permission-journal category, so Drey also binds the approved
  payment/Ordinals purpose set to the exact live document connection. A worker
  restart restores that exact set, but another document or a new unlock session
  must renew address-purpose approval. A broader expiry policy should be added
  only with a defined user-visible renewal contract.
- Requested payment and Ordinals addresses are returned together in the single
  authorized response and filtered to the approved purposes. A later request may
  narrow that set but cannot widen it without approval. Drey does not emit
  addresses piecemeal or publish address-bearing events to unconnected documents.

## Marketplace status

Marketplace signing is fail-closed by default. Deterministic generic PSBT
requests may receive Advanced review, but flexible or partial marketplace
transactions require an exact compile-time template.

ord.net single-inscription trading (authenticate, list, buy, offer, counter,
accept offer, accept counter) is enabled from the published ORD.NET Trading API
1.0.0 contract: requests must present a `marketplaceContext` carrying the
preflight handle (anchor/purchase-anchor UUID) and, for settlement-bearing
actions, the preflight's expected txids, or they fail closed. Batch listing
preflights and the v2 collection/trait funding-parent offers are not supported.
Satflow templates remain fixture-backed and must not be represented as live
integrations until their independent vendor and contract gates pass.

Independent of templates, any HTTPS origin may request a §21.1 generic
listing: a `signPsbt` whose selected wallet inputs carry explicit
`SINGLE|ANYONECANPAY` or `ALL|ANYONECANPAY` is signed one-click when the PSBT
itself proves the guarantees — each SINGLE payout returns to the active
account at no less than the listed input value, wallet-owned outputs cover the
full wallet input value, and no rare-sat/unsupported inputs, script paths, or
mixed deterministic wallet signatures are present. Everything else flexible
still fails closed. Price sanity is disclosed, not enforced: the approval
shows the exact payout.

The provider contract is tested against `@sats-connect/core@0.16.0`, the Core
version used by `sats-connect@4.2.1`.

## Community Vault coordination

Community Purchase requests use separately versioned, exact contexts from
`@drey/core`: `communityVaultAcquisitionContext` for the buyer-funded purchase
and `communityVaultSaleContext` for an owner-approved resale. These contexts
cannot be combined with each other or with marketplace context. Drey rebuilds
the expected plan from the PSBT and context; a changed input, output, payout,
fee, policy commitment, or expiration fails closed.

For an acquisition, Drey signs only the buyer inputs authorized by the normal
wallet. For a sale, one password approval signs every unit that owner holds by
using the independently derived Community Vault root. The approval shows the
owner's direct payout and makes clear that the buyer pays the network fee on
top. It does not expose an Advanced-signing phrase for this fixed policy.

Both operations return a partial PSBT to the coordinating site. Drey never
combines other owners' signatures, finalizes the threshold transaction, or
broadcasts it. The site must preserve the exact reviewed policy package and
observe settlement on Bitcoin independently.
