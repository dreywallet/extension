/**
 * The Vault plan lifecycle at the service level (Workstreams C4-C6).
 *
 * Scope note: core's golden vectors own PSBT construction, partial signing,
 * combination, and finalization, and `vault-signing.test.ts` already proves the
 * extension reaches them through the B3-safe wrappers. None of that is retested
 * here. What is asserted is what C4-C6 added and nothing else — the round trip
 * completes at all, and each of the four ways it must refuse actually refuses.
 *
 * Role B's signature comes from the disposable fixture root through the same
 * transport a real peer would use: PSBT hex, no envelope.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { PASSWORD } from '@drey/core/testing/vault-helpers';
import { bytesToHex, hexToBytes } from '@drey/core/domain/vault/encoding';
import {
  parseCanonicalVaultPlan,
  serializeVaultPartialSignatureInput,
  signVaultPsbtApprovalEnvelope,
} from '@drey/core/domain/vault/multisig-encoding';
import { buildVaultCardinalWithdrawal } from '@drey/core/domain/vault/multisig-planning';
import { createVaultAssetSafePartialSignatureInput } from '@drey/core/domain/vault/multisig-asset-policy';
import { scanVaultPolicy } from '@drey/core/domain/vault/multisig-scan';
import type { VaultUnsignedPlanV1 } from '@drey/core/domain/vault/multisig-contracts';
import { Transaction } from '@scure/btc-signer';
import { VAULT_EVIDENCE_TTL_MS } from '../../src/background/vault-evidence';
import { loadVaultApprovedPlans, loadVaultPolicy } from '../../src/adapters/storage/vault-coordinator-store';
import { deriveVaultEvidenceSource, projectVaultUtxo } from '../../src/background/vault-evidence';
import { TIP, withGateway, type VaultGatewayHarness } from '../fixtures/vault-service-gateway';
import { thirdPartySignedPsbt } from '../helpers/third-party-signer';
import { peerOrigin, signerRoot } from '../fixtures/vault-peer-signers';

beforeAll(installTestCryptoProvider);

/** A funded Vault: one proven-clean cardinal output on receive/0. */
async function fundedVault(
  options: Parameters<typeof withGateway>[0] = { utxos: [] },
): Promise<VaultGatewayHarness> {
  const bootstrap = await withGateway({ utxos: [] });
  const receive = bootstrap.script('receive', 0);
  return withGateway({
    ...options,
    utxos: [
      { ...receive, txid: 'aa'.repeat(32), vout: 0, valueSats: '400000', height: TIP.height - 5 },
    ],
  });
}

async function inscriptionVault(options: Parameters<typeof withGateway>[0] = { utxos: [] }) {
  const bootstrap = await withGateway({ utxos: [] });
  const protectedOutput = bootstrap.script('receive', 0);
  const feeOutput = bootstrap.script('receive', 1);
  const inscriptionId = `${'ef'.repeat(32)}i0`;
  const harness = await withGateway({
    ...options,
    utxos: [
      {
        ...protectedOutput,
        txid: 'ab'.repeat(32),
        vout: 0,
        valueSats: '12000',
        height: TIP.height - 5,
        classification: {
          primaryClass: 'inscribed',
          inscriptions: [{ inscriptionId, satpoint: `${'ab'.repeat(32)}:0:0` }],
        },
      },
      {
        ...feeOutput,
        txid: 'cd'.repeat(32),
        vout: 1,
        valueSats: '400000',
        height: TIP.height - 5,
      },
    ],
  });
  return { harness, inscriptionId };
}

/**
 * Role B signing the way a separate device would: handed PSBT hex, signs, hands
 * hex back. It knows nothing about a plan digest, an SQVB envelope, or the
 * coordinator — which is exactly the transport C4 provides.
 */
function peerSign(h: VaultGatewayHarness, psbtHex: string, plan: VaultUnsignedPlanV1): string {
  return thirdPartySignedPsbt({
    policy: h.identity,
    plan,
    psbtHex,
    role: 'mobile-b',
  }).psbtHex;
}

function holdServiceQueue(service: VaultGatewayHarness['service']): {
  release(): void;
  held: Promise<unknown>;
} {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const held = (service as unknown as {
    runExclusive<T>(fn: () => Promise<T>): Promise<T>;
  }).runExclusive(() => gate);
  return { release, held };
}

describe('C4-C6 the withdrawal round trip', () => {
  it('linearizes signing and lock on the same service queue in either race order', async () => {
    const lockFirst = await fundedVault();
    await lockFirst.service.vaultCoordinatorBuildPlan({
      amountSats: '100000', feeRateSatPerKvB: '5000', ...lockFirst.expectation,
    });
    const firstGate = holdServiceQueue(lockFirst.service);
    const locked = lockFirst.service.lock();
    const refusedSign = lockFirst.service.vaultCoordinatorSignPlan({
      password: PASSWORD,
      ...lockFirst.expectation,
    });
    firstGate.release();
    await firstGate.held;
    await expect(locked).resolves.toEqual({ locked: true });
    await expect(refusedSign).rejects.toMatchObject({ code: 'ERR_LOCKED' });

    const signFirst = await fundedVault();
    await signFirst.service.vaultCoordinatorBuildPlan({
      amountSats: '100000', feeRateSatPerKvB: '5000', ...signFirst.expectation,
    });
    const secondGate = holdServiceQueue(signFirst.service);
    const order: string[] = [];
    const signed = signFirst.service.vaultCoordinatorSignPlan({
      password: PASSWORD,
      ...signFirst.expectation,
    }).then((result) => {
      order.push('sign');
      return result;
    });
    const relocked = signFirst.service.lock().then((result) => {
      order.push('lock');
      return result;
    });
    secondGate.release();
    await secondGate.held;
    await expect(signed).resolves.toMatchObject({ roleAdded: 'desktop-a' });
    await expect(relocked).resolves.toEqual({ locked: true });
    expect(order).toEqual(['sign', 'lock']);
    await expect(signFirst.service.sessionStatus()).resolves.toMatchObject({ locked: true });
  }, 45_000);

  it('builds, signs as A, takes B over the hex transport, finalizes, and sends', async () => {
    const h = await fundedVault();
    const built = await h.service.vaultCoordinatorBuildPlan({
      amountSats: '100000',
      feeRateSatPerKvB: '5000',
      ...h.expectation,
    });
    // The destination is derived, never supplied: there is no request field a
    // caller could point somewhere else.
    expect(built.plan.destinationAddress).toMatch(/^tb1/u);
    expect(built.plan.inputCount).toBe(1);

    const signed = await h.service.vaultCoordinatorSignPlan({
      password: PASSWORD,
      ...h.expectation,
    });
    expect(signed.roleAdded).toBe('desktop-a');

    const record = (await loadVaultApprovedPlans(h.local))[0]!;
    const plan = parseCanonicalVaultPlan(hexToBytes(record.canonicalPlanHex));
    const combined = await h.service.vaultCoordinatorCombinePlan({
      psbtHexes: [signed.signedPsbtHex, peerSign(h, built.psbtHex, plan)],
      ...h.expectation,
    });
    expect(combined.roles).toEqual(['desktop-a', 'mobile-b']);

    const finalized = await h.service.vaultCoordinatorFinalizePlan({
      psbtHex: combined.psbtHex,
      ...h.expectation,
    });
    // Core already re-verified the witness; what matters here is that the
    // transaction the coordinator hands out is the plan's own bytes.
    expect(Transaction.fromRaw(hexToBytes(finalized.transactionHex)).id).toBe(finalized.txid);
    expect(finalized.vsize).toBeLessThanOrEqual(plan.vsize);

    const outcome = await h.service.vaultCoordinatorBroadcastPlan({
      transactionHex: finalized.transactionHex,
      ...h.expectation,
    });
    expect(outcome).toMatchObject({ status: 'accepted', txid: finalized.txid });
    expect(h.broadcasts).toHaveLength(1);
    expect(h.broadcasts[0]!.transactionHex).toBe(finalized.transactionHex);
  }, 30_000);

  it('accelerates an accepted parent by spending only its freshly observed Vault change', async () => {
    const h = await fundedVault();
    const parentFinalized = await finalizeVault(h);
    await expect(h.service.vaultCoordinatorBroadcastPlan({
      transactionHex: parentFinalized.transactionHex,
      ...h.expectation,
    })).resolves.toMatchObject({ status: 'accepted', txid: parentFinalized.txid });

    const parentRecord = (await loadVaultApprovedPlans(h.local))[0]!;
    const parentPlan = parseCanonicalVaultPlan(hexToBytes(parentRecord.canonicalPlanHex));
    const change = parentPlan.outputs.find((output) => output.purpose === 'vault-change')!;
    const changeScript = h.script('change', change.derivationIndex!);
    h.utxos.splice(0, h.utxos.length, {
      ...changeScript,
      txid: parentFinalized.txid,
      vout: change.outputIndex,
      valueSats: change.valueSats,
      height: null,
    });

    const child = await h.service.vaultCoordinatorBuildCpfp({
      feeRateSatPerKvB: '20000',
      ...h.expectation,
    });
    expect(child.plan).toMatchObject({ replacement: 'cpfp', inputCount: 1 });
    const records = await loadVaultApprovedPlans(h.local);
    expect(records).toHaveLength(2);
    const childPlan = parseCanonicalVaultPlan(hexToBytes(records[0]!.canonicalPlanHex));
    expect(childPlan.replacement).toMatchObject({
      kind: 'cpfp',
      parentTxid: parentFinalized.txid,
    });
    expect(childPlan.inputs[0]).toMatchObject({
      txid: parentFinalized.txid,
      vout: change.outputIndex,
      valueSats: change.valueSats,
    });

    const signed = await h.service.vaultCoordinatorSignPlan({
      password: PASSWORD,
      ...h.expectation,
    });
    const combined = await h.service.vaultCoordinatorCombinePlan({
      psbtHexes: [signed.signedPsbtHex, peerSign(h, child.psbtHex, childPlan)],
      ...h.expectation,
    });
    const finalized = await h.service.vaultCoordinatorFinalizePlan({
      psbtHex: combined.psbtHex,
      ...h.expectation,
    });
    await expect(h.service.vaultCoordinatorBroadcastPlan({
      transactionHex: finalized.transactionHex,
      ...h.expectation,
    })).resolves.toMatchObject({ status: 'accepted', txid: finalized.txid });
    expect(h.broadcasts.map((request) => request.txid)).toEqual([
      parentFinalized.txid,
      finalized.txid,
    ]);
  }, 45_000);

  it('resumes an interrupted inscription migration before signing, after signing, and after dispatch', async () => {
    let releaseBroadcast!: () => void;
    let reachedBroadcast!: () => void;
    const release = new Promise<void>((resolve) => { releaseBroadcast = resolve; });
    const reached = new Promise<void>((resolve) => { reachedBroadcast = resolve; });
    const { harness: h, inscriptionId } = await inscriptionVault({
      utxos: [],
      broadcast: { ok: false },
      broadcastBarrier: { reached: reachedBroadcast, release },
    });
    const built = await h.service.vaultCoordinatorBuildPlan({
      movement: 'inscription',
      inscriptionId,
      feeRateSatPerKvB: '5000',
      ...h.expectation,
    });
    expect(built.plan.assetEffects[0]).toMatchObject({
      kind: 'inscription', assetId: inscriptionId, protected: true,
    });

    // Fresh workers continue the exact durable unit instead of manufacturing
    // a replacement or losing its Full Sat Safety evidence.
    const beforeSigning = h.rebuild();
    await expect(beforeSigning.vaultCoordinatorPlan(h.expectation)).resolves.toMatchObject({
      plan: { planDigest: built.plan.planDigest }, stale: false,
    });
    const signed = await beforeSigning.vaultCoordinatorSignPlan({
      password: PASSWORD,
      ...h.expectation,
    });
    const record = (await loadVaultApprovedPlans(h.local))[0]!;
    const plan = parseCanonicalVaultPlan(hexToBytes(record.canonicalPlanHex));
    const combined = await beforeSigning.vaultCoordinatorCombinePlan({
      psbtHexes: [signed.signedPsbtHex, peerSign(h, built.psbtHex, plan)],
      ...h.expectation,
    });
    const afterSigning = h.rebuild();
    const resumedQuorum = await afterSigning.vaultCoordinatorPlan(h.expectation);
    expect(resumedQuorum.combinedPsbtHex).toBe(combined.psbtHex);
    const finalized = await afterSigning.vaultCoordinatorFinalizePlan({
      psbtHex: resumedQuorum.combinedPsbtHex!,
      ...h.expectation,
    });
    await expect(h.rebuild().vaultCoordinatorPlan(h.expectation)).resolves.toMatchObject({
      transactionHex: finalized.transactionHex,
      txid: finalized.txid,
      broadcastPosture: 'safe-to-dispatch-once',
    });

    const inFlight = afterSigning.vaultCoordinatorBroadcastPlan({
      transactionHex: finalized.transactionHex,
      ...h.expectation,
    });
    await reached;
    const afterPossibleDispatch = h.rebuild();
    await expect(afterPossibleDispatch.vaultCoordinatorBroadcastPlan({
      transactionHex: finalized.transactionHex,
      ...h.expectation,
    })).rejects.toMatchObject({ code: 'ERR_VAULT_BROADCAST_INDETERMINATE' });
    expect(h.broadcasts).toHaveLength(1);
    releaseBroadcast();
    await expect(inFlight).resolves.toMatchObject({ status: 'indeterminate' });
    expect(h.broadcasts).toHaveLength(1);
  }, 30_000);

  it('proves a deposit address from the policy rather than storing one', async () => {
    const h = await fundedVault();
    const first = await h.service.vaultCoordinatorDepositAddress({ index: 0, ...h.expectation });
    const again = await h.service.vaultCoordinatorDepositAddress({ index: 0, ...h.expectation });
    expect(first.address).toBe(again.address);
    // Regenerated, so it is the policy's own receive-0 script and not a stored
    // string that could have been edited underneath the coordinator.
    expect(first.scriptPubKeyHex).toBe(h.script('receive', 0).scriptPubKey);
  }, 20_000);
});

describe('C6 refuses rather than guessing', () => {
  it('refuses a Mobile-coordinated request while a Desktop plan remains active', async () => {
    const h = await fundedVault();
    await h.service.vaultCoordinatorBuildPlan({
      amountSats: '100000',
      feeRateSatPerKvB: '5000',
      ...h.expectation,
    });
    await expect(h.service.vaultCoordinatorSignMobileRequest({
      password: PASSWORD,
      approvalEnvelope: {} as never,
      psbtHex: '00',
      ...h.expectation,
    })).rejects.toMatchObject({
      code: 'ERR_VAULT_PLAN_REJECTED',
      message: expect.stringContaining('explicitly discarded'),
    });
  }, 20_000);

  it('durably reissues the exact Desktop response to a Mobile request after restart', async () => {
    const h = await fundedVault();
    const temporary = await h.service.vaultCoordinatorBuildPlan({
      amountSats: '100000', feeRateSatPerKvB: '5000', ...h.expectation,
    });
    const held = (await loadVaultApprovedPlans(h.local))[0]!;
    const desktopPlan = parseCanonicalVaultPlan(hexToBytes(held.canonicalPlanHex));
    await h.service.vaultCoordinatorDiscardPlan({ planId: temporary.plan.planId, ...h.expectation });

    const scan = await scanVaultPolicy({ policy: h.identity, network: 'signet', gateway: h.gateway });
    const status = await h.gateway.fetchStatus();
    expect(scan.result.ok && status.ok).toBe(true);
    if (!scan.result.ok || !status.ok) throw new Error('fixture scan failed');
    const source = deriveVaultEvidenceSource({
      network: 'signet', status: status.status, scan: scan.source, nowMs: h.clock.now,
    });
    if (!source.ok) throw new Error(`fixture source refused: ${source.refusal}`);
    const utxos = scan.result.utxos.map((row) => projectVaultUtxo(row, source.source));
    if (utxos.some((row) => row === null)) throw new Error('fixture projection failed');
    const built = buildVaultCardinalWithdrawal({
      policy: h.identity,
      source: source.source,
      utxos: utxos as NonNullable<(typeof utxos)[number]>[],
      destinationAddress: desktopPlan.destination.address,
      pairedSpendingWalletIdHash: desktopPlan.destination.pairedSpendingWalletIdHash!,
      broadcastIntent: 'broadcast',
      amountSats: '100000',
      feeRateSatPerKvB: '5000',
      changeDerivationIndex: 1,
      planId: '31'.repeat(16),
      requestId: '32'.repeat(16),
      createdAtMs: String(h.clock.now),
      expiresAtMs: source.source.validUntilMs,
    });
    const request = createVaultAssetSafePartialSignatureInput({
      policy: h.identity,
      plan: built.plan,
      role: 'desktop-a',
      psbtHex: built.psbtHex,
      evidence: built.evidence,
      nowMs: String(h.clock.now),
    });
    const stored = await loadVaultPolicy(h.local);
    if (stored.state !== 'valid' || stored.stored.transport === null) throw new Error('transport absent');
    const transport = stored.stored.transport;
    const root = signerRoot('mobile-b');
    let envelope;
    try {
      envelope = signVaultPsbtApprovalEnvelope({
        version: 1,
        network: 'signet',
        policyId: built.plan.policyId,
        planId: built.plan.planId,
        planDigest: built.plan.planDigest,
        senderChannelIdHex: transport.mobileChannelIdHex,
        recipientChannelIdHex: transport.extensionChannelIdHex,
        counter: String(BigInt(transport.highestInboundCounter) + 1n),
        expiresAtMs: built.plan.expiresAtMs,
        antiReplayNonceHex: '41'.repeat(32),
        transcriptHashHex: transport.transcriptHashHex,
        stage: 'request',
        payloadHex: bytesToHex(serializeVaultPartialSignatureInput(request)),
      }, root, peerOrigin('mobile-b'));
    } finally {
      root.wipePrivateData();
    }
    const input = { password: PASSWORD, approvalEnvelope: envelope, psbtHex: built.psbtHex, ...h.expectation };
    const first = await h.service.vaultCoordinatorSignMobileRequest(input);
    const afterFirst = await loadVaultPolicy(h.local);
    const replay = await h.rebuild().vaultCoordinatorSignMobileRequest(input);
    const afterReplay = await loadVaultPolicy(h.local);
    expect(replay).toEqual(first);
    expect(afterReplay).toEqual(afterFirst);
    await expect(h.rebuild().vaultCoordinatorPlan(h.expectation)).resolves.toMatchObject({
      mobileResponse: first,
    });
  }, 30_000);

  it('refuses to sign or send a plan whose evidence has expired', async () => {
    const h = await fundedVault();
    await h.service.vaultCoordinatorBuildPlan({
      amountSats: '100000',
      feeRateSatPerKvB: '5000',
      ...h.expectation,
    });
    // Past the window the evidence itself declared. The classification snapshot
    // no longer describes a chain state anyone has checked.
    h.clock.now += VAULT_EVIDENCE_TTL_MS + 1;
    const held = await h.service.vaultCoordinatorPlan({ ...h.expectation });
    expect(held.stale).toBe(true);
    await expect(
      h.service.vaultCoordinatorSignPlan({ password: PASSWORD, ...h.expectation }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_PLAN_STALE' });
    await expect(
      h.service.vaultCoordinatorBroadcastPlan({ transactionHex: 'aa', ...h.expectation }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_PLAN_STALE' });
  }, 20_000);

  it('re-reads the signed status immediately before sending', async () => {
    // FINDING, from the first live pilot withdrawal: the signed status envelope
    // IS the fee binding for a custom-rate broadcast, and the gateway refuses
    // one older than two minutes. Sending with whatever happened to be cached
    // was rejected with INVALID_BINDING, because a human confirmation prompt
    // had been open across the window. Nothing here can model the gateway's
    // clock, so what is pinned is the behaviour that fixes it: the send hits
    // the status endpoint itself rather than trusting the last scan's read.
    const h = await sentVault();
    const beforeSend = h.statusFetchesBeforeSend;
    expect(h.harness.statusFetches.count).toBeGreaterThan(beforeSend);
  }, 30_000);

  it('refuses to send a transaction that is not the plan of record', async () => {
    const h = await fundedVault();
    await h.service.vaultCoordinatorBuildPlan({
      amountSats: '100000',
      feeRateSatPerKvB: '5000',
      ...h.expectation,
    });
    const record = (await loadVaultApprovedPlans(h.local))[0]!;
    const plan = parseCanonicalVaultPlan(hexToBytes(record.canonicalPlanHex));
    // A structurally valid transaction that simply is not this plan's: one
    // output value moved by a satoshi.
    const forged = Transaction.fromRaw(hexToBytes(plan.unsignedTransactionHex));
    const other = new Transaction({ PSBTVersion: 0 });
    for (let i = 0; i < forged.inputsLength; i += 1) other.addInput(forged.getInput(i));
    for (let i = 0; i < forged.outputsLength; i += 1) {
      const output = forged.getOutput(i);
      other.addOutput({ script: output.script!, amount: output.amount! - (i === 0 ? 1n : 0n) });
    }
    await expect(
      h.service.vaultCoordinatorBroadcastPlan({
        transactionHex: Buffer.from(other.unsignedTx).toString('hex'),
        ...h.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_PLAN_MISSING' });
    expect(h.broadcasts).toHaveLength(0);
  }, 20_000);

  it('refuses a second send of a plan it already sent', async () => {
    const h = await sentVault();
    await expect(
      h.harness.service.vaultCoordinatorBroadcastPlan({
        transactionHex: h.transactionHex,
        ...h.harness.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_PLAN_ALREADY_BROADCAST' });
    // The point is not the error, it is that nothing left the coordinator.
    expect(h.harness.broadcasts).toHaveLength(1);
  }, 30_000);

  it('records an unreachable gateway as indeterminate and never resends', async () => {
    // The outcome that must not look like a plan that was never sent. The exact
    // bytes stay on file for reconciliation; a retry refuses until a human has
    // established what is actually on chain.
    const h = await sentVault({ broadcast: { ok: false } });
    expect(h.outcome.status).toBe('indeterminate');
    const held = await h.harness.service.vaultCoordinatorPlan({ ...h.harness.expectation });
    expect(held.broadcast).toMatchObject({ status: 'indeterminate', txid: h.outcome.txid });
    await expect(
      h.harness.service.vaultCoordinatorBroadcastPlan({
        transactionHex: h.transactionHex,
        ...h.harness.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_BROADCAST_INDETERMINATE' });
    await expect(h.harness.service.vaultCoordinatorDiscardPlan({
      planId: (await h.harness.service.vaultCoordinatorPlan(h.harness.expectation)).plan!.planId,
      ...h.harness.expectation,
    })).rejects.toMatchObject({ code: 'ERR_VAULT_BROADCAST_INDETERMINATE' });
    expect(h.harness.broadcasts).toHaveLength(1);
  }, 30_000);

  it('resumes the same prepared bytes after status was unavailable before dispatch', async () => {
    const statusControl = { failuresRemaining: 0 };
    const h = await fundedVault({ utxos: [], statusControl });
    const finalized = await finalizeVault(h);
    statusControl.failuresRemaining = 100;
    await expect(h.service.vaultCoordinatorBroadcastPlan({
      transactionHex: finalized.transactionHex,
      ...h.expectation,
    })).rejects.toMatchObject({ code: 'ERR_DATA_STALE' });
    statusControl.failuresRemaining = 0;
    expect(h.broadcasts).toHaveLength(0);
    await expect(h.rebuild().vaultCoordinatorPlan(h.expectation)).resolves.toMatchObject({
      transactionHex: finalized.transactionHex,
      txid: finalized.txid,
      broadcastPosture: 'safe-to-dispatch-once',
    });
    await expect(h.rebuild().vaultCoordinatorBroadcastPlan({
      transactionHex: finalized.transactionHex,
      ...h.expectation,
    })).resolves.toMatchObject({ status: 'accepted', txid: finalized.txid });
    expect(h.broadcasts).toHaveLength(1);
  }, 30_000);

  it('reconciles an indeterminate txid from signed Vault history without dispatching again', async () => {
    const reconciliationControl = {
      txid: null as string | null,
      confirmationState: 'mempool' as const,
    };
    const h = await sentVault({ broadcast: { ok: false }, reconciliationControl });
    reconciliationControl.txid = h.outcome.txid;
    const plan = await h.harness.service.vaultCoordinatorPlan(h.harness.expectation);
    const outcome = await h.harness.service.vaultCoordinatorReconcilePlan({
      planId: plan.plan!.planId,
      ...h.harness.expectation,
    });
    expect(outcome).toMatchObject({ status: 'accepted', txid: h.outcome.txid });
    expect(h.harness.broadcasts).toHaveLength(1);
    await expect(h.harness.service.vaultCoordinatorDiscardPlan({
      planId: plan.plan!.planId,
      ...h.harness.expectation,
    })).resolves.toEqual({ removed: true });
  }, 30_000);
});

async function finalizeVault(harness: VaultGatewayHarness) {
  const built = await harness.service.vaultCoordinatorBuildPlan({
    amountSats: '100000', feeRateSatPerKvB: '5000', ...harness.expectation,
  });
  const signed = await harness.service.vaultCoordinatorSignPlan({
    password: PASSWORD, ...harness.expectation,
  });
  const record = (await loadVaultApprovedPlans(harness.local))[0]!;
  const plan = parseCanonicalVaultPlan(hexToBytes(record.canonicalPlanHex));
  const combined = await harness.service.vaultCoordinatorCombinePlan({
    psbtHexes: [signed.signedPsbtHex, peerSign(harness, built.psbtHex, plan)],
    ...harness.expectation,
  });
  return harness.service.vaultCoordinatorFinalizePlan({
    psbtHex: combined.psbtHex, ...harness.expectation,
  });
}

/** Drive a plan all the way to a completed send, whatever the gateway said. */
async function sentVault(
  options: {
    broadcast?: Parameters<typeof withGateway>[0]['broadcast'];
    reconciliationControl?: Parameters<typeof withGateway>[0]['reconciliationControl'];
  } = {},
): Promise<{
  harness: VaultGatewayHarness;
  /** Status-endpoint hits at the moment before the broadcast was attempted. */
  statusFetchesBeforeSend: number;
  transactionHex: string;
  outcome: Awaited<ReturnType<VaultGatewayHarness['service']['vaultCoordinatorBroadcastPlan']>>;
}> {
  const harness = await fundedVault(
    {
      utxos: [],
      ...(options.broadcast === undefined ? {} : { broadcast: options.broadcast }),
      ...(options.reconciliationControl === undefined ? {} : {
        reconciliationControl: options.reconciliationControl,
      }),
    },
  );
  const finalized = await finalizeVault(harness);
  const statusFetchesBeforeSend = harness.statusFetches.count;
  const outcome = await harness.service.vaultCoordinatorBroadcastPlan({
    transactionHex: finalized.transactionHex,
    ...harness.expectation,
  });
  return {
    harness,
    statusFetchesBeforeSend,
    transactionHex: finalized.transactionHex,
    outcome,
  };
}
