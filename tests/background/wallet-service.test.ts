import { beforeAll, describe, expect, it } from 'vitest';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { getSession } from '../../src/adapters/session/session-store';
import { loadActiveVaultId, saveActiveVaultId } from '../../src/adapters/storage/vault-store';
import { ACTIVE_VAULT_KEY, VAULTS_KEY } from '../../src/adapters/storage/keys';
import { PASSWORD } from '@drey/core/testing/vault-helpers';
import { DEFAULT_IDLE_MS, makeHarness } from './service-helpers';

const NEW_PASSWORD = 'a-brand-new-password';

beforeAll(async () => {
  await installTestCryptoProvider();
});

describe('WalletService state machine', () => {
  it('creates a vault but stays locked until an explicit unlock', async () => {
    const h = makeHarness();
    const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
    expect(vaultId).toBe('vault-1');

    const status = await h.service.sessionStatus();
    expect(status.locked).toBe(true);
    expect(status.highSecurityMode).toBe(false);

    const list = await h.service.list();
    expect(list.vaults).toEqual([{ vaultId: 'vault-1', name: 'Main', createdAt: expect.any(Number) }]);
    expect(list.activeVaultId).toBeNull();
  });

  it('rejects an unlock with the wrong password and unlocks with the right one', async () => {
    const h = makeHarness();
    const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });

    await expect(h.service.unlock({ vaultId, password: 'wrong-password-value' })).rejects.toMatchObject({
      code: 'wrong-password',
    });

    const res = await h.service.unlock({ vaultId, password: PASSWORD });
    expect(res.vaultId).toBe(vaultId);
    expect(res.deadline).toBe(h.clock.now + DEFAULT_IDLE_MS);

    const status = await h.service.sessionStatus();
    expect(status).toMatchObject({ locked: false, activeVaultId: vaultId });
    expect(await loadActiveVaultId(h.local)).toBe(vaultId);
  });

  it('unknown vault ids are rejected as not-found', async () => {
    const h = makeHarness();
    await expect(h.service.unlock({ vaultId: 'nope', password: PASSWORD })).rejects.toMatchObject({
      code: 'ERR_VAULT_NOT_FOUND',
    });
  });

  it('locks by clearing the session', async () => {
    const h = makeHarness();
    const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
    await h.service.unlock({ vaultId, password: PASSWORD });

    await h.service.lock();
    expect((await h.service.sessionStatus()).locked).toBe(true);
    expect(await getSession(h.session)).toBeNull();
  });

  it('keeps the last successful wallet when a later unlock attempt fails', async () => {
    const h = makeHarness();
    const a = await h.service.create({ name: 'A', password: PASSWORD });
    const b = await h.service.create({ name: 'B', password: PASSWORD });
    await h.service.unlock({ vaultId: a.vaultId, password: PASSWORD });
    await h.service.lock();

    await expect(h.service.unlock({
      vaultId: b.vaultId,
      password: 'wrong-password-value',
    })).rejects.toMatchObject({ code: 'wrong-password' });
    expect(await loadActiveVaultId(h.local)).toBe(a.vaultId);
  });

  it('switches vaults with reauth, clearing the prior vault from the session (§7.3)', async () => {
    const h = makeHarness();
    const a = await h.service.create({ name: 'A', password: PASSWORD });
    const b = await h.service.create({ name: 'B', password: PASSWORD });
    await h.service.unlock({ vaultId: a.vaultId, password: PASSWORD });

    await h.service.switchVault({ vaultId: b.vaultId, password: PASSWORD });

    const session = await getSession(h.session);
    expect(session?.vaultId).toBe(b.vaultId); // only the switched-to vault is present
    expect(await loadActiveVaultId(h.local)).toBe(b.vaultId);
    // both vaults still exist in storage — switching never deletes them
    expect((await h.service.list()).vaults.map((v) => v.vaultId)).toEqual([a.vaultId, b.vaultId]);
  });

  it('changePassword rewraps records while the active session survives (§7.2)', async () => {
    const h = makeHarness();
    const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
    await h.service.unlock({ vaultId, password: PASSWORD });
    const before = await getSession(h.session);

    await h.service.changePassword({ oldPassword: PASSWORD, newPassword: NEW_PASSWORD });

    // Rewrap leaves the DEK bytes unchanged, so the live session is untouched.
    expect((await h.service.sessionStatus()).locked).toBe(false);
    expect((await getSession(h.session))?.dekB64).toBe(before?.dekB64);

    // The new password is required from here on.
    await h.service.lock();
    await expect(h.service.unlock({ vaultId, password: PASSWORD })).rejects.toMatchObject({
      code: 'wrong-password',
    });
    await expect(h.service.unlock({ vaultId, password: NEW_PASSWORD })).resolves.toMatchObject({ vaultId });
  });

  it('rehydrates an unexpired session across a worker restart (§24.4)', async () => {
    const h = makeHarness();
    const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
    await h.service.unlock({ vaultId, password: PASSWORD });

    const restarted = h.rebuild();
    await restarted.init();
    expect(await restarted.sessionStatus()).toMatchObject({ locked: false, activeVaultId: vaultId });
  });

  it('locks after the idle deadline passes on restart, clearing the session', async () => {
    const h = makeHarness();
    const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
    const { deadline } = await h.service.unlock({ vaultId, password: PASSWORD });

    h.clock.now = deadline; // deadline is inclusive: now >= deadline is expired
    const restarted = h.rebuild();
    await restarted.init();
    expect((await restarted.sessionStatus()).locked).toBe(true);
    expect(await getSession(h.session)).toBeNull();
  });

  it('locks when the session store is wiped (browser restart)', async () => {
    const h = makeHarness();
    const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
    await h.service.unlock({ vaultId, password: PASSWORD });

    h.session.store.clear(); // chrome.storage.session is emptied on browser restart
    const restarted = h.rebuild();
    await restarted.init();
    expect((await restarted.sessionStatus()).locked).toBe(true);
  });

  it('does not report a stale local active pointer after the session is lost', async () => {
    const h = makeHarness();
    const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
    await saveActiveVaultId(h.local, vaultId);

    await expect(h.service.list()).resolves.toMatchObject({ activeVaultId: null });
  });

  it('slides the idle deadline on touch and expires when inactive', async () => {
    const h = makeHarness();
    const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
    const { deadline } = await h.service.unlock({ vaultId, password: PASSWORD });

    h.clock.now += 10 * 60 * 1000; // 10 min of activity, well within the window
    const extended = await h.service.touchSession();
    expect(extended).toBe(h.clock.now + DEFAULT_IDLE_MS);
    expect(extended).toBeGreaterThan(deadline);

    h.clock.now = (extended ?? 0) + 1; // now inactive past the new deadline
    expect(await h.service.touchSession()).toBeNull();
    expect((await h.service.sessionStatus()).locked).toBe(true);
  });

  it('does not treat passive account and backup reads as user activity', async () => {
    const h = makeHarness();
    const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
    const unlocked = await h.service.unlock({ vaultId, password: PASSWORD });
    const expectation = { expectedVaultId: vaultId, expectedSessionId: unlocked.sessionId };

    h.clock.now += 10 * 60 * 1000;
    await expect(h.service.backupStatus(expectation)).resolves.toMatchObject({
      backupVerified: false,
      metadata: { origin: 'generated', wordCount: 12, usesPassphrase: false },
    });
    await expect(h.service.getActiveAccount(expectation)).resolves.toMatchObject({ account: 0 });
    expect((await getSession(h.session))?.deadline).toBe(unlocked.deadline);

    const touched = await h.service.touchSession(expectation);
    expect(touched).toBe(h.clock.now + DEFAULT_IDLE_MS);
    await expect(h.service.touchSession({
      expectedVaultId: vaultId,
      expectedSessionId: '00000000-0000-4000-8000-000000000099',
    })).rejects.toMatchObject({ code: 'ERR_LOCKED' });
  });

  it('restricts the session store to trusted contexts on init (§7.4)', async () => {
    const h = makeHarness();
    await h.service.init();
    expect(h.session.accessLevel).toBe('TRUSTED_CONTEXTS');
    expect(h.session.accessLevelCalls).toBe(1);
  });

  it('removing the active vault clears the session and active pointer (§7.4)', async () => {
    const h = makeHarness();
    const a = await h.service.create({ name: 'A', password: PASSWORD });
    const b = await h.service.create({ name: 'B', password: PASSWORD });
    const unlocked = await h.service.unlock({ vaultId: a.vaultId, password: PASSWORD });

    expect(await h.service.removeVault({ targetVaultId: a.vaultId, password: PASSWORD,
      expectedVaultId: a.vaultId, expectedSessionId: unlocked.sessionId })).toEqual({ removed: true });
    expect((await h.service.list()).vaults.map((v) => v.vaultId)).toEqual([b.vaultId]);
    expect((await h.service.sessionStatus()).locked).toBe(true);
    expect(await loadActiveVaultId(h.local)).toBeNull();

    const retry = await h.service.unlock({ vaultId: b.vaultId, password: PASSWORD });
    expect(await h.service.removeVault({ targetVaultId: 'missing', password: PASSWORD,
      expectedVaultId: b.vaultId, expectedSessionId: retry.sessionId })).toEqual({ removed: false });
  });

  it('locks before removing an inactive vault (§7.4)', async () => {
    const h = makeHarness();
    const a = await h.service.create({ name: 'A', password: PASSWORD });
    const b = await h.service.create({ name: 'B', password: PASSWORD });
    const unlocked = await h.service.unlock({ vaultId: a.vaultId, password: PASSWORD });

    await expect(h.service.removeVault({ targetVaultId: b.vaultId, password: PASSWORD,
      expectedVaultId: a.vaultId, expectedSessionId: unlocked.sessionId })).resolves.toEqual({ removed: true });
    expect(await getSession(h.session)).toBeNull();
    expect((await h.service.list()).vaults.map((vault) => vault.vaultId)).toEqual([a.vaultId]);
  });

  it('locks an unexpired session when an overdue alarm signals sleep/resume', async () => {
    const h = makeHarness();
    const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
    await h.service.unlock({ vaultId, password: PASSWORD });

    await h.service.sweepExpired(true);
    expect(await getSession(h.session)).toBeNull();
  });

  it('enforces one app password before adding another vault', async () => {
    const h = makeHarness();
    await h.service.create({ name: 'A', password: PASSWORD });
    await expect(
      h.service.create({ name: 'B', password: 'a-different-valid-password' }),
    ).rejects.toMatchObject({ code: 'wrong-password' });
    expect((await h.service.list()).vaults.map((vault) => vault.name)).toEqual(['A']);
  });

  it('uses a durable operation ID to make create retries idempotent', async () => {
    const h = makeHarness();
    const operationId = '11111111-1111-4111-8111-111111111111';
    const first = await h.service.create({ name: 'Main', password: PASSWORD, operationId });
    const retry = await h.service.create({ name: 'Main', password: PASSWORD, operationId });

    expect(retry).toEqual(first);
    expect((await h.service.list()).vaults).toHaveLength(1);
    await expect(
      h.service.create({ name: 'Changed name', password: PASSWORD, operationId }),
    ).rejects.toMatchObject({ code: 'ERR_INVALID_PAYLOAD' });
  });

  it('rejects restore operation-ID reuse with a different recovery input', async () => {
    const h = makeHarness();
    const operationId = '22222222-2222-4222-8222-222222222222';
    const original = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const changed = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    const first = await h.service.restore({
      name: 'Restored',
      password: PASSWORD,
      mnemonic: original,
      operationId,
    });

    await expect(
      h.service.restore({
        name: 'Restored',
        password: PASSWORD,
        mnemonic: changed,
        operationId,
      }),
    ).rejects.toMatchObject({ code: 'ERR_INVALID_PAYLOAD' });
    expect((await h.service.list()).vaults.map((vault) => vault.vaultId)).toEqual([first.vaultId]);
  });

  it('keeps healthy vaults usable while preserving and reporting a quarantined record', async () => {
    const h = makeHarness();
    const healthy = await h.service.create({ name: 'Healthy', password: PASSWORD });
    const raw = h.local.store.get(VAULTS_KEY) as Record<string, unknown>;
    h.local.store.set(VAULTS_KEY, {
      ...raw,
      broken: { schemaVersion: 99, ciphertext: 'preserve-me' },
    });

    expect((await h.service.list()).vaults.map((vault) => vault.vaultId)).toEqual([healthy.vaultId]);
    expect((await h.service.sessionSnapshot()).quarantinedVaultCount).toBe(1);
    await expect(h.service.create({ name: 'Blocked', password: PASSWORD })).rejects.toMatchObject({
      code: 'ERR_VAULT_TAMPERED',
    });
  });

  it('returns one coherent UI session snapshot', async () => {
    const h = makeHarness();
    const { vaultId } = await h.service.restore({
      name: 'Restored',
      password: PASSWORD,
      mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    });
    const { sessionId, deadline } = await h.service.unlock({ vaultId, password: PASSWORD });

    await expect(h.service.sessionSnapshot()).resolves.toMatchObject({
      locked: false,
      activeVaultId: vaultId,
      sessionId,
      deadline,
      backupVerified: true,
      quarantinedVaultCount: 0,
      selectableAccounts: [0],
      canAddAccount: false,
      vaults: [{ vaultId, name: 'Restored' }],
    });
  });

  it('fails closed when an active-pointer write rejects during unlock', async () => {
    const h = makeHarness();
    const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
    h.local.failOnSetKey = ACTIVE_VAULT_KEY;

    await expect(h.service.unlock({ vaultId, password: PASSWORD })).rejects.toThrow(/simulated crash/u);
    expect(await getSession(h.session)).toBeNull();

    h.local.failOnSetKey = null;
    h.session.failOnSetKey = 'squirrel:session';
    await expect(h.service.unlock({ vaultId, password: PASSWORD })).rejects.toThrow(/simulated crash/u);
    expect(await getSession(h.session)).toBeNull();
    expect(await loadActiveVaultId(h.local)).toBeNull();
  });

  it('restores from a mnemonic and unlocks with the chosen password', async () => {
    const h = makeHarness();
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const { vaultId } = await h.service.restore({ name: 'Restored', password: PASSWORD, mnemonic });
    await expect(h.service.unlock({ vaultId, password: PASSWORD })).resolves.toMatchObject({ vaultId });
  });

  // ---- concurrency (MV3 interleaves handlers at every await) ----------------

  it('serializes concurrent creates so no vault is lost', async () => {
    const h = makeHarness();
    await Promise.all([
      h.service.create({ name: 'A', password: PASSWORD }),
      h.service.create({ name: 'B', password: PASSWORD }),
      h.service.create({ name: 'C', password: PASSWORD }),
    ]);
    expect((await h.service.list()).vaults).toHaveLength(3);
  });

  it('keeps the session DEK and active pointer on the same vault under concurrent unlocks (§7.3)', async () => {
    const h = makeHarness();
    const a = await h.service.create({ name: 'A', password: PASSWORD });
    const b = await h.service.create({ name: 'B', password: PASSWORD });

    await Promise.all([
      h.service.unlock({ vaultId: a.vaultId, password: PASSWORD }),
      h.service.unlock({ vaultId: b.vaultId, password: PASSWORD }),
    ]);

    const session = await getSession(h.session);
    // The two must never diverge — a mismatch would mean the live DEK belongs to
    // a different vault than the one reported active.
    expect(session?.vaultId).toBe(await loadActiveVaultId(h.local));
  });

  it('a mistyped switch password leaves the current vault unlocked (§7.3)', async () => {
    const h = makeHarness();
    const a = await h.service.create({ name: 'A', password: PASSWORD });
    const b = await h.service.create({ name: 'B', password: PASSWORD });
    await h.service.unlock({ vaultId: a.vaultId, password: PASSWORD });

    await expect(h.service.switchVault({ vaultId: b.vaultId, password: 'wrong-password-x' })).rejects.toMatchObject({
      code: 'wrong-password',
    });

    // A stays active and unlocked — the failed reauth did not lock the wallet.
    expect(await h.service.sessionStatus()).toMatchObject({ locked: false, activeVaultId: a.vaultId });
  });
});
