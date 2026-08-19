/**
 * Vault coordinator persistence: Desktop role A (ADR 0007
 * §§1-2, Workstream C0), the pending signer-import ceremony, and the committed
 * watch-only policy (ADR 0007 §§2-4, Workstream C1).
 *
 * Role A is a Bitcoin signing root, so this store's failure posture is the
 * opposite of the passkey envelope store's. A passkey envelope is convenience
 * ciphertext whose loss degrades to password unlock, so a malformed value is
 * dropped. Losing role A destroys one of three Vault roles, so a value that
 * cannot be parsed is preserved untouched and surfaced as unusable — only an
 * explicit removal ever deletes it.
 *
 * Independence from the Spending wallet (ADR 0007 §1) is structural, not
 * merely conventional:
 *
 * - the record lives under its own storage key and is never a member of the
 *   `squirrel:vaults` map, so it has no vault list entry, no active-vault
 *   pointer, and no unlock session;
 * - its secret half is its own `VaultRecordV1` with its own Argon2id salt, its
 *   own random DEK, and its own `roleId`-bound AEAD associated data, so the
 *   Spending wallet's session DEK cannot open it and neither key wraps the
 *   other; and
 * - the seed inside it is a separate CSPRNG generation event, never derived
 *   from S.
 *
 * The public half (the BIP48 signer-origin record) is stored in the clear so a
 * watch-only Vault can be shown without a password. It carries no spending
 * authority but it is privacy-sensitive: an account xpub reveals the role's
 * addresses. This privacy cost is disclosed during deliberate pairing and is
 * accepted for the production watch-only policy; the record never leaves the
 * authenticated owner-to-owner ceremony.
 */
import { z } from 'zod';
import { vaultRecordV1Schema, type VaultRecordV1 } from '@drey/core/domain/vault/record';
import {
  vaultPairingEnvelopeSchema,
  vaultPsbtApprovalEnvelopeSchema,
  vaultSignerOriginSchema,
  type VaultPairingEnvelopeV1,
  type VaultPsbtApprovalEnvelopeV1,
  type VaultSignerOriginV1,
} from '@drey/core/domain/vault/multisig-contracts';
import {
  vaultPolicyRecordSchema,
  type VaultPolicyRecordV1,
} from '@drey/core/domain/vault/multisig-contracts';
import {
  vaultAssetPolicyEvidenceSchema,
  type VaultAssetPolicyEvidenceV1,
} from '@drey/core/domain/vault/multisig-asset-policy';
import {
  vaultBroadcastLifecycleSchema,
  type VaultBroadcastLifecycleV1,
} from '@drey/core/domain/vault/multisig-lifecycle';
import { hexToBytes } from '@drey/core/domain/vault/encoding';
import {
  parseRecoveryCBackupCheckChallenge,
  parseRecoveryCSetupChallenge,
  recoveryCBackupCheckChallengeDigest,
  recoveryCSetupChallengeDigest,
} from '@drey/core/domain/vault/multisig-encoding';
import type { VaultCoordinatorNetwork } from '../../background/vault-capability';
import { getJson, setJson, type StorageArea } from './area';
import {
  VAULT_COORDINATOR_IMPORT_KEY,
  VAULT_COORDINATOR_PLANS_KEY,
  VAULT_COORDINATOR_POLICY_KEY,
  VAULT_COORDINATOR_RECOVERY_C_KEY,
  VAULT_COORDINATOR_ROLE_KEY,
} from './keys';

/**
 * The stored origin, narrowed to what C0 can actually hold. Structurally a
 * core `VaultSignerOriginV1`, but with role and network pinned to literals so
 * a non-Desktop origin is a type error here, not only a runtime
 * rejection by the schema below.
 */
export type VaultCoordinatorOriginV1 = VaultSignerOriginV1 & {
  role: 'desktop-a';
  network: VaultCoordinatorNetwork;
};

export interface VaultCoordinatorRoleRecordV1 {
  schemaVersion: 1;
  /** Stable identifier for this role; also the secret record's AEAD binding. */
  roleId: string;
  /** This extension mints Desktop A only. Mobile B is generated on mobile. */
  role: 'desktop-a';
  network: VaultCoordinatorNetwork;
  createdAt: number;
  label: string;
  origin: VaultCoordinatorOriginV1;
  secret: VaultRecordV1;
}

export const vaultCoordinatorRoleRecordSchema: z.ZodType<VaultCoordinatorRoleRecordV1> = z
  .object({
    schemaVersion: z.literal(1),
    // Deliberately not `.uuid()`: the format is the composition root's choice
    // (production mints crypto.randomUUID), and what actually matters is the
    // agreement with the secret record's AEAD binding, checked below.
    roleId: z.string().min(1).max(64),
    role: z.literal('desktop-a'),
    network: z.enum(['signet', 'mainnet']),
    createdAt: z.number().int().nonnegative(),
    label: z.string().max(64),
    origin: vaultSignerOriginSchema as z.ZodType<VaultCoordinatorOriginV1>,
    secret: vaultRecordV1Schema,
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.origin.role !== record.role || record.origin.network !== record.network) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['origin'],
        message: 'signer origin must match the stored role and network',
      });
    }
    if (record.secret.vaultId !== record.roleId) {
      // The secret half's AEAD associated data binds `vaultId`. If it named a
      // different id the ciphertext would belong to some other record, so this
      // rejects a swapped or grafted secret rather than trying to open it.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['secret'],
        message: 'secret record is not bound to this roleId',
      });
    }
  });

/** What is stored today, without deciding whether it is usable. */
export type StoredVaultRole =
  | { state: 'absent' }
  | { state: 'valid'; record: VaultCoordinatorRoleRecordV1 }
  | { state: 'unusable' };

export async function loadVaultRole(area: StorageArea): Promise<StoredVaultRole> {
  const raw = await getJson<unknown>(area, VAULT_COORDINATOR_ROLE_KEY);
  if (raw === undefined || raw === null) return { state: 'absent' };
  const parsed = vaultCoordinatorRoleRecordSchema.safeParse(raw);
  // Deliberately not deleted or repaired: an unreadable role is reported so a
  // human can decide, never silently discarded.
  if (!parsed.success) return { state: 'unusable' };
  return { state: 'valid', record: parsed.data };
}

export async function saveVaultRole(
  area: StorageArea,
  record: VaultCoordinatorRoleRecordV1,
): Promise<void> {
  await setJson(area, VAULT_COORDINATOR_ROLE_KEY, vaultCoordinatorRoleRecordSchema.parse(record));
}

export async function clearVaultRole(area: StorageArea): Promise<void> {
  await area.remove(VAULT_COORDINATOR_ROLE_KEY);
}

// ---- pending signer import (ADR 0007 §2, Workstream C1) --------------------

/**
 * A peer origin that has proven possession against this coordinator's own
 * challenge. Only the two roles the extension never generates can appear here:
 * role A comes from local generation, and admitting it would let an import
 * replace the local signing root with a foreign xpub.
 */
export type VaultImportedRole = 'mobile-b' | 'recovery-c';

/**
 * The in-progress import ceremony.
 *
 * The challenge is minted by this coordinator and stored before any peer sees
 * it, because proof of possession is only worth anything when the *verifier*
 * chose the nonce. A peer-supplied challenge would let an attacker replay a
 * proof captured from some other session, so a stored session is the only thing
 * an accepted proof may be verified against.
 */
export interface VaultImportSessionV1 {
  schemaVersion: 1;
  network: 'signet' | 'mainnet';
  createdAt: number;
  sessionIdHex: string;
  challengeNonceHex: string;
  transcriptHashHex: string;
  expiresAtMs: string;
  /**
   * Origins accepted so far, keyed by the role slot they were imported into.
   * Spelled with explicit `| undefined` rather than `Partial<>` because
   * `exactOptionalPropertyTypes` distinguishes an absent key from a present
   * `undefined`, and zod's `.optional()` produces the latter.
   */
  signers: {
    'mobile-b'?: VaultSignerOriginV1 | undefined;
    'recovery-c'?: VaultSignerOriginV1 | undefined;
  };
}

const hexOf = (bytes: number): z.ZodType<string> =>
  z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'u'));

export const vaultImportSessionSchema: z.ZodType<VaultImportSessionV1> = z
  .object({
    schemaVersion: z.literal(1),
    network: z.enum(['signet', 'mainnet']),
    createdAt: z.number().int().nonnegative(),
    sessionIdHex: hexOf(16),
    challengeNonceHex: hexOf(32),
    transcriptHashHex: hexOf(32),
    expiresAtMs: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
    signers: z
      .object({
        'mobile-b': vaultSignerOriginSchema.optional(),
        'recovery-c': vaultSignerOriginSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((session, ctx) => {
    for (const role of ['mobile-b', 'recovery-c'] as const) {
      const origin = session.signers[role];
      if (origin === undefined) continue;
      if (origin.role !== role || origin.network !== session.network) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['signers', role],
          message: 'imported origin must match its role slot and the session network',
        });
      }
    }
  });

export async function loadVaultImportSession(
  area: StorageArea,
): Promise<VaultImportSessionV1 | null> {
  const raw = await getJson<unknown>(area, VAULT_COORDINATOR_IMPORT_KEY);
  if (raw === undefined || raw === null) return null;
  // Unlike the role and policy records this is not recovery material: it is
  // transient setup state whose worst-case loss is restarting the import. An
  // unreadable value is therefore reported as absent rather than as a state a
  // human has to adjudicate.
  const parsed = vaultImportSessionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function saveVaultImportSession(
  area: StorageArea,
  session: VaultImportSessionV1,
): Promise<void> {
  await setJson(area, VAULT_COORDINATOR_IMPORT_KEY, vaultImportSessionSchema.parse(session));
}

export async function clearVaultImportSession(area: StorageArea): Promise<void> {
  await area.remove(VAULT_COORDINATOR_IMPORT_KEY);
}

// ---- Recovery C offline setup and paper restore ---------------------------

export interface VaultRecoveryCOpenChallengeV1 {
  challengeHex: string;
  challengeDigestHex: string;
  createdAt: number;
  expiresAtMs: string;
}

export interface VaultRecoveryCCeremonyStateV1 {
  schemaVersion: 1;
  setup: {
    open: VaultRecoveryCOpenChallengeV1 | null;
    completed: {
      challengeDigestHex: string;
      origin: VaultSignerOriginV1 & { role: 'recovery-c' };
      completedAt: number;
    } | null;
  };
  policy: {
    policyId: string;
    ceremony: 'paper-mnemonic-offline-v1';
    kitExportedAt: number | null;
    backupCheck: {
      open: VaultRecoveryCOpenChallengeV1 | null;
      completedAt: number | null;
    };
  } | null;
}

const openRecoveryCChallengeSchema: z.ZodType<VaultRecoveryCOpenChallengeV1> = z.object({
  challengeHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u).max(131_072),
  challengeDigestHex: hexOf(32),
  createdAt: z.number().int().nonnegative(),
  expiresAtMs: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
}).strict();

export const vaultRecoveryCCeremonyStateSchema: z.ZodType<VaultRecoveryCCeremonyStateV1> = z.object({
  schemaVersion: z.literal(1),
  setup: z.object({
    open: openRecoveryCChallengeSchema.nullable(),
    completed: z.object({
      challengeDigestHex: hexOf(32),
      origin: vaultSignerOriginSchema.and(z.object({ role: z.literal('recovery-c') })),
      completedAt: z.number().int().nonnegative(),
    }).strict().nullable(),
  }).strict(),
  policy: z.object({
    policyId: hexOf(32),
    ceremony: z.literal('paper-mnemonic-offline-v1'),
    kitExportedAt: z.number().int().nonnegative().nullable(),
    backupCheck: z.object({
      open: openRecoveryCChallengeSchema.nullable(),
      completedAt: z.number().int().nonnegative().nullable(),
    }).strict(),
  }).strict().nullable(),
}).strict().superRefine((state, ctx) => {
  if (state.setup.open !== null) {
    try {
      const challenge = parseRecoveryCSetupChallenge(hexToBytes(state.setup.open.challengeHex));
      if (recoveryCSetupChallengeDigest(challenge) !== state.setup.open.challengeDigestHex ||
          Number(challenge.createdAtMs) !== state.setup.open.createdAt ||
          challenge.expiresAtMs !== state.setup.open.expiresAtMs) {
        throw new Error('stored setup challenge metadata does not match its bytes');
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['setup', 'open'],
        message: 'open Recovery C setup challenge must be one exact canonical record',
      });
    }
  }
  if (state.policy !== null && state.setup.completed === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['policy'],
      message: 'a policy-bound Recovery C ceremony requires completed offline setup',
    });
  }
  if (state.setup.open !== null && state.setup.completed !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['setup'],
      message: 'Recovery C setup cannot be open and completed at the same time',
    });
  }
  if (state.policy?.backupCheck.open !== null && state.policy?.kitExportedAt === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['policy', 'backupCheck'],
      message: 'backup check requires an acknowledged public recovery-kit export',
    });
  }
  if (state.policy?.backupCheck.completedAt !== null && state.policy?.kitExportedAt === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['policy', 'backupCheck', 'completedAt'],
      message: 'backup completion requires an acknowledged public recovery-kit export',
    });
  }
  if (state.policy !== null && state.policy.backupCheck.open !== null &&
      state.policy.backupCheck.completedAt !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['policy', 'backupCheck'],
      message: 'Recovery C backup check cannot be open and completed at the same time',
    });
  }
  if (state.policy?.backupCheck.open !== null && state.policy?.backupCheck.open !== undefined) {
    try {
      const open = state.policy.backupCheck.open;
      const challenge = parseRecoveryCBackupCheckChallenge(hexToBytes(open.challengeHex));
      if (challenge.policyId !== state.policy.policyId ||
          recoveryCBackupCheckChallengeDigest(challenge) !== open.challengeDigestHex ||
          Number(challenge.createdAtMs) !== open.createdAt ||
          challenge.expiresAtMs !== open.expiresAtMs) {
        throw new Error('stored backup challenge metadata does not match its bytes');
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['policy', 'backupCheck', 'open'],
        message: 'open Recovery C backup challenge must match this exact policy',
      });
    }
  }
});

export type StoredVaultRecoveryCCeremony =
  | { state: 'absent' }
  | { state: 'valid'; record: VaultRecoveryCCeremonyStateV1 }
  | { state: 'unusable' };

export async function loadVaultRecoveryCCeremony(
  area: StorageArea,
): Promise<StoredVaultRecoveryCCeremony> {
  const raw = await getJson<unknown>(area, VAULT_COORDINATOR_RECOVERY_C_KEY);
  if (raw === undefined || raw === null) return { state: 'absent' };
  const parsed = vaultRecoveryCCeremonyStateSchema.safeParse(raw);
  return parsed.success ? { state: 'valid', record: parsed.data } : { state: 'unusable' };
}

export async function saveVaultRecoveryCCeremony(
  area: StorageArea,
  record: VaultRecoveryCCeremonyStateV1,
): Promise<void> {
  await setJson(area, VAULT_COORDINATOR_RECOVERY_C_KEY, vaultRecoveryCCeremonyStateSchema.parse(record));
}

export async function clearVaultRecoveryCCeremony(area: StorageArea): Promise<void> {
  await area.remove(VAULT_COORDINATOR_RECOVERY_C_KEY);
}

/** Commit the accepted public C origin and ceremony completion atomically. */
export async function saveVaultImportWithRecoveryCCeremony(
  area: StorageArea,
  session: VaultImportSessionV1,
  recoveryC: VaultRecoveryCCeremonyStateV1,
): Promise<void> {
  await area.set({
    [VAULT_COORDINATOR_IMPORT_KEY]: vaultImportSessionSchema.parse(session),
    [VAULT_COORDINATOR_RECOVERY_C_KEY]: vaultRecoveryCCeremonyStateSchema.parse(recoveryC),
  });
}

// ---- committed policy (ADR 0007 §§3-4, Workstream C1) ----------------------

export interface VaultCoordinatorPolicyRecordV1 {
  schemaVersion: 1;
  /**
   * The local role whose origin occupies slot A. Binding it here means a policy
   * cannot outlive the role that signs for it without being noticed: if the
   * stored role is replaced, the policy no longer matches and the Vault is
   * surfaced as unusable rather than silently watched with a foreign A.
   */
  roleId: string;
  network: 'signet' | 'mainnet';
  createdAt: number;
  record: VaultPolicyRecordV1;
  /** Next never-before-used even branch-1 derivation index. Desktop owns the
   * even lane; Mobile owns odd indexes, so concurrent coordinators cannot
   * reserve the same change output. Failed builds leave gaps. */
  nextChangeIndex: number;
  transport: {
    extensionChannelIdHex: string;
    mobileChannelIdHex: string;
    transcriptHashHex: string;
    highestInboundCounter: string;
    nextOutboundCounter: string;
    /** Last authenticated policy handoff to Mobile B. Public and restart-safe;
     * it may be reissued with a fresh expiry after password confirmation. */
    pendingPairingPolicyEnvelope?: VaultPairingEnvelopeV1 | null;
    /** User confirmed that the same Mobile B showed the committed policy as ready.
     * Presentation progress only; transaction authority never depends on it. */
    mobilePairingConfirmedAt?: number | null;
    /** Exact last Desktop response to a Mobile-coordinated request. Keeping
     * both authenticated envelopes and the signed PSBT makes QR delivery
     * restart-safe without advancing either anti-replay counter twice. */
    pendingMobileResponse: {
      requestEnvelope: VaultPsbtApprovalEnvelopeV1;
      requestPsbtHex: string;
      responseEnvelope: VaultPsbtApprovalEnvelopeV1;
      signedPsbtHex: string;
    } | null;
  } | null;
}

export const vaultCoordinatorPolicyRecordSchema: z.ZodType<
  VaultCoordinatorPolicyRecordV1,
  z.ZodTypeDef,
  unknown
> = z
  .object({
    schemaVersion: z.literal(1),
    roleId: z.string().min(1).max(64),
    network: z.enum(['signet', 'mainnet']),
    createdAt: z.number().int().nonnegative(),
    record: vaultPolicyRecordSchema,
    nextChangeIndex: z.number().int().nonnegative().optional(),
    transport: z.object({
      extensionChannelIdHex: hexOf(32),
      mobileChannelIdHex: hexOf(32),
      transcriptHashHex: hexOf(32),
      highestInboundCounter: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
      nextOutboundCounter: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
      pendingPairingPolicyEnvelope: vaultPairingEnvelopeSchema.nullable().optional(),
      mobilePairingConfirmedAt: z.number().int().nonnegative().nullable().optional(),
      pendingMobileResponse: z.object({
        requestEnvelope: vaultPsbtApprovalEnvelopeSchema,
        requestPsbtHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u).max(200_000),
        responseEnvelope: vaultPsbtApprovalEnvelopeSchema,
        signedPsbtHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u).max(200_000),
      }).strict().nullable().optional(),
    }).strict().nullable().optional(),
  })
  .strict()
  .superRefine((stored, ctx) => {
    if (stored.record.identity.network !== stored.network) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['record'],
        message: 'policy network must match the stored coordinator network',
      });
    }
    if (stored.nextChangeIndex !== undefined && stored.nextChangeIndex % 2 !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nextChangeIndex'],
        message: 'Desktop Vault change reservations must use the even coordinator lane',
      });
    }
  })
  .transform((stored) => ({
    ...stored,
    nextChangeIndex: stored.nextChangeIndex ?? 0,
    transport: stored.transport === undefined || stored.transport === null
      ? null
      : {
          ...stored.transport,
          pendingPairingPolicyEnvelope: stored.transport.pendingPairingPolicyEnvelope ?? null,
          // Policies created before the resumable final-handoff fields already
          // displayed their one-shot QR. Treat those as complete instead of
          // trapping upgraded users on a step whose old transcript was never stored.
          mobilePairingConfirmedAt: stored.transport.mobilePairingConfirmedAt ??
            (stored.transport.pendingPairingPolicyEnvelope === undefined ? stored.createdAt : null),
          pendingMobileResponse: stored.transport.pendingMobileResponse ?? null,
        },
  }));

/** What is stored today, without deciding whether it is usable. */
export type StoredVaultPolicy =
  | { state: 'absent' }
  | { state: 'valid'; stored: VaultCoordinatorPolicyRecordV1 }
  | { state: 'unusable' };

export async function loadVaultPolicy(area: StorageArea): Promise<StoredVaultPolicy> {
  const raw = await getJson<unknown>(area, VAULT_COORDINATOR_POLICY_KEY);
  if (raw === undefined || raw === null) return { state: 'absent' };
  const parsed = vaultCoordinatorPolicyRecordSchema.safeParse(raw);
  // Same posture as the role record: a policy that will not parse still names
  // the descriptors somebody's coins live under. Preserve it and let a human
  // decide; only an explicit removal deletes it.
  if (!parsed.success) return { state: 'unusable' };
  return { state: 'valid', stored: parsed.data };
}

export async function saveVaultPolicy(
  area: StorageArea,
  stored: VaultCoordinatorPolicyRecordV1,
): Promise<void> {
  await setJson(
    area,
    VAULT_COORDINATOR_POLICY_KEY,
    vaultCoordinatorPolicyRecordSchema.parse(stored),
  );
}

/** Commit the policy and its public Recovery C gate in one storage mutation. */
export async function saveVaultPolicyWithRecoveryCCeremony(
  area: StorageArea,
  stored: VaultCoordinatorPolicyRecordV1,
  recoveryC: VaultRecoveryCCeremonyStateV1,
): Promise<void> {
  await area.set({
    [VAULT_COORDINATOR_POLICY_KEY]: vaultCoordinatorPolicyRecordSchema.parse(stored),
    [VAULT_COORDINATOR_RECOVERY_C_KEY]: vaultRecoveryCCeremonyStateSchema.parse(recoveryC),
  });
}

export async function clearVaultPolicy(area: StorageArea): Promise<void> {
  await area.remove(VAULT_COORDINATOR_POLICY_KEY);
}

// ---- approved plans (ADR 0007 §7, Workstream C3) ---------------------------

/**
 * One approved plan and everything needed to act on it or to validate a later
 * replacement against it (`vault-asset-policy-v1`'s `previousPlan` deferral
 * into C).
 *
 * The plan is stored as core's canonical SQVB bytes rather than as an object
 * graph: the plan's identity is those bytes, and re-serializing a parsed object
 * risks storing something that no longer hashes to the `planDigest` it claims.
 * The digest is kept alongside so a tampered record is caught on load rather
 * than at signing time.
 *
 * The evidence is stored with it and is not regenerable: each input's
 * `evidenceHash` is committed inside the plan, so a freshly built record from a
 * later scan would describe a different plan. That coupling is what makes a
 * plan expire — when the evidence window closes there is no way to refresh it
 * without building a new plan, which is exactly the C6 behaviour wanted.
 *
 * `broadcast` is the C6 lifecycle. It is written before the send is known to
 * have succeeded and is never cleared automatically: an indeterminate outcome
 * has to stay visible, because the alternative is a coordinator that quietly
 * resends bytes that may already be in a block.
 */
export interface VaultApprovedPlanV1 {
  schemaVersion: 1;
  planId: string;
  planDigest: string;
  policyId: string;
  approvedAt: number;
  canonicalPlanHex: string;
  /** The PSBT the coordinator constructed for this plan. */
  psbtHex: string;
  /** Exact quorum PSBT, committed before an authenticated peer counter moves. */
  combinedPsbtHex: string | null;
  /** Exact finalized bytes, also carried by the prepared lifecycle. */
  finalizedTransactionHex: string | null;
  /** The B3 evidence the plan's own input hashes commit to. */
  evidence: VaultAssetPolicyEvidenceV1;
  /** The regenerated paired-Spending destination, restated for review. */
  destinationAddress: string;
  broadcast: {
    txid: string;
    status:
      | 'accepted'
      | 'already_known'
      | 'confirmed'
      | 'conflicted'
      | 'rejected'
      | 'indeterminate';
    detail: string | null;
    at: number;
  } | null;
  /** Exact-byte, one-way lifecycle. Present for production-mainnet plans. */
  broadcastLifecycle: VaultBroadcastLifecycleV1 | null;
}

export const vaultApprovedPlanSchema: z.ZodType<VaultApprovedPlanV1, z.ZodTypeDef, unknown> = z
  .object({
    schemaVersion: z.literal(1),
    planId: hexOf(16),
    planDigest: hexOf(32),
    policyId: hexOf(32),
    approvedAt: z.number().int().nonnegative(),
    canonicalPlanHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u),
    psbtHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u),
    combinedPsbtHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u).nullable().optional(),
    finalizedTransactionHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u).nullable().optional(),
    // Core's own schema, so a hand-edited record cannot become evidence that
    // the B3 validator would then be asked to trust.
    evidence: vaultAssetPolicyEvidenceSchema,
    destinationAddress: z.string().min(1).max(128),
    broadcast: z
      .object({
        txid: hexOf(32),
        status: z.enum([
          'accepted',
          'already_known',
          'confirmed',
          'conflicted',
          'rejected',
          'indeterminate',
        ]),
        detail: z.string().max(512).nullable(),
        at: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    // Optional only for reading pre-v0.5.0 pilot records. New writes always
    // materialize null or a complete core lifecycle.
    broadcastLifecycle: vaultBroadcastLifecycleSchema.nullable().optional(),
  })
  .strict()
  .transform((record) => ({
    ...record,
    combinedPsbtHex: record.combinedPsbtHex ?? null,
    finalizedTransactionHex: record.finalizedTransactionHex ?? null,
    broadcastLifecycle: record.broadcastLifecycle ?? null,
  }));

/** Bounded: a coordinator that never forgets a plan is an unbounded store. */
export const VAULT_APPROVED_PLAN_LIMIT = 32;

export async function loadVaultApprovedPlans(
  area: StorageArea,
): Promise<VaultApprovedPlanV1[]> {
  const raw = await getJson<unknown>(area, VAULT_COORDINATOR_PLANS_KEY);
  if (!Array.isArray(raw)) return [];
  // Individually parsed: one unreadable entry must not discard the rest, and a
  // plan that will not parse cannot be a `previousPlan` anyway.
  return raw.flatMap((entry) => {
    const parsed = vaultApprovedPlanSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export async function saveVaultApprovedPlan(
  area: StorageArea,
  plan: VaultApprovedPlanV1,
): Promise<void> {
  const parsed = vaultApprovedPlanSchema.parse(plan);
  const existing = await loadVaultApprovedPlans(area);
  const next = [
    parsed,
    ...existing.filter((entry) => entry.planId !== parsed.planId),
  ].slice(0, VAULT_APPROVED_PLAN_LIMIT);
  await setJson(area, VAULT_COORDINATOR_PLANS_KEY, next);
}

/** Commit a peer replay-counter advance and its exact quorum PSBT together. */
export async function saveVaultPolicyAndApprovedPlan(
  area: StorageArea,
  policy: VaultCoordinatorPolicyRecordV1,
  plan: VaultApprovedPlanV1,
): Promise<void> {
  const parsedPolicy = vaultCoordinatorPolicyRecordSchema.parse(policy);
  const parsedPlan = vaultApprovedPlanSchema.parse(plan);
  const existing = await loadVaultApprovedPlans(area);
  const plans = [
    parsedPlan,
    ...existing.filter((entry) => entry.planId !== parsedPlan.planId),
  ].slice(0, VAULT_APPROVED_PLAN_LIMIT);
  await area.set({
    [VAULT_COORDINATOR_POLICY_KEY]: parsedPolicy,
    [VAULT_COORDINATOR_PLANS_KEY]: plans,
  });
}

export async function clearVaultApprovedPlans(area: StorageArea): Promise<void> {
  await area.remove(VAULT_COORDINATOR_PLANS_KEY);
}

/** Forget one plan. Returns false when nothing under that id was stored. */
export async function removeVaultApprovedPlan(
  area: StorageArea,
  planId: string,
): Promise<boolean> {
  const existing = await loadVaultApprovedPlans(area);
  const next = existing.filter((entry) => entry.planId !== planId);
  if (next.length === existing.length) return false;
  await setJson(area, VAULT_COORDINATOR_PLANS_KEY, next);
  return true;
}

/** The public projection of a stored role. Never includes the secret half. */
export function vaultRoleSummary(record: VaultCoordinatorRoleRecordV1): {
  roleId: string;
  label: string;
  createdAt: number;
  origin: VaultCoordinatorOriginV1;
} {
  return {
    roleId: record.roleId,
    label: record.label,
    createdAt: record.createdAt,
    origin: record.origin,
  };
}
