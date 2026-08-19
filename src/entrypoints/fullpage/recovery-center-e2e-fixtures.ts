/**
 * Fixed, non-secret Recovery Center views for the packaged test channel.
 *
 * This module is loaded only behind the compile-time `test` branch in the RPC
 * client. Production/preview/pilot output is scanned for the marker below so
 * neither this selector nor its fixture records can ship in those artifacts.
 */

export const RECOVERY_CENTER_E2E_ISOLATION_MARKER = 'DREY_RECOVERY_CENTER_E2E_ONLY';
export const RECOVERY_CENTER_E2E_QUERY = 'dreyRecoveryScenario';

export const RECOVERY_CENTER_E2E_SCENARIO_IDS = [
  'spending-never-rechecked',
  'spending-healthy',
  'vault-partial',
  'vault-ready',
  'vault-unusable',
] as const;

export type RecoveryCenterE2eScenarioId = typeof RECOVERY_CENTER_E2E_SCENARIO_IDS[number];

const EXPECTED_VAULT_ID = 'recovery-center-safe-view';
const EXPECTED_SESSION_ID = '00000000-0000-4000-8000-000000000042';
const FIXED_CHECK_AT = Date.UTC(2026, 6, 15, 12, 0, 0);

const SESSION_SNAPSHOT = {
  vaults: [{ vaultId: EXPECTED_VAULT_ID, name: 'Recovery Center', createdAt: FIXED_CHECK_AT }],
  quarantinedVaultCount: 0,
  locked: false,
  activeVaultId: EXPECTED_VAULT_ID,
  sessionId: EXPECTED_SESSION_ID,
  // Far enough away that the fixture cannot create an immediate refresh loop.
  deadline: 8_000_000_000_000,
  highSecurityMode: false,
  activeAccountId: null,
  activeAccount: 0,
  selectableAccounts: [0],
  accountSummaries: [],
  accountAddState: null,
  activeRecoveredAddressCount: 0,
  backupVerified: true,
  backupMetadata: undefined,
  capabilities: {
    signMethod: 'software',
    canView: true,
    canDeriveAddresses: true,
    canPlanTransactions: true,
    canSignTransactions: true,
    canSignMessages: true,
    canBroadcast: true,
    canExposeToProviders: true,
    canUseMarketplaces: true,
    canBuildUnsignedPsbt: true,
    canSignPsbt: true,
    canSignBip322: true,
    canRevealSeed: true,
    canExportPublicAccount: true,
    canVerifyAddress: false,
  },
} as const;

const NEVER_RECHECKED_METADATA = {
  version: 1,
  origin: 'generated',
  usageGatePassed: true,
  wordCount: 12,
  usesPassphrase: false,
  lastSpotCheckAt: null,
  lastFullRecoveryCheckAt: null,
} as const;

const HEALTHY_METADATA = {
  ...NEVER_RECHECKED_METADATA,
  lastSpotCheckAt: FIXED_CHECK_AT,
  lastFullRecoveryCheckAt: FIXED_CHECK_AT,
} as const;

const ABSENT_VAULT = {
  state: 'not_started',
  localRole: 'absent',
  policyState: 'absent',
  phoneSignerPaired: false,
  standaloneRecoveryPackageAvailable: true,
  policyId: null,
  setupComplete: false,
  kitExported: false,
  backupCheckComplete: false,
  ready: false,
} as const;

const SCENARIOS = {
  'spending-never-rechecked': {
    backup: { backupVerified: true, metadata: NEVER_RECHECKED_METADATA },
    vault: ABSENT_VAULT,
  },
  'spending-healthy': {
    backup: { backupVerified: true, metadata: HEALTHY_METADATA },
    vault: ABSENT_VAULT,
  },
  'vault-partial': {
    backup: { backupVerified: true, metadata: HEALTHY_METADATA },
    vault: {
      state: 'kit_required',
      localRole: 'usable',
      policyState: 'usable',
      phoneSignerPaired: true,
      standaloneRecoveryPackageAvailable: true,
      policyId: '11'.repeat(32),
      setupComplete: true,
      kitExported: false,
      backupCheckComplete: false,
      ready: false,
    },
  },
  'vault-ready': {
    backup: { backupVerified: true, metadata: HEALTHY_METADATA },
    vault: {
      state: 'ready',
      localRole: 'usable',
      policyState: 'usable',
      phoneSignerPaired: true,
      standaloneRecoveryPackageAvailable: true,
      policyId: '22'.repeat(32),
      setupComplete: true,
      kitExported: true,
      backupCheckComplete: true,
      ready: true,
    },
  },
  'vault-unusable': {
    backup: { backupVerified: true, metadata: HEALTHY_METADATA },
    vault: {
      state: 'unusable',
      localRole: 'unusable',
      policyState: 'unusable',
      phoneSignerPaired: false,
      standaloneRecoveryPackageAvailable: true,
      policyId: null,
      setupComplete: false,
      kitExported: false,
      backupCheckComplete: false,
      ready: false,
    },
  },
} as const satisfies Record<RecoveryCenterE2eScenarioId, {
  backup: object;
  vault: object;
}>;

export type RecoveryCenterE2eFixtureResult =
  | { requested: false }
  | { requested: true; response: unknown };

function selectedScenario(href: string): RecoveryCenterE2eScenarioId | null | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  const requested = url.searchParams.getAll(RECOVERY_CENTER_E2E_QUERY);
  if (requested.length === 0) return undefined;
  if (requested.length !== 1 || !url.pathname.endsWith('/fullpage.html') ||
      url.hash !== '#/settings/recovery') return null;
  const candidate = requested[0];
  return RECOVERY_CENTER_E2E_SCENARIO_IDS.find((id) => id === candidate) ?? null;
}

function hasExpectedSession(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const value = payload as Record<string, unknown>;
  return value['expectedVaultId'] === EXPECTED_VAULT_ID &&
    value['expectedSessionId'] === EXPECTED_SESSION_ID;
}

/** Return a raw worker-shaped response, or decline when no fixture was requested. */
export function recoveryCenterE2eFixtureResponse(
  op: string,
  payload: unknown,
  href: string,
): RecoveryCenterE2eFixtureResult {
  const selected = selectedScenario(href);
  if (selected === undefined) return { requested: false };
  if (selected === null) {
    return { requested: true, response: { ok: false, code: 'ERR_INTERNAL' } };
  }

  if (op === 'session.snapshot') {
    return { requested: true, response: { ok: true, result: SESSION_SNAPSHOT } };
  }
  if (!hasExpectedSession(payload)) {
    return { requested: true, response: { ok: false, code: 'ERR_SESSION_STALE' } };
  }
  if (op === 'backup.status') {
    return { requested: true, response: { ok: true, result: SCENARIOS[selected].backup } };
  }
  if (op === 'vaultCoordinator.recoveryCReadiness') {
    return { requested: true, response: { ok: true, result: SCENARIOS[selected].vault } };
  }
  if (op === 'session.touch') {
    return {
      requested: true,
      response: { ok: true, result: { deadline: SESSION_SNAPSHOT.deadline } },
    };
  }
  // The overview fixtures never emulate ceremonies or mutations.
  return { requested: true, response: { ok: false, code: 'ERR_INTERNAL' } };
}
