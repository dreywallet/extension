import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  presentBlockTrail,
  type BlockTrailStatus,
} from '../../src/ui/transaction/block-trail-presentation';

describe('Block Trail presentation', () => {
  it('provides monotonic ranks only for ordinary forward progress', () => {
    const ranks: Partial<Record<BlockTrailStatus, number | null>> = {
      pending: 1,
      accepted: 2,
      already_known: 2,
      mempool: 2,
      confirmed: 3,
      indeterminate: null,
      replaced: null,
      conflicted: null,
      rejected: null,
    };
    for (const [status, rank] of Object.entries(ranks)) {
      expect(presentBlockTrail(status as BlockTrailStatus).progressRank, status).toBe(rank);
    }
  });

  it('keeps unknown and final outcomes distinct from ordinary pending confirmation', () => {
    expect(presentBlockTrail('indeterminate').steps).toEqual([
      { id: 'recorded', state: 'complete' },
      { id: 'network', state: 'warning' },
      { id: 'confirmation', state: 'future', detail: 'unknown' },
    ]);
    expect(presentBlockTrail('pending').steps).toEqual([
      { id: 'recorded', state: 'complete' },
      { id: 'network', state: 'current' },
      { id: 'confirmation', state: 'future', detail: 'waiting' },
    ]);
    expect(presentBlockTrail('rejected').steps).toEqual([
      { id: 'recorded', state: 'complete' },
      { id: 'network', state: 'danger' },
      { id: 'confirmation', state: 'future', detail: 'not_reached' },
    ]);
    expect(presentBlockTrail('mempool').steps[2]).toEqual({
      id: 'confirmation', state: 'current', detail: 'waiting',
    });
  });

  it('carries whether the first fact is durable or only observed', () => {
    expect(presentBlockTrail('mempool').recordKind).toBe('durable');
    expect(presentBlockTrail('mempool', null, 'observed').recordKind).toBe('observed');
  });

  it('keeps generic Activity observed and maps unknown send dispatch to indeterminate', () => {
    const activity = readFileSync(path.resolve(
      import.meta.dirname, '../../src/entrypoints/fullpage/ActivitySection.tsx',
    ), 'utf8');
    const transactions = readFileSync(path.resolve(
      import.meta.dirname, '../../src/entrypoints/fullpage/Transactions.tsx',
    ), 'utf8');
    expect(activity).toContain("transaction === undefined ? 'observed' : 'durable'");
    expect(activity).toContain('recordKind="durable"');
    expect(transactions).toContain("result.status === 'pending' ? 'indeterminate' : result.status");
  });

  it('shows only a supplied authoritative block height', () => {
    expect(presentBlockTrail('confirmed', 912_345).steps[2].detail).toBe('confirmed');
    expect(presentBlockTrail('confirmed').steps[2].detail).toBe('confirmed_no_height');
  });

  it('uses an accessible ordered trail and disables its 200ms settle for reduced motion', () => {
    const component = readFileSync(path.resolve(
      import.meta.dirname, '../../src/ui/transaction/BlockTrail.tsx',
    ), 'utf8');
    const css = readFileSync(path.resolve(
      import.meta.dirname, '../../src/ui/transaction/BlockTrail.module.css',
    ), 'utf8');
    expect(component).toContain('<ol');
    expect(component).toContain("aria-label={t('blockTrail.title')}");
    expect(component).toContain('const previousRank = useRef<number | null>(null)');
    expect(component).toContain('next <= previous');
    expect(css).toContain('200ms ease-out');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('animation: none');
  });
});
