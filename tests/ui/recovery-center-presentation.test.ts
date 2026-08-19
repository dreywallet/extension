import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  RECOVERY_CENTER_ITEM_IDS,
  presentExtensionRecoveryCenter,
  type ExtensionRecoveryCenterEvidence,
  type ExtensionVaultReadinessEvidence,
  type RecoveryKeyReadinessEvidence,
  type RecoveryKeyReadinessState,
  type SpendingBackupMetadataEvidence,
  type SpendingRecoveryWordCount,
} from '../../src/entrypoints/fullpage/recovery-center-presentation';

const NOW = 2_000_000;

const HEALTHY_SPENDING: SpendingBackupMetadataEvidence = {
  origin: 'generated',
  usageGatePassed: true,
  wordCount: 12,
  usesPassphrase: false,
  lastSpotCheckAt: NOW - 2,
  lastFullRecoveryCheckAt: NOW - 1,
};

const RECOVERY_SHAPES: Record<RecoveryKeyReadinessState, RecoveryKeyReadinessEvidence> = {
  not_started: {
    state: 'not_started', setupComplete: false, kitExported: false,
    backupCheckComplete: false, ready: false,
  },
  setup_open: {
    state: 'setup_open', setupComplete: false, kitExported: false,
    backupCheckComplete: false, ready: false,
  },
  setup_complete: {
    state: 'setup_complete', setupComplete: true, kitExported: false,
    backupCheckComplete: false, ready: false,
  },
  kit_required: {
    state: 'kit_required', setupComplete: true, kitExported: false,
    backupCheckComplete: false, ready: false,
  },
  backup_required: {
    state: 'backup_required', setupComplete: true, kitExported: true,
    backupCheckComplete: false, ready: false,
  },
  backup_open: {
    state: 'backup_open', setupComplete: true, kitExported: true,
    backupCheckComplete: false, ready: false,
  },
  ready: {
    state: 'ready', setupComplete: true, kitExported: true,
    backupCheckComplete: true, ready: true,
  },
  unusable: {
    state: 'unusable', setupComplete: false, kitExported: false,
    backupCheckComplete: false, ready: false,
  },
};

function knownVault(
  overrides: Partial<Extract<ExtensionVaultReadinessEvidence, { state: 'known' }>> = {},
): Extract<ExtensionVaultReadinessEvidence, { state: 'known' }> {
  return {
    state: 'known',
    available: true,
    localRole: 'usable',
    policy: 'present',
    phone: 'paired',
    recoveryKey: RECOVERY_SHAPES.ready,
    independentExit: 'available',
    ...overrides,
  };
}

function evidence(overrides: Partial<ExtensionRecoveryCenterEvidence> = {}): ExtensionRecoveryCenterEvidence {
  return {
    vaultCapability: true,
    now: NOW,
    spending: { state: 'known', backupVerified: true, metadata: HEALTHY_SPENDING },
    vault: knownVault(),
    ...overrides,
  };
}

function item(result: ReturnType<typeof presentExtensionRecoveryCenter>, id: string) {
  const found = result.items.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing presentation item ${id}`);
  return found;
}

describe('extension Recovery Center presentation', () => {
  it('always returns the stable item order and stable, bounded presentation fields', () => {
    const result = presentExtensionRecoveryCenter(evidence());

    expect(result.items.map(({ id }) => id)).toEqual(RECOVERY_CENTER_ITEM_IDS);
    for (const presented of result.items) {
      expect(Object.keys(presented).sort()).toEqual(expect.arrayContaining(['id', 'labelKey', 'state']));
      expect(Object.keys(presented)).not.toContain('label');
      expect(Object.keys(presented)).not.toContain('value');
    }
    expect(result.primaryActionId).toBe('open-vault');
    expect(result.spendingWordCount).toBe(12);
  });

  it.each(
    (['generated', 'imported', 'legacy_unknown'] as const).flatMap((origin) =>
      ([12, 15, 18, 21, 24] as const).flatMap((wordCount) =>
        ([false, true, null] as const).map((usesPassphrase) => ({
          origin, wordCount, usesPassphrase,
        })),
      ),
    ),
  )('keeps $origin/$wordCount/passphrase=$usesPassphrase from changing verified facts', (variant) => {
    const metadata: SpendingBackupMetadataEvidence = { ...HEALTHY_SPENDING, ...variant };
    const result = presentExtensionRecoveryCenter(evidence({
      vaultCapability: false,
      spending: { state: 'known', backupVerified: true, metadata },
    }));

    expect(result.spendingWordCount).toBe(variant.wordCount);
    expect(item(result, 'spending-backup').state).toBe('ready');
    expect(item(result, 'spending-spot-check').state).toBe('ready');
    expect(item(result, 'spending-full-recovery').state).toBe('ready');
  });

  it.each([
    { backupVerified: false, usageGatePassed: false },
    { backupVerified: false, usageGatePassed: true },
    { backupVerified: true, usageGatePassed: false },
  ])('requires both local Spending backup facts: %o', ({ backupVerified, usageGatePassed }) => {
    const result = presentExtensionRecoveryCenter(evidence({
      vaultCapability: false,
      spending: {
        state: 'known',
        backupVerified,
        metadata: { ...HEALTHY_SPENDING, usageGatePassed },
      },
    }));

    expect(item(result, 'spending-backup')).toMatchObject({
      state: 'action_needed', actionId: 'verify-spending-backup',
    });
    expect(result.primaryActionId).toBe('verify-spending-backup');
  });

  it.each([
    null,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    NOW + 1,
  ])('rejects an absent, malformed, or future timestamp: %s', (timestamp) => {
    const result = presentExtensionRecoveryCenter(evidence({
      vaultCapability: false,
      spending: {
        state: 'known',
        backupVerified: true,
        metadata: {
          ...HEALTHY_SPENDING,
          lastSpotCheckAt: timestamp,
          lastFullRecoveryCheckAt: timestamp,
        },
      },
    }));

    expect(item(result, 'spending-spot-check')).toMatchObject({ state: 'not_checked' });
    expect(item(result, 'spending-full-recovery')).toMatchObject({ state: 'not_checked' });
    expect(item(result, 'spending-spot-check')).not.toHaveProperty('verifiedAt');
    expect(item(result, 'spending-full-recovery')).not.toHaveProperty('verifiedAt');
  });

  it('accepts only integral timestamps on or before the supplied local time', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: NOW }), (timestamp) => {
      const result = presentExtensionRecoveryCenter(evidence({
        vaultCapability: false,
        spending: {
          state: 'known',
          backupVerified: true,
          metadata: {
            ...HEALTHY_SPENDING,
            lastSpotCheckAt: timestamp,
            lastFullRecoveryCheckAt: timestamp,
          },
        },
      }));
      expect(item(result, 'spending-spot-check')).toMatchObject({ state: 'ready', verifiedAt: timestamp });
      expect(item(result, 'spending-full-recovery')).toMatchObject({ state: 'ready', verifiedAt: timestamp });
    }));

    fc.assert(fc.property(fc.integer({ min: NOW + 1, max: NOW + 1_000_000 }), (timestamp) => {
      const result = presentExtensionRecoveryCenter(evidence({
        vaultCapability: false,
        spending: {
          state: 'known',
          backupVerified: true,
          metadata: {
            ...HEALTHY_SPENDING,
            lastSpotCheckAt: timestamp,
            lastFullRecoveryCheckAt: timestamp,
          },
        },
      }));
      expect(item(result, 'spending-spot-check').state).toBe('not_checked');
      expect(item(result, 'spending-full-recovery').state).toBe('not_checked');
    }));
  });

  it('rejects every otherwise-valid timestamp when the comparison clock is invalid', () => {
    for (const now of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = presentExtensionRecoveryCenter(evidence({ now, vaultCapability: false }));
      expect(item(result, 'spending-spot-check').state).toBe('not_checked');
      expect(item(result, 'spending-full-recovery').state).toBe('not_checked');
    }
  });

  it('never promotes missing Spending evidence to Ready', () => {
    const unknown = presentExtensionRecoveryCenter(evidence({
      vaultCapability: false,
      spending: { state: 'unknown' },
    }));
    for (const presented of unknown.items.slice(0, 3)) expect(presented.state).toBe('not_checked');
    expect(unknown.spendingWordCount).toBeNull();

    for (const backupVerified of [false, true]) {
      const partial = presentExtensionRecoveryCenter(evidence({
        vaultCapability: false,
        spending: { state: 'known', backupVerified, metadata: null },
      }));
      expect(item(partial, 'spending-backup').state).toBe('action_needed');
      expect(item(partial, 'spending-spot-check').state).toBe('not_checked');
      expect(item(partial, 'spending-full-recovery').state).toBe('not_checked');
      expect(partial.primaryActionId).toBe('verify-spending-backup');
      expect(partial.spendingWordCount).toBeNull();
    }
  });

  it('makes every Vault item not applicable when compile-time capability is off', () => {
    const contradictoryRuntimeEvidence = knownVault();
    const result = presentExtensionRecoveryCenter(evidence({
      vaultCapability: false,
      vault: contradictoryRuntimeEvidence,
    }));

    for (const presented of result.items.slice(3)) {
      expect(presented.state).toBe('not_applicable');
      expect(presented).not.toHaveProperty('actionId');
      expect(presented).not.toHaveProperty('technicalDetailReference');
    }
  });

  it('never promotes unknown evidence for a Vault fact to Ready', () => {
    const cases: Array<[ExtensionVaultReadinessEvidence, string]> = [
      [{ state: 'unknown' }, 'vault-computer'],
      [knownVault({ localRole: 'unknown' }), 'vault-computer'],
      [knownVault({ phone: 'unknown' }), 'vault-phone'],
      [knownVault({ recoveryKey: null }), 'vault-recovery-key'],
      [knownVault({ recoveryKey: null }), 'vault-recovery-kit'],
      [knownVault({ independentExit: 'unknown' }), 'vault-independent-exit'],
    ];
    for (const [vault, id] of cases) {
      expect(item(presentExtensionRecoveryCenter(evidence({ vault })), id).state).not.toBe('ready');
    }
  });

  it.each([
    ['not_started', 'absent', 'continue-recovery-key', 'action_needed'],
    ['setup_open', 'absent', 'continue-recovery-key', 'action_needed'],
    ['setup_complete', 'absent', 'open-vault', 'action_needed'],
    ['kit_required', 'present', 'save-recovery-kit', 'action_needed'],
    ['backup_required', 'present', 'verify-vault-backup', 'action_needed'],
    ['backup_open', 'present', 'verify-vault-backup', 'action_needed'],
    ['ready', 'present', 'open-vault', 'ready'],
    ['unusable', 'present', 'repair-vault', 'action_needed'],
  ] as const)(
    'maps Recovery Key state %s deterministically',
    (recoveryState, policy, primaryAction, presentationState) => {
      const phone = policy === 'present' ? 'paired' : 'not_paired';
      const result = presentExtensionRecoveryCenter(evidence({
        vault: knownVault({
          policy,
          phone,
          recoveryKey: RECOVERY_SHAPES[recoveryState],
        }),
      }));
      expect(item(result, 'vault-recovery-key').state).toBe(presentationState);
      expect(result.primaryActionId).toBe(primaryAction);
    },
  );

  it.each([
    {
      name: 'worker says unavailable while local records claim usable',
      vault: knownVault({ available: false }),
    },
    {
      name: 'local role is unusable',
      vault: knownVault({ localRole: 'unusable' }),
    },
    {
      name: 'policy is unusable',
      vault: knownVault({ policy: 'unusable', phone: 'unknown', recoveryKey: null }),
    },
    {
      name: 'policy lacks the exact phone role',
      vault: knownVault({ phone: 'not_paired' }),
    },
    {
      name: 'Recovery Key booleans contradict its state',
      vault: knownVault({ recoveryKey: { ...RECOVERY_SHAPES.ready, ready: false } }),
    },
    {
      name: 'policy-bound recovery evidence exists without a policy',
      vault: knownVault({ policy: 'absent', phone: 'not_paired' }),
    },
  ])('prioritizes repair for conflicting local state: $name', ({ vault }) => {
    expect(presentExtensionRecoveryCenter(evidence({ vault })).primaryActionId).toBe('repair-vault');
  });

  it('keeps the documented primary action priority stable', () => {
    const spendingIncomplete = {
      state: 'known' as const,
      backupVerified: false,
      metadata: {
        ...HEALTHY_SPENDING,
        usageGatePassed: false,
        lastSpotCheckAt: null,
        lastFullRecoveryCheckAt: null,
      },
    };
    const priorityCases: Array<[string, ExtensionRecoveryCenterEvidence, string | null]> = [
      ['repair', evidence({ spending: spendingIncomplete, vault: knownVault({ phone: 'not_paired' }) }), 'repair-vault'],
      ['Recovery Key setup', evidence({
        spending: spendingIncomplete,
        vault: knownVault({ policy: 'absent', phone: 'not_paired', recoveryKey: RECOVERY_SHAPES.not_started }),
      }), 'continue-recovery-key'],
      ['Recovery Kit', evidence({
        spending: spendingIncomplete,
        vault: knownVault({ recoveryKey: RECOVERY_SHAPES.kit_required }),
      }), 'save-recovery-kit'],
      ['Vault backup check', evidence({
        spending: spendingIncomplete,
        vault: knownVault({ recoveryKey: RECOVERY_SHAPES.backup_required }),
      }), 'verify-vault-backup'],
      ['Spending backup', evidence({ spending: spendingIncomplete }), 'verify-spending-backup'],
      ['full recovery rehearsal', evidence({
        vaultCapability: false,
        spending: {
          state: 'known', backupVerified: true,
          metadata: { ...HEALTHY_SPENDING, lastSpotCheckAt: null, lastFullRecoveryCheckAt: null },
        },
      }), 'test-full-recovery'],
      ['spot check', evidence({
        vaultCapability: false,
        spending: {
          state: 'known', backupVerified: true,
          metadata: { ...HEALTHY_SPENDING, lastSpotCheckAt: null },
        },
      }), 'spot-check'],
      ['optional Vault setup', evidence({
        vault: knownVault({
          localRole: 'absent', policy: 'absent', phone: 'unknown', recoveryKey: null,
          independentExit: 'unknown',
        }),
      }), 'setup-vault'],
      ['no action without Vault', evidence({ vaultCapability: false }), null],
    ];

    for (const [name, input, expected] of priorityCases) {
      expect(presentExtensionRecoveryCenter(input).primaryActionId, name).toBe(expected);
    }
  });

  it('maps the full bounded Vault evidence cross-product deterministically', () => {
    const roles = ['unknown', 'absent', 'usable', 'unusable'] as const;
    const policies = ['unknown', 'absent', 'present', 'unusable'] as const;
    const phones = ['unknown', 'not_paired', 'paired'] as const;
    const exits = ['unknown', 'unavailable', 'available'] as const;
    const recoveries = [null, ...Object.values(RECOVERY_SHAPES)] as const;
    let combinations = 0;

    for (const localRole of roles) for (const policy of policies) {
      for (const phone of phones) for (const independentExit of exits) {
        for (const recoveryKey of recoveries) {
          const input = evidence({
            vault: knownVault({ localRole, policy, phone, independentExit, recoveryKey }),
          });
          const first = presentExtensionRecoveryCenter(input);
          const second = presentExtensionRecoveryCenter(input);
          expect(second).toEqual(first);
          expect(first.items).toHaveLength(RECOVERY_CENTER_ITEM_IDS.length);

          if (localRole === 'unknown') expect(item(first, 'vault-computer').state).not.toBe('ready');
          if (phone === 'unknown') expect(item(first, 'vault-phone').state).not.toBe('ready');
          if (recoveryKey === null) {
            expect(item(first, 'vault-recovery-key').state).not.toBe('ready');
            expect(item(first, 'vault-recovery-kit').state).not.toBe('ready');
          }
          if (independentExit !== 'available') {
            expect(item(first, 'vault-independent-exit').state).not.toBe('ready');
          }
          combinations += 1;
        }
      }
    }
    expect(combinations).toBe(4 * 4 * 3 * 3 * 9);
  });

  it('collapses a genuinely absent Vault to one calm setup action', () => {
    const result = presentExtensionRecoveryCenter(evidence({
      vault: knownVault({
        localRole: 'absent', policy: 'absent', phone: 'unknown', recoveryKey: null,
        independentExit: 'available',
      }),
    }));

    expect(result.vaultNotSetUp).toBe(true);
    expect(result.primaryActionId).toBe('setup-vault');
    expect(result.items.slice(3).every(({ state }) => state === 'not_applicable')).toBe(true);
  });

  it('does not place secrets, identifiers, or technical protocol values in normal summary data', () => {
    const result = presentExtensionRecoveryCenter(evidence());
    const serialized = JSON.stringify(result);

    for (const forbidden of [
      'mnemonic', 'passphrase', 'private', 'xpub', 'descriptor', 'derivation',
      'policyId', 'vaultId', 'sessionId', 'psbt', 'quorum', 'digest', 'desktop-a',
      'mobile-b', 'recovery-c',
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('fails an unexpected word count closed without losing other verified facts', () => {
    const malformedWordCount = 13 as SpendingRecoveryWordCount;
    const result = presentExtensionRecoveryCenter(evidence({
      vaultCapability: false,
      spending: {
        state: 'known', backupVerified: true,
        metadata: { ...HEALTHY_SPENDING, wordCount: malformedWordCount },
      },
    }));

    expect(result.spendingWordCount).toBeNull();
    expect(item(result, 'spending-backup').state).toBe('ready');
  });
});
