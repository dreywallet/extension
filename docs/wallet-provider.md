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

Drey does not expose Stacks, Spark, Starknet, Runes, ECDSA message signing, or
another wallet's legacy namespace. Requests for unsupported methods or address
purposes return a JSON-RPC error.

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
