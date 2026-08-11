import { beforeAll, describe, expect, it } from 'vitest';
import {
  assertVaultProductionAuthority,
  canSignVaultValue,
  resolveVaultCoordinatorCapability,
  type VaultCoordinatorMovement,
  type VaultCoordinatorNetwork,
} from '../../src/background/vault-capability';
import { signVaultPlanAsRole } from '../../src/background/vault-signing';
import {
  MAINNET_PRODUCTION,
  MAINNET_UNSIGNED_ONLY,
  SCENARIO_NOW_MS,
  SIGNET_FULL,
  scenarioPolicy,
  scenarioUtxo,
  scenarioWithdrawal,
} from '../fixtures/vault-signing-scenario';
import { signerRoot } from '../fixtures/vault-peer-signers';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';

const NETWORKS: readonly VaultCoordinatorNetwork[] = ['signet', 'mainnet'];
const MOVEMENTS: readonly VaultCoordinatorMovement[] = ['full', 'unsigned-only', 'production-mainnet'];

beforeAll(installTestCryptoProvider);

describe('reviewed compile-time Vault authority', () => {
  it('composes only the three reviewed network/movement pairings', () => {
    const composed: string[] = [];
    for (const network of NETWORKS) for (const movement of MOVEMENTS) {
      if (resolveVaultCoordinatorCapability(network, movement)) composed.push(`${network}/${movement}`);
    }
    expect(composed.sort()).toEqual([
      'mainnet/production-mainnet',
      'mainnet/unsigned-only',
      'signet/full',
    ]);
    expect(resolveVaultCoordinatorCapability('mainnet', 'full')).toBeUndefined();
    expect(resolveVaultCoordinatorCapability('signet', 'production-mainnet')).toBeUndefined();
  });

  it('permits signet tests and production mainnet signing, never unsigned-only', () => {
    expect(canSignVaultValue(SIGNET_FULL)).toBe(true);
    expect(canSignVaultValue(MAINNET_PRODUCTION)).toBe(true);
    expect(canSignVaultValue(MAINNET_UNSIGNED_ONLY)).toBe(false);
  });

  it('binds every plan to the compile-time network', () => {
    const mainnet = scenarioWithdrawal({
      capability: MAINNET_PRODUCTION,
      utxos: [scenarioUtxo(0, '400000', 'mainnet')],
      amountSats: '250000',
    }).plan;
    expect(() => assertVaultProductionAuthority(MAINNET_PRODUCTION, mainnet)).not.toThrow();
    expect(() => assertVaultProductionAuthority(SIGNET_FULL, mainnet)).toThrow(/network/u);
  });

  it('has no temporary monetary ceiling and retains the permanent signer checks', () => {
    const built = scenarioWithdrawal({
      capability: MAINNET_PRODUCTION,
      utxos: [scenarioUtxo(0, '400000', 'mainnet')],
      amountSats: '250000',
    });
    const signed = signVaultPlanAsRole({
      capability: MAINNET_PRODUCTION,
      policy: scenarioPolicy('mainnet'),
      plan: built.plan,
      evidence: built.evidence,
      nowMs: String(SCENARIO_NOW_MS),
      role: 'desktop-a',
      signerRoot: signerRoot('desktop-a', 'mainnet'),
      psbtHex: built.psbtHex,
    });
    expect(signed.roleAdded).toBe('desktop-a');
  });
});
