import type { WalletHomeResult } from '@drey/core/messaging/ops';
import {
  formatDetectedAssetAmount,
  type DetectedAsset,
} from '@drey/core/domain/gateway/contract';
import type { useI18n } from '../i18n';

export type ActivityItem = WalletHomeResult['activity'][number];
type ActivityT = ReturnType<typeof useI18n>['t'];
type ActivityLang = ReturnType<typeof useI18n>['lang'];
type DetectedActivityItem = ActivityItem & {
  detectedAssets?: DetectedAsset[];
  detectedAssetCount?: number;
  assetIdentityComplete?: boolean;
};

export const HOME_ACTIVITY_LIMIT = 5;

export interface ActivityPresentation {
  description: string;
  state: string;
  identity: string | null;
  identityTitle: string | undefined;
  amount: string | null;
  fee: string | null;
  incoming: boolean;
  inscription: boolean;
  dateKey: string;
  dateLabel: string;
  dateTimeLabel: string;
}

export interface ActivityGroup {
  key: string;
  label: string;
  items: ActivityItem[];
}

function shortInscriptionId(inscriptionId: string): string {
  return `${inscriptionId.slice(0, 8)}…${inscriptionId.slice(-8)}`;
}

function shortAddress(address: string): string {
  if (address.length <= 18) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function runeIdentity(item: DetectedActivityItem, t: ActivityT): string | null {
  const asset = item.detectedAssets?.[0];
  if (asset === undefined) return null;
  const identity = `${formatDetectedAssetAmount(asset)} ${asset.name}${
    asset.symbol === null ? '' : ` ${asset.symbol}`
  }`;
  const extra = Math.max(0, (item.detectedAssetCount ?? item.detectedAssets?.length ?? 1) - 1);
  if (extra === 0) return identity;
  return t(item.assetIdentityComplete === false ? 'activity.rune.partial' : 'activity.rune.more', {
    identity,
    count: extra,
  });
}

export function activityState(item: ActivityItem, t: ActivityT): string {
  if (item.confirmationState === 'confirmed') return t('activity.confirmed');
  if (item.confirmationState === 'mempool') {
    return item.pendingAsset === 'ordinal'
      ? t('activity.state.pendingOrdinal')
      : t('activity.state.mempool');
  }
  if (item.confirmationState === 'replaced') return t('activity.state.replaced');
  if (item.confirmationState === 'indeterminate') return t('activity.state.indeterminate');
  if (item.confirmationState === 'rejected') return t('activity.status.rejected');
  return t('activity.state.conflicted');
}

function activityDate(
  item: ActivityItem,
  t: ActivityT,
  lang: ActivityLang,
): Pick<ActivityPresentation, 'dateKey' | 'dateLabel' | 'dateTimeLabel'> {
  const date = item.timestamp === null ? null : new Date(item.timestamp);
  const valid = date !== null && Number.isFinite(date.getTime());
  if (!valid) {
    const pending = item.confirmationState !== 'confirmed';
    const label = t(pending ? 'activity.date.pending' : 'activity.date.unknown');
    return {
      dateKey: pending ? 'pending' : 'unknown',
      dateLabel: label,
      dateTimeLabel: label,
    };
  }
  return {
    dateKey: `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`,
    dateLabel: new Intl.DateTimeFormat(lang, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(date),
    dateTimeLabel: new Intl.DateTimeFormat(lang, {
      dateStyle: 'long',
      timeStyle: 'short',
    }).format(date),
  };
}

export function presentActivity(
  item: ActivityItem,
  t: ActivityT,
  lang: ActivityLang,
  formatAmount: (value: bigint) => string,
  compact = false,
): ActivityPresentation {
  const delta = BigInt(item.deltaSats);
  const incoming = delta >= 0n;
  const totalOutgoing = incoming ? 0n : -delta;
  const fee = item.feeSats === null ? null : BigInt(item.feeSats);
  const outgoingAmount = fee !== null && fee <= totalOutgoing ? totalOutgoing - fee : totalOutgoing;
  const selfTransfer = item.bitcoinActionKind === 'self_transfer';
  const addressContext = item.actionKind == null && !selfTransfer
    ? item.addressContext ?? null
    : null;
  const compactAddressLabel = compact && addressContext !== null
    ? t(addressContext === 'ordinals_sent'
      ? 'activity.address.ordinals.sent'
      : 'activity.address.ordinals.received')
    : null;
  const inscriptionCount = item.inscriptionCount ?? item.receivedInscriptionCount ?? 1;
  const description = selfTransfer
    ? t('activity.bitcoin.moved')
    : item.actionKind === 'ordinal_receive'
      ? t(inscriptionCount > 1
        ? 'activity.ordinal.receivedPlural'
        : 'activity.ordinal.received')
      : item.actionKind === 'ordinal_transfer'
        ? t('activity.ordinal.sent')
        : item.actionKind === 'rescue'
          ? t('activity.ordinal.rescued')
          : item.actionKind === 'ordinal_sweep'
            ? t('activity.ordinal.swept')
            : !compact && addressContext === 'ordinals_sent'
              ? t('activity.address.ordinals.sent')
              : !compact && addressContext === 'ordinals_received'
                ? t('activity.address.ordinals.received')
                : incoming
                  ? t('activity.bitcoin.received')
                  : t('activity.bitcoin.sent');
  const inscription = item.inscriptionId != null || item.actionKind === 'ordinal_receive' ||
    item.actionKind === 'ordinal_transfer' || item.actionKind === 'rescue';
  const baseOrdinalIdentity = item.inscriptionId == null
    ? null
    : item.inscriptionNumber == null
      ? t('activity.ordinal.identityId', { id: shortInscriptionId(item.inscriptionId) })
      : t('activity.ordinal.identityNumber', {
          number: item.inscriptionNumber.toLocaleString(lang),
        });
  const ordinalIdentity = baseOrdinalIdentity !== null && inscriptionCount > 1
    ? t('activity.ordinal.identityMore', {
        identity: baseOrdinalIdentity,
        count: inscriptionCount - 1,
      })
    : baseOrdinalIdentity;
  const detectedRune = runeIdentity(item as DetectedActivityItem, t);
  const detectedFallback = ((item as DetectedActivityItem).detectedAssetCount ?? 0) > 0
    ? t('activity.rune.identityUnavailable')
    : null;
  const addressDisplay = item.addressDisplay ?? null;
  const destinationLabel = addressDisplay?.kind !== 'sent_to'
    ? null
    : t('activity.address.sentTo', { address: shortAddress(addressDisplay.address) });
  const destinationTitle = addressDisplay?.kind !== 'sent_to'
    ? undefined
    : t('activity.address.sentTo', { address: addressDisplay.address });
  const source = item.transactionSource ?? null;
  const sourceLabel = !incoming
    ? null
    : source === null
      ? t('activity.source.unavailable')
      : source.inputCount === 0
        ? t('activity.source.coinbase')
        : source.inputCount === 1 && source.singleInputAddress !== null
          ? t('activity.source.single', { address: shortAddress(source.singleInputAddress) })
          : t(source.inputCount === 1 ? 'activity.source.input' : 'activity.source.inputs', {
              count: source.inputCount,
            });
  const sourceTitle = source?.singleInputAddress == null
    ? undefined
    : t('activity.source.single', { address: source.singleInputAddress });
  const transactionContext = incoming ? sourceLabel : destinationLabel;
  const transactionContextTitle = incoming ? sourceTitle : destinationTitle;
  const identity = selfTransfer
    ? t('activity.bitcoin.betweenAddresses')
    : ordinalIdentity ?? (detectedRune === null
      ? detectedFallback
      : t('activity.rune.identity', { identity: detectedRune })) ?? compactAddressLabel ??
        (addressContext === null ? transactionContext : null);
  const identityTitle = ordinalIdentity !== null
    ? item.inscriptionId ?? undefined
    : addressContext === null ? transactionContextTitle : undefined;
  const amount = selfTransfer
    ? fee === null ? null : `−${formatAmount(fee)}`
    : inscription
      ? null
      : item.actionKind === 'ordinal_sweep'
        ? t('activity.ordinal.returned', {
            amount: formatAmount(BigInt(item.returnedBtcSats ?? '0')),
          })
        : `${incoming ? '+' : '−'}${formatAmount(incoming ? delta : outgoingAmount)}`;
  const state = activityState(item, t);
  const date = activityDate(item, t, lang);
  return {
    description,
    state,
    identity,
    identityTitle,
    amount,
    fee: !incoming && fee !== null && fee > 0n
      ? t('activity.feeDisplay', { fee: formatAmount(fee) })
      : null,
    incoming,
    inscription,
    ...date,
    dateLabel: item.timestamp === null ? state : date.dateLabel,
  };
}

export function groupActivity(
  items: readonly ActivityItem[],
  t: ActivityT,
  lang: ActivityLang,
): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const item of items) {
    const date = activityDate(item, t, lang);
    const current = groups.at(-1);
    if (current?.key === date.dateKey) current.items.push(item);
    else groups.push({ key: date.dateKey, label: date.dateLabel, items: [item] });
  }
  return groups;
}
