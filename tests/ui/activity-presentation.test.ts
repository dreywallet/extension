import { describe, expect, it } from 'vitest';
import type { WalletHomeResult } from '@drey/core/messaging/ops';
import {
  groupActivity,
  presentActivity,
} from '../../src/ui/activity/activity-presentation';
import { CATALOGS, format, type I18n } from '../../src/ui/i18n';

const t: I18n['t'] = (key, params) => format(CATALOGS.en[key], params);
const sats = (value: bigint): string => `${value.toLocaleString('en')} sats`;

function item(
  overrides: Partial<WalletHomeResult['activity'][number]> = {},
): WalletHomeResult['activity'][number] {
  return {
    txid: 'a'.repeat(64),
    deltaSats: '-1234',
    feeSats: '234',
    confirmationState: 'confirmed',
    timestamp: '2026-07-23T12:00:00.000Z',
    height: 959_347,
    ...overrides,
  };
}

describe('shared activity presentation', () => {
  it('separates outgoing principal from its network fee', () => {
    const presentation = presentActivity(item(), t, 'en', sats);
    expect(presentation.description).toBe('Sent');
    expect(presentation.amount).toBe('−1,000 sats');
    expect(presentation.fee).toBe('234 sats network fee');
    expect(presentation.dateLabel).toMatch(/July 23, 2026/u);
  });

  it('presents self-transfers as a fee instead of a zero-value send', () => {
    const presentation = presentActivity(item({
      deltaSats: '-455',
      feeSats: '455',
      bitcoinActionKind: 'self_transfer',
    }), t, 'en', sats);
    expect(presentation.description).toBe('Bitcoin moved');
    expect(presentation.identity).toBe('Between your addresses');
    expect(presentation.amount).toBe('−455 sats');
  });

  it('keeps inscription value out of the bitcoin amount column', () => {
    const inscriptionId = `${'b'.repeat(64)}i0`;
    const presentation = presentActivity(item({
      actionKind: 'ordinal_receive',
      inscriptionId,
      inscriptionNumber: 1234,
      deltaSats: '546',
      feeSats: null,
    }), t, 'en', sats);
    expect(presentation.description).toBe('Inscription received');
    expect(presentation.identity).toBe('Inscription #1,234');
    expect(presentation.identityTitle).toBe(inscriptionId);
    expect(presentation.amount).toBeNull();
  });

  it('groups newest-first rows by local date and keeps pending separate', () => {
    const groups = groupActivity([
      item({ txid: '1'.repeat(64) }),
      item({ txid: '2'.repeat(64), deltaSats: '1' }),
      item({
        txid: '3'.repeat(64),
        timestamp: null,
        height: null,
        confirmationState: 'mempool',
      }),
    ], t, 'en');
    expect(groups).toHaveLength(2);
    expect(groups[0]?.items).toHaveLength(2);
    expect(groups[1]).toMatchObject({ key: 'pending', label: 'Pending' });
  });
});
