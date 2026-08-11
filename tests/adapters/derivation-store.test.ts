import { describe, expect, it } from 'vitest';
import {
  loadDerivationState,
  reserveChangeIndexPersisted,
  saveDerivationState,
} from '../../src/adapters/storage/derivation-store';
import { derivationKey } from '../../src/adapters/storage/keys';
import {
  BIP32_INDEX_EXHAUSTED,
  initialDerivationState,
} from '@drey/core/domain/keys/derivation-state';
import { makeFakeArea } from './fake-area';

describe('derivation-store', () => {
  it('returns the initial state for an unseen account', async () => {
    const area = makeFakeArea();
    const state = await loadDerivationState(area, 'v-1', 'mainnet', 'payment', 0);
    expect(state).toEqual(initialDerivationState('payment', 'mainnet', 0));
    expect(state.nextChangeIndex).toBe(0);
  });

  it('burns a reserved change index and persists it across reload', async () => {
    const area = makeFakeArea();
    const initial = await loadDerivationState(area, 'v-1', 'mainnet', 'payment', 0);

    const first = await reserveChangeIndexPersisted(area, 'v-1', initial);
    expect(first.index).toBe(0);
    expect(first.state.nextChangeIndex).toBe(1);

    // Reload must reflect the burn even though the tx may never have broadcast.
    const reloaded = await loadDerivationState(area, 'v-1', 'mainnet', 'payment', 0);
    expect(reloaded.nextChangeIndex).toBe(1);

    const second = await reserveChangeIndexPersisted(area, 'v-1', reloaded);
    expect(second.index).toBe(1);
  });

  it('round-trips a saved state', async () => {
    const area = makeFakeArea();
    const state = { ...initialDerivationState('ordinals', 'signet', 3), nextChangeIndex: 5 };
    await saveDerivationState(area, 'v-2', state);
    expect(await loadDerivationState(area, 'v-2', 'signet', 'ordinals', 3)).toEqual(state);
  });

  it('fails closed for malformed persisted state instead of resetting a burned counter', async () => {
    const area = makeFakeArea();
    const key = derivationKey('v-1', 'mainnet', 'payment', 0);
    area.store.set(key, {
      ...initialDerivationState('payment', 'mainnet', 0),
      nextChangeIndex: 'corrupt',
    });
    await expect(loadDerivationState(area, 'v-1', 'mainnet', 'payment', 0)).rejects.toThrow(
      /invalid persisted/u,
    );
  });

  it('rejects a valid-looking record stored under the wrong account key', async () => {
    const area = makeFakeArea();
    area.store.set(
      derivationKey('v-1', 'mainnet', 'payment', 0),
      initialDerivationState('payment', 'mainnet', 1),
    );
    await expect(loadDerivationState(area, 'v-1', 'mainnet', 'payment', 0)).rejects.toThrow(
      /does not match storage key/u,
    );
  });

  it('persists the explicit exhaustion sentinel but rejects larger counters', async () => {
    const area = makeFakeArea();
    const exhausted = {
      ...initialDerivationState('payment', 'mainnet', 0),
      nextChangeIndex: BIP32_INDEX_EXHAUSTED,
    };
    await saveDerivationState(area, 'v-1', exhausted);
    expect(await loadDerivationState(area, 'v-1', 'mainnet', 'payment', 0)).toEqual(exhausted);
    await expect(
      saveDerivationState(area, 'v-1', {
        ...exhausted,
        nextChangeIndex: BIP32_INDEX_EXHAUSTED + 1,
      }),
    ).rejects.toThrow(/invalid derivation state/u);
  });
});
