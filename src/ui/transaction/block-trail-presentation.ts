export type BlockTrailStatus =
  | 'pending'
  | 'accepted'
  | 'already_known'
  | 'mempool'
  | 'confirmed'
  | 'replaced'
  | 'conflicted'
  | 'rejected'
  | 'indeterminate';

export type BlockTrailStepState = 'complete' | 'current' | 'future' | 'warning' | 'danger';
export type BlockTrailRecordKind = 'durable' | 'observed';
export type BlockTrailConfirmationDetail =
  | 'waiting'
  | 'confirmed'
  | 'confirmed_no_height'
  | 'unknown'
  | 'not_reached';

export interface BlockTrailPresentation {
  /** Monotonic normal-path progress; null outcomes never trigger decorative motion. */
  progressRank: 1 | 2 | 3 | null;
  recordKind: BlockTrailRecordKind;
  steps: readonly [
    { id: 'recorded'; state: BlockTrailStepState },
    { id: 'network'; state: BlockTrailStepState },
    {
      id: 'confirmation';
      state: BlockTrailStepState;
      detail: BlockTrailConfirmationDetail;
    },
  ];
}

/**
 * Pure projection of facts already established by the transaction result or
 * Activity model. It deliberately gives unknown/final outcomes no progress
 * motion and never upgrades an indeterminate broadcast into ordinary pending.
 */
export function presentBlockTrail(
  status: BlockTrailStatus,
  height: number | null = null,
  recordKind: BlockTrailRecordKind = 'durable',
): BlockTrailPresentation {
  const recorded = { id: 'recorded' as const, state: 'complete' as const };
  switch (status) {
    case 'confirmed':
      return {
        progressRank: 3,
        recordKind,
        steps: [recorded, { id: 'network', state: 'complete' }, {
          id: 'confirmation', state: 'complete',
          detail: height === null ? 'confirmed_no_height' : 'confirmed',
        }],
      };
    case 'accepted':
    case 'already_known':
    case 'mempool':
      return {
        progressRank: 2,
        recordKind,
        steps: [recorded, { id: 'network', state: 'complete' }, {
          id: 'confirmation', state: 'current', detail: 'waiting',
        }],
      };
    case 'pending':
      return {
        progressRank: 1,
        recordKind,
        steps: [recorded, { id: 'network', state: 'current' }, {
          id: 'confirmation', state: 'future', detail: 'waiting',
        }],
      };
    case 'indeterminate':
      return {
        progressRank: null,
        recordKind,
        steps: [recorded, { id: 'network', state: 'warning' }, {
          id: 'confirmation', state: 'future', detail: 'unknown',
        }],
      };
    case 'replaced':
      return {
        progressRank: null,
        recordKind,
        steps: [recorded, { id: 'network', state: 'warning' }, {
          id: 'confirmation', state: 'future', detail: 'not_reached',
        }],
      };
    case 'conflicted':
    case 'rejected':
      return {
        progressRank: null,
        recordKind,
        steps: [recorded, { id: 'network', state: 'danger' }, {
          id: 'confirmation', state: 'future', detail: 'not_reached',
        }],
      };
  }
}
