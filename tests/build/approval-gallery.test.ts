import { describe, expect, it } from 'vitest';
import { approvalSnapshotSchema } from '../../src/provider/approval';
import {
  APPROVAL_GALLERY_ISOLATION_MARKER,
  APPROVAL_GALLERY_SCENARIOS,
} from '../../tools/approval-gallery/scenarios';

describe('local approval gallery', () => {
  it('uses valid, unique synthetic approval snapshots', () => {
    expect(new Set(APPROVAL_GALLERY_SCENARIOS.map((scenario) => scenario.id)).size)
      .toBe(APPROVAL_GALLERY_SCENARIOS.length);
    expect(APPROVAL_GALLERY_SCENARIOS.map((scenario) => scenario.id)).toEqual(
      expect.arrayContaining([
        'p2wpkh-all',
        'p2tr-default',
        'all-anyonecanpay',
        'single',
        'single-anyonecanpay-listing',
        'mixed-sighash',
        'blocked-none',
        'transaction-batch',
      ]),
    );

    for (const scenario of APPROVAL_GALLERY_SCENARIOS) {
      expect(approvalSnapshotSchema.safeParse(scenario.snapshot).success).toBe(true);
      if (scenario.snapshot.request) {
        expect(scenario.snapshot.request.origin).toMatch(/^https:\/\/[a-z-]+\.example$/u);
        expect(JSON.stringify(scenario.snapshot)).toContain(APPROVAL_GALLERY_ISOLATION_MARKER);
      } else {
        expect(scenario.id).toBe('blocked-none');
        expect(scenario.providerError).toMatch(/reject/u);
      }
    }
  });

  it('shows success verification only for complete transactions', () => {
    const transactions = APPROVAL_GALLERY_SCENARIOS.flatMap((scenario) =>
      scenario.snapshot.request?.review.kind === 'transaction'
        ? [scenario.snapshot.request.review]
        : []);
    expect(transactions.some((review) => review.authorization === 'complete')).toBe(true);
    expect(transactions.some((review) => review.authorization === 'partial')).toBe(true);
    expect(transactions.find((review) => review.authorization === 'partial')?.outputs)
      .toEqual(expect.arrayContaining([expect.objectContaining({ committed: false })]));
  });

  it('rejects message reviews whose method or signed bytes no longer match', () => {
    const source = APPROVAL_GALLERY_SCENARIOS.find((scenario) => scenario.id === 'message-batch')!;
    const wrongMethod = structuredClone(source.snapshot);
    wrongMethod.request!.method = 'signMessage';
    expect(approvalSnapshotSchema.safeParse(wrongMethod).success).toBe(false);

    const changedMessage = structuredClone(source.snapshot);
    const review = changedMessage.request!.review;
    if (review.kind !== 'message_batch') throw new Error('message batch fixture changed');
    review.messages[1]!.message = 'Different authorization';
    expect(approvalSnapshotSchema.safeParse(changedMessage).success).toBe(false);
  });
});
