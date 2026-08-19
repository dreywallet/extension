# Five-account recovery buffer

## Decision

Drey v1 permits five consecutive explicitly created standard accounts without
confirmed history. Confirmed Bitcoin or Ordinals history resets the count;
pending history does not. Recovery and manual rescan continue until five
consecutive standard accounts are empty across both lanes.

Five is intentionally an upward-compatible starting point. Increasing the
limit later preserves wallets created under this policy, while lowering it
could make already-created account gaps undiscoverable.

[Xverse's displayed accounts](https://support.xverse.app/hc/en-us/articles/28787677710989-Understanding-Derivation-Paths-and-Xverse-Wallet-Compatibility)
increment an address index. Drey accounts are complete hardened account
subtrees, each with Bitcoin and Ordinals lanes, so the same displayed account
count does not imply comparable scan work.

## Cost model

Each empty standard account requires 80 script checks: 20 receive and 20 change
scripts on each of the Bitcoin and Ordinals lanes. With 40 scripts per gateway
round, the lookahead cost is:

| Consecutive empty accounts | Script checks | Gateway rounds | Relative work |
| ---: | ---: | ---: | ---: |
| 5 | 400 | 10 | 1x |
| 10 | 800 | 20 | 2x |
| 20 | 1,600 | 40 | 4x |

## Local verification timings

Measured on 2026-08-17 against the deterministic loopback fixture. These are
development measurements, not production-gateway or physical-device service
levels.

| Surface | Five-account discovery | Known-account refresh |
| --- | ---: | ---: |
| Extension worker, isolated integration test | 1.26 s | 0.19 s |
| Mobile controller, isolated single-worker integration test | 0.90 s | 0.90 s |
| iPhone 17 Pro Max simulator, full restore UI | 18.3 s | Not separately surfaced |
| Pixel 9 API 35 emulator, full restore UI | 29.0 s | Not separately surfaced |

The native measurements run from restore submission until the recovery screen
enables Continue, including UI polling, key derivation, fixture I/O, discovery,
and persistence. Synthetic 10- and 20-account comparisons are therefore best
treated as approximately 2x and 4x the discovery portion under the same gateway
latency, not as promises of exact end-to-end wall-clock times.

The native UI does not expose background known-account refresh as a separate
timed phase. Its controller path measured 0.90 seconds in the same serial run,
and both native account-management flows verified that a wallet can remain
visible, refresh, and then reopen a slot after confirmed history.

Normal wallet refresh preserves explicitly created accounts and refreshes their
known lanes while the wallet is visible. Speculative lookahead remains confined
to recovery discovery and manual rescan.
