import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  CommunityVaultPolicyV1,
  CommunityVaultSpendPlanV1,
} from '@drey/core/domain/community-vault/contracts';
import { useRpc } from '../../ui/hooks/use-rpc';
import { useI18n } from '../../ui/i18n';
import { errorMessageKey } from '../../ui/errors';
import { Button } from '../../ui/components/Button';
import { Field } from '../../ui/components/Field';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import type { CommunityVaultSummary } from '../../messaging/community-vault-ops';
import styles from './fullpage.module.css';

interface SigningPackage {
  policy: CommunityVaultPolicyV1;
  plan: CommunityVaultSpendPlanV1;
  psbtHex: string;
}

function jsonObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function policyFromText(value: string): CommunityVaultPolicyV1 {
  const parsed = jsonObject(value);
  return (parsed.policy ?? parsed) as CommunityVaultPolicyV1;
}

function signingPackageFromText(value: string): SigningPackage {
  const parsed = jsonObject(value);
  if (typeof parsed.psbtHex !== 'string' || parsed.policy === undefined || parsed.plan === undefined) {
    throw new Error('This is not a complete Community Vault signing package');
  }
  return parsed as unknown as SigningPackage;
}

function sats(value: bigint | string): string {
  return `${BigInt(value).toLocaleString()} sats`;
}

function readinessLabel(
  readiness: CommunityVaultSummary['readiness'],
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (readiness === 'ready') return t('communityVault.status.ready');
  if (readiness === 'needs-recovery') return t('communityVault.status.recovery');
  return t('communityVault.status.policy');
}

export function CommunityVault(props: {
  expectation: ActiveSessionExpectation;
  onBack: () => void;
}): ReactNode {
  const rpc = useRpc();
  const { t } = useI18n();
  const setup = useMemo(() => {
    const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
    return {
      campaignId: params.get('communityCampaignId') ?? '',
      ownerId: params.get('communityOwnerId') ?? '',
      label: params.get('communityLabel') ?? '',
    };
  }, []);
  const [owners, setOwners] = useState<CommunityVaultSummary[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [campaignId, setCampaignId] = useState(setup.campaignId);
  const [ownerId, setOwnerId] = useState(setup.ownerId);
  const [label, setLabel] = useState(setup.label);
  const [showSetup, setShowSetup] = useState(Boolean(setup.campaignId && setup.ownerId));
  const [password, setPassword] = useState('');
  const [restoreMode, setRestoreMode] = useState(false);
  const [policyText, setPolicyText] = useState('');
  const [signingText, setSigningText] = useState('');
  const [review, setReview] = useState<SigningPackage | null>(null);
  const [signedPsbt, setSignedPsbt] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recoveryRevealed, setRecoveryRevealed] = useState(false);
  const [recoveryConfirmationPresent, setRecoveryConfirmationPresent] = useState(false);
  const recoveryMnemonic = useRef('');
  const recoveryWords = useRef<HTMLParagraphElement>(null);
  const recoveryConfirmation = useRef<HTMLInputElement>(null);
  const restoreWords = useRef<HTMLInputElement>(null);

  const selected = owners.find((owner) => owner.campaignId === selectedCampaignId) ?? owners[0] ?? null;
  const refresh = useCallback(async () => {
    const result = await rpc('communityVault.status', { ...props.expectation });
    if (!result.ok) {
      setError(t(errorMessageKey(result.code)));
      return;
    }
    setOwners(result.result.owners);
    setSelectedCampaignId((current) => current ?? result.result.owners[0]?.campaignId ?? null);
    if (result.result.unusableCampaignIds.length > 0) {
      setError('One Community Vault record could not be read. It was preserved for recovery.');
    }
  }, [props.expectation, rpc, t]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!recoveryRevealed || !recoveryWords.current) return;
    recoveryWords.current.textContent = recoveryMnemonic.current;
    recoveryConfirmation.current?.focus();
  }, [recoveryRevealed]);

  function clearFeedback(): void {
    setError(null);
    setNotice(null);
  }

  async function createOwner(): Promise<void> {
    clearFeedback();
    setBusy(true);
    try {
      const result = await rpc('communityVault.create', {
        campaignId,
        ownerId,
        label,
        password,
        ...props.expectation,
      });
      if (!result.ok) {
        setError(t(errorMessageKey(result.code)));
        return;
      }
      setPassword('');
      setCampaignId('');
      setOwnerId('');
      setLabel('');
      setSelectedCampaignId(result.result.owner.campaignId);
      setShowSetup(false);
      setRecoveryRevealed(false);
      setRecoveryConfirmationPresent(false);
      setNotice(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function restoreOwner(): Promise<void> {
    if (!restoreWords.current?.value) return;
    clearFeedback();
    setBusy(true);
    try {
      const result = await rpc('communityVault.restore', {
        campaignId,
        ownerId,
        label,
        password,
        mnemonic: restoreWords.current.value.trim(),
        ...props.expectation,
      });
      if (!result.ok) {
        setError(t(errorMessageKey(result.code)));
        return;
      }
      restoreWords.current.value = '';
      setPassword('');
      setCampaignId('');
      setOwnerId('');
      setLabel('');
      setSelectedCampaignId(result.result.owner.campaignId);
      setShowSetup(false);
      setRecoveryRevealed(false);
      setRecoveryConfirmationPresent(false);
      setNotice(t('communityVault.recovery.done'));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function copyEnrollment(): Promise<void> {
    if (!selected) return;
    clearFeedback();
    try {
      await navigator.clipboard.writeText(JSON.stringify({
        version: 1,
        network: 'mainnet',
        campaignId: selected.campaignId,
        ownerId: selected.ownerId,
        campaignRoot: selected.campaignRoot,
      }, null, 2));
      setNotice(t('communityVault.enrollment.copied'));
    } catch {
      setError(t('common.copyFailed'));
    }
  }

  async function revealRecovery(): Promise<void> {
    if (!selected) return;
    clearFeedback();
    setBusy(true);
    try {
      const result = await rpc('communityVault.revealRecovery', {
        campaignId: selected.campaignId,
        password,
        ...props.expectation,
      });
      if (!result.ok) {
        setError(t(errorMessageKey(result.code)));
        return;
      }
      recoveryMnemonic.current = result.result.mnemonic;
      setRecoveryRevealed(true);
      setPassword('');
      setNotice(null);
    } finally {
      setBusy(false);
    }
  }

  async function confirmRecovery(): Promise<void> {
    if (!selected || !recoveryConfirmation.current?.value) return;
    clearFeedback();
    setBusy(true);
    try {
      const result = await rpc('communityVault.confirmRecovery', {
        campaignId: selected.campaignId,
        mnemonic: recoveryConfirmation.current.value.trim(),
        password,
        ...props.expectation,
      });
      if (!result.ok) {
        setError(t(errorMessageKey(result.code)));
        return;
      }
      recoveryConfirmation.current.value = '';
      if (recoveryWords.current) recoveryWords.current.textContent = '';
      recoveryMnemonic.current = '';
      setRecoveryRevealed(false);
      setRecoveryConfirmationPresent(false);
      setPassword('');
      setNotice(t('communityVault.recovery.done'));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function acceptPolicy(): Promise<void> {
    if (!selected) return;
    clearFeedback();
    setBusy(true);
    try {
      let policy: CommunityVaultPolicyV1;
      try {
        policy = policyFromText(policyText);
      } catch {
        setError('Paste the complete final cap-table package from the campaign.');
        return;
      }
      const result = await rpc('communityVault.acceptPolicy', {
        campaignId: selected.campaignId,
        policy,
        ...props.expectation,
      });
      if (!result.ok) {
        setError(t(errorMessageKey(result.code)));
        return;
      }
      setPolicyText('');
      setNotice(t('communityVault.policy.done', { units: result.result.owner.units.length }));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function prepareReview(): void {
    clearFeedback();
    setSignedPsbt(null);
    try {
      const next = signingPackageFromText(signingText);
      if (!selected || next.policy.campaignId !== selected.campaignId) {
        throw new Error('The signing package belongs to another campaign');
      }
      setReview(next);
    } catch (cause) {
      setReview(null);
      setError(cause instanceof Error ? cause.message : 'Invalid signing package');
    }
  }

  async function approve(): Promise<void> {
    if (!selected || !review) return;
    clearFeedback();
    setBusy(true);
    try {
      const result = await rpc('communityVault.sign', {
        campaignId: selected.campaignId,
        password,
        policy: review.policy,
        plan: review.plan,
        psbtHex: review.psbtHex,
        ...props.expectation,
      });
      if (!result.ok) {
        setError(t(errorMessageKey(result.code)));
        return;
      }
      setPassword('');
      setSignedPsbt(result.result.psbtHex);
      setNotice(t('communityVault.transaction.done', { units: result.result.addedUnits.length }));
    } finally {
      setBusy(false);
    }
  }

  const economics = useMemo(() => {
    if (!review || !selected) return null;
    const owner = review.policy.owners.find((candidate) => candidate.ownerId === selected.ownerId);
    if (!owner) return null;
    const payout = review.plan.outputs
      .filter((output) => output.scriptPubKeyHex === owner.payoutScriptPubKeyHex)
      .reduce((total, output) => total + BigInt(output.valueSats), 0n);
    const allPayouts = new Set(review.policy.owners.map((candidate) => candidate.payoutScriptPubKeyHex));
    const gross = review.plan.outputs
      .filter((output) => allPayouts.has(output.scriptPubKeyHex))
      .reduce((total, output) => total + BigInt(output.valueSats), 0n);
    return { payout, gross };
  }, [review, selected]);

  const showOwnerFlow = owners.length > 0 && !showSetup && selected !== null;

  return (
    <>
      <div className={styles['row']}>
        <div>
          <p className={`${styles['eyebrow']} ${styles['communityVaultEyebrow']}`}>
            {t('communityVault.eyebrow')}
          </p>
          <h1 className={styles['title']}>{t('communityVault.title')}</h1>
        </div>
        <Button variant="secondary" onClick={props.onBack}>{t('common.back')}</Button>
      </div>
      <p className={styles['rowLabel']}>
        {t('communityVault.intro')}
      </p>

      {error ? <p role="alert" className={styles['retainedNotice']}>{error}</p> : null}
      {notice ? <p role="status" className={styles['retainedNotice']}>{notice}</p> : null}

      {owners.length === 0 || showSetup ? (
        <section className={styles['section']}>
          <h2 className={styles['sectionTitle']}>{t('communityVault.join.title')}</h2>
          <p className={styles['rowLabel']}>
            {t('communityVault.join.body')}
          </p>
          <div className={styles['form']}>
            <Field label={t('communityVault.campaignId')} value={campaignId} onChange={(event) => setCampaignId(event.target.value)} />
            <Field label={t('communityVault.ownerId')} value={ownerId} onChange={(event) => setOwnerId(event.target.value)} />
            <Field label={t('communityVault.label')} value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t('communityVault.label.placeholder')} />
            {restoreMode ? (
              <Field ref={restoreWords} label={t('communityVault.restore.words')} autoComplete="off" spellCheck={false} />
            ) : null}
            <Field label={t('communityVault.password')} type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            <Button
              disabled={busy || !campaignId || !ownerId || !password}
              onClick={() => void (restoreMode ? restoreOwner() : createOwner())}
            >
              {t(
                !password
                  ? 'communityVault.password.required'
                  : restoreMode
                    ? 'communityVault.restore'
                    : 'communityVault.create',
              )}
            </Button>
            <Button variant="secondary" onClick={() => setRestoreMode((current) => !current)}>
              {t(restoreMode ? 'communityVault.restore.createInstead' : 'communityVault.restore')}
            </Button>
            {owners.length > 0 ? (
              <Button variant="secondary" onClick={() => setShowSetup(false)}>{t('common.cancel')}</Button>
            ) : null}
          </div>
        </section>
      ) : null}

      {showOwnerFlow && selected ? (
        <>
          {owners.length > 1 ? (
            <div className={styles['communityVaultCampaignPicker']}>
              <div>
                <span>{t('communityVault.campaign.current')}</span>
                <strong>{selected.label || selected.campaignId}</strong>
              </div>
              <select value={selected.campaignId} onChange={(event) => {
                recoveryMnemonic.current = '';
                setRecoveryRevealed(false);
                setRecoveryConfirmationPresent(false);
                setPassword('');
                setSelectedCampaignId(event.target.value);
              }}>
                {owners.map((owner) => <option key={owner.campaignId} value={owner.campaignId}>{owner.label || owner.campaignId}</option>)}
              </select>
            </div>
          ) : null}

          {!selected.recoveryConfirmed ? (
            <section className={`${styles['section']} ${styles['communityVaultActiveStep']}`}>
              <p className={styles['communityVaultStep']}>
                {t('communityVault.setup.step', { step: 1, total: 2 })}
              </p>
              <h2 className={styles['sectionTitle']}>{t('communityVault.recovery.title')}</h2>
              <p className={styles['rowLabel']}>
                {t('communityVault.recovery.body')}
              </p>
              <p className={styles['communityVaultCampaignName']}>{selected.label || selected.campaignId}</p>
              {!recoveryRevealed ? (
                <>
                  <Field
                    label={t('communityVault.password')}
                    hint={t('communityVault.recovery.passwordHint')}
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <Button disabled={busy || !password} onClick={() => void revealRecovery()}>
                    {t('communityVault.recovery.show')}
                  </Button>
                </>
              ) : (
                <>
                  <p className={styles['communityVaultInstruction']}>
                    {t('communityVault.recovery.instructions')}
                  </p>
                  <div className={styles['communityVaultWordsPanel']}>
                    <span>{t('communityVault.recovery.words')}</span>
                    <p ref={recoveryWords} aria-live="polite" />
                  </div>
                  <Field
                    ref={recoveryConfirmation}
                    label={t('communityVault.recovery.confirm')}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setRecoveryConfirmationPresent(Boolean(event.target.value.trim()))}
                  />
                  <Field
                    label={t('communityVault.password')}
                    hint={t('communityVault.recovery.verifyHint')}
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <Button
                    disabled={busy || !password || !recoveryConfirmationPresent}
                    onClick={() => void confirmRecovery()}
                  >
                    {t('communityVault.recovery.verify')}
                  </Button>
                </>
              )}
            </section>
          ) : null}

          {selected.recoveryConfirmed && selected.policyId === null ? (
            <>
              <section className={`${styles['section']} ${styles['communityVaultSuccess']}`}>
                <p className={styles['communityVaultStep']}>
                  {t('communityVault.setup.step', { step: 1, total: 2 })} · {t('communityVault.verified')}
                </p>
                <h2 className={styles['sectionTitle']}>{t('communityVault.enrollment.readyTitle')}</h2>
                <p className={styles['rowLabel']}>{t('communityVault.enrollment.readyBody')}</p>
                <Button onClick={() => void copyEnrollment()}>
                  {t('communityVault.enrollment.copyForGallery')}
                </Button>
                <p className={styles['communityVaultActionHint']}>
                  {t('communityVault.enrollment.next')}
                </p>
              </section>
              <details className={styles['disclosureSection']}>
                <summary>
                  <span>
                    <strong>{t('communityVault.policy.later')}</strong>
                    <small>{t('communityVault.policy.waiting')}</small>
                  </span>
                </summary>
                <div className={styles['disclosureContent']}>
                  <p className={styles['communityVaultStep']}>
                    {t('communityVault.setup.step', { step: 2, total: 2 })}
                  </p>
                  <h2 className={styles['sectionTitle']}>{t('communityVault.policy.title')}</h2>
                  <p className={styles['rowLabel']}>{t('communityVault.policy.body')}</p>
                  <textarea className={styles['packageInput']} value={policyText} onChange={(event) => setPolicyText(event.target.value)} aria-label={t('communityVault.policy.paste')} />
                  <Button disabled={busy || !policyText} onClick={() => void acceptPolicy()}>{t('communityVault.policy.accept')}</Button>
                </div>
              </details>
            </>
          ) : null}

          {selected.policyId !== null ? (
            <section className={styles['section']}>
              <div className={styles['row']}>
                <div>
                  <h2 className={styles['sectionTitle']}>{selected.label || selected.campaignId}</h2>
                  <p className={styles['rowLabel']}>{readinessLabel(selected.readiness, t)}</p>
                </div>
              </div>
              <dl className={styles['details']}>
                <div><dt>{t('communityVault.units')}</dt><dd>{selected.units.length}</dd></div>
                <div><dt>{t('communityVault.mode')}</dt><dd>{selected.mode ? selected.mode[0]!.toUpperCase() + selected.mode.slice(1) : t('communityVault.pending')}</dd></div>
                <div><dt>{t('communityVault.recovery')}</dt><dd>{t('communityVault.verified')}</dd></div>
                <div><dt>{t('communityVault.capTable')}</dt><dd>{t('communityVault.accepted')}</dd></div>
              </dl>
              <Button variant="secondary" onClick={() => void copyEnrollment()}>{t('communityVault.enrollment.copy')}</Button>
              <Button variant="secondary" onClick={() => setShowSetup(true)}>{t('communityVault.join.another')}</Button>
            </section>
          ) : null}

          {selected.readiness === 'ready' ? (
            <section className={styles['section']}>
              <h2 className={styles['sectionTitle']}>{t('communityVault.transaction.title')}</h2>
              <p className={styles['rowLabel']}>
                {t('communityVault.transaction.body')}
              </p>
              <textarea className={styles['packageInput']} value={signingText} onChange={(event) => setSigningText(event.target.value)} aria-label={t('communityVault.transaction.paste')} />
              <Button variant="secondary" disabled={!signingText} onClick={prepareReview}>{t('communityVault.transaction.review')}</Button>
              {review ? (
                <div className={styles['reviewPanel']}>
                  <dl className={styles['details']}>
                    <div><dt>{t('communityVault.transaction.action')}</dt><dd>{t(review.plan.kind === 'sale' ? 'communityVault.transaction.sell' : 'communityVault.transaction.move')}</dd></div>
                    <div><dt>{t('communityVault.transaction.payout')}</dt><dd>{economics ? sats(economics.payout) : '—'}</dd></div>
                    <div><dt>{t('communityVault.transaction.gross')}</dt><dd>{economics ? sats(economics.gross) : '—'}</dd></div>
                    <div><dt>{t('communityVault.transaction.fee')}</dt><dd>{sats(review.plan.feeSats)}</dd></div>
                    <div><dt>{t('communityVault.transaction.destination')}</dt><dd>{t('communityVault.transaction.output', { output: review.plan.ordinalRoute.outputIndex + 1 })}</dd></div>
                    <div><dt>{t('communityVault.transaction.expires')}</dt><dd>{new Date(Number(review.plan.expiresAtMs)).toLocaleString()}</dd></div>
                  </dl>
                  <p className={styles['code']}>Plan {review.plan.planDigest}</p>
                  <Field label={t('communityVault.password')} type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
                  <Button disabled={busy || !password} onClick={() => void approve()}>
                    {t('communityVault.transaction.approve', { units: selected.units.length })}
                  </Button>
                </div>
              ) : null}
              {signedPsbt ? (
                <div className={styles['reviewPanel']}>
                  <p className={styles['rowLabel']}>Signed package ready to return to the campaign coordinator.</p>
                  <Button onClick={() => void navigator.clipboard.writeText(signedPsbt)}>{t('communityVault.transaction.copy')}</Button>
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
    </>
  );
}
