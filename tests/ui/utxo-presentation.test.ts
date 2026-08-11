import { describe, expect, it } from 'vitest';
import {
  classHelpKey,
  classificationKey,
  groupUtxos,
  isProtectedClass,
  primaryReason,
  reasonKey,
  shortId,
  shortOutpoint,
  totalSats,
  UTXO_GROUP_ORDER,
  utxoGroup,
  type PresentableUtxo,
} from '../../src/ui/utxo-presentation';

function utxo(overrides: Partial<PresentableUtxo> = {}): PresentableUtxo {
  return {
    txid: 'a'.repeat(64),
    vout: 0,
    valueSats: '1000',
    classification: 'cardinal_clean',
    eligible: true,
    reasons: [],
    wrongLane: 'normal',
    ...overrides,
  };
}

/** Every reason code the §11.2 predicate can emit, plus the lane suppression. */
const ALL_REASONS = [
  'not_cardinal_clean',
  'classification_stale',
  'user_frozen',
  'dust_quarantined',
  'unconfirmed_not_wallet_change',
  'plan_locked',
  'uneconomic',
  'reserved_ordinals_lane',
];

const PROTECTED_CLASSES = ['inscribed', 'rare_sat', 'runic_or_unsupported', 'mixed'];

describe('utxoGroup', () => {
  it('puts every eligible input in Available regardless of anything else', () => {
    expect(utxoGroup(utxo({ eligible: true }))).toBe('available');
    // Eligibility is the worker's call; presentation never second-guesses it.
    expect(utxoGroup(utxo({ eligible: true, classification: 'inscribed' })))
      .toBe('available');
  });

  it('classes ordinals-lane bitcoin as Reserved even though it is cardinal_clean', () => {
    expect(utxoGroup(utxo({
      eligible: false,
      classification: 'cardinal_clean',
      wrongLane: 'reserved_ordinal_lane_btc',
      reasons: ['reserved_ordinals_lane'],
    }))).toBe('reserved');
  });

  it.each(PROTECTED_CLASSES)('classes %s as Protected', (classification) => {
    expect(utxoGroup(utxo({ eligible: false, classification, reasons: ['not_cardinal_clean'] })))
      .toBe('protected');
  });

  it('keeps a protected asset stranded in the payment lane in Protected', () => {
    expect(utxoGroup(utxo({
      eligible: false,
      classification: 'inscribed',
      wrongLane: 'protected_wrong_address',
      reasons: ['not_cardinal_clean'],
    }))).toBe('protected');
  });

  it.each([
    ['user_frozen', 'cardinal_clean'],
    ['dust_quarantined', 'cardinal_clean'],
    ['unconfirmed_not_wallet_change', 'cardinal_clean'],
    ['plan_locked', 'cardinal_clean'],
    ['uneconomic', 'cardinal_clean'],
    ['not_cardinal_clean', 'unknown'],
  ])('routes %s to Unavailable', (reason, classification) => {
    expect(utxoGroup(utxo({ eligible: false, classification, reasons: [reason] })))
      .toBe('unavailable');
  });

  it('never returns a group outside the render order', () => {
    for (const reason of ALL_REASONS) {
      for (const classification of [...PROTECTED_CLASSES, 'cardinal_clean', 'unknown']) {
        const group = utxoGroup(utxo({ eligible: false, classification, reasons: [reason] }));
        expect(UTXO_GROUP_ORDER).toContain(group);
      }
    }
  });
});

describe('primaryReason', () => {
  it('reports nothing for an eligible input', () => {
    expect(primaryReason(utxo({ eligible: true, reasons: [] }))).toBeNull();
    // Defensive: eligibility wins even if the worker also sent reasons.
    expect(primaryReason(utxo({ eligible: true, reasons: ['uneconomic'] }))).toBeNull();
  });

  it('picks the most severe reason rather than joining them', () => {
    expect(primaryReason(utxo({
      eligible: false,
      reasons: ['classification_stale', 'uneconomic', 'dust_quarantined'],
    }))).toBe('dust_quarantined');
  });

  it('ranks staleness last, because it accompanies almost everything else', () => {
    expect(primaryReason(utxo({
      eligible: false,
      reasons: ['classification_stale', 'not_cardinal_clean'],
    }))).toBe('not_cardinal_clean');
    // Alone it is still worth saying.
    expect(primaryReason(utxo({ eligible: false, reasons: ['classification_stale'] })))
      .toBe('classification_stale');
  });

  it('is order-independent', () => {
    const forwards = primaryReason(utxo({
      eligible: false, reasons: ['uneconomic', 'user_frozen'],
    }));
    const backwards = primaryReason(utxo({
      eligible: false, reasons: ['user_frozen', 'uneconomic'],
    }));
    expect(forwards).toBe('user_frozen');
    expect(backwards).toBe('user_frozen');
  });

  it('falls back to an unranked reason instead of dropping it', () => {
    expect(primaryReason(utxo({ eligible: false, reasons: ['some_future_reason'] })))
      .toBe('some_future_reason');
  });

  it('returns null when the worker reports ineligible with no reason', () => {
    expect(primaryReason(utxo({ eligible: false, reasons: [] }))).toBeNull();
  });
});

describe('reasonKey', () => {
  // The regression this whole screen was rebuilt around: an inscription is
  // protected forever, so its row must never imply that waiting resolves it.
  it.each(PROTECTED_CLASSES)(
    'describes %s as permanently protected, never as pending verification',
    (classification) => {
      expect(reasonKey('not_cardinal_clean', classification))
        .toBe('utxos.reason.protectedAsset');
    },
  );

  it('describes an unclassified input as still being checked', () => {
    expect(reasonKey('not_cardinal_clean', 'unknown')).toBe('utxos.reason.checking');
  });

  it.each(ALL_REASONS)('maps %s to a real message key', (reason) => {
    expect(reasonKey(reason, 'cardinal_clean')).toMatch(/^utxos\.reason\./u);
  });

  it('never leaks an unknown reason code into the UI', () => {
    expect(reasonKey('some_future_reason', 'cardinal_clean'))
      .toBe('utxos.reason.checking');
  });
});

describe('classificationKey', () => {
  it('keeps the unsupported-asset label generic, per §12.4', () => {
    // Naming the protocol would disclose the asset type the spec forbids
    // surfacing, and the raw token also leaks an internal enum.
    expect(classificationKey('runic_or_unsupported')).toBe('utxos.class.protectedAsset');
  });

  it.each([
    ['cardinal_clean', 'utxos.class.bitcoin'],
    ['inscribed', 'utxos.class.inscription'],
    ['rare_sat', 'utxos.class.rareSat'],
    ['mixed', 'utxos.class.mixed'],
    ['unknown', 'utxos.class.checking'],
  ])('maps %s to %s', (classification, key) => {
    expect(classificationKey(classification)).toBe(key);
  });

  it('falls back rather than echoing an unrecognised token', () => {
    expect(classificationKey('brand_new_class')).toBe('utxos.class.checking');
  });
});

describe('classHelpKey', () => {
  it.each(PROTECTED_CLASSES)('explains %s distinctly', (classification) => {
    expect(classHelpKey(classification)).not.toBeNull();
  });

  it('gives each protected class its own explanation', () => {
    // "Rare sat" and "Protected asset" mean very different things; a shared
    // sentence at the group header made them read identically.
    const keys = PROTECTED_CLASSES.map((entry) => classHelpKey(entry));
    expect(new Set(keys).size).toBe(PROTECTED_CLASSES.length);
  });

  it.each(['cardinal_clean', 'unknown', 'brand_new_class'])(
    'stays silent for %s, whose reason line already says enough',
    (classification) => {
      expect(classHelpKey(classification)).toBeNull();
    },
  );
});

describe('isProtectedClass', () => {
  it.each(PROTECTED_CLASSES)('treats %s as permanently protected', (classification) => {
    expect(isProtectedClass(classification)).toBe(true);
  });

  it.each(['cardinal_clean', 'unknown'])('does not treat %s as protected', (classification) => {
    expect(isProtectedClass(classification)).toBe(false);
  });
});

describe('shortId and shortOutpoint', () => {
  it('returns short input untouched rather than padding it with an ellipsis', () => {
    expect(shortId('abcd', 8)).toBe('abcd');
    expect(shortId('', 8)).toBe('');
  });

  it('keeps both ends of a long identifier', () => {
    const id = `${'a'.repeat(8)}${'b'.repeat(48)}${'c'.repeat(8)}`;
    expect(shortId(id)).toBe(`${'a'.repeat(8)}…${'c'.repeat(8)}`);
  });

  it('distinguishes coins that share an amount and a derivation path', () => {
    const first = shortOutpoint(`${'ab12'}${'0'.repeat(56)}${'cd34'}`, 0);
    const second = shortOutpoint(`${'ef56'}${'0'.repeat(56)}${'ab78'}`, 0);
    expect(first).not.toBe(second);
    expect(first).toBe('ab12…cd34:0');
  });

  it('separates two outputs of the same transaction', () => {
    const txid = 'a'.repeat(64);
    expect(shortOutpoint(txid, 0)).not.toBe(shortOutpoint(txid, 1));
  });
});

describe('totalSats', () => {
  it('sums an empty set to zero', () => {
    expect(totalSats([])).toBe(0n);
  });

  it('stays exact past Number.MAX_SAFE_INTEGER', () => {
    // 21M BTC in sats exceeds 2^53, which is exactly why the wire format is a
    // decimal string. Summing through Number would silently lose satoshis.
    const beyond = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();
    expect(totalSats([{ valueSats: beyond }, { valueSats: '1' }]))
      .toBe(BigInt(Number.MAX_SAFE_INTEGER) + 2n);
  });

  it('adds ordinary values', () => {
    expect(totalSats([{ valueSats: '609646' }, { valueSats: '86257' }])).toBe(695_903n);
  });
});

describe('groupUtxos', () => {
  it('returns nothing for an empty wallet', () => {
    expect(groupUtxos([])).toEqual([]);
  });

  it('omits empty groups so no zero-count header ever renders', () => {
    const groups = groupUtxos([utxo({ eligible: true })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe('available');
  });

  it('orders groups with Available first', () => {
    const groups = groupUtxos([
      utxo({ txid: 'b'.repeat(64), eligible: false, classification: 'inscribed', reasons: ['not_cardinal_clean'] }),
      utxo({ txid: 'c'.repeat(64), eligible: false, reasons: ['user_frozen'] }),
      utxo({ txid: 'd'.repeat(64), eligible: true }),
      utxo({ txid: 'e'.repeat(64), eligible: false, wrongLane: 'reserved_ordinal_lane_btc', reasons: ['reserved_ordinals_lane'] }),
    ]);
    expect(groups.map((group) => group.key))
      .toEqual(['available', 'protected', 'reserved', 'unavailable']);
  });

  it('preserves the worker ordering inside a group', () => {
    const groups = groupUtxos([
      utxo({ txid: 'a'.repeat(64), valueSats: '3' }),
      utxo({ txid: 'b'.repeat(64), valueSats: '1' }),
      utxo({ txid: 'c'.repeat(64), valueSats: '2' }),
    ]);
    expect(groups[0]?.utxos.map((entry) => entry.valueSats)).toEqual(['3', '1', '2']);
  });

  it('totals each group independently', () => {
    const groups = groupUtxos([
      utxo({ txid: 'a'.repeat(64), valueSats: '500' }),
      utxo({ txid: 'b'.repeat(64), valueSats: '250' }),
      utxo({
        txid: 'c'.repeat(64), valueSats: '546',
        eligible: false, classification: 'inscribed', reasons: ['not_cardinal_clean'],
      }),
    ]);
    expect(groups.find((group) => group.key === 'available')?.total).toBe(750n);
    expect(groups.find((group) => group.key === 'protected')?.total).toBe(546n);
  });

  it('accounts for every input exactly once', () => {
    const inputs = [
      utxo({ txid: 'a'.repeat(64) }),
      utxo({ txid: 'b'.repeat(64), eligible: false, classification: 'rare_sat', reasons: ['not_cardinal_clean'] }),
      utxo({ txid: 'c'.repeat(64), eligible: false, reasons: ['dust_quarantined'] }),
      utxo({ txid: 'd'.repeat(64), eligible: false, wrongLane: 'reserved_ordinal_lane_btc', reasons: ['reserved_ordinals_lane'] }),
    ];
    const grouped = groupUtxos(inputs).flatMap((group) => group.utxos);
    expect(grouped).toHaveLength(inputs.length);
    expect(new Set(grouped.map((entry) => entry.txid)).size).toBe(inputs.length);
  });
});
