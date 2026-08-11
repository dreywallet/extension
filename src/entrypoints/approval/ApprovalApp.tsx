import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { APPROVAL_PORT_NAME, approvalSnapshotSchema, type ApprovalSnapshot } from '../../provider/approval';
import { PROVIDER_BRIDGE_VERSION } from '../../provider/bridge';
import { Button } from '../../ui/components/Button';
import { Field } from '../../ui/components/Field';
import { InscriptionReview, parseInscriptionReview } from '../../ui/components/InscriptionReview';
import { SatFlow, parseSatFlowModel } from '../../ui/components/SatFlow';
import { BrandMark } from '../../ui/components/BrandMark';
import { useI18n, type MessageKey } from '../../ui/i18n';
import styles from './approval.module.css';

function approvalCopy(
  method: string,
  t: ReturnType<typeof useI18n>['t'],
): { title: string; description: string } {
  switch (method) {
    case 'wallet_connect':
      return {
        title: t('approval.connect.title'),
        description: t('approval.connect.description'),
      };
    case 'wallet_requestPermissions':
      return {
        title: t('approval.permissions.title'),
        description: t('approval.permissions.description'),
      };
    case 'signMessage':
      return {
        title: t('approval.message.title'),
        description: t('approval.message.description'),
      };
    case 'signPsbt':
      return {
        title: t('approval.transaction.title'),
        description: t('approval.transaction.description'),
      };
    case 'sendTransfer':
      return {
        title: t('approval.send.title'),
        description: t('approval.send.description'),
      };
    case 'ord_sendInscriptions':
      return {
        title: t('approval.inscription.title'),
        description: t('approval.inscription.description'),
      };
    default:
      return {
        title: t('approval.default.title'),
        description: t('approval.default.description'),
      };
  }
}

const WARNING_COPY: Readonly<Record<string, MessageKey>> = {
  punycode: 'approval.warning.punycode',
  mixed_script: 'approval.warning.mixedScript',
  confusable: 'approval.warning.confusable',
  security_list_expired: 'approval.warning.securityExpired',
  security_list_invalid: 'approval.warning.securityInvalid',
  high_absolute_fee: 'approval.warning.highAbsoluteFee',
  high_relative_fee: 'approval.warning.highRelativeFee',
  fee_above_target: 'approval.warning.aboveTarget',
};

function warningCopy(code: string, t: ReturnType<typeof useI18n>['t']): string {
  const key = WARNING_COPY[code];
  return key ? t(key) : t('approval.warning.wallet');
}

function approvalAction(method: string, t: ReturnType<typeof useI18n>['t']): string {
  switch (method) {
    case 'wallet_connect':
      return t('approval.action.connect');
    case 'wallet_requestPermissions':
      return t('approval.action.allow');
    case 'signMessage':
      return t('approval.action.signMessage');
    case 'signPsbt':
      return t('approval.action.signTransaction');
    case 'sendTransfer':
    case 'ord_sendInscriptions':
      return t('approval.action.signAndSend');
    default:
      return t('approval.approve');
  }
}

export function ApprovalApp(): ReactNode {
  const { t, lang } = useI18n();
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const requestNonceRef = useRef<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [snapshot, setSnapshot] = useState<ApprovalSnapshot | null>(null);
  const [snapshotInvalid, setSnapshotInvalid] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [feeRate, setFeeRate] = useState('');
  const [previewUnavailableAcknowledged, setPreviewUnavailableAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [approvalReady, setApprovalReady] = useState(false);

  useEffect(() => {
    const port = chrome.runtime.connect({ name: APPROVAL_PORT_NAME });
    portRef.current = port;
    const onMessage = (raw: unknown): void => {
      const parsed = approvalSnapshotSchema.safeParse(raw);
      if (!parsed.success) {
        requestNonceRef.current = null;
        setSnapshot(null);
        setSnapshotInvalid(true);
        setBusy(false);
        setApprovalReady(false);
        return;
      }
      setSnapshotInvalid(false);
      setSnapshot(parsed.data);
      const nextNonce = parsed.data.request?.requestNonce ?? null;
      const requestChanged = nextNonce !== requestNonceRef.current;
      requestNonceRef.current = nextNonce;
      const details = parsed.data.request?.details;
      if (requestChanged) {
        setPassword('');
        setConfirmation('');
        setPreviewUnavailableAcknowledged(false);
        setFeeRate(
          details && typeof details === 'object' && 'feeRateSatPerVb' in details &&
            typeof details.feeRateSatPerVb === 'string'
            ? details.feeRateSatPerVb
            : '',
        );
        setApprovalReady(
          parsed.data.request !== null && Date.now() >= parsed.data.request.approveAfter,
        );
      } else if (
        details && typeof details === 'object' && 'feeRateSatPerVb' in details &&
        typeof details.feeRateSatPerVb === 'string'
      ) {
        setFeeRate(details.feeRateSatPerVb);
      }
      setBusy(false);
    };
    const onDisconnect = (): void => {
      portRef.current = null;
      window.close();
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    port.postMessage({ type: 'drey:approval', protocolVersion: PROVIDER_BRIDGE_VERSION, command: 'snapshot' });
    return () => {
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      port.disconnect();
      portRef.current = null;
    };
  }, []);

  const requestNonce = snapshot?.request?.requestNonce ?? null;
  const approveAfter = snapshot?.request?.approveAfter ?? null;
  useEffect(() => {
    if (requestNonce === null || approveAfter === null) {
      setApprovalReady(false);
      return undefined;
    }
    const scrollingElement = document.scrollingElement ?? document.documentElement;
    scrollingElement.scrollTop = 0;
    scrollingElement.scrollLeft = 0;
    headingRef.current?.focus();
    const remaining = approveAfter - Date.now();
    if (remaining <= 0) {
      setApprovalReady(true);
      return undefined;
    }
    setApprovalReady(false);
    const timer = window.setTimeout(() => setApprovalReady(true), remaining);
    return () => window.clearTimeout(timer);
  }, [approveAfter, requestNonce]);

  const resolve = useCallback((approved: boolean) => {
    const request = snapshot?.request;
    const port = portRef.current;
    if (!request || !port || (approved && !approvalReady)) return;
    setBusy(true);
    port.postMessage({
      type: 'drey:approval',
      protocolVersion: PROVIDER_BRIDGE_VERSION,
      command: 'resolve',
      requestNonce: request.requestNonce,
      approved,
      ...(password === '' ? {} : { password }),
      ...(confirmation === '' ? {} : { confirmation }),
      ...(previewUnavailableAcknowledged ? { previewUnavailableAcknowledged: true } : {}),
    });
  }, [approvalReady, confirmation, password, previewUnavailableAcknowledged, snapshot?.request]);

  const request = snapshot?.request;
  if (snapshotInvalid) {
    return (
      <main className={styles['card']}>
        <BrandMark />
        <h1>{t('approval.reviewUnavailable.title')}</h1>
        <p role="alert" className={styles['warning']}>{t('approval.reviewUnavailable.body')}</p>
        <Button onClick={() => window.close()}>{t('approval.close')}</Button>
      </main>
    );
  }
  if (!request) {
    return <main className={styles['card']}><BrandMark /><p>{t('approval.waiting')}</p></main>;
  }
  const details = request.details && typeof request.details === 'object'
    ? request.details as Record<string, unknown>
    : null;
  const security = details?.['security'] && typeof details['security'] === 'object'
    ? details['security'] as Record<string, unknown>
    : null;
  const advancedPsbt = request.method === 'signPsbt' && security?.['requiresAdvanced'] === true;
  const marketplace = details?.['marketplace'] && typeof details['marketplace'] === 'object'
    ? details['marketplace'] as Record<string, unknown>
    : null;
  const validConfirmation = request.confirmationPhrase === null || confirmation === request.confirmationPhrase;
  const validPassword = !request.requiresPassword || password !== '';
  const parsedFeeRate = Number(feeRate);
  const editableFee = request.method === 'sendTransfer' || request.method === 'ord_sendInscriptions';
  const copy = approvalCopy(request.method, t);
  const review = request.review;
  const message = review.kind === 'message' ? review.message : null;
  const outputs = review.kind === 'transaction' ? review.outputs : [];
  // Presentation only: a null model simply means no diagram. It never gates
  // approval and never affects the inscription review below.
  const satFlowModel = parseSatFlowModel(details);
  const inscriptionReview = parseInscriptionReview(details?.['inscriptions']);
  const inscriptionEffectCountValid = details?.['inscriptions'] === undefined ||
    (typeof details?.['effectCount'] === 'number' && Number.isSafeInteger(details['effectCount']) &&
      details['effectCount'] === inscriptionReview.items.length);
  const inscriptionReviewValid = inscriptionReview.valid && inscriptionEffectCountValid;
  const requiresPreviewAcknowledgement = details?.['requiresPreviewAcknowledgement'] === true ||
    inscriptionReview.items.some((item) => item.preview.kind === 'placeholder');
  const transactionWarnings = Array.isArray(details?.['warnings'])
    ? details['warnings'].flatMap((warning) => {
        if (warning !== null && typeof warning === 'object' && 'code' in warning &&
            typeof warning.code === 'string') return [warning.code];
        return [];
      })
    : [];
  const warningCodes = [...new Set([...request.warnings, ...transactionWarnings])];
  const formatSats = (value: string): string =>
    `${BigInt(value).toLocaleString(lang)} sats`;
  const technicalDetails = details === null
    ? request.details
    : Object.fromEntries(Object.entries(details).filter(([key]) =>
        key !== 'authority' && key !== 'inscriptions' && key !== 'requiresPreviewAcknowledgement'));

  return (
    <main className={styles['card']}>
      <BrandMark />
      <p className={styles['eyebrow']}>{t('approval.eyebrow')}</p>
      <h1 ref={headingRef} tabIndex={-1}>{marketplace ? `${String(marketplace['name'])}: ${String(marketplace['action']).replaceAll('_', ' ')}` : copy.title}</h1>
      <p className={styles['origin']}>{request.unicodeOrigin}</p>
      {request.origin !== request.unicodeOrigin ? <code>{request.origin}</code> : null}
      <p className={styles['description']}>{copy.description}</p>
      {marketplace ? (
        <div className={styles['message']}>
          <strong>{t('approval.marketplace.verified')}</strong>
          <p>
            {String(marketplace['name'])} · {String(marketplace['role'])} · {String(marketplace['assetKind'])}
            {' · '}{t('approval.marketplace.step', {
              step: String(marketplace['step']),
              count: String(marketplace['stepCount']),
            })}
          </p>
          <p>{marketplace['broadcaster'] === 'wallet'
            ? t('approval.marketplace.walletBroadcasts')
            : t('approval.marketplace.siteBroadcasts')}</p>
        </div>
      ) : null}
      <dl className={styles['summary']}>
        <div><dt>{t('approval.wallet')}</dt><dd>{review.walletName}</dd></div>
        <div><dt>{t('approval.account')}</dt><dd>{t('approval.accountNumber', { number: review.account + 1 })}</dd></div>
        <div>
          <dt>{t('approval.network')}</dt>
          <dd>{review.network === 'mainnet' ? 'Mainnet' : 'Signet'}</dd>
        </div>
        {review.kind === 'transaction' ? (
          <div><dt>{t('approval.networkFee')}</dt><dd>{formatSats(review.feeSats)}</dd></div>
        ) : null}
        {review.kind === 'transaction' && BigInt(review.netWalletDebitSats) >= 0n ? (
          <div>
            <dt>{t('approval.walletDebit')}</dt>
            <dd>{formatSats(review.netWalletDebitSats)}</dd>
          </div>
        ) : null}
        {review.kind === 'transaction' && BigInt(review.netWalletDebitSats) < 0n ? (
          <div>
            <dt>{t('approval.walletCredit')}</dt>
            <dd>{formatSats(review.netWalletDebitSats.slice(1))}</dd>
          </div>
        ) : null}
        {review.kind === 'transaction'
          ? review.economicClaims.map((claim) => (
              <div key={claim.kind}>
                <dt>{t(`approval.economics.${claim.kind}` as MessageKey)}</dt>
                <dd>{formatSats(claim.valueSats)}</dd>
              </div>
            ))
          : null}
      </dl>
      {review.kind === 'connection' ? (
        <div className={styles['message']}>
          <strong>{t('approval.sharedInformation')}</strong>
          <ul>
            {review.categories.map((category) => (
              <li key={category}>{t(`approval.category.${category}` as MessageKey)}</li>
            ))}
            {review.purposes.map((purpose) => (
              <li key={purpose}>{t(`approval.purpose.${purpose}` as MessageKey)}</li>
            ))}
            {review.categories.length === 0 && review.purposes.length === 0
              ? <li>{t('approval.category.connection')}</li>
              : null}
          </ul>
          <p>{t('approval.connectionNoSpending')}</p>
        </div>
      ) : null}
      {review.kind === 'transaction' && review.authorization === 'partial' ? (
        <div role="alert" className={styles['warning']}>
          <strong>{t('approval.partial.title')}</strong>
          <p>{t('approval.partial.body')}</p>
        </div>
      ) : null}
      {warningCodes.length > 0 || advancedPsbt ? (
        <div role="alert" className={styles['warning']}>
          <strong>{t('approval.warnings')}</strong>
          {warningCodes.length > 0 ? (
            <ul>{warningCodes.map((warning) => <li key={warning}>{warningCopy(warning, t)}</li>)}</ul>
          ) : null}
          {advancedPsbt ? (
            <p>{t('approval.advanced')}</p>
          ) : null}
        </div>
      ) : null}
      {marketplace?.['flexible'] === true ? (
        <div role="alert" className={styles['warning']}>
          <strong>{t('approval.flexible.title')}</strong>
          <p>{t('approval.flexible.body')}</p>
        </div>
      ) : null}
      {message !== null ? (
        <div className={styles['message']}>
          <strong>{t('approval.message.label')}</strong>
          <p>{message}</p>
        </div>
      ) : null}
      {satFlowModel === null ? null : <SatFlow model={satFlowModel} />}
      {outputs.length > 0 ? (
        <div className={styles['outputs']}>
          <strong>{outputs.length === 1
            ? t('approval.destination')
            : t('approval.destinations')}</strong>
          <ul>
            {outputs.map((output, index) => (
              <li key={output.index}>
                <span>
                  {String(output.address ?? output.ownership ??
                    t('approval.output', { number: index + 1 }))}
                  {' · '}
                  {t(`approval.role.${output.role}` as MessageKey)}
                </span>
                <strong>
                  {formatSats(output.valueSats)}
                  {!output.committed ? ` · ${t('approval.outputChangeable')}` : ''}
                </strong>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!inscriptionReviewValid ? (
        <p role="alert" className={styles['warning']}>
          {t('approval.inscription.invalid')}
        </p>
      ) : (
        <InscriptionReview
          items={inscriptionReview.items}
          acknowledgementChecked={previewUnavailableAcknowledged}
          onAcknowledgementChange={setPreviewUnavailableAcknowledged}
        />
      )}
      <details className={styles['technical']} open={advancedPsbt}>
        <summary>{t('approval.technical')}</summary>
        <pre className={styles['details']}>{JSON.stringify(technicalDetails, null, 2)}</pre>
      </details>
      {request.approvalError ? <p role="alert" className={styles['warning']}>{request.approvalError}</p> : null}
      {editableFee ? (
        <details className={styles['technical']}>
          <summary>{t('approval.adjustFee')}</summary>
          <Field label={t('send.fee.rate')} type="number" value={feeRate}
            onChange={(event) => setFeeRate(event.target.value)} />
          <Button variant="secondary" disabled={busy || !Number.isInteger(parsedFeeRate) || parsedFeeRate < 1 || parsedFeeRate > 5_000}
            onClick={() => {
              const port = portRef.current;
              if (!port) return;
              setBusy(true);
              port.postMessage({
                type: 'drey:approval', protocolVersion: PROVIDER_BRIDGE_VERSION,
                command: 'setFee', requestNonce: request.requestNonce,
                feeRateSatPerVb: parsedFeeRate,
              });
          }}>
            {t('approval.updateFee')}
          </Button>
        </details>
      ) : null}
      {request.requiresPassword ? (
        <Field label={t('approval.password')} type="password" autoComplete="current-password"
          value={password} onChange={(event) => setPassword(event.target.value)} />
      ) : null}
      {request.confirmationPhrase !== null ? (
        <Field label={t('approval.confirmation', { phrase: request.confirmationPhrase })} value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)} />
      ) : null}
      <div className={styles['actions']}>
        <Button variant="danger" data-testid="approval-reject" disabled={busy} onClick={() => resolve(false)}>
          {t('approval.reject')}
        </Button>
        {/* The label is deliberately method-specific ("Sign transaction" reads
            better than "Approve"), so the harness identifies this button by a
            stable hook rather than by copy. tests/ui/approval.test.tsx is what
            asserts the label itself. */}
        <Button data-testid="approval-approve" disabled={busy || !approvalReady || !validPassword || !validConfirmation || !inscriptionReviewValid ||
          (requiresPreviewAcknowledgement && !previewUnavailableAcknowledged)} onClick={() => resolve(true)}>
          {approvalAction(request.method, t)}
        </Button>
      </div>
    </main>
  );
}
