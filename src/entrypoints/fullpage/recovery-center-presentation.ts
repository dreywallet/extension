/**
 * Pure Recovery Center presentation for the extension.
 *
 * This module deliberately accepts only bounded, already-local evidence. It
 * does not parse stored records, inspect keys, derive addresses, or contact a
 * service. In particular, `unknown` is evidence absence and can never become a
 * reassuring state.
 */

export const RECOVERY_CENTER_ITEM_IDS = [
  'spending-backup',
  'spending-spot-check',
  'spending-full-recovery',
  'vault-computer',
  'vault-phone',
  'vault-recovery-key',
  'vault-recovery-kit',
  'vault-independent-exit',
] as const;

export type RecoveryCenterItemId = typeof RECOVERY_CENTER_ITEM_IDS[number];

export type RecoveryPresentationState =
  | 'ready'
  | 'action_needed'
  | 'not_checked'
  | 'not_applicable';

export type RecoveryCenterActionId =
  | 'repair-vault'
  | 'continue-recovery-key'
  | 'save-recovery-kit'
  | 'verify-vault-backup'
  | 'verify-spending-backup'
  | 'test-full-recovery'
  | 'spot-check'
  | 'setup-vault'
  | 'open-vault';

export type RecoveryTechnicalDetailReference =
  | 'spending-generation'
  | 'vault-computer-role'
  | 'vault-policy'
  | 'vault-recovery-key'
  | 'vault-recovery-kit'
  | 'vault-independent-exit';

export type RecoveryPresentationLabelKey =
  | 'recovery.overview.spending.backup'
  | 'recovery.overview.spending.spotCheck'
  | 'recovery.overview.spending.fullTest'
  | 'recovery.overview.vault.computer'
  | 'recovery.overview.vault.phone'
  | 'recovery.overview.vault.recoveryKey'
  | 'recovery.overview.vault.recoveryKit'
  | 'recovery.overview.vault.independentRecovery';

export type RecoveryPresentationValueKey =
  | 'recovery.overview.state.ready'
  | 'recovery.overview.state.actionNeeded'
  | 'recovery.overview.state.notChecked'
  | 'recovery.overview.state.notApplicable'
  | 'recovery.overview.spending.backupChecked'
  | 'recovery.overview.spending.backupNeedsCheck'
  | 'recovery.overview.vault.computerReady'
  | 'recovery.overview.vault.computerNeedsVerification'
  | 'recovery.overview.vault.computerUnusable'
  | 'recovery.overview.vault.phonePaired'
  | 'recovery.overview.vault.phoneNotPaired'
  | 'recovery.overview.vault.phoneNotChecked'
  | 'recovery.overview.vault.recoveryKeyChecked'
  | 'recovery.overview.vault.recoveryKeyNeedsCheck'
  | 'recovery.overview.vault.recoveryKeyIncomplete'
  | 'recovery.overview.vault.recoveryKeyNotChecked'
  | 'recovery.overview.vault.recoveryKitSaved'
  | 'recovery.overview.vault.recoveryKitNeedsSave'
  | 'recovery.overview.vault.recoveryKitNotChecked'
  | 'recovery.overview.vault.independentRecoveryAvailable'
  | 'recovery.overview.vault.independentRecoveryUnavailable'
  | 'recovery.overview.vault.unusable';

export interface RecoveryPresentationItem {
  id: RecoveryCenterItemId;
  state: RecoveryPresentationState;
  labelKey: RecoveryPresentationLabelKey;
  valueKey: RecoveryPresentationValueKey;
  verifiedAt?: number;
  actionId?: RecoveryCenterActionId;
  technicalDetailReference?: RecoveryTechnicalDetailReference;
}

export type SpendingRecoveryWordCount = 12 | 15 | 18 | 21 | 24;

export interface SpendingBackupMetadataEvidence {
  origin: 'generated' | 'imported' | 'legacy_unknown';
  usageGatePassed: boolean;
  wordCount: SpendingRecoveryWordCount | null;
  usesPassphrase: boolean | null;
  lastSpotCheckAt: number | null;
  lastFullRecoveryCheckAt: number | null;
}

export type SpendingReadinessEvidence =
  | { state: 'unknown' }
  | {
      state: 'known';
      backupVerified: boolean;
      metadata: SpendingBackupMetadataEvidence | null;
    };

export type VaultLocalRoleEvidence = 'unknown' | 'absent' | 'usable' | 'unusable';
export type VaultPolicyEvidence = 'unknown' | 'absent' | 'present' | 'unusable';
export type VaultPhoneEvidence = 'unknown' | 'not_paired' | 'paired';
export type IndependentExitEvidence = 'unknown' | 'unavailable' | 'available';

export type RecoveryKeyReadinessState =
  | 'not_started'
  | 'setup_open'
  | 'setup_complete'
  | 'kit_required'
  | 'backup_required'
  | 'backup_open'
  | 'ready'
  | 'unusable';

/** The non-identifying facts returned by recoveryCReadiness. */
export interface RecoveryKeyReadinessEvidence {
  state: RecoveryKeyReadinessState;
  setupComplete: boolean;
  kitExported: boolean;
  backupCheckComplete: boolean;
  ready: boolean;
}

export type ExtensionVaultReadinessEvidence =
  | { state: 'unknown' }
  | {
      state: 'known';
      available: boolean;
      localRole: VaultLocalRoleEvidence;
      policy: VaultPolicyEvidence;
      phone: VaultPhoneEvidence;
      recoveryKey: RecoveryKeyReadinessEvidence | null;
      independentExit: IndependentExitEvidence;
    };

export interface ExtensionRecoveryCenterEvidence {
  /** A compile-time value. Stored or runtime data must not enable Vault UI. */
  vaultCapability: boolean;
  now: number;
  spending: SpendingReadinessEvidence;
  vault: ExtensionVaultReadinessEvidence;
}

export interface ExtensionRecoveryCenterPresentation {
  items: readonly RecoveryPresentationItem[];
  primaryActionId: RecoveryCenterActionId | null;
  spendingWordCount: SpendingRecoveryWordCount | null;
  vaultNotSetUp: boolean;
}

const WORD_COUNTS: readonly SpendingRecoveryWordCount[] = [12, 15, 18, 21, 24];

const ITEM_LABEL_KEYS: Record<RecoveryCenterItemId, RecoveryPresentationLabelKey> = {
  'spending-backup': 'recovery.overview.spending.backup',
  'spending-spot-check': 'recovery.overview.spending.spotCheck',
  'spending-full-recovery': 'recovery.overview.spending.fullTest',
  'vault-computer': 'recovery.overview.vault.computer',
  'vault-phone': 'recovery.overview.vault.phone',
  'vault-recovery-key': 'recovery.overview.vault.recoveryKey',
  'vault-recovery-kit': 'recovery.overview.vault.recoveryKit',
  'vault-independent-exit': 'recovery.overview.vault.independentRecovery',
};

function validTimestamp(value: number | null, now: number): number | undefined {
  if (value === null || !Number.isFinite(now) || !Number.isInteger(now) || now < 0 ||
      !Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > now) {
    return undefined;
  }
  return value;
}

function validWordCount(value: SpendingRecoveryWordCount | null): SpendingRecoveryWordCount | null {
  return value !== null && WORD_COUNTS.includes(value) ? value : null;
}

function item(
  id: RecoveryCenterItemId,
  state: RecoveryPresentationState,
  valueKey: RecoveryPresentationValueKey,
  options: {
    verifiedAt?: number;
    actionId?: RecoveryCenterActionId;
    technicalDetailReference?: RecoveryTechnicalDetailReference;
  } = {},
): RecoveryPresentationItem {
  return { id, state, labelKey: ITEM_LABEL_KEYS[id], valueKey, ...options };
}

function spendingItems(evidence: SpendingReadinessEvidence, now: number): {
  items: readonly RecoveryPresentationItem[];
  wordCount: SpendingRecoveryWordCount | null;
  backupNeedsAction: boolean;
  fullNeedsAction: boolean;
  spotNeedsAction: boolean;
} {
  if (evidence.state === 'unknown') {
    return {
      items: [
        item('spending-backup', 'not_checked', 'recovery.overview.state.notChecked', {
          technicalDetailReference: 'spending-generation',
        }),
        item('spending-spot-check', 'not_checked', 'recovery.overview.state.notChecked'),
        item(
          'spending-full-recovery',
          'not_checked',
          'recovery.overview.state.notChecked',
        ),
      ],
      wordCount: null,
      backupNeedsAction: false,
      fullNeedsAction: false,
      spotNeedsAction: false,
    };
  }

  if (evidence.metadata === null) {
    return {
      items: [
        item('spending-backup', 'action_needed', 'recovery.overview.spending.backupNeedsCheck', {
          actionId: 'verify-spending-backup',
          technicalDetailReference: 'spending-generation',
        }),
        item('spending-spot-check', 'not_checked', 'recovery.overview.state.notChecked', {
          actionId: 'spot-check',
        }),
        item('spending-full-recovery', 'not_checked', 'recovery.overview.state.notChecked', {
          actionId: 'test-full-recovery',
        }),
      ],
      wordCount: null,
      backupNeedsAction: true,
      fullNeedsAction: true,
      spotNeedsAction: true,
    };
  }

  const metadata = evidence.metadata;
  const backupReady = evidence.backupVerified && metadata.usageGatePassed;
  const spotAt = validTimestamp(metadata.lastSpotCheckAt, now);
  const fullAt = validTimestamp(metadata.lastFullRecoveryCheckAt, now);
  return {
    items: [
      backupReady
        ? item('spending-backup', 'ready', 'recovery.overview.spending.backupChecked', {
            technicalDetailReference: 'spending-generation',
          })
        : item('spending-backup', 'action_needed', 'recovery.overview.spending.backupNeedsCheck', {
            actionId: 'verify-spending-backup',
            technicalDetailReference: 'spending-generation',
          }),
      spotAt === undefined
        ? item('spending-spot-check', 'not_checked', 'recovery.overview.state.notChecked', {
            actionId: 'spot-check',
          })
        : item('spending-spot-check', 'ready', 'recovery.overview.state.ready', {
            verifiedAt: spotAt,
            actionId: 'spot-check',
          }),
      fullAt === undefined
        ? item(
            'spending-full-recovery',
            'not_checked',
            'recovery.overview.state.notChecked',
            { actionId: 'test-full-recovery' },
          )
        : item('spending-full-recovery', 'ready', 'recovery.overview.state.ready', {
            verifiedAt: fullAt,
            actionId: 'test-full-recovery',
          }),
    ],
    wordCount: validWordCount(metadata.wordCount),
    backupNeedsAction: !backupReady,
    fullNeedsAction: fullAt === undefined,
    spotNeedsAction: spotAt === undefined,
  };
}

function notApplicableVaultItems(): readonly RecoveryPresentationItem[] {
  return [
    item('vault-computer', 'not_applicable', 'recovery.overview.state.notApplicable'),
    item('vault-phone', 'not_applicable', 'recovery.overview.state.notApplicable'),
    item('vault-recovery-key', 'not_applicable', 'recovery.overview.state.notApplicable'),
    item('vault-recovery-kit', 'not_applicable', 'recovery.overview.state.notApplicable'),
    item(
      'vault-independent-exit',
      'not_applicable',
      'recovery.overview.state.notApplicable',
    ),
  ];
}

function canonicalRecoveryKeyShape(value: RecoveryKeyReadinessEvidence): boolean {
  switch (value.state) {
    case 'not_started':
    case 'setup_open':
      return !value.setupComplete && !value.kitExported &&
        !value.backupCheckComplete && !value.ready;
    case 'setup_complete':
    case 'kit_required':
      return value.setupComplete && !value.kitExported &&
        !value.backupCheckComplete && !value.ready;
    case 'backup_required':
    case 'backup_open':
      return value.setupComplete && value.kitExported &&
        !value.backupCheckComplete && !value.ready;
    case 'ready':
      return value.setupComplete && value.kitExported &&
        value.backupCheckComplete && value.ready;
    case 'unusable':
      return false;
  }
}

function vaultHasConflict(evidence: Extract<ExtensionVaultReadinessEvidence, { state: 'known' }>): boolean {
  if (!evidence.available || evidence.localRole === 'unusable' || evidence.policy === 'unusable') {
    return true;
  }
  if (evidence.localRole === 'absent' &&
      (evidence.policy === 'present' || evidence.phone === 'paired' || evidence.recoveryKey !== null)) {
    return true;
  }
  if ((evidence.policy === 'absent' && evidence.phone === 'paired') ||
      (evidence.policy === 'present' && evidence.phone === 'not_paired')) {
    return true;
  }
  const recovery = evidence.recoveryKey;
  if (recovery === null) return false;
  if (recovery.state === 'unusable' || !canonicalRecoveryKeyShape(recovery)) return true;
  if (evidence.policy === 'absent' && [
    'kit_required', 'backup_required', 'backup_open', 'ready',
  ].includes(recovery.state)) {
    return true;
  }
  if (evidence.policy === 'present' && recovery.state === 'setup_complete') return true;
  return false;
}

interface VaultItemsResult {
  items: readonly RecoveryPresentationItem[];
  conflict: boolean;
  recoverySetupNeedsAction: boolean;
  kitNeedsAction: boolean;
  recoveryBackupNeedsAction: boolean;
  setupVaultAction: boolean;
  openVaultAction: boolean;
  notSetUp: boolean;
}

function vaultItems(
  capability: boolean,
  evidence: ExtensionVaultReadinessEvidence,
): VaultItemsResult {
  if (!capability) {
    return {
      items: notApplicableVaultItems(), conflict: false, recoverySetupNeedsAction: false,
      kitNeedsAction: false, recoveryBackupNeedsAction: false, setupVaultAction: false,
      openVaultAction: false, notSetUp: false,
    };
  }
  if (evidence.state === 'unknown') {
    return {
      items: [
        item('vault-computer', 'not_checked', 'recovery.overview.vault.computerNeedsVerification', {
          actionId: 'open-vault', technicalDetailReference: 'vault-computer-role',
        }),
        item('vault-phone', 'not_checked', 'recovery.overview.vault.phoneNotChecked', {
          technicalDetailReference: 'vault-policy',
        }),
        item('vault-recovery-key', 'not_checked', 'recovery.overview.vault.recoveryKeyNotChecked', {
          technicalDetailReference: 'vault-recovery-key',
        }),
        item('vault-recovery-kit', 'not_checked', 'recovery.overview.vault.recoveryKitNotChecked', {
          technicalDetailReference: 'vault-recovery-kit',
        }),
        item('vault-independent-exit', 'not_checked', 'recovery.overview.state.notChecked', {
          technicalDetailReference: 'vault-independent-exit',
        }),
      ],
      conflict: false, recoverySetupNeedsAction: false, kitNeedsAction: false,
      recoveryBackupNeedsAction: false, setupVaultAction: false, openVaultAction: true,
      notSetUp: false,
    };
  }

  const notSetUp = evidence.available && evidence.localRole === 'absent' &&
    evidence.policy === 'absent' && evidence.phone !== 'paired' && evidence.recoveryKey === null;
  if (notSetUp) {
    return {
      items: notApplicableVaultItems(), conflict: false, recoverySetupNeedsAction: false,
      kitNeedsAction: false, recoveryBackupNeedsAction: false, setupVaultAction: true,
      openVaultAction: false, notSetUp: true,
    };
  }

  const conflict = vaultHasConflict(evidence);
  const recovery = conflict ? null : evidence.recoveryKey;
  const roleUsable = evidence.available && evidence.localRole === 'usable';
  const roleAbsent = evidence.available && evidence.localRole === 'absent';
  const phonePaired = evidence.policy === 'present' && evidence.phone === 'paired';
  const recoveryReady = recovery?.state === 'ready';
  const kitReady = recovery !== null && recovery.kitExported;
  const setupNeedsAction = recovery !== null &&
    (recovery.state === 'not_started' || recovery.state === 'setup_open');
  const kitNeedsAction = recovery !== null && recovery.setupComplete &&
    evidence.policy === 'present' && !recovery.kitExported;
  const backupNeedsAction = recovery !== null && recovery.setupComplete &&
    recovery.kitExported && !recovery.backupCheckComplete;

  return {
    items: [
      roleUsable
        ? item('vault-computer', 'ready', 'recovery.overview.vault.computerReady', {
            actionId: 'open-vault', technicalDetailReference: 'vault-computer-role',
          })
        : roleAbsent && !conflict
          ? item('vault-computer', 'action_needed', 'recovery.overview.vault.computerNeedsVerification', {
              actionId: 'setup-vault', technicalDetailReference: 'vault-computer-role',
            })
          : item('vault-computer', conflict ? 'action_needed' : 'not_checked',
              conflict
                ? 'recovery.overview.vault.computerUnusable'
                : 'recovery.overview.vault.computerNeedsVerification', {
                actionId: conflict ? 'repair-vault' : 'open-vault',
                technicalDetailReference: 'vault-computer-role',
              }),
      phonePaired && !conflict
        ? item('vault-phone', 'ready', 'recovery.overview.vault.phonePaired', {
            actionId: 'open-vault', technicalDetailReference: 'vault-policy',
          })
        : item('vault-phone',
            conflict || evidence.phone === 'not_paired' ? 'action_needed' : 'not_checked',
            conflict
              ? 'recovery.overview.vault.unusable'
              : evidence.phone === 'not_paired'
                ? 'recovery.overview.vault.phoneNotPaired'
                : 'recovery.overview.vault.phoneNotChecked', {
              actionId: conflict ? 'repair-vault' : 'open-vault',
              technicalDetailReference: 'vault-policy',
            }),
      recoveryReady && !conflict
        ? item('vault-recovery-key', 'ready', 'recovery.overview.vault.recoveryKeyChecked', {
            actionId: 'open-vault', technicalDetailReference: 'vault-recovery-key',
          })
        : item('vault-recovery-key',
            conflict || recovery !== null ? 'action_needed' : 'not_checked',
            conflict
              ? 'recovery.overview.vault.unusable'
              : recovery !== null
                ? setupNeedsAction
                  ? 'recovery.overview.vault.recoveryKeyIncomplete'
                  : 'recovery.overview.vault.recoveryKeyNeedsCheck'
                : 'recovery.overview.vault.recoveryKeyNotChecked', {
              actionId: conflict
                ? 'repair-vault'
                : setupNeedsAction
                  ? 'continue-recovery-key'
                  : backupNeedsAction
                    ? 'verify-vault-backup'
                    : 'open-vault',
              technicalDetailReference: 'vault-recovery-key',
            }),
      kitReady && !conflict
        ? item('vault-recovery-kit', 'ready', 'recovery.overview.vault.recoveryKitSaved', {
            actionId: 'open-vault', technicalDetailReference: 'vault-recovery-kit',
          })
        : item('vault-recovery-kit',
            kitNeedsAction ? 'action_needed' : 'not_checked',
            kitNeedsAction
              ? 'recovery.overview.vault.recoveryKitNeedsSave'
              : 'recovery.overview.vault.recoveryKitNotChecked', {
              actionId: conflict ? 'repair-vault' : kitNeedsAction ? 'save-recovery-kit' : 'open-vault',
              technicalDetailReference: 'vault-recovery-kit',
            }),
      evidence.independentExit === 'available' && !conflict
        ? item('vault-independent-exit', 'ready', 'recovery.overview.vault.independentRecoveryAvailable', {
            technicalDetailReference: 'vault-independent-exit',
          })
        : item('vault-independent-exit', 'not_checked',
            evidence.independentExit === 'unavailable'
              ? 'recovery.overview.vault.independentRecoveryUnavailable'
              : 'recovery.overview.state.notChecked', {
              technicalDetailReference: 'vault-independent-exit',
            }),
    ],
    conflict,
    recoverySetupNeedsAction: setupNeedsAction,
    kitNeedsAction,
    recoveryBackupNeedsAction: backupNeedsAction,
    setupVaultAction: roleAbsent && !conflict,
    openVaultAction: !roleAbsent && !conflict,
    notSetUp: false,
  };
}

export function presentExtensionRecoveryCenter(
  evidence: ExtensionRecoveryCenterEvidence,
): ExtensionRecoveryCenterPresentation {
  const spending = spendingItems(evidence.spending, evidence.now);
  const vault = vaultItems(evidence.vaultCapability, evidence.vault);

  // This order is product policy. Keep it explicit rather than deriving it
  // from item order or visual layout.
  const primaryActionId: RecoveryCenterActionId | null = vault.conflict
    ? 'repair-vault'
    : vault.recoverySetupNeedsAction
      ? 'continue-recovery-key'
      : vault.kitNeedsAction
        ? 'save-recovery-kit'
        : vault.recoveryBackupNeedsAction
          ? 'verify-vault-backup'
          : spending.backupNeedsAction
            ? 'verify-spending-backup'
            : spending.fullNeedsAction
              ? 'test-full-recovery'
              : spending.spotNeedsAction
                ? 'spot-check'
                : vault.setupVaultAction
                  ? 'setup-vault'
                  : vault.openVaultAction
                    ? 'open-vault'
                    : null;

  return {
    items: [...spending.items, ...vault.items],
    primaryActionId,
    spendingWordCount: spending.wordCount,
    vaultNotSetUp: vault.notSetUp,
  };
}
