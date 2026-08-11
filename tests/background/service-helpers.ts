/**
 * WalletService test harness: a service wired over in-memory fake stores with a
 * controllable clock and deterministic RNG, plus a `rebuild()` that constructs a
 * fresh service over the SAME stores/clock to simulate MV3 worker restart
 * (spec §24.4 prep).
 */
import { WalletService, type WalletServiceDeps } from '../../src/background/wallet-service';
import type { VaultDeps } from '@drey/core/domain/vault/vault';
import { TEST_PARAMS } from '@drey/core/testing/vault-helpers';
import { makeFakeArea, type FakeArea } from '../adapters/fake-area';
import { MemoryWalletCache } from '../../src/adapters/storage/wallet-cache-idb';

export const DEFAULT_IDLE_MS = 60 * 60 * 1000;

export interface Harness {
  service: WalletService;
  local: FakeArea;
  session: FakeArea;
  clock: { now: number };
  /** Fresh service over the same stores + clock (worker restart). */
  rebuild(): WalletService;
}

export function makeHarness(
  startTime = 1_752_969_600_000,
  overrides: Partial<WalletServiceDeps> = {},
): Harness {
  const local = makeFakeArea();
  const session = makeFakeArea();
  const clock = { now: startTime };
  const walletCache = new MemoryWalletCache();
  let rngCounter = 1;
  let idCounter = 0;
  let sessionCounter = 0;
  const vaultDeps: VaultDeps = {
    random: (n) => new Uint8Array(n).map((_, i) => (i * 31 + rngCounter++ * 97) % 256),
    now: () => clock.now,
  };
  const cfg: WalletServiceDeps = {
    local,
    session,
    vaultDeps,
    calibrateKdf: () => Promise.resolve(TEST_PARAMS),
    newVaultId: () => `vault-${++idCounter}`,
    newSessionId: () => `00000000-0000-4000-8000-${String(++sessionCounter).padStart(12, '0')}`,
    // Pre-M6 suites assert mainnet addresses; scan tests override to signet.
    network: 'mainnet',
    walletCache,
    ...overrides,
  };
  return {
    service: new WalletService(cfg),
    local,
    session,
    clock,
    rebuild: () => new WalletService(cfg),
  };
}
