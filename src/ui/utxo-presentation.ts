/**
 * Presentation rules for the §14.4 UTXO manager.
 *
 * This module decides how a row *reads*, never whether it may be spent.
 * Eligibility comes solely from the worker's §11.2 predicate
 * (`domain/classification/eligibility.ts`), which documents that it exports no
 * bypass. `utxoGroup` therefore branches on `utxo.eligible` first and never
 * re-derives it.
 *
 * Kept separate from the components so the copy rules — especially the
 * permanent-vs-transient distinction in `primaryReason` — are unit-testable
 * without rendering.
 */
import type { MessageKey } from './i18n/en';

/** The subset of the `utxo.list` row this module needs. */
export interface PresentableUtxo {
  txid: string;
  vout: number;
  valueSats: string;
  classification: string;
  eligible: boolean;
  reasons: readonly string[];
  wrongLane: 'normal' | 'protected_wrong_address' | 'reserved_ordinal_lane_btc';
}

export type UtxoGroupKey = 'available' | 'protected' | 'reserved' | 'unavailable';

/** Render order. `available` leads and is the only group open by default. */
export const UTXO_GROUP_ORDER: readonly UtxoGroupKey[] = [
  'available',
  'protected',
  'reserved',
  'unavailable',
];

/**
 * Classes §11.2 can never clear. A UTXO in one of these is protected forever,
 * so its row must not imply that waiting will change anything.
 */
const PROTECTED_CLASSES = new Set([
  'inscribed',
  'rare_sat',
  'runic_or_unsupported',
  'mixed',
]);

export function isProtectedClass(classification: string): boolean {
  return PROTECTED_CLASSES.has(classification);
}

export function utxoGroup(utxo: PresentableUtxo): UtxoGroupKey {
  if (utxo.eligible) return 'available';
  // §12.2 plain BTC parked in the ordinals lane: reserved as postage, not
  // broken. Checked before the class test because it is always cardinal_clean.
  if (utxo.wrongLane === 'reserved_ordinal_lane_btc') return 'reserved';
  if (isProtectedClass(utxo.classification)) return 'protected';
  return 'unavailable';
}

/**
 * Most severe reason first. The row shows exactly one: joining all of them is
 * what made the live screen unreadable, and the tail reasons are usually
 * consequences of the head (a protected UTXO is also perpetually "stale").
 */
const REASON_RANK: readonly string[] = [
  'dust_quarantined',
  'user_frozen',
  'not_cardinal_clean',
  'reserved_ordinals_lane',
  'plan_locked',
  'unconfirmed_not_wallet_change',
  'uneconomic',
  'classification_stale',
];

export function primaryReason(utxo: PresentableUtxo): string | null {
  if (utxo.eligible) return null;
  for (const candidate of REASON_RANK) {
    if (utxo.reasons.includes(candidate)) return candidate;
  }
  return utxo.reasons[0] ?? null;
}

/**
 * The reason line, split so a permanent condition never borrows transient
 * wording. `not_cardinal_clean` on an inscription is forever; the same code on
 * an unclassified UTXO really is "still checking".
 */
export function reasonKey(reason: string, classification: string): MessageKey {
  switch (reason) {
    case 'not_cardinal_clean':
      return isProtectedClass(classification)
        ? 'utxos.reason.protectedAsset'
        : 'utxos.reason.checking';
    case 'classification_stale': return 'utxos.reason.classificationStale';
    case 'reserved_ordinals_lane': return 'utxos.reason.reservedOrdinalsLane';
    case 'user_frozen': return 'utxos.reason.userFrozen';
    case 'dust_quarantined': return 'utxos.reason.dustQuarantined';
    case 'unconfirmed_not_wallet_change': return 'utxos.reason.unconfirmed';
    case 'plan_locked': return 'utxos.reason.planLocked';
    case 'uneconomic': return 'utxos.reason.uneconomic';
    default: return 'utxos.reason.checking';
  }
}

/**
 * §10.3 keeps enum tokens out of the UI, and §12.4 forbids naming an
 * unsupported asset's protocol — hence the deliberately generic label for
 * `runic_or_unsupported`.
 */
export function classificationKey(classification: string): MessageKey {
  switch (classification) {
    case 'cardinal_clean': return 'utxos.class.bitcoin';
    case 'inscribed': return 'utxos.class.inscription';
    case 'rare_sat': return 'utxos.class.rareSat';
    case 'runic_or_unsupported': return 'utxos.class.protectedAsset';
    case 'mixed': return 'utxos.class.mixed';
    default: return 'utxos.class.checking';
  }
}

/**
 * Why *this* class is protected, for the row disclosure.
 *
 * The group header can only say what the whole band has in common, which left
 * "Rare sat" and "Protected asset" reading identically despite meaning very
 * different things. Returns null for classes whose reason line already says
 * everything — an ordinary coin held up by dust or a pending confirmation does
 * not need a lecture about protection.
 */
export function classHelpKey(classification: string): MessageKey | null {
  switch (classification) {
    case 'inscribed': return 'utxos.class.inscription.help';
    case 'rare_sat': return 'utxos.class.rareSat.help';
    case 'runic_or_unsupported': return 'utxos.class.protectedAsset.help';
    case 'mixed': return 'utxos.class.mixed.help';
    default: return null;
  }
}

/** Middle-ellipsis for long hex identifiers. Short values pass through. */
export function shortId(id: string, edge = 8): string {
  return id.length <= edge * 2 + 1 ? id : `${id.slice(0, edge)}…${id.slice(-edge)}`;
}

/** The stable per-row identifier: `a3f2…9c1:0`. */
export function shortOutpoint(txid: string, vout: number): string {
  return `${shortId(txid, 4)}:${vout}`;
}

export function outpointKeyOf(utxo: { txid: string; vout: number }): string {
  return `${utxo.txid}:${utxo.vout}`;
}

/** Sums as BigInt — `valueSats` is a decimal string precisely to avoid Number. */
export function totalSats(utxos: readonly { valueSats: string }[]): bigint {
  return utxos.reduce((sum, utxo) => sum + BigInt(utxo.valueSats), 0n);
}

/**
 * Groups in render order, preserving the worker's ordering inside each group
 * and dropping empty groups so the screen never shows a zero-count header.
 */
export function groupUtxos<T extends PresentableUtxo>(
  utxos: readonly T[],
): { key: UtxoGroupKey; utxos: T[]; total: bigint }[] {
  const buckets = new Map<UtxoGroupKey, T[]>();
  for (const utxo of utxos) {
    const key = utxoGroup(utxo);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(utxo); else buckets.set(key, [utxo]);
  }
  return UTXO_GROUP_ORDER.flatMap((key) => {
    const bucket = buckets.get(key);
    return bucket === undefined
      ? []
      : [{ key, utxos: bucket, total: totalSats(bucket) }];
  });
}

export const GROUP_TITLE_KEYS: Record<UtxoGroupKey, MessageKey> = {
  available: 'utxos.group.available',
  protected: 'utxos.group.protected',
  reserved: 'utxos.group.reserved',
  unavailable: 'utxos.group.unavailable',
};

export const GROUP_HELP_KEYS: Record<UtxoGroupKey, MessageKey> = {
  available: 'utxos.group.available.help',
  protected: 'utxos.group.protected.help',
  reserved: 'utxos.group.reserved.help',
  unavailable: 'utxos.group.unavailable.help',
};
