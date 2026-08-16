/**
 * M4 WalletService surface: seed reveal (§7.6), backup verification gate
 * (§7.1), receive addresses (§8.1/§10.6), and config ops (§7.4).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { restoreMnemonic } from '@drey/core/domain/keys/mnemonic';
import { stableExternalAddress } from '@drey/core/domain/keys/derivation';
import { verifyBip322Simple } from '@drey/core/domain/transactions/bip322';
import { getSession } from '../../src/adapters/session/session-store';
import { loadVaultMeta } from '../../src/adapters/storage/vault-store';
import { PASSWORD } from '@drey/core/testing/vault-helpers';
import { makeHarness, type Harness } from './service-helpers';

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

beforeAll(async () => {
  await installTestCryptoProvider();
});

interface ActiveExpectation {
  expectedVaultId: string;
  expectedSessionId: string;
  accountId: string;
}

async function createdUnlocked(): Promise<{ h: Harness; vaultId: string; active: ActiveExpectation }> {
  const h = makeHarness();
  const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
  const { sessionId } = await h.service.unlock({ vaultId, password: PASSWORD });
  const accountId = (await h.service.sessionSnapshot()).activeAccountId;
  if (accountId === null) throw new Error('missing active account identity');
  return {
    h,
    vaultId,
    active: { expectedVaultId: vaultId, expectedSessionId: sessionId, accountId },
  };
}

describe('revealMnemonic (§7.6)', () => {
  it('returns the generated mnemonic after password reauth', async () => {
    const { h, active } = await createdUnlocked();
    const { mnemonic } = await h.service.revealMnemonic({ password: PASSWORD, ...active });
    expect(mnemonic.split(' ')).toHaveLength(12);
    // Round-trips through the domain validator (checksum-valid, canonical).
    expect(() => restoreMnemonic(mnemonic)).not.toThrow();
  });

  it('rejects a wrong password without touching the session', async () => {
    const { h, active } = await createdUnlocked();
    const before = await getSession(h.session);
    await expect(h.service.revealMnemonic({ password: 'totally-wrong-pw', ...active })).rejects.toMatchObject({
      code: 'wrong-password',
    });
    expect(await getSession(h.session)).toEqual(before);
  });

  it('extends the idle deadline as authenticated activity', async () => {
    const { h, active } = await createdUnlocked();
    const before = await getSession(h.session);
    h.clock.now += 1000;
    await h.service.revealMnemonic({ password: PASSWORD, ...active });
    expect((await getSession(h.session))?.deadline).toBe((before?.deadline ?? 0) + 1000);
  });

  it('requires an unlocked wallet', async () => {
    const h = makeHarness();
    await h.service.create({ name: 'Main', password: PASSWORD });
    await expect(
      h.service.revealMnemonic({
        password: PASSWORD,
        expectedVaultId: 'vault-1',
        expectedSessionId: '00000000-0000-4000-8000-000000000001',
      }),
    ).rejects.toMatchObject({
      code: 'ERR_LOCKED',
    });
  });

  it('rejects a stale active-session identity after a vault switch', async () => {
    const { h, active } = await createdUnlocked();
    const b = await h.service.create({ name: 'B', password: PASSWORD });
    await h.service.switchVault({ vaultId: b.vaultId, password: PASSWORD });

    await expect(h.service.revealMnemonic({ password: PASSWORD, ...active })).rejects.toMatchObject({
      code: 'ERR_LOCKED',
    });
  });
});

describe('verifyBackup + backupStatus (§7.1)', () => {
  it('opens the gate only on a worker-verified match, with word folding', async () => {
    const { h, vaultId, active } = await createdUnlocked();
    expect(await h.service.backupStatus(active)).toMatchObject({
      backupVerified: false,
      metadata: { origin: 'generated', wordCount: 12, usageGatePassed: false },
    });

    const words = (await h.service.revealMnemonic({ password: PASSWORD, ...active })).mnemonic.split(' ');
    const wrong = await h.service.verifyBackup({
      ...active,
      wordCount: 12,
      words: [
        { index: 0, word: 'zoo' },
        { index: 5, word: words[5] ?? '' },
        { index: 11, word: words[11] ?? '' },
      ],
    });
    expect(wrong).toEqual({ verified: false });
    expect(await h.service.backupStatus(active)).toMatchObject({ backupVerified: false });

    const right = await h.service.verifyBackup({
      ...active,
      wordCount: 12,
      words: [
        { index: 2, word: `  ${(words[2] ?? '').toUpperCase()} ` }, // trim + case-fold
        { index: 7, word: words[7] ?? '' },
        { index: 9, word: words[9] ?? '' },
      ],
    });
    expect(right).toEqual({ verified: true });
    expect(await h.service.backupStatus(active)).toMatchObject({
      backupVerified: true,
      metadata: { usageGatePassed: true, lastSpotCheckAt: expect.any(Number) },
    });
    expect(await loadVaultMeta(h.local)).toMatchObject({
      [vaultId]: { backupVerified: true, metadata: { usageGatePassed: true } },
    });
  });

  it('marks restored vaults verified and clears meta on removal', async () => {
    const h = makeHarness();
    const { vaultId } = await h.service.restore({
      name: 'R',
      password: PASSWORD,
      mnemonic: VALID_MNEMONIC,
    });
    expect(await loadVaultMeta(h.local)).toMatchObject({
      [vaultId]: {
        backupVerified: true,
        metadata: { origin: 'imported', wordCount: 12, usageGatePassed: true },
      },
    });
    const unlocked = await h.service.unlock({ vaultId, password: PASSWORD });
    await h.service.removeVault({ targetVaultId: vaultId, password: PASSWORD,
      expectedVaultId: vaultId, expectedSessionId: unlocked.sessionId });
    expect(await loadVaultMeta(h.local)).toEqual({});
  });

  it('performs an aggregate full recovery rehearsal and records only success metadata', async () => {
    const { h, active } = await createdUnlocked();
    const mnemonic = (await h.service.revealMnemonic({ password: PASSWORD, ...active })).mnemonic;

    await expect(h.service.verifyFullRecovery({
      ...active,
      mnemonic: VALID_MNEMONIC,
    })).resolves.toEqual({ verified: false });
    expect((await h.service.backupStatus(active)).metadata?.lastFullRecoveryCheckAt).toBeNull();

    await expect(h.service.verifyFullRecovery({
      ...active,
      mnemonic,
    })).resolves.toEqual({ verified: true });
    expect((await h.service.backupStatus(active)).metadata?.lastFullRecoveryCheckAt)
      .toEqual(expect.any(Number));
  });
});

describe('receiveAddress (§8.1/§10.6)', () => {
  it('blocks an unverified vault with ERR_BACKUP_REQUIRED', async () => {
    const { h, active } = await createdUnlocked();
    await expect(h.service.receiveAddress({ kind: 'payment', ...active })).rejects.toMatchObject({
      code: 'ERR_BACKUP_REQUIRED',
    });
  });

  it('derives the stable external BIP84/BIP86 mainnet addresses for account 0', async () => {
    const h = makeHarness();
    const { vaultId } = await h.service.restore({
      name: 'R',
      password: PASSWORD,
      mnemonic: VALID_MNEMONIC,
    });
    const { sessionId } = await h.service.unlock({ vaultId, password: PASSWORD });
    const accountId = (await h.service.sessionSnapshot()).activeAccountId;
    if (accountId === null) throw new Error('missing active account identity');
    const active = { expectedVaultId: vaultId, expectedSessionId: sessionId, accountId };

    const { seed } = restoreMnemonic(VALID_MNEMONIC);
    const payment = await h.service.receiveAddress({ kind: 'payment', ...active });
    expect(payment).toEqual({
      accountId,
      kind: 'payment',
      network: 'mainnet',
      address: stableExternalAddress(seed, 'payment', 'mainnet', 0).address,
      path: stableExternalAddress(seed, 'payment', 'mainnet', 0).path,
    });
    const ordinals = await h.service.receiveAddress({ kind: 'ordinals', ...active });
    expect(ordinals.address).toBe(stableExternalAddress(seed, 'ordinals', 'mainnet', 0).address);
    expect(ordinals.address).not.toBe(payment.address);
  });
});

describe('manual BIP-322 signing', () => {
  it('reauthenticates, signs the chosen address kind, and post-verifies', async () => {
    const h = makeHarness();
    const { vaultId } = await h.service.restore({
      name: 'R', password: PASSWORD, mnemonic: VALID_MNEMONIC,
    });
    const { sessionId } = await h.service.unlock({ vaultId, password: PASSWORD });
    const accountId = (await h.service.sessionSnapshot()).activeAccountId;
    if (accountId === null) throw new Error('missing active account identity');
    const input = {
      accountId,
      addressKind: 'ordinals' as const,
      message: 'Drey manual signing test',
      password: PASSWORD,
      expectedVaultId: vaultId,
      expectedSessionId: sessionId,
    };
    const result = await h.service.signMessage(input);
    expect(result.protocol).toBe('BIP-322');
    expect(result.signature).toMatch(/^smp/u);
    expect(result.messageHashHex).toMatch(/^[0-9a-f]{64}$/u);
    expect(verifyBip322Simple(
      input.message, result.address, 'mainnet', result.signature,
    )).toBe(true);

    await expect(h.service.signMessage({ ...input, password: 'wrong-password-value' }))
      .rejects.toMatchObject({ code: 'wrong-password' });
  });
});

describe('address book', () => {
  it('encrypts saved recipients per vault and survives a worker restart', async () => {
    const { h, active } = await createdUnlocked();
    expect(await h.service.addressBook(active)).toMatchObject({
      version: 1, network: 'mainnet', saved: [], recent: [],
    });
    const saved = await h.service.addAddressBookRecipient({
      label: ' Alice   Savings ',
      address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
      ...active,
    });
    expect(saved.saved).toEqual([expect.objectContaining({
      label: 'Alice Savings',
      address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    })]);
    expect(await h.rebuild().addressBook(active)).toEqual(saved);
    await expect(h.service.addAddressBookRecipient({
      label: 'Duplicate',
      address: saved.saved[0]!.address,
      ...active,
    })).rejects.toMatchObject({ code: 'ERR_INVALID_PAYLOAD' });

    const imported = await h.service.importAddressBookRecipients({
      recipients: [
        { label: 'Duplicate label', address: saved.saved[0]!.address },
        { label: 'Bob', address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' },
      ],
      ...active,
    });
    expect(imported).toMatchObject({ added: 1, skipped: 1 });
    expect(imported.addressBook.saved.map((entry) => entry.label)).toEqual([
      'Alice Savings', 'Bob',
    ]);
    expect(await h.rebuild().addressBook(active)).toEqual(imported.addressBook);
  });
});

describe('config ops (§7.4)', () => {
  it('gets defaults and merges partial sets', async () => {
    const changes: string[] = [];
    const h = makeHarness(undefined, {
      notifyWalletDataChanged: (reason) => changes.push(reason),
    });
    expect(await h.service.getConfig()).toEqual({
      idleTimeoutMs: 3_600_000, highSecurityMode: false, advancedPsbtSigning: false,
    });
    const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
    const { sessionId } = await h.service.unlock({ vaultId, password: PASSWORD });
    const active = { expectedVaultId: vaultId, expectedSessionId: sessionId };
    expect(await h.service.setConfig({ idleTimeoutMs: 43_200_000, ...active })).toEqual({
      idleTimeoutMs: 43_200_000,
      highSecurityMode: false,
      advancedPsbtSigning: false,
    });
    expect(await h.service.setConfig({ highSecurityMode: true, ...active })).toEqual({
      idleTimeoutMs: 43_200_000,
      highSecurityMode: true,
      advancedPsbtSigning: false,
    });
    expect(changes).toEqual(['config', 'config']);
  });

  it('applies a one-week idle timeout to the current and next session deadlines', async () => {
    const { h, vaultId, active } = await createdUnlocked();
    await h.service.setConfig({ idleTimeoutMs: 604_800_000, ...active });
    expect((await getSession(h.session))?.deadline).toBe(h.clock.now + 604_800_000);

    await h.service.lock();
    const { deadline } = await h.service.unlock({ vaultId, password: PASSWORD });
    expect(deadline).toBe(h.clock.now + 604_800_000);
  });

  it('rejects config writes from a stale/locked session identity', async () => {
    const { h, active } = await createdUnlocked();
    await h.service.lock();

    await expect(h.service.setConfig({ idleTimeoutMs: 86_400_000, ...active })).rejects.toMatchObject({
      code: 'ERR_LOCKED',
    });
    expect(await h.service.getConfig()).toEqual({
      idleTimeoutMs: 3_600_000, highSecurityMode: false, advancedPsbtSigning: false,
    });
  });
});

describe('connected-site invalidation', () => {
  it('notifies open settings only when a permission projection actually changes', async () => {
    const changes: string[] = [];
    const h = makeHarness(undefined, {
      notifyWalletDataChanged: (reason) => changes.push(reason),
    });
    const { vaultId } = await h.service.restore({
      name: 'R', password: PASSWORD, mnemonic: VALID_MNEMONIC,
    });
    const { sessionId } = await h.service.unlock({ vaultId, password: PASSWORD });
    const active = { expectedVaultId: vaultId, expectedSessionId: sessionId };

    const grant = await h.service.providerGrantPermission(
      'https://wallet.example',
      ['addresses'],
    );
    expect(changes).toEqual(['permissions']);

    // An exact duplicate is a read of the existing projection, not a mutation.
    await h.service.providerGrantPermission('https://wallet.example', ['addresses']);
    expect(changes).toEqual(['permissions']);

    await expect(h.service.revokeConnectedSite({
      resourceId: grant.resourceId,
      ...active,
    })).resolves.toEqual({ revoked: true });
    expect(changes).toEqual(['permissions', 'permissions']);

    await expect(h.service.revokeConnectedSite({
      resourceId: grant.resourceId,
      ...active,
    })).resolves.toEqual({ revoked: false });
    expect(changes).toEqual(['permissions', 'permissions']);
  });
});
