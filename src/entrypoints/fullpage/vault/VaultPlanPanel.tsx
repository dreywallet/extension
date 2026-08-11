/**
 * The Vault plan surface: build, sign, combine, finalize, send
 * (Workstreams C3-C6).
 *
 * Split out of `VaultCoordinator.tsx` rather than added to it. The coordinator
 * page already carried ten modes and four parallel caption tables; a plan
 * lifecycle with its own five-step state does not belong in the same component
 * as the role and policy ceremonies, and keeping them together would have made
 * the one surface that can move real value the hardest one to read.
 *
 * Production transport uses a channel-bound `ur:x-drey-vault` approval
 * context plus a standards-valid `ur:psbt`. The hex field remains a diagnostic
 * fallback; production combination authenticates Mobile B's returned context.
 *
 * Nothing here decides anything. Every refusal that matters — evidence
 * freshness, asset policy, replay, an indeterminate send —
 * belongs to the worker, which re-derives the destination, re-parses the stored
 * plan from its canonical bytes, and re-checks it immediately before any key
 * is used. This component only presents and transports the reviewed values.
 */
import { Suspense, useCallback, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { useI18n } from '../../../ui/i18n';
import { useRpc } from '../../../ui/hooks/use-rpc';
import { errorMessageKey } from '../../../ui/errors';
import { Button } from '../../../ui/components/Button';
import { Field } from '../../../ui/components/Field';
import { QrCode } from '../../../ui/components/QrCode';
import styles from '../fullpage.module.css';
import type { ActiveSessionExpectation } from '../../../ui/hooks/use-session';
import type { VaultTransportPayload } from './VaultTransportScanner';
import { hexToBytes } from '@drey/core/domain/vault/encoding';
import {
  parseCanonicalVaultPlan,
  parseVaultPartialSignatureInput,
} from '@drey/core/domain/vault/multisig-encoding';
import type { VaultPsbtApprovalEnvelopeV1 } from '@drey/core/domain/vault/multisig-contracts';

interface PlanSummary {
  planId: string;
  planDigest: string;
  replacement: 'none' | 'rbf' | 'cpfp';
  destinationAddress: string;
  amountSats: string;
  changeSats: string;
  feeSats: string;
  feeRateSatPerKvB: string;
  vsize: number;
  inputCount: number;
  outputs: readonly {
    outputIndex: number; purpose: string; valueSats: string; address: string;
  }[];
  assetEffects: readonly { kind: string; assetId: string; protected: boolean }[];
  expiresAtMs: string;
}

interface MobileRequestSummary extends Omit<PlanSummary, 'outputs' | 'assetEffects'> {
  outputs: readonly string[];
  assetEffects: string;
}

interface Broadcast {
  txid: string;
  status: string;
  detail: string | null;
}

type BroadcastPosture = 'none' | 'safe-to-dispatch-once' | 'reconcile-only' | 'terminal';

export function VaultPlanPanel(props: {
  expectation: ActiveSessionExpectation;
  /** Only a build that may move value gets a plan surface at all. */
  canSign: boolean;
  TransportScanner: ComponentType<{
    kind?: 'context' | 'psbt';
    onComplete?(payload: VaultTransportPayload): void;
    onClose(): void;
  }> | null;
}): ReactNode {
  const { t } = useI18n();
  const rpc = useRpc();
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [psbtHex, setPsbtHex] = useState<string | null>(null);
  const [combinedPsbtHex, setCombinedPsbtHex] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [broadcast, setBroadcast] = useState<Broadcast | null>(null);
  const [broadcastPosture, setBroadcastPosture] = useState<BroadcastPosture>('none');
  const [amountSats, setAmountSats] = useState('');
  const [movement, setMovement] = useState<'cardinal' | 'inscription'>('cardinal');
  const [inscriptionId, setInscriptionId] = useState('');
  const [feeRate, setFeeRate] = useState('');
  const [speedUpOpen, setSpeedUpOpen] = useState(false);
  const [speedUpFeeRate, setSpeedUpFeeRate] = useState('');
  const [password, setPassword] = useState('');
  const [peerPsbtHex, setPeerPsbtHex] = useState('');
  const [transactionHex, setTransactionHex] = useState<string | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  const [depositAddress, setDepositAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [approvalFrames, setApprovalFrames] = useState<readonly string[]>([]);
  const [psbtFrames, setPsbtFrames] = useState<readonly string[]>([]);
  const [approvalFrameIndex, setApprovalFrameIndex] = useState(0);
  const [psbtFrameIndex, setPsbtFrameIndex] = useState(0);
  const [mobileEnvelope, setMobileEnvelope] = useState<
    Extract<VaultTransportPayload, { kind: 'context' }>['context'] | null
  >(null);
  const [scannerKind, setScannerKind] = useState<'context' | 'psbt' | null>(null);
  const [requestScannerKind, setRequestScannerKind] = useState<'context' | 'psbt' | null>(null);
  const [mobileRequestEnvelope, setMobileRequestEnvelope] = useState<VaultPsbtApprovalEnvelopeV1 | null>(null);
  const [mobileRequestPsbt, setMobileRequestPsbt] = useState<string | null>(null);
  const [mobileRequestSummary, setMobileRequestSummary] = useState<MobileRequestSummary | null>(null);
  const [mobileResponseFrames, setMobileResponseFrames] = useState<{
    context: readonly string[]; psbt: readonly string[];
  } | null>(null);
  const [mobileResponseContextIndex, setMobileResponseContextIndex] = useState(0);
  const [mobileResponsePsbtIndex, setMobileResponsePsbtIndex] = useState(0);

  const refresh = useCallback(async (): Promise<void> => {
    const held = await rpc('vaultCoordinator.plan', { ...props.expectation });
    if (!held.ok) return;
    setPlan(held.result.plan);
    setPsbtHex(held.result.psbtHex);
    setCombinedPsbtHex(held.result.combinedPsbtHex ?? null);
    setStale(held.result.stale);
    setBroadcast(held.result.broadcast);
    setTransactionHex(held.result.transactionHex ?? null);
    setTxid(held.result.txid ?? held.result.broadcast?.txid ?? null);
    setBroadcastPosture(held.result.broadcastPosture ??
      (held.result.broadcast === null ? 'none' : 'terminal'));
    if (held.result.mobileResponse != null) {
      setMobileResponseFrames({
        context: held.result.mobileResponse.approvalContextQrFrames,
        psbt: held.result.mobileResponse.psbtQrFrames,
      });
      setMobileResponseContextIndex(0);
      setMobileResponsePsbtIndex(0);
    }
  }, [rpc, props.expectation]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * One shape for every step: clear the last outcome, run, and surface a typed
   * refusal as copy rather than as a thrown error. Steps differ only in what
   * they do on success.
   */
  async function run(step: () => Promise<void>): Promise<void> {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await step();
    } finally {
      setBusy(false);
    }
  }

  function fail(code: Parameters<typeof errorMessageKey>[0]): void {
    setError(t(errorMessageKey(code)));
  }

  const showDeposit = (): Promise<void> =>
    run(async () => {
      const result = await rpc('vaultCoordinator.depositAddress', {
        index: 0,
        ...props.expectation,
      });
      if (!result.ok) return fail(result.code);
      setDepositAddress(result.result.address);
    });

  const build = (): Promise<void> =>
    run(async () => {
      const result = await rpc('vaultCoordinator.buildPlan', {
        movement,
        ...(movement === 'cardinal'
          ? { amountSats: amountSats.trim() }
          : { inscriptionId: inscriptionId.trim().toLowerCase() }),
        feeRateSatPerKvB: feeRate.trim(),
        ...props.expectation,
      });
      if (!result.ok) return fail(result.code);
      setPlan(result.result.plan);
      setPsbtHex(result.result.psbtHex);
      setCombinedPsbtHex(null);
      setStale(false);
      setBroadcast(null);
      setBroadcastPosture('none');
      setTransactionHex(null);
      setTxid(null);
      setPeerPsbtHex('');
      setApprovalFrames([]);
      setPsbtFrames([]);
      setApprovalFrameIndex(0);
      setPsbtFrameIndex(0);
      setMobileEnvelope(null);
    });

  const buildCpfp = (): Promise<void> =>
    run(async () => {
      const result = await rpc('vaultCoordinator.buildCpfp', {
        feeRateSatPerKvB: speedUpFeeRate.trim(),
        ...props.expectation,
      });
      if (!result.ok) return fail(result.code);
      setPlan(result.result.plan);
      setPsbtHex(result.result.psbtHex);
      setCombinedPsbtHex(null);
      setStale(false);
      setBroadcast(null);
      setBroadcastPosture('none');
      setTransactionHex(null);
      setTxid(null);
      setPeerPsbtHex('');
      setApprovalFrames([]);
      setPsbtFrames([]);
      setApprovalFrameIndex(0);
      setPsbtFrameIndex(0);
      setMobileEnvelope(null);
      setSpeedUpOpen(false);
      setSpeedUpFeeRate('');
      setNotice(t('vault.plan.cpfpBuilt'));
    });

  const sign = (): Promise<void> =>
    run(async () => {
      const result = await rpc('vaultCoordinator.signPlan', {
        password,
        ...props.expectation,
      });
      setPassword('');
      if (!result.ok) return fail(result.code);
      // Our own signed PSBT replaces the unsigned one in the transport field:
      // it is what the peer must be given, and showing the unsigned one next to
      // it would invite handing over the wrong text.
      setPsbtHex(result.result.signedPsbtHex);
      setApprovalFrames(result.result.approvalContextQrFrames);
      setPsbtFrames(result.result.psbtQrFrames);
      setApprovalFrameIndex(0);
      setPsbtFrameIndex(0);
      setNotice(t('vault.plan.signed'));
    });

  const combineAndFinalize = (): Promise<void> =>
    run(async () => {
      let quorumPsbtHex = combinedPsbtHex;
      if (quorumPsbtHex === null) {
        const combined = await rpc('vaultCoordinator.combinePlan', {
          psbtHexes: [psbtHex ?? '', peerPsbtHex.trim().toLowerCase()],
          ...(mobileEnvelope?.kind === 'approval'
            ? { mobileApprovalEnvelope: mobileEnvelope.envelope }
            : {}),
          ...props.expectation,
        });
        if (!combined.ok) return fail(combined.code);
        quorumPsbtHex = combined.result.psbtHex;
        setCombinedPsbtHex(quorumPsbtHex);
      }
      const finalized = await rpc('vaultCoordinator.finalizePlan', {
        psbtHex: quorumPsbtHex,
        ...props.expectation,
      });
      if (!finalized.ok) return fail(finalized.code);
      setTransactionHex(finalized.result.transactionHex);
      setTxid(finalized.result.txid);
      setBroadcastPosture('safe-to-dispatch-once');
      setNotice(t('vault.plan.finalized'));
    });

  const send = (): Promise<void> =>
    run(async () => {
      const result = await rpc('vaultCoordinator.broadcastPlan', {
        transactionHex: transactionHex ?? '',
        ...props.expectation,
      });
      if (!result.ok) return fail(result.code);
      setBroadcast(result.result);
      setBroadcastPosture(result.result.status === 'indeterminate' ? 'reconcile-only' : 'terminal');
    });

  const reconcile = (): Promise<void> =>
    run(async () => {
      const result = await rpc('vaultCoordinator.reconcilePlan', {
        planId: plan?.planId ?? '',
        ...props.expectation,
      });
      if (!result.ok) return fail(result.code);
      setBroadcast(result.result);
      setBroadcastPosture(result.result.status === 'indeterminate' ? 'reconcile-only' : 'terminal');
      setNotice(t('vault.plan.reconciled'));
    });

  const discard = (): Promise<void> =>
    run(async () => {
      const result = await rpc('vaultCoordinator.discardPlan', {
        planId: plan?.planId ?? '',
        ...props.expectation,
      });
      if (!result.ok) return fail(result.code);
      setPlan(null);
      setPsbtHex(null);
      setCombinedPsbtHex(null);
      setTransactionHex(null);
      setTxid(null);
      setBroadcast(null);
      setBroadcastPosture('none');
      setPeerPsbtHex('');
      setApprovalFrames([]);
      setPsbtFrames([]);
      setMobileEnvelope(null);
    });

  const signMobileRequest = (): Promise<void> => run(async () => {
    if (mobileRequestEnvelope === null || mobileRequestPsbt === null) return;
    const result = await rpc('vaultCoordinator.signMobileRequest', {
      password,
      approvalEnvelope: mobileRequestEnvelope,
      psbtHex: mobileRequestPsbt,
      ...props.expectation,
    });
    setPassword('');
    if (!result.ok) return fail(result.code);
    setMobileResponseFrames({
      context: result.result.approvalContextQrFrames,
      psbt: result.result.psbtQrFrames,
    });
    setMobileResponseContextIndex(0);
    setMobileResponsePsbtIndex(0);
    setNotice(t('vault.plan.mobileRequestSigned'));
  });

  function acceptMobileRequestPayload(payload: VaultTransportPayload): void {
    try {
      if (payload.kind === 'psbt') {
        setMobileRequestPsbt(payload.psbtHex);
      } else if (payload.kind === 'context' && payload.context.kind === 'approval' &&
          payload.context.envelope.stage === 'request') {
        const envelope = payload.context.envelope;
        const request = parseVaultPartialSignatureInput(hexToBytes(envelope.payloadHex));
        const parsed = parseCanonicalVaultPlan(hexToBytes(request.canonicalPlanHex));
        setMobileRequestEnvelope(envelope);
        setMobileRequestSummary({
          planId: parsed.planId,
          planDigest: parsed.planDigest,
          replacement: parsed.replacement.kind,
          destinationAddress: parsed.destination.address,
          amountSats: parsed.amountSats,
          changeSats: parsed.changeSats,
          feeSats: parsed.feeSats,
          feeRateSatPerKvB: parsed.feeRateSatPerKvB,
          vsize: parsed.vsize,
          inputCount: parsed.inputs.length,
          expiresAtMs: parsed.expiresAtMs,
          outputs: parsed.outputs.map((output, index) =>
            `${index}: ${output.purpose} — ${output.valueSats} sats — ${output.address}`),
          assetEffects: parsed.assetEffects.length === 0
            ? 'none'
            : parsed.assetEffects.map((effect) => `${effect.kind}:${effect.assetId}`).join(', '),
        });
        setMobileResponseFrames(null);
      }
    } catch {
      setError(t('vault.transportScanner.error.invalid'));
    }
    setRequestScannerKind(null);
  }

  function detail(term: string, value: string, code = false): ReactNode {
    return (
      <div>
        <dt>{term}</dt>
        <dd className={code ? styles['code'] : undefined}>{value}</dd>
      </div>
    );
  }

  if (!props.canSign) return null;

  return (
    <>
      <h2 className={styles['sectionTitle']}>{t('vault.plan.heading')}</h2>
      <p className={styles['rowLabel']}>{t('vault.plan.body')}</p>
      {notice !== null ? <p role="status">{notice}</p> : null}
      {error !== null ? (
        <p role="alert" className={styles['error']}>
          {error}
        </p>
      ) : null}

      {depositAddress !== null ? (
        <>
          <p className={styles['rowLabel']}>{t('vault.plan.depositBody')}</p>
          <p className={styles['code']} data-testid="vault-deposit-address">
            {depositAddress}
          </p>
        </>
      ) : null}

      {plan === null ? (
        <>
          <div className={styles['row']}>
            <Button variant={movement === 'cardinal' ? 'primary' : 'secondary'}
              onClick={() => setMovement('cardinal')}>
              {t('vault.plan.cardinal')}
            </Button>
            <Button variant={movement === 'inscription' ? 'primary' : 'secondary'}
              onClick={() => setMovement('inscription')}>
              {t('vault.plan.inscription')}
            </Button>
          </div>
          {movement === 'cardinal' ? (
            <Field
              label={t('vault.plan.amount')}
              value={amountSats}
              inputMode="numeric"
              onChange={(e) => setAmountSats(e.target.value)}
              data-testid="vault-plan-amount"
            />
          ) : (
            <Field
              label={t('vault.plan.inscriptionId')}
              value={inscriptionId}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setInscriptionId(e.target.value)}
              data-testid="vault-plan-inscription-id"
            />
          )}
          <Field
            label={t('vault.plan.feeRate')}
            value={feeRate}
            inputMode="numeric"
            onChange={(e) => setFeeRate(e.target.value)}
            data-testid="vault-plan-fee-rate"
          />
        </>
      ) : (
        <>
          <dl className={styles['details']} data-testid="vault-plan">
            {plan.replacement === 'cpfp'
              ? detail(t('vault.plan.transactionType'), t('vault.plan.cpfpType'))
              : null}
            {detail(t('vault.plan.destination'), plan.destinationAddress, true)}
            {detail(t('vault.plan.amount'), `${plan.amountSats} sats`)}
            {detail(t('vault.plan.fee'), `${plan.feeSats} sats`)}
            {detail(t('vault.plan.feeRate'), plan.feeRateSatPerKvB)}
            {detail(t('vault.plan.change'), `${plan.changeSats} sats`)}
            {detail(t('vault.plan.size'), String(plan.vsize))}
            {detail(t('vault.plan.inputs'), String(plan.inputCount))}
            {detail(t('vault.plan.outputs'), plan.outputs.map((output) =>
              `${output.outputIndex}: ${output.purpose} — ${output.valueSats} sats — ${output.address}`).join('\n'), true)}
            {detail(t('vault.plan.assets'), plan.assetEffects.length === 0 ? 'none' :
              plan.assetEffects.map((effect) =>
                `${effect.kind}${effect.assetId === '' ? '' : `:${effect.assetId}`}${effect.protected ? ' (protected)' : ''}`).join(', '))}
            {detail(t('vault.plan.digest'), plan.planDigest, true)}
            {detail(t('vault.plan.expires'), new Date(Number(plan.expiresAtMs)).toISOString())}
          </dl>
          {stale ? <p className={styles['warning']}>{t('vault.plan.stale')}</p> : null}
          {psbtHex !== null ? (
            <>
              <p className={styles['rowLabel']}>{t('vault.plan.psbt')}</p>
              <p className={styles['code']} data-testid="vault-plan-psbt">
                {psbtHex}
              </p>
            </>
          ) : null}
          {approvalFrames.length > 0 && psbtFrames.length > 0 ? (
            <section aria-labelledby="vault-mobile-approval-heading">
              <h3 id="vault-mobile-approval-heading" className={styles['sectionTitle']}>
                {t('vault.plan.mobileQrHeading')}
              </h3>
              <p className={styles['rowLabel']}>{t('vault.plan.mobileQrBody')}</p>
              <QrCode value={approvalFrames[approvalFrameIndex]!} alt={t('vault.plan.mobileContextQr')} />
              <p>{t('vault.plan.qrPart', { index: approvalFrameIndex + 1, count: approvalFrames.length })}</p>
              <div className={styles['row']}>
                <Button variant="secondary" disabled={approvalFrameIndex === 0}
                  onClick={() => setApprovalFrameIndex((index) => Math.max(0, index - 1))}>
                  {t('vault.import.challengeQrPrevious')}
                </Button>
                <Button variant="secondary" disabled={approvalFrameIndex >= approvalFrames.length - 1}
                  onClick={() => setApprovalFrameIndex((index) => Math.min(approvalFrames.length - 1, index + 1))}>
                  {t('vault.import.challengeQrNext')}
                </Button>
              </div>
              <QrCode value={psbtFrames[psbtFrameIndex]!} alt={t('vault.plan.mobilePsbtQr')} />
              <p>{t('vault.plan.qrPart', { index: psbtFrameIndex + 1, count: psbtFrames.length })}</p>
              <div className={styles['row']}>
                <Button variant="secondary" disabled={psbtFrameIndex === 0}
                  onClick={() => setPsbtFrameIndex((index) => Math.max(0, index - 1))}>
                  {t('vault.import.challengeQrPrevious')}
                </Button>
                <Button variant="secondary" disabled={psbtFrameIndex >= psbtFrames.length - 1}
                  onClick={() => setPsbtFrameIndex((index) => Math.min(psbtFrames.length - 1, index + 1))}>
                  {t('vault.import.challengeQrNext')}
                </Button>
              </div>
            </section>
          ) : null}
          {/* The same hex-in-a-text-field transport the import ceremony uses. */}
          <Field
            label={t('vault.plan.peerPsbt')}
            value={peerPsbtHex}
            autoComplete="off"
            spellCheck={false}
            maxLength={200_000}
            onChange={(e) => setPeerPsbtHex(e.target.value)}
            data-testid="vault-plan-peer-psbt"
          />
          {props.TransportScanner !== null ? (
            <>
              <div className={styles['row']}>
                <Button variant="secondary" onClick={() => setScannerKind('context')}>
                  {t('vault.plan.scanMobileContext')}
                </Button>
                <Button variant="secondary" onClick={() => setScannerKind('psbt')}>
                  {t('vault.plan.scanMobilePsbt')}
                </Button>
              </div>
              {scannerKind !== null ? (
                <Suspense fallback={<p role="status">{t('common.loading')}</p>}>
                  <props.TransportScanner
                    kind={scannerKind}
                    onClose={() => setScannerKind(null)}
                    onComplete={(payload) => {
                      if (payload.kind === 'psbt') setPeerPsbtHex(payload.psbtHex);
                      else if (payload.kind === 'context' && payload.context.kind === 'approval') {
                        setMobileEnvelope(payload.context);
                      }
                      setScannerKind(null);
                    }}
                  />
                </Suspense>
              ) : null}
            </>
          ) : null}
          {transactionHex !== null ? (
            <>
              <p className={styles['rowLabel']}>{t('vault.plan.transaction')}</p>
              <p className={styles['code']} data-testid="vault-plan-transaction">
                {transactionHex}
              </p>
              {txid !== null ? (
                <dl className={styles['details']}>{detail(t('vault.plan.txid'), txid, true)}</dl>
              ) : null}
            </>
          ) : null}
          {broadcast !== null ? (
            <dl className={styles['details']} data-testid="vault-plan-broadcast">
              {detail(t('vault.plan.broadcastState'), broadcast.status)}
              {detail(t('vault.plan.txid'), broadcast.txid, true)}
              {broadcast.detail !== null ? detail(t('vault.plan.body'), broadcast.detail) : null}
            </dl>
          ) : null}
          {plan.replacement === 'none' &&
              (broadcast?.status === 'accepted' || broadcast?.status === 'already_known') ? (
            <section aria-labelledby="vault-cpfp-heading" data-testid="vault-cpfp">
              <h3 id="vault-cpfp-heading" className={styles['sectionTitle']}>
                {t('vault.plan.cpfpHeading')}
              </h3>
              <p className={styles['rowLabel']}>{t('vault.plan.cpfpBody')}</p>
              {speedUpOpen ? (
                <>
                  <Field
                    label={t('vault.plan.cpfpFeeRate')}
                    value={speedUpFeeRate}
                    inputMode="numeric"
                    onChange={(e) => setSpeedUpFeeRate(e.target.value)}
                    data-testid="vault-cpfp-fee-rate"
                  />
                  <div className={styles['row']}>
                    <Button variant="secondary" disabled={busy}
                      onClick={() => {
                        setSpeedUpOpen(false);
                        setSpeedUpFeeRate('');
                      }}>
                      {t('common.cancel')}
                    </Button>
                    <Button disabled={busy || speedUpFeeRate.trim() === ''}
                      onClick={() => void buildCpfp()}>
                      {t('vault.plan.cpfpBuild')}
                    </Button>
                  </div>
                </>
              ) : (
                <Button variant="secondary" disabled={busy} onClick={() => setSpeedUpOpen(true)}>
                  {t('vault.plan.cpfpOpen')}
                </Button>
              )}
            </section>
          ) : null}
          {broadcastPosture === 'reconcile-only' ? (
            <div data-testid="vault-plan-reconcile-only">
              <p role="alert">{t('vault.plan.reconcileOnly')}</p>
              <Button variant="secondary" disabled={busy} onClick={() => void reconcile()}>
                {t('vault.plan.reconcile')}
              </Button>
            </div>
          ) : broadcastPosture === 'safe-to-dispatch-once' ? (
            <p role="status">{t('vault.plan.preparedResume')}</p>
          ) : null}
        </>
      )}

      {plan !== null || mobileRequestSummary !== null ? (
        <Field
          label={t('unlock.password')}
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          data-testid="vault-plan-password"
        />
      ) : null}

      <div className={styles['row']}>
        <Button variant="secondary" disabled={busy} onClick={() => void showDeposit()}>
          {t('vault.plan.depositShow')}
        </Button>
        {plan === null ? (
          <Button
            disabled={busy || feeRate.trim() === '' || (movement === 'cardinal'
              ? amountSats.trim() === ''
              : inscriptionId.trim() === '')}
            onClick={() => void build()}
          >
            {t('vault.plan.build')}
          </Button>
        ) : (
          <>
            <Button disabled={busy || stale || password === ''} onClick={() => void sign()}>
              {t('vault.plan.sign')}
            </Button>
            <Button
              disabled={busy || stale || (combinedPsbtHex === null && peerPsbtHex.trim() === '')}
              onClick={() => void combineAndFinalize()}
            >
              {t('vault.plan.finalize')}
            </Button>
            <Button
              variant="danger"
              disabled={busy || stale || transactionHex === null || broadcast !== null ||
                broadcastPosture === 'reconcile-only' || broadcastPosture === 'terminal'}
              onClick={() => void send()}
            >
              {t('vault.plan.broadcast')}
            </Button>
            <Button variant="secondary" disabled={busy || broadcastPosture === 'reconcile-only'} onClick={() => void discard()}>
              {t('vault.plan.discard')}
            </Button>
          </>
        )}
      </div>
      {props.TransportScanner !== null ? (
        <section aria-labelledby="vault-mobile-request-heading">
          <h2 id="vault-mobile-request-heading" className={styles['sectionTitle']}>
            {t('vault.plan.mobileRequestHeading')}
          </h2>
          <p className={styles['rowLabel']}>{t('vault.plan.mobileRequestBody')}</p>
          <div className={styles['row']}>
            <Button variant="secondary" onClick={() => setRequestScannerKind('context')}>
              {t('vault.plan.scanMobileRequest')}
            </Button>
            <Button variant="secondary" onClick={() => setRequestScannerKind('psbt')}>
              {t('vault.plan.scanMobileRequestPsbt')}
            </Button>
          </div>
          {requestScannerKind !== null ? (
            <Suspense fallback={<p role="status">{t('common.loading')}</p>}>
              <props.TransportScanner
                kind={requestScannerKind}
                onClose={() => setRequestScannerKind(null)}
                onComplete={acceptMobileRequestPayload}
              />
            </Suspense>
          ) : null}
          {mobileRequestSummary !== null ? (
            <>
              <dl className={styles['details']} data-testid="vault-mobile-request-review">
                {mobileRequestSummary.replacement === 'cpfp'
                  ? detail(t('vault.plan.transactionType'), t('vault.plan.cpfpType'))
                  : null}
                {detail(t('vault.plan.destination'), mobileRequestSummary.destinationAddress, true)}
                {detail(t('vault.plan.amount'), `${mobileRequestSummary.amountSats} sats`)}
                {detail(t('vault.plan.fee'), `${mobileRequestSummary.feeSats} sats`)}
                {detail(t('vault.plan.feeRate'), mobileRequestSummary.feeRateSatPerKvB)}
                {detail(t('vault.plan.change'), `${mobileRequestSummary.changeSats} sats`)}
                {detail(t('vault.plan.vsize'), String(mobileRequestSummary.vsize))}
                {detail(t('vault.plan.inputs'), String(mobileRequestSummary.inputCount))}
                {detail(t('vault.plan.outputs'), mobileRequestSummary.outputs.join('\n'), true)}
                {detail(t('vault.plan.assets'), mobileRequestSummary.assetEffects)}
                {detail(t('vault.plan.digest'), mobileRequestSummary.planDigest, true)}
                {detail(t('vault.plan.expires'), new Date(Number(mobileRequestSummary.expiresAtMs)).toISOString())}
              </dl>
              <Button
                disabled={busy || password === '' || mobileRequestPsbt === null}
                onClick={() => void signMobileRequest()}
              >
                {t('vault.plan.signMobileRequest')}
              </Button>
            </>
          ) : null}
          {mobileResponseFrames !== null ? (
            <>
              <QrCode value={mobileResponseFrames.context[mobileResponseContextIndex]!}
                alt={t('vault.plan.mobileResultContextQr')} />
              <div className={styles['row']}>
                <Button variant="secondary" disabled={mobileResponseContextIndex === 0}
                  onClick={() => setMobileResponseContextIndex((index) => Math.max(0, index - 1))}>
                  {t('vault.import.challengeQrPrevious')}
                </Button>
                <Button variant="secondary"
                  disabled={mobileResponseContextIndex >= mobileResponseFrames.context.length - 1}
                  onClick={() => setMobileResponseContextIndex((index) => Math.min(mobileResponseFrames.context.length - 1, index + 1))}>
                  {t('vault.import.challengeQrNext')}
                </Button>
              </div>
              <QrCode value={mobileResponseFrames.psbt[mobileResponsePsbtIndex]!}
                alt={t('vault.plan.mobileResultPsbtQr')} />
              <div className={styles['row']}>
                <Button variant="secondary" disabled={mobileResponsePsbtIndex === 0}
                  onClick={() => setMobileResponsePsbtIndex((index) => Math.max(0, index - 1))}>
                  {t('vault.import.challengeQrPrevious')}
                </Button>
                <Button variant="secondary"
                  disabled={mobileResponsePsbtIndex >= mobileResponseFrames.psbt.length - 1}
                  onClick={() => setMobileResponsePsbtIndex((index) => Math.min(mobileResponseFrames.psbt.length - 1, index + 1))}>
                  {t('vault.import.challengeQrNext')}
                </Button>
              </div>
            </>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
