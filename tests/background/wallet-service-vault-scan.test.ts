/**
 * Workstream C2 exit gate, service level: the Vault scans its own descriptor
 * addresses and reports classified state, or says why it cannot.
 *
 * The scan is driven end to end — role A generated live, peers imported, policy
 * committed, then addresses regenerated from that policy and seeded into a fake
 * gateway. Nothing here asserts against a hand-written address: the test asks
 * the same `deriveVaultOutput` the scanner uses, so a derivation regression
 * shows up as an empty Vault rather than as a passing test.
 *
 * The signed-evidence claims (ADR 0007 §7): the whole Vault goes read-only when
 * status and snapshot describe different moments, when capabilities are short,
 * or when the scan itself could not complete — and never silently degrades to a
 * guess about what the Vault holds.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { OTHER_TIP, TIP, withGateway } from '../fixtures/vault-service-gateway';

beforeAll(installTestCryptoProvider);

describe('C2 Vault scan over the committed policy', () => {
  it('reports an empty Vault without refusing', async () => {
    const { scan } = await withGateway({ utxos: [] });
    const result = await scan();
    expect(result.refusal).toBeNull();
    expect(result.utxos).toEqual([]);
    expect(result.balance).toEqual({
      totalSats: '0',
      movableSats: '0',
      immovableSats: '0',
      inscriptionCount: 0,
    });
    // Even with nothing to classify, the tip comparison still ran.
    expect(result.tip).toEqual(TIP);
  });

  it('finds and classifies a funded receive output', async () => {
    const bootstrap = await withGateway({ utxos: [] });
    const receive = bootstrap.script('receive', 0);
    const { scan } = await withGateway({
      utxos: [
        {
          ...receive,
          txid: 'aa'.repeat(32),
          vout: 0,
          valueSats: '150000',
          height: TIP.height - 5,
        },
      ],
    });
    const result = await scan();
    expect(result.refusal).toBeNull();
    expect(result.utxos).toHaveLength(1);
    expect(result.utxos[0]).toMatchObject({
      valueSats: '150000',
      branch: 'receive',
      derivationIndex: 0,
      primaryClass: 'cardinal_clean',
      refusal: null,
      confirmations: 6,
    });
    expect(result.balance).toMatchObject({ totalSats: '150000', movableSats: '150000' });
  });

  it('holds back a frozen-looking output while still counting it', async () => {
    const bootstrap = await withGateway({ utxos: [] });
    const receive = bootstrap.script('receive', 0);
    const { scan } = await withGateway({
      utxos: [
        {
          ...receive,
          txid: 'bb'.repeat(32),
          vout: 0,
          valueSats: '90000',
          height: TIP.height - 1,
          // Degraded confidence: present, counted, not movable.
          classification: { confidence: 'degraded' },
        },
      ],
    });
    const result = await scan();
    expect(result.refusal).toBeNull();
    expect(result.utxos[0]?.refusal).toBe('degraded');
    expect(result.balance).toMatchObject({ totalSats: '90000', movableSats: '0', immovableSats: '90000' });
  });
});

describe('C2 forces read-only rather than guessing (ADR 0007 §7)', () => {
  it('refuses when status and snapshot describe different blocks', async () => {
    const { scan } = await withGateway({ utxos: [], statusTip: OTHER_TIP });
    const result = await scan();
    expect(result.refusal).toBe('conflicting_source');
    expect(result.balance).toBeNull();
    expect(result.utxos).toEqual([]);
  });

  it('refuses when the backend is short a Full Sat Safety capability', async () => {
    const { scan } = await withGateway({ utxos: [], dropCapabilities: ['sat_index'] });
    expect((await scan()).refusal).toBe('capabilities_insufficient');
  });

  it('refuses when snapshot and classify disagree on the revision', async () => {
    const bootstrap = await withGateway({ utxos: [] });
    const receive = bootstrap.script('receive', 0);
    const { scan } = await withGateway({
      utxos: [
        { ...receive, txid: 'cc'.repeat(32), vout: 0, valueSats: '10000', height: TIP.height },
      ],
      skewClassifyRevision: true,
    });
    // scanUnit retries once, then reports the conflict rather than caching a
    // half-verified UTXO set.
    expect((await scan()).refusal).toBe('conflicting_source');
  });

  it('refuses when the snapshot cannot be fetched at all', async () => {
    const { scan } = await withGateway({ utxos: [], failSnapshot: true });
    expect((await scan()).refusal).toBe('scan_incomplete');
  });
});
