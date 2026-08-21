import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import type { OpResult } from '../../adapters/rpc-client';
import { Button } from '../../ui/components/Button';
import { Field } from '../../ui/components/Field';
import { InscriptionReview, parseInscriptionReview } from '../../ui/components/InscriptionReview';
import { MediaBadgeTile, TextExcerptTile } from '../../ui/components/PreviewTile';
import { errorMessageKey } from '../../ui/errors';
import { transactionExplorerUrl } from '../../ui/activity/explorer';
import { useI18n } from '../../ui/i18n';
import { useRpc } from '../../ui/hooks/use-rpc';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import type { AccountCapabilities } from '@drey/core/domain/accounts/capabilities';
import { btcDecimalToSats, parseSats, satsToBtcDecimal } from '@drey/core/domain/sats';
import {
  formatFeeRateSatPerVb,
  parseCustomFeeRate,
} from '@drey/core/domain/transactions/fees';
import { isScanProgressEvent, isWalletDataChangedEvent } from '@drey/core/messaging/events';
import { handleRadioKey } from '../../ui/radio-keyboard';
import { BlockTrail } from '../../ui/transaction/BlockTrail';
import type {
  OrdinalActionDraft,
  OrdinalActionPresentation,
} from '../../ui/ordinal-action';
import { FullpageNav } from './FullpageNav';
import { ActivitySection } from './ActivitySection';
import { ManageUtxos } from './ManageUtxos';
import type { UtxoLabel } from '@drey/core/domain/classification/labels';
import type { AddressBookV1 } from '@drey/core/domain/address-book';
import { resolvePayableAddress } from '@drey/core/domain/transactions/native-send';
import { useAccountActivity } from '../../ui/hooks/use-account-activity';
import styles from './fullpage.module.css';
import {
  alignInscriptionThumbnailScope,
  retryFailedInscriptionThumbnails,
} from '../../ui/hooks/use-inscription-thumbnail';

type Section = 'send' | 'utxos' | 'activity';
type PlanResult = OpResult<'transaction.plan'>;
type ApproveResult = OpResult<'transaction.approve'>;
type BroadcastResult = Exclude<ApproveResult, { status: 'review_required' }>;
type SubmittedResult = BroadcastResult & {
  network: 'mainnet' | 'signet' | 'regtest';
  kind: PlanResult['review']['kind'];
  inscriptionCount: number | null;
  receipt: Pick<PlanResult['review'], 'amountSats' | 'feeSats' | 'recipients'>;
};
type Utxo = OpResult<'utxo.list'>['utxos'][number];
type Transaction = OpResult<'transaction.status'>['transactions'][number];
type SendUnit = 'btc' | 'sats';
type PostageTarget = 'common_546' | 'compatible_10000' | 'minimum_standard' | 'custom';
type ImportedPaymentSuggestions = {
  amountSats?: string;
};
type AdditionalRecipient = {
  id: number;
  address: string;
  amount: string;
};

function withoutImportedSuggestion(
  current: ImportedPaymentSuggestions,
  key: keyof ImportedPaymentSuggestions,
): ImportedPaymentSuggestions {
  const next = { ...current };
  delete next[key];
  return next;
}

const QUOTE_REFRESH_SKEW_MS = 5_000;
const QUOTE_RETRY_MS = 15_000;
const LIVE_SCAN_FALLBACK_MS = 60_000;
const SEND_UNITS = ['btc', 'sats'] as const;
const MAX_NATIVE_BATCH_RECIPIENTS = 20;

function resultTitle(
  result: SubmittedResult,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (result.status === 'accepted') {
    if (result.kind === 'ordinal_transfer') return t('ordinal.result.transfer.title');
    if (result.kind === 'ordinal_batch_transfer') {
      return t('ordinal.result.batch.title', { count: result.inscriptionCount ?? 0 });
    }
    if (result.kind === 'ordinal_postage_manage') return t('ordinal.postage.resultTitle');
    if (result.kind === 'rescue') return t('ordinal.result.rescue.title');
    if (result.kind === 'ordinal_sweep') return t('ordinal.result.sweep.title');
  }
  const ordinal = result.kind === 'ordinal_transfer' || result.kind === 'ordinal_batch_transfer' ||
    result.kind === 'ordinal_postage_manage' ||
    result.kind === 'rescue' ||
    result.kind === 'ordinal_sweep';
  return t(`${ordinal ? 'ordinal' : 'send'}.result.title.${result.status}`);
}

function isOrdinalResult(result: SubmittedResult): boolean {
  return result.kind === 'ordinal_transfer' || result.kind === 'ordinal_batch_transfer' ||
    result.kind === 'ordinal_postage_manage' || result.kind === 'rescue' ||
    result.kind === 'ordinal_sweep';
}

function resultMark(status: SubmittedResult['status']): string {
  if (status === 'accepted' || status === 'already_known' || status === 'confirmed') return '✓';
  if (status === 'pending') return '…';
  return '!';
}

function resultNetworkStatus(
  status: SubmittedResult['status'],
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (status === 'pending') return t('activity.state.indeterminate');
  return t(`activity.status.${status}`);
}

function displaySatPerVb(satPerKvB: number | string): string {
  return formatFeeRateSatPerVb(BigInt(satPerKvB));
}

export function parseCustomFeeInput(text: string): ReturnType<typeof parseCustomFeeRate> | null {
  try {
    return parseCustomFeeRate(text);
  } catch {
    return null;
  }
}

function amountAsSats(amount: string, unit: SendUnit): string | null {
  if (amount === '') return null;
  try {
    const sats = unit === 'btc' ? btcDecimalToSats(amount) : parseSats(amount);
    return sats > 0n ? sats.toString(10) : null;
  } catch {
    return null;
  }
}

function OrdinalDraftPreview(props: {
  inscriptionId: string;
  presentation?: OrdinalActionPresentation | undefined;
}): ReactNode {
  const { t } = useI18n();
  const preview = props.presentation?.preview;
  if (preview?.kind === 'text') {
    return <TextExcerptTile excerpt={preview.excerpt} truncated={preview.truncated} />;
  }
  if (preview?.kind === 'mediaBadge') {
    return <MediaBadgeTile mediaKind={preview.mediaKind} contentLength={preview.contentLength} />;
  }
  if (!preview || preview.kind !== 'raster') {
    return (
      <div className={styles['ordinalDraftPlaceholder']}>
        {t('gallery.previewUnavailable')}
      </div>
    );
  }
  const message = {
    type: 'drey:inert-inscription-preview',
    protocolVersion: 1,
    inscriptionId: props.inscriptionId,
    rasterBase64: preview.rasterBase64,
    pngSha256: preview.pngSha256,
    pngWidth: preview.pngWidth,
    pngHeight: preview.pngHeight,
  };
  return (
    <iframe
      className={styles['ordinalDraftPreview']}
      onLoad={(event: SyntheticEvent<HTMLIFrameElement>) =>
        event.currentTarget.contentWindow?.postMessage(message, '*')}
      referrerPolicy="no-referrer"
      sandbox="allow-scripts"
      src={chrome.runtime.getURL('inscription-preview.html')}
      tabIndex={-1}
      title={t('inscription.preview.iframe', { inscriptionId: props.inscriptionId })}
    />
  );
}

export function Transactions(props: {
  expectedVaultId: ActiveSessionExpectation['expectedVaultId'];
  expectedSessionId: ActiveSessionExpectation['expectedSessionId'];
  accountId: string;
  capabilities: AccountCapabilities;
  initialSection: Section;
  initialAccount?: number;
  initialRecipient?: string | undefined;
  initialOrdinalAction?: OrdinalActionDraft | null;
  selectableAccounts?: readonly number[];
  accountSummaries?: readonly { accountId: string; name: string }[];
  compact?: boolean;
  onNavigate: (section: Section) => void;
  onOpenSettings?: () => void;
  onOpenAddressBook?: () => void;
  onInitialRecipientConsumed?: () => void;
  onOrdinalDone?: () => void;
}): ReactNode {
  const { t, lang } = useI18n();
  const rpc = useRpc();
  const account = String(props.initialAccount ?? 0);
  /** The account every plan built from this screen is submitted under. */
  const accountIndex = Number(account);
  const [recipient, setRecipient] = useState(() => props.initialRecipient ?? '');
  const [addressBook, setAddressBook] = useState<AddressBookV1 | null>(null);
  const [addressBookLoaded, setAddressBookLoaded] = useState(false);
  const [recipientPickerOpen, setRecipientPickerOpen] = useState(false);
  const [recipientPickerTarget, setRecipientPickerTarget] = useState(0);
  const recipientPickerTrigger = useRef<HTMLButtonElement>(null);
  const recipientDialog = useRef<HTMLElement>(null);
  const recipientRequestGeneration = useRef(0);
  const [recipientSearch, setRecipientSearch] = useState('');
  const [myRecipients, setMyRecipients] = useState<Array<{ accountId: string; label: string; address: string }>>([]);
  const [myRecipientsLoading, setMyRecipientsLoading] = useState(false);
  const [selfTransfer, setSelfTransfer] = useState(false);
  const [amount, setAmount] = useState('');
  const [additionalRecipients, setAdditionalRecipients] = useState<AdditionalRecipient[]>([]);
  const nextRecipientId = useRef(1);
  const batchAddressInputs = useRef(new Map<number, HTMLInputElement>());
  const addRecipientButton = useRef<HTMLButtonElement>(null);
  const pendingBatchFocus = useRef<number | 'add' | null>(null);
  const [sendUnit, setSendUnit] = useState<SendUnit>('btc');
  const [sendMax, setSendMax] = useState(false);
  const [postageTarget, setPostageTarget] = useState<PostageTarget>('common_546');
  const [customPostageSats, setCustomPostageSats] = useState('');
  const [paymentRequestLabel, setPaymentRequestLabel] = useState('');
  const [paymentRequestMessage, setPaymentRequestMessage] = useState('');
  const [importedSuggestions, setImportedSuggestions] =
    useState<ImportedPaymentSuggestions>({});
  const [paymentImportBusy, setPaymentImportBusy] = useState(false);
  const [feeTier, setFeeTier] = useState<'priority' | 'standard' | 'economy' | 'custom'>('standard');
  const [customFee, setCustomFee] = useState('');
  const [quote, setQuote] = useState<OpResult<'fees.quote'> | null>(null);
  const [quoteUnavailable, setQuoteUnavailable] = useState(false);
  const [quoteLoading, setQuoteLoading] = useState(true);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [password, setPassword] = useState('');
  const [previewUnavailableAcknowledged, setPreviewUnavailableAcknowledged] = useState(false);
  const [nonTaprootDestinationAcknowledged, setNonTaprootDestinationAcknowledged] = useState(false);
  const [ordinalDraft, setOrdinalDraft] = useState<OrdinalActionDraft | null>(
    () => props.initialOrdinalAction ?? null,
  );
  const [result, setResult] = useState<SubmittedResult | null>(null);
  // `null` until the first load resolves, so the empty state never flashes
  // before the wallet has actually reported zero coins.
  const [utxos, setUtxos] = useState<Utxo[] | null>(null);
  const [privacyNotes, setPrivacyNotes] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [transactionNetwork, setTransactionNetwork] = useState<'mainnet' | 'signet' | 'regtest' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const quoteGeneration = useRef(0);
  const utxoGeneration = useRef(0);
  const activityGeneration = useRef(0);
  const commandGeneration = useRef(0);
  // React disables the action button on the next render, but two click events
  // can still arrive in the same task. Keep the transaction command itself
  // single-flight so a hurried double-click never reaches the worker twice.
  const commandInFlight = useRef<symbol | null>(null);
  const paymentImportGeneration = useRef(0);
  const scanRefreshInFlight = useRef(false);
  const resumeScheduled = useRef(false);
  const feeState = useRef({ feeTier, customFee, quote });
  const navigate = useRef(props.onNavigate);
  feeState.current = { feeTier, customFee, quote };
  navigate.current = props.onNavigate;

  const postageDraftOutpoint = ordinalDraft?.kind === 'ordinal_postage_manage'
    ? `${ordinalDraft.selection.outpoint.txid}:${ordinalDraft.selection.outpoint.vout}`
    : null;
  const currentPostageSats = postageDraftOutpoint === null || utxos === null
    ? null
    : utxos.find((utxo) => `${utxo.txid}:${utxo.vout}` === postageDraftOutpoint)?.valueSats ?? null;

  const { expectedVaultId, expectedSessionId } = props;
  const inscriptionPreviewScope = `${expectedVaultId}:${expectedSessionId}:${props.accountId}`;
  alignInscriptionThumbnailScope(inscriptionPreviewScope);
  const accountActivity = useAccountActivity(
    { expectedVaultId, expectedSessionId },
    props.accountId,
    { enabled: props.initialSection === 'activity' },
  );

  const loadQuote = useCallback(async () => {
    const generation = ++quoteGeneration.current;
    setQuoteLoading(true);
    const response = await rpc('fees.quote', { expectedVaultId, expectedSessionId });
    if (generation !== quoteGeneration.current) return;
    setQuoteLoading(false);
    if (response.ok) {
      feeState.current = { ...feeState.current, quote: response.result };
      setQuote(response.result);
      setQuoteUnavailable(false);
    } else {
      feeState.current = { ...feeState.current, feeTier: 'custom', quote: null };
      setQuote(null);
      setQuoteUnavailable(true);
      setFeeTier((current) => current === 'custom' ? current : 'custom');
    }
  }, [expectedSessionId, expectedVaultId, rpc]);

  const loadUtxos = useCallback(async () => {
    const generation = ++utxoGeneration.current;
    const current = feeState.current;
    const feeRateSatPerKvB = current.feeTier === 'custom'
      ? Number(parseCustomFeeInput(current.customFee)?.satPerKvB ?? 1_000n)
      : (
          current.feeTier === 'priority'
            ? current.quote?.prioritySatPerKvB
            : current.feeTier === 'standard'
              ? current.quote?.standardSatPerKvB
              : current.quote?.economySatPerKvB
        ) ?? 1000;
    const response = await rpc('utxo.list', {
      feeRateSatPerKvB, accountId: props.accountId, expectedVaultId, expectedSessionId,
    });
    if (generation === utxoGeneration.current && response.ok) {
      setUtxos(response.result.utxos);
      setPrivacyNotes(response.result.privacyNotes);
    }
  }, [expectedSessionId, expectedVaultId, props.accountId, rpc]);

  // One rule, both triggers. A selection is only usable while every coin in it
  // stays eligible *and* stays in the account the plan is built under: a higher
  // fee tier can turn a selected input uneconomic, and switching accounts on
  // Send invalidates every coin from the previous one. selectCoins rejects the
  // whole plan with 'manual selection contains an ineligible input' rather than
  // quietly skipping either, so a stale key is a failed send, not a smaller one.
  useEffect(() => {
    if (utxos === null) return;
    const stillSelectable = new Set(
      utxos
        .filter((utxo) => utxo.eligible && utxo.account === accountIndex)
        .map((utxo) => `${utxo.txid}:${utxo.vout}`),
    );
    setSelected((prior) => {
      const next = new Set([...prior].filter((key) => stillSelectable.has(key)));
      return next.size === prior.size ? prior : next;
    });
  }, [accountIndex, utxos]);

  const loadTransactions = useCallback(async () => {
    const generation = ++activityGeneration.current;
    const response = await rpc(
      'transaction.status',
      { accountId: props.accountId, expectedVaultId, expectedSessionId },
    );
    if (generation !== activityGeneration.current) return;
    if (response.ok) {
      setTransactions(response.result.transactions);
      setTransactionNetwork(response.result.network);
    }
  }, [expectedSessionId, expectedVaultId, props.accountId, rpc]);

  const requestLiveScan = useCallback(async (): Promise<void> => {
    if (document.visibilityState === 'hidden' || scanRefreshInFlight.current) return;
    scanRefreshInFlight.current = true;
    try {
      const status = await rpc('scan.status', { expectedVaultId, expectedSessionId });
      if (!status.ok) return;
      if (status.result.kind === 'interrupted' || status.result.kind === 'failed') {
        await rpc('scan.start', { mode: 'resume', expectedVaultId, expectedSessionId });
        return;
      }
      if (status.result.kind === 'idle' || status.result.kind === 'completed') {
        await rpc('scan.start', { mode: 'refresh', expectedVaultId, expectedSessionId });
      }
    } finally {
      scanRefreshInFlight.current = false;
    }
  }, [expectedSessionId, expectedVaultId, rpc]);

  useEffect(() => () => {
    quoteGeneration.current += 1;
    utxoGeneration.current += 1;
    activityGeneration.current += 1;
    commandGeneration.current += 1;
    commandInFlight.current = null;
    paymentImportGeneration.current += 1;
    scanRefreshInFlight.current = false;
    resumeScheduled.current = false;
  }, [expectedSessionId, expectedVaultId]);

  useEffect(() => {
    setTransactions([]);
    setTransactionNetwork(null);
  }, [expectedSessionId, expectedVaultId, props.accountId]);

  useEffect(() => {
    recipientRequestGeneration.current += 1;
    setMyRecipients([]);
    setMyRecipientsLoading(false);
    setRecipientPickerOpen(false);
  }, [expectedSessionId, expectedVaultId]);

  useEffect(() => {
    if (props.initialSection === 'send') {
      void loadQuote();
      if (postageDraftOutpoint !== null) void loadUtxos();
    }
    if (props.initialSection === 'utxos') void loadQuote().then(loadUtxos);
    if (props.initialSection === 'activity') void loadTransactions();
  }, [loadQuote, loadTransactions, loadUtxos, postageDraftOutpoint, props.initialSection]);
  useEffect(() => {
    if (props.initialSection !== 'send') return undefined;
    let active = true;
    setAddressBook(null);
    setAddressBookLoaded(false);
    void rpc('addressBook.list', { expectedVaultId, expectedSessionId }).then((response) => {
      if (!active) return;
      if (response.ok) setAddressBook(response.result);
      setAddressBookLoaded(true);
    });
    return () => { active = false; };
  }, [expectedSessionId, expectedVaultId, props.initialSection, rpc]);
  useEffect(() => {
    if (props.initialRecipient !== undefined) props.onInitialRecipientConsumed?.();
  }, [props.initialRecipient, props.onInitialRecipientConsumed]);
  const closeRecipientPicker = useCallback((restoreFocus = false) => {
    setRecipientPickerOpen(false);
    if (restoreFocus) requestAnimationFrame(() => recipientPickerTrigger.current?.focus());
  }, []);
  useEffect(() => {
    if (!recipientPickerOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRecipientPicker(true);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...(recipientDialog.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? [])];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [closeRecipientPicker, recipientPickerOpen]);
  useEffect(() => {
    if (props.initialSection === 'send') return undefined;
    const loadVisibleData = (): void => {
      if (props.initialSection === 'utxos') void loadUtxos();
      else void loadTransactions();
    };
    const onMessage = (message: unknown): void => {
      if (isScanProgressEvent(message)) {
        loadVisibleData();
        return;
      }
      if (!isWalletDataChangedEvent(message)) return;
      if (message.reason === 'transaction' || message.reason === 'utxo' || message.reason === 'account') {
        loadVisibleData();
      }
      if (message.reason === 'transaction' || message.reason === 'account') void requestLiveScan();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    void requestLiveScan();
    // External incoming payments have no local mutation event. A slow visible-
    // window fallback discovers those without making every local UI refresh hit
    // the gateway. requestLiveScan remains single-flight and skips active scans.
    const scanTimer = setInterval(() => void requestLiveScan(), LIVE_SCAN_FALLBACK_MS);
    return () => {
      clearInterval(scanTimer);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, [loadTransactions, loadUtxos, props.initialSection, requestLiveScan]);
  useEffect(() => {
    const onResume = (): void => {
      if (document.visibilityState === 'hidden' || resumeScheduled.current) return;
      resumeScheduled.current = true;
      queueMicrotask(() => {
        resumeScheduled.current = false;
        if (props.initialSection === 'send') {
          void loadQuote();
        } else if (props.initialSection === 'utxos') {
          void loadQuote().then(loadUtxos);
          void requestLiveScan();
        } else {
          void loadTransactions();
          void requestLiveScan();
        }
      });
    };
    window.addEventListener('focus', onResume);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      resumeScheduled.current = false;
      window.removeEventListener('focus', onResume);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, [loadQuote, loadTransactions, loadUtxos, props.initialSection, requestLiveScan]);
  useEffect(() => {
    if (quote === null || props.initialSection === 'activity') return undefined;
    const untilRefresh = Date.parse(quote.expiresAt) - Date.now() - QUOTE_REFRESH_SKEW_MS;
    const timer = setTimeout(() => void loadQuote(), untilRefresh > 0 ? untilRefresh : QUOTE_RETRY_MS);
    return () => clearTimeout(timer);
  }, [loadQuote, props.initialSection, quote]);

  const planIntent = useCallback(async (intent: Record<string, unknown>): Promise<void> => {
    if (!props.capabilities.canBuildUnsignedPsbt || commandInFlight.current !== null) return;
    const command = Symbol('transaction-plan');
    commandInFlight.current = command;
    const generation = commandGeneration.current;
    const currentFee = feeState.current.feeTier === 'custom'
      ? { type: 'custom' as const, rateSatPerVb: feeState.current.customFee }
      : { type: 'automatic' as const, tier: feeState.current.feeTier };
    setBusy(true);
    setError(null);
    setResult(null);
    const response = await (async () => {
      try {
        return await rpc('transaction.plan', {
          account: accountIndex,
          ...intent,
          accountId: props.accountId,
          fee: currentFee,
          expectedVaultId,
          expectedSessionId,
        } as Parameters<typeof rpc<'transaction.plan'>>[1]);
      } finally {
        if (commandInFlight.current === command) commandInFlight.current = null;
      }
    })();
    if (generation !== commandGeneration.current) return;
    setBusy(false);
    if (!response.ok) {
      setError(t(intent['kind'] === 'ordinal_postage_manage' &&
        response.code === 'ERR_NO_SWEEPABLE_EXCESS'
        ? 'ordinal.postage.error.uneconomic'
        : errorMessageKey(response.code)));
      return;
    }
    setPlan(response.result);
    setPreviewUnavailableAcknowledged(false);
    setNonTaprootDestinationAcknowledged(false);
    navigate.current('send');
  }, [accountIndex, expectedSessionId, expectedVaultId, props.accountId,
    props.capabilities.canBuildUnsignedPsbt, rpc, t]);

  const changeRecipientManually = useCallback((next: string): void => {
    paymentImportGeneration.current += 1;
    setPaymentImportBusy(false);
    setImportedSuggestions({});
    setPaymentRequestLabel('');
    setPaymentRequestMessage('');
    setRecipient(next.trim());
  }, []);

  const changeAdditionalRecipient = useCallback((
    id: number,
    field: 'address' | 'amount',
    value: string,
  ): void => {
    setAdditionalRecipients((current) => current.map((entry) =>
      entry.id === id ? { ...entry, [field]: value } : entry));
  }, []);

  useEffect(() => {
    const target = pendingBatchFocus.current;
    if (target === null) return;
    pendingBatchFocus.current = null;
    if (target === 'add') addRecipientButton.current?.focus();
    else batchAddressInputs.current.get(target)?.focus();
  }, [additionalRecipients]);

  const addRecipient = useCallback((): void => {
    if (additionalRecipients.length + 1 >= MAX_NATIVE_BATCH_RECIPIENTS) return;
    const id = nextRecipientId.current++;
    setSendMax(false);
    pendingBatchFocus.current = id;
    setAdditionalRecipients((current) => [...current, { id, address: '', amount: '' }]);
  }, [additionalRecipients.length]);

  const removeRecipient = useCallback((id: number): void => {
    const index = additionalRecipients.findIndex((entry) => entry.id === id);
    const remaining = additionalRecipients.filter((entry) => entry.id !== id);
    pendingBatchFocus.current = remaining[index]?.id ?? remaining[index - 1]?.id ?? 'add';
    setAdditionalRecipients(remaining);
  }, [additionalRecipients]);

  const pastePaymentInstruction = useCallback(async (
    event: ClipboardEvent<HTMLInputElement>,
  ): Promise<void> => {
    const input = event.clipboardData.getData('text').trim();
    if (input === '') return;
    event.preventDefault();
    const generation = ++paymentImportGeneration.current;
    setPaymentImportBusy(true);
    setError(null);
    const response = await rpc('paymentInstruction.resolve', {
      input,
      expectedVaultId,
      expectedSessionId,
    });
    if (generation !== paymentImportGeneration.current) return;
    setPaymentImportBusy(false);
    if (!response.ok) {
      setError(t(errorMessageKey(response.code)));
      return;
    }

    const requested = response.result;
    const conflicts: ImportedPaymentSuggestions = {};
    setRecipient(requested.address);
    if (requested.amountSats !== null) {
      const enteredSats = amountAsSats(amount, sendUnit);
      if (amount === '' && !sendMax) {
        setAmount(sendUnit === 'btc'
          ? satsToBtcDecimal(BigInt(requested.amountSats))
          : requested.amountSats);
      } else if (sendMax || enteredSats !== requested.amountSats) {
        conflicts.amountSats = requested.amountSats;
      }
    }
    setPaymentRequestLabel(requested.label ?? '');
    setPaymentRequestMessage(requested.message ?? '');
    setImportedSuggestions(conflicts);
  }, [amount, expectedSessionId, expectedVaultId, rpc, sendMax, sendUnit, t]);

  const submitSend = useCallback((event: FormEvent): void => {
    event.preventDefault();
    const amountSats = amountAsSats(amount, sendUnit);
    if (!sendMax && amountSats === null) return;
    const selectedOutpoints = [...selected].map((key) => {
      const [txid, vout] = key.split(':');
      return { txid: txid ?? '', vout: Number(vout) };
    });
    if (additionalRecipients.length > 0) {
      const recipients = [
        { address: recipient, amountSats: amountSats ?? '' },
        ...additionalRecipients.map((entry) => ({
          address: entry.address,
          amountSats: amountAsSats(entry.amount, sendUnit) ?? '',
        })),
      ];
      if (recipients.some((entry) => entry.address === '' || entry.amountSats === '')) return;
      void planIntent({
        kind: 'native_batch_send',
        account: Number(account),
        recipients,
        ...(selectedOutpoints.length > 0 ? { selectedOutpoints } : {}),
      });
      return;
    }
    void planIntent({
      kind: 'native_send',
      account: Number(account),
      recipient,
      amountSats: sendMax ? '0' : amountSats,
      sendMax,
      ...(selectedOutpoints.length > 0 ? { selectedOutpoints } : {}),
    });
  }, [account, additionalRecipients, amount, planIntent, recipient, selected, sendMax, sendUnit]);

  const submitOrdinal = useCallback((event: FormEvent): void => {
    event.preventDefault();
    if (!ordinalDraft) return;
    if (ordinalDraft.kind === 'ordinal_transfer') {
      if (recipient === '') return;
      void planIntent({
        kind: ordinalDraft.kind,
        account: ordinalDraft.account,
        inscriptionId: ordinalDraft.inscriptionId,
        outpoint: { ...ordinalDraft.outpoint },
        recipient,
      });
      return;
    }
    if (ordinalDraft.kind === 'ordinal_batch_transfer') {
      if (recipient === '') return;
      void planIntent({
        kind: ordinalDraft.kind,
        account: ordinalDraft.account,
        recipient,
        selections: ordinalDraft.selections.map((selection) => ({
          inscriptionId: selection.inscriptionId,
          outpoint: { ...selection.outpoint },
          satpoint: selection.satpoint,
          classificationRevision: selection.classificationRevision,
        })),
      });
      return;
    }
    if (ordinalDraft.kind === 'ordinal_postage_manage') {
      if (postageTarget === 'custom' && customPostageSats === '') return;
      void planIntent({
        kind: ordinalDraft.kind,
        account: ordinalDraft.account,
        selections: [{
          inscriptionId: ordinalDraft.selection.inscriptionId,
          outpoint: { ...ordinalDraft.selection.outpoint },
          satpoint: ordinalDraft.selection.satpoint,
          classificationRevision: ordinalDraft.selection.classificationRevision,
        }],
        target: postageTarget === 'custom'
          ? { type: postageTarget, customSats: customPostageSats }
          : { type: postageTarget },
      });
      return;
    }
    void planIntent({
      kind: ordinalDraft.kind,
      outpoint: { ...ordinalDraft.outpoint },
    });
  }, [customPostageSats, ordinalDraft, planIntent, postageTarget, recipient]);

  const changeSendUnit = useCallback((nextUnit: SendUnit): void => {
    if (nextUnit === sendUnit) return;
    const sats = amountAsSats(amount, sendUnit);
    setAmount(
      sats === null
        ? ''
        : nextUnit === 'btc'
          ? satsToBtcDecimal(BigInt(sats))
          : sats,
    );
    setAdditionalRecipients((current) => current.map((entry) => {
      const entrySats = amountAsSats(entry.amount, sendUnit);
      return {
        ...entry,
        amount: entrySats === null
          ? ''
          : nextUnit === 'btc'
            ? satsToBtcDecimal(BigInt(entrySats))
            : entrySats,
      };
    }));
    setSendUnit(nextUnit);
  }, [amount, sendUnit]);

  const cancelPlan = useCallback(async (): Promise<void> => {
    if (plan) await rpc('transaction.cancel', {
      planId: plan.planId,
      accountId: props.accountId,
      expectedVaultId,
      expectedSessionId,
    });
    setPlan(null);
    setPassword('');
    setPreviewUnavailableAcknowledged(false);
    setNonTaprootDestinationAcknowledged(false);
  }, [expectedSessionId, expectedVaultId, plan, props.accountId, rpc]);

  const approve = useCallback(async (): Promise<void> => {
    if (!plan || !props.capabilities.canSignPsbt || commandInFlight.current !== null) return;
    const command = Symbol('transaction-approval');
    commandInFlight.current = command;
    const generation = commandGeneration.current;
    setBusy(true);
    setError(null);
    const response = await (async () => {
      try {
        return await rpc('transaction.approve', {
          planId: plan.planId,
          accountId: props.accountId,
          planHash: plan.planHash,
          ...(password ? { password } : {}),
          ...(previewUnavailableAcknowledged ? { previewUnavailableAcknowledged: true } : {}),
          ...(nonTaprootDestinationAcknowledged
            ? { nonTaprootDestinationAcknowledged: true }
            : {}),
          expectedVaultId,
          expectedSessionId,
        });
      } finally {
        if (commandInFlight.current === command) commandInFlight.current = null;
      }
    })();
    if (generation !== commandGeneration.current) return;
    setBusy(false);
    if (!response.ok) {
      setError(t(errorMessageKey(response.code)));
      return;
    }
    if (response.result.status === 'review_required') {
      setPlan(response.result.replacement);
      setPassword('');
      setPreviewUnavailableAcknowledged(false);
      setNonTaprootDestinationAcknowledged(false);
      return;
    }
    setResult({
      ...response.result,
      network: plan.review.network,
      kind: plan.review.kind,
      inscriptionCount: plan.review.ordinalAction?.action === 'batch_transfer'
        ? plan.review.ordinalAction.inscriptionCount
        : plan.review.ordinalAction?.action === 'manage_postage'
          ? plan.review.ordinalAction.items.length
          : plan.review.ordinalAction?.inscriptionId === null ? null : 1,
      receipt: {
        amountSats: plan.review.amountSats,
        feeSats: plan.review.feeSats,
        recipients: plan.review.ordinalAction?.action === 'batch_transfer'
          ? [{
              address: plan.review.ordinalAction.destination.address,
              valueSats: plan.review.ordinalAction.aggregatePostageSats,
              role: 'postage',
            }]
          : plan.review.recipients.map((recipient) => ({ ...recipient })),
      },
    });
    setPlan(null);
    setPreviewUnavailableAcknowledged(false);
    setNonTaprootDestinationAcknowledged(false);
    setSelected(new Set());
  }, [expectedSessionId, expectedVaultId, nonTaprootDestinationAcknowledged, password, plan,
    previewUnavailableAcknowledged,
    props.accountId, props.capabilities.canSignPsbt, rpc, t]);

  const freeze = useCallback(async (utxo: Utxo): Promise<void> => {
    setError(null);
    const response = await rpc('utxo.setFrozen', {
      txid: utxo.txid,
      vout: utxo.vout,
      accountId: props.accountId,
      frozen: !utxo.frozen,
      expectedVaultId,
      expectedSessionId,
    });
    if (!response.ok) {
      setError(t(errorMessageKey(response.code)));
      return;
    }
    if (!response.result.updated) {
      setError(t('common.error.internal'));
      return;
    }
    await loadUtxos();
  }, [expectedSessionId, expectedVaultId, loadUtxos, props.accountId, rpc, t]);

  const setLabel = useCallback(async (utxo: Utxo, label: UtxoLabel | null): Promise<void> => {
    const response = await rpc('utxo.setLabel', {
      txid: utxo.txid,
      vout: utxo.vout,
      accountId: props.accountId,
      label,
      expectedVaultId,
      expectedSessionId,
    });
    if (response.ok) await loadUtxos();
  }, [expectedSessionId, expectedVaultId, loadUtxos, props.accountId, rpc]);

  const consolidate = useCallback((): void => {
    const selectedOutpoints = [...selected].map((key) => {
      const [txid, vout] = key.split(':');
      return { txid: txid ?? '', vout: Number(vout) };
    });
    void planIntent({ kind: 'consolidation', account: Number(account), selectedOutpoints });
  }, [account, planIntent, selected]);

  const sendKind = ordinalDraft?.kind === 'ordinal_transfer' ||
    ordinalDraft?.kind === 'ordinal_batch_transfer' ? 'ordinal' : 'bitcoin';
  const openRecipientPicker = useCallback(async (target = 0): Promise<void> => {
    const generation = ++recipientRequestGeneration.current;
    setRecipientPickerOpen(true);
    setRecipientPickerTarget(target);
    setRecipientSearch('');
    setMyRecipientsLoading(true);
    const kind = sendKind === 'ordinal' ? 'ordinals' as const : 'payment' as const;
    try {
      const entries = await Promise.all((props.accountSummaries ?? []).map(async (summary) => {
        const result = await rpc('address.receive', {
          accountId: summary.accountId,
          kind,
          expectedVaultId,
          expectedSessionId,
        });
        return result.ok ? { accountId: summary.accountId, label: summary.name, address: result.result.address } : null;
      }));
      if (recipientRequestGeneration.current !== generation) return;
      setMyRecipients(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
    } finally {
      if (recipientRequestGeneration.current === generation) setMyRecipientsLoading(false);
    }
  }, [expectedSessionId, expectedVaultId, props.accountSummaries, rpc, sendKind]);
  const chooseRecipient = (address: string, owned = false): void => {
    if (recipientPickerTarget === 0) {
      changeRecipientManually(address);
      setSelfTransfer(owned);
    } else {
      changeAdditionalRecipient(recipientPickerTarget, 'address', address);
    }
    closeRecipientPicker(true);
  };
  const normalizedRecipientSearch = recipientSearch.trim().toLowerCase();
  const filteredSavedPickerEntries = (addressBook?.saved ?? []).filter((entry) => {
    if (sendKind === 'ordinal') {
      const resolved = resolvePayableAddress(entry.address, addressBook?.network ?? 'mainnet');
      if (!resolved.ok || resolved.value.scriptKind !== 'p2tr') return false;
    }
    return normalizedRecipientSearch === '' || `${entry.label} ${entry.address}`.toLowerCase().includes(normalizedRecipientSearch);
  });
  const filteredMyPickerEntries = myRecipients.filter((entry) => normalizedRecipientSearch === '' ||
    `${entry.label} ${entry.address}`.toLowerCase().includes(normalizedRecipientSearch));
  const filteredRecentPickerEntries = (addressBook?.recent ?? []).filter((entry) =>
    entry.lastKind === sendKind &&
    (normalizedRecipientSearch === '' || entry.address.toLowerCase().includes(normalizedRecipientSearch)));
  const visibleAddresses = new Set<string>();
  const uniqueByAddress = <Entry extends { address: string }>(entries: Entry[]): Entry[] => entries.filter((entry) => {
    const normalized = entry.address.toLowerCase();
    if (visibleAddresses.has(normalized)) return false;
    visibleAddresses.add(normalized);
    return true;
  });
  const savedPickerEntries = uniqueByAddress(filteredSavedPickerEntries);
  const myPickerEntries = uniqueByAddress(filteredMyPickerEntries);
  const recentPickerEntries = uniqueByAddress(filteredRecentPickerEntries);
  const recipientPickerLoading = !addressBookLoaded || myRecipientsLoading;
  const recipientPickerEmpty = savedPickerEntries.length + myPickerEntries.length +
    recentPickerEntries.length === 0;
  const recipientGroups = [
    { id: 'saved', heading: t('contacts.saved'), entries: savedPickerEntries.map((entry) => ({
      key: entry.id, label: entry.label, address: entry.address, owned: false,
    })) },
    { id: 'accounts', heading: t('contacts.myAccounts'), entries: myPickerEntries.map((entry) => ({
      key: entry.accountId, label: entry.label, address: entry.address, owned: true,
    })) },
    { id: 'recent', heading: t('contacts.recent'), entries: recentPickerEntries.map((entry) => ({
      key: entry.address, label: t('contacts.recentAddress'), address: entry.address, owned: false,
    })) },
  ];

  const recipientPicker = (target = 0) => (
    <>
      <Button
        ref={target === 0 ? recipientPickerTrigger : undefined}
        type="button"
        variant="secondary"
        onClick={(event) => {
          recipientPickerTrigger.current = event.currentTarget;
          void openRecipientPicker(target);
        }}
      >
        {t('contacts.addressBook')}
      </Button>
      {target === 0 && selfTransfer ? <p className={styles['advisory']} role="note">{t('contacts.selfTransfer')}</p> : null}
      {recipientPickerOpen && recipientPickerTarget === target ? (
        <div className={`${styles['dialogBackdrop']} ${props.compact ? styles['dialogBackdropCompact'] : ''}`} role="presentation">
          <section ref={recipientDialog}
            className={`${styles['dialog']} ${props.compact ? styles['dialogCompact'] : ''}`}
            role="dialog" aria-modal="true" aria-labelledby="recipient-picker-title">
            <div className={styles['dialogHeader']}>
              <h2 id="recipient-picker-title">{t('contacts.choose')}</h2>
              <Button className={styles['dialogClose']} variant="ghost"
                onClick={() => closeRecipientPicker(true)}>{t('common.close')}</Button>
            </div>
            <div className={styles['dialogSearch']}>
              <Field label={t('contacts.search')} value={recipientSearch}
                onChange={(event) => setRecipientSearch(event.target.value)} autoFocus />
            </div>
            <div className={styles['recipientList']}>
              {recipientPickerLoading && recipientPickerEmpty ? (
                <p className={styles['recipientEmpty']} role="status">{t('contacts.loading')}</p>
              ) : null}
              {!recipientPickerLoading && recipientPickerEmpty ? (
                <p className={styles['recipientEmpty']} role="status">
                  {normalizedRecipientSearch === '' ? t('contacts.picker.empty') : t('contacts.noMatches')}
                </p>
              ) : null}
              {recipientGroups.map(({ id, heading, entries }) => entries.length === 0 ? null : (
                <section key={id} className={styles['recipientGroup']} aria-labelledby={`recipient-group-${id}`}>
                  <h3 id={`recipient-group-${id}`}>{heading}</h3>
                  <div className={styles['recipientRows']}>
                    {entries.map((entry) => (
                      <button className={styles['recipientRow']} key={entry.key} type="button"
                        onClick={() => chooseRecipient(entry.address, entry.owned)}>
                        <span className={styles['recipientRowCopy']}>
                          <strong>{entry.label}</strong>
                          <span className={styles['recipientAddress']} title={entry.address}>{entry.address}</span>
                        </span>
                        {entry.owned ? <span className={styles['recipientBadge']}>{t('contacts.owned')}</span> : null}
                        <span className={styles['recipientChevron']} aria-hidden="true">›</span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
            {props.onOpenAddressBook ? (
              <div className={styles['dialogFooter']}>
                <Button variant="ghost" onClick={() => {
                  closeRecipientPicker(false);
                  props.onOpenAddressBook?.();
                }}>{t('contacts.manage')}</Button>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </>
  );

  const accelerate = useCallback((kind: 'rbf' | 'cpfp', txid: string): void => {
    void planIntent({ kind, txid });
  }, [planIntent]);

  const customFeeValid = parseCustomFeeInput(customFee) !== null;
  const feeSelectionReady = feeTier === 'custom' ? customFeeValid : quote !== null;

  const feeChooser = (
    <fieldset className={styles['fieldset']}>
      <legend>
        <span className={styles['feeLegend']}>
          {t('send.fee')}
          <span
            className={styles['feeRefreshStatus']}
            data-loading={quoteLoading}
            role="status"
            aria-label={quoteLoading ? t('send.fee.loading') : undefined}
            title={quoteLoading ? t('send.fee.loading') : undefined}
          />
        </span>
      </legend>
      {([
        ['priority', quote?.prioritySatPerKvB, 'send.fee.priority', 'send.fee.priority.eta'],
        ['standard', quote?.standardSatPerKvB, 'send.fee.standard', 'send.fee.standard.eta'],
        ['economy', quote?.economySatPerKvB, 'send.fee.economy', 'send.fee.economy.eta'],
      ] as const).map(([tier, rate, label, eta]) => (
        <label className={styles['feeOption']} key={tier}>
          <input
            type="radio"
            disabled={quote === null}
            checked={feeTier === tier}
            onChange={() => setFeeTier(tier)}
          />
          <span className={styles['feeOptionCopy']}>
            <strong>{t(label)}</strong>
            <span className={styles['feeOptionEta']}>{t(eta)}</span>
          </span>
          <span className={styles['feeOptionRate']}>
            {rate === undefined ? '—' : `${displaySatPerVb(rate)} sat/vB`}
          </span>
        </label>
      ))}
      <label className={styles['feeOption']}>
        <input type="radio" checked={feeTier === 'custom'} onChange={() => setFeeTier('custom')} />
        <span className={styles['feeOptionCopy']}><strong>{t('send.fee.custom')}</strong></span>
      </label>
      {feeTier === 'custom' ? (
        <>
          <p className={styles['warning']} role="alert">{t('send.fee.customWarning')}</p>
          <Field
            label={t('send.fee.rate')}
            inputMode="decimal"
            value={customFee}
            onChange={(event) => {
              const next = event.target.value.trim();
              if (/^\d*(?:\.\d{0,3})?$/u.test(next)) setCustomFee(next);
            }}
          />
        </>
      ) : null}
      {quoteUnavailable ? (
        <div className={styles['advisory']} role="note">
          <p>{t('send.fee.degraded')}</p>
          <Button type="button" variant="secondary" onClick={() => void loadQuote()} disabled={quoteLoading}>
            {t('common.retry')}
          </Button>
        </div>
      ) : null}
    </fieldset>
  );

  const review = plan?.review;
  const reviewRecord = review as unknown as Record<string, unknown> | undefined;
  const inscriptionReview = parseInscriptionReview(reviewRecord?.['inscriptions']);
  const inscriptionEffectCountValid = reviewRecord?.['inscriptions'] === undefined ||
    (typeof reviewRecord?.['effectCount'] === 'number' && Number.isSafeInteger(reviewRecord['effectCount']) &&
      reviewRecord['effectCount'] === inscriptionReview.items.length);
  const inscriptionReviewValid = inscriptionReview.valid && inscriptionEffectCountValid;
  const requiresPreviewAcknowledgement = reviewRecord?.['requiresPreviewAcknowledgement'] === true ||
    inscriptionReview.items.some((item) => item.preview.kind === 'placeholder');
  const validAmountSats = amountAsSats(amount, sendUnit);
  const batchRecipientsReady = additionalRecipients.length === 0 || additionalRecipients.every(
    (entry) => entry.address !== '' && amountAsSats(entry.amount, sendUnit) !== null,
  );
  return (
    <div className={props.compact ? styles['compactTransactions'] : undefined}>
      {!props.compact ? (
        <FullpageNav
          current={props.initialSection}
          settingsDisabled={busy || plan !== null}
          onNavigate={(destination) => {
            if (destination === 'settings') props.onOpenSettings?.();
            else props.onNavigate(destination);
          }}
        />
      ) : null}

      {error ? <p role="alert" className={styles['error']}>{error}</p> : null}

      {props.initialSection === 'send' ? (
        result ? (
          <section
            className={`${styles['section']} ${styles['transactionResult']}`}
            data-status={result.status}
            aria-live="polite"
          >
            <div className={styles['resultHeading']}>
              <span className={styles['resultMark']} aria-hidden="true">
                {resultMark(result.status)}
              </span>
              <div>
                <h1 className={styles['title']}>{resultTitle(result, t)}</h1>
                <p className={styles['resultMessage']}>
                  {result.kind === 'ordinal_transfer' || result.kind === 'ordinal_batch_transfer' ||
                    result.kind === 'ordinal_postage_manage' ||
                    result.kind === 'rescue' ||
                    result.kind === 'ordinal_sweep'
                    ? t(`ordinal.result.${result.status}`)
                    : t(`send.result.${result.status}`)}
                </p>
              </div>
            </div>
            <BlockTrail
              compact={props.compact === true}
              status={result.status === 'pending' ? 'indeterminate' : result.status}
              recordKind="durable"
              statusLabel={resultNetworkStatus(result.status, t)}
            />
            <dl className={styles['resultSummary']}>
              <div>
                <dt>{t('send.review.amount')}</dt>
                <dd>{BigInt(result.receipt.amountSats).toLocaleString(lang)} sats</dd>
              </div>
              <div>
                <dt>{t('send.review.fee')}</dt>
                <dd>{BigInt(result.receipt.feeSats).toLocaleString(lang)} sats</dd>
              </div>
            </dl>
            {result.receipt.recipients.length > 0 ? (
              <div className={styles['resultDestinations']}>
                <strong className={styles['resultDestinationLabel']}>
                  {result.receipt.recipients.length === 1
                  ? t('approval.destination')
                  : t('approval.destinations')}
                </strong>
                <ul className={styles['resultRecipientList']}>
                  {result.receipt.recipients.map((recipient, index) => (
                    <li className={styles['resultRecipient']} key={`${recipient.address}:${index}`}>
                      <span className={styles['resultAddress']} title={recipient.address}>
                        {recipient.address}
                      </span>
                      {result.receipt.recipients.length > 1 ? (
                        <strong>{BigInt(recipient.valueSats).toLocaleString(lang)} sats</strong>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <a
              className={`${styles['explorerLink']} ${styles['resultExplorer']}`}
              href={transactionExplorerUrl(result.network, result.txid)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className={styles['resultExplorerLabel']}>
                {t('activity.viewExplorer')} ↗
              </span>
              <code className={styles['code']} title={result.txid}>{result.txid}</code>
            </a>
            <Button
              className={styles['resultAction']}
              onClick={() => {
                if (result.status === 'pending') {
                  props.onNavigate('activity');
                  return;
                }
                setResult(null);
                setOrdinalDraft(null);
                if (isOrdinalResult(result)) props.onOrdinalDone?.();
              }}
            >
              {result.status === 'pending'
                ? t('nav.activity')
                : isOrdinalResult(result) ? t('ordinal.done') : t('send.new')}
            </Button>
          </section>
        ) : review ? (
          <section className={styles['section']}>
            <h1 className={styles['title']}>{review.kind === 'ordinal_transfer'
              ? t('ordinal.review.transfer.title')
              : review.kind === 'ordinal_batch_transfer'
                ? t('ordinal.review.batch.title', {
                    count: review.ordinalAction?.action === 'batch_transfer'
                      ? review.ordinalAction.inscriptionCount
                      : 0,
                  })
              : review.kind === 'ordinal_postage_manage'
                ? t('ordinal.postage.reviewTitle')
              : review.kind === 'rescue'
                ? t('ordinal.review.rescue.title')
                : review.kind === 'ordinal_sweep'
                  ? t('ordinal.review.sweep.title')
                  : review.kind === 'rbf' || review.kind === 'cpfp'
                    ? t('send.review.speedUp.title')
                    : t('send.review.title')}</h1>
            {review.kind === 'rbf' || review.kind === 'cpfp' ? (
              <p className={styles['advisory']} role="note">
                {t(review.kind === 'rbf'
                  ? 'send.review.rbf.explanation'
                  : 'send.review.cpfp.explanation')}
              </p>
            ) : null}
            {review.ordinalAction?.action === 'sweep'
              ? <p>{t('ordinal.review.sweep.noInscription')}</p>
              : null}
            {!inscriptionReviewValid ? (
              <p role="alert" className={styles['warning']}>
                {t('inscription.review.invalid')}
              </p>
            ) : (
              <InscriptionReview
                items={inscriptionReview.items}
                primaryInscriptionId={review.ordinalAction !== null &&
                  'inscriptionId' in review.ordinalAction
                  ? review.ordinalAction.inscriptionId ?? undefined
                  : undefined}
                acknowledgementChecked={previewUnavailableAcknowledged}
                onAcknowledgementChange={setPreviewUnavailableAcknowledged}
                compact={review.ordinalAction !== null}
              />
            )}
            {review.ordinalAction?.action === 'manage_postage' ? (
              <>
                <dl className={`${styles['details']} ${styles['ordinalReviewSummary']}`}>
                  <div>
                    <dt>{t('ordinal.postage.recovered')}</dt>
                    <dd>{BigInt(review.ordinalAction.returnedBtcSats).toLocaleString(lang)} sats</dd>
                  </div>
                  <div>
                    <dt>{t('send.review.fee')}</dt>
                    <dd>{BigInt(review.ordinalAction.feeSats).toLocaleString(lang)} sats</dd>
                  </div>
                  <div>
                    <dt>{t('ordinal.postage.netReturned')}</dt>
                    <dd>{BigInt(review.ordinalAction.netReturnedBtcSats).toLocaleString(lang)} sats</dd>
                  </div>
                </dl>
                {review.ordinalAction.items.map((item) => (
                  <section className={styles['ordinalBatchGroup']} key={item.inscriptionId}>
                    <code className={styles['code']}>{item.inscriptionId}</code>
                    <dl className={styles['details']}>
                      <div>
                        <dt>{t('ordinal.postage.current')}</dt>
                        <dd>{BigInt(item.currentPostageSats).toLocaleString(lang)} sats</dd>
                      </div>
                      <div>
                        <dt>{t('ordinal.postage.remaining')}</dt>
                        <dd>{BigInt(item.retainedPostageSats).toLocaleString(lang)} sats</dd>
                      </div>
                      {BigInt(item.addedSats) > 0n ? (
                        <div>
                          <dt>{t('ordinal.postage.added')}</dt>
                          <dd>{BigInt(item.addedSats).toLocaleString(lang)} sats</dd>
                        </div>
                      ) : null}
                    </dl>
                  </section>
                ))}
                <details className={styles['ordinalTechnicalDetails']}>
                  <summary>{t('send.review.details')}</summary>
                  <p>{t('send.review.psbt')}</p>
                  <code className={styles['code']}>{review.psbtHash}</code>
                </details>
              </>
            ) : review.ordinalAction?.action === 'batch_transfer' ? (
              <>
                <dl className={`${styles['details']} ${styles['ordinalReviewSummary']}`}>
                  <div className={styles['ordinalDestination']}>
                    <dt>{t('ordinal.review.destination')}</dt>
                    <dd>{review.ordinalAction.destination.address}</dd>
                    <span className={styles['ordinalOwnership']}>
                      {review.ordinalAction.destination.ownership === 'wallet'
                        ? t('ordinal.review.owned')
                        : t('ordinal.review.external')}
                    </span>
                  </div>
                  <div>
                    <dt>{t('ordinal.review.postage')}</dt>
                    <dd>{BigInt(review.ordinalAction.aggregatePostageSats).toLocaleString(lang)} sats</dd>
                  </div>
                  <div>
                    <dt>{t('send.review.fee')}</dt>
                    <dd>{BigInt(review.ordinalAction.feeSats).toLocaleString(lang)} sats</dd>
                  </div>
                  <div>
                    <dt>{t('send.review.rate')}</dt>
                    <dd>{displaySatPerVb(review.feeRateSatPerKvB)} sat/vB</dd>
                  </div>
                  <div>
                    <dt>{t('ordinal.review.returned')}</dt>
                    <dd>{BigInt(review.ordinalAction.returnedBtcSats).toLocaleString(lang)} sats</dd>
                  </div>
                </dl>
                <details className={styles['ordinalTechnicalDetails']}>
                  <summary>{t('ordinal.review.batch.groups')}</summary>
                  {review.ordinalAction.groups.map((group) => (
                    <section className={styles['ordinalBatchGroup']} key={`${group.satpoint}:${group.destinationOutputIndex}`}>
                      <strong>{t('ordinal.review.batch.group', {
                        output: group.destinationOutputIndex,
                      })}</strong>
                      <code className={styles['code']}>{group.satpoint}</code>
                      <code className={styles['code']}>{group.source.txid}:{group.source.vout}</code>
                      <span>{BigInt(group.postageSats).toLocaleString(lang)} sats</span>
                      {group.travelsTogether ? (
                        <span>{t('ordinal.review.batch.travelsTogether', {
                          count: group.inscriptionIds.length,
                        })}</span>
                      ) : null}
                      <details>
                        <summary>{t('ordinal.review.batch.identifiers')}</summary>
                        {group.inscriptionIds.map((inscriptionId) => (
                          <code className={styles['code']} key={inscriptionId}>{inscriptionId}</code>
                        ))}
                      </details>
                    </section>
                  ))}
                  <dl className={styles['details']}>
                    <div>
                      <dt>{t('ordinal.review.funding')}</dt>
                      <dd>{review.ordinalAction.fundingInputs.length === 0
                        ? t('ordinal.review.none')
                        : review.ordinalAction.fundingInputs.map((input) =>
                            `${input.txid}:${input.vout} (${BigInt(input.valueSats).toLocaleString(lang)} sats)`,
                          ).join(', ')}</dd>
                    </div>
                    <div><dt>{t('send.review.inputs')}</dt><dd>{review.inputs.length}</dd></div>
                  </dl>
                  <p>{t('send.review.psbt')}</p>
                  <code className={styles['code']}>{review.psbtHash}</code>
                </details>
              </>
            ) : review.ordinalAction ? (
              <>
                <dl className={`${styles['details']} ${styles['ordinalReviewSummary']}`}>
                  <div className={styles['ordinalDestination']}>
                    <dt>{t('ordinal.review.destination')}</dt>
                    <dd>{review.ordinalAction.destination.address}</dd>
                    <span className={styles['ordinalOwnership']}>
                      {review.ordinalAction.destination.ownership === 'wallet'
                        ? t('ordinal.review.owned')
                        : t('ordinal.review.external')}
                    </span>
                  </div>
                  <div>
                    <dt>{t('ordinal.review.postage')}</dt>
                    <dd>{BigInt(review.ordinalAction.postageSats).toLocaleString(lang)} sats</dd>
                  </div>
                  <div>
                    <dt>{t('send.review.fee')}</dt>
                    <dd>{BigInt(review.ordinalAction.feeSats).toLocaleString(lang)} sats</dd>
                  </div>
                  <div>
                    <dt>{t('send.review.total')}</dt>
                    <dd>{BigInt(review.totalSats).toLocaleString(lang)} sats</dd>
                  </div>
                  <div>
                    <dt>{t('ordinal.review.returned')}</dt>
                    <dd>{BigInt(review.ordinalAction.returnedBtcSats).toLocaleString(lang)} sats</dd>
                  </div>
                </dl>
                {review.ordinalAction.retainedInscriptionIds.length > 0 ? (
                  <p className={styles['retainedNotice']}>
                    {t('ordinal.review.retainedCount', {
                      count: review.ordinalAction.retainedInscriptionIds.length,
                    })}
                  </p>
                ) : null}
                <details className={styles['ordinalTechnicalDetails']}>
                  <summary>{t('send.review.details')}</summary>
                  <dl className={styles['details']}>
                    <div>
                      <dt>{t('ordinal.review.inscription')}</dt>
                      <dd>{review.ordinalAction.inscriptionId ?? t('ordinal.review.none')}</dd>
                    </div>
                    <div>
                      <dt>{t('ordinal.review.source')}</dt>
                      <dd>{review.ordinalAction.protectedSource.txid}:{review.ordinalAction.protectedSource.vout}</dd>
                    </div>
                    <div>
                      <dt>{t('ordinal.review.funding')}</dt>
                      <dd>{review.ordinalAction.fundingInputs.length === 0
                        ? t('ordinal.review.none')
                        : review.ordinalAction.fundingInputs.map((input) =>
                            `${input.txid}:${input.vout} (${BigInt(input.valueSats).toLocaleString(lang)} sats)`,
                          ).join(', ')}</dd>
                    </div>
                    <div>
                      <dt>{t('ordinal.review.retained')}</dt>
                      <dd>{review.ordinalAction.retainedInscriptionIds.length === 0
                        ? t('ordinal.review.none')
                        : review.ordinalAction.retainedInscriptionIds.join(', ')}</dd>
                    </div>
                    <div>
                      <dt>{t('send.review.rate')}</dt>
                      <dd>{displaySatPerVb(review.feeRateSatPerKvB)} sat/vB</dd>
                    </div>
                    <div>
                      <dt>{t('send.review.inputs')}</dt>
                      <dd>{review.inputs.length}</dd>
                    </div>
                  </dl>
                  <p>{t('send.review.psbt')}</p>
                  <code className={styles['code']}>{review.psbtHash}</code>
                  {review.inputs.map((input) => (
                    <code className={styles['code']} key={`${input.txid}:${input.vout}`}>
                      {input.txid}:{input.vout} · {input.path} · {input.classification}
                    </code>
                  ))}
                </details>
              </>
            ) : (
              <>
                <dl className={styles['details']}>
                  <div><dt>{t('send.review.amount')}</dt><dd>{BigInt(review.amountSats).toLocaleString(lang)} sats</dd></div>
                  <div><dt>{t('send.review.fee')}</dt><dd>{BigInt(review.feeSats).toLocaleString(lang)} sats</dd></div>
                  <div><dt>{t('send.review.total')}</dt><dd>{BigInt(review.totalSats).toLocaleString(lang)} sats</dd></div>
                  <div><dt>{t('send.review.rate')}</dt><dd>{displaySatPerVb(review.feeRateSatPerKvB)} sat/vB</dd></div>
                  <div><dt>{t('send.review.inputs')}</dt><dd>{review.inputs.length}</dd></div>
                </dl>
                {paymentRequestLabel !== '' || paymentRequestMessage !== '' ? (
                  <div className={styles['advisory']} role="note">
                    <strong>{t('send.paymentInstruction.reviewMetadata')}</strong>
                    <dl className={styles['details']}>
                      {paymentRequestLabel !== '' ? (
                        <div>
                          <dt>{t('send.paymentInstruction.label')}</dt>
                          <dd>{paymentRequestLabel}</dd>
                        </div>
                      ) : null}
                      {paymentRequestMessage !== '' ? (
                        <div>
                          <dt>{t('send.paymentInstruction.message')}</dt>
                          <dd>{paymentRequestMessage}</dd>
                        </div>
                      ) : null}
                    </dl>
                    <p>{t('send.paymentInstruction.metadataLocal')}</p>
                  </div>
                ) : null}
                {review.recipients.map((output, index) => (
                  <div className={styles['output']} key={`${output.address}:${index}`}>
                    <span>{output.address}</span>
                    <strong>{BigInt(output.valueSats).toLocaleString(lang)} sats</strong>
                  </div>
                ))}
                <details>
                  <summary>{t('send.review.details')}</summary>
                  <p>{t('send.review.psbt')}</p>
                  <code className={styles['code']}>{review.psbtHash}</code>
                  {review.inputs.map((input) => (
                    <code className={styles['code']} key={`${input.txid}:${input.vout}`}>
                      {input.txid}:{input.vout} · {input.path} · {input.classification}
                    </code>
                  ))}
                </details>
              </>
            )}
            {review.requiresReauth ? (
              <div className={styles['warning']}>
                <strong>{t('send.review.reauth')}</strong>
                <ul>
                  {review.reauthReasons.map((reason) => (
                    <li key={reason}>{t(reason === 'high_security_mode'
                      ? 'send.review.reauth.highSecurity'
                      : reason === 'high_absolute_fee'
                        ? 'send.review.reauth.highAbsoluteFee'
                        : 'send.review.reauth.highRelativeFee')}</li>
                  ))}
                </ul>
                <Field label={t('send.password')} type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
              </div>
            ) : null}
            {review.ordinalAction !== null &&
            review.ordinalAction.action !== 'manage_postage' &&
            review.ordinalAction.requiresNonTaprootAcknowledgement ? (
              <label className={styles['warning']}>
                <input
                  type="checkbox"
                  checked={nonTaprootDestinationAcknowledged}
                  onChange={(event) =>
                    setNonTaprootDestinationAcknowledged(event.target.checked)}
                />
                {t('ordinal.review.nonTaprootWarning')}
              </label>
            ) : null}
            {!props.capabilities.canSignTransactions ? (
              <p className={styles['advisory']} role="note">{t('send.watchOnlyReview')}</p>
            ) : null}
            <div className={styles['row']}>
              <Button variant="secondary" onClick={() => void cancelPlan()} disabled={busy}>{t('common.cancel')}</Button>
              {props.capabilities.canSignTransactions ? (
              <Button onClick={() => void approve()} disabled={!props.capabilities.canSignPsbt || busy ||
                !inscriptionReviewValid || (requiresPreviewAcknowledgement && !previewUnavailableAcknowledged) ||
                (review.ordinalAction !== null &&
                  review.ordinalAction.action !== 'manage_postage' &&
                  review.ordinalAction.requiresNonTaprootAcknowledgement &&
                  !nonTaprootDestinationAcknowledged) ||
                (review.requiresReauth && password === '')}>{review.kind === 'ordinal_transfer'
                  ? t('ordinal.approve.transfer')
                  : review.kind === 'ordinal_batch_transfer'
                    ? t('ordinal.approve.batch', {
                        count: review.ordinalAction?.action === 'batch_transfer'
                          ? review.ordinalAction.inscriptionCount
                          : 0,
                      })
                  : review.kind === 'ordinal_postage_manage'
                    ? t('ordinal.postage.approve')
                  : review.kind === 'rescue'
                    ? t('ordinal.approve.rescue')
                    : review.kind === 'ordinal_sweep'
                      ? t('ordinal.approve.sweep')
                    : review.kind === 'rbf' || review.kind === 'cpfp'
                      ? t('send.approve.speedUp')
                      : t('send.approve')}</Button>
              ) : null}
            </div>
          </section>
        ) : ordinalDraft ? (
          <form className={styles['section']} onSubmit={submitOrdinal}>
            <h1 className={styles['title']}>{ordinalDraft.kind === 'ordinal_transfer'
              ? t('ordinal.composer.transfer.title')
              : ordinalDraft.kind === 'ordinal_batch_transfer'
                ? t('ordinal.composer.batch.title', { count: ordinalDraft.selections.length })
              : ordinalDraft.kind === 'ordinal_postage_manage'
                ? t('ordinal.postage.title')
              : ordinalDraft.kind === 'rescue'
                ? t('ordinal.composer.rescue.title')
                : t('ordinal.composer.sweep.title')}</h1>
            {ordinalDraft.kind === 'ordinal_transfer' ||
            ordinalDraft.kind === 'ordinal_batch_transfer' ||
            ordinalDraft.kind === 'ordinal_postage_manage' ? null : (
              <p>{ordinalDraft.kind === 'rescue'
                ? t('ordinal.composer.rescue.body')
                : t('ordinal.composer.sweep.body')}</p>
            )}
            {ordinalDraft.kind === 'ordinal_transfer' ? (
              <div className={styles['ordinalDraftSummary']}>
                <OrdinalDraftPreview
                  inscriptionId={ordinalDraft.inscriptionId}
                  presentation={ordinalDraft.presentation}
                />
                <div className={styles['ordinalDraftSummaryCopy']}>
                  <span>{t('ordinal.composer.sending')}</span>
                  <strong>{ordinalDraft.presentation?.number === null ||
                    ordinalDraft.presentation?.number === undefined
                    ? t('gallery.unnumbered')
                    : `#${ordinalDraft.presentation.number}`}</strong>
                </div>
              </div>
            ) : ordinalDraft.kind === 'ordinal_batch_transfer' ? (
              <div className={styles['ordinalBatchDraftSummary']}>
                <div className={styles['ordinalBatchDraftPreviews']}>
                  {ordinalDraft.selections.slice(0, 4).map((selection) => (
                    <OrdinalDraftPreview
                      inscriptionId={selection.inscriptionId}
                      key={selection.inscriptionId}
                      presentation={selection.presentation}
                    />
                  ))}
                </div>
                <strong>{t('ordinal.composer.batch.sending', {
                  count: ordinalDraft.selections.length,
                })}</strong>
              </div>
            ) : ordinalDraft.kind === 'ordinal_postage_manage' ? (
              <div className={`${styles['advisory']} ${styles['postageAdvisory']}`} role="note">
                <p>{t('ordinal.postage.body')}</p>
                <strong>{utxos === null
                  ? t('ordinal.postage.currentLoading')
                  : currentPostageSats === null
                    ? t('ordinal.postage.currentUnavailable')
                    : t('ordinal.postage.currentValue', {
                        amount: BigInt(currentPostageSats).toLocaleString(lang),
                      })}</strong>
              </div>
            ) : null}
            <details className={styles['ordinalTechnicalDetails']}>
              <summary>{t('ordinal.composer.technical')}</summary>
              {ordinalDraft.kind === 'ordinal_batch_transfer' ? ordinalDraft.selections.map(
                (selection) => (
                  <div className={styles['ordinalBatchDraftItem']} key={selection.inscriptionId}>
                    <code className={styles['code']}>{selection.inscriptionId}</code>
                    <code className={styles['code']}>{selection.satpoint}</code>
                    <code className={styles['code']}>
                      {selection.outpoint.txid}:{selection.outpoint.vout}
                    </code>
                  </div>
                ),
              ) : ordinalDraft.kind === 'ordinal_postage_manage' ? (
                <div>
                  <strong>{t('ordinal.composer.inscriptionId')}</strong>
                  <code className={styles['code']}>{ordinalDraft.selection.inscriptionId}</code>
                </div>
              ) : 'inscriptionId' in ordinalDraft ? (
                <div>
                  <strong>{t('ordinal.composer.inscriptionId')}</strong>
                  <p>{t('ordinal.composer.inscriptionId.help')}</p>
                  <code className={styles['code']}>{ordinalDraft.inscriptionId}</code>
                </div>
              ) : null}
              {ordinalDraft.kind === 'ordinal_batch_transfer' ? null : <div>
                <strong>{t('ordinal.composer.currentOutput')}</strong>
                <p>{t('ordinal.composer.currentOutput.help')}</p>
                <code className={styles['code']}>
                  {ordinalDraft.kind === 'ordinal_postage_manage'
                    ? `${ordinalDraft.selection.outpoint.txid}:${ordinalDraft.selection.outpoint.vout}`
                    : `${ordinalDraft.outpoint.txid}:${ordinalDraft.outpoint.vout}`}
                </code>
              </div>}
            </details>
            {ordinalDraft.kind === 'ordinal_transfer' ||
            ordinalDraft.kind === 'ordinal_batch_transfer' ? (
              <>
                <Field
                  label={t('send.recipient')}
                  value={recipient}
                  onChange={(event) => setRecipient(event.target.value.trim())}
                  autoComplete="off"
                />
                {recipientPicker()}
              </>
            ) : null}
            {ordinalDraft.kind === 'ordinal_postage_manage' ? (
              <fieldset className={styles['fieldset']}>
                <legend>{t('ordinal.postage.amount')}</legend>
                {([
                  ['common_546', 'ordinal.postage.common546'],
                  ['compatible_10000', 'ordinal.postage.compatible10000'],
                  ['minimum_standard', 'ordinal.postage.minimum'],
                  ['custom', 'ordinal.postage.custom'],
                ] as const).map(([value, key]) => (
                  <label className={styles['feeOption']} key={value}>
                    <input
                      type="radio"
                      checked={postageTarget === value}
                      onChange={() => setPostageTarget(value)}
                    />
                    <span className={styles['feeOptionCopy']}><strong>{t(key)}</strong></span>
                  </label>
                ))}
                {postageTarget === 'custom' ? (
                  <Field
                    label={t('ordinal.postage.customAmount')}
                    inputMode="numeric"
                    value={customPostageSats}
                    onChange={(event) => {
                      const next = event.target.value.trim();
                      if (/^\d*$/u.test(next)) setCustomPostageSats(next);
                    }}
                  />
                ) : null}
              </fieldset>
            ) : null}
            {feeChooser}
            <Button
              type="submit"
              disabled={!props.capabilities.canBuildUnsignedPsbt || busy || !feeSelectionReady ||
                ((ordinalDraft.kind === 'ordinal_transfer' ||
                  ordinalDraft.kind === 'ordinal_batch_transfer') && recipient === '') ||
                (ordinalDraft.kind === 'ordinal_postage_manage' &&
                  postageTarget === 'custom' && customPostageSats === '') ||
                (feeTier === 'custom' && !customFeeValid)}
            >{t('send.review')}</Button>
          </form>
        ) : (
          <form className={styles['section']} onSubmit={submitSend}>
            <h1 className={styles['title']}>{t('send.title')}</h1>
            <label>
              {t('send.account')}{' '}
              {Number(account) + 1}
            </label>
            <Field
              label={t('send.recipient.paymentInstruction')}
              value={recipient}
              maxLength={8 * 1024}
              onChange={(event) => changeRecipientManually(event.target.value)}
              onPaste={(event) => void pastePaymentInstruction(event)}
              autoComplete="off"
            />
            {paymentImportBusy ? (
              <p className={styles['advisory']} role="status">
                {t('send.paymentInstruction.resolving')}
              </p>
            ) : null}
            {recipientPicker()}
            {paymentRequestLabel !== '' || paymentRequestMessage !== '' ? (
              <div className={styles['advisory']} role="note">
                <strong>{t('send.paymentInstruction.reviewMetadata')}</strong>
                <dl className={styles['details']}>
                  {paymentRequestLabel !== '' ? (
                    <div>
                      <dt>{t('send.paymentInstruction.label')}</dt>
                      <dd>{paymentRequestLabel}</dd>
                    </div>
                  ) : null}
                  {paymentRequestMessage !== '' ? (
                    <div>
                      <dt>{t('send.paymentInstruction.message')}</dt>
                      <dd>{paymentRequestMessage}</dd>
                    </div>
                  ) : null}
                </dl>
                <p>{t('send.paymentInstruction.metadataLocal')}</p>
              </div>
            ) : null}
            <div className={styles['amountField']}>
              <Field
                label={t('send.amount', { unit: sendUnit === 'btc' ? 'BTC' : 'sats' })}
                inputMode="decimal"
                value={amount}
                disabled={sendMax}
                onChange={(event) => {
                  const next = event.target.value.trim();
                  if (
                    sendUnit === 'sats'
                      ? /^\d*$/u.test(next)
                      : /^\d*(?:\.\d{0,8})?$/u.test(next)
                  ) {
                    setAmount(next);
                  }
                }}
              />
              <span
                className={styles['amountUnits']}
                role="radiogroup"
                aria-label={t('send.units')}
              >
                {SEND_UNITS.map((unit) => (
                  <button
                    key={unit}
                    type="button"
                    role="radio"
                    aria-checked={sendUnit === unit}
                    tabIndex={sendUnit === unit ? 0 : -1}
                    disabled={sendMax}
                    onClick={() => changeSendUnit(unit)}
                    onKeyDown={(event) => {
                      handleRadioKey(event, SEND_UNITS, sendUnit, changeSendUnit);
                    }}
                  >
                    {unit === 'btc' ? 'BTC' : 'sats'}
                  </button>
                ))}
              </span>
            </div>
            {importedSuggestions.amountSats !== undefined ? (
              <div className={styles['advisory']} role="note">
                <p>{t('send.paymentInstruction.requestedAmount', {
                  amount: sendUnit === 'btc'
                    ? `${satsToBtcDecimal(BigInt(importedSuggestions.amountSats))} BTC`
                    : `${importedSuggestions.amountSats} sats`,
                })}</p>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    const requested = importedSuggestions.amountSats;
                    if (requested === undefined) return;
                    setSendMax(false);
                    setAmount(sendUnit === 'btc'
                      ? satsToBtcDecimal(BigInt(requested))
                      : requested);
                    setImportedSuggestions((current) =>
                      withoutImportedSuggestion(current, 'amountSats'));
                  }}
                >
                  {t('send.paymentInstruction.useRequestValue')}
                </Button>
              </div>
            ) : null}
            {additionalRecipients.length > 0 ? (
              <div className={styles['batchRecipients']}>
                <p className={styles['advisory']} role="note">
                  {t('send.batch.privacy')}
                </p>
                {additionalRecipients.map((entry, index) => (
                  <fieldset className={styles['batchRecipient']} key={entry.id}>
                    <legend>{t('send.batch.recipient', { number: index + 2 })}</legend>
                    <Field
                      ref={(element) => {
                        if (element === null) batchAddressInputs.current.delete(entry.id);
                        else batchAddressInputs.current.set(entry.id, element);
                      }}
                      label={t('send.recipient')}
                      value={entry.address}
                      onChange={(event) => changeAdditionalRecipient(
                        entry.id, 'address', event.target.value.trim(),
                      )}
                      autoComplete="off"
                    />
                    {recipientPicker(entry.id)}
                    <Field
                      label={t('send.amount', { unit: sendUnit === 'btc' ? 'BTC' : 'sats' })}
                      inputMode="decimal"
                      value={entry.amount}
                      onChange={(event) => {
                        const next = event.target.value.trim();
                        if (sendUnit === 'sats'
                          ? /^\d*$/u.test(next)
                          : /^\d*(?:\.\d{0,8})?$/u.test(next)) {
                          changeAdditionalRecipient(entry.id, 'amount', next);
                        }
                      }}
                    />
                    <Button type="button" variant="ghost" onClick={() => removeRecipient(entry.id)}>
                      {t('send.batch.remove')}
                    </Button>
                  </fieldset>
                ))}
              </div>
            ) : null}
            <div className={styles['row']}>
              <Button
                ref={addRecipientButton}
                type="button"
                variant="secondary"
                disabled={additionalRecipients.length + 1 >= MAX_NATIVE_BATCH_RECIPIENTS}
                onClick={addRecipient}
              >
                {t('send.batch.add')}
              </Button>
              {additionalRecipients.length === 0 ? (
                <label>
                  <input
                    type="checkbox"
                    checked={sendMax}
                    onChange={(event) => setSendMax(event.target.checked)}
                  />{' '}
                  {t('send.max')}
                </label>
              ) : null}
            </div>
            {selected.size > 0 ? <p className={styles['success']}>{t('send.manualInputs', { count: selected.size })}</p> : null}
            {feeChooser}
            <Button type="submit" disabled={!props.capabilities.canBuildUnsignedPsbt || busy || !feeSelectionReady || recipient === '' || (!sendMax && validAmountSats === null) || !batchRecipientsReady || (feeTier === 'custom' && !customFeeValid)}>{t('send.review')}</Button>
          </form>
        )
      ) : null}

      {props.initialSection === 'utxos' ? (
        <ManageUtxos
          utxos={utxos}
          account={accountIndex}
          privacyNotes={privacyNotes}
          selected={selected}
          onSelectedChange={setSelected}
          lang={lang}
          busy={busy}
          expectation={{ expectedVaultId, expectedSessionId }}
          accountId={props.accountId}
          feeChooser={feeChooser}
          consolidationSuggestionEnabled={feeTier === 'economy' && quote !== null}
          onRefresh={() => {
            retryFailedInscriptionThumbnails(inscriptionPreviewScope);
            void loadUtxos();
          }}
          onConsolidate={consolidate}
          onConsolidateSuggested={(coins) => {
            const next = new Set(coins.map((coin) => `${coin.txid}:${coin.vout}`));
            setSelected(next);
            void planIntent({
              kind: 'consolidation',
              account: Number(account),
              selectedOutpoints: coins.map((coin) => ({ txid: coin.txid, vout: coin.vout })),
            });
          }}
          onFreeze={(utxo) => void freeze(utxo)}
          onSetLabel={setLabel}
          onRescue={(utxo) => void planIntent({
            kind: 'rescue', outpoint: { txid: utxo.txid, vout: utxo.vout },
          })}
          onSweep={(utxo) => void planIntent({
            kind: 'ordinal_sweep', outpoint: { txid: utxo.txid, vout: utxo.vout },
          })}
        />
      ) : null}

      {props.initialSection === 'activity' ? (
        <ActivitySection
          expectation={{ expectedVaultId, expectedSessionId }}
          accountId={props.accountId}
          activity={accountActivity.items}
          transactions={transactions}
          network={transactionNetwork}
          loadState={accountActivity.loadState}
          hasMore={accountActivity.hasMore}
          loadingOlder={accountActivity.loadingOlder}
          pageError={accountActivity.pageError}
          updated={accountActivity.updated}
          historyComplete={accountActivity.historyComplete}
          onLoadOlder={accountActivity.loadOlder}
          onRefresh={() => {
            accountActivity.refresh();
            void loadTransactions();
            void requestLiveScan();
          }}
          onAccelerate={(strategy, txid) => {
            void accelerate(strategy, txid);
          }}
        />
      ) : null}
    </div>
  );
}
