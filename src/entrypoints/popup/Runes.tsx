import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { formatFeeRateSatPerVb, parseCustomFeeRate, MIN_CUSTOM_FEE_RATE_SAT_PER_KVB } from '@drey/core/domain/transactions/fees';
import { formatRuneQuantity, parseRuneQuantity } from '@drey/core/domain/runes/amounts';
import type { RuneDraft, RuneListResult, RuneReview, RuneTransferView } from '../../messaging/rune-ops';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import { useRunes } from '../../ui/hooks/use-runes';
import { meaningfulRuneDraft, useRuneDraft } from '../../ui/hooks/use-rune-draft';
import { useWalletHome } from '../../ui/hooks/use-wallet-home';
import { useRpc } from '../../ui/hooks/use-rpc';
import { useI18n } from '../../ui/i18n';
import { errorMessageKey } from '../../ui/errors';
import { usePortfolioPrivacy } from '../../ui/UiRoot';
import { Button } from '../../ui/components/Button';
import { Field } from '../../ui/components/Field';
import { formatRuneAmount } from '../../ui/format-rune-amount';
import { RuneTransferDetails, RuneTransferRow, runeNetwork } from '../../ui/activity/RuneActivity';
import type { OpResult } from '../../adapters/rpc-client';
import { RuneRecipients } from './RuneRecipients';
import { Receive } from './Receive';
import { PopupIcon } from './PopupIcon';
import styles from './Runes.module.css';
import popupStyles from './popup.module.css';

interface RuneProps { expectation: ActiveSessionExpectation; accountId: string; accountName?: string | undefined }
export function RunesEntry(props: RuneProps & { onOpen: () => void; onData?: (data: RuneListResult | null) => void }): ReactNode {
  const { t } = useI18n();
  const { data, failed } = useRunes(props);
  const onData = props.onData;
  useEffect(() => { onData?.(data); }, [data, onData]);
  const visible = data?.holdings.filter((item) => !item.hidden).length ?? 0;
  const hidden = data?.holdings.filter((item) => item.hidden).length ?? 0;
  return <button className={styles.entry} onClick={props.onOpen} type="button">
    <strong>{t('runes.title')}</strong><span>{failed && !data ? t('runes.balanceUnavailable') :
      data?.status !== 'ready' ? t('runes.checking') : visible ? t(visible === 1 ? 'runes.oneAsset' : 'runes.count', { count: visible }) :
        hidden ? t('runes.hiddenCount', { count: hidden }) : t('runes.empty')}</span><span aria-hidden>›</span>
  </button>;
}

const runeQuoteRate = (rate: number) => formatFeeRateSatPerVb(BigInt(Math.max(rate, MIN_CUSTOM_FEE_RATE_SAT_PER_KVB)));
const blankForm = (runeId = ''): RuneDraft => ({ runeId, recipient: '', quantity: '', feeRate: '1', feeTier: 'standard', sending: true });
type RunesProps = RuneProps & { onClose: () => void; onExpand?: (resume: boolean) => void; resumeDraft?: boolean };
export function Runes(props: RunesProps): ReactNode {
  return <RuneScreen key={`${props.accountId}:${props.expectation.expectedVaultId}:${props.expectation.expectedSessionId}`} {...props} />;
}
function RuneScreen(props: RunesProps): ReactNode {
  const rpc = useRpc();
  const { t, lang } = useI18n();
  const { amountsHidden } = usePortfolioPrivacy();
  const { data, failed, refresh } = useRunes(props);
  const saved = useRuneDraft(props.expectation, props.accountId);
  const scanOnMount = useRef(data === null).current;
  const { refresh: refreshHome, refreshScan } = useWalletHome(props.expectation, props.accountId, { scanOnMount, scanOnResume: false });
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [includeHidden, setIncludeHidden] = useState(false);
  const [sending, setSending] = useState(false);
  const [form, setForm] = useState<RuneDraft>(() => blankForm());
  const [feesOpen, setFeesOpen] = useState(false);
  const [quote, setQuote] = useState<OpResult<'fees.quote'> | null>(null);
  const [quoteFailed, setQuoteFailed] = useState(false);
  const [quoteAttempt, setQuoteAttempt] = useState(0);
  const [review, setReview] = useState<RuneReview | null>(null);
  const [transfer, setTransfer] = useState<RuneTransferView | null>(null);
  const [receive, setReceive] = useState<'payment' | 'ordinals' | null>(null);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [recipientError, setRecipientError] = useState<string | undefined>();
  const [amountError, setAmountError] = useState<string | undefined>();
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationAttempt, setValidationAttempt] = useState(0);
  const [fundingError, setFundingError] = useState(false);
  const [needsReview, setNeedsReview] = useState(false);
  const [uncertainApproval, setUncertainApproval] = useState(false);
  const [hiddenToken, setHiddenToken] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const feeTrigger = useRef<HTMLButtonElement>(null);
  const resumed = useRef(false);
  const binding = { ...props.expectation, accountId: props.accountId };
  const { expectedVaultId, expectedSessionId } = props.expectation;
  const token = data?.holdings.find((item) => item.id === selected);
  const currentTransfer = transfer ? data?.transfers.find((item) => item.txid === transfer.txid && item.rune.id === transfer.rune.id) ?? transfer : null;
  const step = receive ? `receive:${receive}` : currentTransfer ? `receipt:${currentTransfer.txid}` : review ? `review:${review.planId}` : token ? `${sending ? 'send' : 'token'}:${token.id}` : 'list';

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const heading = node.querySelector<HTMLElement>('h1') ?? node;
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
    node.scrollIntoView?.({ block: 'start' });
  }, [step]);
  useLayoutEffect(() => {
    if (!error && !recipientError && !amountError && !passwordError) return;
    const node = root.current?.querySelector<HTMLElement>('[aria-invalid="true"], [data-rune-error]');
    node?.focus({ preventScroll: true });
    node?.scrollIntoView?.({ block: 'nearest' });
  }, [error, recipientError, amountError, passwordError, validationAttempt]);
  useEffect(() => {
    if (!props.resumeDraft || !saved.loaded || resumed.current) return;
    resumed.current = true;
    if (saved.draft) {
      setSelected(saved.draft.runeId);
      setForm({ ...saved.draft, feeTier: saved.draft.feeTier ?? 'custom' });
      setSending(true);
    }
  }, [props.resumeDraft, saved.loaded, saved.draft]);
  useEffect(() => {
    setExpired(false);
    if (!review) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, review.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [review]);
  useEffect(() => {
    if (!sending) return;
    let active = true;
    setQuoteFailed(false);
    void rpc('fees.quote', { expectedVaultId, expectedSessionId }).then((result) => {
      if (!active) return;
      if (result.ok) setQuote(result.result);
      else setQuoteFailed(true);
    });
    return () => { active = false; };
  }, [rpc, expectedVaultId, expectedSessionId, sending, selected, quoteAttempt]);

  const feeTier = form.feeTier ?? 'custom';
  const selectedRate = feeTier === 'custom' ? form.feeRate : quote ? runeQuoteRate(quote[`${feeTier}SatPerKvB`]) : null;
  let feeValid = false;
  try { if (selectedRate !== null) { parseCustomFeeRate(selectedRate); feeValid = true; } } catch { /* Keep the custom rate editable. */ }
  const sats = (value: string) => BigInt(value).toLocaleString(lang);
  const ready = !failed && data?.status === 'ready';
  const quantity = (value: string, rune: { divisibility: number; symbol: string | null }) => amountsHidden ? '••••' : formatRuneAmount(value, rune.divisibility, lang, rune.symbol);
  const changeForm = (patch: Partial<RuneDraft>) => {
    const next = { ...form, ...patch };
    setForm(next);
    void saved.save(meaningfulRuneDraft(next) ? next : null);
    setNeedsReview(false);
  };
  const clearErrors = () => { setError(null); setRecipientError(undefined); setAmountError(undefined); setPasswordError(undefined); setNeedsReview(false); };
  const resume = (draft: RuneDraft) => {
    clearErrors(); setSelected(draft.runeId); setForm({ ...draft, feeTier: draft.feeTier ?? 'custom' }); setSending(true); setFeesOpen(false);
  };
  const back = () => {
    if (review) { void rpc('runes.cancel', { ...binding, planId: review.planId }); setReview(null); setPassword(''); }
    else if (sending) setSending(false);
    else if (selected) setSelected(null);
    else props.onClose();
    clearErrors(); setFeesOpen(false);
  };
  const refreshBalances = () => { refreshHome(); refreshScan(); void refresh(); };
  const prepare = async (previous?: RuneReview) => {
    if (busy || !token || !ready || !data?.canSign || data.feeFundingSats === '0' || !feeValid || selectedRate === null || uncertainApproval) return;
    clearErrors(); setValidationAttempt((value) => value + 1);
    if (!form.recipient.trim()) { setRecipientError(t('runes.recipient')); return; }
    let atomic: bigint;
    try {
      atomic = form.quantity === 'max' ? BigInt(token.available) : parseRuneQuantity(form.quantity, token.divisibility, lang);
      if (atomic <= 0n || atomic > BigInt(token.available)) throw new Error();
    } catch {
      setAmountError(t('runes.amountHelp', { amount: formatRuneQuantity(token.available, token.divisibility, lang), decimals: token.divisibility }));
      return;
    }
    setBusy(true);
    try {
      if (previous) {
        const cancelled = await rpc('runes.cancel', { ...binding, planId: previous.planId });
        if (!cancelled.ok) { setError(t('runes.changed')); return; }
        setReview(null); setPassword('');
      }
      const result = await rpc('runes.prepare', { ...binding, runeId: token.id, recipient: form.recipient.trim(), amount: form.quantity === 'max' ? 'max' : atomic.toString(), feeRate: selectedRate });
      if (result.ok) { setReview(result.result); setFundingError(false); setFeesOpen(false); }
      else if (result.code === 'ERR_INVALID_ADDRESS' || result.code === 'ERR_UNSUPPORTED_ADDRESS') setRecipientError(t(errorMessageKey(result.code)));
      else if (result.code === 'ERR_INSUFFICIENT_FUNDS') { setFundingError(true); setError(t('runes.fundsError')); }
      else setError(t(errorMessageKey(result.code)));
    } finally { setBusy(false); }
  };
  const approve = async () => {
    if (!review || busy || expired || !ready || !data?.canSign) return;
    if (review.requiresReauth && !password) { setValidationAttempt((value) => value + 1); setPasswordError(t('runes.passwordRequired')); return; }
    setBusy(true); clearErrors();
    const enteredPassword = password; setPassword('');
    try {
      const result = await rpc('runes.approve', { ...binding, planId: review.planId, planHash: review.planHash, ...(review.requiresReauth ? { password: enteredPassword } : {}) });
      if (result.ok) { setTransfer(result.result); setForm(blankForm()); void saved.save(null); void refresh(); }
      else {
        // The worker consumes the plan even on reauthentication failure. A retry
        // must prepare a fresh review and requires another explicit confirmation.
        setReview(null);
        const uncertain = result.code === 'ERR_INTERNAL';
        setUncertainApproval(uncertain);
        setNeedsReview(!uncertain);
        setError(t(uncertain ? 'runes.noResend' : result.code === 'ERR_WRONG_PASSWORD' ? 'runes.passwordAgain' : errorMessageKey(result.code)));
      }
    } finally { setBusy(false); }
  };
  const setVisibility = async (runeId: string, hidden: boolean) => {
    setBusy(true); setError(null);
    try {
      const result = await rpc('runes.visibility', { ...binding, runeId, hidden });
      if (result.ok) { await refresh(); setHiddenToken(hidden ? runeId : null); if (hidden) setSelected(null); }
      else setError(t(errorMessageKey(result.code)));
    } finally { setBusy(false); }
  };
  const matches = data?.holdings.filter((item) => (includeHidden || !item.hidden) && `${item.name} ${item.id}`.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  const savedToken = data?.holdings.find((item) => item.id === saved.draft?.runeId);
  const network = runeNetwork(props.accountId);

  if (receive) return <section ref={root} className={styles.page}><div className={popupStyles.overlayToolbar}><button className={popupStyles.overlayBack} type="button" onClick={() => { setReceive(null); refreshBalances(); }}>{t('common.back')}</button></div><Receive initialKind={receive} runeContext={receive === 'ordinals'} accountName={props.accountName} expectation={props.expectation} activeAccountId={props.accountId} onClose={() => { setReceive(null); refreshBalances(); }} /></section>;
  if (currentTransfer) return <section ref={root} className={styles.page}>
    <h1>{t(currentTransfer.status === 'indeterminate' ? 'runes.statusChecking' : `runes.${currentTransfer.status}`)}</h1>
    {currentTransfer.status === 'indeterminate' ? <p className={styles.warning} role="status">{t('runes.noResend')}</p> : null}
    <div className={styles.tokenSummary}><strong>{currentTransfer.rune.name}</strong><span>{currentTransfer.rune.id}</span></div>
    <RuneTransferDetails transfer={currentTransfer} network={network} review={review} />
    {currentTransfer.status === 'pending' || currentTransfer.status === 'indeterminate' ? <Button variant="secondary" onClick={() => void refresh()}>{t('runes.checkStatus')}</Button> : null}
    <Button onClick={() => { setTransfer(null); setSelected(null); setSending(false); setReview(null); clearErrors(); void refresh(); }}>{t('runes.done')}</Button>
  </section>;
  return <section ref={root} className={styles.page}>
    <div className={popupStyles.overlayToolbar}>
      <button className={popupStyles.overlayBack} onClick={back} type="button" disabled={busy}>{t('common.back')}</button>
      {props.onExpand ? <button className={popupStyles.iconButton} type="button" aria-label={t('runes.expand')} title={t('runes.expand')} disabled={busy} onClick={() => {
        if (review) { void rpc('runes.cancel', { ...binding, planId: review.planId }); setReview(null); setPassword(''); }
        const shouldResume = sending && meaningfulRuneDraft(form);
        const draft = shouldResume ? form : saved.draft;
        void saved.save(draft).then((ok) => { if (ok) props.onExpand?.(shouldResume); });
      }}><PopupIcon name="expand" /></button> : null}
    </div>
    <h1>{review ? t('runes.review') : sending && token ? t('runes.sendTitle') : token?.name ?? t('runes.title')}</h1>
    {failed ? <div className={styles.notice} role="status"><p>{t(data ? 'runes.refreshFailed' : 'runes.unavailable')}</p><Button variant="ghost" disabled={busy} onClick={refreshBalances}>{t('common.retry')}</Button></div> : !data ? <p role="status">{t('runes.checking')}</p> : null}
    {saved.failed ? <div className={styles.notice} role="status"><p>{t('runes.draftFailed')}</p><Button variant="ghost" onClick={saved.retry}>{t('common.retry')}</Button></div> : null}
    {error ? <div className={styles.error} role="alert" tabIndex={-1} data-rune-error><p>{error}</p>{needsReview ? <Button variant="secondary" disabled={busy} onClick={() => void prepare()}>{t('runes.reviewAgain')}</Button> : null}{uncertainApproval ? <><Button variant="secondary" onClick={() => void refresh()}>{t('runes.checkStatus')}</Button>{data?.transfers.map((item) => <RuneTransferRow key={`${item.txid}:${item.rune.id}`} transfer={item} network={network} />)}</> : null}</div> : null}
    {review ? <>
      <div className={styles.tokenSummary}><strong>{review.rune.name}</strong><span>{review.rune.id}</span></div>
      <dl className={styles.review}>
        <dt>{t('runes.amount')}</dt><dd className={styles.balance}>{formatRuneAmount(review.amount, review.rune.divisibility, lang, review.rune.symbol)}</dd>
        <dt>{t('runes.recipient')}</dt><dd>{review.recipient}</dd>
        <dt>{t('runes.totalBitcoin')}</dt><dd><strong>{sats((BigInt(review.feeSats) + BigInt(review.postageSats)).toString())} sats</strong></dd>
        <dt>{t('runes.fee')}</dt><dd>{sats(review.feeSats)} sats</dd>
        <dt>{t('runes.postage')}</dt><dd>{sats(review.postageSats)} sats</dd>
      </dl>
      <p className={styles.hint}>{t('runes.postageHint')}</p>
      <p className={styles.hint}>{t('runes.retained')}: {formatRuneAmount(review.retained, review.rune.divisibility, lang, review.rune.symbol)}</p>
      {review.requiresReauth ? <Field label={t('send.password')} type="password" value={password} error={passwordError} onChange={(event) => { setPasswordError(undefined); setPassword(event.target.value); }} autoComplete="current-password" /> : null}
      {expired ? <><p role="status">{t('runes.reviewExpired')}</p><Button disabled={busy || !ready} onClick={() => void prepare(review)}>{t('runes.reviewAgain')}</Button></> : <Button disabled={busy || !ready || !data?.canSign} onClick={() => void approve()}>{busy ? t('runes.checking') : t('runes.confirm')}</Button>}
    </> : token ? <>
      {sending ? <>
        <div className={styles.tokenSummary}><strong>{token.name}</strong></div>
        <form className={styles.page} noValidate onSubmit={(event) => { event.preventDefault(); void prepare(); }}>
          <RuneRecipients expectation={props.expectation} disabled={busy} onChoose={(recipient) => { changeForm({ recipient }); setRecipientError(undefined); }}>
            <Field label={t('runes.recipient')} value={form.recipient} aria-invalid={recipientError ? true : undefined} aria-describedby={recipientError ? 'rune-recipient-error' : undefined} disabled={busy} onChange={(event) => { changeForm({ recipient: event.target.value }); setRecipientError(undefined); }} autoComplete="off" spellCheck={false} required />
          </RuneRecipients>
          {recipientError ? <p id="rune-recipient-error" className={styles.error} role="alert">{recipientError}</p> : null}
          <div>
            <div className={styles.amountField}>
              <Field label={t('runes.amount')} disabled={busy} value={form.quantity === 'max' ? formatRuneQuantity(token.available, token.divisibility, lang) : form.quantity} onChange={(event) => { changeForm({ quantity: event.target.value }); setAmountError(undefined); }} inputMode="decimal" required aria-invalid={amountError ? true : undefined} aria-describedby={amountError ? 'rune-amount-error' : undefined} />
              <button type="button" className={styles.max} aria-pressed={form.quantity === 'max'} disabled={busy || !ready} onClick={() => { changeForm({ quantity: 'max' }); setAmountError(undefined); }}>{t('runes.max')}</button>
            </div>
            {amountError ? <p id="rune-amount-error" className={styles.error} role="alert">{amountError}</p> : null}
            <p className={styles.available}>{t('runes.available')}: {quantity(token.available, token)}</p>
          </div>
          <div className={styles.feeSummary}><span><small>{t('send.fee')}</small><strong>{t(`send.fee.${feeTier}`)}{selectedRate ? ` · ${selectedRate} sat/vB` : ''}</strong></span><Button ref={feeTrigger} variant="ghost" disabled={busy} aria-expanded={feesOpen} onClick={() => setFeesOpen(!feesOpen)}>{t('runes.changeFee')}</Button></div>
          {feeTier === 'custom' && !feeValid && !feesOpen ? <p className={styles.error} role="alert">{t('runes.invalidFee')}</p> : null}
          {feesOpen ? <fieldset className={styles.fees} disabled={busy}>
            <legend>{t('send.fee')}</legend>
            {(['priority', 'standard', 'economy'] as const).map((tier) => <label className={styles.feeOption} key={tier}>
              <input type="radio" name="rune-fee" checked={feeTier === tier} disabled={!quote} onChange={() => changeForm({ feeTier: tier })} />
              <span><strong>{t(`send.fee.${tier}`)}</strong><small>{t(`send.fee.${tier}.eta`)}</small></span>
              <span>{quote ? runeQuoteRate(quote[`${tier}SatPerKvB`]) : '—'} <small>sat/vB</small></span>
            </label>)}
            <label className={styles.feeOption}><input type="radio" name="rune-fee" checked={feeTier === 'custom'} onChange={() => changeForm({ feeTier: 'custom', feeRate: selectedRate ?? form.feeRate })} /><strong>{t('send.fee.custom')}</strong></label>
            {feeTier === 'custom' ? <Field label={t('runes.feeRate')} value={form.feeRate} hint={t('send.fee.customWarning')} error={!feeValid ? t('runes.invalidFee') : undefined} onChange={(event) => changeForm({ feeRate: event.target.value })} inputMode="decimal" required /> : null}
            <Button variant="ghost" disabled={!feeValid} onClick={() => { setFeesOpen(false); feeTrigger.current?.focus(); }}>{t('runes.feeDone')}</Button>
          </fieldset> : null}
          {quoteFailed ? <div className={styles.notice} role="status"><p>{t('send.fee.degraded')}</p><Button variant="ghost" onClick={() => setQuoteAttempt((value) => value + 1)}>{t('common.retry')}</Button></div> : null}
          <p className={styles.hint}>{t('runes.feeFunding', { amount: amountsHidden ? '••••' : data ? sats(data.feeFundingSats) : '—' })}</p>
          {data?.feeFundingSats === '0' || fundingError ? <div className={styles.notice}><p>{t('runes.needBitcoin')}</p><Button variant="secondary" disabled={busy} onClick={() => setReceive('payment')}>{t('runes.receiveBitcoin')}</Button></div> : null}
          <div className={styles.submit}><Button type="submit" disabled={busy || !ready || !data?.canSign || data.feeFundingSats === '0' || !feeValid || uncertainApproval}>{busy ? t('runes.checking') : t('runes.review')}</Button></div>
        </form>
      </> : <>
        <div className={styles.tokenBalance}><span className={styles.hint}>{t('runes.available')}</span><strong className={styles.balance}>{quantity(token.available, token)}</strong>{token.available !== token.total ? <span className={styles.hint}>{t('runes.total')}: {quantity(token.total, token)}</span> : null}</div>
        <div className={styles.actions}><Button disabled={!data?.canSign || token.available === '0' || !ready} onClick={() => {
          clearErrors(); setFundingError(false); setFeesOpen(false); setForm(saved.draft?.runeId === token.id ? { ...saved.draft, feeTier: saved.draft.feeTier ?? 'custom' } : blankForm(token.id)); setSending(true);
        }}>{t('runes.send')}</Button><Button variant="secondary" onClick={() => setReceive('ordinals')}>{t('runes.receive')}</Button></div>
        {!data?.canSign ? <p className={styles.hint}>{t('runes.watchOnly')}</p> : null}
        {token.constrained.length ? <div className={styles.notice}><p>{t('runes.constrained')}</p>{token.constrained.map((item) => <p className={styles.hint} key={item.reason}>{t(`runes.reason.${item.reason}`)}: {quantity(item.amount, token)}</p>)}</div> : null}
        <details className={styles.options}><summary>{t('runes.options')}</summary><p className={styles.hint}>{t('runes.tokenId')}: {token.id}</p><Button variant="ghost" disabled={busy} onClick={() => void setVisibility(token.id, !token.hidden)}>{t(token.hidden ? 'runes.show' : 'runes.hide')}</Button></details>
        {data?.historyComplete === false ? <p className={styles.hint}>{t('runes.historyIncomplete')}</p> : null}
        {data?.transfers.some((item) => item.rune.id === token.id) ? <div><h2>{t('runes.activity')}</h2>{data.transfers.filter((item) => item.rune.id === token.id).map((item) => <RuneTransferRow key={`${item.txid}:${item.rune.id}`} transfer={item} network={network} />)}</div> : null}
      </>}
    </> : <>
      {saved.draft ? <div className={styles.notice}><span className={styles.hint}>{t('runes.savedDraft')}</span><strong>{savedToken?.name ?? saved.draft.runeId}</strong>{ready && !savedToken ? <p className={styles.hint}>{t('runes.draftMissingToken')}</p> : null}<div className={styles.actions}><Button variant="secondary" disabled={!savedToken || !ready} onClick={() => { if (saved.draft) resume(saved.draft); }}>{t('runes.resume')}</Button><Button variant="ghost" onClick={() => { void saved.save(null); setSelected(null); setSending(false); }}>{t('runes.discard')}</Button></div></div> : null}
      {hiddenToken ? <div className={styles.notice} role="status"><p>{t('runes.hiddenNotice')}</p><Button variant="ghost" disabled={busy} onClick={() => void setVisibility(hiddenToken, false)}>{t('runes.undo')}</Button></div> : null}
      {(data?.holdings.length ?? 0) > 4 || query ? <Field label={t('runes.search')} value={query} onChange={(event) => setQuery(event.target.value)} /> : null}
      {data?.holdings.some((item) => item.hidden) ? <label className={styles.hint}><input type="checkbox" checked={includeHidden} onChange={(event) => setIncludeHidden(event.target.checked)} /> {t('runes.includeHidden')}</label> : null}
      {matches.map((item) => <button type="button" className={styles.entry} key={item.id} onClick={() => { resumed.current = true; setSelected(item.id); setSending(false); clearErrors(); }}><span className={styles.identity}><strong>{item.name}</strong><small>{item.id}</small>{item.available !== item.total ? <small>{t('runes.partAvailable', { amount: quantity(item.available, item) })}</small> : null}</span><span>{quantity(item.total, item)}</span></button>)}
      {ready && matches.length === 0 ? <div className={styles.empty}>{query.trim() ? <><h2>{t('runes.noMatches')}</h2><Button variant="ghost" onClick={() => setQuery('')}>{t('runes.clearSearch')}</Button></> : data.holdings.length ? <><h2>{t('runes.allHidden')}</h2><Button variant="ghost" onClick={() => setIncludeHidden(true)}>{t('runes.showHidden')}</Button></> : <><h2>{t('runes.empty')}</h2><p className={styles.hint}>{t('runes.emptyHint')}</p></>}</div> : null}
      <Button onClick={() => setReceive('ordinals')}>{t('runes.receive')}</Button>
    </>}
  </section>;
}
