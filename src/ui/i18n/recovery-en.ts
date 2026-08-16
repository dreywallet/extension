/** Browser-specific recovery wording; portable recovery semantics stay in en.ts. */
export const recoveryEn = {
  'recovery.platform.randomSource':
    'Randomness source: this browser’s cryptographically secure random generator (Web Crypto).',
} as const;

export type RecoveryMessageKey = keyof typeof recoveryEn;
