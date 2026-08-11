import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch } from '../../src/background/dispatch';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import type { MessageEnvelope, SenderContext } from '@drey/core/messaging/envelope';
import { OP_SCHEMAS, type OpRegistry } from '@drey/core/messaging/ops';
import { PASSWORD } from '@drey/core/testing/vault-helpers';
import { createSecretScanner, type NamedSecret } from '../e2e/heap-scanner';
import { makeHarness } from './service-helpers';

beforeAll(async () => {
  await installTestCryptoProvider();
});

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = `acct_mainnet_${'1'.repeat(64)}`;

function env(sender: SenderContext, op: string, payload: unknown): MessageEnvelope {
  return { protocolVersion: 1, requestId: 'req-0', sender, op, payload };
}

function scanObservedErrors(secrets: readonly NamedSecret[], values: readonly unknown[]): string[] {
  const scanner = createSecretScanner(secrets);
  for (const value of values) {
    if (value instanceof Error) {
      scanner.push(`${value.name}\n${value.message}\n${value.stack ?? ''}`);
      if (value.cause !== undefined) scanner.push(String(value.cause));
    } else {
      scanner.push(JSON.stringify(value) ?? String(value));
    }
  }
  return scanner.labels();
}

describe('RPC dispatch', () => {
  it('rejects an unknown op', async () => {
    const { service } = makeHarness();
    expect(await dispatch(env('popup', 'vault.teleport', {}), service)).toEqual({
      ok: false,
      code: 'ERR_UNKNOWN_OPERATION',
    });
  });

  it('rejects a disallowed sender context', async () => {
    const { service } = makeHarness();
    expect(await dispatch(env('content-bridge', 'vault.list', {}), service)).toEqual({
      ok: false,
      code: 'ERR_UNAUTHORIZED_CONTEXT',
    });
    expect(await dispatch(env('approval', 'vault.list', {}), service)).toEqual({
      ok: false,
      code: 'ERR_UNAUTHORIZED_CONTEXT',
    });
  });

  it('rejects a malformed payload', async () => {
    const { service } = makeHarness();
    expect(await dispatch(env('popup', 'vault.unlock', {}), service)).toEqual({
      ok: false,
      code: 'ERR_INVALID_PAYLOAD',
    });
  });

  it('maps a wrong password to ERR_WRONG_PASSWORD', async () => {
    const { service } = makeHarness();
    const { vaultId } = await service.create({ name: 'Main', password: PASSWORD });
    expect(await dispatch(env('popup', 'vault.unlock', { vaultId, password: 'nope-nope-nope' }), service)).toEqual({
      ok: false,
      code: 'ERR_WRONG_PASSWORD',
    });
  });

  it('maps a weak password to ERR_WEAK_PASSWORD', async () => {
    const { service } = makeHarness();
    expect(
      await dispatch(
        env('popup', 'vault.create', { name: 'Main', password: 'short', operationId: OPERATION_ID }),
        service,
      ),
    ).toEqual({
      ok: false,
      code: 'ERR_WEAK_PASSWORD',
    });
  });

  it('never carries secret-bearing request values into observable error surfaces', async () => {
    const mnemonic = 'drey-invalid-mnemonic-sentinel';
    const passphrase = 'drey-passphrase-error-sentinel';
    const password = 'drey-password-error-sentinel';
    const secrets = [
      { label: 'mnemonic', value: mnemonic },
      { label: 'passphrase', value: passphrase },
      { label: 'password', value: password },
    ] as const;
    const { service } = makeHarness();
    const observed: unknown[] = [];

    observed.push(await dispatch(env('onboarding', 'vault.restore', {
      name: 'Invalid restore',
      password: PASSWORD,
      mnemonic,
      passphrase,
      operationId: OPERATION_ID,
    }), service));
    try {
      await service.restore({ name: 'Invalid restore', password: PASSWORD, mnemonic, passphrase });
    } catch (error) {
      observed.push(error);
    }

    const { vaultId } = await service.create({ name: 'Main', password: PASSWORD });
    observed.push(await dispatch(env('popup', 'vault.unlock', { vaultId, password }), service));
    try {
      await service.unlock({ vaultId, password });
    } catch (error) {
      observed.push(error);
    }

    expect(observed).toHaveLength(4);
    expect(scanObservedErrors(secrets, observed)).toEqual([]);
  });

  it('returns a validated result on success', async () => {
    const { service } = makeHarness();
    const res = await dispatch(
      env('popup', 'vault.create', { name: 'Main', password: PASSWORD, operationId: OPERATION_ID }),
      service,
    );
    expect(res).toEqual({ ok: true, result: { vaultId: `operation:create:${OPERATION_ID}` } });
  });

  it('applies the locked-privacy gate for requiresUnlock ops (§7.5)', async () => {
    const { service } = makeHarness();
    // Synthetic registry: mark vault.list as requiring an unlock session.
    const gated: OpRegistry = {
      ...OP_SCHEMAS,
      'vault.list': { ...OP_SCHEMAS['vault.list'], requiresUnlock: true },
    };
    const { vaultId } = await service.create({ name: 'Main', password: PASSWORD });

    expect(await dispatch(env('popup', 'vault.list', {}), service, gated)).toEqual({
      ok: false,
      code: 'ERR_LOCKED',
    });

    await service.unlock({ vaultId, password: PASSWORD });
    const res = await dispatch(env('popup', 'vault.list', {}), service, gated);
    expect(res).toMatchObject({ ok: true });
  });

  it('binds session.touch to the live session and wallet UI senders only', async () => {
    const { service } = makeHarness();
    const { vaultId } = await service.create({ name: 'Main', password: PASSWORD });
    const { sessionId } = await service.unlock({ vaultId, password: PASSWORD });
    const payload = { expectedVaultId: vaultId, expectedSessionId: sessionId };

    await expect(dispatch(env('popup', 'session.touch', payload), service))
      .resolves.toMatchObject({ ok: true, result: { deadline: expect.any(Number) } });
    await expect(dispatch(env('approval', 'session.touch', payload), service))
      .resolves.toEqual({ ok: false, code: 'ERR_UNAUTHORIZED_CONTEXT' });
    await expect(dispatch(env('content-bridge', 'session.touch', payload), service))
      .resolves.toEqual({ ok: false, code: 'ERR_UNAUTHORIZED_CONTEXT' });
    await expect(dispatch(env('fullpage', 'session.touch', {
      ...payload,
      expectedSessionId: '00000000-0000-4000-8000-000000000099',
    }), service)).resolves.toEqual({ ok: false, code: 'ERR_LOCKED' });
  });

  it('binds Home snapshot hydration to the exact session/account and wallet UI senders', async () => {
    const { service } = makeHarness();
    const { vaultId } = await service.create({ name: 'Main', password: PASSWORD });
    const { sessionId } = await service.unlock({ vaultId, password: PASSWORD });
    const payload = {
      accountId: ACCOUNT_ID,
      expectedVaultId: vaultId,
      expectedSessionId: sessionId,
    };

    await expect(dispatch(env('popup', 'wallet.home.snapshot', payload), service))
      .resolves.toEqual({ ok: true, result: { home: null } });
    await expect(dispatch(env('approval', 'wallet.home.snapshot', payload), service))
      .resolves.toEqual({ ok: false, code: 'ERR_UNAUTHORIZED_CONTEXT' });
    await expect(dispatch(env('popup', 'wallet.home.snapshot', {
      ...payload,
      accountId: 'not-an-account',
    }), service)).resolves.toEqual({ ok: false, code: 'ERR_INVALID_PAYLOAD' });
    await expect(dispatch(env('sidepanel', 'wallet.home.snapshot', {
      ...payload,
      expectedSessionId: '00000000-0000-4000-8000-000000000099',
    }), service)).resolves.toEqual({ ok: false, code: 'ERR_LOCKED' });
  });

  it('pages cached activity only for the live account and trusted wallet surfaces', async () => {
    const { service } = makeHarness();
    const { vaultId } = await service.create({ name: 'Main', password: PASSWORD });
    const { sessionId } = await service.unlock({ vaultId, password: PASSWORD });
    const expectation = { expectedVaultId: vaultId, expectedSessionId: sessionId };
    const accounts = await service.listAccounts(expectation);
    const accountId = accounts.accounts[0]?.accountId;
    if (accountId === undefined) throw new Error('missing default account');
    const payload = { ...expectation, accountId, cursor: null };

    await expect(dispatch(env('popup', 'activity.list', payload), service))
      .resolves.toEqual({ ok: true, result: {
        accountId,
        items: [],
        nextCursor: null,
        reset: false,
      } });
    await expect(dispatch(env('fullpage', 'activity.list', payload), service))
      .resolves.toMatchObject({ ok: true, result: { accountId } });
    await expect(dispatch(env('approval', 'activity.list', payload), service))
      .resolves.toEqual({ ok: false, code: 'ERR_UNAUTHORIZED_CONTEXT' });
    await expect(dispatch(env('popup', 'activity.list', {
      ...payload,
      expectedSessionId: '00000000-0000-4000-8000-000000000099',
    }), service)).resolves.toEqual({ ok: false, code: 'ERR_LOCKED' });
    await expect(dispatch(env('popup', 'activity.list', {
      ...payload,
      accountId: `acct_mainnet_${'f'.repeat(64)}`,
    }), service)).resolves.toEqual({ ok: false, code: 'ERR_INVALID_PAYLOAD' });
  });

  it('admits full-page activity previews to the ordinary unlock gate', async () => {
    const { service } = makeHarness();
    const session = {
      accountId: ACCOUNT_ID,
      expectedVaultId: 'vault-1',
      expectedSessionId: '00000000-0000-4000-8000-000000000001',
    };
    const item = {
      txid: 'a'.repeat(64),
      inscriptionId: `${'b'.repeat(64)}i0`,
    };
    for (const [op, payload] of [
      ['activity.inscriptionPreview', { ...session, ...item }],
      ['activity.inscriptionPreviewBatch', { ...session, items: [item] }],
    ] as const) {
      await expect(dispatch(env('fullpage', op, payload), service))
        .resolves.toEqual({ ok: false, code: 'ERR_LOCKED' });
      await expect(dispatch(env('approval', op, payload), service))
        .resolves.toEqual({ ok: false, code: 'ERR_UNAUTHORIZED_CONTEXT' });
    }
  });

  it('routes trusted BIP-321 resolution through its handler-owned unlock gate', async () => {
    const { service } = makeHarness();
    const { vaultId } = await service.create({ name: 'Main', password: PASSWORD });
    const input = 'bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?amount=0.00001';
    const locked = {
      input,
      expectedVaultId: vaultId,
      expectedSessionId: '00000000-0000-4000-8000-000000000001',
    };
    await expect(dispatch(env('popup', 'paymentInstruction.resolve', locked), service))
      .resolves.toEqual({ ok: false, code: 'ERR_LOCKED' });

    const { sessionId } = await service.unlock({ vaultId, password: PASSWORD });
    const active = { ...locked, expectedSessionId: sessionId };
    await expect(dispatch(env('popup', 'paymentInstruction.resolve', active), service))
      .resolves.toEqual({ ok: true, result: {
        address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
        amountSats: '1000',
        label: null,
        message: null,
      } });
    await expect(dispatch(env('content-bridge', 'paymentInstruction.resolve', active), service))
      .resolves.toEqual({ ok: false, code: 'ERR_UNAUTHORIZED_CONTEXT' });
    await expect(dispatch(env('popup', 'paymentInstruction.resolve', {
      ...active,
      input: `${input}&req-pop=https%3A%2F%2Fevil.example`,
    }), service)).resolves.toEqual({
      ok: false,
      code: 'ERR_INVALID_PAYMENT_INSTRUCTION',
    });
    await expect(dispatch(env('popup', 'paymentInstruction.resolve', {
      ...active,
      input: 'é'.repeat(5_000),
    }), service)).resolves.toEqual({
      ok: false,
      code: 'ERR_INVALID_PAYMENT_INSTRUCTION',
    });
  });

  it('locks address.receive behind the session gate (§7.5)', async () => {
    const { service } = makeHarness();
    await service.create({ name: 'Main', password: PASSWORD });
    expect(
      await dispatch(
        env('popup', 'address.receive', {
          accountId: ACCOUNT_ID,
          kind: 'payment',
          expectedVaultId: 'vault-1',
          expectedSessionId: '00000000-0000-4000-8000-000000000001',
        }),
        service,
      ),
    ).toEqual({
      ok: false,
      code: 'ERR_LOCKED',
    });
  });

  it('blocks receive with ERR_BACKUP_REQUIRED until the §7.1 gate opens', async () => {
    const { service } = makeHarness();
    const { vaultId } = await service.create({ name: 'Main', password: PASSWORD });
    const { sessionId } = await service.unlock({ vaultId, password: PASSWORD });
    const accountId = (await service.sessionSnapshot()).activeAccountId;
    expect(accountId).not.toBeNull();
    const active = { expectedVaultId: vaultId, expectedSessionId: sessionId };
    expect(await dispatch(env('popup', 'address.receive', {
      accountId: accountId!, kind: 'payment', ...active,
    }), service)).toEqual({
      ok: false,
      code: 'ERR_BACKUP_REQUIRED',
    });

    const revealed = await service.revealMnemonic({ password: PASSWORD, ...active });
    const words = revealed.mnemonic.split(' ');
    const verify = await dispatch(
      env('onboarding', 'vault.verifyBackup', {
        ...active,
        words: [0, 5, 11].map((index) => ({ index, word: words[index] })),
      }),
      service,
    );
    expect(verify).toEqual({ ok: true, result: { verified: true } });

    const res = await dispatch(env('popup', 'address.receive', {
      accountId: accountId!, kind: 'payment', ...active,
    }), service);
    expect(res).toMatchObject({ ok: true, result: { kind: 'payment', network: 'mainnet' } });
  });

  it('maps a wrong reveal password to ERR_WRONG_PASSWORD and keeps the session live', async () => {
    const { service } = makeHarness();
    const { vaultId } = await service.create({ name: 'Main', password: PASSWORD });
    const { deadline, sessionId } = await service.unlock({ vaultId, password: PASSWORD });
    expect(
      await dispatch(
        env('fullpage', 'vault.revealMnemonic', {
          password: 'wrong-wrong-wrong',
          expectedVaultId: vaultId,
          expectedSessionId: sessionId,
        }),
        service,
      ),
    ).toEqual({
      ok: false,
      code: 'ERR_WRONG_PASSWORD',
    });
    const status = await service.sessionStatus();
    expect(status.locked).toBe(false);
    expect(status.deadline).toBe(deadline);
  });

  it('routes gateway.status while locked and returns the sanctioned view shape', async () => {
    const { service } = makeHarness();
    const res = await dispatch(env('popup', 'gateway.status', {}), service);
    // Harness wires no GatewayClient: the view is an honest unreachable.
    expect(res).toEqual({
      ok: true,
      result: {
        state: 'unreachable',
        network: null,
        mode: null,
        missingProtections: [],
        tipHeight: null,
        verifiedAtMs: null,
        ageMs: null,
        lastReason: null,
        walletDataFresh: false,
        spendingReady: false,
        commonTip: null,
        classificationState: null,
        reorgState: null,
      },
    });
  });

  it('routes the optional fiat quote while locked without exposing wallet data', async () => {
    const { service } = makeHarness();
    expect(await dispatch(env('popup', 'price.quote', {}), service)).toEqual({
      ok: true,
      result: null,
    });
  });

  it('rejects gateway.status from the content-bridge and with session fields', async () => {
    const { service } = makeHarness();
    expect(await dispatch(env('content-bridge', 'gateway.status', {}), service)).toEqual({
      ok: false,
      code: 'ERR_UNAUTHORIZED_CONTEXT',
    });
    expect(
      await dispatch(env('popup', 'gateway.status', { expectedVaultId: 'v' }), service),
    ).toEqual({ ok: false, code: 'ERR_INVALID_PAYLOAD' });
  });
});

describe('RPC dispatch locked-privacy preflight', () => {
  it('still refuses a self-gated op while locked', async () => {
    // gallery.cached skips the shared preflight, so its own requireSession is
    // the whole locked-privacy gate. It has to hold on its own.
    const { service } = makeHarness();
    await service.create({ name: 'Main', password: PASSWORD });

    expect(await dispatch(env('popup', 'gallery.cached', {
      accountId: ACCOUNT_ID,
      expectedVaultId: 'vault-1',
      expectedSessionId: '00000000-0000-4000-8000-000000000001',
    }), service)).toEqual({ ok: false, code: 'ERR_LOCKED' });
    expect(await dispatch(env('popup', 'gallery.home.cached', {
      accountId: ACCOUNT_ID,
      expectedVaultId: 'vault-1',
      expectedSessionId: '00000000-0000-4000-8000-000000000001',
    }), service)).toEqual({ ok: false, code: 'ERR_LOCKED' });
  });

  it('does not queue a self-gated op behind the service lock', async () => {
    // The preflight calls sessionStatus(), which runs through the exclusive
    // queue. Dispatching gallery.cached through it while a long operation held
    // that queue would serialize the paint-ahead read behind the very batch it
    // exists to precede — which the service-level test cannot observe, because
    // it never goes through the dispatcher at all.
    const { service } = makeHarness();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const queued = (service as unknown as {
      runExclusive: <T>(fn: () => Promise<T>) => Promise<T>;
    }).runExclusive(() => held);

    const answered = await Promise.race([
      dispatch(env('popup', 'gallery.cached', {
        accountId: ACCOUNT_ID,
        expectedVaultId: 'vault-1',
        expectedSessionId: '00000000-0000-4000-8000-000000000001',
      }), service).then(() => 'dispatched' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 250)),
    ]);
    release();
    await queued;

    expect(answered).toBe('dispatched');
  });
});
