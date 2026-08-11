import { useEffect, useId, useState, type ReactNode } from 'react';
import { parseSats, satsToBtcDecimal } from '@drey/core/domain/sats';
import { formatUsdFromSats } from '@drey/core/domain/fiat';
import { isGatewaySyncing, type GatewayStatusView } from '@drey/core/domain/gateway/status-view';
import type { WalletHomeResult } from '@drey/core/messaging/ops';
import { useI18n, type I18n } from '../../ui/i18n';
import { useWalletHome } from '../../ui/hooks/use-wallet-home';
import { GATEWAY_TRANSIENT_GRACE_MS } from '../../ui/hooks/use-gateway-status';
import { useFiatPrice } from '../../ui/hooks/use-fiat-price';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import { Button } from '../../ui/components/Button';
import { AmountUnitToggle } from '../../ui/components/AmountUnitToggle';
import { useActivityUnit, usePortfolioPrivacy } from '../../ui/UiRoot';
import { ActivityList } from './ActivityList';
import { HomeCollectibles } from './HomeCollectibles';
import { PopupIcon } from './PopupIcon';
import { QuickAddresses } from './QuickAddresses';
import styles from './popup.module.css';

/**
 * §10.2 degraded-status slot. Standard mode names exactly which protections
 * are absent (§11.3); stale/unreachable/read-only get their own one-liners.
 * §10.4: text carries the state, never color alone.
 */
function degradedGatewayBanner(view: GatewayStatusView, t: I18n['t']): string {
  const missing = [
    view.missingProtections.some((c) => c === 'sat_index' || c === 'rarity')
      ? t('gateway.protection.rareSats')
      : null,
    view.missingProtections.some(
      (c) => c === 'rune_detection' || c === 'unsupported_asset_detection',
    )
      ? t('gateway.protection.runes')
      : null,
  ]
    .filter((s): s is string => s !== null)
    .join(' · ');
  return t('gateway.banner.degraded', { missing });
}

function gatewayBanner(view: GatewayStatusView | null, t: I18n['t']): string | null {
  if (view === null) return null;
  // Routine convergence is presented compactly inside the balance card. An
  // existing Standard-mode protection warning remains higher priority.
  if (isGatewaySyncing(view)) {
    return view.mode === 'standard_ordinals_safety'
      ? degradedGatewayBanner(view, t)
      : null;
  }
  switch (view.state) {
    case 'degraded':
      return degradedGatewayBanner(view, t);
    case 'stale':
      return t('gateway.banner.stale');
    case 'unreachable':
      return t('gateway.banner.unreachable');
    case 'read_only':
      return t('gateway.banner.readOnly');
    case 'connected':
      return null;
  }
}

/** §11.4: the four non-fresh gating states get DISTINCT wording. */
function gatingBanner(
  home: WalletHomeResult | null,
  t: I18n['t'],
): string | null {
  switch (home?.dataGating.state) {
    case 'backend_unreachable':
      return t('gating.backendUnreachable');
    case 'backend_read_only':
      return t('gating.backendReadOnly');
    case 'index_lag':
      return null;
    case 'reorg_reconciliation':
      return t('gating.reorg');
    case 'conflicting_sources':
      return home.scan.kind === 'running'
        ? t('gating.conflictingRetrying')
        : t('gating.conflicting');
    default:
      return null;
  }
}

/** §10.2 active-account home over real scanned balances (M6). */
export function Home(props: {
  gateway: GatewayStatusView | null;
  expectation: ActiveSessionExpectation;
  activeAccountId: string;
  onReceive: () => void;
  onSend?: () => void;
  onManageUtxos?: () => void;
  onViewOrdinals?: () => void;
  onOpenCollectible?: (inscriptionId: string) => void;
  continuous?: boolean;
}): ReactNode {
  const { t, lang } = useI18n();
  const { activityUnit } = useActivityUnit();
  const { amountsHidden, saveFailed, setAmountsHidden } = usePortfolioPrivacy();
  const [protectionExpanded, setProtectionExpanded] = useState(false);
  const [showTransientIndexLag, setShowTransientIndexLag] = useState(false);
  const [showSendSyncNotice, setShowSendSyncNotice] = useState(false);
  const protectionDetailsId = useId();
  const { home, status, refresh } = useWalletHome(
    props.expectation,
    props.activeAccountId,
    { continuous: props.continuous ?? true },
  );
  const fiat = useFiatPrice(props.gateway?.network === 'mainnet');
  useEffect(() => {
    if (home?.dataGating.state !== 'index_lag') {
      setShowTransientIndexLag(false);
      return undefined;
    }
    const timer = setTimeout(
      () => setShowTransientIndexLag(true),
      GATEWAY_TRANSIENT_GRACE_MS,
    );
    return () => clearTimeout(timer);
  }, [home?.dataGating.state]);
  const homeGatingState = home?.dataGating.state ?? null;
  useEffect(() => {
    if (homeGatingState !== 'index_lag') setShowSendSyncNotice(false);
  }, [homeGatingState]);
  // Data gating (§11.4) outranks the capability banner: showing both would
  // bury the one that blocks actions.
  const banner = gatingBanner(home, t) ?? gatewayBanner(props.gateway, t);
  const showSyncing =
    banner === null &&
    (showTransientIndexLag ||
      (props.gateway !== null && isGatewaySyncing(props.gateway)));

  const available = home === null ? null : parseSats(home.balances.availableSats);
  const unavailableClean =
    home === null ? null : parseSats(home.balances.unavailableCleanSats);
  const protectedSats =
    home === null
      ? null
      : parseSats(home.balances.protectedSats) + parseSats(home.balances.frozenSats) +
        parseSats(home.balances.reservedSats);
  const pending = home === null ? null : parseSats(home.balances.pendingSats);
  const pendingOrdinal =
    home === null ? null : parseSats(home.balances.pendingOrdinalSats ?? '0');
  const pendingPayment =
    pending === null || pendingOrdinal === null || pendingOrdinal > pending
      ? pending
      : pending - pendingOrdinal;
  const bitcoinBalance =
    available === null || unavailableClean === null || pendingPayment === null
      ? null
      : available + unavailableClean + pendingPayment;
  const formatAmount = (value: bigint): string =>
    amountsHidden
      ? t('privacy.amountHidden')
      : activityUnit === 'btc'
      ? `${satsToBtcDecimal(value)} BTC`
      : `${value.toLocaleString(lang)} sats`;
  const formatAlternateAmount = (value: bigint): string =>
    amountsHidden
      ? t('privacy.amountHidden')
      : activityUnit === 'btc'
      ? `${value.toLocaleString(lang)} sats`
      : `${satsToBtcDecimal(value)} BTC`;
  const formattedFiat = !amountsHidden && bitcoinBalance !== null && fiat.quote !== null
    ? formatUsdFromSats(bitcoinBalance, fiat.quote.priceUsdCentsPerBtc, lang)
    : null;
  const alternateAmountLabel =
    bitcoinBalance === null || amountsHidden ? null : formatAlternateAmount(bitcoinBalance);
  const protectionDetails: string[] = [];
  if (home !== null) {
    const asset = parseSats(home.protectionBreakdown.assetSats);
    const awaiting = parseSats(home.protectionBreakdown.awaitingClassificationSats);
    const frozen = parseSats(home.protectionBreakdown.userFrozenSats);
    const dust = parseSats(home.protectionBreakdown.dustQuarantinedSats);
    const reservedSats = parseSats(home.balances.reservedSats);
    if (asset > 0n) {
      protectionDetails.push(t('home.protected.asset', { amount: formatAmount(asset) }));
    }
    if (awaiting > 0n) {
      protectionDetails.push(
        t('home.protected.awaiting', { amount: formatAmount(awaiting) }),
      );
    }
    if (frozen > 0n) {
      protectionDetails.push(t('home.protected.frozen', { amount: formatAmount(frozen) }));
    }
    if (dust > 0n) {
      protectionDetails.push(t('home.protected.dust', { amount: formatAmount(dust) }));
    }
    if (reservedSats > 0n) {
      protectionDetails.push(t('home.protected.reserved', { amount: formatAmount(reservedSats) }));
    }
  }

  return (
    <>
      {banner !== null ? (
        <p role="status" className={styles['statusBanner']}>
          {banner}
        </p>
      ) : null}
      {saveFailed ? (
        <p role="status" className={styles['statusBanner']}>
          {t('privacy.saveFailed')}
        </p>
      ) : null}

      <div className={styles['balanceCard']} data-testid="balance-card">
        <span className={styles['balanceLabel']}>{t('home.balance')}</span>
        <Button
          variant="ghost"
          className={styles['balancePrivacyButton']}
          aria-label={t(amountsHidden ? 'privacy.showBalances' : 'privacy.hideBalances')}
          aria-pressed={amountsHidden}
          title={t(amountsHidden ? 'privacy.showBalances' : 'privacy.hideBalances')}
          onClick={() => setAmountsHidden(!amountsHidden)}
        >
          <PopupIcon name={amountsHidden ? 'eye' : 'eyeOff'} />
        </Button>
        <span
          className={styles['balanceValue']}
          title={amountsHidden ? undefined : alternateAmountLabel ?? undefined}
        >
          {bitcoinBalance === null ? '—' : formatAmount(bitcoinBalance)}
        </span>
        <div className={styles['balanceMeta']} data-testid="balance-meta">
          <span className={styles['balanceSats']}>
            {amountsHidden
              ? t('privacy.amountHidden')
              : formattedFiat !== null
              ? fiat.stale
                ? t('home.usdStale', {
                    amount: `≈ ${formattedFiat}`,
                    minutes: Math.max(1, fiat.ageMinutes),
                  })
                : `≈ ${formattedFiat} USD`
              : alternateAmountLabel !== null
                ? alternateAmountLabel
              : status === 'error'
                ? t('home.balanceUnavailable')
                : t('common.loading')}
          </span>
          {showSyncing ? (
            <span
              className={styles['balanceSyncStatus']}
              role="status"
              aria-label={t('gateway.banner.syncing')}
              title={t('gateway.banner.syncing')}
            >
              <span className={styles['balanceSyncDot']} aria-hidden="true" />
              {t('gateway.state.syncing')}
            </span>
          ) : null}
        </div>
        {status === 'error' && home === null ? (
          <Button variant="secondary" onClick={refresh}>
            {t('common.retry')}
          </Button>
        ) : null}
        <QuickAddresses
          expectation={props.expectation}
          activeAccountId={props.activeAccountId}
        />
      </div>

      {pendingPayment !== null && pendingPayment > 0n ? (
        <>
          <div className={styles['protectedRow']}>
            <span>{t('home.available')}</span>
            <span>{available === null ? '—' : formatAmount(available)}</span>
          </div>
          <div className={styles['protectedRow']}>
            <div className={styles['summaryLabel']}>
              <span>{t('home.pending')}</span>
              <small>{t('home.pending.hint')}</small>
            </div>
            <span>{formatAmount(pendingPayment)}</span>
          </div>
        </>
      ) : null}

      {protectedSats !== null && protectedSats > 0n ? (
        <div className={styles['protectedDisclosure']}>
          {/* §10.2: protected sats stay separate without occupying permanent detail space. */}
          <button
            type="button"
            className={styles['protectedRow']}
            aria-expanded={protectionExpanded}
            aria-controls={protectionDetailsId}
            aria-label={t('home.protected.toggle', { amount: formatAmount(protectedSats) })}
            title={t('home.protected.hint')}
            onClick={() => setProtectionExpanded((expanded) => !expanded)}
          >
            <span>{t('home.protected')}</span>
            <span className={styles['protectedValue']}>
              <span>{formatAmount(protectedSats)}</span>
              <span className={styles['protectedChevron']} aria-hidden="true">⌄</span>
            </span>
          </button>
          {protectionExpanded ? (
            <div id={protectionDetailsId} className={styles['protectedDetails']}>
              {protectionDetails.map((detail, index) => (
                <p key={index} className={styles['protectedDetail']}>
                  {detail}
                </p>
              ))}
              <Button variant="secondary" onClick={props.onManageUtxos}>
                {t('home.protected.review')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className={styles['protectedRow']} title={t('home.protected.hint')}>
          <span>{t('home.protected')}</span>
          <span>{protectedSats === null ? '—' : formatAmount(protectedSats)}</span>
        </div>
      )}

      {home !== null && home.wrongLaneCount > 0 ? (
        <p role="alert" className={styles['statusBanner']}>
          {t(home.wrongLaneCount === 1 ? 'home.wrongLaneOne' : 'home.wrongLane', {
            count: home.wrongLaneCount,
          })}{' '}
          <button
            type="button"
            className={styles['statusBannerAction']}
            onClick={props.onManageUtxos}
          >
            {t('home.wrongLane.review')}
          </button>
        </p>
      ) : null}

      {pendingOrdinal !== null && pendingOrdinal > 0n ? (
        <div className={styles['protectedRow']}>
          <div className={styles['summaryLabel']}>
            <span>
              {t((home?.pendingOrdinalCount ?? 0) === 1
                ? 'home.pendingOrdinal'
                : 'home.pendingOrdinals')}
            </span>
            <small>{t('home.pendingOrdinal.hint')}</small>
          </div>
          <span>{formatAmount(pendingOrdinal)}</span>
        </div>
      ) : null}

      <div className={styles['actionsRow']}>
        <Button
          variant="secondary"
          onClick={() => {
            if (homeGatingState === 'index_lag') {
              setShowSendSyncNotice(true);
              return;
            }
            props.onSend?.();
          }}
        >
          {t('home.send')}
        </Button>
        <Button onClick={props.onReceive}>{t('home.receive')}</Button>
      </div>
      {showSendSyncNotice ? (
        <p role="status" className={styles['muted']}>
          {t('home.send.syncing')}
        </p>
      ) : null}

      {home === null ? null : (
        <HomeCollectibles
          accountId={props.activeAccountId}
          activity={home.activity}
          count={home.collectiblesCount}
          expectation={props.expectation}
          onOpen={props.onOpenCollectible ?? props.onViewOrdinals ?? (() => undefined)}
          onViewAll={props.onViewOrdinals ?? (() => undefined)}
        />
      )}

      <div>
        <div className={styles['sectionHeading']}>
          <h2 className={styles['sectionTitle']}>{t('home.recentActivity')}</h2>
          <AmountUnitToggle />
        </div>
        <ActivityList
          activity={home?.activity ?? []}
          accountId={props.activeAccountId}
          compact
          expectation={props.expectation}
          network={props.gateway?.network ?? null}
        />
      </div>
    </>
  );
}
