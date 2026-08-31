/**
 * Lock / unlock / switch-vault state machine and session manager (spec §7.3,
 * §7.4, §7.5). This is the sole software-wallet authority (spec §5.2).
 *
 * Design notes:
 * - No decrypted secret is cached in worker memory between calls. The only live
 *   unlock material is the DEK held (base64) in chrome.storage.session, so a
 *   worker restart rehydrates an unexpired session for free and a lock is a
 *   single session clear. The transient DEK from unlockVault is zeroized
 *   immediately after it is copied into the session store.
 * - Chrome is never touched directly: everything goes through injected storage
 *   ports, so the whole machine is unit-testable with faked stores.
 * - Only one vault is ever unlocked (spec §7.3): unlock/switch clear any prior
 *   session before establishing the new one.
 * - Storage read-modify-writes run under one serialization queue. MV3
 *   interleaves message handlers at every await and chrome.storage has no
 *   transactions, so the queue keeps vault/session mutations atomic. Remote
 *   gallery I/O is deliberately split into queued prepare and commit phases;
 *   the commit revalidates the exact authority snapshot before writing.
 */
import { entropyToMnemonic, restoreMnemonic, generateMnemonic, mnemonicToSeed } from '@drey/core/domain/keys/mnemonic';
import {
  createBackupMetadata,
  recordBackupSpotCheck,
  recordFullRecoveryCheck,
  verifyFullRecoveryRehearsal,
  type BackupMetadataV1,
  type RecoveryWordCount,
} from '@drey/core/domain/vault/backup-metadata';
import { z } from 'zod';
import { deriveAccountNode, deriveAddress, type Network } from '@drey/core/domain/keys/derivation';
import {
  ACCOUNT_GAP_LIMIT,
  normalizeAccountIndexes,
  standardAccountAddState,
} from '@drey/core/domain/accounts/limits';
import {
  derivePublicAccountAddress,
  parsePublicAccountDescriptors,
  publicAccountFromSeed,
  type PublicAccountDefinitionV1,
} from '@drey/core/domain/accounts/public-account';
import {
  migrateLegacySoftwareAccountV1,
  type AccountSigningSourceV1,
} from '@drey/core/domain/accounts/signing-source';
import { restoreOccupiedStandardAccounts } from '@drey/core/domain/accounts/visibility';
import { Transaction } from '@scure/btc-signer';
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes } from '@drey/core/domain/vault/encoding';
import type { Argon2idParams, VaultPayloadV1, VaultRecordV1 } from '@drey/core/domain/vault/record';
import {
  changePassword as domainChangePassword,
  createVaultRecord,
  openVaultPayload,
  unlockVault,
  verifyVaultPassword,
  zeroize,
  type VaultDeps,
} from '@drey/core/domain/vault/vault';
import {
  addProfileSecret,
  createProfileCredential,
  linkLegacyVaultToProfile,
  removeProfileSecret,
  rewrapProfilePassword,
  unlockProfileCredential,
  unwrapProfileSecret,
} from '@drey/core/domain/vault/profile-credential';
import { VaultError } from '@drey/core/domain/vault/errors';
import type { StorageArea } from '../adapters/storage/area';
import {
  passkeyBeginEnrollment,
  passkeyChallenge,
  passkeyEnroll,
  passkeyList,
  passkeyRemove,
  passkeyRename,
  passkeyUnlock,
  consumePasskeyUnlockChallenge,
  mintPasskeyUnlockChallenge,
  purgePasskeyStateForVault,
  type PasskeyContext,
  type PasskeyEnrollAuthorization,
  type PasskeyOpsContext,
  type PasskeyUnlockChallenge,
} from './passkey-service';
import {
  transactionWtxid,
  vaultCoordinatorAcknowledgeRecoveryKitExport,
  vaultCoordinatorBeginRoleRecoveryExport,
  vaultCoordinatorBeginImport,
  vaultCoordinatorBeginRecoveryCBackupCheck,
  vaultCoordinatorBeginRecoveryCSetup,
  vaultCoordinatorBroadcastPlan,
  vaultCoordinatorReconcilePlan,
  vaultCoordinatorBuildPlan,
  vaultCoordinatorBuildCpfp,
  vaultCoordinatorCombinePlan,
  vaultCoordinatorCreatePolicy,
  vaultCoordinatorCreateRole,
  vaultCoordinatorDepositAddress,
  vaultCoordinatorDiscardPlan,
  vaultCoordinatorFinalizePlan,
  vaultCoordinatorImportSigner,
  vaultCoordinatorImportRecoveryCBackupCheckResponse,
  vaultCoordinatorImportRecoveryCSetupResponse,
  vaultCoordinatorPlan,
  vaultCoordinatorPolicy,
  vaultCoordinatorPolicyPairingQr,
  vaultCoordinatorAcknowledgePolicyPairing,
  vaultCoordinatorProveRole,
  vaultCoordinatorRecoveryKit,
  vaultCoordinatorRecoveryCReadiness,
  vaultCoordinatorCancelRecoveryCSetup,
  vaultCoordinatorRemovePolicy,
  vaultCoordinatorRemoveRole,
  vaultCoordinatorRestoreRole,
  vaultCoordinatorRevealRole,
  vaultCoordinatorExportRoleRecovery,
  vaultCoordinatorRoleOrigin,
  vaultCoordinatorScan,
  vaultCoordinatorSignPlan,
  vaultCoordinatorSignMobileRequest,
  vaultCoordinatorStatus,
  type VaultCoordinatorContext,
} from './vault-coordinator-service';
import type { VaultCoordinatorCapability } from './vault-capability';
import {
  communityVaultAcceptPolicy,
  communityVaultConfirmRecovery,
  communityVaultCreate,
  communityVaultRestore,
  communityVaultRevealRecovery,
  communityVaultSign,
  communityVaultStatus,
  type CommunityVaultContext,
} from './community-vault-service';
import type {
  CommunityVaultAcceptPolicyRequest,
  CommunityVaultConfirmRecoveryRequest,
  CommunityVaultCreateRequest,
  CommunityVaultOwnerResult,
  CommunityVaultPasswordCampaignRequest,
  CommunityVaultRestoreRequest,
  CommunityVaultSignRequest,
  CommunityVaultStatusRequest,
  CommunityVaultStatusResult,
} from '../messaging/community-vault-ops';
import type {
  VaultCoordinatorBeginImportRequest,
  VaultCoordinatorBeginImportResult,
  VaultCoordinatorBeginRoleRecoveryExportRequest,
  VaultCoordinatorBeginRoleRecoveryExportResult,
  VaultCoordinatorBeginRecoveryCBackupCheckRequest,
  VaultCoordinatorBeginRecoveryCSetupRequest,
  VaultCoordinatorCancelRecoveryCSetupRequest,
  VaultCoordinatorCreatePolicyRequest,
  VaultCoordinatorCreatePolicyResult,
  VaultCoordinatorCreateRoleRequest,
  VaultCoordinatorCreateRoleResult,
  VaultCoordinatorImportSignerRequest,
  VaultCoordinatorImportSignerResult,
  VaultCoordinatorImportRecoveryCBackupCheckResponseRequest,
  VaultCoordinatorImportRecoveryCSetupResponseRequest,
  VaultCoordinatorPolicyRequest,
  VaultCoordinatorPolicyResult,
  VaultCoordinatorPolicyPairingQrRequest,
  VaultCoordinatorPolicyPairingQrResult,
  VaultCoordinatorAcknowledgePolicyPairingRequest,
  VaultCoordinatorAcknowledgePolicyPairingResult,
  VaultCoordinatorProveRoleRequest,
  VaultCoordinatorProveRoleResult,
  VaultCoordinatorRecoveryKitRequest,
  VaultCoordinatorRecoveryKitResult,
  VaultCoordinatorRecoveryCChallengeResult,
  VaultCoordinatorRecoveryCReadinessRequest,
  VaultCoordinatorRecoveryCReadinessResult,
  VaultCoordinatorAcknowledgeRecoveryKitExportRequest,
  VaultCoordinatorRemovePolicyRequest,
  VaultCoordinatorScanRequest,
  VaultCoordinatorScanResult,
  VaultCoordinatorBroadcastPlanRequest,
  VaultCoordinatorReconcilePlanRequest,
  VaultCoordinatorBuildPlanRequest,
  VaultCoordinatorBuildPlanResult,
  VaultCoordinatorBuildCpfpRequest,
  VaultCoordinatorCombinePlanRequest,
  VaultCoordinatorCombinePlanResult,
  VaultCoordinatorDepositAddressRequest,
  VaultCoordinatorDepositAddressResult,
  VaultCoordinatorDiscardPlanRequest,
  VaultCoordinatorFinalizePlanRequest,
  VaultCoordinatorFinalizePlanResult,
  VaultCoordinatorPlanBroadcast,
  VaultCoordinatorPlanRequest,
  VaultCoordinatorPlanResult,
  VaultCoordinatorSignPlanRequest,
  VaultCoordinatorSignPlanResult,
  VaultCoordinatorSignMobileRequestRequest,
  VaultCoordinatorSignMobileRequestResult,
  VaultCoordinatorRemoveRoleRequest,
  VaultCoordinatorRestoreRoleRequest,
  VaultCoordinatorRestoreRoleResult,
  VaultCoordinatorRevealRoleRequest,
  VaultCoordinatorExportRoleRecoveryRequest,
  VaultCoordinatorExportRoleRecoveryResult,
  VaultCoordinatorRoleOriginRequest,
  VaultCoordinatorRoleOriginResult,
  VaultCoordinatorStatusRequest,
  VaultCoordinatorStatusResult,
} from '../messaging/vault-coordinator-ops';
import {
  type PasskeyBeginEnrollmentRequest,
  type PasskeyBeginEnrollmentResult,
  type PasskeyChallengeRequest,
  type PasskeyChallengeResult,
  type PasskeyEnrollRequest,
  type PasskeyEnrollResult,
  type PasskeyListRequest,
  type PasskeyListResult,
  type PasskeyRemoveRequest,
  type PasskeyRenameRequest,
  type PasskeyUnlockRequest,
} from '../messaging/passkey-ops';
import {
  activeAccountKey,
  countQuarantinedVaults,
  loadConfig,
  loadVaultMeta,
  loadVaults,
  saveActiveVaultId,
  saveConfig,
  saveVaultMeta,
  saveVaults,
  type VaultRecordMap,
} from '../adapters/storage/vault-store';
import {
  loadCommunityVaultOwners,
  savePasswordChangedRecords,
} from '../adapters/storage/community-vault-store';
import {
  loadProfileCredential,
  profileWalletSecret,
  saveProfileCredential,
  type StoredProfileCredentialV1,
} from '../adapters/storage/profile-credential-store';
import {
  clearSession,
  getSession,
  peekSession,
  putSession,
  setSessionAccessTrusted,
  type SessionArea,
  type UnlockSession,
} from '../adapters/session/session-store';
import {
  clearBoundHomeSnapshot,
  clearHomeSnapshot,
  loadHomeSnapshot,
  saveHomeSnapshot,
} from '../adapters/session/home-snapshot';
import { loadCachedStatus, saveCachedStatus } from '../adapters/gateway/status-cache';
import {
  isAcceptableFiatPriceQuote,
  loadCachedPrice,
  saveCachedPrice,
} from '../adapters/gateway/price-cache';
import {
  clearCachedGallery,
  loadCachedGallery,
  saveCachedGallery,
} from '../adapters/gateway/preview-cache';
import {
  createDurableGalleryPreviewCache,
  GALLERY_DURABLE_PREVIEW_PAINT_AHEAD_ITEMS,
  type DurableGalleryPreviewCache,
  type DurableGalleryPreviewInput,
} from '../adapters/storage/gallery-preview-cache';
import type { GatewayClient } from '@drey/core/gateway-client';
import {
  deriveGatewayView,
  type GatewayStatusView,
} from '@drey/core/domain/gateway/status-view';
import type { GatewayRejectReason } from '@drey/core/domain/gateway/verify';
import { evaluateFreshness, type FreshnessReport } from '@drey/core/domain/gateway/freshness';
import { loadDerivationState } from '../adapters/storage/derivation-store';
import { reserveChangeIndexPersisted } from '../adapters/storage/derivation-store';
import { derivationKey } from '../adapters/storage/keys';
import {
  accountSigningBindingSchema,
  parsePublicAccountRecordPair,
  publicAccountDefinitionRecordSchema,
  type AccountSigningBinding,
  type PublicAccountDefinitionRecord,
} from '@drey/core/messaging/account-schemas';
import {
  openRecord,
  sealRecord,
  type WalletCacheKey,
  type WalletCachePort,
  type WalletCacheRecord,
  type WalletCacheRecordType,
} from '../adapters/storage/wallet-cache';
import { summarizeBalances } from '@drey/core/domain/classification/balances';
import { laneState } from '@drey/core/domain/classification/lanes';
import { deriveDataGating, type DataGating } from '@drey/core/domain/classification/staleness';
import type { WalletUtxo } from '@drey/core/domain/classification/types';
import { outpointKey } from '@drey/core/domain/classification/types';
import { evaluateEligibility, type EligibilityContext } from '@drey/core/domain/classification/eligibility';
import { labelGroupKey } from '@drey/core/domain/classification/labels';
import { walletPrivacyNotes } from '@drey/core/domain/classification/privacy-signals';
import {
  createOwnedAddressResolver,
  summarizeRecoveredAddresses,
} from '@drey/core/domain/classification/owned-address';
import {
  scriptHashFromScriptPubKey,
  scriptPubKeyHex,
} from '@drey/core/domain/keys/script-hash';
import { parseCanonicalSatpoint } from '@drey/core/domain/ordinals/satpoint';
import {
  accountsMetaReadSchema,
  activityEvidenceRecordSchema,
  ACTIVITY_EVIDENCE_MAX_IDENTITIES,
  galleryRecordSchema,
  labelsRecordSchema,
  migrateLegacyStoredUtxos,
  migrateLegacyAccountsMetaV04,
  UTXO_LABEL_MAX_ENTRIES,
  type LabelsRecord,
  scanCheckpointSchema,
  storedHistoryReadSchema,
  storedUtxosSchema,
  type AccountsMeta,
  type RegisteredPublicAccount,
  type LegacyAccountsMeta,
  type ActivityEvidenceEntry,
  type ActivityEvidenceRecord,
  type GalleryRecord,
  type ScanCheckpoint,
  type StoredHistoryRecord,
} from '@drey/core/scan/cache-schemas';
import {
  buildRefreshUnits,
  buildPublicAccountScanUnits,
  buildScanUnits,
  EXTEND_STEP,
  INITIAL_MAX_INDEX,
  scanStatusView,
  shadowedByStandardKey,
  removeDescriptorAccountLifecycle,
  includeIntermediateDiscoveredAccounts,
  stopStandardDiscoveryAfter,
  unitKey,
  unitLaneFromKey,
  type ScanPhase,
  type ScanScope,
  type ScanStatusView,
  type ScanUnit,
} from '@drey/core/scan/scan-state';
import { scanUnit as runScanUnit, type ScanUnitPorts, type ScanUnitResult } from '@drey/core/scan/scan-engine';
import {
  buildAccountKeyRing,
  buildPublicAccountKeyRing,
  windowScriptHashes,
  type AccountKeyRing,
} from '@drey/core/scan/address-window';
import {
  CLASSIFY_MAX_OUTPOINTS,
  INSCRIPTION_APPROVAL_MAX_ITEMS,
  INSCRIPTION_APPROVAL_MAX_RASTERS,
  type FeeQuoteResponse,
  type FiatPriceQuote,
  type InscriptionGalleryBatchResponse,
  type InscriptionGalleryEnrichedBatchResponse,
  type InscriptionDisplayMetadata,
  type InscriptionPreviewPayload,
  type OutpointsClassifyResponse,
  type SnapshotHistoryEntry,
  type StatusCapabilities,
  type UtxoClassification,
} from '@drey/core/domain/gateway/contract';
import type {
  AccountListResult,
  AccountAddRequest,
  AccountAddState,
  AddressBookAddRequest,
  AddressBookImportRequest,
  AddressBookImportResult,
  AddressBookDismissRecentRequest,
  AddressBookRemoveRequest,
  AddressBookRenameRequest,
  AccountVisibilitySetRequest,
  ActiveAccountSetRequest,
  PublicAccountExportRequest,
  PublicAccountImportRequest,
  PublicAccountRemoveRequest,
  ActivityInscriptionPreviewBatchRequest,
  ActivityInscriptionPreviewBatchResult,
  ActivityInscriptionPreviewRequest,
  ActivityInscriptionPreviewResult,
  ActivityListRequest,
  ActivityListResult,
  ConnectedSiteRevokeRequest,
  FeeQuoteRequest,
  ActiveSessionRequest,
  AddressReceiveRequest,
  PaymentInstructionResolveRequest,
  PaymentInstructionResolveResult,
  MessageSignRequest,
  MessageSignResult,
  ConfigSetRequest,
  GalleryCachedItem,
  GalleryCachedRequest,
  GalleryCachedResult,
  GalleryListRequest,
  GalleryListResult,
  GalleryMediaLeaseRequest,
  GalleryMediaOpenRequest,
  GalleryUpdateRequest,
  GatewayStatusRequest,
  ScanCancelRequest,
  ScanStartRequest,
  TransactionApproveRequest,
  TransactionPlanRequest,
  TransactionPlanResult,
  TransactionReviewRequest,
  UtxoListRequest,
  UtxoSetFrozenRequest,
  UtxoSetLabelRequest,
  VaultChangePasswordRequest,
  VaultCreateRequest,
  VaultRestoreRequest,
  VaultRemoveRequest,
  VaultRevealMnemonicRequest,
  VaultUnlockRequest,
  VaultVerifyBackupRequest,
  WalletHomeResult,
  WalletActivityItem,
} from '@drey/core/messaging/ops';
import {
  BIP321_LIMITS,
  parseBip321,
  selectBip321OnchainFallback,
  type ParsedBip321,
} from '@drey/core/domain/payments/bip321';
import {
  addSavedRecipient,
  AddressBookError,
  addressBookSchema,
  dismissRecentRecipient,
  emptyAddressBook,
  removeSavedRecipient,
  recordRecentRecipient,
  renameSavedRecipient,
  type AddressBookV1,
} from '@drey/core/domain/address-book';
import { mergeContactTransferRecipients } from '@drey/core/domain/contact-transfer';
import { GALLERY_PREVIEW_UNAVAILABLE } from '@drey/core/messaging/ops';
import type { WalletDataChangeReason } from '@drey/core/messaging/events';
import type { MarketplaceContext, MarketplaceResolution } from '@drey/core/domain/marketplaces/types';
import type { CommunityVaultAcquisitionProviderReviewV1 } from '@drey/core/domain/community-vault/acquisition-provider';
import type { CommunityVaultSaleProviderReviewV1 } from '@drey/core/domain/community-vault/sale-provider';
import type { CommunityVaultSaleBuyerProviderReviewV1 } from '@drey/core/domain/community-vault/sale-provider';
import type {
  CommunityVaultPositionTransferProviderReviewV1,
} from '@drey/core/domain/community-vault/position-transfer-provider';
import { verifyOrdnetSaleScriptPath } from '@drey/core/domain/marketplaces/ordnet-script-path';
import {
  marketplaceReservationSchema,
  marketplaceWorkflowSchema,
  transitionMarketplaceWorkflow,
  type MarketplaceReservation,
  type MarketplaceWorkflow,
} from '@drey/core/domain/marketplaces/workflow';
import { getCryptoProvider } from '@drey/core/domain/vault/crypto-provider';
import { RpcError } from './errors';
import { classifyProviderOutpointsChunked } from './provider-classification';
import { parseSats } from '@drey/core/domain/sats';
import {
  DEFAULT_POSTAGE_SATS,
  MAX_FEE_RATE_SAT_PER_KVB,
  economicChangeThreshold,
  estimateVsize,
  feeForVsize,
  parseCustomFeeRate,
  inputVbytes,
  scriptDustSats,
  sequenceForInput,
  validateAutomaticQuote,
  quoteTier,
} from '@drey/core/domain/transactions/fees';
import { selectCoins } from '@drey/core/domain/transactions/selection';
import {
  buildNativeBatchSendCandidate,
  buildNativeSendCandidate,
  resolvePayableAddress,
  type NativeBatchSendCandidateFailure,
  type NativeSendCandidateFailure,
  type ResolvedPayableAddress,
} from '@drey/core/domain/transactions/native-send';
import {
  assertLegacyAnalyzedPlanHash,
  assertLegacyCurrentPlanHash,
  assertLegacyPlanHash,
  assertPlanHash,
  customPlanFeePolicy,
  finalizePlan,
  hashHex,
  inputFromUtxo,
  reviewFromPlan,
  transactionCommitmentHash,
  type PlanDerivation,
  type PlanInput,
  type PlanIntent,
  type PlanOutput,
  type TransactionPlan,
} from '@drey/core/domain/transactions/plan';
import {
  approvalInscriptionItems,
  assertPreviewAcknowledged,
  bindInscriptionPreviews,
  inscriptionApprovalRequest,
  requiresPreviewAcknowledgement,
  storedPreviewSet,
  type InscriptionPreviewSet,
  type StoredInscriptionPreviewSet,
} from '@drey/core/domain/transactions/inscription-previews';
import {
  buildPsbtHex,
  signAndValidatePlan,
} from '@drey/core/domain/transactions/signing';
import { analysisContextFromPlan, analyzePsbtHex } from '@drey/core/domain/transactions/analysis';
import {
  bip322MessageHash,
  signBip322Simple,
  validateBip322Message,
  verifyBip322Simple,
} from '@drey/core/domain/transactions/bip322';
import {
  createProviderPsbtPlan,
  assertProviderPsbtPlan,
  bindProviderPsbtPlanPreviews,
  partitionOrdinalSatFlow,
  providerPsbtOutpoints,
  reattachProviderPsbtPlanPreviews,
  signProviderPsbtPlan,
  validateProviderTransactionHex,
  type ProviderAuthorityBinding,
  type ProviderPsbtInputSelection,
  type ProviderPsbtPlanV3,
} from '@drey/core/domain/transactions/provider-psbt';
import {
  assertProviderPsbtBatchPlan,
  createProviderPsbtBatchPlan,
  signProviderPsbtBatchPlan,
  type ProviderBatchInputSelection,
  type ProviderPsbtBatchPlanV1,
} from '@drey/core/domain/transactions/provider-psbt-batch';
import { PROVIDER_MAX_PSBT_BATCH_ITEMS } from
  '@drey/core/domain/transactions/provider-psbt-limits';
import {
  inspectProviderPsbtGroupRequest,
  prepareProviderPsbtGroupInputs,
  providerPsbtLinkedGroupBinding,
  type ProviderPsbtGroupPreparationItem,
} from '@drey/core/domain/transactions/provider-psbt-group-prepare';
import {
  assertProviderPsbtGroupPlan,
  createProviderPsbtGroupPlan,
  signProviderPsbtGroupPlan,
  type ProviderPsbtGroupPlanV1,
} from '@drey/core/domain/transactions/provider-psbt-group-plan';
import {
  assertProviderMessageBatchPlan,
  assertProviderMessageBatchResults,
  createProviderMessageBatchPlan,
  signProviderMessageBatchItem,
  type ProviderMessageBatchPlanV1,
  type ProviderSignedMessage,
} from '@drey/core/domain/transactions/provider-message-batch';
import {
  automaticOrdinalPostage,
  canonicalOrdinalBatchSelections,
  groupOrdinalInscriptions,
  planOrdinalBatchSatFlow,
  OrdinalBatchPlanError,
  OrdinalInscriptionGroupError,
} from '@drey/core/domain/transactions/ordinal-transfer';
import {
  OrdinalPostagePlanError,
  planOrdinalPostageManage,
} from '@drey/core/domain/transactions/postage-manage';
import {
  appendPermissionEvent,
  createPermissionOpaqueId,
  hasExactPermission,
  hasExactPermissionSet,
  loadPermissionJournal,
  normalizePermissionScope,
  type PermissionDataCategory,
  type PermissionGrantEvent,
} from '@drey/core/domain/provider/permission-journal';
import {
  deriveAccountCapabilities,
  derivePublicAccountCapabilities,
  type AccountCapabilities,
} from '@drey/core/domain/accounts/capabilities';
import {
  broadcastRecoverySchema,
  providerBroadcastRecoverySchema,
  storedPlanSchema,
  storedTransactionSchema,
  type BroadcastRecovery,
  type ProviderBroadcastRecovery,
  type StoredTransaction,
} from '@drey/core/scan/cache-schemas';
import {
  annotateOrdinalFlowActivity,
  annotateReceivedDetectedAssetActivity,
  annotateReceivedInscriptionActivity,
  paginateActivity,
  projectRecentActivity,
  propagateActivityEvidence,
  type LaneAwareHistoryEntry,
  ordinalActionInscriptionId,
  reconcileTransactionStatus,
  type ReceivedInscriptionEvidence,
} from '@drey/core/domain/recent-activity';

export interface WalletServiceDeps {
  local: StorageArea;
  session: SessionArea;
  vaultDeps: VaultDeps; // random + now
  /** Device-calibrated Argon2id params for new records (spec §7.2). */
  calibrateKdf: () => Promise<Argon2idParams>;
  newVaultId: () => string;
  newSessionId: () => string;
  /**
   * Channel-pinned network (M6 settled decision): dev build = signet
   * everywhere, prod = mainnet. Derivation, receive, scanning, and the
   * gateway all key off this one value.
   */
  network: Network;
  /**
   * Full WebAuthn RP origin (`chrome-extension://<id>`) when — and only when —
   * this build channel has a stable pinned identity (A0 §1). Undefined
   * disables every passkey op: enrollment is refused and stored envelopes are
   * never offered, so an unstable-identity build can neither create nor
   * exercise a ceremony. Password unlock is unaffected.
   */
  passkeyRpOrigin?: string;
  /**
   * What this build's Vault coordinator may do, when the channel enables one at
   * all (ADR 0007 §8, Workstream C). Undefined refuses every
   * `vaultCoordinator.*` op. The capability pairs network with movement in one
   * union whose only mainnet inhabitant is unsigned-only, so a mainnet
   * coordinator requires the explicit `production-mainnet` arm; `unsigned-only`
   * remains unable to sign. The composition root derives this from the
   * compile-time channel alone.
   */
  vaultCoordinatorCapability?: VaultCoordinatorCapability;
  /** Broadcasts only that session state changed; never receives secret data. */
  notifySessionChanged?: (locked: boolean) => void;
  /** Broadcasts only that scan progress changed; surfaces re-poll scan.status. */
  notifyScanProgress?: () => void;
  /** Invalidates provider approvals and emits permission-filtered account events. */
  notifyAccountChanged?: (accountId: string, account: number) => void;
  /** Invalidates live site connections after a settings-driven grant revocation. */
  notifyPermissionsRevoked?: (origin: string) => void;
  /** Invalidates non-secret UI projections after a persisted wallet mutation. */
  notifyWalletDataChanged?: (reason: WalletDataChangeReason) => void;
  /** Gateway /v1 client (spec §18). Absent in harnesses that don't exercise it. */
  gateway?: GatewayClient;
  /** Encrypted wallet cache (spec §5.1). Absent in harnesses that don't scan. */
  walletCache?: WalletCachePort;
}

/** Skip the network when the cached status verified this recently. */
export const GATEWAY_MIN_REFETCH_MS = 10_000;
export const PRICE_MIN_REFETCH_MS = 30_000;
export const GALLERY_MEDIA_LEASE_TTL_MS = 30_000;

/** Cached status may bridge transport loss, never a failed verification. */
const HARD_GATEWAY_VERIFICATION_FAILURES: ReadonlySet<GatewayRejectReason> = new Set([
  'schema',
  'signature',
  'nonce_mismatch',
  'wrong_network',
  'protocol',
  'skew',
  'conflicting_sources',
  'key_unprovisioned',
]);

/**
 * One gatewayStatusOnce pass. `revalidated` records whether the pass actually
 * reached the gateway rather than answering from the min-refetch cache, so the
 * single-flight guard can tell a shareable run from one a forceRefresh caller
 * must not inherit.
 */
interface GatewayStatusRun {
  view: GatewayStatusView;
  revalidated: boolean;
}

interface SessionStatus {
  locked: boolean;
  activeVaultId: string | null;
  sessionId: string | null;
  deadline: number | null;
  highSecurityMode: boolean;
}

export interface ProviderAccountView {
  vaultId: string;
  vaultName: string;
  sessionId: string;
  network: Network;
  accountId: string;
  account: number;
  payment: { address: string; publicKeyHex: string; path: string };
  ordinals: { address: string; publicKeyHex: string; path: string };
}

interface ProviderBalanceView {
  confirmed: string;
  unconfirmed: string;
  total: string;
  fresh: boolean;
}

interface ProviderInscriptionView {
  id: string;
  number?: number;
  satpoint: string;
  output: string;
  address: string;
  postage: string;
  genesisTxid: string;
  offset: string;
}

/**
 * Synchronous controller-owned authority check. It is deliberately synchronous
 * so it can run inside the worker's serialized signing/persistence boundary
 * without recursively entering WalletService's queue.
 */
type ProviderOperationGuard = () => void;

/**
 * Whether the sandboxed media viewer will even consider this content type. A
 * presentation hint only: `gallery.media.open` re-derives it and refuses active
 * content regardless, so being permissive here costs a rejected open, never a
 * leak.
 */
const OPENABLE_MEDIA_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'audio/mpeg', 'audio/ogg', 'audio/wav',
  'video/mp4', 'video/webm', 'text/plain', 'application/json',
]);

function openableMediaType(contentType: string | null): boolean {
  return OPENABLE_MEDIA_TYPES.has(contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '');
}

type UiInscriptionPreview =
  | { kind: 'raster'; rasterBase64: string; pngSha256: string; pngWidth: number; pngHeight: number }
  | { kind: 'placeholder'; reason: string }
  | {
      kind: 'text';
      textMime: 'text/plain' | 'application/json';
      excerpt: string;
      truncated: boolean;
    }
  | { kind: 'mediaBadge'; mediaKind: 'audio' | 'video'; contentLength: number };

/** Signed preview payload → the shape the surfaces render. */
function uiPreviewFromPayload(
  payload: import('@drey/core/domain/gateway/contract').InscriptionPreviewPayload,
): UiInscriptionPreview {
  switch (payload.disposition) {
    case 'raster':
      return {
        kind: 'raster',
        rasterBase64: payload.bytesBase64,
        pngSha256: payload.pngSha256,
        pngWidth: payload.pngWidth,
        pngHeight: payload.pngHeight,
      };
    case 'text':
      return {
        kind: 'text',
        textMime: payload.declaredMime,
        excerpt: payload.excerpt,
        truncated: payload.truncated,
      };
    case 'mediaBadge':
      return {
        kind: 'mediaBadge',
        mediaKind: payload.mediaKind,
        contentLength: payload.declaredContentLength,
      };
    default:
      return { kind: 'placeholder', reason: payload.reason };
  }
}

function permissionStorageKey(vaultId: string, network: Network): string {
  return `squirrel:provider:permissions:${vaultId}:${network}`;
}

/**
 * Resolve a pre-v0.4 standard/Xverse cache key to the current stable public
 * account key that supersedes it. `shadowedByStandardKey` intentionally
 * returns the old `a0:<lane>` spelling for coincident Xverse units, so readers
 * must take this second migration step once standard accounts use
 * `pub:<accountId>:<lane>` keys.
 */
function stableStandardShadowKey(
  network: Network,
  key: string,
  publicIdByIndex: ReadonlyMap<number, string>,
): string | null {
  const legacyStandardKey = shadowedByStandardKey(network, key) ?? key;
  const match = /^a(0|[1-9][0-9]*):(payment|ordinals)$/u.exec(legacyStandardKey);
  if (!match) return null;
  const accountId = publicIdByIndex.get(Number(match[1]));
  return accountId === undefined ? null : `pub:${accountId}:${match[2]}`;
}

function tipsEqual(
  left: { height: number; hash: string },
  right: { height: number; hash: string },
): boolean {
  return left.height === right.height && left.hash === right.hash;
}

type ApprovalEvidenceSource = Pick<
  OutpointsClassifyResponse,
  'instanceId' | 'classificationRevision' | 'coreTip' | 'indexTip'
>;

function approvalEvidenceSource(
  response: ApprovalEvidenceSource,
): ApprovalEvidenceSource {
  return {
    instanceId: response.instanceId,
    classificationRevision: response.classificationRevision,
    coreTip: response.coreTip,
    indexTip: response.indexTip,
  };
}

function approvalSourcesEqual(
  left: ApprovalEvidenceSource,
  right: ApprovalEvidenceSource,
): boolean {
  return left.instanceId === right.instanceId &&
    left.classificationRevision === right.classificationRevision &&
    tipsEqual(left.coreTip, right.coreTip) &&
    tipsEqual(left.indexTip, right.indexTip);
}

function approvalSourceMatchesStatus(
  source: ApprovalEvidenceSource,
  status: StatusCapabilities,
): boolean {
  return source.instanceId === status.instanceId &&
    source.classificationRevision === status.activeRevision &&
    tipsEqual(source.coreTip, status.coreTip) &&
    tipsEqual(source.indexTip, status.indexTip);
}

function providerFactsEqual(fresh: UtxoClassification, expected: ProviderPsbtPlanV3['inputs'][number]): boolean {
  return fresh.txid === expected.txid && fresh.vout === expected.vout &&
    fresh.valueSats === expected.valueSats.toString() && fresh.scriptPubKey === expected.scriptPubKey &&
    fresh.primaryClass === expected.classification.primaryClass &&
    JSON.stringify(fresh.inscriptions) === JSON.stringify(expected.classification.inscriptions) &&
    JSON.stringify(fresh.satRanges) === JSON.stringify(expected.classification.satRanges) &&
    fresh.unsupportedAssetDetected === expected.classification.unsupportedAssetDetected &&
    fresh.confidence === expected.classification.confidence &&
    tipsEqual(fresh.classifiedTip, expected.classification.classifiedTip) &&
    fresh.classificationRevision === expected.classification.classificationRevision;
}

function cachedProviderFactsEqual(
  fresh: NonNullable<WalletUtxo['facts']>,
  expected: ProviderPsbtPlanV3['inputs'][number]['classification'],
): boolean {
  return fresh.primaryClass === expected.primaryClass &&
    JSON.stringify(fresh.inscriptions) === JSON.stringify(expected.inscriptions) &&
    JSON.stringify(fresh.satRanges) === JSON.stringify(expected.satRanges) &&
    fresh.unsupportedAssetDetected === expected.unsupportedAssetDetected &&
    fresh.confidence === expected.confidence && tipsEqual(fresh.classifiedTip, expected.classifiedTip) &&
    fresh.classificationRevision === expected.classificationRevision;
}

function rbfInputMatchesParent(candidate: PlanInput, parent: PlanInput): boolean {
  return candidate.txid === parent.txid && candidate.vout === parent.vout &&
    candidate.valueSats === parent.valueSats && candidate.scriptPubKey === parent.scriptPubKey &&
    candidate.sequence === sequenceForInput('rbf', parent.sequence) &&
    candidate.sighash === parent.sighash && candidate.ownership === parent.ownership &&
    JSON.stringify(candidate.derivation) === JSON.stringify(parent.derivation) &&
    JSON.stringify(candidate.classification) === JSON.stringify(parent.classification);
}

type CurrentStoredTransaction = StoredTransaction & { plan: TransactionPlan };

function isCurrentStoredTransaction(
  transaction: StoredTransaction,
): transaction is CurrentStoredTransaction {
  return transaction.plan.version === 4;
}

// Direct domain/service callers may omit operationId; the RPC boundary requires
// it so every user-triggered create/restore is durably idempotent.
type ServiceCreateRequest = Omit<VaultCreateRequest, 'operationId' | 'password'> & {
  operationId?: string;
  password?: string;
};
type ServiceRestoreRequest = Omit<VaultRestoreRequest, 'operationId' | 'password'> & {
  operationId?: string;
  password?: string;
};

/** BIP39 words are stored NFKD-normalized lowercase; typed input is folded the same way. */
function normalizeWord(word: string): string {
  return word.trim().toLowerCase().normalize('NFKD');
}

function rawBytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function marketplaceRequestHash(plan: ProviderPsbtPlanV3): string {
  const bytes = new TextEncoder().encode(JSON.stringify({
    provider: plan.provider,
    context: plan.marketplace?.context ?? null,
    psbtHash: plan.psbtHash,
  }));
  return bytesToHex(getCryptoProvider().sha256(bytes));
}

const marketplaceWorkflowJournalSchema = z.object({
  version: z.literal(1),
  accountId: z.string().regex(/^acct_(?:mainnet|signet|regtest)_[0-9a-f]{64}$/u),
  authority: z.object({
    origin: z.string().url(),
    tabId: z.number().int(),
    frameId: z.number().int(),
    documentId: z.string().min(1),
    requestNonce: z.string().min(1),
    providerMethod: z.string().min(1),
  }).strict(),
  workflow: marketplaceWorkflowSchema,
}).strict().superRefine((journal, context) => {
  if (journal.workflow.origin !== journal.authority.origin) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['authority', 'origin'],
      message: 'workflow origin differs from authority',
    });
  }
  if (!journal.accountId.startsWith(`acct_${journal.workflow.network}_`)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['accountId'],
      message: 'workflow account network differs',
    });
  }
});
type MarketplaceWorkflowJournal = z.infer<typeof marketplaceWorkflowJournalSchema>;

const marketplaceWorkflowGroupJournalSchema = z.object({
  version: z.literal(1),
  groupHash: z.string().regex(/^[0-9a-f]{64}$/u),
  workflowId: z.string().min(1).max(128),
  step: z.number().int().positive(),
  entries: z.array(z.object({
    nodeId: z.string().min(1).max(128),
    journal: marketplaceWorkflowJournalSchema,
  }).strict()).min(1).max(PROVIDER_MAX_PSBT_BATCH_ITEMS),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict().superRefine((group, context) => {
  if (new Set(group.entries.map((entry) => entry.nodeId)).size !== group.entries.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate marketplace group node' });
  }
  const ombLinkedListing = group.entries.length === 3 && group.step === 1 &&
    group.entries.every((entry, index) =>
      entry.journal.workflow.templateId === 'omb-wiki-ordnet-list-v1' &&
      entry.journal.workflow.step === index + 1);
  if (group.entries.some((entry) => entry.journal.workflow.workflowId !== group.workflowId) ||
      (!ombLinkedListing && group.entries.some((entry) => entry.journal.workflow.step !== group.step))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'marketplace group workflow differs' });
  }
});
type MarketplaceWorkflowGroupJournal = z.infer<typeof marketplaceWorkflowGroupJournalSchema>;

/** Dedicated marketplace gate: provider exposure alone is insufficient. */
export function assertMarketplaceCapability(capabilities: AccountCapabilities): void {
  if (!capabilities.canUseMarketplaces) {
    throw new RpcError('ERR_UNAUTHORIZED_CONTEXT', 'active account cannot use marketplaces');
  }
}

/**
 * Decode a recipient address to the script this wallet will pay to, rejecting
 * an undecodable address and a decodable one we cannot pay as two distinct,
 * actionable errors. Without the second check an address that decodes but has
 * no dust floor -- a future witness version, say -- surfaces as `unsupported
 * script type` from scriptDustSats several steps later, which reaches the user
 * as a bare internal error.
 */
function payableRecipient(address: string, network: Network): ResolvedPayableAddress {
  const outcome = resolvePayableAddress(address, network);
  if (outcome.ok) return outcome.value;
  if (outcome.reason === 'invalid_address') {
    throw new RpcError('ERR_INVALID_ADDRESS', 'invalid recipient address');
  }
  throw new RpcError('ERR_UNSUPPORTED_ADDRESS', 'unsupported recipient address type');
}

interface ResolvedPaymentInstruction {
  recipient: ResolvedPayableAddress;
  amountSats: bigint | null;
  label: string | null;
  message: string | null;
}

/**
 * One worker-owned boundary for both explicit paste resolution and transaction
 * planning. It never interprets alternatives or invokes proof-of-payment
 * callbacks: the only supported method is the ordinary URI path fallback.
 */
function resolvePaymentInstructionInput(
  input: string,
  network: Network,
): ResolvedPaymentInstruction {
  if (new TextEncoder().encode(input).byteLength > BIP321_LIMITS.uriBytes) {
    throw new RpcError(
      'ERR_INVALID_PAYMENT_INSTRUCTION',
      'payment instruction exceeds the BIP-321 input limit',
    );
  }
  let parsed: ParsedBip321;
  if (/^bitcoin:/iu.test(input)) {
    try {
      parsed = parseBip321(input);
    } catch {
      throw new RpcError(
        'ERR_INVALID_PAYMENT_INSTRUCTION',
        'invalid BIP-321 payment instruction',
      );
    }
  } else {
    parsed = {
      onchainFallback: { kind: 'onchain', source: 'path', address: input },
      alternatives: [],
    };
  }

  const selected = selectBip321OnchainFallback(parsed, network);
  if (!selected.ok) {
    switch (selected.reason) {
      case 'no_supported_payment_method':
        throw new RpcError(
          'ERR_UNSUPPORTED_PAYMENT_METHOD',
          'payment instruction has no supported on-chain fallback',
        );
      case 'unsupported_output_type':
        throw new RpcError('ERR_UNSUPPORTED_ADDRESS', 'unsupported recipient address type');
      case 'wrong_network':
        throw new RpcError('ERR_INVALID_ADDRESS', 'recipient address is for a different network');
      case 'invalid_address':
        throw new RpcError('ERR_INVALID_ADDRESS', 'invalid recipient address');
    }
  }

  return {
    recipient: selected.value,
    amountSats: parsed.amountSats ?? null,
    label: parsed.label ?? null,
    message: parsed.message ?? null,
  };
}

function mapNativeSendFailure(
  reason: NativeSendCandidateFailure | NativeBatchSendCandidateFailure,
): never {
  switch (reason) {
    case 'dust':
      throw new RpcError('ERR_OUTPUT_DUST', 'recipient output is dust');
    case 'manual_selection_mismatch':
      throw new RpcError('ERR_INSUFFICIENT_FUNDS', 'manual selection contains an ineligible input');
    case 'insufficient_eligible_funds':
      throw new RpcError('ERR_INSUFFICIENT_FUNDS', 'insufficient funds');
    case 'duplicate_recipient':
      throw new RpcError('ERR_INVALID_PAYLOAD', 'combine duplicate recipient amounts');
    case 'invalid_recipient_count':
      throw new RpcError('ERR_INVALID_PAYLOAD', 'batch send requires 2 to 20 recipients');
  }
}

interface ResolvedFeeBase {
  rate: bigint;
  urgency: 'priority' | 'standard' | 'economy' | 'recommended' | 'custom';
}

type ResolvedFee = ResolvedFeeBase & ({
  binding: 'quote';
  quote: FeeQuoteResponse;
  target: 2 | 6 | 12;
} | {
  binding: 'custom';
  status: Extract<StatusCapabilities, { protocolVersion: 2 }>;
});

interface RefreshedPlanClassifications {
  byOutpoint: Map<string, UtxoClassification>;
  sourceChanged: boolean;
  preservedRbfOutpoints: Set<string>;
  source: ApprovalEvidenceSource | null;
}

export { MAX_PASSKEY_RECORDS_TOTAL, MAX_PASSKEY_RECORDS_PER_VAULT, PASSKEY_GRANT_TTL_MS } from './passkey-service';

export function reconcileTrackedTransactionStatus(
  journalStatus: StoredTransaction['status'],
  observedState: SnapshotHistoryEntry['confirmationState'] | undefined,
  replacedByAcceptedWalletTransaction: boolean,
) {
  return observedState === 'mempool' && replacedByAcceptedWalletTransaction
    ? 'replaced' as const
    : reconcileTransactionStatus(journalStatus, observedState);
}

export class WalletService {
  /** Serialization queue for storage/session critical sections. */
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Single-flight guard + last failure for gateway status (worker memory only).
   * The forced flag is part of the guard: a caller that asked to revalidate must
   * never be handed a run that resolved from cache (see gatewayStatus).
   */
  private gatewayInflight: { forced: boolean; run: Promise<GatewayStatusRun> } | null = null;
  private gatewayLastFailure: GatewayRejectReason | null = null;
  /** Public display quote shared by every extension surface. */
  private priceInflight: Promise<FiatPriceQuote | null> | null = null;
  /**
   * Native transaction approvals span refresh, signing, and broadcast awaits
   * that deliberately cannot hold the storage queue. Claim the plan in worker
   * memory before the first await so two windows (or an overlapping RPC retry)
   * cannot sign and dispatch different Taproot witnesses for one plan.
   */
  private approvingPlanIds = new Set<string>();
  /** Verified raster bytes are worker-memory-only and vanish on MV3 restart. */
  private nativeInscriptionPreviews = new Map<string, InscriptionPreviewSet>();
  /**
   * Last projection written to the paint-ahead cache.
   *
   * A running scan invalidates the gallery continuously, so `galleryList` is
   * re-entered every second or so; re-serializing several MiB into session
   * storage each time buys nothing when the pixels have not moved.
   */
  private lastCachedGalleryPayload: string | null = null;
  /**
   * Exact gallery requests are shared in worker memory. Popup documents are
   * disposable, so hook-level single-flight cannot stop a close/reopen cycle
   * from launching the same signed work again while the first caller drains.
   */
  private galleryInflight = new Map<string, Promise<GalleryListResult>>();
  /** DEK-sealed L2 cache; unlike the session paint cache, survives a later unlock. */
  private readonly durableGalleryPreviews: DurableGalleryPreviewCache | null;
  /** Short-lived gallery media authority; lost on lock and MV3 restart. */
  private galleryMediaLeases = new Map<string, {
    vaultId: string;
    sessionId: string;
    inscriptionId: string;
    expiresAt: number;
  }>();

  private sweepGalleryMediaLeases(now: number): void {
    for (const [leaseId, lease] of this.galleryMediaLeases) {
      if (lease.expiresAt <= now) this.galleryMediaLeases.delete(leaseId);
    }
  }

  /** Scan state (worker memory; the encrypted checkpoint is the durable copy). */
  private scanPhase: ScanPhase = { kind: 'idle' };
  private scanUnitsTotal = 0;
  private scanCancel = false;
  private scanHistoryPartial = false;
  private scanRun: Promise<void> | null = null;
  private currentScanId: string | null = null;
  /**
   * In-flight startScan, held from entry until the loop handle is published.
   * scanRun/currentScanId only become visible after an awaited prep section, so
   * without this a second concurrent scan.start would prepare and launch its own
   * loop (see startScan).
   */
  private scanStarting: Promise<{ scanId: string }> | null = null;
  /**
   * Account removal and scan planning are mutually exclusive. The flag is set
   * synchronously before removal awaits anything, so a new scan cannot slip
   * between the cancellation check and the registry mutation.
   */
  private accountRemovalInProgress = false;

  /**
   * Outstanding worker-issued WebAuthn challenges (A2.1). Worker memory only
   * and deliberately so: an MV3 restart drops them and every in-flight
   * ceremony fails closed — the UI simply requests a fresh challenge. Each is
   * single-use (consumed on first lookup, success or failure) and expiring.
   */
  private passkeyUnlockChallenges = new Map<string, PasskeyUnlockChallenge>();
  /** Single-use enrollment authorizations minted by passkey.beginEnrollment. */
  private passkeyEnrollAuthorizations = new Map<string, PasskeyEnrollAuthorization>();

  constructor(private readonly deps: WalletServiceDeps) {
    this.durableGalleryPreviews = deps.walletCache
      ? createDurableGalleryPreviewCache({
          cache: deps.walletCache,
          network: deps.network,
          random: (length) => deps.vaultDeps.random(length),
          now: () => deps.vaultDeps.now(),
        })
      : null;
  }

  /**
   * Deps slice for the extracted passkey helpers (passkey-service.ts). The two
   * grant maps are this instance's own — the context aliases, never copies,
   * them. Callers must already hold the serialization queue; the helpers never
   * take it themselves.
   */
  private passkeyContext(): PasskeyContext {
    return {
      local: this.deps.local,
      network: this.deps.network,
      now: () => this.deps.vaultDeps.now(),
      random: (bytes) => this.deps.vaultDeps.random(bytes),
      unlockChallenges: this.passkeyUnlockChallenges,
      enrollAuthorizations: this.passkeyEnrollAuthorizations,
    };
  }

  /**
   * Scan transient state is session-scoped: whenever the session ends or its
   * identity changes (lock, expiry, switch, removal), the phase must not leak
   * to the next vault — vault B would otherwise see vault A's completed scan
   * and never auto-start its own. Nulling currentScanId also detaches any
   * still-draining loop: its setScanPhase writes are dropped and its next
   * persist fails the session check.
   */
  private resetScanState(): void {
    this.scanCancel = true; // nudge a draining loop; startScan re-arms to false
    this.currentScanId = null;
    this.scanPhase = { kind: 'idle' };
    this.scanUnitsTotal = 0;
    this.scanHistoryPartial = false;
  }

  /** Every path that ends the current session must also drop its scan state. */
  private async clearSessionAndScanState(): Promise<void> {
    this.resetScanState();
    this.nativeInscriptionPreviews.clear();
    this.galleryMediaLeases.clear();
    this.lastCachedGalleryPayload = null;
    this.galleryInflight.clear();
    // The DEK goes first, and the cosmetic cache is best-effort behind it. A
    // failed removal of paint-only pixels must never be able to abort a lock,
    // an idle expiry, or a vault switch and leave the wallet unlocked.
    await clearSession(this.deps.session);
    try {
      await Promise.all([
        clearCachedGallery(this.deps.session),
        clearHomeSnapshot(this.deps.session),
      ]);
    } catch {
      // Nothing further to do: the session is already gone, and retained UI
      // projections are unreadable without their exact live-session binding.
    }
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    // Run fn once the previous op settles (success or failure). `tail` swallows
    // outcomes so one failing op never rejects the queue for the next; the
    // caller still sees fn's real result/rejection via `run`.
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Worker-startup wiring: lock the session store to trusted contexts and drop
   * an expired session (rehydration keeps an unexpired one untouched).
   */
  async init(): Promise<void> {
    return this.runExclusive(async () => {
      await setSessionAccessTrusted(this.deps.session);
      const map = await loadVaults(this.deps.local);
      const session = await this.liveSession();
      if (session && map[session.vaultId] === undefined) {
        await this.clearSessionAndScanState();
        this.notifySessionChanged(true);
      } else {
        this.notifySessionChanged(session === null);
      }
    });
  }

  async create(input: ServiceCreateRequest): Promise<{ vaultId: string }> {
    return this.runExclusive(async () => {
      const { mnemonic, entropy } = generateMnemonic((n) => this.deps.vaultDeps.random(n));
      const seed = mnemonicToSeed(mnemonic);
      try {
        const payload: VaultPayloadV1 = {
          version: 1,
          entropyHex: bytesToHex(entropy),
          seedHex: bytesToHex(seed),
        };
        const result = await this.persistNewVault(input.name, input.password, payload, input.operationId, 'create');
        const meta = await loadVaultMeta(this.deps.local);
        const metadata = createBackupMetadata({
          origin: 'generated', wordCount: 12, usesPassphrase: false,
        });
        meta[result.vaultId] = {
          backupVerified: false, metadata, deferredUseAcknowledgedAt: null,
        };
        await saveVaultMeta(this.deps.local, meta);
        return result;
      } finally {
        zeroize(entropy);
        zeroize(seed);
      }
    });
  }

  async restore(input: ServiceRestoreRequest): Promise<{ vaultId: string }> {
    return this.runExclusive(async () => {
      const { entropy, seed } = restoreMnemonic(input.mnemonic, input.passphrase);
      try {
        const payload: VaultPayloadV1 = {
          version: 1,
          entropyHex: bytesToHex(entropy),
          seedHex: bytesToHex(seed),
          ...(input.passphrase !== undefined ? { passphrase: input.passphrase } : {}),
        };
        const result = await this.persistNewVault(input.name, input.password, payload, input.operationId, 'restore');
        // A restored user necessarily holds the seed already — the §7.1
        // forced-verification gate applies only to newly generated vaults.
        const meta = await loadVaultMeta(this.deps.local);
        const wordCount = input.mnemonic.trim().split(/\s+/u).length as RecoveryWordCount;
        const metadata = createBackupMetadata({
          origin: 'imported',
          usageGatePassed: true,
          wordCount,
          usesPassphrase: Boolean(input.passphrase),
        });
        meta[result.vaultId] = {
          backupVerified: true, metadata, deferredUseAcknowledgedAt: null,
        };
        await saveVaultMeta(this.deps.local, meta);
        return result;
      } finally {
        zeroize(entropy);
        zeroize(seed);
      }
    });
  }

  async unlock(input: VaultUnlockRequest): Promise<{ vaultId: string; sessionId: string; deadline: number }> {
    const result = await this.runExclusive(() => this.unlockLocked(input));
    void this.retryBroadcasts().catch(() => undefined);
    return result;
  }

  async lock(): Promise<{ locked: true }> {
    return this.runExclusive(async () => {
      await this.clearSessionAndScanState();
      this.notifySessionChanged(true);
      return { locked: true };
    });
  }

  /**
   * Switch active vault with reauthentication (spec §7.3). Delegates to the same
   * unlock core, which verifies the password *before* touching the prior
   * session — so a mistyped switch password leaves the current vault unlocked
   * rather than locking the wallet out.
   */
  async switchVault(input: { vaultId: string; password?: string }): Promise<{ vaultId: string; sessionId: string; deadline: number }> {
    const result = await this.runExclusive(() => this.unlockLocked(input));
    void this.retryBroadcasts().catch(() => undefined);
    return result;
  }

  async list(): Promise<{
    vaults: { vaultId: string; name: string; createdAt: number }[];
    activeVaultId: string | null;
  }> {
    return this.runExclusive(async () => {
      const map = await loadVaults(this.deps.local);
      const vaults = Object.values(map).map((r) => ({
        vaultId: r.vaultId,
        name: r.name,
        createdAt: r.createdAt,
      }));
      const session = await this.liveSession();
      return { vaults, activeVaultId: session?.vaultId ?? null };
    });
  }

  async changePassword(input: VaultChangePasswordRequest): Promise<{ ok: true }> {
    return this.runExclusive(async () => {
      const map = await loadVaults(this.deps.local);
      const community = await loadCommunityVaultOwners(this.deps.local);
      if ((await countQuarantinedVaults(this.deps.local)) > 0) {
        throw new RpcError('ERR_VAULT_TAMPERED', 'profile contains quarantined vault records');
      }
      if (community.unusableCampaignIds.length > 0) {
        throw new RpcError('ERR_COMMUNITY_VAULT_UNUSABLE', 'profile contains unreadable Community Vault owner records');
      }
      const records = Object.values(map);
      if (records.length === 0) throw new RpcError('ERR_VAULT_NOT_FOUND', 'no vaults to rewrap');

      // Rewrap only rewraps each DEK under the new password; the DEK bytes are
      // unchanged, so an active session's stored DEK stays valid (spec §7.2).
      const profile = await loadProfileCredential(this.deps.local);
      const nextCredential = profile === null ? null : await rewrapProfilePassword(
        profile.credential,
        input.oldPassword,
        input.newPassword,
        this.deps.vaultDeps,
      );
      const updated: VaultRecordV1[] = [];
      for (const record of [...records, ...community.records.map((entry) => entry.secret)]) {
        try {
          updated.push((await domainChangePassword(
            [record], input.oldPassword, input.newPassword, this.deps.vaultDeps,
          ))[0]!);
        } catch (error) {
          if (profile !== null && error instanceof VaultError && error.code === 'wrong-password') {
            updated.push(record);
          } else {
            throw error;
          }
        }
      }
      const newMap: VaultRecordMap = {};
      for (const r of updated.slice(0, records.length)) newMap[r.vaultId] = r;
      const communityUpdated = community.records.map((record, index) => ({
        ...record,
        secret: updated[records.length + index]!,
      }));
      await savePasswordChangedRecords(this.deps.local, newMap, communityUpdated);
      if (profile !== null && nextCredential !== null) {
        await saveProfileCredential(this.deps.local, { ...profile, credential: nextCredential });
      }
      return { ok: true };
    });
  }

  async sessionStatus(): Promise<SessionStatus> {
    return this.runExclusive(async () => {
      const session = await this.liveSession();
      const config = await loadConfig(this.deps.local);
      const map = await loadVaults(this.deps.local);
      let activeSession = session;
      if (activeSession && map[activeSession.vaultId] === undefined) {
        await this.clearSessionAndScanState();
        this.notifySessionChanged(true);
        activeSession = null;
      }
      if (!activeSession) {
        return {
          locked: true,
          activeVaultId: null,
          sessionId: null,
          deadline: null,
          highSecurityMode: config.highSecurityMode,
        };
      }
      return {
        locked: false,
        activeVaultId: activeSession.vaultId,
        sessionId: activeSession.sessionId,
        deadline: activeSession.deadline,
        highSecurityMode: config.highSecurityMode,
      };
    });
  }

  /** One coherent read for UI routing; avoids list/status/backup races. */
  async sessionSnapshot(): Promise<{
    vaults: { vaultId: string; name: string; createdAt: number }[];
    quarantinedVaultCount: number;
    locked: boolean;
    activeVaultId: string | null;
    sessionId: string | null;
    deadline: number | null;
    highSecurityMode: boolean;
    activeAccountId: string | null;
    activeAccount: number;
    selectableAccounts: number[];
    accountSummaries: {
      accountId: string;
      account: number;
      name: string;
      signingSource: 'software' | 'none';
    }[];
    accountAddState: AccountAddState | null;
    activeRecoveredAddressCount: number;
    backupVerified: boolean;
    capabilities: AccountCapabilities;
  }> {
    return this.runExclusive(async () => {
      const map = await loadVaults(this.deps.local);
      const [config, quarantinedVaultCount, session] = await Promise.all([
        loadConfig(this.deps.local),
        countQuarantinedVaults(this.deps.local),
        this.liveSession(),
      ]);
      const vaults = Object.values(map).map((record) => ({
        vaultId: record.vaultId,
        name: record.name,
        createdAt: record.createdAt,
      }));
      let activeSession = session;
      if (activeSession && map[activeSession.vaultId] === undefined) {
        await this.clearSessionAndScanState();
        this.notifySessionChanged(true);
        activeSession = null;
      }
      if (!activeSession) {
        return {
          vaults,
          quarantinedVaultCount,
          locked: true,
          activeVaultId: null,
          sessionId: null,
          deadline: null,
          highSecurityMode: config.highSecurityMode,
          activeAccountId: null,
          activeAccount: 0,
          selectableAccounts: [0],
          accountSummaries: [],
          accountAddState: null,
          activeRecoveredAddressCount: 0,
          backupVerified: false,
          capabilities: deriveAccountCapabilities({
            unlocked: false, vaultType: 'seed', network: this.deps.network, transport: 'software',
          }),
        };
      }
      const vaultMeta = await loadVaultMeta(this.deps.local);
      const dek = base64ToBytes(activeSession.dekB64);
      let accountsMeta: AccountsMeta;
      let activeSigningSource: AccountSigningSourceV1 = { version: 1, kind: 'none' };
      let accountSummaries: {
        accountId: string;
        account: number;
        name: string;
        signingSource: 'software' | 'none';
      }[] = [];
      let confirmedStandardAccounts = new Set<number>();
      try {
        accountsMeta = await this.loadAccountsMetaLocked(dek, activeSession.vaultId);
        accountSummaries = await Promise.all(accountsMeta.registeredPublicAccounts.map(async (account) => ({
          accountId: account.accountId,
          account: account.account,
          name: account.name,
          signingSource: (await this.accountSigningSourceLocked(
            dek, activeSession.vaultId, account.accountId,
          )).kind,
        })));
        if (accountsMeta.activePublicAccountId !== null) {
          activeSigningSource = await this.accountSigningSourceLocked(
            dek, activeSession.vaultId, accountsMeta.activePublicAccountId,
          );
        }
        confirmedStandardAccounts = await this.confirmedStandardAccountIndexesLocked(
          dek, activeSession.vaultId, accountsMeta,
        );
      } finally {
        zeroize(dek);
      }
      const activeEntry = accountsMeta.registeredPublicAccounts.find(
        (account) => account.accountId === accountsMeta.activePublicAccountId,
      );
      const activeAccount = activeEntry?.account ?? 0;
      const selectableAccounts = normalizeAccountIndexes([
        ...accountsMeta.standardAccounts,
        activeAccount,
        ...accountsMeta.activeUnits
          .filter((unit) => unit.source === 'standard')
          .map((unit) => unit.account),
      ]);
      const hiddenAccounts = new Set(
        accountsMeta.registeredPublicAccounts
          .filter((account) => accountsMeta.hiddenPublicAccountIds.includes(account.accountId))
          .map((account) => account.account),
      );
      const visibleAccounts = selectableAccounts.filter((account) => !hiddenAccounts.has(account));
      const accountAddState = activeSigningSource.kind === 'software'
        ? standardAccountAddState(
            selectableAccounts,
            confirmedStandardAccounts,
            accountsMeta.emptyAccountGapAcknowledged,
          )
        : null;
      const activeRecovered = accountsMeta.recoveredAddressCounts.find(
        (entry) => entry.accountId === activeEntry?.accountId,
      );
      return {
        vaults,
        quarantinedVaultCount,
        locked: false,
        activeVaultId: activeSession.vaultId,
        sessionId: activeSession.sessionId,
        deadline: activeSession.deadline,
        highSecurityMode: config.highSecurityMode,
        activeAccountId: activeEntry?.accountId ?? null,
        activeAccount,
        selectableAccounts: visibleAccounts,
        accountSummaries: accountSummaries.filter(
          (account) => !accountsMeta.hiddenPublicAccountIds.includes(account.accountId),
        ),
        accountAddState,
        activeRecoveredAddressCount:
          (activeRecovered?.payment ?? 0) + (activeRecovered?.ordinals ?? 0),
        backupVerified: vaultMeta[activeSession.vaultId]?.backupVerified === true,
        capabilities: derivePublicAccountCapabilities({
          unlocked: true,
          network: this.deps.network,
          signingSource: { kind: activeSigningSource.kind },
        }),
      };
    });
  }

  /**
   * Extend a live session's idle deadline (sliding window, spec §7.4). Protected
   * user actions use touchSessionLocked so authorization and extension are one
   * transition. Passive reads only authorize; wallet UI interaction reaches this
   * expectation-bound helper through the extension-local session.touch RPC.
   */
  async touchSession(expectation?: ActiveSessionRequest): Promise<number | null> {
    return this.runExclusive(async () => {
      const session = expectation
        ? await this.requireSession(expectation)
        : await this.liveSession();
      if (!session) return null;
      const deadline = await this.nextDeadline();
      await putSession(this.deps.session, { ...session, deadline });
      // UI activity already receives the authoritative deadline in the RPC
      // response. Avoid broadcasting a full session refresh for ordinary input;
      // the existing UI deadline timer will still revalidate against storage.
      // Internal touches retain the notification used by explicit operations.
      if (!expectation) this.notifySessionChanged(false);
      return deadline;
    });
  }

  /** Wake path for the periodic alarm: clear the session if the deadline passed. */
  async sweepExpired(lockForResume = false): Promise<void> {
    return this.runExclusive(async () => {
      if (lockForResume) {
        await this.clearSessionAndScanState();
        this.notifySessionChanged(true);
        return;
      }
      await this.liveSession();
    });
  }

  /**
   * Remove a vault (spec §7.4 vault-removal lock path). The whole profile locks
   * before any vault record is removed.
   */
  async removeVault(input: VaultRemoveRequest): Promise<{ removed: boolean }> {
    return this.runExclusive(async () => {
      await this.requireSession(input);
      const map = await loadVaults(this.deps.local);
      const record = map[input.targetVaultId];
      if (!record) {
        // A prior partial removal may have committed the vault-map deletion
        // and then failed before its auxiliary cleanup (A2.1 review Finding
        // 4): a retry must still purge orphaned passkey state even though
        // there is no vault record left to remove.
        await purgePasskeyStateForVault(this.passkeyContext(), input.targetVaultId);
        return { removed: false };
      }
      await this.verifyAppPassword(record, input.password);
      // Every successful removal locks, regardless of which vault was active.
      // Lock first: if a later local-storage write fails, the vault remains
      // recoverable but no DEK-equivalent material survives the operation.
      await this.clearSessionAndScanState();
      this.notifySessionChanged(true);
      await saveActiveVaultId(this.deps.local, null);
      // ADR 0007 §5: a removed vault's passkey envelopes die with it — a
      // convenience wrap must never outlive the record it unlocks. Purged
      // BEFORE the cache clear so a cache failure cannot leave an orphaned
      // envelope that is still offered for a ceremony (review Finding 4).
      await purgePasskeyStateForVault(this.passkeyContext(), input.targetVaultId);
      await this.deps.local.remove(permissionStorageKey(input.targetVaultId, this.deps.network));
      // §5.1/§7.6: the encrypted cache dies with its vault.
      await this.deps.walletCache?.clearVault(input.targetVaultId);
      // Commit the record deletion only after auxiliary cleanup succeeds. A
      // cleanup failure therefore leaves a locked, password-recoverable vault
      // that can be retried instead of an orphaned partial deletion.
      delete map[input.targetVaultId];
      await saveVaults(this.deps.local, map);
      const meta = await loadVaultMeta(this.deps.local);
      if (meta[input.targetVaultId]) {
        delete meta[input.targetVaultId];
        await saveVaultMeta(this.deps.local, meta);
      }
      const profile = await loadProfileCredential(this.deps.local);
      if (profile !== null) {
        await saveProfileCredential(this.deps.local, {
          ...profile,
          secrets: removeProfileSecret(profile.secrets, {
            profileId: profile.credential.profileId,
            secretId: input.targetVaultId,
            kind: 'wallet-dek',
          }),
        });
      }
      return { removed: true };
    });
  }

  /**
   * Seed reveal (spec §7.6) and onboarding display (§7.1). Reauthenticates with
   * the password against the *active* vault record. It never creates or replaces
   * a session; successful authenticated activity extends the existing deadline.
   */
  async revealMnemonic(input: VaultRevealMnemonicRequest): Promise<{ mnemonic: string }> {
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const { capabilities } = await this.activePublicAccountContextLocked(
        dek, session.vaultId,
      );
      if (!capabilities.canRevealSeed) {
        throw new RpcError('ERR_UNSAFE_TRANSACTION', 'active account cannot reveal the seed');
      }
      const map = await loadVaults(this.deps.local);
      const record = map[session.vaultId];
      if (!record) throw new RpcError('ERR_VAULT_NOT_FOUND', 'active vault record missing');
      await this.verifyAppPassword(record, input.password);
      const entropy = hexToBytes(openVaultPayload(record, dek).entropyHex);
      try {
        const result = { mnemonic: entropyToMnemonic(entropy) };
        await this.touchSessionLocked(session);
        return result;
      } finally {
        zeroize(entropy);
      }
    }));
  }

  /**
   * §7.1 forced seed-word verification: the worker — not the UI — decides
   * whether the typed words match, and only a worker-verified match marks the
   * vault usable. A mismatch reports verified:false so the UI reshuffles.
   */
  async verifyBackup(input: VaultVerifyBackupRequest): Promise<{ verified: boolean }> {
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const { capabilities } = await this.activePublicAccountContextLocked(
        dek, session.vaultId,
      );
      if (!capabilities.canRevealSeed) {
        throw new RpcError('ERR_UNSAFE_TRANSACTION', 'active account cannot verify a seed backup');
      }
      const vaults = await loadVaults(this.deps.local);
      const record = vaults[session.vaultId];
      if (!record) throw new RpcError('ERR_VAULT_NOT_FOUND', 'active vault record missing');
      const payload = openVaultPayload(record, dek);
      const { vaultId, words } = await (async () => {
        const entropy = hexToBytes(payload.entropyHex);
        try {
          return { vaultId: session.vaultId, words: entropyToMnemonic(entropy).split(' ') };
        } finally {
          zeroize(entropy);
        }
      })();
      const verified = input.words.every(({ index, word }) => {
        const expected = words[index];
        return expected !== undefined && normalizeWord(word) === expected;
      });
      if (verified) {
        const meta = await loadVaultMeta(this.deps.local);
        const existing = meta[vaultId];
        const observed = existing?.metadata.wordCount === null
          ? {
              ...existing.metadata,
              wordCount: words.length as RecoveryWordCount,
              usesPassphrase: payload.passphrase !== undefined,
            } as BackupMetadataV1
          : existing?.metadata ?? createBackupMetadata({
              origin: 'generated', wordCount: words.length as RecoveryWordCount, usesPassphrase: false,
            });
        const metadata = recordBackupSpotCheck(observed, this.deps.vaultDeps.now());
        meta[vaultId] = {
          backupVerified: true,
          metadata,
          deferredUseAcknowledgedAt: existing?.deferredUseAcknowledgedAt ?? null,
        };
        await saveVaultMeta(this.deps.local, meta);
      }
      await this.touchSessionLocked(session);
      return { verified };
    }));
  }

  async verifyFullRecovery(input: {
    mnemonic: string;
    passphrase?: string | undefined;
    expectedVaultId: string;
    expectedSessionId: string;
  }): Promise<{ verified: boolean }> {
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const { capabilities } = await this.activePublicAccountContextLocked(
        dek, session.vaultId,
      );
      if (!capabilities.canRevealSeed) {
        throw new RpcError('ERR_UNSAFE_TRANSACTION', 'active account cannot verify a seed backup');
      }
      const vaults = await loadVaults(this.deps.local);
      const record = vaults[session.vaultId];
      if (!record) throw new RpcError('ERR_VAULT_NOT_FOUND', 'active vault record missing');
      const payload = openVaultPayload(record, dek);
      const verified = verifyFullRecoveryRehearsal({
        mnemonic: input.mnemonic,
        ...(input.passphrase !== undefined && input.passphrase !== ''
          ? { passphrase: input.passphrase }
          : {}),
        expectedSeedHex: payload.seedHex,
      });
      if (verified) {
        const meta = await loadVaultMeta(this.deps.local);
        const existing = meta[session.vaultId];
        const wordCount = input.mnemonic.trim().split(/\s+/u).length as RecoveryWordCount;
        const observed = existing?.metadata.wordCount === null
          ? {
              ...existing.metadata,
              wordCount,
              usesPassphrase: payload.passphrase !== undefined,
            } as BackupMetadataV1
          : existing?.metadata ?? createBackupMetadata({
              origin: 'imported', usageGatePassed: true, wordCount,
              usesPassphrase: payload.passphrase !== undefined,
            });
        const metadata = recordFullRecoveryCheck(observed, this.deps.vaultDeps.now());
        meta[session.vaultId] = {
          backupVerified: metadata.usageGatePassed,
          metadata,
          deferredUseAcknowledgedAt: existing?.deferredUseAcknowledgedAt ?? null,
        };
        await saveVaultMeta(this.deps.local, meta);
      }
      await this.touchSessionLocked(session);
      return { verified };
    }));
  }

  async backupStatus(input: ActiveSessionRequest): Promise<{
    backupVerified: boolean;
    metadata?: BackupMetadataV1;
  }> {
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const meta = await loadVaultMeta(this.deps.local);
      let entry = meta[session.vaultId];
      if (entry?.metadata.origin === 'legacy_unknown' &&
          (entry.metadata.wordCount === null || entry.metadata.usesPassphrase === null)) {
        const vaults = await loadVaults(this.deps.local);
        const record = vaults[session.vaultId];
        if (!record) throw new RpcError('ERR_VAULT_NOT_FOUND', 'active vault record missing');
        const payload = openVaultPayload(record, dek);
        const entropy = hexToBytes(payload.entropyHex);
        let observedWordCount: RecoveryWordCount;
        try {
          observedWordCount = entropyToMnemonic(entropy).split(' ').length as RecoveryWordCount;
        } finally {
          zeroize(entropy);
        }
        const metadata: BackupMetadataV1 = {
          ...entry.metadata,
          wordCount: observedWordCount,
          usesPassphrase: payload.passphrase !== undefined,
        };
        entry = { ...entry, metadata };
        meta[session.vaultId] = entry;
        await saveVaultMeta(this.deps.local, meta);
      }
      const result = {
        backupVerified: entry?.backupVerified === true,
        ...(entry !== undefined ? { metadata: entry.metadata } : {}),
      };
      return result;
    }));
  }

  async backupDeferralStatus(): Promise<{ deferred: boolean }> {
    return this.runExclusive(async () => {
      const session = await this.liveSession();
      if (session === null) return { deferred: false };
      const meta = await loadVaultMeta(this.deps.local);
      return {
        deferred: meta[session.vaultId]?.backupVerified !== true &&
          (meta[session.vaultId]?.deferredUseAcknowledgedAt ?? null) !== null,
      };
    });
  }

  async deferBackup(input: ActiveSessionRequest): Promise<{ deferred: true }> {
    return this.runExclusive(() => this.withSessionDek(input, async (_dek, session) => {
      const meta = await loadVaultMeta(this.deps.local);
      const entry = meta[session.vaultId];
      if (entry === undefined) throw new RpcError('ERR_VAULT_NOT_FOUND');
      meta[session.vaultId] = {
        ...entry,
        deferredUseAcknowledgedAt: entry.deferredUseAcknowledgedAt ?? this.deps.vaultDeps.now(),
      };
      await saveVaultMeta(this.deps.local, meta);
      await this.touchSessionLocked(session);
      this.notifySessionChanged(false);
      return { deferred: true as const };
    }));
  }

  /**
   * Stable external receive address (spec §8.1, §10.6): change 0, index 0 of
   * active standard account, on the channel-pinned network. Gated on the §7.1 backup
   * verification — an unverified vault is not usable.
   */
  async receiveAddress(input: AddressReceiveRequest): Promise<{
    accountId: string;
    address: string;
    path: string;
    kind: 'payment' | 'ordinals';
    network: Network;
  }> {
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
        const accountsMeta = await this.loadAccountsMetaLocked(dek, session.vaultId);
        const registered = accountsMeta.registeredPublicAccounts.find(
          (account) => account.accountId === input.accountId,
        );
        if (!registered || registered.network !== this.deps.network) {
          throw new RpcError('ERR_INVALID_PAYLOAD', 'account is not registered for this network');
        }
        const signingSource = await this.accountSigningSourceLocked(
          dek, session.vaultId, input.accountId,
        );
        if (signingSource.kind === 'software') {
          const meta = await loadVaultMeta(this.deps.local);
          const backup = meta[session.vaultId];
          if (backup?.backupVerified !== true &&
              (backup?.deferredUseAcknowledgedAt ?? null) === null) {
            throw new RpcError('ERR_BACKUP_REQUIRED', 'seed backup not verified');
          }
        }
        const definition = await this.loadPublicAccountDefinitionLocked(
          dek, session.vaultId, input.accountId,
        );
        const info = derivePublicAccountAddress(definition, input.kind, 0, 0);
        return {
          accountId: input.accountId,
          address: info.address,
          path: info.path,
          kind: input.kind,
          network: this.deps.network,
        };
    }));
  }

  /** Resolve an address or BIP-321 instruction without trusting the UI. */
  async resolvePaymentInstruction(
    input: PaymentInstructionResolveRequest,
  ): Promise<PaymentInstructionResolveResult> {
    return this.runExclusive(() => this.withSessionDek(input, async (_dek, session) => {
      const resolved = resolvePaymentInstructionInput(input.input, this.deps.network);
      await this.touchSessionLocked(session);
      return {
        address: resolved.recipient.address,
        amountSats: resolved.amountSats?.toString() ?? null,
        label: resolved.label,
        message: resolved.message,
      };
    }));
  }

  /** Manual, first-party BIP-322 signing with an immutable address choice and password reauth. */
  async signMessage(input: MessageSignRequest): Promise<MessageSignResult> {
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const accountsMeta = await this.loadAccountsMetaLocked(dek, session.vaultId);
      const registered = accountsMeta.registeredPublicAccounts.find(
        (account) => account.accountId === input.accountId,
      );
      if (!registered || registered.network !== this.deps.network) {
        throw new RpcError('ERR_INVALID_PAYLOAD', 'account is not registered for this network');
      }
      const signingSource = await this.accountSigningSourceLocked(
        dek, session.vaultId, input.accountId,
      );
      if (signingSource.kind !== 'software') {
        throw new RpcError('ERR_UNSAFE_TRANSACTION', 'account cannot sign messages');
      }
      const vaults = await loadVaults(this.deps.local);
      const record = vaults[session.vaultId];
      if (!record) throw new RpcError('ERR_VAULT_NOT_FOUND', 'active vault record missing');
      await this.verifyAppPassword(record, input.password);

      const payload = openVaultPayload(record, dek);
      const seed = hexToBytes(payload.seedHex);
      const accountNode = deriveAccountNode(
        seed, input.addressKind, this.deps.network, registered.account,
      );
      const chain = accountNode.deriveChild(0);
      const key = chain.deriveChild(0);
      try {
        if (!key.privateKey) {
          throw new RpcError('ERR_UNSAFE_TRANSACTION', 'signing key unavailable');
        }
        const address = deriveAddress(
          accountNode, input.addressKind, this.deps.network, 0, 0,
        ).address;
        const signature = signBip322Simple({
          message: input.message,
          privateKey: key.privateKey,
          addressKind: input.addressKind,
          random: (length) => this.deps.vaultDeps.random(length),
        });
        if (!verifyBip322Simple(input.message, address, this.deps.network, signature)) {
          throw new RpcError('ERR_UNSAFE_TRANSACTION', 'BIP-322 post-sign verification failed');
        }
        const messageHashHex = bytesToHex(
          bip322MessageHash(validateBip322Message(input.message)),
        );
        await this.touchSessionLocked(session);
        return { protocol: 'BIP-322', address, signature, messageHashHex };
      } finally {
        key.privateKey?.fill(0);
        key.wipePrivateData();
        chain.wipePrivateData();
        accountNode.wipePrivateData();
        zeroize(seed);
      }
    }));
  }

  async addressBook(input: ActiveSessionRequest): Promise<AddressBookV1> {
    return this.runExclusive(() => this.withSessionDek(
      input, (dek, session) => this.loadAddressBookLocked(dek, session.vaultId),
    ));
  }

  async addAddressBookRecipient(input: AddressBookAddRequest): Promise<AddressBookV1> {
    return this.mutateAddressBook(input, (book) => addSavedRecipient(book, {
      id: bytesToHex(this.deps.vaultDeps.random(16)),
      label: input.label,
      address: input.address,
      nowMs: this.deps.vaultDeps.now(),
    }));
  }

  async renameAddressBookRecipient(input: AddressBookRenameRequest): Promise<AddressBookV1> {
    return this.mutateAddressBook(input, (book) => renameSavedRecipient(book, {
      id: input.id,
      label: input.label,
      nowMs: this.deps.vaultDeps.now(),
    }));
  }

  async removeAddressBookRecipient(input: AddressBookRemoveRequest): Promise<AddressBookV1> {
    return this.mutateAddressBook(input, (book) => removeSavedRecipient(book, input.id));
  }

  async importAddressBookRecipients(
    input: AddressBookImportRequest,
  ): Promise<AddressBookImportResult> {
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      let merged;
      try {
        merged = mergeContactTransferRecipients({
          addressBook: await this.loadAddressBookLocked(dek, session.vaultId),
          recipients: input.recipients,
          nowMs: this.deps.vaultDeps.now(),
          newId: () => bytesToHex(this.deps.vaultDeps.random(16)),
        });
      } catch (error) {
        if (error instanceof AddressBookError) {
          throw new RpcError('ERR_INVALID_PAYLOAD', error.message);
        }
        throw error;
      }
      await this.saveAddressBookLocked(dek, session.vaultId, merged.addressBook);
      await this.touchSessionLocked(session);
      return merged;
    }));
  }

  async dismissRecentAddressBookRecipient(
    input: AddressBookDismissRecentRequest,
  ): Promise<AddressBookV1> {
    return this.mutateAddressBook(
      input, (book) => dismissRecentRecipient(book, input.address),
    );
  }

  async clearRecentAddressBookRecipients(input: ActiveSessionRequest): Promise<AddressBookV1> {
    return this.mutateAddressBook(input, (book) => ({ ...book, recent: [] }));
  }

  async getConfig(): Promise<{
    idleTimeoutMs: number;
    highSecurityMode: boolean;
    advancedPsbtSigning: boolean;
  }> {
    return this.runExclusive(async () => {
      const config = await loadConfig(this.deps.local);
      return {
        idleTimeoutMs: config.idleTimeoutMs,
        highSecurityMode: config.highSecurityMode,
        advancedPsbtSigning: false,
      };
    });
  }

  async setConfig(input: ConfigSetRequest): Promise<{
    idleTimeoutMs: number;
    highSecurityMode: boolean;
    advancedPsbtSigning: boolean;
  }> {
    return this.runExclusive(async () => {
      const session = await this.requireSession(input);
      const config = await loadConfig(this.deps.local);
      const next = {
        ...config,
        ...(input.idleTimeoutMs !== undefined ? { idleTimeoutMs: input.idleTimeoutMs } : {}),
        ...(input.highSecurityMode !== undefined ? { highSecurityMode: input.highSecurityMode } : {}),
      };
      await saveConfig(this.deps.local, next);
      await this.touchSessionLocked(session);
      this.notifyWalletDataChanged('config');
      return {
        idleTimeoutMs: next.idleTimeoutMs,
        highSecurityMode: next.highSecurityMode,
        advancedPsbtSigning: false,
      };
    });
  }

  async getActiveAccount(input: ActiveSessionRequest): Promise<{ accountId: string; account: number }> {
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const meta = await this.loadAccountsMetaLocked(dek, session.vaultId);
      const active = meta.registeredPublicAccounts.find(
        (account) => account.accountId === meta.activePublicAccountId,
      );
      if (!active) throw new RpcError('ERR_INVALID_PAYLOAD', 'active account unavailable');
      return { accountId: active.accountId, account: active.account };
    }));
  }

  async setActiveAccount(input: ActiveAccountSetRequest): Promise<{ accountId: string; account: number }> {
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const config = await loadConfig(this.deps.local);
      const meta = await this.loadAccountsMetaLocked(dek, session.vaultId);
      const selected = meta.registeredPublicAccounts.find(
        (account) => account.accountId === input.accountId,
      );
      if (!selected) {
        throw new RpcError('ERR_INVALID_PAYLOAD', 'account has not been created or imported');
      }
      if (meta.hiddenPublicAccountIds.includes(input.accountId)) {
        throw new RpcError('ERR_INVALID_PAYLOAD', 'account is hidden');
      }
      const key = activeAccountKey(session.vaultId, this.deps.network);
      await this.saveAccountsMetaLocked(dek, session.vaultId, {
        ...meta,
        activePublicAccountId: selected.accountId,
      });
      // Keep the v2 numeric preference synchronized until the config schema is
      // retired; it is compatibility state, never account identity.
      await saveConfig(this.deps.local, {
        ...config,
        activeAccounts: { ...config.activeAccounts, [key]: selected.account },
      });
      await this.touchSessionLocked(session);
      try {
        this.deps.notifyAccountChanged?.(selected.accountId, selected.account);
      } catch {
        // Provider invalidation is best-effort; persisted state is authoritative.
      }
      this.notifyWalletDataChanged('account');
      return { accountId: selected.accountId, account: selected.account };
    }));
  }

  async addAccount(input: AccountAddRequest): Promise<{ accountId: string; account: number }> {
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const { capabilities } = await this.activePublicAccountContextLocked(
        dek, session.vaultId,
      );
      if (!capabilities.canRevealSeed) {
        throw new RpcError('ERR_UNSAFE_TRANSACTION', 'active account cannot derive a software account');
      }
      const config = await loadConfig(this.deps.local);
      const key = activeAccountKey(session.vaultId, this.deps.network);
      const current = config.activeAccounts[key] ?? 0;
      const meta = await this.loadAccountsMetaLocked(dek, session.vaultId);
      const accounts = normalizeAccountIndexes([
        ...meta.standardAccounts,
        current,
        ...meta.activeUnits
          .filter((unit) => unit.source === 'standard')
          .map((unit) => unit.account),
      ]);
      const confirmedAccounts = await this.confirmedStandardAccountIndexesLocked(
        dek, session.vaultId, meta,
      );
      const addState = standardAccountAddState(
        accounts, confirmedAccounts, meta.emptyAccountGapAcknowledged,
      );
      if (addState.kind === 'empty_limit') {
        throw new RpcError(
          'ERR_INVALID_PAYLOAD',
          'You already have five unused accounts. Use one and let its transaction confirm before adding another.',
        );
      }
      if (addState.kind === 'index_exhausted') {
        throw new RpcError('ERR_INVALID_PAYLOAD', 'BIP32 account index space exhausted');
      }
      if (addState.requiresAcknowledgement && !input.acknowledgeEmptyAccountRisk) {
        throw new RpcError(
          'ERR_INVALID_PAYLOAD',
          'acknowledge the empty-account recovery warning before creating this account',
        );
      }
      const account = addState.nextAccount;
      const vaults = await loadVaults(this.deps.local);
      const record = vaults[session.vaultId];
      if (!record) throw new RpcError('ERR_VAULT_NOT_FOUND', 'active vault record missing');
      const payload = openVaultPayload(record, dek);
      const seed = hexToBytes(payload.seedHex);
      let migrated: ReturnType<typeof migrateLegacySoftwareAccountV1>;
      try {
        migrated = migrateLegacySoftwareAccountV1(
          seed, this.deps.network, account, session.vaultId,
        );
      } finally {
        zeroize(seed);
      }
      await this.savePublicAccountDefinitionLocked(dek, session.vaultId, migrated.definition);
      await this.saveAccountSigningBindingLocked(dek, session.vaultId, migrated.binding);
      await this.saveAccountsMetaLocked(dek, session.vaultId, {
        ...meta,
        standardAccounts: [...accounts, account],
        registeredPublicAccounts: [
          ...meta.registeredPublicAccounts,
          {
            accountId: migrated.definition.accountId,
            network: this.deps.network,
            source: 'standard',
            account,
            name: `Account ${account + 1}`,
          },
        ],
        activePublicAccountId: migrated.definition.accountId,
        emptyAccountGapAcknowledged: meta.emptyAccountGapAcknowledged ||
          (addState.requiresAcknowledgement && input.acknowledgeEmptyAccountRisk),
      });
      await saveConfig(this.deps.local, {
        ...config,
        activeAccounts: { ...config.activeAccounts, [key]: account },
      });
      await this.touchSessionLocked(session);
      try {
        this.deps.notifyAccountChanged?.(migrated.definition.accountId, account);
      } catch {
        // Provider invalidation is best-effort; persisted state is authoritative.
      }
      this.notifyWalletDataChanged('account');
      return { accountId: migrated.definition.accountId, account };
    }));
  }

  async listAccounts(input: ActiveSessionRequest): Promise<AccountListResult> {
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const meta = await this.loadAccountsMetaLocked(dek, session.vaultId);
      const activeId = meta.activePublicAccountId;
      const hidden = new Set(meta.hiddenPublicAccountIds);
      const visible = meta.registeredPublicAccounts.filter((account) => !hidden.has(account.accountId));
      const utxos = await this.loadAllUtxosLocked(dek, session.vaultId);
      const holdings = new Set(utxos.map((utxo) => utxo.accountId));
      const pending = await this.pendingAccountIndexesLocked(dek, session.vaultId);
      const records = await this.accountRecordCoverageLocked(dek, session.vaultId);
      const globallyFresh = meta.lastSyncedAt !== null && meta.revision !== null &&
        !meta.hasConflictingSources;
      const activeSigningSource = meta.activePublicAccountId === null
        ? { version: 1, kind: 'none' } as const
        : await this.accountSigningSourceLocked(
            dek, session.vaultId, meta.activePublicAccountId,
          );
      const accountAddState = activeSigningSource.kind === 'software'
        ? standardAccountAddState(
            normalizeAccountIndexes(meta.standardAccounts),
            await this.confirmedStandardAccountIndexesLocked(dek, session.vaultId, meta),
            meta.emptyAccountGapAcknowledged,
          )
        : null;

      const result: AccountListResult = {
        accounts: await Promise.all(meta.registeredPublicAccounts.map(async (registered) => {
          const account = registered.account;
          const isHidden = hidden.has(registered.accountId);
          const hasHistory = meta.activeUnits.some(
            (unit) => unit.accountId === registered.accountId,
          );
          const blocker = registered.accountId === activeId
            ? 'active' as const
            : visible.length <= 1 && !isHidden
              ? 'last_visible' as const
              : !globallyFresh || !records.has(registered.accountId)
                ? 'stale' as const
                : holdings.has(registered.accountId)
                  ? 'holdings' as const
                  : pending.has(account) || pending.has(-1)
                    ? 'pending' as const
                    : null;
          return {
            accountId: registered.accountId,
            account,
            name: registered.name,
            signingSource: (await this.accountSigningSourceLocked(
              dek, session.vaultId, registered.accountId,
            )).kind,
            active: registered.accountId === activeId,
            hidden: isHidden,
            hasHistory,
            canHide: !isHidden && blocker === null,
            hideBlocker: isHidden ? null : blocker,
          };
        })),
        accountAddState,
      };
      return result;
    }));
  }

  async setAccountVisibility(input: AccountVisibilitySetRequest): Promise<{
    accountId: string;
    account: number;
    hidden: boolean;
  }> {
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const meta = await this.loadAccountsMetaLocked(dek, session.vaultId);
      const registered = meta.registeredPublicAccounts.find(
        (account) => account.accountId === input.accountId,
      );
      if (!registered) {
        throw new RpcError('ERR_INVALID_PAYLOAD', 'account has not been created or discovered');
      }
      if (!input.hidden) {
        await this.saveAccountsMetaLocked(dek, session.vaultId, {
          ...meta,
          hiddenPublicAccountIds: meta.hiddenPublicAccountIds.filter(
            (accountId) => accountId !== input.accountId,
          ),
        });
      } else {
        const listed = await this.accountVisibilityBlockerLocked(
          dek, session.vaultId, registered.accountId, meta,
        );
        if (listed !== null) {
          throw new RpcError('ERR_INVALID_PAYLOAD', `account cannot be hidden: ${listed}`);
        }
        await this.saveAccountsMetaLocked(dek, session.vaultId, {
          ...meta,
          hiddenPublicAccountIds: [...meta.hiddenPublicAccountIds, input.accountId],
        });
      }
      await this.touchSessionLocked(session);
      this.notifyWalletDataChanged('account');
      return { accountId: input.accountId, account: registered.account, hidden: input.hidden };
    }));
  }

  async importWatchAccount(
    input: PublicAccountImportRequest,
  ): Promise<{ accountId: string; account: number }> {
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      if (input.network !== this.deps.network) {
        throw new RpcError('ERR_INVALID_PAYLOAD', 'descriptor network differs from this build');
      }
      let definition: PublicAccountDefinitionV1;
      try {
        definition = parsePublicAccountDescriptors(input);
      } catch (error) {
        throw new RpcError(
          'ERR_INVALID_PAYLOAD',
          error instanceof Error ? error.message : 'invalid public account descriptors',
        );
      }
      const meta = await this.loadAccountsMetaLocked(dek, session.vaultId);
      if (meta.registeredPublicAccounts.some((account) => account.accountId === definition.accountId)) {
        throw new RpcError('ERR_INVALID_PAYLOAD', 'account is already registered');
      }
      const binding: AccountSigningBinding = {
        version: 1,
        accountId: definition.accountId,
        signingSource: { version: 1, kind: 'none' },
      };
      await this.savePublicAccountDefinitionLocked(dek, session.vaultId, definition);
      await this.saveAccountSigningBindingLocked(dek, session.vaultId, binding);
      await this.saveAccountsMetaLocked(dek, session.vaultId, {
        ...meta,
        registeredPublicAccounts: [
          ...meta.registeredPublicAccounts,
          {
            accountId: definition.accountId,
            network: definition.network,
            source: 'descriptor',
            account: definition.derivationAccountIndex,
            name: input.name.trim(),
          },
        ],
        activePublicAccountId: definition.accountId,
      });
      const config = await loadConfig(this.deps.local);
      const key = activeAccountKey(session.vaultId, this.deps.network);
      await saveConfig(this.deps.local, {
        ...config,
        activeAccounts: {
          ...config.activeAccounts,
          [key]: definition.derivationAccountIndex,
        },
      });
      await this.touchSessionLocked(session);
      try {
        this.deps.notifyAccountChanged?.(definition.accountId, definition.derivationAccountIndex);
      } catch {
        // Provider invalidation is best-effort; persisted account identity is authoritative.
      }
      this.notifyWalletDataChanged('account');
      return { accountId: definition.accountId, account: definition.derivationAccountIndex };
    }));
  }

  async exportPublicAccount(
    input: PublicAccountExportRequest,
  ): Promise<{ definition: PublicAccountDefinitionV1 }> {
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const source = await this.accountSigningSourceLocked(dek, session.vaultId, input.accountId);
      const capabilities = derivePublicAccountCapabilities({
        unlocked: true,
        network: this.deps.network,
        signingSource: { kind: source.kind },
      });
      if (!capabilities.canExportPublicAccount) {
        throw new RpcError('ERR_UNSAFE_TRANSACTION', 'public account export is unavailable for this account');
      }
      // Export is deliberately reauthenticated against wrappedDek without
      // decrypting the seed payload. Definitions come only from the separately
      // encrypted public-account store.
      const map = await loadVaults(this.deps.local);
      const record = map[session.vaultId];
      if (!record) throw new RpcError('ERR_VAULT_NOT_FOUND', 'active vault record missing');
      await this.verifyAppPassword(record, input.password);
      const definition = await this.loadPublicAccountDefinitionLocked(
        dek, session.vaultId, input.accountId,
      );
      await this.touchSessionLocked(session);
      return { definition };
    }));
  }

  async removeWatchAccount(input: PublicAccountRemoveRequest): Promise<{ removed: true }> {
    if (this.accountRemovalInProgress) {
      throw new RpcError('ERR_PLAN_CHANGED', 'account removal is already in progress');
    }
    this.accountRemovalInProgress = true;
    try {
      // A scan may be outside the wallet mutex while a gateway request is in
      // flight. Publish cancellation first, join both its preparation and its
      // loop, and only then mutate the public-account registry. startScan's
      // synchronous removal guard prevents a replacement loop from racing in.
      this.scanCancel = true;
      const starting = this.scanStarting;
      if (starting) await starting.catch(() => null);
      this.scanCancel = true;
      const running = this.scanRun;
      if (running) await running.catch(() => undefined);

      const result = await this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const cache = this.requireCache();
      const meta = await this.loadAccountsMetaLocked(dek, session.vaultId);
      const removed = meta.registeredPublicAccounts.find(
        (account) => account.accountId === input.accountId,
      );
      if (!removed || removed.source !== 'descriptor') {
        throw new RpcError('ERR_INVALID_PAYLOAD', 'only imported watch-only accounts can be removed');
      }
      const fallback = meta.registeredPublicAccounts.find(
        (account) => account.accountId !== input.accountId &&
          !meta.hiddenPublicAccountIds.includes(account.accountId),
      );
      if (!fallback) throw new RpcError('ERR_INVALID_PAYLOAD', 'another visible account is required');

      // Pending transaction and broadcast journals are safety evidence. They
      // must remain attributable to a stable account for revalidation and
      // recovery; an unreadable or legacy plan makes that attribution
      // ambiguous, so removal fails closed before deleting any account state.
      const plans = new Map<string, TransactionPlan>();
      for (const planId of await cache.listKeys(session.vaultId, this.deps.network, 'plans')) {
        const record = await cache.get(this.cacheKey(session.vaultId, 'plans', planId));
        if (!record) {
          throw new RpcError('ERR_PLAN_CHANGED', 'pending transaction journal is incomplete');
        }
        let plan: TransactionPlan;
        try {
          const parsed = openRecord(dek, record, storedPlanSchema);
          if (parsed.version !== 4) {
            throw new Error('legacy plan identity is ambiguous');
          }
          assertPlanHash(parsed);
          if (parsed.planId !== planId) throw new Error('plan journal key differs');
          plan = parsed;
        } catch {
          throw new RpcError('ERR_PLAN_CHANGED', 'pending transaction attribution is unavailable');
        }
        plans.set(planId, plan);
        if (plan.accountId === input.accountId) {
          throw new RpcError('ERR_PLAN_CHANGED', 'account has a pending transaction plan');
        }
      }
      for (const planId of await cache.listKeys(
        session.vaultId, this.deps.network, 'broadcastRecovery',
      )) {
        const record = await cache.get(this.cacheKey(session.vaultId, 'broadcastRecovery', planId));
        if (!record) {
          throw new RpcError('ERR_PLAN_CHANGED', 'broadcast recovery journal is incomplete');
        }
        try {
          const recovery = openRecord(dek, record, broadcastRecoverySchema);
          if (recovery.planId !== planId) throw new Error('recovery journal key differs');
        } catch {
          throw new RpcError('ERR_PLAN_CHANGED', 'broadcast recovery journal is unreadable');
        }
        const plan = plans.get(planId);
        if (!plan) {
          throw new RpcError('ERR_PLAN_CHANGED', 'broadcast recovery attribution is unavailable');
        }
        if (plan.accountId === input.accountId) {
          throw new RpcError('ERR_PLAN_CHANGED', 'account has a pending broadcast recovery');
        }
      }
      for (const recoveryId of await cache.listKeys(
        session.vaultId, this.deps.network, 'providerBroadcastRecovery',
      )) {
        const record = await cache.get(this.cacheKey(
          session.vaultId, 'providerBroadcastRecovery', recoveryId,
        ));
        if (!record) {
          throw new RpcError('ERR_PLAN_CHANGED', 'provider recovery journal is incomplete');
        }
        let providerPlan: ProviderPsbtPlanV3;
        try {
          const recovery = openRecord(dek, record, providerBroadcastRecoverySchema);
          providerPlan = recovery.plan as ProviderPsbtPlanV3;
          assertProviderPsbtPlan(providerPlan);
          if (providerPlan.planId !== recoveryId) throw new Error('provider recovery key differs');
        } catch {
          throw new RpcError('ERR_PLAN_CHANGED', 'provider recovery attribution is unavailable');
        }
        if (providerPlan.accountId === input.accountId) {
          throw new RpcError('ERR_PLAN_CHANGED', 'account has a pending provider recovery');
        }
      }

      const targetOwnedOutpoints = new Set<string>();
      const targetInscriptionIds = new Set<string>();
      const targetHistoryKeys = new Set(
        (['payment', 'ordinals'] as const).map((lane) => unitKey({
          source: 'descriptor',
          accountId: input.accountId,
          account: removed.account,
          lane,
        })),
      );
      const allHistory: SnapshotHistoryEntry[] = [];
      const targetHistory: SnapshotHistoryEntry[] = [];
      for (const historyKey of await cache.listKeys(
        session.vaultId, this.deps.network, 'history',
      )) {
        const record = await cache.get(this.cacheKey(session.vaultId, 'history', historyKey));
        if (!record) {
          throw new RpcError('ERR_PLAN_CHANGED', 'wallet history journal is incomplete');
        }
        let history: SnapshotHistoryEntry[];
        try {
          history = (openRecord(
            dek, record, storedHistoryReadSchema,
          ) as StoredHistoryRecord).entries;
        } catch {
          throw new RpcError('ERR_PLAN_CHANGED', 'wallet history attribution is unavailable');
        }
        allHistory.push(...history);
        if (targetHistoryKeys.has(historyKey)) targetHistory.push(...history);
      }

      for (const lane of ['payment', 'ordinals'] as const) {
        const unit = unitKey({
          source: 'descriptor',
          accountId: input.accountId,
          account: removed.account,
          lane,
        });
        const record = await cache.get(this.cacheKey(session.vaultId, 'utxos', unit));
        if (record) {
          try {
            const utxos = migrateLegacyStoredUtxos(
              storedUtxosSchema.parse(openRecord(dek, record, storedUtxosSchema)),
              () => null,
            );
            for (const utxo of utxos) {
              if (utxo.accountId !== input.accountId) {
                throw new Error('descriptor UTXO cache identity differs');
              }
              targetOwnedOutpoints.add(outpointKey(utxo.outpoint));
              for (const inscription of utxo.facts?.inscriptions ?? []) {
                targetInscriptionIds.add(inscription.inscriptionId);
              }
            }
          } catch {
            throw new RpcError('ERR_PLAN_CHANGED', 'account UTXO attribution is unavailable');
          }
        }
      }

      const terminalTransactionIds: string[] = [];
      for (const txid of await cache.listKeys(session.vaultId, this.deps.network, 'transactions')) {
        const record = await cache.get(this.cacheKey(session.vaultId, 'transactions', txid));
        if (!record) {
          throw new RpcError('ERR_PLAN_CHANGED', 'terminal transaction journal is incomplete');
        }
        let transaction: StoredTransaction;
        try {
          transaction = openRecord(dek, record, storedTransactionSchema);
          if (transaction.txid !== txid || transaction.planId !== transaction.plan.planId ||
              transaction.plan.version !== 4) {
            throw new Error('terminal transaction identity is ambiguous');
          }
          assertPlanHash(transaction.plan);
        } catch {
          throw new RpcError('ERR_PLAN_CHANGED', 'terminal transaction attribution is unavailable');
        }
        if (transaction.plan.accountId !== input.accountId) continue;
        terminalTransactionIds.push(txid);
        for (const planInput of transaction.plan.inputs) {
          if (planInput.ownership !== 'external') {
            targetOwnedOutpoints.add(`${planInput.txid}:${planInput.vout}`);
          }
          for (const inscription of planInput.classification.inscriptions) {
            targetInscriptionIds.add(inscription.inscriptionId);
          }
        }
        for (const flow of transaction.plan.protectedSatFlow) {
          targetInscriptionIds.add(flow.inscriptionId);
        }
        for (let outputIndex = 0; outputIndex < transaction.plan.outputs.length; outputIndex += 1) {
          if (transaction.plan.outputs[outputIndex]?.derivation?.accountId === input.accountId) {
            targetOwnedOutpoints.add(`${transaction.txid}:${outputIndex}`);
          }
        }
      }

      const evidenceKey = this.cacheKey(session.vaultId, 'activityEvidence', 'all');
      const evidenceRecord = await cache.get(evidenceKey);
      if (evidenceRecord) {
        let evidence: ActivityEvidenceRecord;
        try {
          evidence = openRecord(dek, evidenceRecord, activityEvidenceRecordSchema);
        } catch {
          throw new RpcError('ERR_PLAN_CHANGED', 'activity evidence attribution is unavailable');
        }
        const targetRanges = new Map<string, Array<{ start: bigint; end: bigint }>>();
        const addRange = (
          location: { txid: string; vout: number; offsetSats: string },
          lengthSats: string,
        ): void => {
          const key = `${location.txid}:${location.vout}`;
          const start = BigInt(location.offsetSats);
          const ranges = targetRanges.get(key) ?? [];
          ranges.push({ start, end: start + BigInt(lengthSats) });
          targetRanges.set(key, ranges);
        };
        let edgeCount = 0;
        for (const entry of targetHistory) {
          if (entry.ordinalFlow?.kind !== 'complete') continue;
          for (const edge of entry.ordinalFlow.edges) {
            if (edge.sourceRequested) addRange(edge.source, edge.lengthSats);
            if (edge.destinationRequested && edge.destination) {
              addRange(edge.destination, edge.lengthSats);
            }
          }
        }
        for (const entry of allHistory) {
          if (entry.ordinalFlow?.kind === 'complete') edgeCount += entry.ordinalFlow.edges.length;
        }
        const evidenceByInscription = new Map<string, ActivityEvidenceEntry[]>();
        for (const entry of evidence.entries) {
          const rows = evidenceByInscription.get(entry.inscriptionId) ?? [];
          rows.push(entry);
          evidenceByInscription.set(entry.inscriptionId, rows);
        }
        for (const [inscriptionId, seeds] of evidenceByInscription) {
          if (targetInscriptionIds.has(inscriptionId)) continue;
          const closure = propagateActivityEvidence(
            allHistory,
            seeds,
            seeds.length + edgeCount * 2 + 1,
          );
          const touchesTarget = closure.some((entry) => {
            const key = `${entry.outpoint.txid}:${entry.outpoint.vout}`;
            if (targetOwnedOutpoints.has(key)) return true;
            return (targetRanges.get(key) ?? []).some(
              (range) => entry.offsetSats >= range.start && entry.offsetSats < range.end,
            );
          });
          if (touchesTarget) targetInscriptionIds.add(inscriptionId);
        }
        const retainedEntries = evidence.entries.filter(
          (entry) => !targetInscriptionIds.has(entry.inscriptionId),
        );
        if (retainedEntries.length !== evidence.entries.length) {
          await this.saveActivityEvidenceLocked(dek, session.vaultId, {
            version: 1,
            entries: retainedEntries,
          });
        }
      }
      for (const txid of terminalTransactionIds) {
        await cache.delete(this.cacheKey(session.vaultId, 'transactions', txid));
      }

      const checkpoint = await this.loadCheckpointLocked(dek, session.vaultId);
      const lifecycle = removeDescriptorAccountLifecycle(
        meta, checkpoint, input.accountId, fallback.accountId,
      );
      // Purge account-bound local state before dropping the registry entry so
      // an interrupted removal remains retryable and cannot strand private
      // wallet metadata under an identity the UI can no longer address.
      for (const lane of ['payment', 'ordinals'] as const) {
        const key = unitKey({
          source: 'descriptor',
          accountId: input.accountId,
          account: removed.account,
          lane,
        });
        await cache.delete(this.cacheKey(session.vaultId, 'utxos', key));
        await cache.delete(this.cacheKey(session.vaultId, 'history', key));
      }
      await Promise.all([
        cache.delete(this.cacheKey(session.vaultId, 'gallery', input.accountId)),
        this.durableGalleryPreviews?.clearAccount(session.vaultId, input.accountId),
        cache.delete(this.labelsCacheKey(session.vaultId, input.accountId)),
        clearCachedGallery(this.deps.session),
        this.deps.local.remove([
          derivationKey(session.vaultId, this.deps.network, 'payment', removed.account, input.accountId),
          derivationKey(session.vaultId, this.deps.network, 'ordinals', removed.account, input.accountId),
        ]),
      ]);
      await cache.delete(this.cacheKey(
        session.vaultId, 'publicAccountDefinition', input.accountId,
      ));
      await cache.delete(this.cacheKey(
        session.vaultId, 'accountSigningBinding', input.accountId,
      ));
      await this.saveAccountsMetaLocked(dek, session.vaultId, {
        ...lifecycle.meta,
        partialHistoryUnits: lifecycle.meta.partialHistoryUnits.filter(
          (unit) => unit.accountId !== input.accountId,
        ),
      });
      if (lifecycle.checkpoint) {
        await this.saveCheckpointLocked(dek, session.vaultId, lifecycle.checkpoint);
      }
      const config = await loadConfig(this.deps.local);
      const key = activeAccountKey(session.vaultId, this.deps.network);
      await saveConfig(this.deps.local, {
        ...config,
        activeAccounts: { ...config.activeAccounts, [key]: fallback.account },
      });
      await this.touchSessionLocked(session);
      try {
        this.deps.notifyAccountChanged?.(fallback.accountId, fallback.account);
      } catch {
        // Persisted lifecycle state remains authoritative.
      }
      this.notifyWalletDataChanged('account');
      return { removed: true as const };
      }));
      this.resetScanState();
      return result;
    } finally {
      this.accountRemovalInProgress = false;
    }
  }

  /** Internal provider read. The returned session identity must be rebound at approval time. */
  async providerAccountView(): Promise<ProviderAccountView> {
    return this.runExclusive(async () => {
      const session = await this.liveSession();
      if (!session) throw new RpcError('ERR_LOCKED', 'wallet locked');
      const vaults = await loadVaults(this.deps.local);
      const vaultName = vaults[session.vaultId]?.name;
      if (!vaultName) throw new RpcError('ERR_PLAN_CHANGED', 'active wallet metadata missing');
      return this.withSessionDek(
        { expectedVaultId: session.vaultId, expectedSessionId: session.sessionId },
        async (dek) => {
          const active = await this.assertProviderAccountLocked(dek, session.vaultId);
          const definition = await this.loadPublicAccountDefinitionLocked(
            dek, session.vaultId, active.accountId,
          );
          const payment = derivePublicAccountAddress(definition, 'payment', 0, 0);
          const ordinals = derivePublicAccountAddress(definition, 'ordinals', 0, 0);
            return {
              vaultId: session.vaultId,
              vaultName,
              sessionId: session.sessionId,
              network: this.deps.network,
              accountId: active.accountId,
              account: active.account,
              payment: {
                address: payment.address,
                publicKeyHex: payment.publicKeyHex,
                path: payment.path,
              },
              ordinals: {
                address: ordinals.address,
                publicKeyHex: ordinals.publicKeyHex,
                path: ordinals.path,
              },
            };
        },
      );
    });
  }

  async providerBalanceView(): Promise<ProviderBalanceView> {
    const gateway = await this.gatewayStatus({});
    return this.runExclusive(async () => {
      const session = await this.liveSession();
      if (!session) throw new RpcError('ERR_LOCKED', 'wallet locked');
      return this.withSessionDek(
        { expectedVaultId: session.vaultId, expectedSessionId: session.sessionId },
        async (dek) => {
          const active = await this.assertProviderAccountLocked(dek, session.vaultId);
          const utxos = await this.loadAllUtxosLocked(dek, session.vaultId);
          let confirmed = 0n;
          let unconfirmed = 0n;
          for (const utxo of utxos) {
            if (
              utxo.accountId !== active.accountId ||
              utxo.lane !== 'payment' ||
              utxo.facts?.primaryClass !== 'cardinal_clean' ||
              utxo.facts.unsupportedAssetDetected ||
              utxo.flags.userFrozen ||
              utxo.flags.dustQuarantined
            ) continue;
            if (utxo.height === null) unconfirmed += utxo.valueSats;
            else confirmed += utxo.valueSats;
          }
          return {
            confirmed: confirmed.toString(),
            unconfirmed: unconfirmed.toString(),
            total: (confirmed + unconfirmed).toString(),
            fresh: gateway.state === 'connected' || gateway.state === 'degraded',
          };
        },
      );
    });
  }

  async providerInscriptionsView(): Promise<ProviderInscriptionView[]> {
    return this.runExclusive(async () => {
      const session = await this.liveSession();
      if (!session) throw new RpcError('ERR_LOCKED', 'wallet locked');
      return this.withSessionDek(
        { expectedVaultId: session.vaultId, expectedSessionId: session.sessionId },
        async (dek) => {
          const active = await this.assertProviderAccountLocked(dek, session.vaultId);
          const definition = await this.loadPublicAccountDefinitionLocked(
            dek, session.vaultId, active.accountId,
          );
          const utxos = await this.loadAllUtxosLocked(dek, session.vaultId);
          const rows: ProviderInscriptionView[] = [];
          for (const utxo of utxos) {
            if (utxo.accountId !== active.accountId || !utxo.facts) continue;
            const address = derivePublicAccountAddress(
              definition, utxo.lane, utxo.chain, utxo.addressIndex,
            ).address;
            for (const inscription of utxo.facts.inscriptions) {
              const offset = inscription.satpoint.split(':')[2] ?? '0';
              rows.push({
                id: inscription.inscriptionId,
                ...(inscription.number === undefined ? {} : { number: inscription.number }),
                satpoint: inscription.satpoint,
                output: `${utxo.outpoint.txid}:${utxo.outpoint.vout}`,
                address,
                postage: utxo.valueSats.toString(),
                genesisTxid: inscription.inscriptionId.split('i')[0] ?? inscription.inscriptionId,
                offset,
              });
            }
          }
          return rows.sort((a, b) => a.id.localeCompare(b.id));
        },
      );
    });
  }

  async providerSignMessage(
    message: string,
    addressKind: 'payment' | 'ordinals',
    guard?: ProviderOperationGuard,
  ): Promise<{ address: string; signature: string } & Pick<ProviderAccountView, 'vaultId' | 'sessionId' | 'network' | 'account'>> {
    return this.runExclusive(async () => {
      const session = await this.liveSession();
      if (!session) throw new RpcError('ERR_LOCKED', 'wallet locked');
      const authorizationDek = base64ToBytes(session.dekB64);
      let activeAccount: AccountsMeta['registeredPublicAccounts'][number];
      try {
        activeAccount = await this.assertProviderAccountLocked(
          authorizationDek, session.vaultId,
        );
      } finally {
        zeroize(authorizationDek);
      }
      const account = activeAccount.account;
      return this.withActiveDek(
        { expectedVaultId: session.vaultId, expectedSessionId: session.sessionId },
        (payload) => {
          const seed = hexToBytes(payload.seedHex);
          const accountNode = deriveAccountNode(seed, addressKind, this.deps.network, account);
          const chain = accountNode.deriveChild(0);
          const key = chain.deriveChild(0);
          try {
            if (!key.privateKey) throw new RpcError('ERR_UNSAFE_TRANSACTION', 'signing key unavailable');
            const address = deriveAddress(accountNode, addressKind, this.deps.network, 0, 0).address;
            guard?.();
            const signature = signBip322Simple({
              message,
              privateKey: key.privateKey,
              addressKind,
              random: (length) => this.deps.vaultDeps.random(length),
            });
            if (!verifyBip322Simple(message, address, this.deps.network, signature)) {
              throw new RpcError('ERR_UNSAFE_TRANSACTION', 'BIP322 post-sign verification failed');
            }
            return {
              vaultId: session.vaultId,
              sessionId: session.sessionId,
              network: this.deps.network,
              account,
              address,
              signature,
            };
          } finally {
            key.privateKey?.fill(0);
            key.wipePrivateData();
            chain.wipePrivateData();
            accountNode.wipePrivateData();
            zeroize(seed);
          }
        },
      );
    });
  }

  async providerPrepareMessageBatch(input: {
    requests: Array<{ address: string; message: string; protocol?: 'BIP322' }>;
    provider: ProviderMessageBatchPlanV1['provider'];
    approvalGeneration: number;
    guard?: ProviderOperationGuard;
  }): Promise<ProviderMessageBatchPlanV1> {
    input.guard?.();
    const account = await this.providerAccountView();
    input.guard?.();
    try {
      return createProviderMessageBatchPlan({
        requests: input.requests,
        activeAddresses: {
          payment: account.payment.address,
          ordinals: account.ordinals.address,
        },
        planId: this.deps.newSessionId(),
        now: this.deps.vaultDeps.now(),
        network: account.network,
        vaultId: account.vaultId,
        sessionId: account.sessionId,
        accountId: account.accountId,
        account: account.account,
        provider: input.provider,
        approvalGeneration: input.approvalGeneration,
      });
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError('ERR_UNSAFE_TRANSACTION', 'provider message batch rejected');
    }
  }

  async providerRevalidatePreparedMessageBatch(plan: ProviderMessageBatchPlanV1): Promise<void> {
    try {
      assertProviderMessageBatchPlan(plan);
    } catch {
      throw new RpcError('ERR_PLAN_CHANGED', 'provider message batch changed');
    }
    if (this.deps.vaultDeps.now() >= plan.expiresAt) throw new RpcError('ERR_PLAN_EXPIRED');
    await this.runExclusive(async () => {
      const session = await this.liveSession();
      if (!session || session.vaultId !== plan.vaultId || session.sessionId !== plan.sessionId ||
          plan.network !== this.deps.network) {
        throw new RpcError('ERR_LOCKED', 'wallet session changed');
      }
      await this.withSessionDek(
        { expectedVaultId: session.vaultId, expectedSessionId: session.sessionId },
        async (dek) => {
          const active = await this.assertProviderAccountLocked(dek, session.vaultId);
          if (active.accountId !== plan.accountId || active.account !== plan.account) {
            throw new RpcError('ERR_PLAN_CHANGED', 'provider message batch account changed');
          }
        },
      );
    });
  }

  async providerSignPreparedMessageBatch(
    plan: ProviderMessageBatchPlanV1,
    guard?: ProviderOperationGuard,
  ): Promise<ProviderSignedMessage[]> {
    try {
      assertProviderMessageBatchPlan(plan);
    } catch {
      throw new RpcError('ERR_PLAN_CHANGED', 'provider message batch changed');
    }
    if (this.deps.vaultDeps.now() >= plan.expiresAt) throw new RpcError('ERR_PLAN_EXPIRED');
    return this.runExclusive(async () => {
      const session = await this.liveSession();
      if (!session || session.vaultId !== plan.vaultId || session.sessionId !== plan.sessionId ||
          plan.network !== this.deps.network) {
        throw new RpcError('ERR_LOCKED', 'wallet session changed');
      }
      return this.withSessionDek(
        { expectedVaultId: session.vaultId, expectedSessionId: session.sessionId },
        async (dek) => {
          const active = await this.assertProviderAccountLocked(dek, session.vaultId);
          if (active.accountId !== plan.accountId || active.account !== plan.account) {
            throw new RpcError('ERR_PLAN_CHANGED', 'provider message batch account changed');
          }
          const map = await loadVaults(this.deps.local);
          const record = map[session.vaultId];
          if (!record) throw new RpcError('ERR_VAULT_NOT_FOUND');
          const seed = hexToBytes(openVaultPayload(record, dek).seedHex);
          const results: ProviderSignedMessage[] = [];
          try {
            for (const item of plan.items) {
              guard?.();
              results.push(signProviderMessageBatchItem({
                plan,
                itemIndex: item.index,
                seed,
                now: this.deps.vaultDeps.now(),
                random: (length) => this.deps.vaultDeps.random(length),
              }));
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
            guard?.();
            assertProviderMessageBatchResults(plan, results);
            return results;
          } catch (error) {
            if (error instanceof RpcError) throw error;
            throw new RpcError('ERR_UNSAFE_TRANSACTION', 'provider message batch signing failed');
          } finally {
            zeroize(seed);
          }
        },
      );
    });
  }

  async providerPermissionGrants(): Promise<PermissionGrantEvent[]> {
    return this.runExclusive(async () => {
      const session = await this.liveSession();
      if (!session) return [];
      const dek = base64ToBytes(session.dekB64);
      try {
        await this.assertProviderAccountLocked(dek, session.vaultId);
        const journal = await loadPermissionJournal(
          this.deps.local,
          permissionStorageKey(session.vaultId, this.deps.network),
          dek,
          session.vaultId,
        );
        return journal.status === 'corrupt' ? [] : [...journal.projection.grants];
      } finally {
        zeroize(dek);
      }
    });
  }

  async connectedSites(input: ActiveSessionRequest): Promise<{ sites: Array<{
    resourceId: string;
    origin: string;
    network: Network;
    accountId: string;
    account: number;
    categories: PermissionDataCategory[];
  }> }> {
    return this.runExclusive(async () => {
      const session = await this.requireSession(input);
      const dek = base64ToBytes(session.dekB64);
      try {
        const accountsMeta = await this.loadAccountsMetaLocked(dek, session.vaultId);
        const publicIdByIndex = new Map(
          accountsMeta.registeredPublicAccounts
            .filter((account) => account.source === 'standard')
            .map((account) => [account.account, account.accountId] as const),
        );
        const journal = await loadPermissionJournal(
          this.deps.local,
          permissionStorageKey(session.vaultId, this.deps.network),
          dek,
          session.vaultId,
        );
        if (journal.status === 'corrupt') return { sites: [] };
        const grouped = new Map<string, {
          resourceId: string; origin: string; network: Network; account: number;
          categories: Set<PermissionDataCategory>;
        }>();
        for (const grant of journal.projection.grants) {
          const key = `${grant.scope.origin}|${grant.scope.network}|${grant.scope.account}`;
          const existing = grouped.get(key) ?? {
            resourceId: grant.resourceId,
            origin: grant.scope.origin,
            network: grant.scope.network,
            account: grant.scope.account,
            categories: new Set<PermissionDataCategory>(),
          };
          for (const category of grant.scope.categories) existing.categories.add(category);
          grouped.set(key, existing);
        }
        return { sites: [...grouped.values()].flatMap((site) => {
          const accountId = publicIdByIndex.get(site.account);
          return accountId === undefined ? [] : [{
            ...site,
            accountId,
            categories: [...site.categories].sort(),
          }];
        }) };
      } finally {
        zeroize(dek);
      }
    });
  }

  async revokeConnectedSite(input: ConnectedSiteRevokeRequest): Promise<{ revoked: boolean }> {
    return this.runExclusive(async () => {
      const session = await this.requireSession(input);
      const dek = base64ToBytes(session.dekB64);
      try {
        const storageKey = permissionStorageKey(session.vaultId, this.deps.network);
        const journal = await loadPermissionJournal(this.deps.local, storageKey, dek, session.vaultId);
        if (journal.status === 'corrupt') return { revoked: false };
        const grant = journal.projection.grants.find((item) => item.resourceId === input.resourceId);
        if (!grant) return { revoked: false };
        await appendPermissionEvent({
          area: this.deps.local,
          storageKey,
          dek,
          vaultId: session.vaultId,
          expectedRevision: journal.revision,
          event: {
            version: 1, kind: 'revoke_scope', eventId: createPermissionOpaqueId(),
            occurredAtMs: this.deps.vaultDeps.now(), origin: grant.scope.origin,
            network: grant.scope.network, vaultId: grant.scope.vaultId,
            account: grant.scope.account, reason: 'user_revoked',
          },
        });
        this.deps.notifyPermissionsRevoked?.(grant.scope.origin);
        this.notifyWalletDataChanged('permissions');
        return { revoked: true };
      } finally {
        zeroize(dek);
      }
    });
  }

  async providerHasPermission(origin: string, categories: PermissionDataCategory[]): Promise<boolean> {
    return this.runExclusive(async () => {
      const session = await this.liveSession();
      if (!session) return false;
      const dek = base64ToBytes(session.dekB64);
      try {
        const active = await this.assertProviderAccountLocked(dek, session.vaultId);
        const account = active.account;
        const journal = await loadPermissionJournal(
          this.deps.local,
          permissionStorageKey(session.vaultId, this.deps.network),
          dek,
          session.vaultId,
        );
        return journal.status !== 'corrupt' && hasExactPermission(journal.projection, {
          origin,
          network: this.deps.network,
          vaultId: session.vaultId,
          account,
          categories: [...new Set(categories)].sort(),
        });
      } finally {
        zeroize(dek);
      }
    });
  }

  async providerHasExactPermission(origin: string, categories: PermissionDataCategory[]): Promise<boolean> {
    return this.runExclusive(async () => {
      const session = await this.liveSession();
      if (!session) return false;
      const dek = base64ToBytes(session.dekB64);
      try {
        const active = await this.assertProviderAccountLocked(dek, session.vaultId);
        const journal = await loadPermissionJournal(
          this.deps.local,
          permissionStorageKey(session.vaultId, this.deps.network),
          dek,
          session.vaultId,
        );
        return journal.status !== 'corrupt' && hasExactPermissionSet(journal.projection, {
          origin,
          network: this.deps.network,
          vaultId: session.vaultId,
          account: active.account,
          categories: [...new Set(categories)].sort(),
        });
      } finally {
        zeroize(dek);
      }
    });
  }

  async providerGrantPermission(
    origin: string,
    categories: PermissionDataCategory[],
  ): Promise<PermissionGrantEvent> {
    return this.runExclusive(async () => {
      const session = await this.liveSession();
      if (!session) throw new RpcError('ERR_LOCKED', 'wallet locked');
      const dek = base64ToBytes(session.dekB64);
      try {
        const active = await this.assertProviderAccountLocked(dek, session.vaultId);
        const account = active.account;
        const storageKey = permissionStorageKey(session.vaultId, this.deps.network);
        const current = await loadPermissionJournal(this.deps.local, storageKey, dek, session.vaultId);
        if (current.status === 'corrupt') throw new RpcError('ERR_INTERNAL', 'permission journal corrupt');
        const scope = normalizePermissionScope({
          origin,
          network: this.deps.network,
          vaultId: session.vaultId,
          account,
          categories: [...new Set(categories)].sort(),
        });
        if (hasExactPermission(current.projection, scope)) {
          const existing = current.projection.grants.find((grant) =>
            grant.scope.origin === scope.origin &&
            grant.scope.network === scope.network &&
            grant.scope.vaultId === scope.vaultId &&
            grant.scope.account === scope.account);
          if (existing) return existing;
        }
        const event: PermissionGrantEvent = {
          version: 1,
          kind: 'grant',
          eventId: createPermissionOpaqueId(),
          resourceId: createPermissionOpaqueId(),
          occurredAtMs: this.deps.vaultDeps.now(),
          scope,
        };
        await appendPermissionEvent({
          area: this.deps.local,
          storageKey,
          dek,
          vaultId: session.vaultId,
          expectedRevision: current.revision,
          event,
        });
        this.notifyWalletDataChanged('permissions');
        return event;
      } finally {
        zeroize(dek);
      }
    });
  }

  async providerRevokeOrigin(origin: string): Promise<number> {
    return this.runExclusive(async () => {
      const session = await this.liveSession();
      if (!session) throw new RpcError('ERR_LOCKED', 'wallet locked');
      const dek = base64ToBytes(session.dekB64);
      try {
        const storageKey = permissionStorageKey(session.vaultId, this.deps.network);
        const journal = await loadPermissionJournal(this.deps.local, storageKey, dek, session.vaultId);
        if (journal.status === 'corrupt') throw new RpcError('ERR_INTERNAL', 'permission journal corrupt');
        const revoked = journal.projection.grants.filter((grant) => grant.scope.origin === origin).length;
        if (revoked === 0) return 0;
        await appendPermissionEvent({
          area: this.deps.local, storageKey, dek, vaultId: session.vaultId,
          expectedRevision: journal.revision,
          event: {
            version: 1, kind: 'revoke_scope', eventId: createPermissionOpaqueId(),
            occurredAtMs: this.deps.vaultDeps.now(),
            origin: normalizePermissionScope({
              origin, network: this.deps.network, vaultId: session.vaultId,
              account: 0, categories: ['network'],
            }).origin,
            network: this.deps.network, vaultId: session.vaultId,
            account: null, reason: 'disconnect',
          },
        });
        return revoked;
      } finally {
        zeroize(dek);
      }
    });
  }

  async providerPrepareTransfer(input: {
    recipients: Array<{ address: string; amount: number }>;
    binding: ProviderAuthorityBinding & { providerMethod: 'sendTransfer' };
    feeRateSatPerVb?: number;
  }): Promise<ProviderPsbtPlanV3> {
    const [gatewayView, fee, accountView] = await Promise.all([
      this.gatewayStatus({ forceRefresh: true }),
      this.resolveFee(input.feeRateSatPerVb === undefined
        ? { type: 'automatic', tier: 'recommended' }
        : { type: 'custom', rateSatPerVb: input.feeRateSatPerVb.toString() }),
      this.providerAccountView(),
    ]);
    const prepared = await this.runExclusive(() => this.withSessionDek(
      { expectedVaultId: accountView.vaultId, expectedSessionId: accountView.sessionId },
      async (dek, session) => {
        await this.assertSpendingFreshLocked(dek, session.vaultId, gatewayView, 'native_send');
        const active = await this.assertProviderAccountLocked(dek, session.vaultId);
        if (active.accountId !== accountView.accountId || active.account !== accountView.account) {
          throw new RpcError('ERR_PLAN_CHANGED', 'active account changed');
        }
        const account = active.account;
        const recipientOutputs = input.recipients.map((recipient) => {
          const scriptPubKey = payableRecipient(recipient.address, this.deps.network).scriptPubKey;
          const valueSats = BigInt(recipient.amount);
          if (valueSats < scriptDustSats(scriptPubKey)) throw new RpcError('ERR_OUTPUT_DUST', 'recipient output is dust');
          return { address: recipient.address, scriptPubKey, valueSats, role: 'recipient' as const };
        });
        const target = recipientOutputs.reduce((sum, output) => sum + output.valueSats, 0n);
        const map = await loadVaults(this.deps.local);
        const record = map[session.vaultId];
        if (!record) throw new RpcError('ERR_VAULT_NOT_FOUND');
        const seed = hexToBytes(openVaultPayload(record, dek).seedHex);
        try {
          const change = await this.reserveOutputLocked(session.vaultId, seed, 'payment', account, 'payment_change');
          const utxos = await this.loadAllUtxosLocked(dek, session.vaultId);
          const eligibility = await this.eligibilityContextLocked(dek, session.vaultId, fee.rate);
          let selection;
          try {
            selection = selectCoins({
              utxos,
              eligibility,
              accountId: accountView.accountId,
              account,
              feeRate: fee.rate,
              targetSats: target,
              recipientScripts: recipientOutputs.map((output) => output.scriptPubKey),
              changeScript: change.scriptPubKey,
              sendMax: false,
            });
          } catch {
            throw new RpcError('ERR_INSUFFICIENT_FUNDS', 'insufficient eligible funds');
          }
          const inputs = selection.inputs.map((utxo) => inputFromUtxo(
            utxo, this.deriveForUtxo(seed, utxo), sequenceForInput('native_send'),
          ));
          const outputs: PlanOutput[] = [...recipientOutputs];
          if (selection.changeSats > 0n) outputs.push({ ...change, valueSats: selection.changeSats });
          return {
            psbtBase64: bytesToBase64(hexToBytes(buildPsbtHex(inputs, outputs))),
            walletOutputs: outputs
              .filter((output) => output.derivation !== undefined)
              .map((output) => ({ scriptPubKey: output.scriptPubKey, output })),
          };
        } finally {
          zeroize(seed);
        }
      },
    ));
    return this.providerPreparePsbt({
      ...prepared,
      binding: input.binding,
      broadcast: true,
      kind: 'provider_transfer',
      requiresAdvanced: false,
    });
  }

  /**
   * Bring the selected account to the gateway's active revision before a
   * provider transaction is planned. This is deliberately a pre-plan action:
   * it may join an existing scan, but it never retries a transaction request
   * and never weakens the approval/signing guards.
   */
  async providerEnsureSpendReady(input: {
    expectedVaultId: string;
    expectedSessionId: string;
    expectedAccountId: string;
    expectedAccount: number;
  }, guard?: ProviderOperationGuard): Promise<void> {
    const assertFresh = async (): Promise<void> => {
      guard?.();
      const [gatewayView, accountView] = await Promise.all([
        this.gatewayStatus({ forceRefresh: true }),
        this.providerAccountView(),
      ]);
      guard?.();
      if (accountView.vaultId !== input.expectedVaultId ||
          accountView.sessionId !== input.expectedSessionId ||
          accountView.accountId !== input.expectedAccountId ||
          accountView.account !== input.expectedAccount) {
        throw new RpcError('ERR_PLAN_CHANGED', 'provider account changed during refresh');
      }
      await this.runExclusive(() => this.withSessionDek(
        {
          expectedVaultId: input.expectedVaultId,
          expectedSessionId: input.expectedSessionId,
        },
        async (dek, session) => {
          guard?.();
          const active = await this.assertProviderAccountLocked(dek, session.vaultId);
          if (active.accountId !== input.expectedAccountId || active.account !== input.expectedAccount) {
            throw new RpcError('ERR_PLAN_CHANGED', 'provider account changed during refresh');
          }
          await this.assertSpendingFreshLocked(dek, session.vaultId, gatewayView, 'native_send');
          guard?.();
        },
      ));
      guard?.();
    };

    try {
      await assertFresh();
      return;
    } catch (error) {
      if (!(error instanceof RpcError) || error.code !== 'ERR_DATA_STALE') throw error;
    }

    guard?.();
    try {
      await this.startScan({
        mode: 'refresh',
        expectedVaultId: input.expectedVaultId,
        expectedSessionId: input.expectedSessionId,
      });
      guard?.();
      const run = this.scanRun;
      if (run) {
        while (this.scanRun === run) {
          guard?.();
          await Promise.race([
            run,
            new Promise<void>((resolve) => setTimeout(resolve, 100)),
          ]);
        }
        await run;
      }
      guard?.();
    } catch (error) {
      guard?.();
      if (error instanceof RpcError &&
          (error.code === 'ERR_PLAN_CHANGED' || error.code === 'ERR_LOCKED')) throw error;
      throw new RpcError('ERR_DATA_STALE', 'wallet refresh did not complete');
    }

    await assertFresh();
  }

  async providerPrepareOrdinalTransfer(input: {
    inscriptionId: string;
    address: string;
    binding: ProviderAuthorityBinding & { providerMethod: 'ord_sendInscriptions' };
    feeRateSatPerVb?: number;
  }): Promise<ProviderPsbtPlanV3> {
    const [gatewayView, fee, accountView] = await Promise.all([
      this.gatewayStatus({ forceRefresh: true }),
      this.resolveFee(input.feeRateSatPerVb === undefined
        ? { type: 'automatic', tier: 'recommended' }
        : { type: 'custom', rateSatPerVb: input.feeRateSatPerVb.toString() }),
      this.providerAccountView(),
    ]);
    const prepared = await this.runExclusive(() => this.withSessionDek(
      { expectedVaultId: accountView.vaultId, expectedSessionId: accountView.sessionId },
      async (dek, session) => {
        await this.assertSpendingFreshLocked(dek, session.vaultId, gatewayView, 'rescue_sweep');
        const active = await this.assertProviderAccountLocked(dek, session.vaultId);
        if (active.accountId !== accountView.accountId || active.account !== accountView.account) {
          throw new RpcError('ERR_PLAN_CHANGED', 'active account changed');
        }
        const utxos = await this.loadAllUtxosLocked(dek, session.vaultId);
        const required = utxos.find((utxo) =>
          utxo.accountId === accountView.accountId &&
          utxo.facts?.inscriptions.some((item) => item.inscriptionId === input.inscriptionId));
        if (!required || required.height === null ||
            (required.facts?.primaryClass !== 'inscribed' && required.facts?.primaryClass !== 'mixed') ||
            required.facts.inscriptions.length === 0 || required.facts.unsupportedAssetDetected ||
            required.facts.confidence !== 'authoritative' ||
            required.facts.satRanges?.some((range) => range.rarity !== undefined && range.rarity !== 'common')) {
          throw new RpcError('ERR_UNSAFE_TRANSACTION', 'inscription cannot be transferred safely');
        }
        let groups;
        try {
          groups = groupOrdinalInscriptions({
            txid: required.outpoint.txid,
            vout: required.outpoint.vout,
            valueSats: required.valueSats,
            targetInscriptionId: input.inscriptionId,
            inscriptions: required.facts.inscriptions,
          });
        } catch (error) {
          throw new RpcError('ERR_UNSAFE_TRANSACTION', (error as Error).message);
        }
        const recipientScript = payableRecipient(input.address, this.deps.network).scriptPubKey;
        const map = await loadVaults(this.deps.local);
        const record = map[session.vaultId];
        if (!record) throw new RpcError('ERR_VAULT_NOT_FOUND');
        const seed = hexToBytes(openVaultPayload(record, dek).seedHex);
        try {
          const paymentChange = await this.reserveOutputLocked(
            session.vaultId, seed, 'payment', required.account, 'payment_change',
          );
          const ordinalChanges = new Map<string, PlanOutput>();
          for (const group of groups) {
            if (group.target) continue;
            ordinalChanges.set(group.key, {
              ...await this.reserveOutputLocked(
                session.vaultId, seed, 'ordinals', required.account, 'ordinal_change',
              ),
              valueSats: 0n,
            });
          }
          const targetPostage = automaticOrdinalPostage(
            required.valueSats,
            DEFAULT_POSTAGE_SATS,
            scriptDustSats(recipientScript),
          );
          const targetDust = scriptDustSats(recipientScript);
          let partitions;
          try {
            partitions = partitionOrdinalSatFlow(required.valueSats, groups.map((group) => {
              const change = ordinalChanges.get(group.key);
              const minimumOutputSats = group.target
                ? targetDust
                : economicChangeThreshold(change!.scriptPubKey, fee.rate);
              return {
                inscriptionId: group.key,
                inputOffset: group.offset,
                minimumOutputSats,
                ...(group.target ? { preferredOutputSats: targetPostage } : {}),
                target: group.target,
              };
            }));
          } catch {
            throw new RpcError('ERR_UNSAFE_TRANSACTION', 'co-located inscriptions cannot be partitioned safely');
          }
          let cleanProtectedTail = 0n;
          const targetPartition = partitions.find((partition) => partition.target)!;
          if (partitions.at(-1) === targetPartition) {
            const minimumContainingTarget = targetPartition.outputOffset + 1n > targetPostage
              ? targetPartition.outputOffset + 1n : targetPostage;
            const removableTail = targetPartition.valueSats - minimumContainingTarget;
            if (removableTail > economicChangeThreshold(paymentChange.scriptPubKey, fee.rate)) {
              targetPartition.valueSats = minimumContainingTarget;
              cleanProtectedTail = removableTail;
            }
          }
          const outputs: PlanOutput[] = partitions.map((partition) => partition.target
            ? {
                address: input.address,
                scriptPubKey: recipientScript,
                valueSats: partition.valueSats,
                role: 'postage' as const,
              }
            : { ...ordinalChanges.get(partition.inscriptionId)!, valueSats: partition.valueSats });
          const protectedOutputTotal = partitions.reduce(
            (sum, partition) => sum + partition.valueSats,
            0n,
          );
          const requiredPostageTopUp = protectedOutputTotal > required.valueSats
            ? protectedOutputTotal - required.valueSats
            : 0n;
          const eligibility = await this.eligibilityContextLocked(dek, session.vaultId, fee.rate);
          if (eligibility.lockedOutpoints.has(outpointKey(required.outpoint))) {
            throw new RpcError('ERR_UNSAFE_TRANSACTION', 'inscription input is locked');
          }
          const protectedInput = inputFromUtxo(
            required, this.deriveForUtxo(seed, required), sequenceForInput('rescue'),
          );
          let feeInputs: WalletUtxo[];
          try {
            feeInputs = selectCoins({
              utxos,
              eligibility,
              accountId: accountView.accountId,
              account: required.account,
              feeRate: fee.rate,
              targetSats:
                requiredPostageTopUp +
                feeForVsize(inputVbytes(required.scriptPubKey), fee.rate),
              recipientScripts: outputs.map((output) => output.scriptPubKey),
              changeScript: paymentChange.scriptPubKey,
              sendMax: false,
            }).inputs;
          } catch {
            throw new RpcError('ERR_INSUFFICIENT_FUNDS', 'clean payment fee inputs unavailable');
          }
          const inputs = [protectedInput, ...feeInputs.map((utxo) => inputFromUtxo(
            utxo, this.deriveForUtxo(seed, utxo), sequenceForInput('rescue'),
          ))];
          let vsize = estimateVsize(
            inputs.map((item) => item.scriptPubKey),
            [...outputs.map((output) => output.scriptPubKey), paymentChange.scriptPubKey],
          );
          const feeSats = feeForVsize(vsize, fee.rate);
          const paymentTotal = feeInputs.reduce((sum, item) => sum + item.valueSats, 0n);
          const paymentRemainder = paymentTotal - feeSats - requiredPostageTopUp;
          if (paymentRemainder < 0n) throw new RpcError('ERR_INSUFFICIENT_FUNDS');
          if (cleanProtectedTail > 0n) {
            outputs.push({ ...paymentChange, valueSats: cleanProtectedTail + paymentRemainder });
          } else if (paymentRemainder > economicChangeThreshold(paymentChange.scriptPubKey, fee.rate)) {
            outputs.push({ ...paymentChange, valueSats: paymentRemainder });
          } else {
            vsize = estimateVsize(
              inputs.map((item) => item.scriptPubKey), outputs.map((output) => output.scriptPubKey),
            );
            const minimumFee = feeForVsize(vsize, fee.rate);
            if (paymentTotal < minimumFee) throw new RpcError('ERR_INSUFFICIENT_FUNDS');
          }
          return {
            psbtBase64: bytesToBase64(hexToBytes(buildPsbtHex(inputs, outputs))),
            outputs,
            protectedSatFlow: partitions.flatMap((partition, outputIndex) => {
              const group = groups.find((candidate) => candidate.key === partition.inscriptionId);
              if (!group) throw new RpcError('ERR_UNSAFE_TRANSACTION', 'inscription group changed');
              return group.items.map((item) => ({
                inputIndex: 0,
                inputOffset: partition.inputOffset,
                outputIndex,
                outputOffset: partition.outputOffset,
                inscriptionId: item.inscriptionId,
              }));
            }),
          };
        } finally {
          zeroize(seed);
        }
      },
    ));
    return this.providerPreparePsbt({
      psbtBase64: prepared.psbtBase64,
      binding: input.binding,
      broadcast: true,
      kind: 'provider_ordinal_transfer',
      walletOutputs: prepared.outputs.map((output) => ({ scriptPubKey: output.scriptPubKey, output })),
      protectedSatFlow: prepared.protectedSatFlow,
      requiresAdvanced: false,
    });
  }

  private async assertProviderClassificationBatch(
    response: OutpointsClassifyResponse,
    requested: Array<{ txid: string; vout: number }>,
    expectedPlan?: ProviderPsbtPlanV3,
    allowUnknown = false,
  ): Promise<Map<string, UtxoClassification>> {
    const gateway = this.deps.gateway;
    if (!gateway) throw new RpcError('ERR_DATA_STALE', 'gateway unavailable');
    const cached = await loadCachedStatus(this.deps.session, gateway.endpoint, gateway.protocolVersions);
    if (!cached || response.instanceId !== cached.status.instanceId ||
        response.classificationRevision !== cached.status.activeRevision ||
        !tipsEqual(response.coreTip, cached.status.coreTip) ||
        !tipsEqual(response.indexTip, cached.status.indexTip)) {
      throw new RpcError('ERR_DATA_STALE', 'classification source is not current');
    }
    if (expectedPlan && (expectedPlan.source.backend !== gateway.endpoint ||
        response.instanceId !== expectedPlan.source.instanceId ||
        response.classificationRevision !== expectedPlan.source.classificationRevision ||
        !tipsEqual(response.coreTip, expectedPlan.source.coreTip) ||
        !tipsEqual(response.indexTip, expectedPlan.source.indexTip))) {
      throw new RpcError('ERR_PLAN_CHANGED', 'provider classification source changed');
    }
    const expected = new Set(requested.map((item) => `${item.txid}:${item.vout}`));
    if (expected.size !== requested.length || (!allowUnknown && response.unknownOutpoints.length > 0) ||
        response.classifications.length + response.unknownOutpoints.length !== expected.size) {
      throw new RpcError('ERR_DATA_STALE', 'classification response incomplete');
    }
    const byOutpoint = new Map<string, UtxoClassification>();
    for (const classification of response.classifications) {
      const key = `${classification.txid}:${classification.vout}`;
      if (!expected.has(key) || byOutpoint.has(key) || classification.confidence !== 'authoritative' ||
          classification.classificationRevision !== response.classificationRevision ||
          !tipsEqual(classification.classifiedTip, response.coreTip)) {
        throw new RpcError('ERR_DATA_STALE', 'classification response is not authoritative');
      }
      byOutpoint.set(key, classification);
    }
    const unknown = new Set<string>();
    for (const candidate of response.unknownOutpoints) {
      const key = `${candidate.txid}:${candidate.vout}`;
      if (!expected.has(key) || byOutpoint.has(key) || unknown.has(key)) {
        throw new RpcError('ERR_DATA_STALE', 'classification response is not authoritative');
      }
      unknown.add(key);
    }
    if (expectedPlan && expectedPlan.inputs.some((planInput) => {
      const fresh = byOutpoint.get(`${planInput.txid}:${planInput.vout}`);
      return !fresh || !providerFactsEqual(fresh, planInput);
    })) {
      throw new RpcError('ERR_PLAN_CHANGED', 'provider input classification changed');
    }
    return byOutpoint;
  }

  private async refreshProviderPlanFacts(plan: ProviderPsbtPlanV3): Promise<GatewayStatusView> {
    const gateway = this.deps.gateway;
    if (!gateway || gateway.endpoint !== plan.source.backend) {
      throw new RpcError('ERR_DATA_STALE', 'approved provider backend unavailable');
    }
    const requested = plan.inputs.map((item) => ({ txid: item.txid, vout: item.vout }));
    const [view, classified] = await Promise.all([
      this.gatewayStatus({ forceRefresh: true }),
      gateway.classifyOutpoints({ network: plan.network, outpoints: requested }),
    ]);
    if (!classified.ok) throw new RpcError('ERR_DATA_STALE', 'classification refresh failed');
    await this.assertProviderClassificationBatch(classified.value, requested, plan);
    return view;
  }

  private async refreshProviderGroupFacts(plan: ProviderPsbtGroupPlanV1): Promise<GatewayStatusView> {
    const gateway = this.deps.gateway;
    if (!gateway || gateway.endpoint !== plan.items[0]?.plan.source.backend) {
      throw new RpcError('ERR_DATA_STALE', 'approved provider backend unavailable');
    }
    const internalTxids = new Set(plan.topology.nodes.map((node) => node.unsignedTxid));
    const requested = plan.topology.nodes.flatMap((node) => node.inputs)
      .filter((input) => !internalTxids.has(input.txid))
      .map(({ txid, vout }) => ({ txid, vout }))
      .filter((item, index, all) => all.findIndex((candidate) =>
        candidate.txid === item.txid && candidate.vout === item.vout) === index)
      .sort((left, right) => left.txid.localeCompare(right.txid) || left.vout - right.vout);
    if (requested.length === 0) throw new RpcError('ERR_PLAN_CHANGED', 'provider group has no external roots');
    const prospective = new Set(plan.preparation?.prospectiveOutpoints ?? []);
    const [view, classified] = await Promise.all([
      this.gatewayStatus({ forceRefresh: true }),
      classifyProviderOutpointsChunked({
        network: plan.network,
        requested,
        classify: (request) => gateway.classifyOutpoints(request),
        allowUnknown: prospective.size > 0,
      }),
    ]);
    const fresh = await this.assertProviderClassificationBatch(
      classified,
      requested,
      undefined,
      prospective.size > 0,
    );
    const source = plan.items[0]!.plan.source;
    if (classified.instanceId !== source.instanceId ||
        classified.classificationRevision !== source.classificationRevision ||
        !tipsEqual(classified.coreTip, source.coreTip) ||
        !tipsEqual(classified.indexTip, source.indexTip)) {
      throw new RpcError('ERR_PLAN_CHANGED', 'provider group classification source changed');
    }
    const freshUnknown = new Set(classified.unknownOutpoints.map((candidate) =>
      `${candidate.txid}:${candidate.vout}`));
    for (const root of requested) {
      const key = `${root.txid}:${root.vout}`;
      if (prospective.has(key)) {
        if (!freshUnknown.has(key) || fresh.has(key)) {
          throw new RpcError('ERR_PLAN_CHANGED', 'future Foundry input is no longer unknown');
        }
        continue;
      }
      const expected = plan.items.flatMap((item) => item.plan.inputs).find((candidate) =>
        candidate.txid === root.txid && candidate.vout === root.vout);
      const current = fresh.get(key);
      if (!expected || !current || !providerFactsEqual(current, expected)) {
        throw new RpcError('ERR_PLAN_CHANGED', 'provider group root classification changed');
      }
    }
    return view;
  }

  private async refreshProviderPlanPreviews(plan: ProviderPsbtPlanV3): Promise<void> {
    if (plan.analysis.assetEffects.inscriptions.length === 0) return;
    const gateway = this.deps.gateway;
    if (!gateway || gateway.endpoint !== plan.source.backend) {
      throw new RpcError('ERR_PLAN_CHANGED', 'approved preview backend unavailable');
    }
    const request = inscriptionApprovalRequest({
      network: plan.network,
      analysis: plan.analysis,
      analysisHash: plan.analysisHash,
      psbtHash: plan.psbtHash,
      transactionCommitmentHash: plan.transactionCommitmentHash,
    });
    const fetched = await gateway.fetchInscriptionApprovalBatch(request);
    if (!fetched.ok || fetched.value.instanceId !== plan.source.instanceId ||
        !tipsEqual(fetched.value.coreTip, plan.source.coreTip) ||
        !tipsEqual(fetched.value.indexTip, plan.source.indexTip)) {
      throw new RpcError('ERR_PLAN_CHANGED', 'signed inscription previews changed');
    }
    try {
      reattachProviderPsbtPlanPreviews(plan, bindInscriptionPreviews({
        request,
        response: fetched.value,
        verifiedAtMs: fetched.verifiedAtMs,
      }));
    } catch {
      throw new RpcError('ERR_PLAN_CHANGED', 'inscription preview provenance changed');
    }
  }

  private async assertProviderWalletInputsEligibleLocked(
    dek: Uint8Array,
    vaultId: string,
    plan: ProviderPsbtPlanV3,
  ): Promise<void> {
    const utxos = await this.loadAllUtxosLocked(dek, vaultId);
    const byOutpoint = new Map(utxos.map((utxo) => [outpointKey(utxo.outpoint), utxo]));
    // A deferred parent deliberately carries no fee; its child or replacement
    // supplies the package fee. Eligibility still needs a positive marginal
    // input cost, so use the minimum relay rate for that independent check.
    const eligibilityFeeRate = plan.deferredZeroFee
      ? 1_000n
      : plan.feeRateSatPerKvB ?? BigInt(MAX_FEE_RATE_SAT_PER_KVB);
    const eligibility = await this.eligibilityContextLocked(
      dek,
      vaultId,
      eligibilityFeeRate,
    );
    const protectedInputs = new Set(plan.protectedSatFlow.map((flow) => flow.inputIndex));
    for (let index = 0; index < plan.inputs.length; index += 1) {
      const planned = plan.inputs[index]!;
      if (planned.ownership !== 'wallet') continue;
      // A child may spend an output created by another PSBT in the same
      // approved group. It cannot exist in the wallet cache yet; Core has
      // already proven its value, asset projection, and active-account
      // control from the immutable parent transaction and group preparation.
      if (plan.linkedGroup?.inputProvenance[index]?.kind === 'linked_output') continue;
      if (plan.linkedGroup?.inputProvenance[index]?.kind === 'ordnet_foundry_future') continue;
      const provenance = plan.linkedGroup?.inputProvenance[index];
      if (provenance?.kind === 'gateway' &&
          provenance.walletControl === 'ordnet_foundry_script_path') continue;
      const current = byOutpoint.get(`${planned.txid}:${planned.vout}`);
      if (!current || current.accountId !== plan.accountId || current.account !== plan.account ||
          current.valueSats !== planned.valueSats ||
          current.scriptPubKey !== planned.scriptPubKey || !current.facts ||
          current.facts.confidence !== 'authoritative' ||
          !cachedProviderFactsEqual(current.facts, planned.classification)) {
        throw new RpcError('ERR_PLAN_CHANGED', 'wallet input state changed');
      }
      const result = evaluateEligibility(current, eligibility);
      const allowedProtected =
        (plan.kind === 'provider_ordinal_transfer' || plan.kind === 'community_vault_acquisition') &&
        protectedInputs.has(index);
      if (result.reasons.some((reason) => !allowedProtected || reason !== 'not_cardinal_clean')) {
        throw new RpcError('ERR_UNSAFE_TRANSACTION', 'provider wallet input is not eligible');
      }
    }
  }

  async providerPreparePsbt(input: {
    psbtBase64: string;
    binding: ProviderAuthorityBinding;
    broadcast: boolean;
    kind?: ProviderPsbtPlanV3['kind'];
    walletOutputs?: Array<{ scriptPubKey: string; output: PlanOutput }>;
    protectedSatFlow?: TransactionPlan['protectedSatFlow'];
    requiresAdvanced?: boolean;
    expiresAt?: number;
    selectedInputIndexes?: number[];
    signInputBindings?: Array<{ address: string; inputIndexes: number[] }>;
    communityVaultAcquisition?: CommunityVaultAcquisitionProviderReviewV1;
    communityVaultSale?: CommunityVaultSaleProviderReviewV1;
    communityVaultSaleBuyer?: CommunityVaultSaleBuyerProviderReviewV1;
    communityVaultPositionTransfer?: CommunityVaultPositionTransferProviderReviewV1;
    marketplace?: {
      context: MarketplaceContext;
      resolution: MarketplaceResolution;
      selectedInputIndexes?: number[];
    };
  }): Promise<ProviderPsbtPlanV3> {
    const gateway = this.deps.gateway;
    if (!gateway) throw new RpcError('ERR_DATA_STALE', 'gateway unavailable');
    const accountView = await this.providerAccountView();
    if (input.marketplace) {
      await this.runExclusive(() => this.withSessionDek(
        { expectedVaultId: accountView.vaultId, expectedSessionId: accountView.sessionId },
        async (dek, session) => {
          const active = await this.assertMarketplaceAccountLocked(dek, session.vaultId);
          if (active.accountId !== accountView.accountId || active.account !== accountView.account) {
            throw new RpcError('ERR_PLAN_CHANGED', 'marketplace account changed');
          }
        },
      ));
    }
    let requested: Array<{ txid: string; vout: number }>;
    try {
      requested = providerPsbtOutpoints(input.psbtBase64);
    } catch {
      throw new RpcError('ERR_INVALID_PAYLOAD', 'invalid PSBT');
    }
    if (requested.length === 0 || requested.length > CLASSIFY_MAX_OUTPOINTS) {
      throw new RpcError('ERR_INVALID_PAYLOAD', 'unsupported PSBT input count');
    }
    const [gatewayView, classified] = await Promise.all([
      this.gatewayStatus({ forceRefresh: true }),
      gateway.classifyOutpoints({ network: this.deps.network, outpoints: requested }),
    ]);
    if (!classified.ok || classified.value.unknownOutpoints.length > 0 ||
        classified.value.classifications.length !== requested.length) {
      throw new RpcError('ERR_DATA_STALE', 'classification incomplete');
    }
    await this.assertProviderClassificationBatch(classified.value, requested);
    return this.runExclusive(() => this.withSessionDek(
      { expectedVaultId: accountView.vaultId, expectedSessionId: accountView.sessionId },
      async (dek, session) => {
        await this.assertSpendingFreshLocked(
          dek,
          session.vaultId,
          gatewayView,
          input.kind === 'provider_ordinal_transfer' ? 'rescue_sweep' : 'native_send',
        );
        const activeAccount = input.marketplace
          ? await this.assertMarketplaceAccountLocked(dek, session.vaultId)
          : await this.assertProviderAccountLocked(dek, session.vaultId);
        if (activeAccount.accountId !== accountView.accountId ||
            activeAccount.account !== accountView.account) {
          throw new RpcError('ERR_PLAN_CHANGED', 'active account changed');
        }
        const active = activeAccount.account;
        const utxos = await this.loadAllUtxosLocked(dek, session.vaultId);
        const requestedSet = new Set(requested.map((item) => `${item.txid}:${item.vout}`));
        const map = await loadVaults(this.deps.local);
        const record = map[session.vaultId];
        if (!record) throw new RpcError('ERR_VAULT_NOT_FOUND');
        const seed = hexToBytes(openVaultPayload(record, dek).seedHex);
        try {
          const providerReceiveOutputs: Array<{ scriptPubKey: string; output: PlanOutput }> = [
            { kind: 'payment' as const, address: accountView.payment, role: 'payment_change' as const },
            { kind: 'ordinals' as const, address: accountView.ordinals, role: 'ordinal_change' as const },
          ].map(({ kind, address, role }) => {
            const scriptPubKey = scriptPubKeyHex(address.publicKeyHex, kind, this.deps.network);
            return {
              scriptPubKey,
              output: {
                valueSats: 0n,
                scriptPubKey,
                address: address.address,
                role,
                derivation: {
                  account: active,
                  accountId: accountView.accountId,
                  lane: kind,
                  chain: 0,
                  index: 0,
                  path: address.path,
                  publicKeyHex: address.publicKeyHex,
                },
              },
            };
          });
          const walletInputs = utxos
            .filter((utxo) => utxo.accountId === accountView.accountId &&
              requestedSet.has(outpointKey(utxo.outpoint)))
            .map((utxo) => ({
              outpoint: outpointKey(utxo.outpoint),
              derivation: this.deriveForUtxo(seed, utxo),
            }));
          if (input.marketplace?.resolution.templateId === 'ordnet-list' &&
              input.marketplace.context.step === 2 && input.marketplace.selectedInputIndexes) {
            const tx = Transaction.fromPSBT(base64ToBytes(input.psbtBase64), { lowR: true });
            for (const index of input.marketplace.selectedInputIndexes) {
              const outpoint = requested[index];
              if (!outpoint || walletInputs.some((item) => item.outpoint === `${outpoint.txid}:${outpoint.vout}`)) continue;
              verifyOrdnetSaleScriptPath(tx, index, accountView.ordinals.publicKeyHex.slice(2));
              walletInputs.push({
                outpoint: `${outpoint.txid}:${outpoint.vout}`,
                derivation: {
                  account: active,
                  accountId: accountView.accountId,
                  lane: 'ordinals',
                  chain: 0,
                  index: 0,
                  path: accountView.ordinals.path,
                  publicKeyHex: accountView.ordinals.publicKeyHex,
                },
              });
            }
          }
          const source: TransactionPlan['source'] = {
            backend: gateway.endpoint,
            instanceId: classified.value.instanceId,
            classificationRevision: classified.value.classificationRevision,
            coreTip: classified.value.coreTip,
            indexTip: classified.value.indexTip,
            feeQuoteTimestamp: null,
            mempoolState: null,
          };
          try {
            let plan = createProviderPsbtPlan({
              psbtBase64: input.psbtBase64,
              binding: input.binding,
              network: this.deps.network,
              vaultId: session.vaultId,
              sessionId: session.sessionId,
              accountId: accountView.accountId,
              account: active,
              classifications: classified.value.classifications,
              walletInputs,
              source,
              broadcast: input.broadcast,
              planId: this.deps.newSessionId(),
              now: this.deps.vaultDeps.now(),
              ...(input.kind === undefined ? {} : { kind: input.kind }),
              walletOutputs: input.walletOutputs ?? providerReceiveOutputs,
              ...(input.protectedSatFlow === undefined ? {} : { protectedSatFlow: input.protectedSatFlow }),
              ...(input.requiresAdvanced === undefined ? {} : { requiresAdvanced: input.requiresAdvanced }),
              ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
              ...(input.selectedInputIndexes === undefined ? {} : { selectedInputIndexes: input.selectedInputIndexes }),
              ...(input.signInputBindings === undefined ? {} : { signInputBindings: input.signInputBindings }),
              ...(input.communityVaultAcquisition === undefined ? {} : {
                communityVaultAcquisition: input.communityVaultAcquisition,
              }),
              ...(input.communityVaultSale === undefined ? {} : {
                communityVaultSale: input.communityVaultSale,
              }),
              ...(input.communityVaultSaleBuyer === undefined ? {} : {
                communityVaultSaleBuyer: input.communityVaultSaleBuyer,
              }),
              ...(input.communityVaultPositionTransfer === undefined ? {} : {
                communityVaultPositionTransfer: input.communityVaultPositionTransfer,
              }),
              ...(input.marketplace === undefined ? {} : { marketplace: input.marketplace }),
            });
            // The Advanced-signing setting gates only plans that actually need
            // the Advanced ceremony. Core decides that: recognized marketplace
            // templates and proven §21.1 generic listings are not Advanced.
            if (plan.analysis.assetEffects.inscriptions.length > 0) {
              if (!classified.value.capabilities.includes('preview_service')) {
                throw new Error('signed inscription previews unavailable');
              }
              const request = inscriptionApprovalRequest({
                network: plan.network,
                analysis: plan.analysis,
                analysisHash: plan.analysisHash,
                psbtHash: plan.psbtHash,
                transactionCommitmentHash: plan.transactionCommitmentHash,
              });
              const fetched = await gateway.fetchInscriptionApprovalBatch(request);
              if (!fetched.ok || fetched.value.instanceId !== plan.source.instanceId ||
                  !tipsEqual(fetched.value.coreTip, plan.source.coreTip) ||
                  !tipsEqual(fetched.value.indexTip, plan.source.indexTip)) {
                throw new Error('signed inscription previews unavailable');
              }
              plan = bindProviderPsbtPlanPreviews(plan, bindInscriptionPreviews({
                request,
                response: fetched.value,
                verifiedAtMs: fetched.verifiedAtMs,
              }));
            }
            await this.assertProviderWalletInputsEligibleLocked(dek, session.vaultId, plan);
            await this.persistMarketplacePreparedLocked(dek, plan);
            return plan;
          } catch (error) {
            if (error instanceof RpcError) throw error;
            throw new RpcError('ERR_UNSAFE_TRANSACTION', 'provider PSBT rejected');
          }
        } finally {
          zeroize(seed);
        }
      },
    ));
  }

  async providerPreparePsbtBatch(input: {
    items: Array<{ psbtBase64: string; inputsToSign?: ProviderBatchInputSelection[] }>;
    binding: ProviderAuthorityBinding & { providerMethod: 'signMultipleTransactions' };
    approvalGeneration: number;
    guard?: ProviderOperationGuard;
  }): Promise<ProviderPsbtBatchPlanV1> {
    const account = await this.providerAccountView();
    const addressLane = new Map([
      [account.payment.address, 'payment' as const],
      [account.ordinals.address, 'ordinals' as const],
    ]);
    const prepared: Array<{ plan: ProviderPsbtPlanV3; inputsToSign?: ProviderBatchInputSelection[] }> = [];
    for (const item of input.items) {
      input.guard?.();
      for (const selection of item.inputsToSign ?? []) {
        if (!addressLane.has(selection.address)) {
          throw new RpcError('ERR_UNSAFE_TRANSACTION', 'batch signing address is not in the active account');
        }
      }
      const selectedInputIndexes = item.inputsToSign?.flatMap((selection) => selection.signingIndexes);
      const plan = await this.providerPreparePsbt({
        psbtBase64: item.psbtBase64,
        binding: input.binding,
        broadcast: false,
        ...(selectedInputIndexes === undefined ? {} : { selectedInputIndexes }),
        ...(item.inputsToSign === undefined ? {} : {
          signInputBindings: item.inputsToSign.map((selection) => ({
            address: selection.address,
            inputIndexes: selection.signingIndexes,
          })),
        }),
      });
      for (const selection of item.inputsToSign ?? []) {
        const lane = addressLane.get(selection.address);
        if (selection.signingIndexes.some((index) => plan.inputs[index]?.derivation?.lane !== lane)) {
          throw new RpcError('ERR_UNSAFE_TRANSACTION', 'batch signing indexes do not match their address');
        }
      }
      prepared.push({ plan, ...(item.inputsToSign === undefined ? {} : { inputsToSign: item.inputsToSign }) });
      input.guard?.();
    }
    try {
      const batch = createProviderPsbtBatchPlan({
        items: prepared,
        planId: this.deps.newSessionId(),
        now: this.deps.vaultDeps.now(),
        approvalGeneration: input.approvalGeneration,
      });
      input.guard?.();
      return batch;
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError('ERR_UNSAFE_TRANSACTION', 'provider PSBT batch rejected');
    }
  }

  /**
   * Prepare a graph-aware signing request from one authenticated root
   * classification pass. Internally-created child inputs are projected and
   * control-proven by Core; they are never sent to the gateway as if they were
   * already on-chain UTXOs.
   */
  async providerPreparePsbtGroup(input: {
    items: Array<{
      nodeId: string;
      psbtBase64: string;
      inputsToSign: ProviderPsbtInputSelection[];
      expectedUnsignedTxid?: string;
      marketplace?: { context: MarketplaceContext; resolution: MarketplaceResolution };
    }>;
    binding: ProviderAuthorityBinding & { providerMethod: 'signMultipleTransactions' };
    approvalGeneration: number;
    guard?: ProviderOperationGuard;
  }): Promise<ProviderPsbtGroupPlanV1> {
    const gateway = this.deps.gateway;
    if (!gateway) throw new RpcError('ERR_DATA_STALE', 'gateway unavailable');
    const accountView = await this.providerAccountView();
    const addressLane = new Map([
      [accountView.payment.address, 'payment' as const],
      [accountView.ordinals.address, 'ordinals' as const],
    ]);
    const preparationItems: ProviderPsbtGroupPreparationItem[] = input.items.map((item) => {
      for (const selection of item.inputsToSign) {
        if (!addressLane.has(selection.address)) {
          throw new RpcError('ERR_UNSAFE_TRANSACTION', 'group signing address is not in the active account');
        }
      }
      return {
        nodeId: item.nodeId,
        psbtBase64: item.psbtBase64,
        selectedInputIndexes: item.inputsToSign.flatMap((selection) => selection.signingIndexes),
        inputsToSign: item.inputsToSign,
        ...(item.marketplace === undefined ? {} : { marketplace: item.marketplace }),
      };
    });
    let inspected;
    try {
      inspected = inspectProviderPsbtGroupRequest(preparationItems);
    } catch {
      throw new RpcError('ERR_INVALID_PAYLOAD', 'invalid PSBT transaction group');
    }
    if (inspected.externalOutpoints.length === 0) {
      throw new RpcError('ERR_INVALID_PAYLOAD', 'unsupported PSBT transaction group input count');
    }
    input.guard?.();
    const nativeOrdnet = input.binding.origin === 'https://ord.net' ||
      input.binding.origin === 'https://www.ord.net';
    const [gatewayView, classified] = await Promise.all([
      this.gatewayStatus({ forceRefresh: true }),
      classifyProviderOutpointsChunked({
        network: this.deps.network,
        requested: inspected.externalOutpoints,
        classify: (request) => gateway.classifyOutpoints(request),
        allowUnknown: nativeOrdnet,
        ...(input.guard === undefined ? {} : { guard: input.guard }),
      }),
    ]);
    await this.assertProviderClassificationBatch(
      classified,
      inspected.externalOutpoints,
      undefined,
      nativeOrdnet,
    );
    input.guard?.();
    return this.runExclusive(() => this.withSessionDek(
      { expectedVaultId: accountView.vaultId, expectedSessionId: accountView.sessionId },
      async (dek, session) => {
        await this.assertSpendingFreshLocked(dek, session.vaultId, gatewayView, 'native_send');
        const hasMarketplace = input.items.some((item) => item.marketplace !== undefined);
        const activeAccount = hasMarketplace
          ? await this.assertMarketplaceAccountLocked(dek, session.vaultId)
          : await this.assertProviderAccountLocked(dek, session.vaultId);
        if (activeAccount.accountId !== accountView.accountId || activeAccount.account !== accountView.account) {
          throw new RpcError('ERR_PLAN_CHANGED', 'active account changed');
        }
        const utxos = await this.loadAllUtxosLocked(dek, session.vaultId);
        const map = await loadVaults(this.deps.local);
        const record = map[session.vaultId];
        if (!record) throw new RpcError('ERR_VAULT_NOT_FOUND');
        const seed = hexToBytes(openVaultPayload(record, dek).seedHex);
        try {
          const primaryDerivations = [
            { lane: 'payment' as const, address: accountView.payment },
            { lane: 'ordinals' as const, address: accountView.ordinals },
          ].map(({ lane, address }) => ({
            address: address.address,
            derivation: {
              account: activeAccount.account,
              accountId: accountView.accountId,
              lane,
              chain: 0 as const,
              index: 0 as const,
              path: address.path,
              publicKeyHex: address.publicKeyHex,
            },
          }));
          const source: TransactionPlan['source'] = {
            backend: gateway.endpoint,
            instanceId: classified.instanceId,
            classificationRevision: classified.classificationRevision,
            coreTip: classified.coreTip,
            indexTip: classified.indexTip,
            feeQuoteTimestamp: null,
            mempoolState: null,
          };
          const preparation = prepareProviderPsbtGroupInputs({
            groupId: this.deps.newSessionId(),
            items: preparationItems,
            externalClassifications: classified.classifications,
            prospectiveOutpoints: classified.unknownOutpoints.map((candidate) =>
              `${candidate.txid}:${candidate.vout}`),
            source,
            walletControl: {
              network: this.deps.network,
              origin: input.binding.origin,
              accountId: accountView.accountId,
              account: activeAccount.account,
              candidates: primaryDerivations,
            },
          });
          const walletOutputs: Array<{ scriptPubKey: string; output: PlanOutput }> =
            primaryDerivations.map(({ address, derivation }) => {
              const role = derivation.lane === 'payment' ? 'payment_change' as const : 'ordinal_change' as const;
              const scriptPubKey = scriptPubKeyHex(
                derivation.publicKeyHex, derivation.lane, this.deps.network,
              );
              return { scriptPubKey, output: { valueSats: 0n, scriptPubKey, address, role, derivation } };
            });
          const policyBoundPreparation = !inspected.topology.independent ||
            preparation.prospectiveOutpoints.length > 0 || preparation.items.some((preparedItem) =>
              preparedItem.provenance.some((entry) =>
                entry.walletControl === 'ordnet_foundry_script_path'));
          const externalWalletInputs = utxos
            .filter((utxo) => utxo.accountId === accountView.accountId &&
              inspected.externalOutpoints.some((root) => outpointKey(utxo.outpoint) === `${root.txid}:${root.vout}`))
            .map((utxo) => ({
              outpoint: outpointKey(utxo.outpoint),
              derivation: this.deriveForUtxo(seed, utxo),
            }));
          const plans: Array<{
            nodeId: string;
            plan: ProviderPsbtPlanV3;
            inputsToSign: ProviderPsbtInputSelection[];
            expectedUnsignedTxid?: string;
          }> = [];
          for (let index = 0; index < input.items.length; index += 1) {
            input.guard?.();
            const item = input.items[index]!;
            const linkedBinding = providerPsbtLinkedGroupBinding(preparation, item.nodeId);
            const selectedInputIndexes = item.inputsToSign.flatMap((selection) => selection.signingIndexes);
            let plan = createProviderPsbtPlan({
              psbtBase64: item.psbtBase64,
              binding: input.binding,
              network: this.deps.network,
              vaultId: session.vaultId,
              sessionId: session.sessionId,
              accountId: accountView.accountId,
              account: activeAccount.account,
              classifications: linkedBinding.classifications,
              walletInputs: [...externalWalletInputs, ...linkedBinding.walletInputs],
              source,
              broadcast: false,
              planId: this.deps.newSessionId(),
              now: this.deps.vaultDeps.now(),
              walletOutputs,
              selectedInputIndexes,
              signInputBindings: item.inputsToSign.map((selection) => ({
                address: selection.address,
                inputIndexes: selection.signingIndexes,
              })),
              ...(item.marketplace === undefined ? {} : { marketplace: {
                ...item.marketplace,
                selectedInputIndexes,
              } }),
              ...(policyBoundPreparation ? { linkedGroup: linkedBinding.linkedGroup } : {}),
            });
            for (const selection of item.inputsToSign) {
              const lane = addressLane.get(selection.address);
              if (selection.signingIndexes.some((inputIndex) => plan.inputs[inputIndex]?.derivation?.lane !== lane)) {
                throw new Error('group signing indexes do not match their address');
              }
            }
            if (plan.analysis.assetEffects.inscriptions.length > 0) {
              if (!classified.capabilities.includes('preview_service')) {
                throw new Error('signed inscription previews unavailable');
              }
              const request = inscriptionApprovalRequest({
                network: plan.network,
                analysis: plan.analysis,
                analysisHash: plan.analysisHash,
                psbtHash: plan.psbtHash,
                transactionCommitmentHash: plan.transactionCommitmentHash,
              });
              const fetched = await gateway.fetchInscriptionApprovalBatch(request);
              if (!fetched.ok || fetched.value.instanceId !== plan.source.instanceId ||
                  !tipsEqual(fetched.value.coreTip, plan.source.coreTip) ||
                  !tipsEqual(fetched.value.indexTip, plan.source.indexTip)) {
                throw new Error('signed inscription previews unavailable');
              }
              plan = bindProviderPsbtPlanPreviews(plan, bindInscriptionPreviews({
                request,
                response: fetched.value,
                verifiedAtMs: fetched.verifiedAtMs,
              }));
            }
            await this.assertProviderWalletInputsEligibleLocked(dek, session.vaultId, plan);
            plans.push({
              nodeId: item.nodeId,
              plan,
              inputsToSign: item.inputsToSign,
              ...(item.expectedUnsignedTxid === undefined
                ? {} : { expectedUnsignedTxid: item.expectedUnsignedTxid }),
            });
          }
          input.guard?.();
          const group = createProviderPsbtGroupPlan({
            items: plans,
            groupId: preparation.groupId,
            now: this.deps.vaultDeps.now(),
            approvalGeneration: input.approvalGeneration,
            ...(policyBoundPreparation ? { preparation } : {}),
          });
          input.guard?.();
          await this.persistMarketplaceGroupPreparedLocked(
            dek,
            group,
            input.guard,
          );
          input.guard?.();
          return group;
        } catch (error) {
          if (error instanceof RpcError) throw error;
          throw new RpcError('ERR_UNSAFE_TRANSACTION', 'provider PSBT transaction group rejected');
        } finally {
          zeroize(seed);
        }
      },
    ));
  }

  /** Revalidate the exact provider plan before it is shown or approved. */
  async providerRevalidatePreparedPsbt(plan: ProviderPsbtPlanV3): Promise<void> {
    try {
      assertProviderPsbtPlan(plan);
    } catch {
      throw new RpcError('ERR_PLAN_CHANGED', 'provider plan changed');
    }
    if (this.deps.vaultDeps.now() >= plan.expiresAt) throw new RpcError('ERR_PLAN_EXPIRED');
    const gatewayView = await this.refreshProviderPlanFacts(plan);
    await this.refreshProviderPlanPreviews(plan);
    await this.runExclusive(async () => {
      const session = await this.liveSession();
      if (!session || session.vaultId !== plan.vaultId || session.sessionId !== plan.sessionId ||
          plan.network !== this.deps.network) {
        throw new RpcError('ERR_LOCKED', 'wallet session changed');
      }
      await this.withSessionDek(
        { expectedVaultId: session.vaultId, expectedSessionId: session.sessionId },
        async (dek) => {
          const active = plan.marketplace
            ? await this.assertMarketplaceAccountLocked(dek, session.vaultId)
            : await this.assertProviderAccountLocked(dek, session.vaultId);
          if (active.accountId !== plan.accountId || active.account !== plan.account) {
            throw new RpcError('ERR_PLAN_CHANGED', 'provider review account changed');
          }
          await this.assertSpendingFreshLocked(
            dek,
            session.vaultId,
            gatewayView,
            plan.kind === 'provider_ordinal_transfer' ? 'rescue_sweep' : 'native_send',
          );
          await this.assertProviderWalletInputsEligibleLocked(dek, session.vaultId, plan);
        },
      );
    });
  }

  async providerRevalidatePreparedPsbtBatch(plan: ProviderPsbtBatchPlanV1): Promise<void> {
    try {
      assertProviderPsbtBatchPlan(plan);
    } catch {
      throw new RpcError('ERR_PLAN_CHANGED', 'provider batch plan changed');
    }
    if (this.deps.vaultDeps.now() >= plan.expiresAt) throw new RpcError('ERR_PLAN_EXPIRED');
    for (const item of plan.items) await this.providerRevalidatePreparedPsbt(item.plan);
  }

  async providerRevalidatePreparedPsbtGroup(plan: ProviderPsbtGroupPlanV1): Promise<void> {
    try {
      assertProviderPsbtGroupPlan(plan);
    } catch {
      throw new RpcError('ERR_PLAN_CHANGED', 'provider transaction group changed');
    }
    if (this.deps.vaultDeps.now() >= plan.expiresAt) throw new RpcError('ERR_PLAN_EXPIRED');
    const gatewayView = await this.refreshProviderGroupFacts(plan);
    for (const item of plan.items) await this.refreshProviderPlanPreviews(item.plan);
    await this.runExclusive(async () => {
      const session = await this.liveSession();
      if (!session || session.vaultId !== plan.vaultId || session.sessionId !== plan.sessionId ||
          plan.network !== this.deps.network) {
        throw new RpcError('ERR_LOCKED', 'wallet session changed');
      }
      await this.withSessionDek(
        { expectedVaultId: session.vaultId, expectedSessionId: session.sessionId },
        async (dek) => {
          const active = plan.items.some((item) => item.plan.marketplace)
            ? await this.assertMarketplaceAccountLocked(dek, session.vaultId)
            : await this.assertProviderAccountLocked(dek, session.vaultId);
          if (active.accountId !== plan.accountId || active.account !== plan.account) {
            throw new RpcError('ERR_PLAN_CHANGED', 'provider group review account changed');
          }
          await this.assertSpendingFreshLocked(dek, session.vaultId, gatewayView, 'native_send');
          for (const item of plan.items) {
            await this.assertProviderWalletInputsEligibleLocked(dek, session.vaultId, item.plan);
          }
        },
      );
    });
  }

  async providerSignPreparedPsbt(
    plan: ProviderPsbtPlanV3,
    requestedInputIndexes?: number[],
    guard?: ProviderOperationGuard,
  ): Promise<{ psbtBase64: string; transactionHex?: string }> {
    try {
      assertProviderPsbtPlan(plan);
    } catch {
      throw new RpcError('ERR_PLAN_CHANGED', 'provider plan changed');
    }
    if (this.deps.vaultDeps.now() >= plan.expiresAt) throw new RpcError('ERR_PLAN_EXPIRED');
    const gatewayView = await this.refreshProviderPlanFacts(plan);
    await this.refreshProviderPlanPreviews(plan);
    return this.runExclusive(async () => {
      const session = await this.liveSession();
      if (!session || session.vaultId !== plan.vaultId || session.sessionId !== plan.sessionId ||
          plan.network !== this.deps.network) {
        throw new RpcError('ERR_LOCKED', 'wallet session changed');
      }
      if (!deriveAccountCapabilities({
        unlocked: true,
        vaultType: 'seed',
        network: this.deps.network,
        transport: 'software',
      }).canSignPsbt) {
        throw new RpcError('ERR_UNSAFE_TRANSACTION', 'account cannot sign PSBTs');
      }
      return this.withSessionDek(
        { expectedVaultId: session.vaultId, expectedSessionId: session.sessionId },
        async (dek) => {
          const active = plan.marketplace
            ? await this.assertMarketplaceAccountLocked(dek, session.vaultId)
            : await this.assertProviderAccountLocked(dek, session.vaultId);
          if (active.accountId !== plan.accountId || active.account !== plan.account) {
            throw new RpcError('ERR_PLAN_CHANGED', 'provider signing account changed');
          }
          await this.assertSpendingFreshLocked(
            dek,
            session.vaultId,
            gatewayView,
            plan.kind === 'provider_ordinal_transfer' ? 'rescue_sweep' : 'native_send',
          );
          await this.assertProviderWalletInputsEligibleLocked(dek, session.vaultId, plan);
          const map = await loadVaults(this.deps.local);
          const record = map[session.vaultId];
          if (!record) throw new RpcError('ERR_VAULT_NOT_FOUND');
          const seed = hexToBytes(openVaultPayload(record, dek).seedHex);
          try {
            guard?.();
            const signed = signProviderPsbtPlan({
              plan,
              seed,
              ...(requestedInputIndexes === undefined ? {} : { requestedInputIndexes }),
              random: (length) => this.deps.vaultDeps.random(length),
            });
            await this.persistMarketplaceSignedLocked(dek, plan, signed.psbtBase64);
            return signed;
          } finally {
            zeroize(seed);
          }
        },
      );
    });
  }

  async providerSignPreparedPsbtBatch(
    plan: ProviderPsbtBatchPlanV1,
    guard?: ProviderOperationGuard,
  ): Promise<Array<{ psbtBase64: string }>> {
    try {
      assertProviderPsbtBatchPlan(plan);
    } catch {
      throw new RpcError('ERR_PLAN_CHANGED', 'provider batch plan changed');
    }
    if (this.deps.vaultDeps.now() >= plan.expiresAt) throw new RpcError('ERR_PLAN_EXPIRED');
    const gatewayViews: GatewayStatusView[] = [];
    for (const item of plan.items) {
      gatewayViews.push(await this.refreshProviderPlanFacts(item.plan));
      await this.refreshProviderPlanPreviews(item.plan);
    }
    return this.runExclusive(async () => {
      const session = await this.liveSession();
      if (!session || session.vaultId !== plan.vaultId || session.sessionId !== plan.sessionId ||
          plan.network !== this.deps.network) {
        throw new RpcError('ERR_LOCKED', 'wallet session changed');
      }
      if (!deriveAccountCapabilities({
        unlocked: true,
        vaultType: 'seed',
        network: this.deps.network,
        transport: 'software',
      }).canSignPsbt) {
        throw new RpcError('ERR_UNSAFE_TRANSACTION', 'account cannot sign PSBTs');
      }
      return this.withSessionDek(
        { expectedVaultId: session.vaultId, expectedSessionId: session.sessionId },
        async (dek) => {
          const active = await this.assertProviderAccountLocked(dek, session.vaultId);
          if (active.accountId !== plan.accountId || active.account !== plan.account) {
            throw new RpcError('ERR_PLAN_CHANGED', 'provider batch signing account changed');
          }
          for (let index = 0; index < plan.items.length; index += 1) {
            const item = plan.items[index]!;
            await this.assertSpendingFreshLocked(
              dek,
              session.vaultId,
              gatewayViews[index]!,
              'native_send',
            );
            await this.assertProviderWalletInputsEligibleLocked(dek, session.vaultId, item.plan);
          }
          const map = await loadVaults(this.deps.local);
          const record = map[session.vaultId];
          if (!record) throw new RpcError('ERR_VAULT_NOT_FOUND');
          const seed = hexToBytes(openVaultPayload(record, dek).seedHex);
          try {
            guard?.();
            return await signProviderPsbtBatchPlan({
              plan,
              seed,
              now: this.deps.vaultDeps.now(),
              random: (length) => this.deps.vaultDeps.random(length),
              ...(guard === undefined ? {} : { guard }),
              // A timer task lets queued port, window, lock, and account events
              // invalidate the synchronous guard between signatures and before
              // any complete result can leave the service.
              yieldControl: () => new Promise((resolve) => setTimeout(resolve, 0)),
            });
          } finally {
            zeroize(seed);
          }
        },
      );
    });
  }

  async providerSignPreparedPsbtGroup(
    plan: ProviderPsbtGroupPlanV1,
    guard?: ProviderOperationGuard,
  ): Promise<Array<{ psbtBase64: string }>> {
    try {
      assertProviderPsbtGroupPlan(plan);
    } catch {
      throw new RpcError('ERR_PLAN_CHANGED', 'provider transaction group changed');
    }
    if (this.deps.vaultDeps.now() >= plan.expiresAt) throw new RpcError('ERR_PLAN_EXPIRED');
    const gatewayView = await this.refreshProviderGroupFacts(plan);
    for (const item of plan.items) await this.refreshProviderPlanPreviews(item.plan);
    return this.runExclusive(async () => {
      const session = await this.liveSession();
      if (!session || session.vaultId !== plan.vaultId || session.sessionId !== plan.sessionId ||
          plan.network !== this.deps.network) {
        throw new RpcError('ERR_LOCKED', 'wallet session changed');
      }
      if (!deriveAccountCapabilities({
        unlocked: true,
        vaultType: 'seed',
        network: this.deps.network,
        transport: 'software',
      }).canSignPsbt) {
        throw new RpcError('ERR_UNSAFE_TRANSACTION', 'account cannot sign PSBTs');
      }
      return this.withSessionDek(
        { expectedVaultId: session.vaultId, expectedSessionId: session.sessionId },
        async (dek) => {
          const active = plan.items.some((item) => item.plan.marketplace)
            ? await this.assertMarketplaceAccountLocked(dek, session.vaultId)
            : await this.assertProviderAccountLocked(dek, session.vaultId);
          if (active.accountId !== plan.accountId || active.account !== plan.account) {
            throw new RpcError('ERR_PLAN_CHANGED', 'provider group signing account changed');
          }
          await this.assertSpendingFreshLocked(dek, session.vaultId, gatewayView, 'native_send');
          for (const item of plan.items) {
            await this.assertProviderWalletInputsEligibleLocked(dek, session.vaultId, item.plan);
          }
          const map = await loadVaults(this.deps.local);
          const record = map[session.vaultId];
          if (!record) throw new RpcError('ERR_VAULT_NOT_FOUND');
          const seed = hexToBytes(openVaultPayload(record, dek).seedHex);
          try {
            guard?.();
            const signed = await signProviderPsbtGroupPlan({
              plan,
              seed,
              now: () => this.deps.vaultDeps.now(),
              random: (length) => this.deps.vaultDeps.random(length),
              ...(guard === undefined ? {} : { guard }),
              yieldControl: () => new Promise((resolve) => setTimeout(resolve, 0)),
            });
            await this.persistMarketplaceGroupSignedLocked(
              dek,
              plan,
              signed.results,
              guard,
            );
            return signed.results.map(({ psbtBase64 }) => ({ psbtBase64 }));
          } finally {
            zeroize(seed);
          }
        },
      );
    });
  }

  async providerMarkMarketplaceDelivered(plan: ProviderPsbtPlanV3): Promise<void> {
    if (!plan.marketplace || plan.marketplace.context.broadcaster !== 'site') return;
    const marketplace = plan.marketplace;
    await this.runExclusive(() => this.withSessionDek(
      { expectedVaultId: plan.vaultId, expectedSessionId: plan.sessionId },
      async (dek) => {
        const active = await this.assertMarketplaceAccountLocked(dek, plan.vaultId);
        if (active.accountId !== plan.accountId || active.account !== plan.account) {
          throw new RpcError('ERR_PLAN_CHANGED', 'provider delivery account changed');
        }
        const key = this.cacheKey(plan.vaultId, 'marketplaceWorkflows', this.marketplaceWorkflowKey(plan));
        const record = await this.requireCache().get(key);
        if (!record) return;
        let workflow: MarketplaceWorkflow;
        try {
          workflow = this.assertMarketplaceWorkflowJournal(
            openRecord(dek, record, marketplaceWorkflowJournalSchema),
            plan,
            marketplace.context.step,
          );
        }
        catch { throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow journal is corrupt'); }
        if (workflow.planHash !== plan.planHash || workflow.state !== 'signed_undelivered') return;
        const delivered = transitionMarketplaceWorkflow(
          workflow,
          'delivered_site_broadcast',
          this.deps.vaultDeps.now(),
        );
        await this.requireCache().put(sealRecord(
          dek,
          this.marketplaceWorkflowJournal(plan, delivered),
          key,
          this.deps.vaultDeps.random(24),
          this.deps.vaultDeps.now(),
        ));
      },
    ));
  }

  async providerMarkMarketplaceGroupDelivered(plan: ProviderPsbtGroupPlanV1): Promise<void> {
    const marketplaceItems = plan.items.filter((item) => item.plan.marketplace !== undefined);
    if (marketplaceItems.length === 0 ||
        marketplaceItems.every((item) => item.plan.marketplace!.context.broadcaster !== 'site')) return;
    if (marketplaceItems.length !== plan.items.length) {
      throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow group is incomplete');
    }
    const first = marketplaceItems[0]!.plan;
    const workflowId = first.marketplace!.context.workflowId;
    await this.runExclusive(() => this.withSessionDek(
      { expectedVaultId: plan.vaultId, expectedSessionId: plan.sessionId },
      async (dek) => {
        const active = await this.assertMarketplaceAccountLocked(dek, plan.vaultId);
        if (active.accountId !== plan.accountId || active.account !== plan.account) {
          throw new RpcError('ERR_PLAN_CHANGED', 'provider group delivery account changed');
        }
        const key = this.cacheKey(
          plan.vaultId,
          'marketplaceWorkflows',
          this.marketplaceWorkflowGroupKey(plan, workflowId),
        );
        const cache = this.requireCache();
        const record = await cache.get(key);
        if (!record) return;
        let grouped: MarketplaceWorkflowGroupJournal;
        try { grouped = openRecord(dek, record, marketplaceWorkflowGroupJournalSchema); }
        catch { throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow group journal is corrupt'); }
        if (grouped.groupHash !== plan.groupHash || grouped.entries.length !== marketplaceItems.length) return;
        const now = this.deps.vaultDeps.now();
        const entries = grouped.entries.map((entry, index) => {
          const item = marketplaceItems[index];
          if (!item || entry.nodeId !== item.nodeId || !item.plan.marketplace) {
            throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow group changed');
          }
          const workflow = this.assertMarketplaceWorkflowJournal(
            entry.journal,
            item.plan,
            item.plan.marketplace.context.step,
          );
          if (workflow.planHash !== item.plan.planHash || workflow.state !== 'signed_undelivered') {
            return entry;
          }
          if (workflow.broadcaster !== 'site') return entry;
          return {
            ...entry,
            journal: this.marketplaceWorkflowJournal(
              item.plan,
              transitionMarketplaceWorkflow(workflow, 'delivered_site_broadcast', now),
            ),
          };
        });
        await cache.put(sealRecord(
          dek,
          marketplaceWorkflowGroupJournalSchema.parse({ ...grouped, entries, updatedAt: now }),
          key,
          this.deps.vaultDeps.random(24),
          now,
        ));
      },
    ));
  }

  async providerBroadcastPreparedPsbt(
    plan: ProviderPsbtPlanV3,
    requestedInputIndexes?: number[],
    guard?: ProviderOperationGuard,
  ): Promise<{ psbt: string; txid: string }> {
    const signed = await this.providerSignPreparedPsbt(plan, requestedInputIndexes, guard);
    if (!signed.transactionHex) throw new RpcError('ERR_UNSAFE_TRANSACTION', 'PSBT did not fully finalize');
    const txid = validateProviderTransactionHex(plan, signed.transactionHex);
    const gateway = this.deps.gateway;
    if (!gateway) throw new RpcError('ERR_BROADCAST_REJECTED', 'gateway unavailable');
    const feeResponse = await gateway.fetchFees();
    if (!feeResponse.ok) throw new RpcError('ERR_FEE_QUOTE_INVALID', 'fee estimator unavailable');
    try { validateAutomaticQuote(feeResponse.value, this.deps.vaultDeps.now()); }
    catch { throw new RpcError('ERR_FEE_QUOTE_INVALID', 'unsafe fee quote'); }
    if (plan.feeRateSatPerKvB === null) {
      throw new RpcError('ERR_FEE_QUOTE_INVALID', 'provider fee rate is unavailable');
    }
    const approvedFeeRate = plan.feeRateSatPerKvB;
    const feeTier = feeResponse.value.tiers.find((tier) =>
      BigInt(tier.effectiveSatPerKvB) <= approvedFeeRate);
    if (!feeTier) throw new RpcError('ERR_FEE_QUOTE_INVALID', 'provider fee is below the live policy floor');
    const wtxid = transactionWtxid(signed.transactionHex);
    const recovery: ProviderBroadcastRecovery = {
      version: 1,
      plan,
      transactionHex: signed.transactionHex,
      txid,
      wtxid,
      feeTarget: feeTier.target,
      feeQuote: feeResponse.value,
      attempts: 0,
      nextRetryAt: this.deps.vaultDeps.now(),
      lastFailure: null,
    };
    await this.runExclusive(() => this.withSessionDek(
      { expectedVaultId: plan.vaultId, expectedSessionId: plan.sessionId },
      async (dek, session) => {
        const active = plan.marketplace
          ? await this.assertMarketplaceAccountLocked(dek, session.vaultId)
          : await this.assertProviderAccountLocked(dek, session.vaultId);
        if (active.accountId !== plan.accountId || active.account !== plan.account) {
          throw new RpcError('ERR_PLAN_CHANGED', 'provider broadcast account changed');
        }
        guard?.();
        await this.requireCache().put(sealRecord(
          dek,
          recovery,
          this.cacheKey(session.vaultId, 'providerBroadcastRecovery', plan.planId),
          this.deps.vaultDeps.random(24),
          this.deps.vaultDeps.now(),
        ));
      },
    ));
    try {
      guard?.();
    } catch (error) {
      // Deletion needs no DEK. Remove the just-persisted recovery even if the
      // invalidation was a lock/session switch that already cleared the old
      // session; otherwise a rejected authority could be broadcast on restart.
      await this.runExclusive(async () => this.requireCache().delete(
        this.cacheKey(plan.vaultId, 'providerBroadcastRecovery', plan.planId),
      )).catch(() => undefined);
      throw error;
    }
    const result = await gateway.broadcastTransaction({
      network: plan.network,
      transactionHex: signed.transactionHex,
      txid,
      wtxid,
      feeTarget: feeTier.target,
      feeQuote: feeResponse.value,
    });
    if (!result.ok) {
      throw new RpcError(
        'ERR_BROADCAST_OUTCOME_UNKNOWN',
        'provider broadcast outcome is unknown; manual reconciliation is required',
      );
    }
    if (result.value.status === 'indeterminate') {
      throw new RpcError(
        'ERR_BROADCAST_OUTCOME_UNKNOWN',
        'provider broadcast is indeterminate; manual reconciliation is required',
      );
    }
    await this.runExclusive(() => this.withSessionDek(
      { expectedVaultId: plan.vaultId, expectedSessionId: plan.sessionId },
      async (_dek, session) => {
        await this.requireCache().delete(
          this.cacheKey(session.vaultId, 'providerBroadcastRecovery', plan.planId),
        );
      },
    )).catch(() => undefined);
    if (result.value.status === 'rejected' || result.value.status === 'conflicted') {
      throw new RpcError('ERR_UNSAFE_TRANSACTION', `provider broadcast ${result.value.status}`);
    }
    this.notifyWalletDataChanged('transaction');
    return { psbt: signed.psbtBase64, txid };
  }

  /** Restart-safe retry of provider transactions using the exact approved bytes. */
  async retryProviderBroadcasts(): Promise<void> {
    // Provider transactions share the native no-replay rule. A persisted
    // indeterminate mutation requires explicit reconciliation before any
    // user-authorized resubmission.
  }

  async providerReauthenticate(password: string): Promise<void> {
    return this.runExclusive(async () => {
      const session = await this.liveSession();
      if (!session) throw new RpcError('ERR_LOCKED', 'wallet locked');
      const map = await loadVaults(this.deps.local);
      const record = map[session.vaultId];
      if (!record) throw new RpcError('ERR_VAULT_NOT_FOUND');
      const verified = await unlockVault(record, password);
      zeroize(verified.dek);
      await this.touchSessionLocked(session);
    });
  }

  /**
   * Gateway status for UI surfaces (spec §10.2, §11.3). Deliberately runs
   * OUTSIDE runExclusive: a multi-second network stall must never block vault
   * ops. It touches no vault storage — only the session-scoped status cache —
   * and is guarded by a single-flight promise so concurrent popup callers
   * share one fetch. Answers while locked (§7.5: no wallet data in the view).
   */
  async gatewayStatus(input: GatewayStatusRequest = {}): Promise<GatewayStatusView> {
    const forced = input.forceRefresh === true;
    const inflight = this.gatewayInflight;
    // A forced run satisfies every caller, and an unforced caller is satisfied by
    // anything in flight.
    if (inflight && (inflight.forced || !forced)) return (await inflight.run).view;
    if (inflight) {
      // An unforced run may have answered from the min-refetch cache without
      // touching the network, and a spending path that asked to revalidate must
      // not silently inherit that. But if it DID reach the network its result is
      // exactly what this caller wanted, so share it rather than paying a second
      // round trip on the send path. A cache-only run settles in microseconds,
      // so waiting for it here costs nothing before the real fetch starts.
      const prior = await inflight.run.catch(() => null);
      if (prior?.revalidated === true) return prior.view;
      // Two forced callers can queue behind the same unforced run. Without this
      // re-check they both fall through and each starts its own fetch, which is
      // exactly the duplicate round trip the single-flight guard exists to stop.
      const current = this.gatewayInflight;
      if (current !== null && current !== inflight && current.forced) {
        return (await current.run).view;
      }
    }
    const run = this.gatewayStatusOnce(forced).finally(() => {
      if (this.gatewayInflight?.run === run) this.gatewayInflight = null;
    });
    this.gatewayInflight = { forced, run };
    return (await run).view;
  }

  private async gatewayStatusOnce(forceRefresh: boolean): Promise<GatewayStatusRun> {
    const gateway = this.deps.gateway;
    const now = this.deps.vaultDeps.now();
    if (!gateway) return { view: deriveGatewayView(null, null, now), revalidated: false };

    let cached = await loadCachedStatus(this.deps.session, gateway.endpoint, gateway.protocolVersions);
    const freshEnough =
      cached !== null && now - cached.verifiedAtMs < GATEWAY_MIN_REFETCH_MS && !forceRefresh;

    if (!freshEnough) {
      const result = await gateway.fetchStatus();
      if (result.ok) {
        cached = { status: result.status, verifiedAtMs: result.verifiedAtMs, endpoint: gateway.endpoint };
        await saveCachedStatus(this.deps.session, cached);
        this.gatewayLastFailure = null;
      } else {
        // Keep the prior verified snapshot; the view degrades by age.
        this.gatewayLastFailure = result.reason;
      }
    }
    return {
      view: deriveGatewayView(cached, this.gatewayLastFailure, this.deps.vaultDeps.now()),
      // A failed attempt still counts: the caller asked to reach the gateway and
      // this run did, so it learns the real state instead of retrying into the
      // same failure. The client's own retry policy already covers transients.
      revalidated: !freshEnough,
    };
  }

  /**
   * Optional, display-only BTC/USD quote. Price failures never affect gateway
   * readiness or spending and signet coins are never assigned a fiat value.
   */
  async fiatPriceQuote(): Promise<FiatPriceQuote | null> {
    const gateway = this.deps.gateway;
    if (!gateway || this.deps.network !== 'mainnet') return null;
    if (this.priceInflight !== null) return this.priceInflight;
    const run = this.fiatPriceQuoteOnce(gateway).finally(() => {
      if (this.priceInflight === run) this.priceInflight = null;
    });
    this.priceInflight = run;
    return run;
  }

  private async fiatPriceQuoteOnce(gateway: GatewayClient): Promise<FiatPriceQuote | null> {
    const startedAt = this.deps.vaultDeps.now();
    let cached: Awaited<ReturnType<typeof loadCachedPrice>> = null;
    try {
      cached = await loadCachedPrice(this.deps.session, gateway.endpoint, startedAt);
    } catch {
      // Session storage is an optimization; a live verified fetch still works.
    }
    const cacheAgeMs = cached === null ? null : startedAt - cached.fetchedAtMs;
    if (cached !== null && cacheAgeMs !== null && cacheAgeMs >= 0 &&
        cacheAgeMs < PRICE_MIN_REFETCH_MS) {
      return cached.quote;
    }
    const result = await gateway.fetchPrice();
    const completedAt = this.deps.vaultDeps.now();
    if (result.ok && isAcceptableFiatPriceQuote(result.value, completedAt)) {
      try {
        await saveCachedPrice(this.deps.session, {
          quote: result.value,
          fetchedAtMs: result.verifiedAtMs,
          endpoint: gateway.endpoint,
        });
      } catch {
        // Optional public cache failure must not hide a freshly verified quote.
      }
      return result.value;
    }
    return cached !== null && isAcceptableFiatPriceQuote(cached.quote, completedAt)
      ? cached.quote
      : null;
  }

  // ---- M6: discovery scan, home view, user freeze --------------------------

  /**
   * Start (or resume) an account-discovery scan (spec §8.2). The scan runs
   * OUTSIDE runExclusive like gatewayStatus — a multi-minute network loop must
   * never block vault ops — but every persistence step is a short runExclusive
   * section that re-checks the session inside. Key material: the seed is
   * decrypted once here, neutered account xpubs live in worker memory for the
   * scan's duration only (§18.5; see address-window.ts), and a mid-scan lock
   * cancels the scan and drops them.
   */
  async startScan(input: ScanStartRequest): Promise<{ scanId: string }> {
    if (this.accountRemovalInProgress) {
      throw new RpcError('ERR_PLAN_CHANGED', 'account removal is in progress');
    }
    if (this.scanRun && this.currentScanId) {
      // Single-flight, but never hand the running scan's id to a caller whose
      // session expectation doesn't match the live session.
      const scanId = this.currentScanId;
      await this.runExclusive(async () => {
        await this.requireSession(input);
      });
      return { scanId };
    }
    const starting = this.scanStarting;
    if (starting) {
      // Another start is still between its prep and its loop handoff, so
      // scanRun/currentScanId are not published yet. Join it and report the same
      // scan: two loops would duplicate every gateway request for the whole scan
      // and interleave checkpoint writes for different scan ids. Same session
      // rule as above — verify this caller before handing back the id.
      await this.runExclusive(async () => {
        await this.requireSession(input);
      });
      const joined = await starting.catch(() => null);
      // Only a start that actually launched a scan can be shared. If it failed
      // — a resume with no checkpoint, say — this caller must not inherit an
      // error raised for a different request; fall through and run its own.
      if (joined) return joined;
    }
    const start = this.startScanUnguarded(input);
    this.scanStarting = start;
    try {
      return await start;
    } finally {
      if (this.scanStarting === start) this.scanStarting = null;
    }
  }

  /** startScan's body; entered only through startScan's single-flight guard. */
  private async startScanUnguarded(input: ScanStartRequest): Promise<{ scanId: string }> {
    const gateway = this.deps.gateway;
    const cache = this.deps.walletCache;
    if (!gateway || !cache) throw new RpcError('ERR_INTERNAL', 'scan dependencies unavailable');

    const prep = await this.runExclusive(() =>
      this.withSessionDek(input, async (dek, session) => {
        const storedCheckpoint = await this.loadCheckpointLocked(dek, session.vaultId);
        const checkpoint = input.mode === 'resume' ? storedCheckpoint : null;
        const activeCheckpoint = checkpoint !== null && checkpoint.queue.length > 0 ? checkpoint : null;
        if (input.mode === 'resume' && activeCheckpoint === null) {
          throw new RpcError('ERR_INVALID_PAYLOAD', 'no interrupted scan to resume');
        }
        const scanId = activeCheckpoint?.scanId ?? this.deps.newSessionId();
        const scope: ScanScope = activeCheckpoint?.scope ??
          (input.mode === 'refresh' ? 'refresh' : 'discovery');
        const meta = await this.loadAccountsMetaLocked(dek, session.vaultId);
        const selectedPublicAccount = meta.registeredPublicAccounts.find(
          (account) => account.accountId === meta.activePublicAccountId,
        );
        if (!selectedPublicAccount) {
          throw new RpcError('ERR_INVALID_PAYLOAD', 'active public account unavailable');
        }
        const descriptorSelected = selectedPublicAccount.source === 'descriptor';
        const standardAccounts = activeCheckpoint?.standardAccounts ??
          normalizeAccountIndexes([
            ...meta.standardAccounts,
            ...meta.activeUnits
              .filter((unit) => unit.source === 'standard')
              .map((unit) => unit.account),
          ]);
        const standardAccountIds = new Map(
          meta.registeredPublicAccounts
            .filter((account) => account.source === 'standard')
            .map((account) => [account.account, account.accountId] as const),
        );
        const descriptorDefinitions = await Promise.all(
          meta.registeredPublicAccounts
            .filter((account) => account.source === 'descriptor')
            .map((account) => this.loadPublicAccountDefinitionLocked(
              dek, session.vaultId, account.accountId,
            )),
        );
        const descriptorUnits = descriptorDefinitions.flatMap((definition) =>
          buildPublicAccountScanUnits(definition));
        let queue = activeCheckpoint
          ? [...activeCheckpoint.queue]
              .filter((unit) => !descriptorSelected || unit.source === 'descriptor')
          : scope === 'refresh'
            ? buildRefreshUnits(this.deps.network, selectedPublicAccount)
            : descriptorSelected
              ? descriptorUnits
              : [
                  ...buildScanUnits(
                    this.deps.network, true, standardAccounts, standardAccountIds,
                  ),
                  ...descriptorUnits,
                ];
        if (activeCheckpoint === null && scope === 'refresh' && meta.hasConflictingSources) {
          if (storedCheckpoint === null || storedCheckpoint.done.length === 0) {
            throw new RpcError(
              'ERR_DATA_STALE',
              'a complete rescan is required to reconcile conflicting sources',
            );
          }
          const recoveryUnits = new Map(queue.map((unit) => [unitKey(unit), unit]));
          for (const unit of storedCheckpoint.done) recoveryUnits.set(unitKey(unit), unit);
          queue = [...recoveryUnits.values()];
        }
        const done = activeCheckpoint
          ? [...activeCheckpoint.done]
              .filter((unit) => !descriptorSelected || unit.source === 'descriptor')
          : [];
        const activeUnits = activeCheckpoint
          ? [...activeCheckpoint.activeUnits]
              .filter((unit) => !descriptorSelected || unit.source === 'descriptor')
          : [];
        const confirmedUnits = activeCheckpoint
          ? [...activeCheckpoint.confirmedUnits]
              .filter((unit) => !descriptorSelected || unit.source === 'descriptor')
          : [];
        const emptyStandardAccountStreak =
          activeCheckpoint?.emptyStandardAccountStreak ?? 0;
        // Resume restores ALL safety-relevant scan state, not just the queue:
        // dropping boundaryUnits would lose a pending Extended-scan prompt, and
        // dropping hadConflict would let a resumed scan complete "clean" and
        // silently clear the §11.4 conflicting_sources gate.
        const boundaryUnits: ScanUnit[] = activeCheckpoint
          ? [...activeCheckpoint.boundaryUnits]
              .filter((unit) => !descriptorSelected || unit.source === 'descriptor')
          : [];
        const revision = activeCheckpoint?.revision ?? null;
        const hadConflict = activeCheckpoint?.hadConflict ?? false;
        const historyPartial = activeCheckpoint?.historyPartial ?? false;
        const maxIndexPerChain = activeCheckpoint?.maxIndexPerChain ?? INITIAL_MAX_INDEX;
        const startedAt = activeCheckpoint?.startedAt ?? this.deps.vaultDeps.now();

        const publicRing = buildPublicAccountKeyRing(
          descriptorDefinitions, this.deps.network, queue,
        );
        const needsSoftwareKeys = queue.some(
          (unit) => unit.source === 'standard' || unit.source === 'xverse',
        );
        let softwareRing: AccountKeyRing = {
          network: this.deps.network,
          standard: new Map(),
          descriptor: new Map(),
          legacy: new Map(),
        };
        if (needsSoftwareKeys) {
          const map = await loadVaults(this.deps.local);
          const record = map[session.vaultId];
          if (!record) throw new RpcError('ERR_VAULT_NOT_FOUND', 'active vault record missing');
          const seed = hexToBytes(openVaultPayload(record, dek).seedHex);
          try {
            softwareRing = buildAccountKeyRing(seed, this.deps.network, queue);
          } finally {
            zeroize(seed);
          }
        }
        const ring: AccountKeyRing = {
          network: this.deps.network,
          standard: softwareRing.standard,
          descriptor: publicRing.descriptor,
          legacy: softwareRing.legacy,
        };

        const burned = new Map<string, number>();
        for (const unit of queue) {
          if (unit.source !== 'standard') continue;
          const state = await loadDerivationState(
            this.deps.local,
            session.vaultId,
            this.deps.network,
            unit.lane,
            unit.account,
            unit.accountId,
            unit.source === 'standard',
          );
          burned.set(unitKey(unit), state?.nextChangeIndex ?? 0);
        }
        // Persist the initial work queue before the first gateway request is
        // allowed to start. MV3 may terminate the worker at any await point;
        // without this checkpoint, termination during the first snapshot
        // request makes a started scan look idle and therefore impossible to
        // resume after the worker is recreated.
        await this.saveCheckpointLocked(dek, session.vaultId, {
          scanId,
          scope,
          queue: [...queue],
          done: [...done],
          activeUnits: [...activeUnits],
          confirmedUnits: [...confirmedUnits],
          emptyStandardAccountStreak,
          standardAccounts: [...standardAccounts],
          revision,
          startedAt,
          maxIndexPerChain,
          boundaryUnits: [...boundaryUnits],
          hadConflict,
          historyPartial,
        });
        if (input.mode === 'rescan') await this.touchSessionLocked(session);
        return {
          scanId,
          scope,
          queue,
          done,
          activeUnits,
          confirmedUnits,
          emptyStandardAccountStreak,
          standardAccounts,
          boundaryUnits,
          revision,
          hadConflict,
          historyPartial,
          maxIndexPerChain,
          startedAt,
          ring,
          burned,
        };
      }),
    );

    this.scanCancel = false;
    this.scanHistoryPartial = prep.historyPartial;
    this.currentScanId = prep.scanId;
    this.scanUnitsTotal = prep.queue.length + prep.done.length;
    // Report 'running' synchronously: a status poll right after startScan must
    // not read the PREVIOUS scan's settled phase as this scan's outcome.
    const firstUnit = prep.queue[0];
    if (firstUnit !== undefined) {
      this.setScanPhase(prep.scanId, {
        kind: 'running',
        scanId: prep.scanId,
        unit: firstUnit,
        unitsDone: prep.done.length,
        unitsTotal: this.scanUnitsTotal,
      });
    }
    const run = this.runScanLoop(prep, input).finally(() => {
      // A session change may have started a newer loop; never null its handle.
      if (this.scanRun === run) this.scanRun = null;
    });
    this.scanRun = run;
    return { scanId: prep.scanId };
  }

  /** Queryable scan progress (§8.2). Lazily surfaces an interrupted checkpoint. */
  async scanStatus(input: ActiveSessionRequest): Promise<ScanStatusView> {
    if (this.scanPhase.kind === 'idle' && this.scanRun === null && this.deps.walletCache) {
      const checkpoint = await this.runExclusive(() =>
        this.withSessionDek(input, (dek, session) => this.loadCheckpointLocked(dek, session.vaultId)),
      );
      if (checkpoint !== null && checkpoint.queue.length > 0) {
        this.scanHistoryPartial = checkpoint.historyPartial;
        this.scanPhase = { kind: 'interrupted', checkpoint };
      } else if (checkpoint !== null && checkpoint.boundaryUnits.length > 0) {
        this.scanHistoryPartial = checkpoint.historyPartial;
        this.scanPhase = {
          kind: 'awaiting_extend',
          scanId: checkpoint.scanId,
          boundaryUnits: checkpoint.boundaryUnits,
        };
      }
    } else {
      await this.runExclusive(async () => {
        await this.requireSession(input);
      });
    }
    const view = scanStatusView(this.scanPhase, this.scanUnitsTotal);
    return { ...view, historyPartial: view.historyPartial || this.scanHistoryPartial };
  }

  /**
   * Request cancellation. The engine polls the flag between requests; the
   * in-flight response completes but nothing after the cancel is persisted.
   */
  async cancelScan(input: ScanCancelRequest): Promise<{ cancelled: boolean }> {
    await this.runExclusive(async () => {
      await this.requireSession(input);
    });
    if (this.scanRun === null || this.currentScanId !== input.scanId) return { cancelled: false };
    this.scanCancel = true;
    return { cancelled: true };
  }

  /**
   * §8.2 Extended scan: user opt-in after a boundary prompt. Requeues the
   * boundary units with a raised per-chain index bound, in bounded steps.
   */
  async extendScan(input: ScanCancelRequest): Promise<{ resumed: boolean }> {
    if (this.scanRun !== null) return { resumed: false };
    await this.runExclusive(() =>
      this.withSessionDek(input, async (dek, session) => {
        const checkpoint = await this.loadCheckpointLocked(dek, session.vaultId);
        if (!checkpoint || checkpoint.scanId !== input.scanId) {
          throw new RpcError('ERR_INVALID_PAYLOAD', 'no matching scan to extend');
        }
        const queue = checkpoint.queue.length > 0 ? checkpoint.queue : checkpoint.boundaryUnits;
        if (queue.length === 0) throw new RpcError('ERR_INVALID_PAYLOAD', 'nothing to extend');
        await this.saveCheckpointLocked(dek, session.vaultId, {
          ...checkpoint,
          queue,
          boundaryUnits: [],
          maxIndexPerChain: checkpoint.maxIndexPerChain + EXTEND_STEP,
        });
        await this.touchSessionLocked(session);
      }),
    );
    await this.startScan({
      mode: 'resume',
      expectedVaultId: input.expectedVaultId,
      expectedSessionId: input.expectedSessionId,
    });
    return { resumed: true };
  }

  /**
   * §10.2 home view from the encrypted cache: Available vs Protected from the
   * single §11.2 predicate, wrong-lane states (§12), §11.4 data gating, and
   * recent activity. Read-only — answers from cache even while the gateway is
   * unreachable (balances then gate as stale).
   */
  private async projectAccountActivityLocked(
    dek: Uint8Array,
    vaultId: string,
    accountId: string,
    registered: RegisteredPublicAccount,
    utxos: readonly WalletUtxo[],
    history: readonly LaneAwareHistoryEntry[],
    transactions: readonly StoredTransaction[],
    observedAt: number,
  ): Promise<WalletActivityItem[]> {
    const recoveries = await this.loadRecoveriesLocked(dek, vaultId);
    const indeterminateTransactions = [];
    const transactionTxids = new Set(transactions.map((transaction) => transaction.txid));
    for (const recovery of recoveries) {
      if (transactionTxids.has(recovery.txid)) continue;
      const plan = await this.loadPlanLocked(dek, vaultId, recovery.planId);
      if (!plan) continue;
      const planIdentity = plan as { accountId?: string; account?: number };
      if (planIdentity.accountId !== accountId &&
          !(planIdentity.accountId === undefined && registered.source === 'standard' &&
            planIdentity.account === registered.account)) continue;
      indeterminateTransactions.push({
        txid: recovery.txid,
        createdAt: plan.createdAt,
        amountSats: plan.outputs
          .filter((output) => output.role === 'recipient' || output.role === 'postage')
          .reduce((sum, output) => sum + output.valueSats, 0n),
        feeSats: plan.feeSats,
        status: 'pending' as const,
        replacesTxid: plan.replacesTxid,
        kind: plan.kind,
        plan,
      });
    }

    const pendingOrdinalTxids = new Set(
      utxos
        .filter((utxo) =>
          utxo.height === null &&
          !utxo.walletCreatedChange &&
          (utxo.facts?.inscriptions.length ?? 0) > 0)
        .map((utxo) => utxo.outpoint.txid),
    );
    const activityTransactions = [...transactions, ...indeterminateTransactions];
    const receivedInscriptionEvidence: ReceivedInscriptionEvidence[] = [
      ...utxos.flatMap((utxo) => (utxo.facts?.inscriptions ?? []).map((inscription) => ({
        txid: utxo.outpoint.txid,
        vout: utxo.outpoint.vout,
        inscriptionId: inscription.inscriptionId,
        number: inscription.number ?? null,
        valueSats: utxo.valueSats,
      }))),
      ...activityTransactions.flatMap((transaction) => transaction.plan?.inputs
        .filter((planInput) => planInput.ownership !== 'external')
        .flatMap((planInput) => planInput.classification.inscriptions.map((inscription) => ({
          txid: planInput.txid,
          vout: planInput.vout,
          inscriptionId: inscription.inscriptionId,
          number: (transaction.plan?.version === 3
            ? transaction.plan.inscriptionPreviews.items.find(
                (item) => item.metadata.inscriptionId === inscription.inscriptionId,
              )?.metadata.number
            : null) ?? inscription.number ?? null,
          valueSats: planInput.valueSats,
        }))) ?? []),
    ];
    const retainedEvidence = await this.loadActivityEvidenceLocked(dek, vaultId);
    const authoritativeSeeds: ActivityEvidenceEntry[] = [
      ...utxos.flatMap((utxo) => (utxo.facts?.inscriptions ?? []).flatMap((inscription) => {
        const satpoint = parseCanonicalSatpoint(inscription.satpoint);
        if (satpoint === null ||
            satpoint.txid !== utxo.outpoint.txid ||
            satpoint.vout !== utxo.outpoint.vout) return [];
        return [{
          inscriptionId: inscription.inscriptionId,
          number: inscription.number ?? null,
          outpoint: { ...utxo.outpoint },
          offsetSats: satpoint.offset,
          observedAt,
        }];
      })),
      ...activityTransactions.flatMap((transaction) => transaction.plan?.inputs
        .filter((planInput) => planInput.ownership !== 'external')
        .flatMap((planInput) => planInput.classification.inscriptions.flatMap((inscription) => {
          const satpoint = parseCanonicalSatpoint(inscription.satpoint);
          if (satpoint === null ||
              satpoint.txid !== planInput.txid ||
              satpoint.vout !== planInput.vout) return [];
          return [{
            inscriptionId: inscription.inscriptionId,
            number: (transaction.plan?.version === 3
              ? transaction.plan.inscriptionPreviews.items.find(
                  (item) => item.metadata.inscriptionId === inscription.inscriptionId,
                )?.metadata.number
              : null) ?? inscription.number ?? null,
            outpoint: { txid: planInput.txid, vout: planInput.vout },
            offsetSats: satpoint.offset,
            observedAt,
          }];
        })) ?? []),
    ];
    const activityEvidence = propagateActivityEvidence(
      history,
      [...authoritativeSeeds, ...retainedEvidence.entries],
      ACTIVITY_EVIDENCE_MAX_IDENTITIES,
    );
    const evidenceChanged =
      activityEvidence.length !== retainedEvidence.entries.length ||
      activityEvidence.some((entry, index) => {
        const prior = retainedEvidence.entries[index];
        return prior === undefined ||
          entry.inscriptionId !== prior.inscriptionId ||
          entry.number !== prior.number ||
          entry.outpoint.txid !== prior.outpoint.txid ||
          entry.outpoint.vout !== prior.outpoint.vout ||
          entry.offsetSats !== prior.offsetSats ||
          entry.observedAt !== prior.observedAt;
      });
    if (evidenceChanged) {
      await this.saveActivityEvidenceLocked(dek, vaultId, {
        version: 1,
        entries: activityEvidence,
      });
    }
    const projectedActivity = projectRecentActivity(history, activityTransactions);
    return annotateOrdinalFlowActivity(
      annotateReceivedDetectedAssetActivity(
        annotateReceivedInscriptionActivity(projectedActivity, receivedInscriptionEvidence),
        utxos.flatMap((utxo) => {
          const facts = utxo.facts;
          if (facts === null || !facts.unsupportedAssetDetected) return [];
          return [{
            txid: utxo.outpoint.txid,
            vout: utxo.outpoint.vout,
            assets: facts.detectedAssets ?? [],
            identityCount: facts.detectedAssetCount ?? 0,
            identityComplete: facts.assetIdentityComplete ?? false,
          }];
        }),
      ),
      history,
      activityEvidence,
    ).map((entry) => ({
      ...entry,
      pendingAsset:
        entry.confirmationState === 'mempool' && pendingOrdinalTxids.has(entry.txid)
          ? 'ordinal' as const
          : null,
    }));
  }

  async homeView(input: ActiveSessionRequest & { accountId: string }): Promise<WalletHomeResult> {
    const binding = {
      vaultId: input.expectedVaultId,
      sessionId: input.expectedSessionId,
      accountId: input.accountId,
    };
    const clearFailedSnapshot = async (error: unknown): Promise<never> => {
      // A corrupt/invalid live projection must not keep repainting its older
      // snapshot on later popup opens. The identity-bound clear cannot delete
      // a new session/account's record when an old request fails late.
      await clearBoundHomeSnapshot(this.deps.session, binding).catch(() => undefined);
      throw error;
    };
    const gatewayView = await this.gatewayStatus({}).catch(clearFailedSnapshot);
    return this.runExclusive(() =>
      this.withSessionDek(input, async (dek, session) => {
        const meta = await this.loadAccountsMetaLocked(dek, session.vaultId);
        const registered = meta.registeredPublicAccounts.find(
          (account) => account.accountId === input.accountId,
        );
        if (!registered) throw new RpcError('ERR_INVALID_PAYLOAD', 'account is not registered');
        const historyComplete = !meta.partialHistoryUnits.some((unit) =>
          unit.accountId === input.accountId ||
          (unit.accountId === undefined && registered.source === 'standard' &&
            unit.account === registered.account));
        const utxos = (await this.loadAllUtxosLocked(dek, session.vaultId)).filter(
          (utxo) => utxo.accountId === input.accountId,
        );
        const history = await this.loadHistoryLocked(dek, session.vaultId, input.accountId);
        const transactions = (await this.loadTransactionsLocked(dek, session.vaultId)).filter(
          (transaction) => {
            const planIdentity = transaction.plan as { accountId?: string; account?: number } | undefined;
            return planIdentity?.accountId === input.accountId ||
              (planIdentity?.accountId === undefined &&
                registered.source === 'standard' && planIdentity?.account === registered.account);
          },
        );
        const cachedStatus = this.deps.gateway
          ? await loadCachedStatus(this.deps.session, this.deps.gateway.endpoint, this.deps.gateway.protocolVersions)
          : null;
        const nowMs = this.deps.vaultDeps.now();
        const freshness: FreshnessReport = cachedStatus
          ? evaluateFreshness(cachedStatus.status, nowMs, cachedStatus.verifiedAtMs)
          : { commonTip: false, heartbeatFresh: false, revisionActive: false, spendEligible: false };
        const ctx: EligibilityContext = {
          // A recorded source conflict makes preserved cache display-only.
          // Keep category totals visible, but no value is Available until a
          // subsequent full scan reconciles cleanly.
          freshness: {
            ...freshness,
            spendEligible: freshness.spendEligible && !meta.hasConflictingSources,
          },
          activeRevision: cachedStatus?.status.activeRevision ?? '',
          lockedOutpoints: await this.loadLockedOutpointsLocked(dek, session.vaultId),
          // Home has no selected fee tier; use the minimum positive relay-rate
          // marginal cost so non-positive effective values never appear as
          // Available. Transaction plans replace this with their exact rate.
          marginalFeeSatsFor: (utxo) => inputVbytes(utxo.scriptPubKey),
        };
        const balances = summarizeBalances(utxos, ctx);
        const tipsDivergeByHashOnly =
          cachedStatus !== null &&
          cachedStatus.status.coreTip.height === cachedStatus.status.ordTip.height &&
          cachedStatus.status.coreTip.hash !== cachedStatus.status.ordTip.hash;
        // §11.4/§18.4: cached classifications under a rotated revision must
        // gate spend paths even while the gateway itself reports healthy.
        const cachedRevisionStale =
          meta.revision !== null &&
          cachedStatus !== null &&
          meta.revision !== cachedStatus.status.activeRevision;
        const gating: DataGating = deriveDataGating(gatewayView, {
          hasConflictingSources: meta.hasConflictingSources,
          tipsDivergeByHashOnly,
          cachedRevisionStale,
        });

        const observedAt = meta.lastSyncedAt ?? this.deps.vaultDeps.now();
        const activity = (await this.projectAccountActivityLocked(
          dek,
          session.vaultId,
          input.accountId,
          registered,
          utxos,
          history,
          transactions,
          observedAt,
        )).slice(0, 10);
        const wrongLane = utxos
          .filter((utxo) => laneState(utxo) === 'protected_wrong_address')
          .map((utxo) => ({
            txid: utxo.outpoint.txid,
            vout: utxo.outpoint.vout,
            valueSats: utxo.valueSats.toString(),
            accountId: utxo.accountId!,
            account: utxo.account,
            lane: utxo.lane,
          }));

        const result: WalletHomeResult = {
          accountId: input.accountId,
          balances: {
            availableSats: balances.availableSats.toString(),
            protectedSats: balances.protectedSats.toString(),
            reservedSats: balances.reservedSats.toString(),
            pendingSats: balances.pendingSats.toString(),
            pendingOrdinalSats: balances.pendingOrdinalSats.toString(),
            frozenSats: balances.frozenSats.toString(),
            unavailableCleanSats: balances.unavailableCleanSats.toString(),
          },
          protectionBreakdown: {
            assetSats: balances.assetProtectedSats.toString(),
            awaitingClassificationSats: balances.awaitingClassificationSats.toString(),
            userFrozenSats: balances.userFrozenSats.toString(),
            dustQuarantinedSats: balances.dustQuarantinedSats.toString(),
          },
          collectiblesCount: balances.collectiblesCount,
          pendingOrdinalCount: balances.pendingOrdinalCount,
          wrongLaneCount: balances.wrongLaneCount,
          dataGating: { state: gating.state, blockedActions: [...gating.blockedActions] },
          activity,
          historyComplete,
          wrongLane,
          lastSyncedAt: meta.lastSyncedAt,
          scan: {
            ...scanStatusView(this.scanPhase, this.scanUnitsTotal),
            historyPartial: meta.partialHistoryUnits.length > 0 || this.scanHistoryPartial,
          },
        };
        try {
          await saveHomeSnapshot(this.deps.session, {
            vaultId: session.vaultId,
            sessionId: session.sessionId,
            accountId: input.accountId,
          }, result);
        } catch {
          // Hydration is an optimization. A full session area or unavailable
          // storage must not turn an otherwise valid Home response into an
          // error, and an older projection must not survive a failed update.
          await clearHomeSnapshot(this.deps.session).catch(() => undefined);
        }
        return result;
      }),
    ).catch(clearFailedSnapshot);
  }

  /** Page through all activity already retained in this account's encrypted cache. */
  async activityList(input: ActivityListRequest): Promise<ActivityListResult> {
    return this.runExclusive(() =>
      this.withSessionDek(input, async (dek, session) => {
        const meta = await this.loadAccountsMetaLocked(dek, session.vaultId);
        const registered = meta.registeredPublicAccounts.find(
          (account) => account.accountId === input.accountId,
        );
        if (!registered) throw new RpcError('ERR_INVALID_PAYLOAD', 'account is not registered');
        const historyComplete = !meta.partialHistoryUnits.some((unit) =>
          unit.accountId === input.accountId ||
          (unit.accountId === undefined && registered.source === 'standard' &&
            unit.account === registered.account));
        const utxos = (await this.loadAllUtxosLocked(dek, session.vaultId)).filter(
          (utxo) => utxo.accountId === input.accountId,
        );
        const history = await this.loadHistoryLocked(dek, session.vaultId, input.accountId);
        const transactions = (await this.loadTransactionsLocked(dek, session.vaultId)).filter(
          (transaction) => {
            const planIdentity = transaction.plan as
              { accountId?: string; account?: number } | undefined;
            return planIdentity?.accountId === input.accountId ||
              (planIdentity?.accountId === undefined &&
                registered.source === 'standard' && planIdentity?.account === registered.account);
          },
        );
        const activity = await this.projectAccountActivityLocked(
          dek,
          session.vaultId,
          input.accountId,
          registered,
          utxos,
          history,
          transactions,
          meta.lastSyncedAt ?? this.deps.vaultDeps.now(),
        );
        return {
          accountId: input.accountId,
          ...paginateActivity(activity, input.cursor),
          historyComplete,
        };
      }),
    );
  }

  /** Return only the exact current session/account's last Home projection. */
  async homeSnapshot(
    input: ActiveSessionRequest & { accountId: string },
  ): Promise<{ home: WalletHomeResult | null }> {
    return this.runExclusive(async () => {
      const session = await this.requireSession(input);
      const home = await loadHomeSnapshot(this.deps.session, {
        vaultId: session.vaultId,
        sessionId: session.sessionId,
        accountId: input.accountId,
      });
      return { home };
    });
  }

  /**
   * Return only a gateway-signed, inert raster for an inscription tied to this
   * wallet's current classified UTXOs or encrypted transaction journal. These
   * checks prevent this surface from becoming an arbitrary inscription lookup,
   * while fetching current metadata first preserves the preview service's
   * exact-identity binding after an inscription has moved.
   */
  async activityInscriptionPreview(
    input: ActivityInscriptionPreviewRequest,
  ): Promise<ActivityInscriptionPreviewResult> {
    const authorize = () => this.runExclusive(() =>
      this.withSessionDek(input, async (dek, session) => {
        await this.authorizeActivityPreviewItemsLocked(
          dek, session.vaultId, input.accountId, [input],
        );
        return true;
      }),
    );
    await authorize();

    const gateway = this.deps.gateway;
    if (!gateway) throw new RpcError('ERR_DATA_STALE', 'signed preview service unavailable');
    const metadata = await gateway.fetchInscriptionMetadata(input.inscriptionId);
    if (!metadata.ok) throw new RpcError('ERR_DATA_STALE', 'signed inscription metadata unavailable');
    const preview = await gateway.fetchInscriptionPreview({
      inscriptionId: metadata.value.metadata.inscriptionId,
      satpoint: metadata.value.metadata.satpoint,
      outpoint: { ...metadata.value.metadata.outpoint },
      classificationRevision: metadata.value.metadata.classificationRevision,
    });
    if (!preview.ok) throw new RpcError('ERR_DATA_STALE', 'signed inscription preview unavailable');

    // A fetch may cross a lock or vault switch. Re-authorize before releasing
    // wallet-linked bytes to the caller.
    await authorize();
    const payload = preview.value.preview;
    return {
      inscriptionId: input.inscriptionId,
      preview: uiPreviewFromPayload(payload),
    };
  }

  async activityInscriptionPreviewBatch(
    input: ActivityInscriptionPreviewBatchRequest,
  ): Promise<ActivityInscriptionPreviewBatchResult> {
    const authorize = () => this.runExclusive(() =>
      this.withSessionDek(input, async (dek, session) => {
        await this.authorizeActivityPreviewItemsLocked(
          dek, session.vaultId, input.accountId, input.items,
        );
      }),
    );
    await authorize();
    const gateway = this.deps.gateway;
    if (!gateway) throw new RpcError('ERR_DATA_STALE', 'signed preview service unavailable');
    const batch = await gateway.fetchInscriptionActivityBatch({
      network: this.deps.network,
      inscriptionIds: input.items.map((item) => item.inscriptionId),
    });
    if (!batch.ok) {
      if (batch.reason === 'http' && batch.httpStatus === 404) {
        const items = await Promise.all(input.items.map((item) =>
          this.activityInscriptionPreview({
            ...item,
            accountId: input.accountId,
            expectedSessionId: input.expectedSessionId,
            expectedVaultId: input.expectedVaultId,
          })));
        return { items };
      }
      throw new RpcError('ERR_DATA_STALE', 'signed inscription previews unavailable');
    }
    await authorize();
    return {
      items: batch.value.items.map((item) => ({
        inscriptionId: item.metadata.inscriptionId,
        preview: uiPreviewFromPayload(item.preview),
      })),
    };
  }

  private async authorizeActivityPreviewItemsLocked(
    dek: Uint8Array,
    vaultId: string,
    accountId: string,
    items: readonly { txid: string; inscriptionId: string }[],
  ): Promise<void> {
    const transactions = await this.loadTransactionsLocked(dek, vaultId);
    const recoveries = await this.loadRecoveriesLocked(dek, vaultId);
    const recoveryPlans = [];
    for (const recovery of recoveries) {
      const plan = await this.loadPlanLocked(dek, vaultId, recovery.planId);
      if (plan) recoveryPlans.push({ txid: recovery.txid, plan });
    }
    const transactionPlans = transactions.flatMap((transaction) =>
      transaction.plan
        ? [{ txid: transaction.txid, plan: transaction.plan }]
        : []);
    const plans = [...transactionPlans, ...recoveryPlans].filter(({ plan }) =>
      (plan as { accountId?: string }).accountId === accountId);
    const utxos = (await this.loadAllUtxosLocked(dek, vaultId)).filter(
      (utxo) => utxo.accountId === accountId,
    );
    const retained = await this.loadActivityEvidenceLocked(dek, vaultId);
    for (const input of items) {
      const outboundLinked = plans.some(({ txid, plan }) =>
        txid === input.txid &&
        ordinalActionInscriptionId(plan) === input.inscriptionId);
      const inboundJournalLinked = plans.some(({ plan }) => plan.inputs.some((planInput) =>
        planInput.ownership !== 'external' &&
        planInput.txid === input.txid &&
        planInput.classification.inscriptions.some(
          (inscription) => inscription.inscriptionId === input.inscriptionId,
        )));
      const inboundCurrentLinked = utxos.some((utxo) =>
        utxo.outpoint.txid === input.txid &&
        utxo.facts?.inscriptions.some(
          (inscription) => inscription.inscriptionId === input.inscriptionId,
        ));
      const retainedLinked = retained.entries.some((entry) =>
        entry.outpoint.txid === input.txid &&
        entry.inscriptionId === input.inscriptionId);
      if (!outboundLinked && !inboundJournalLinked && !inboundCurrentLinked && !retainedLinked) {
        throw new RpcError('ERR_INVALID_PAYLOAD', 'activity inscription is not linked to transaction');
      }
    }
  }

  private galleryAuthorityFingerprint(
    account: unknown,
    statusAuthority: unknown,
    utxos: readonly WalletUtxo[],
    lockedOutpoints: ReadonlySet<string>,
    encryptedRecord: unknown,
  ): string {
    return JSON.stringify({
      account,
      statusAuthority,
      utxos,
      lockedOutpoints: [...lockedOutpoints].sort(),
      encryptedRecord,
    }, (_key, value: unknown) => typeof value === 'bigint' ? `bigint:${value}` : value);
  }

  async galleryList(input: GalleryListRequest): Promise<GalleryListResult> {
    // Initial metadata loads and explicit Refresh force the network. A targeted
    // lazy-paint request follows the initial answer by ~150 ms, so it may use
    // the same 10-second verified status snapshot instead of paying for a
    // redundant second TLS round trip. If that snapshot aged out, the ordinary
    // gatewayStatus path revalidates it anyway.
    const forceStatus = input.rasterFor === undefined || input.rasterFor.length === 0;
    const statusView = await this.gatewayStatus({ forceRefresh: forceStatus });
    if (
      statusView.lastReason !== null &&
      HARD_GATEWAY_VERIFICATION_FAILURES.has(statusView.lastReason)
    ) {
      throw new RpcError('ERR_DATA_STALE', 'signed gateway status is invalid');
    }
    const session = await this.runExclusive(() => this.requireSession(input));
    const rasterKey = input.rasterFor === undefined
      ? 'all'
      : JSON.stringify([...new Set(input.rasterFor)].sort());
    const key = `${session.vaultId}:${session.sessionId}:${input.accountId}:${rasterKey}`;
    const existing = this.galleryInflight.get(key);
    if (existing) return existing;
    const run = this.galleryListUncoalesced(input).finally(() => {
      if (this.galleryInflight.get(key) === run) this.galleryInflight.delete(key);
    });
    this.galleryInflight.set(key, run);
    return run;
  }

  private async galleryListUncoalesced(input: GalleryListRequest): Promise<GalleryListResult> {
    // Phase 1 snapshots encrypted local authority under the storage queue. The
    // callback returns only public wallet facts and encrypted-record metadata;
    // withSessionDek wipes its call-owned DEK before any remote request starts.
    const prepared = await this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const accountsMeta = await this.loadAccountsMetaLocked(dek, session.vaultId);
      const registered = accountsMeta.registeredPublicAccounts.find(
        (account) => account.accountId === input.accountId,
      );
      if (!registered) throw new RpcError('ERR_INVALID_PAYLOAD', 'account is not registered');
      const gateway = this.deps.gateway;
      const cached = gateway
        ? await loadCachedStatus(this.deps.session, gateway.endpoint, gateway.protocolVersions)
        : null;
      if (!gateway || !cached || !cached.status.capabilities.includes('preview_service')) {
        throw new RpcError('ERR_DATA_STALE', 'signed gallery service unavailable');
      }
      const utxos = (await this.loadAllUtxosLocked(dek, session.vaultId)).filter(
        (utxo) => utxo.accountId === input.accountId,
      );
      const lockedOutpoints = await this.loadLockedOutpointsLocked(dek, session.vaultId);
      const actionFor = (
        utxo: WalletUtxo,
        inscriptionId: string,
      ): GalleryListResult['items'][number]['action'] => {
        const kind = laneState(utxo) === 'protected_wrong_address' ? 'rescue' as const : 'send' as const;
        const blocked = (
          reason: Extract<GalleryListResult['items'][number]['action'], { status: 'blocked' }>['reason'],
        ): GalleryListResult['items'][number]['action'] => ({ status: 'blocked', kind, reason });
        // An incoming mempool inscription is an expected lifecycle state, even
        // though its asset classification deliberately remains degraded until
        // confirmation. Keep both gates intact, but present the condition the
        // user can act on (wait) before the generic stale-classification one.
        if (utxo.height === null) return blocked('unconfirmed');
        if (
          utxo.facts?.confidence !== 'authoritative' ||
          utxo.facts.classificationRevision !== cached.status.activeRevision
        ) return blocked('stale_classification');
        if (utxo.flags.userFrozen || utxo.flags.dustQuarantined) return blocked('frozen');
        if (lockedOutpoints.has(outpointKey(utxo.outpoint))) return blocked('locked_by_plan');
        if (utxo.facts.unsupportedAssetDetected) return blocked('unsupported_assets');
        if (utxo.facts.satRanges?.some((range) =>
          range.rarity !== undefined && range.rarity !== 'common')) return blocked('rare_sats');
        if (kind === 'rescue') {
          if (
            utxo.facts.primaryClass !== 'inscribed' ||
            utxo.facts.inscriptions.length !== 1
          ) return blocked('co_located');
          return { status: 'available', kind };
        }
        if (utxo.lane !== 'ordinals' ||
            (utxo.facts.primaryClass !== 'inscribed' && utxo.facts.primaryClass !== 'mixed')) {
          return blocked('unsafe_lane');
        }
        try {
          groupOrdinalInscriptions({
            txid: utxo.outpoint.txid,
            vout: utxo.outpoint.vout,
            valueSats: utxo.valueSats,
            targetInscriptionId: inscriptionId,
            inscriptions: utxo.facts.inscriptions,
          });
        } catch (error) {
          if (!(error instanceof OrdinalInscriptionGroupError)) throw error;
          return blocked(error.reason === 'co_located' ? 'co_located' : 'unverifiable_location');
        }
        return { status: 'available', kind };
      };
      const resolveOwnership = createOwnedAddressResolver(this.deps.network, 'stable');
      const ownershipFor = (utxo: WalletUtxo) => {
        try {
          return resolveOwnership(utxo);
        } catch {
          throw new RpcError('ERR_DATA_STALE', 'cached ownership script is not displayable');
        }
      };
      const allCurrent = utxos.flatMap((utxo) => {
        if (!utxo.facts) return [];
        const ownership = ownershipFor(utxo);
        return utxo.facts.inscriptions.map((inscription) => ({
          // Pending sat-flow inference already binds this number to the
          // inscription's confirmed source. It is safe display metadata, not
          // spend authority, and avoids calling a known inscription unnumbered
          // while its destination output waits for confirmation.
          number: inscription.number ?? null,
          identity: {
            inscriptionId: inscription.inscriptionId,
            satpoint: inscription.satpoint,
            outpoint: utxo.outpoint,
            classificationRevision: utxo.facts!.classificationRevision,
          },
          rareSats: (utxo.facts!.satRanges ?? [])
            .flatMap((range) => range.rarity && range.rarity !== 'common' ? [range.rarity] : []),
          ownership,
          utxo,
        }));
      }).sort((a, b) => a.identity.inscriptionId.localeCompare(b.identity.inscriptionId));
      if (new Set(allCurrent.map((item) => item.identity.inscriptionId)).size !== allCurrent.length) {
        throw new RpcError('ERR_DATA_STALE', 'duplicate inscription identity');
      }
      if (allCurrent.length > 4096) {
        throw new RpcError('ERR_DATA_STALE', 'gallery capacity exceeded');
      }
      const current = allCurrent.filter((item) =>
        item.utxo.facts?.confidence === 'authoritative' &&
        item.utxo.facts.classificationRevision === cached.status.activeRevision);
      const recoveredAddressCount = new Set(
        current
          .filter((item) => item.ownership.role === 'recovered')
          .map((item) => item.ownership.address),
      ).size;
      const previewable = current.filter((item) =>
        laneState(item.utxo) !== 'protected_wrong_address');

      const recordKey = this.cacheKey(session.vaultId, 'gallery', input.accountId);
      const existingRecord = await this.requireCache().get(recordKey);
      let record: GalleryRecord = { version: 2, items: [] };
      if (existingRecord) {
        try { record = openRecord(dek, existingRecord, galleryRecordSchema) as GalleryRecord; }
        catch { throw new RpcError('ERR_DATA_STALE', 'gallery cache is unreadable'); }
      }
      const byId = new Map(record.items.map((item) => [item.inscriptionId, item]));
      const currentIds = new Set(allCurrent.map((item) => item.identity.inscriptionId));
      // Only rasters the caller asked for are fetched. An inscription without
      // cached metadata is always fetched regardless, because its card would
      // otherwise have no number, MIME, or size to show. Ownership, satpoint,
      // confirmations, and action eligibility are all derived locally below,
      // so skipping a raster never weakens what gates Send/Rescue.
      const wanted = input.rasterFor === undefined ? null : new Set(input.rasterFor);
      // A targeted paint request may be satisfied by the DEK-sealed durable
      // cache after current ownership has been derived above. An unfiltered
      // request is an explicit Refresh and deliberately reaches the signed
      // gateway so renderer/policy changes eventually replace old paint.
      let durableCandidates: typeof previewable = [];
      if (wanted !== null) {
        durableCandidates = wanted.size > 0
          ? previewable.filter((item) => wanted.has(item.identity.inscriptionId))
          : previewable.toSorted((left, right) => {
              const leftVisible = byId.get(left.identity.inscriptionId)?.state !== 'hidden';
              const rightVisible = byId.get(right.identity.inscriptionId)?.state !== 'hidden';
              if (leftVisible !== rightVisible) return leftVisible ? -1 : 1;
              const confirmations = (item: typeof left): number => item.utxo.height === null
                ? 0
                : Math.max(0, cached.status.coreTip.height - item.utxo.height + 1);
              return confirmations(left) - confirmations(right) ||
                left.identity.inscriptionId.localeCompare(right.identity.inscriptionId);
            }).slice(0, GALLERY_DURABLE_PREVIEW_PAINT_AHEAD_ITEMS);
      }
      const durableWanted = durableCandidates.map((item) => item.identity);
      const durablePreviews = this.durableGalleryPreviews === null || durableWanted.length === 0
        ? new Map<string, InscriptionPreviewPayload>()
        : await this.durableGalleryPreviews.load(
            dek,
            session.vaultId,
            input.accountId,
            durableWanted,
          );
      const previewCurrent = wanted === null
        ? previewable
        : previewable.filter((item) =>
          (wanted.has(item.identity.inscriptionId) &&
            !durablePreviews.has(item.identity.inscriptionId)) ||
          byId.get(item.identity.inscriptionId)?.metadata === undefined ||
          // Records written before collection enrichment have complete core
          // metadata but no `display` field. Backfill every such record in the
          // same gallery response so collection grouping commits atomically
          // instead of changing as lazy raster batches enter the viewport.
          // `display: null` is deliberately different: enrichment was already
          // attempted against a legacy/unavailable gateway and must not turn
          // every warm gallery load into another full retry.
          byId.get(item.identity.inscriptionId)?.display === undefined);
      const skipped = wanted === null
        ? []
        : previewable.filter((item) => !previewCurrent.includes(item));
      return {
        registered,
        gateway,
        cached,
        utxos,
        lockedOutpoints,
        actionFor,
        allCurrent,
        current,
        recoveredAddressCount,
        recordKey,
        existingRecord,
        byId,
        currentIds,
        previewCurrent,
        skipped,
        durablePreviews,
        authorityFingerprint: this.galleryAuthorityFingerprint(
          registered,
          {
            activeRevision: cached.status.activeRevision,
            coreTip: cached.status.coreTip,
          },
          utxos,
          lockedOutpoints,
          existingRecord,
        ),
      };
    }));
    const {
      registered,
      gateway,
      cached,
      utxos,
      lockedOutpoints,
      actionFor,
      allCurrent,
      current,
      recoveredAddressCount,
      recordKey,
      byId,
      currentIds,
      previewCurrent,
      skipped,
      durablePreviews,
      authorityFingerprint,
    } = prepared;
    const now = this.deps.vaultDeps.now();
    const liveItems: GalleryListResult['items'] = [];
    let collectionCatalog: GalleryListResult['collectionCatalog'] = null;
    // Phase 2 is signed, bound network I/O with no storage queue or DEK held.
    /** Requested but unfetchable this round; rendered as placeholders. */
    const unresolvedPreview: typeof previewCurrent = [];
    /** Newly verified settled payloads committed to the encrypted L2 cache. */
    const durablePreviewWrites: DurableGalleryPreviewInput[] = [];
    let previewsUnavailable = false;
      if (previewCurrent.length > 0) {
        // Keep every batch within the signed raster budget so a large wallet
        // does not turn otherwise safe images into permanent budget
        // placeholders. The user pays only for batches requested on gallery
        // open/refresh; there is no background media polling.
        const galleryBatchSize = Math.min(
          INSCRIPTION_APPROVAL_MAX_ITEMS,
          INSCRIPTION_APPROVAL_MAX_RASTERS,
        );
        /**
         * Keyed rather than positional. A wallet past one batch used to depend
         * on every batch succeeding *and* on the concatenated response staying
         * index-aligned with the request; one 503 killed the whole gallery.
         * `verifyGalleryBatchBinding` already proves per-batch identity and
         * length, so keying by inscription id is equally strict and lets a
         * failed batch degrade to placeholders instead of taking the rest down.
         */
        type GalleryResponseItem =
          InscriptionGalleryBatchResponse['items'][number] & {
            display?: InscriptionDisplayMetadata;
          };
        const byResponseId = new Map<string, GalleryResponseItem>();
        let galleryProtocol: 'unknown' | 'enriched' | 'legacy' = 'unknown';
        for (let offset = 0; offset < previewCurrent.length; offset += galleryBatchSize) {
          const identities = previewCurrent
            .slice(offset, offset + galleryBatchSize)
            .map((item) => item.identity);
          const request = {
            network: this.deps.network,
            inscriptions: identities,
          };
          let result: Awaited<ReturnType<typeof gateway.fetchInscriptionGalleryBatch>> |
            { ok: true; value: InscriptionGalleryEnrichedBatchResponse; verifiedAtMs: number };
          const enriched = galleryProtocol === 'legacy'
            ? null
            : await gateway.fetchInscriptionGalleryEnrichedBatch(request);
          if (enriched?.ok) {
            galleryProtocol = 'enriched';
            result = enriched;
            if (collectionCatalog !== null &&
                JSON.stringify(collectionCatalog) !== JSON.stringify(enriched.value.collectionCatalog)) {
              throw new RpcError('ERR_DATA_STALE', 'collection catalog changed within gallery response');
            }
            collectionCatalog = enriched.value.collectionCatalog;
          } else {
            const compatibilityFailure =
              enriched === null ||
              (enriched.reason === 'http' && enriched.httpStatus === 404) ||
              enriched.reason === 'network_error' ||
              enriched.reason === 'timeout' ||
              enriched.reason === 'response_too_large' ||
              enriched.reason === 'rate_limited';
            if (!compatibilityFailure) {
              throw new RpcError('ERR_DATA_STALE', 'signed gallery enrichment is invalid');
            }
            if (galleryProtocol === 'enriched') {
              throw new RpcError('ERR_DATA_STALE', 'gallery enrichment changed within response');
            }
            galleryProtocol = 'legacy';
            result = await gateway.fetchInscriptionGalleryBatch(request);
          }
          // A transport failure is transient — the gateway shedding load must
          // not empty a gallery whose action eligibility is derived locally.
          if (!result.ok) {
            const transient = result.reason === 'http' ||
              result.reason === 'network_error' ||
              result.reason === 'timeout' ||
              result.reason === 'response_too_large' ||
              result.reason === 'rate_limited';
            if (!transient) {
              throw new RpcError('ERR_DATA_STALE', 'signed gallery response is invalid');
            }
            previewsUnavailable = true;
            continue;
          }
          // A revision mismatch is NOT transient: the gateway has moved to a
          // classification we have not verified against, so this still fails
          // closed and the caller re-synchronizes.
          if (result.value.classificationRevision !== cached.status.activeRevision) {
            throw new RpcError('ERR_DATA_STALE', 'signed gallery response unavailable');
          }
          for (const responseItem of result.value.items) {
            byResponseId.set(responseItem.metadata.inscriptionId, responseItem);
          }
        }
        for (const expected of previewCurrent) {
          const responseItem = byResponseId.get(expected.identity.inscriptionId);
          if (!responseItem) {
            // Cosmetic degradation only. Identity, confirmations, and action
            // below come from the same local facts the skipped path uses.
            previewsUnavailable = true;
            unresolvedPreview.push(expected);
            continue;
          }
          const prior = byId.get(responseItem.metadata.inscriptionId);
          const state = prior?.state === 'hidden' ? 'hidden' : 'visible';
          const display = responseItem.display ??
            prior?.display?.metadata ??
            { title: null, collections: [] };
          const metadata = {
            number: responseItem.metadata.number,
            contentType: responseItem.metadata.contentType,
            contentLength: responseItem.metadata.contentLength,
            satpoint: responseItem.metadata.satpoint,
            outpoint: responseItem.metadata.outpoint,
            confirmations: responseItem.metadata.confirmations,
            parent: responseItem.metadata.parent,
            delegate: responseItem.metadata.delegate,
            reinscription: responseItem.metadata.reinscription,
            cursed: responseItem.metadata.cursed,
            classificationRevision: responseItem.metadata.classificationRevision,
          };
          byId.set(responseItem.metadata.inscriptionId, {
            inscriptionId: responseItem.metadata.inscriptionId,
            account: registered.account,
            state,
            firstSeenAt: prior?.firstSeenAt ?? now,
            lastSeenAt: now,
            metadata,
            display: responseItem.display === undefined
              ? prior?.display ?? null
              : {
                  catalogRevision: collectionCatalog!.revision,
                  metadata: responseItem.display,
                },
          });
          const preview = uiPreviewFromPayload(responseItem.preview);
          durablePreviewWrites.push({
            inscriptionId: responseItem.metadata.inscriptionId,
            satpoint: responseItem.metadata.satpoint,
            outpoint: { ...responseItem.metadata.outpoint },
            classificationRevision: responseItem.metadata.classificationRevision,
            preview: responseItem.preview,
          });
          const mediaAvailable = openableMediaType(responseItem.metadata.contentType);
          liveItems.push({
            inscriptionId: responseItem.metadata.inscriptionId,
            state,
            ...metadata,
            rareSats: expected.rareSats,
            display,
            ownership: expected.ownership,
            preview,
            mediaAvailable,
            action: actionFor(expected.utxo, responseItem.metadata.inscriptionId),
          });
        }
      }
      // Rasters the caller did not ask for, plus any the gateway could not
      // serve this round. Everything that gates an action is recomputed from
      // local authoritative UTXO facts and the verified core tip; only cosmetic
      // descriptors come from the encrypted record. The two carry different
      // placeholder reasons so the surface lazily re-requests the first and
      // leaves the second to an explicit Refresh.
      const placeholderItems = [
        ...skipped.map((item) => ({ item, reason: 'not_requested' })),
        ...unresolvedPreview.map((item) => ({ item, reason: GALLERY_PREVIEW_UNAVAILABLE })),
      ];
      for (const { item, reason: placeholderReason } of placeholderItems) {
        const prior = byId.get(item.identity.inscriptionId);
        const durablePreview = durablePreviews.get(item.identity.inscriptionId);
        const state = prior?.state === 'hidden' ? 'hidden' : 'visible';
        const priorMetadata = prior?.metadata;
        const display = prior?.display?.metadata ?? { title: null, collections: [] };
        const metadata = {
          number: priorMetadata?.number ?? null,
          contentType: priorMetadata?.contentType ?? null,
          contentLength: priorMetadata?.contentLength ?? null,
          satpoint: item.identity.satpoint,
          outpoint: { ...item.identity.outpoint },
          confirmations: item.utxo.height === null
            ? 0
            : Math.max(0, cached.status.coreTip.height - item.utxo.height + 1),
          parent: priorMetadata?.parent ?? null,
          delegate: priorMetadata?.delegate ?? null,
          reinscription: priorMetadata?.reinscription ?? false,
          cursed: priorMetadata?.cursed ?? false,
          classificationRevision: item.identity.classificationRevision,
        };
        byId.set(item.identity.inscriptionId, {
          inscriptionId: item.identity.inscriptionId,
          account: registered.account,
          state,
          firstSeenAt: prior?.firstSeenAt ?? now,
          lastSeenAt: now,
          metadata,
          display: prior?.display ?? null,
        });
        liveItems.push({
          inscriptionId: item.identity.inscriptionId,
          state,
          ...metadata,
          rareSats: item.rareSats,
          display,
          ownership: item.ownership,
          preview: durablePreview === undefined
            ? { kind: 'placeholder', reason: placeholderReason }
            : uiPreviewFromPayload(durablePreview),
          // Derived from the cached content type, not hardcoded false. A
          // surface painting this item from its own cache never re-requests
          // the raster, so a false here would strand the viewer affordance
          // until something else forced a fetch. gallery.media.open is the
          // real gate and re-derives everything anyway.
          mediaAvailable: openableMediaType(metadata.contentType),
          action: actionFor(item.utxo, item.identity.inscriptionId),
        });
      }
      for (const stale of allCurrent.filter((item) => !current.includes(item))) {
        const prior = byId.get(stale.identity.inscriptionId);
        const state = prior?.state === 'hidden' ? 'hidden' : 'visible';
        const priorMetadata = prior?.metadata;
        const display = prior?.display?.metadata ?? { title: null, collections: [] };
        const metadata = {
          number: priorMetadata?.number ?? stale.number,
          contentType: priorMetadata?.contentType ?? null,
          contentLength: priorMetadata?.contentLength ?? null,
          satpoint: stale.identity.satpoint,
          outpoint: { ...stale.identity.outpoint },
          confirmations: stale.utxo.height === null
            ? 0
            : Math.max(0, cached.status.coreTip.height - stale.utxo.height + 1),
          parent: priorMetadata?.parent ?? null,
          delegate: priorMetadata?.delegate ?? null,
          reinscription: priorMetadata?.reinscription ?? false,
          cursed: priorMetadata?.cursed ?? false,
          classificationRevision: stale.identity.classificationRevision,
        };
        byId.set(stale.identity.inscriptionId, {
          inscriptionId: stale.identity.inscriptionId,
          account: registered.account,
          state,
          firstSeenAt: prior?.firstSeenAt ?? now,
          lastSeenAt: now,
          metadata,
          display: prior?.display ?? null,
        });
        liveItems.push({
          inscriptionId: stale.identity.inscriptionId,
          state,
          ...metadata,
          rareSats: stale.rareSats,
          display,
          ownership: stale.ownership,
          preview: { kind: 'placeholder', reason: 'stale_classification' },
          mediaAvailable: false,
          action: actionFor(stale.utxo, stale.identity.inscriptionId),
        });
      }

      // Phase 3 reacquires the exact session and rejects any account, UTXO,
      // locked-plan, classification, or encrypted-gallery change before commit.
      return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
        const commitAccounts = await this.loadAccountsMetaLocked(dek, session.vaultId);
        const commitAccount = commitAccounts.registeredPublicAccounts.find(
          (account) => account.accountId === input.accountId,
        );
        const commitGateway = this.deps.gateway;
        const commitStatus = commitGateway
          ? await loadCachedStatus(
            this.deps.session,
            commitGateway.endpoint,
            commitGateway.protocolVersions,
          )
          : null;
        const commitUtxos = (await this.loadAllUtxosLocked(dek, session.vaultId)).filter(
          (utxo) => utxo.accountId === input.accountId,
        );
        const commitLockedOutpoints = await this.loadLockedOutpointsLocked(dek, session.vaultId);
        const commitRecord = await this.requireCache().get(recordKey);
        if (
          commitAccount === undefined ||
          commitStatus === null ||
          this.galleryAuthorityFingerprint(
            commitAccount,
            {
              activeRevision: commitStatus.status.activeRevision,
              coreTip: commitStatus.status.coreTip,
            },
            commitUtxos,
            commitLockedOutpoints,
            commitRecord,
          ) !== authorityFingerprint
        ) {
          throw new RpcError('ERR_DATA_STALE', 'gallery authority changed while loading previews');
        }

      const retainedItems = [...byId.values()]
        .filter((item) => item.account !== registered.account || currentIds.has(item.inscriptionId))
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.inscriptionId.localeCompare(b.inscriptionId))
        .slice(0, 4096)
        .sort((a, b) => a.inscriptionId.localeCompare(b.inscriptionId));
      const nextRecord: GalleryRecord = {
        version: 2,
        items: retainedItems,
      };
      await this.requireCache().put(sealRecord(
        dek, nextRecord, recordKey, this.deps.vaultDeps.random(24), now,
      ));
      if (this.durableGalleryPreviews !== null && durablePreviewWrites.length > 0) {
        try {
          await this.durableGalleryPreviews.merge(
            dek,
            session.vaultId,
            input.accountId,
            durablePreviewWrites,
          );
        } catch {
          // Paint persistence is optional. A quota/IDB failure must not turn a
          // fully verified gallery into an error or weaken the fresh result.
        }
      }
      const attentionItems: GalleryListResult['attentionItems'] = allCurrent
        .filter((item) => laneState(item.utxo) === 'protected_wrong_address')
        .map((item) => ({
          inscriptionId: item.identity.inscriptionId,
          outpoint: { ...item.identity.outpoint },
          action: actionFor(item.utxo, item.identity.inscriptionId),
        }))
        .sort((a, b) => a.inscriptionId.localeCompare(b.inscriptionId));
      const sweepCandidates: GalleryListResult['sweepCandidates'] = utxos
        .filter((utxo) =>
          laneState(utxo) === 'reserved_ordinal_lane_btc')
        .map((utxo) => {
          let reason: GalleryListResult['sweepCandidates'][number]['reason'] = null;
          if (utxo.height === null) reason = 'unconfirmed';
          else if (
            utxo.facts?.confidence !== 'authoritative' ||
            utxo.facts.classificationRevision !== cached.status.activeRevision
          ) reason = 'stale_classification';
          else if (utxo.flags.userFrozen || utxo.flags.dustQuarantined) reason = 'frozen';
          else if (lockedOutpoints.has(outpointKey(utxo.outpoint))) reason = 'locked_by_plan';
          else {
            const minimumPaymentScript = `0014${'00'.repeat(20)}`;
            const minimumFeeRate = 1_000n;
            const minimumFee = feeForVsize(
              estimateVsize(
                [utxo.scriptPubKey],
                [utxo.scriptPubKey, minimumPaymentScript],
              ),
              minimumFeeRate,
            );
            if (
              utxo.valueSats - DEFAULT_POSTAGE_SATS - minimumFee <=
              economicChangeThreshold(minimumPaymentScript, minimumFeeRate)
            ) reason = 'no_economic_excess';
          }
          return {
            accountId: input.accountId,
            account: utxo.account,
            outpoint: { ...utxo.outpoint },
            valueSats: utxo.valueSats.toString(),
            status: reason === null ? 'available' as const : 'blocked' as const,
            reason,
          };
        })
        .sort((a, b) =>
          `${a.outpoint.txid}:${a.outpoint.vout}`.localeCompare(`${b.outpoint.txid}:${b.outpoint.vout}`));
      const items = liveItems.sort((a, b) =>
        a.inscriptionId.localeCompare(b.inscriptionId));
      // Strictly after touchSessionLocked above: chrome.storage.session is one
      // shared quota, and a cosmetic write must never be able to cost the
      // session record its slot. saveCachedGallery never throws.
      await this.saveGalleryPaintCache(session, input.accountId, items, now);
      return {
        accountId: input.accountId,
        items,
        collectionCatalog,
        attentionItems,
        sweepCandidates,
        previewsUnavailable,
        recoveredAddressCount,
        refreshedAt: now,
      };
      }));
  }

  /**
   * Paint-ahead projection under freshly revalidated wallet authority. Drops
   * `action` and `mediaAvailable` entirely. The settled preview may have been
   * verified in this response or restored from the exact DEK-sealed L2 record;
   * a placeholder is never cached on either tier.
   */
  private async saveGalleryPaintCache(
    session: UnlockSession,
    accountId: string,
    items: GalleryListResult['items'],
    now: number,
  ): Promise<void> {
    const projected: GalleryCachedItem[] = items.map((item) => ({
      inscriptionId: item.inscriptionId,
      state: item.state,
      number: item.number,
      contentType: item.contentType,
      contentLength: item.contentLength,
      satpoint: item.satpoint,
      outpoint: { ...item.outpoint },
      confirmations: item.confirmations,
      parent: item.parent,
      delegate: item.delegate,
      reinscription: item.reinscription,
      cursed: item.cursed,
      classificationRevision: item.classificationRevision,
      rareSats: [...item.rareSats],
      display: item.display,
      // Placeholders are never cached, on any surface; the settled kinds —
      // rasters, text excerpts, media badges — all paint ahead.
      ...(item.preview.kind === 'placeholder' ? {} : { preview: { ...item.preview } }),
    }));
    const binding = {
      vaultId: session.vaultId,
      sessionId: session.sessionId,
      network: this.deps.network,
      accountId,
    };
    // Raster bytes are the whole weight of the projection and are already
    // content-addressed, so the signature carries pngSha256 instead — same
    // discrimination, without holding several MiB of base64 in worker memory
    // for the life of the session.
    const signature = JSON.stringify({
      binding,
      items: projected.map(({ preview, confirmations, ...rest }) => ({
        ...rest,
        confirmations: Math.min(confirmations, 6),
        preview: preview === undefined
          ? null
          : preview.kind === 'raster' ? preview.pngSha256 : preview,
      })),
    });
    if (signature === this.lastCachedGalleryPayload) return;
    // Committed only on a successful write: a swallowed quota rejection must
    // not make the next identical batch skip the retry that would fix it.
    if (await saveCachedGallery(this.deps.session, binding, projected, now)) {
      this.lastCachedGalleryPayload = signature;
    }
  }

  /**
   * Read the paint-ahead cache.
   *
   * Deliberately outside `runExclusive` and without a DEK: the whole point is
   * to paint before the signed batch lands, and queueing behind that batch —
   * which holds the exclusive lock for its entire multi-round-trip life — would
   * make the answer arrive strictly after the thing it exists to precede. It
   * touches only session-memory state, so there is nothing for the queue to
   * serialize and nothing to decrypt.
   *
   * The UI's store epoch and request-generation guards are load-bearing: a
   * lock can clear this slot after requireSession returns but before the read
   * resolves, and those guards prevent that stale paint from committing.
   */
  async galleryCached(input: GalleryCachedRequest): Promise<GalleryCachedResult> {
    const session = await this.peekExpectedSession(input);
    const cached = await loadCachedGallery(this.deps.session, {
      vaultId: session.vaultId,
      sessionId: session.sessionId,
      network: this.deps.network,
      accountId: input.accountId,
    });
    if (cached === null) return { accountId: input.accountId, hit: false };
    return { accountId: input.accountId, hit: true, items: cached.items, cachedAt: cached.cachedAt };
  }

  /**
   * Fast Home paint from the exact-session L1 cache, revalidated entirely
   * against current local wallet state. This intentionally performs no
   * gateway request: the live gallery load still runs concurrently and owns
   * every action, media, ownership, and approval decision.
   */
  async galleryHomeCached(input: GalleryCachedRequest): Promise<GalleryCachedResult> {
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const accounts = await this.loadAccountsMetaLocked(dek, session.vaultId);
      const registered = accounts.registeredPublicAccounts.find(
        (account) => account.accountId === input.accountId,
      );
      if (registered === undefined) {
        throw new RpcError('ERR_INVALID_PAYLOAD', 'account is not registered');
      }
      const cached = await loadCachedGallery(this.deps.session, {
        vaultId: session.vaultId,
        sessionId: session.sessionId,
        network: this.deps.network,
        accountId: input.accountId,
      });
      if (cached === null) return { accountId: input.accountId, hit: false };

      const recordKey = this.cacheKey(session.vaultId, 'gallery', input.accountId);
      const encryptedRecord = await this.requireCache().get(recordKey);
      if (encryptedRecord === undefined) return { accountId: input.accountId, hit: false };
      let record: GalleryRecord;
      try {
        record = openRecord(dek, encryptedRecord, galleryRecordSchema) as GalleryRecord;
      } catch {
        throw new RpcError('ERR_DATA_STALE', 'gallery cache is unreadable');
      }

      const recordById = new Map(record.items.map((item) => [item.inscriptionId, item]));
      const cachedById = new Map(cached.items.map((item) => [item.inscriptionId, item]));
      const items: GalleryCachedItem[] = [];
      const utxos = (await this.loadAllUtxosLocked(dek, session.vaultId)).filter(
        (utxo) => utxo.accountId === input.accountId,
      );
      for (const utxo of utxos) {
        const facts = utxo.facts;
        if (facts?.confidence !== 'authoritative') continue;
        for (const inscription of facts.inscriptions) {
          const cachedItem = cachedById.get(inscription.inscriptionId);
          const stored = recordById.get(inscription.inscriptionId);
          if (
            cachedItem?.preview === undefined ||
            stored === undefined ||
            stored.metadata === null ||
            stored.account !== registered.account ||
            cachedItem.satpoint !== inscription.satpoint ||
            cachedItem.outpoint.txid !== utxo.outpoint.txid ||
            cachedItem.outpoint.vout !== utxo.outpoint.vout ||
            cachedItem.classificationRevision !== facts.classificationRevision ||
            stored.metadata.satpoint !== inscription.satpoint ||
            stored.metadata.outpoint.txid !== utxo.outpoint.txid ||
            stored.metadata.outpoint.vout !== utxo.outpoint.vout ||
            stored.metadata.classificationRevision !== facts.classificationRevision
          ) continue;
          items.push({ ...cachedItem, state: stored.state });
        }
      }
      return items.length === 0
        ? { accountId: input.accountId, hit: false }
        : { accountId: input.accountId, hit: true, items, cachedAt: cached.cachedAt };
    }));
  }

  async galleryUpdate(input: GalleryUpdateRequest): Promise<{ updated: true }> {
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const key = this.cacheKey(session.vaultId, 'gallery', input.accountId);
      const encrypted = await this.requireCache().get(key);
      if (!encrypted) throw new RpcError('ERR_INVALID_PAYLOAD', 'gallery item not found');
      let record: GalleryRecord;
      try { record = openRecord(dek, encrypted, galleryRecordSchema) as GalleryRecord; }
      catch { throw new RpcError('ERR_DATA_STALE', 'gallery cache is unreadable'); }
      const item = record.items.find((candidate) => candidate.inscriptionId === input.inscriptionId);
      if (!item) throw new RpcError('ERR_INVALID_PAYLOAD', 'gallery item not found');
      item.state = input.state;
      await this.requireCache().put(sealRecord(
        dek, record, key, this.deps.vaultDeps.random(24), this.deps.vaultDeps.now(),
      ));
      await this.touchSessionLocked(session);
      return { updated: true };
    }));
  }

  async galleryMediaOpen(input: GalleryMediaOpenRequest): Promise<
    | { disposition: 'unavailable'; reason: string; inscriptionId: string }
    | { disposition: 'media'; leaseId: string; expiresAt: number; inscriptionId: string;
        contentType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' |
          'audio/mpeg' | 'audio/ogg' | 'audio/wav' |
          'video/mp4' | 'video/webm' | 'text/plain' | 'application/json';
        contentSha256: string; contentByteLength: number; bytesBase64: string }
  > {
    const statusView = await this.gatewayStatus({ forceRefresh: true });
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      this.sweepGalleryMediaLeases(this.deps.vaultDeps.now());
      const gateway = this.deps.gateway;
      const cached = gateway
        ? await loadCachedStatus(this.deps.session, gateway.endpoint, gateway.protocolVersions)
        : null;
      if (
        statusView.lastReason !== null &&
        HARD_GATEWAY_VERIFICATION_FAILURES.has(statusView.lastReason)
      ) {
        return {
          disposition: 'unavailable' as const,
          reason: 'verification_failed',
          inscriptionId: input.inscriptionId,
        };
      }
      if (statusView.lastReason !== null) {
        throw new RpcError('ERR_GATEWAY_UNAVAILABLE', 'signed media service is temporarily unavailable');
      }
      if (!gateway || !cached || !cached.status.capabilities.includes('preview_service')) {
        throw new RpcError('ERR_GATEWAY_UNAVAILABLE', 'signed media service unavailable');
      }
      const utxos = (await this.loadAllUtxosLocked(dek, session.vaultId)).filter(
        (utxo) => utxo.accountId === input.accountId,
      );
      const candidates = utxos.flatMap((utxo) => {
        if (!utxo.facts || utxo.facts.confidence !== 'authoritative') return [];
        return utxo.facts.inscriptions
          .filter((item) => item.inscriptionId === input.inscriptionId)
          .map((item) => ({
            inscriptionId: item.inscriptionId,
            satpoint: item.satpoint,
            outpoint: utxo.outpoint,
            classificationRevision: utxo.facts!.classificationRevision,
          }));
      });
      if (
        candidates.length === 1 &&
        candidates[0]!.classificationRevision !== cached.status.activeRevision
      ) {
        throw new RpcError('ERR_DATA_STALE', 'inscription classification revision is stale');
      }
      if (candidates.length !== 1) {
        return {
          disposition: 'unavailable' as const,
          reason: 'unsafe_identity',
          inscriptionId: input.inscriptionId,
        };
      }
      await this.touchSessionLocked(session);
      const result = await gateway.fetchInscriptionMedia({
        network: this.deps.network,
        identity: candidates[0]!,
      });
      if (!result.ok) {
        if (HARD_GATEWAY_VERIFICATION_FAILURES.has(result.reason)) {
          return {
            disposition: 'unavailable' as const,
            reason: 'verification_failed',
            inscriptionId: input.inscriptionId,
          };
        }
        throw new RpcError('ERR_GATEWAY_UNAVAILABLE', 'signed inscription media unavailable');
      }
      if (result.value.media.disposition === 'unavailable') {
        return { disposition: 'unavailable' as const, reason: result.value.media.reason, inscriptionId: input.inscriptionId };
      }
      const leaseId = bytesToHex(this.deps.vaultDeps.random(16));
      const expiresAt = this.deps.vaultDeps.now() + GALLERY_MEDIA_LEASE_TTL_MS;
      this.galleryMediaLeases.set(leaseId, {
        vaultId: session.vaultId,
        sessionId: session.sessionId,
        inscriptionId: input.inscriptionId,
        expiresAt,
      });
      return {
        disposition: 'media' as const,
        leaseId,
        expiresAt,
        inscriptionId: input.inscriptionId,
        contentType: result.value.media.detectedMime,
        contentSha256: result.value.media.contentSha256,
        contentByteLength: result.value.media.contentByteLength,
        bytesBase64: result.value.media.bytesBase64,
      };
    }));
  }

  async galleryMediaLease(input: GalleryMediaLeaseRequest): Promise<{
    valid: boolean;
    expiresAt: number | null;
  }> {
    return this.runExclusive(async () => {
      const session = await this.requireSession(input);
      const now = this.deps.vaultDeps.now();
      this.sweepGalleryMediaLeases(now);
      const lease = this.galleryMediaLeases.get(input.leaseId);
      if (!lease || lease.vaultId !== session.vaultId || lease.sessionId !== session.sessionId ||
          lease.expiresAt <= now) {
        this.galleryMediaLeases.delete(input.leaseId);
        return { valid: false, expiresAt: null };
      }
      lease.expiresAt = now + GALLERY_MEDIA_LEASE_TTL_MS;
      return { valid: true, expiresAt: lease.expiresAt };
    });
  }

  /**
   * §14.4 user freeze: flips the local flag only — asset facts are never
   * touched — and only on clean UTXOs (protected status is stronger and
   * cannot be user-managed).
   */
  async setUtxoFrozen(input: UtxoSetFrozenRequest): Promise<{ updated: boolean }> {
    return this.runExclusive(() =>
      this.withSessionDek(input, async (dek, session) => {
        const cache = this.requireCache();
        const keys = await cache.listKeys(session.vaultId, this.deps.network, 'utxos');
        // An outpoint can live in more than one record (standard + coinciding
        // Xverse legacy unit) — update every copy so they never disagree.
        let updated = false;
        for (const key of keys) {
          const cacheKey: WalletCacheKey = {
            vaultId: session.vaultId,
            network: this.deps.network,
            type: 'utxos',
            key,
          };
          const record = await cache.get(cacheKey);
          if (!record) continue;
          const opened = storedUtxosSchema.parse(openRecord(dek, record, storedUtxosSchema));
          const meta = await this.loadAccountsMetaLocked(dek, session.vaultId);
          const standardIds = new Map(meta.registeredPublicAccounts
            .filter((account) => account.source === 'standard')
            .map((account) => [account.account, account.accountId] as const));
          const utxos = migrateLegacyStoredUtxos(
            opened, (utxo) => standardIds.get(utxo.account) ?? null,
          );
          const found = utxos.find(
            (u) => u.accountId === input.accountId &&
              u.outpoint.txid === input.txid && u.outpoint.vout === input.vout,
          );
          if (!found) continue;
          if (found.facts?.primaryClass !== 'cardinal_clean') {
            throw new RpcError('ERR_INVALID_PAYLOAD', 'only clean UTXOs can be user-frozen');
          }
          found.flags.userFrozen = input.frozen;
          await cache.put(
            sealRecord(dek, utxos, cacheKey, this.deps.vaultDeps.random(24), this.deps.vaultDeps.now()),
          );
          updated = true;
        }
        await this.touchSessionLocked(session);
        if (updated) this.notifyWalletDataChanged('utxo');
        return { updated };
      }),
    );
  }

  private labelsCacheKey(vaultId: string, accountId: string): WalletCacheKey {
    return this.cacheKey(vaultId, 'labels', accountId);
  }

  private addressBookCacheKey(vaultId: string): WalletCacheKey {
    return this.cacheKey(vaultId, 'addressBook', 'all');
  }

  private async loadAddressBookLocked(
    dek: Uint8Array,
    vaultId: string,
  ): Promise<AddressBookV1> {
    const record = await this.requireCache().get(this.addressBookCacheKey(vaultId));
    if (!record) return emptyAddressBook(this.deps.network);
    return openRecord(dek, record, addressBookSchema);
  }

  private async saveAddressBookLocked(
    dek: Uint8Array,
    vaultId: string,
    book: AddressBookV1,
  ): Promise<void> {
    await this.requireCache().put(sealRecord(
      dek,
      addressBookSchema.parse(book),
      this.addressBookCacheKey(vaultId),
      this.deps.vaultDeps.random(24),
      this.deps.vaultDeps.now(),
    ));
  }

  private async mutateAddressBook(
    input: ActiveSessionRequest,
    mutate: (book: AddressBookV1) => AddressBookV1,
  ): Promise<AddressBookV1> {
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      let next: AddressBookV1;
      try {
        next = mutate(await this.loadAddressBookLocked(dek, session.vaultId));
      } catch (error) {
        if (error instanceof AddressBookError) {
          throw new RpcError('ERR_INVALID_PAYLOAD', error.message);
        }
        throw error;
      }
      await this.saveAddressBookLocked(dek, session.vaultId, next);
      await this.touchSessionLocked(session);
      return next;
    }));
  }

  /**
   * An unreadable record degrades to no labels rather than failing closed.
   * Labels are pure §14.4 annotation: they grant no §11.2 relief and only
   * tie-break under waste in `selectCoins`, so treating corruption as fatal
   * would let an advisory record block ordinary sends and the UTXO manager —
   * and `setUtxoLabel` reads through here too, so there would be no way back.
   * Because that write seals a whole fresh record, the next label edit repairs
   * the corruption on its own.
   */
  private async loadLabelsLocked(
    dek: Uint8Array,
    vaultId: string,
    accountId: string,
  ): Promise<LabelsRecord> {
    const record = await this.requireCache().get(this.labelsCacheKey(vaultId, accountId)) ??
      await this.requireCache().get(this.cacheKey(vaultId, 'labels', 'all'));
    if (!record) return { version: 1, entries: [] };
    try {
      return openRecord(dek, record, labelsRecordSchema) as LabelsRecord;
    } catch {
      return { version: 1, entries: [] };
    }
  }

  /** labelGroupKey per outpoint key, spent outpoints included (§14.1, §14.4). */
  private async labelGroupsLocked(
    dek: Uint8Array,
    vaultId: string,
    accountId: string,
  ): Promise<Map<string, string>> {
    const record = await this.loadLabelsLocked(dek, vaultId, accountId);
    return new Map(
      record.entries.map((entry) => [outpointKey(entry.outpoint), labelGroupKey(entry.label)]),
    );
  }

  /**
   * §14.4 "Local label or cluster".
   *
   * Unlike a §14.4 freeze this is pure annotation: it applies to any UTXO
   * including protected ones, and grants no §11.2 relief whatsoever. Labels are
   * local-only — §22.1 forbids them in server logs and nothing here sends them
   * anywhere. A null label clears the entry.
   */
  async setUtxoLabel(input: UtxoSetLabelRequest): Promise<{ updated: boolean }> {
    return this.runExclusive(() =>
      this.withSessionDek(input, async (dek, session) => {
        const owned = (await this.loadAllUtxosLocked(dek, session.vaultId)).some(
          (utxo) => utxo.accountId === input.accountId &&
            utxo.outpoint.txid === input.txid && utxo.outpoint.vout === input.vout,
        );
        if (!owned) throw new RpcError('ERR_INVALID_PAYLOAD', 'UTXO does not belong to account');
        const record = await this.loadLabelsLocked(dek, session.vaultId, input.accountId);
        const target = outpointKey({ txid: input.txid, vout: input.vout });
        const entries = record.entries.filter(
          (entry) => outpointKey(entry.outpoint) !== target,
        );
        const removed = entries.length !== record.entries.length;
        if (input.label !== null) {
          entries.push({
            outpoint: { txid: input.txid, vout: input.vout },
            label: input.label,
            updatedAt: this.deps.vaultDeps.now(),
          });
        }
        // Entries stay in update order (remove-then-append), so trimming from
        // the front evicts the least recently touched. Labels for spent
        // outpoints are retained until eviction so a change output can still
        // report the labels of the inputs that funded it.
        const bounded = entries.length > UTXO_LABEL_MAX_ENTRIES
          ? entries.slice(entries.length - UTXO_LABEL_MAX_ENTRIES)
          : entries;
        await this.requireCache().put(sealRecord(
          dek,
          { version: 1, entries: bounded } satisfies LabelsRecord,
          this.labelsCacheKey(session.vaultId, input.accountId),
          this.deps.vaultDeps.random(24),
          this.deps.vaultDeps.now(),
        ));
        await this.touchSessionLocked(session);
        const updated = removed || input.label !== null;
        if (updated) this.notifyWalletDataChanged('utxo');
        return { updated };
      }),
    );
  }

  // ---- M7: transaction planning, signing, broadcast -----------------------

  async feeQuote(input: FeeQuoteRequest) {
    await this.runExclusive(async () => { await this.requireSession(input); });
    const gateway = this.deps.gateway;
    if (!gateway) throw new RpcError('ERR_FEE_QUOTE_INVALID', 'gateway unavailable');
    const result = await gateway.fetchFees();
    if (!result.ok) throw new RpcError('ERR_FEE_QUOTE_INVALID', 'fee estimator unavailable');
    try {
      validateAutomaticQuote(result.value, this.deps.vaultDeps.now());
    } catch {
      throw new RpcError('ERR_FEE_QUOTE_INVALID', 'unsafe fee quote');
    }
    await this.runExclusive(async () => { await this.requireSession(input); });
    const quote = result.value;
    const economy = quoteTier(quote, 12);
    const standard = quoteTier(quote, 6);
    const priority = quoteTier(quote, 2);
    return {
      prioritySatPerKvB: priority.effectiveSatPerKvB,
      standardSatPerKvB: standard.effectiveSatPerKvB,
      economySatPerKvB: economy.effectiveSatPerKvB,
      floorSatPerKvB: quote.floorSatPerKvB,
      sampledAt: quote.sampledAt,
      expiresAt: quote.expiresAt,
    };
  }

  async listUtxos(input: UtxoListRequest) {
    // Primes the verified status cache that eligibilityContextLocked reads; the
    // view itself is not needed here. Without it a cold cache makes freshness
    // all-false and every UTXO reads as ineligible.
    await this.gatewayStatus({});
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const utxos = (await this.loadAllUtxosLocked(dek, session.vaultId)).filter(
        (utxo) => utxo.accountId === input.accountId,
      );
      const feeRateSatPerKvB = BigInt(input.feeRateSatPerKvB);
      const ctx = await this.eligibilityContextLocked(dek, session.vaultId, feeRateSatPerKvB);
      const labels = await this.loadLabelsLocked(dek, session.vaultId, input.accountId);
      const labelByOutpoint = new Map(
        labels.entries.map((entry) => [outpointKey(entry.outpoint), entry.label]),
      );
      const rows = utxos.map((utxo) => {
        const evaluated = evaluateEligibility(utxo, ctx);
        const marginal = feeForVsize(inputVbytes(utxo.scriptPubKey), feeRateSatPerKvB);
        const effective = utxo.valueSats > marginal ? utxo.valueSats - marginal : 0n;
        // §12.2 keeps the ordinals lane out of ordinary funding even when the
        // §11.2 predicate itself passes. Without an explicit reason the row
        // would render ineligible with nothing to explain it.
        const laneSuppressed = evaluated.eligible && utxo.lane !== 'payment';
        return {
          txid: utxo.outpoint.txid,
          vout: utxo.outpoint.vout,
          valueSats: utxo.valueSats.toString(),
          effectiveValueSats: effective.toString(),
          accountId: utxo.accountId,
          account: utxo.account,
          lane: utxo.lane,
          path: this.utxoPath(utxo),
          classification: utxo.facts?.primaryClass ?? 'unknown',
          eligible: evaluated.eligible && utxo.lane === 'payment',
          reasons: laneSuppressed ? ['reserved_ordinals_lane'] : evaluated.reasons,
          frozen: utxo.flags.userFrozen,
          dustQuarantined: utxo.flags.dustQuarantined,
          wrongLane: laneState(utxo),
          inscriptions: utxo.facts?.inscriptions ?? [],
          label: labelByOutpoint.get(outpointKey(utxo.outpoint)) ?? null,
        };
      });
      return {
        utxos: rows,
        // §8.1 pins the external address to chain 0 / index 0 in v1, so the
        // persisted externalMode has no other value yet. Read it from the
        // derivation state once a rotating mode variant exists.
        privacyNotes: walletPrivacyNotes({ externalAddressRotates: false }),
      };
    }));
  }

  async createTransactionPlan(input: TransactionPlanRequest): Promise<TransactionPlanResult> {
    const viewPromise = this.gatewayStatus({ forceRefresh: true });
    const [gatewayView, fee] = input.fee.type === 'custom'
      ? await Promise.all([
          viewPromise,
          viewPromise.then(() => this.resolveFee(input.fee)),
        ])
      : await Promise.all([viewPromise, this.resolveFee(input.fee)]);
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const meta = await this.loadAccountsMetaLocked(dek, session.vaultId);
      const registered = meta.registeredPublicAccounts.find(
        (account) => account.accountId === input.accountId,
      );
      if (!registered || registered.account !== input.account) {
        throw new RpcError('ERR_INVALID_PAYLOAD', 'transaction account identity mismatch');
      }
      const signingSource = await this.accountSigningSourceLocked(
        dek, session.vaultId, input.accountId,
      );
      if (!derivePublicAccountCapabilities({
        unlocked: true,
        network: this.deps.network,
        signingSource: { kind: signingSource.kind },
      }).canPlanTransactions) {
        throw new RpcError('ERR_UNSAFE_TRANSACTION', 'account cannot build transaction plans');
      }
      const plan = await this.buildTransactionPlanLocked(dek, session, input, gatewayView, fee);
      await this.savePlanLocked(dek, session.vaultId, plan);
      await this.touchSessionLocked(session);
      return this.planResultLocked(plan);
    }));
  }

  async reviewTransactionPlan(input: TransactionReviewRequest): Promise<TransactionPlanResult> {
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const plan = await this.loadPlanLocked(dek, session.vaultId, input.planId);
      if (!plan) throw new RpcError('ERR_PLAN_EXPIRED', 'transaction plan unavailable');
      if (plan.accountId !== input.accountId) {
        throw new RpcError('ERR_PLAN_CHANGED', 'transaction account changed');
      }
      this.assertLivePlan(plan);
      await this.touchSessionLocked(session);
      return this.planResultLocked(plan);
    }));
  }

  async cancelTransactionPlan(input: TransactionReviewRequest): Promise<{ cancelled: boolean }> {
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const cache = this.requireCache();
      const key = this.cacheKey(session.vaultId, 'plans', input.planId);
      const plan = await this.loadPlanLocked(dek, session.vaultId, input.planId);
      const existed = plan !== null && plan.accountId === input.accountId;
      if (plan !== null && plan.accountId !== input.accountId) {
        throw new RpcError('ERR_PLAN_CHANGED', 'transaction account changed');
      }
      await cache.delete(key);
      this.nativeInscriptionPreviews.delete(input.planId);
      await this.touchSessionLocked(session);
      return { cancelled: existed };
    }));
  }

  async approveTransaction(input: TransactionApproveRequest) {
    if (this.approvingPlanIds.has(input.planId)) {
      throw new RpcError('ERR_PLAN_CHANGED', 'transaction approval is already in progress');
    }
    this.approvingPlanIds.add(input.planId);
    try {
      return await this.approveTransactionOnce(input);
    } finally {
      this.approvingPlanIds.delete(input.planId);
    }
  }

  private async approveTransactionOnce(input: TransactionApproveRequest) {
    const plan = await this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const loaded = await this.loadPlanLocked(dek, session.vaultId, input.planId);
      if (!loaded) throw new RpcError('ERR_PLAN_EXPIRED', 'transaction plan unavailable');
      if (loaded.accountId !== input.accountId) {
        throw new RpcError('ERR_PLAN_CHANGED', 'transaction account changed');
      }
      const signingSource = await this.accountSigningSourceLocked(
        dek, session.vaultId, loaded.accountId,
      );
      const capabilities = derivePublicAccountCapabilities({
        unlocked: true,
        network: this.deps.network,
        signingSource: { kind: signingSource.kind },
      });
      if (!capabilities.canSignTransactions || !capabilities.canBroadcast) {
        throw new RpcError(
          'ERR_UNSAFE_TRANSACTION',
          'watch-only accounts cannot sign or broadcast transactions',
        );
      }
      return loaded;
    }));
    if (plan.planHash !== input.planHash) throw new RpcError('ERR_PLAN_CHANGED', 'plan hash mismatch');
    this.assertLivePlan(plan);

    const gateway = this.deps.gateway;
    if (!gateway) throw new RpcError('ERR_BROADCAST_REJECTED', 'gateway unavailable');
    const viewPromise = this.gatewayStatus({ forceRefresh: true });
    const [initialView, initialClassifications, initialFee] = await Promise.all([
      viewPromise,
      this.refreshPlanClassifications(plan),
      plan.policy.fee.type === 'custom'
        ? viewPromise.then(() => this.resolveFee({
            type: 'custom',
            rateSatPerVb: plan.policy.fee.type === 'custom'
              ? plan.policy.fee.normalizedSatPerVb
              : '',
          }))
        : this.resolveFee(plan.policy.fee),
    ]);
    const { view, classifications: refreshedClassifications } =
      await this.reconcileApprovalEvidence(plan, initialView, initialClassifications);
    let refreshedFee = initialFee;
    if (plan.policy.fee.type === 'custom') {
      refreshedFee = await this.resolveFee({
        type: 'custom',
        rateSatPerVb: plan.policy.fee.normalizedSatPerVb,
      });
    }
    const { byOutpoint, sourceChanged, preservedRbfOutpoints } = refreshedClassifications;
    for (const expected of plan.inputs) {
      if (preservedRbfOutpoints.has(`${expected.txid}:${expected.vout}`)) continue;
      const fresh = byOutpoint.get(`${expected.txid}:${expected.vout}`);
      const expectedFacts = expected.classification;
      if (!fresh || fresh.valueSats !== expected.valueSats.toString() || fresh.scriptPubKey !== expected.scriptPubKey ||
          fresh.primaryClass !== expectedFacts.primaryClass ||
          JSON.stringify(fresh.inscriptions) !== JSON.stringify(expectedFacts.inscriptions) ||
          JSON.stringify(fresh.satRanges) !== JSON.stringify(expectedFacts.satRanges) ||
          fresh.unsupportedAssetDetected !== expectedFacts.unsupportedAssetDetected ||
          fresh.confidence !== expectedFacts.confidence ||
          fresh.classificationRevision !== expectedFacts.classificationRevision) {
        throw new RpcError('ERR_PLAN_CHANGED', 'selected prevout changed');
      }
    }
    if (sourceChanged || refreshedFee.rate > plan.feeRateSatPerKvB) {
      return this.createReplacementReview(input, plan, view, refreshedFee, byOutpoint);
    }

    const signed = await this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const current = await this.loadPlanLocked(dek, session.vaultId, input.planId);
      if (!current || current.planHash !== input.planHash) throw new RpcError('ERR_PLAN_CHANGED');
      if (current.accountId !== input.accountId) {
        throw new RpcError('ERR_PLAN_CHANGED', 'transaction account changed');
      }
      const currentSource = await this.accountSigningSourceLocked(
        dek, session.vaultId, current.accountId,
      );
      if (currentSource.kind !== 'software' || currentSource.vaultId !== session.vaultId) {
        throw new RpcError('ERR_UNSAFE_TRANSACTION', 'account has no attached software signer');
      }
      this.assertLivePlan(current);
      await this.assertSpendingFreshLocked(dek, session.vaultId, view, this.actionForPlan(current.kind));
      const cached = this.deps.gateway
        ? await loadCachedStatus(this.deps.session, this.deps.gateway.endpoint, this.deps.gateway.protocolVersions)
        : null;
      if (!cached || cached.status.instanceId !== current.source.instanceId ||
          cached.status.activeRevision !== current.source.classificationRevision ||
          cached.status.coreTip.height !== current.source.coreTip.height ||
          cached.status.coreTip.hash !== current.source.coreTip.hash ||
          cached.status.indexTip.height !== current.source.indexTip.height ||
          cached.status.indexTip.hash !== current.source.indexTip.hash) {
        throw new RpcError('ERR_PLAN_CHANGED', 'gateway source changed');
      }
      const config = await loadConfig(this.deps.local);
      const review = reviewFromPlan(current, view.missingProtections, config.highSecurityMode);
      if (
        review.ordinalAction !== null &&
        review.ordinalAction.action !== 'manage_postage' &&
        review.ordinalAction.requiresNonTaprootAcknowledgement &&
        input.nonTaprootDestinationAcknowledged !== true
      ) {
        throw new RpcError(
          'ERR_UNSAFE_TRANSACTION',
          'non-Taproot inscription destination acknowledgement required',
        );
      }
      if (review.requiresReauth) {
        if (!input.password) throw new RpcError('ERR_WRONG_PASSWORD', 'password confirmation required');
        const map = await loadVaults(this.deps.local);
        const record = map[session.vaultId];
        if (!record) throw new RpcError('ERR_VAULT_NOT_FOUND');
        await this.verifyAppPassword(record, input.password);
      }
      const livePreviews = await this.livePreviewsForPlan(current, true);
      try {
        assertPreviewAcknowledged(livePreviews.previews, input.previewUnavailableAcknowledged);
      } catch (error) {
        throw new RpcError('ERR_UNSAFE_TRANSACTION', (error as Error).message);
      }
      const map = await loadVaults(this.deps.local);
      const record = map[session.vaultId];
      if (!record) throw new RpcError('ERR_VAULT_NOT_FOUND');
      const payload = openVaultPayload(record, dek);
      const seed = hexToBytes(payload.seedHex);
      try {
        const result = signAndValidatePlan(current, seed, (n) => this.deps.vaultDeps.random(n));
        const recoveryBase = {
          planId: current.planId,
          transactionHex: result.transactionHex,
          txid: result.txid,
          wtxid: result.wtxid,
          network: current.network,
          backend: current.source.backend,
          attempts: 0,
          nextRetryAt: this.deps.vaultDeps.now(),
          lastFailure: null,
        };
        const recovery: BroadcastRecovery = refreshedFee.binding === 'quote'
          ? {
              ...recoveryBase,
              feeTarget: refreshedFee.target,
              feeQuote: refreshedFee.quote,
            }
          : {
              ...recoveryBase,
              customFeeRateSatPerKvB: Number(refreshedFee.rate),
              status: refreshedFee.status,
            };
        await this.saveRecoveryLocked(dek, session.vaultId, recovery);
        this.nativeInscriptionPreviews.delete(current.planId);
        await this.touchSessionLocked(session);
        return result;
      } finally {
        zeroize(seed);
      }
    }));

    const broadcastBase = {
      network: this.deps.network,
      transactionHex: signed.transactionHex,
      txid: signed.txid,
      wtxid: signed.wtxid,
    };
    const response = await gateway.broadcastTransaction(
      refreshedFee.binding === 'quote'
        ? {
            ...broadcastBase,
            feeTarget: refreshedFee.target,
            feeQuote: refreshedFee.quote,
          }
        : {
            ...broadcastBase,
            customFeeRateSatPerKvB: Number(refreshedFee.rate),
            status: refreshedFee.status,
          },
    );
    if (!response.ok) {
      await this.noteRecoveryFailure(input, plan, 'gateway unavailable');
      return { planId: plan.planId, txid: signed.txid, status: 'pending' as const, detail: 'Broadcast state is unknown. Refresh before recovery; it will not be retried automatically.' };
    }
    if (response.value.status === 'indeterminate') {
      await this.noteRecoveryFailure(input, plan, 'broadcast outcome indeterminate');
      return { planId: plan.planId, txid: signed.txid, status: 'pending' as const, detail: response.value.detail };
    }
    return this.finishBroadcast(input, plan, response.value.status, response.value.detail, signed.txid);
  }

  async transactionStatus(input: ActiveSessionRequest & { accountId: string }) {
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const transactions = (await this.loadTransactionsLocked(dek, session.vaultId)).filter(
        (transaction) => (transaction.plan as { accountId?: string }).accountId === input.accountId,
      );
      const recoveries = await this.loadRecoveriesLocked(dek, session.vaultId);
      const history = await this.loadHistoryLocked(dek, session.vaultId, input.accountId);
      const historyByTxid = new Map(history.map((entry) => [entry.txid, entry]));
      const replacedTxids = new Set(transactions
        .filter((transaction) =>
          transaction.replacesTxid !== null &&
          (transaction.status === 'accepted' || transaction.status === 'already_known' ||
            transaction.status === 'confirmed'))
        .map((transaction) => transaction.replacesTxid!));
      const results = transactions.map((tx) => {
        const observed = historyByTxid.get(tx.txid);
        const status = reconcileTrackedTransactionStatus(
          tx.status,
          observed?.confirmationState,
          replacedTxids.has(tx.txid),
        );
        const pending = status === 'accepted' || status === 'already_known' || status === 'pending';
        const rbfCurrentlyAvailable = observed?.confirmationState === 'mempool' &&
          observed.replaceable === true && observed.replacedByTxid === null;
        const recommendedAcceleration = !pending
          ? null
          : rbfCurrentlyAvailable && tx.plan.rbf &&
              tx.plan.outputs.some((output) => output.role === 'payment_change')
            ? 'rbf' as const
            : observed?.cpfpEligible
              ? 'cpfp' as const
              : null;
        return {
          planId: tx.planId, kind: tx.kind, txid: tx.txid, createdAt: tx.createdAt,
          amountSats: tx.amountSats.toString(), feeSats: tx.feeSats.toString(), status,
          detail: tx.detail, parentTxid: tx.parentTxid, replacesTxid: tx.replacesTxid,
          recovering: false, recommendedAcceleration,
          accelerationUnavailableReason: pending && recommendedAcceleration === null
            ? 'No safe fee-bump path is available for this transaction.'
            : null,
        };
      });
      for (const recovery of recoveries) {
        const plan = await this.loadPlanLocked(dek, session.vaultId, recovery.planId);
        if (!plan || plan.accountId !== input.accountId) continue;
        const scannedState = historyByTxid.get(recovery.txid)?.confirmationState;
        results.push({
          planId: plan.planId, kind: plan.kind, txid: recovery.txid, createdAt: plan.createdAt,
          amountSats: plan.outputs.filter((o) => o.role === 'recipient' || o.role === 'postage').reduce((s,o) => s + o.valueSats, 0n).toString(),
          feeSats: plan.feeSats.toString(), status: reconcileTransactionStatus('pending', scannedState),
          detail: recovery.lastFailure, parentTxid: plan.parentTxid, replacesTxid: plan.replacesTxid,
          recovering: scannedState === undefined,
          recommendedAcceleration: null,
          accelerationUnavailableReason: 'Resolve the pending broadcast before changing its fee.',
        });
      }
      return {
        network: this.deps.network,
        accountId: input.accountId,
        transactions: results.sort((a,b) => b.createdAt - a.createdAt),
      };
    }));
  }

  /** Preserve indeterminate bytes for explicit reconciliation; never replay. */
  async retryBroadcasts(): Promise<void> {
    // An unavailable or indeterminate mutation is never safe to replay. The
    // persisted exact bytes remain visible to recovery UI, but only explicit
    // reconciliation may clear or resubmit them.
  }

  private async resolveFee(policy: TransactionPlanRequest['fee']): Promise<ResolvedFee> {
    const gateway = this.deps.gateway;
    if (!gateway) throw new RpcError('ERR_FEE_QUOTE_INVALID', 'fee estimator unavailable');
    if (policy.type === 'custom') {
      let rate: bigint;
      try {
        rate = parseCustomFeeRate(policy.rateSatPerVb).satPerKvB;
      } catch (error) {
        throw new RpcError(
          'ERR_FEE_QUOTE_INVALID',
          error instanceof Error ? error.message : 'invalid custom fee rate',
        );
      }
      const cached = await loadCachedStatus(
        this.deps.session,
        gateway.endpoint,
        gateway.protocolVersions,
      );
      if (
        cached?.status.protocolVersion !== 2 ||
        !cached.status.readiness.spendingReady ||
        !cached.status.capabilities.includes('broadcast')
      ) {
        throw new RpcError('ERR_FEE_QUOTE_INVALID', 'custom fee rate unavailable');
      }
      return {
        binding: 'custom',
        rate,
        urgency: 'custom',
        status: cached.status,
      };
    }
    const result = await gateway.fetchFees();
    if (!result.ok) throw new RpcError('ERR_FEE_QUOTE_INVALID', 'fee estimator unavailable');
    try {
      validateAutomaticQuote(result.value, this.deps.vaultDeps.now());
    } catch {
      throw new RpcError('ERR_FEE_QUOTE_INVALID', 'unsafe automatic fee quote');
    }
    const target = policy.tier === 'priority' || policy.tier === 'recommended'
      ? 2 as const
      : policy.tier === 'standard'
        ? 6 as const
        : 12 as const;
    return {
      binding: 'quote',
      rate: BigInt(quoteTier(result.value, target).effectiveSatPerKvB),
      urgency: policy.tier === 'recommended' ? 'priority' : policy.tier,
      quote: result.value,
      target,
    };
  }

  private async refreshPlanClassifications(
    plan: TransactionPlan,
  ): Promise<RefreshedPlanClassifications> {
    const gateway = this.deps.gateway;
    if (!gateway) throw new RpcError('ERR_DATA_STALE', 'gateway unavailable');
    let sourceChanged = false;
    let source: ApprovalEvidenceSource | null = null;
    const preservedRbfOutpoints = new Set<string>();
    if (plan.kind === 'rbf') {
      if (plan.replacesTxid === null) {
        throw new RpcError('ERR_PLAN_CHANGED', 'replacement parent is missing');
      }
      const parent = await this.loadStoredTransactionForApproval(plan.replacesTxid, plan.accountId);
      if (!parent) throw new RpcError('ERR_NOT_ACCELERATABLE', 'replacement parent is unavailable');
      sourceChanged = (await this.assertPendingRbfParent(parent, plan.source)).sourceChanged;
      const parentByOutpoint = new Map(
        parent.plan.inputs.map((entry) => [`${entry.txid}:${entry.vout}`, entry]),
      );
      for (const candidate of plan.inputs) {
        const key = `${candidate.txid}:${candidate.vout}`;
        const original = parentByOutpoint.get(key);
        if (original === undefined) continue;
        if (!rbfInputMatchesParent(candidate, original)) {
          throw new RpcError('ERR_PLAN_CHANGED', 'replacement parent input changed');
        }
        preservedRbfOutpoints.add(key);
      }
      if (preservedRbfOutpoints.size !== parent.plan.inputs.length) {
        throw new RpcError('ERR_PLAN_CHANGED', 'replacement parent inputs are incomplete');
      }
    }
    const requested = plan.inputs
      .filter((entry) => !preservedRbfOutpoints.has(`${entry.txid}:${entry.vout}`))
      .map((entry) => ({ txid: entry.txid, vout: entry.vout }));
    const byOutpoint = new Map<string, UtxoClassification>();
    for (let offset = 0; offset < requested.length; offset += CLASSIFY_MAX_OUTPOINTS) {
      const chunk = requested.slice(offset, offset + CLASSIFY_MAX_OUTPOINTS);
      const result = await gateway.classifyOutpoints({ network: this.deps.network, outpoints: chunk });
      if (!result.ok || result.value.classificationRevision !== plan.source.classificationRevision ||
          result.value.unknownOutpoints.length > 0) {
        throw new RpcError('ERR_DATA_STALE', 'classification refresh failed');
      }
      const expected = new Set(chunk.map((entry) => `${entry.txid}:${entry.vout}`));
      if (result.value.classifications.length !== expected.size) {
        throw new RpcError('ERR_DATA_STALE', 'classification response incomplete');
      }
      const chunkSource = approvalEvidenceSource(result.value);
      if (source !== null && !approvalSourcesEqual(source, chunkSource)) {
        throw new RpcError('ERR_DATA_STALE', 'classification responses changed source');
      }
      source ??= chunkSource;
      sourceChanged ||= !approvalSourcesEqual(chunkSource, {
        instanceId: plan.source.instanceId,
        classificationRevision: plan.source.classificationRevision,
        coreTip: plan.source.coreTip,
        indexTip: plan.source.indexTip,
      });
      for (const record of result.value.classifications) {
        const key = `${record.txid}:${record.vout}`;
        if (!expected.has(key) || byOutpoint.has(key) ||
            record.classificationRevision !== result.value.classificationRevision ||
            record.classifiedTip.height !== result.value.coreTip.height ||
            record.classifiedTip.hash !== result.value.coreTip.hash) {
          throw new RpcError('ERR_DATA_STALE', 'classification response conflict');
        }
        byOutpoint.set(key, record);
      }
    }
    return { byOutpoint, sourceChanged, preservedRbfOutpoints, source };
  }

  /**
   * Status, fee, and input evidence use independent signed endpoints. Preserve
   * the parallel fast path, but never build a replacement review from a status
   * snapshot known to be older or newer than its classifications. One bounded
   * status/classification reconciliation covers normal tip propagation; a
   * source that still will not converge fails closed instead of looping review.
   */
  private async reconcileApprovalEvidence(
    plan: TransactionPlan,
    view: GatewayStatusView,
    classifications: RefreshedPlanClassifications,
  ): Promise<{ view: GatewayStatusView; classifications: RefreshedPlanClassifications }> {
    const gateway = this.deps.gateway;
    if (!gateway || classifications.source === null) return { view, classifications };
    const loadStatus = () => loadCachedStatus(
      this.deps.session,
      gateway.endpoint,
      gateway.protocolVersions,
    );
    let cached = await loadStatus();
    if (cached && approvalSourceMatchesStatus(classifications.source, cached.status)) {
      return { view, classifications };
    }

    const reconciledView = await this.gatewayStatus({ forceRefresh: true });
    cached = await loadStatus();
    if (cached && approvalSourceMatchesStatus(classifications.source, cached.status)) {
      return { view: reconciledView, classifications };
    }

    const retriedClassifications = await this.refreshPlanClassifications(plan);
    cached = await loadStatus();
    if (!cached || retriedClassifications.source === null ||
        !approvalSourceMatchesStatus(retriedClassifications.source, cached.status)) {
      throw new RpcError('ERR_DATA_STALE', 'gateway evidence changed during approval');
    }
    return { view: reconciledView, classifications: retriedClassifications };
  }

  private async loadStoredTransactionForApproval(
    txid: string,
    accountId: string,
  ): Promise<CurrentStoredTransaction | null> {
    return this.runExclusive(async () => {
      const session = await this.liveSession();
      if (!session) throw new RpcError('ERR_LOCKED', 'wallet locked');
      const dek = base64ToBytes(session.dekB64);
      try {
        return (await this.loadTransactionsLocked(dek, session.vaultId)).find(
          (transaction): transaction is CurrentStoredTransaction =>
            isCurrentStoredTransaction(transaction) && transaction.txid === txid &&
            transaction.plan.accountId === accountId,
        ) ?? null;
      } finally {
        zeroize(dek);
      }
    });
  }

  /**
   * A parent input is absent from the ordinary UTXO/classification APIs once
   * the wallet broadcasts it. The exact encrypted plan remains authoritative
   * for those immutable prevout bytes, while this fresh signed snapshot proves
   * that the exact wallet-signed txid is still pending and BIP125-replaceable.
   */
  private async assertPendingRbfParent(
    parent: CurrentStoredTransaction,
    expectedSource?: TransactionPlan['source'],
  ): Promise<{ sourceChanged: boolean }> {
    const gateway = this.deps.gateway;
    if (!gateway || parent.plan.inputs.length === 0) {
      throw new RpcError('ERR_NOT_ACCELERATABLE', 'replacement parent is unavailable');
    }
    const proofInput = parent.plan.inputs.find(
      (entry) => entry.ownership === 'wallet' && entry.derivation !== null,
    );
    if (!proofInput) {
      throw new RpcError('ERR_NOT_ACCELERATABLE', 'replacement parent ownership is unavailable');
    }
    const scriptHash = scriptHashFromScriptPubKey(proofInput.scriptPubKey);
    const result = await gateway.fetchSnapshot({
      network: this.deps.network,
      scriptHashes: [scriptHash],
    });
    if (!result.ok) throw new RpcError('ERR_DATA_STALE', 'pending transaction proof unavailable');
    const cached = await loadCachedStatus(
      this.deps.session,
      gateway.endpoint,
      gateway.protocolVersions,
    );
    if (!cached || result.value.instanceId !== cached.status.instanceId ||
        result.value.classificationRevision !== cached.status.activeRevision ||
        !tipsEqual(result.value.coreTip, cached.status.coreTip) ||
        !tipsEqual(result.value.indexTip, cached.status.indexTip)) {
      throw new RpcError('ERR_DATA_STALE', 'pending transaction proof is not current');
    }
    if (parent.plan.source.classificationRevision !== result.value.classificationRevision) {
      throw new RpcError('ERR_NOT_ACCELERATABLE', 'parent classification revision changed');
    }
    const observed = result.value.history.find((entry) => entry.txid === parent.txid);
    if (!observed || !observed.spentScriptHashes.includes(scriptHash) ||
        observed.confirmationState !== 'mempool' || observed.replaceable !== true ||
        observed.replacedByTxid !== null) {
      throw new RpcError('ERR_NOT_ACCELERATABLE', 'transaction is no longer replaceable');
    }
    return {
      sourceChanged: expectedSource !== undefined &&
        (result.value.instanceId !== expectedSource.instanceId ||
          result.value.classificationRevision !== expectedSource.classificationRevision ||
          !tipsEqual(result.value.coreTip, expectedSource.coreTip) ||
          !tipsEqual(result.value.indexTip, expectedSource.indexTip)),
    };
  }

  /**
   * Freshness here is read from the verified cached status, not from a passed-in
   * view — the two can disagree, and the cache is the one the eligibility
   * predicate is defined against. (assertSpendingFreshLocked is the caller that
   * genuinely gates on the view.)
   */
  private async eligibilityContextLocked(
    dek: Uint8Array,
    vaultId: string,
    feeRate: bigint,
  ): Promise<EligibilityContext> {
    const cached = this.deps.gateway
      ? await loadCachedStatus(this.deps.session, this.deps.gateway.endpoint, this.deps.gateway.protocolVersions)
      : null;
    const freshness = cached
      ? evaluateFreshness(cached.status, this.deps.vaultDeps.now(), cached.verifiedAtMs)
      : { commonTip: false, heartbeatFresh: false, revisionActive: false, spendEligible: false };
    const meta = await this.loadAccountsMetaLocked(dek, vaultId);
    const lockedOutpoints = await this.loadLockedOutpointsLocked(dek, vaultId);
    return {
      freshness: {
        ...freshness,
        spendEligible: freshness.spendEligible && !meta.hasConflictingSources,
      },
      activeRevision: cached?.status.activeRevision ?? '',
      lockedOutpoints,
      marginalFeeSatsFor: (utxo) => feeForVsize(inputVbytes(utxo.scriptPubKey), feeRate),
    };
  }

  private async assertSpendingFreshLocked(
    dek: Uint8Array,
    vaultId: string,
    view: GatewayStatusView,
    action: 'native_send' | 'rbf' | 'cpfp' | 'consolidation' | 'rescue_sweep',
  ): Promise<void> {
    const meta = await this.loadAccountsMetaLocked(dek, vaultId);
    const cached = this.deps.gateway
      ? await loadCachedStatus(this.deps.session, this.deps.gateway.endpoint, this.deps.gateway.protocolVersions)
      : null;
    const tipsDivergeByHashOnly = cached !== null &&
      cached.status.coreTip.height === cached.status.ordTip.height &&
      cached.status.coreTip.hash !== cached.status.ordTip.hash;
    const gating = deriveDataGating(view, {
      hasConflictingSources: meta.hasConflictingSources,
      tipsDivergeByHashOnly,
      cachedRevisionStale: meta.revision !== null && cached !== null && meta.revision !== cached.status.activeRevision,
    });
    if (gating.state !== 'fresh' || gating.blockedActions.includes(action)) {
      throw new RpcError('ERR_DATA_STALE', `spending blocked: ${gating.state}`);
    }
  }

  private actionForPlan(kind: TransactionPlan['kind']): 'native_send' | 'rbf' | 'cpfp' | 'consolidation' | 'rescue_sweep' {
    if (kind === 'rbf') return 'rbf';
    if (kind === 'cpfp') return 'cpfp';
    if (kind === 'consolidation') return 'consolidation';
    if (kind === 'ordinal_transfer' || kind === 'ordinal_batch_transfer' ||
        kind === 'ordinal_postage_manage' ||
        kind === 'rescue' || kind === 'ordinal_sweep') return 'rescue_sweep';
    return 'native_send';
  }

  private async buildTransactionPlanLocked(
    dek: Uint8Array,
    session: UnlockSession,
    input: TransactionPlanRequest,
    view: GatewayStatusView,
    fee: ResolvedFee,
  ): Promise<TransactionPlan> {
    await this.assertSpendingFreshLocked(dek, session.vaultId, view, this.actionForPlan(input.kind));
    const cached = this.deps.gateway
      ? await loadCachedStatus(this.deps.session, this.deps.gateway.endpoint, this.deps.gateway.protocolVersions)
      : null;
    if (!cached) throw new RpcError('ERR_DATA_STALE', 'verified gateway status unavailable');
    const status = cached.status;
    const definition = await this.loadPublicAccountDefinitionLocked(
      dek, session.vaultId, input.accountId,
    );
    if (definition.derivationAccountIndex !== input.account) {
      throw new RpcError('ERR_INVALID_PAYLOAD', 'transaction account metadata mismatch');
    }
    const utxos = (await this.loadAllUtxosLocked(dek, session.vaultId)).filter(
      (utxo) => utxo.accountId === input.accountId,
    );
    const eligibility = await this.eligibilityContextLocked(dek, session.vaultId, fee.rate);
      let built: {
        account: number;
        inputs: TransactionPlan['inputs'];
        outputs: PlanOutput[];
        feeSats: bigint;
        vsize: bigint;
        protectedSatFlow: TransactionPlan['protectedSatFlow'];
        rbf: boolean;
        parentTxid: string | null;
        replacesTxid: string | null;
        canonicalRecipient?: string;
      };
      if (input.kind === 'native_send') {
        built = await this.buildNativeLocked(
          dek, session.vaultId, definition, input, utxos, eligibility, fee.rate,
        );
      } else if (input.kind === 'native_batch_send') {
        built = await this.buildNativeBatchLocked(
          dek, session.vaultId, definition, input, utxos, eligibility, fee.rate,
        );
      } else if (input.kind === 'ordinal_transfer') {
        built = await this.buildOrdinalTransferLocked(
          session.vaultId, definition, input, utxos, eligibility, fee.rate,
        );
      } else if (input.kind === 'ordinal_batch_transfer') {
        built = await this.buildOrdinalBatchTransferLocked(
          session.vaultId, definition, input, utxos, eligibility, fee.rate,
        );
      } else if (input.kind === 'ordinal_postage_manage') {
        built = await this.buildOrdinalPostageManageLocked(
          session.vaultId, definition, input, utxos, eligibility, fee.rate,
        );
      } else if (input.kind === 'consolidation') {
        built = await this.buildConsolidationLocked(session.vaultId, definition, input, utxos, eligibility, fee.rate);
      } else if (input.kind === 'rescue') {
        built = await this.buildRescueLocked(session.vaultId, definition, input, utxos, eligibility, fee.rate);
      } else if (input.kind === 'ordinal_sweep') {
        built = await this.buildSweepLocked(session.vaultId, definition, input, utxos, eligibility, fee.rate);
      } else if (input.kind === 'rbf') {
        built = await this.buildRbfLocked(
          dek,
          session.vaultId,
          definition,
          input,
          utxos,
          eligibility,
          fee.rate,
          fee.binding === 'quote' ? BigInt(fee.quote.incrementalRelaySatPerKvB) : 1_000n,
        );
      } else {
        built = await this.buildCpfpLocked(dek, session.vaultId, definition, input, utxos, eligibility, fee.rate);
      }

      const psbtHex = buildPsbtHex(built.inputs, built.outputs);
      const now = this.deps.vaultDeps.now();
      const feeExpiry = fee.binding === 'quote'
        ? Date.parse(fee.quote.expiresAt)
        : now + 600_000;
      const source: TransactionPlan['source'] = {
        backend: this.deps.gateway?.endpoint ?? '',
        instanceId: status.instanceId,
        classificationRevision: status.activeRevision,
        coreTip: status.coreTip,
        indexTip: status.indexTip,
        feeQuoteTimestamp: fee.binding === 'quote' ? fee.quote.sampledAt : null,
        mempoolState: null,
      };
      const analyzed = analyzePsbtHex(psbtHex, {
        network: this.deps.network,
        account: built.account,
        kind: input.kind,
        source,
        inputs: built.inputs,
        outputs: built.outputs,
        protectedSatFlow: built.protectedSatFlow,
        feeSats: built.feeSats,
        vsize: built.vsize,
        feeRateSatPerKvB: fee.rate,
        rbf: built.rbf,
      });
      if (!analyzed.ok || analyzed.analysis.hardViolations.length > 0) {
        throw new RpcError('ERR_UNSAFE_TRANSACTION', 'transaction analysis rejected candidate');
      }
      const transaction = {
        version: 4 as const,
        planId: this.deps.newSessionId(),
        createdAt: now,
        expiresAt: Math.min(now + 600_000, feeExpiry),
        network: this.deps.network,
        accountId: input.accountId,
        account: built.account,
        kind: input.kind,
        policy: this.planPolicy(input, built.canonicalRecipient),
        source,
        inputs: built.inputs,
        outputs: built.outputs,
        protectedSatFlow: built.protectedSatFlow,
        feeSats: built.feeSats,
        vsize: built.vsize,
        feeRateSatPerKvB: fee.rate,
        urgency: fee.urgency,
        rbf: built.rbf,
        parentTxid: built.parentTxid,
        replacesTxid: built.replacesTxid,
        broadcast: true as const,
        psbtHex,
        psbtHash: hashHex(psbtHex),
        analysisHash: analyzed.analysisHash,
      };
      const commitment = transactionCommitmentHash(transaction);
      let inscriptionPreviews: StoredInscriptionPreviewSet;
      let livePreviews: InscriptionPreviewSet;
      if (analyzed.analysis.assetEffects.inscriptions.length === 0) {
        livePreviews = {
          transactionCommitmentHash: commitment,
          analysisHash: analyzed.analysisHash,
          psbtHash: transaction.psbtHash,
          effectSetHash: analyzed.analysis.assetEffects.effectSetHash,
          classificationRevision: source.classificationRevision,
          verifiedAtMs: now,
          items: [],
        };
        inscriptionPreviews = storedPreviewSet(livePreviews);
      } else {
        const gateway = this.deps.gateway;
        if (!gateway || !status.capabilities.includes('preview_service')) {
          throw new RpcError('ERR_UNSAFE_TRANSACTION', 'signed inscription previews unavailable');
        }
        const request = inscriptionApprovalRequest({
          network: transaction.network,
          analysis: analyzed.analysis,
          analysisHash: analyzed.analysisHash,
          psbtHash: transaction.psbtHash,
          transactionCommitmentHash: commitment,
        });
        const fetched = await gateway.fetchInscriptionApprovalBatch(request);
        if (!fetched.ok) throw new RpcError('ERR_UNSAFE_TRANSACTION', 'signed inscription previews unavailable');
        livePreviews = bindInscriptionPreviews({
          request,
          response: fetched.value,
          verifiedAtMs: fetched.verifiedAtMs,
        });
        inscriptionPreviews = storedPreviewSet(livePreviews);
      }
      const plan = finalizePlan({ ...transaction, inscriptionPreviews });
      this.nativeInscriptionPreviews.set(plan.planId, livePreviews);
      return plan;
  }

  private planPolicy(
    input: TransactionPlanRequest,
    canonicalRecipient?: string,
  ): TransactionPlan['policy'] {
    let intent: PlanIntent;
    if (input.kind === 'native_send') {
      intent = { kind: input.kind, account: input.account,
        recipient: canonicalRecipient ?? input.recipient,
        amountSats: input.amountSats, sendMax: input.sendMax,
        ...(input.selectedOutpoints ? { selectedOutpoints: input.selectedOutpoints.map((item) => ({ ...item })) } : {}) };
    } else if (input.kind === 'native_batch_send') {
      intent = {
        kind: input.kind,
        account: input.account,
        recipients: input.recipients.map((recipient) => ({ ...recipient })),
        ...(input.selectedOutpoints
          ? { selectedOutpoints: input.selectedOutpoints.map((item) => ({ ...item })) }
          : {}),
      };
    } else if (input.kind === 'ordinal_transfer') {
      intent = {
        kind: input.kind,
        account: input.account,
        inscriptionId: input.inscriptionId,
        outpoint: { ...input.outpoint },
        recipient: input.recipient,
      };
    } else if (input.kind === 'ordinal_batch_transfer') {
      intent = {
        kind: input.kind,
        account: input.account,
        recipient: canonicalRecipient ?? input.recipient,
        selections: canonicalOrdinalBatchSelections(input.selections),
      };
    } else if (input.kind === 'ordinal_postage_manage') {
      intent = {
        kind: input.kind,
        account: input.account,
        selections: canonicalOrdinalBatchSelections(input.selections),
        target: { ...input.target },
      };
    } else if (input.kind === 'consolidation') {
      intent = { kind: input.kind, account: input.account,
        selectedOutpoints: input.selectedOutpoints.map((item) => ({ ...item })) };
    } else if (input.kind === 'rbf' || input.kind === 'cpfp') {
      intent = { kind: input.kind, txid: input.txid };
    } else {
      intent = { kind: input.kind, outpoint: { ...input.outpoint } };
    }
    return {
      intent,
      fee: input.fee.type === 'custom'
        ? customPlanFeePolicy(input.fee.rateSatPerVb)
        : { ...input.fee },
    };
  }

  private requestFromPlan(plan: TransactionPlan, input: ActiveSessionRequest): TransactionPlanRequest {
    const fee = plan.policy.fee.type === 'custom'
      ? { type: 'custom' as const, rateSatPerVb: plan.policy.fee.normalizedSatPerVb }
      : { ...plan.policy.fee };
    return {
      ...plan.policy.intent,
      accountId: plan.accountId,
      fee,
      ...input,
    } as TransactionPlanRequest;
  }

  private async createReplacementReview(
    input: TransactionApproveRequest,
    oldPlan: TransactionPlan,
    view: GatewayStatusView,
    fee: ResolvedFee,
    freshByOutpoint: Map<string, import('@drey/core/domain/gateway/contract').UtxoClassification>,
  ) {
    return this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const current = await this.loadPlanLocked(dek, session.vaultId, oldPlan.planId);
      if (!current || current.planHash !== input.planHash) throw new RpcError('ERR_PLAN_CHANGED');
      const cache = this.requireCache();
      const keys = await cache.listKeys(session.vaultId, this.deps.network, 'utxos');
      for (const key of keys) {
        const cacheKey = this.cacheKey(session.vaultId, 'utxos', key);
        const record = await cache.get(cacheKey);
        if (!record) continue;
        const utxos = openRecord(dek, record, storedUtxosSchema) as WalletUtxo[];
        let updated = false;
        for (const utxo of utxos) {
          const fresh = freshByOutpoint.get(outpointKey(utxo.outpoint));
          if (!fresh || !utxo.facts) continue;
          utxo.facts = {
            primaryClass: fresh.primaryClass, inscriptions: fresh.inscriptions,
            satRanges: fresh.satRanges, unsupportedAssetDetected: fresh.unsupportedAssetDetected,
            confidence: fresh.confidence, classifiedTip: fresh.classifiedTip,
            classificationRevision: fresh.classificationRevision,
          };
          updated = true;
        }
        if (updated) await cache.put(sealRecord(dek, utxos, cacheKey,
          this.deps.vaultDeps.random(24), this.deps.vaultDeps.now()));
      }
      await cache.delete(this.cacheKey(session.vaultId, 'plans', oldPlan.planId));
      this.nativeInscriptionPreviews.delete(oldPlan.planId);
      const replacementRequest = this.requestFromPlan(oldPlan, input);
      if (replacementRequest.kind === 'ordinal_batch_transfer' ||
          replacementRequest.kind === 'ordinal_postage_manage') {
        replacementRequest.selections = replacementRequest.selections.map((selection) => {
          const fresh = freshByOutpoint.get(outpointKey(selection.outpoint));
          return fresh === undefined
            ? selection
            : { ...selection, classificationRevision: fresh.classificationRevision };
        });
      }
      const replacement = await this.buildTransactionPlanLocked(
        dek,
        session,
        replacementRequest,
        view,
        fee,
      );
      await this.savePlanLocked(dek, session.vaultId, replacement);
      await this.touchSessionLocked(session);
      return {
        planId: replacement.planId,
        txid: null,
        status: 'review_required' as const,
        detail: 'Transaction data changed. Review the replacement before signing.',
        replacement: await this.planResultLocked(replacement),
      };
    }));
  }

  private async buildNativeLocked(
    dek: Uint8Array,
    vaultId: string,
    definition: PublicAccountDefinitionV1,
    input: Extract<TransactionPlanRequest, { kind: 'native_send' }>,
    utxos: WalletUtxo[],
    eligibility: EligibilityContext,
    feeRate: bigint,
  ) {
    const paymentInstruction = resolvePaymentInstructionInput(input.recipient, this.deps.network);
    const recipient = paymentInstruction.recipient;
    const change = await this.reserveOutputLocked(
      vaultId, definition, 'payment', input.account, 'payment_change',
    );
    const amount = parseSats(input.amountSats);
    if (!input.sendMax && amount <= 0n) throw new RpcError('ERR_INVALID_PAYLOAD', 'amount must be positive');
    const selected = input.selectedOutpoints
      ? new Set(input.selectedOutpoints.map((entry) => `${entry.txid}:${entry.vout}`))
      : undefined;
    // §14.1: an automatic selection prefers not to merge label groups, but only
    // as a tie-break under waste. Manual selection ignores it entirely — the
    // user already said which inputs to spend. Consolidation deliberately
    // merges (§14.5 explains the privacy loss instead), so it does not pass
    // label groups either.
    const labelGroups = selected
      ? undefined
      : await this.labelGroupsLocked(dek, vaultId, input.accountId);
    const outcome = buildNativeSendCandidate({
      recipient,
      amountSats: amount,
      sendMax: input.sendMax,
      accountId: input.accountId,
      account: input.account,
      utxos,
      eligibility,
      feeRate,
      changeOutput: change,
      deriveInput: (utxo) => this.deriveForUtxo(definition, utxo),
      ...(selected ? { selectedOutpoints: selected } : {}),
      ...(labelGroups ? { labelGroupByOutpoint: labelGroups } : {}),
    });
    if (!outcome.ok) return mapNativeSendFailure(outcome.reason);
    return { ...outcome.candidate, canonicalRecipient: recipient.address };
  }

  private async buildNativeBatchLocked(
    dek: Uint8Array,
    vaultId: string,
    definition: PublicAccountDefinitionV1,
    input: Extract<TransactionPlanRequest, { kind: 'native_batch_send' }>,
    utxos: WalletUtxo[],
    eligibility: EligibilityContext,
    feeRate: bigint,
  ) {
    const recipients = input.recipients.map((item) => ({
      recipient: payableRecipient(item.address, this.deps.network),
      amountSats: parseSats(item.amountSats),
    }));
    const change = await this.reserveOutputLocked(
      vaultId, definition, 'payment', input.account, 'payment_change',
    );
    const selected = input.selectedOutpoints
      ? new Set(input.selectedOutpoints.map((entry) => `${entry.txid}:${entry.vout}`))
      : undefined;
    const labelGroups = selected
      ? undefined
      : await this.labelGroupsLocked(dek, vaultId, input.accountId);
    const outcome = buildNativeBatchSendCandidate({
      recipients,
      accountId: input.accountId,
      account: input.account,
      utxos,
      eligibility,
      feeRate,
      changeOutput: change,
      deriveInput: (utxo) => this.deriveForUtxo(definition, utxo),
      ...(selected ? { selectedOutpoints: selected } : {}),
      ...(labelGroups ? { labelGroupByOutpoint: labelGroups } : {}),
    });
    if (!outcome.ok) return mapNativeSendFailure(outcome.reason);
    return outcome.candidate;
  }

  private async buildOrdinalTransferLocked(
    vaultId: string,
    definition: PublicAccountDefinitionV1,
    input: Extract<TransactionPlanRequest, { kind: 'ordinal_transfer' }>,
    utxos: WalletUtxo[],
    eligibility: EligibilityContext,
    feeRate: bigint,
  ) {
    const required = utxos.find((utxo) =>
      utxo.account === input.account &&
      outpointKey(utxo.outpoint) === `${input.outpoint.txid}:${input.outpoint.vout}`);
    if (
      !required ||
      required.lane !== 'ordinals' ||
      required.height === null ||
      required.flags.userFrozen ||
      required.flags.dustQuarantined ||
      required.facts?.confidence !== 'authoritative' ||
      required.facts.classificationRevision !== eligibility.activeRevision ||
      !eligibility.freshness.spendEligible ||
      (required.facts.primaryClass !== 'inscribed' && required.facts.primaryClass !== 'mixed') ||
      required.facts.inscriptions.length === 0 ||
      required.facts.unsupportedAssetDetected ||
      required.facts.satRanges?.some((range) =>
        range.rarity !== undefined && range.rarity !== 'common') ||
      eligibility.lockedOutpoints.has(outpointKey(required.outpoint))
    ) {
      throw new RpcError('ERR_UNSAFE_TRANSACTION', 'inscription cannot be transferred safely');
    }

    let groups;
    try {
      groups = groupOrdinalInscriptions({
        txid: required.outpoint.txid,
        vout: required.outpoint.vout,
        valueSats: required.valueSats,
        targetInscriptionId: input.inscriptionId,
        inscriptions: required.facts.inscriptions,
      });
    } catch (error) {
      if (
        error instanceof OrdinalInscriptionGroupError &&
        error.reason === 'co_located'
      ) {
        throw new RpcError(
          'ERR_INSCRIPTION_INSEPARABLE',
          'target inscription is co-located with another inscription',
        );
      }
      throw new RpcError('ERR_UNSAFE_TRANSACTION', (error as Error).message);
    }

    const recipientScript = payableRecipient(input.recipient, this.deps.network).scriptPubKey;
    const paymentChange = await this.reserveOutputLocked(
      vaultId, definition, 'payment', required.account, 'payment_change',
    );
    const ordinalChanges = new Map<string, PlanOutput>();
    for (const group of groups) {
      if (group.target) continue;
      ordinalChanges.set(group.key, {
        ...await this.reserveOutputLocked(
          vaultId, definition, 'ordinals', required.account, 'ordinal_change',
        ),
        valueSats: 0n,
      });
    }

    const targetPostage = automaticOrdinalPostage(
      required.valueSats,
      DEFAULT_POSTAGE_SATS,
      scriptDustSats(recipientScript),
    );
    const targetDust = scriptDustSats(recipientScript);
    let partitions;
    try {
      partitions = partitionOrdinalSatFlow(required.valueSats, groups.map((group) => {
        const change = ordinalChanges.get(group.key);
        const minimumOutputSats = group.target
          ? targetDust
          : economicChangeThreshold(change!.scriptPubKey, feeRate);
        return {
          inscriptionId: group.key,
          inputOffset: group.offset,
          minimumOutputSats,
          ...(group.target ? { preferredOutputSats: targetPostage } : {}),
          target: group.target,
        };
      }));
    } catch {
      throw new RpcError(
        'ERR_INSCRIPTION_INSEPARABLE',
        'inscription groups cannot be partitioned safely',
      );
    }

    let cleanProtectedTail = 0n;
    const lastPartition = partitions.at(-1)!;
    const lastOutput = lastPartition.target
      ? recipientScript
      : ordinalChanges.get(lastPartition.inscriptionId)!.scriptPubKey;
    const minimumLastOutput = lastPartition.target
      ? targetPostage
      : economicChangeThreshold(lastOutput, feeRate);
    const minimumContainingLast = lastPartition.outputOffset + 1n > minimumLastOutput
      ? lastPartition.outputOffset + 1n : minimumLastOutput;
    const removableTail = lastPartition.valueSats - minimumContainingLast;
    if (removableTail > economicChangeThreshold(paymentChange.scriptPubKey, feeRate)) {
      lastPartition.valueSats = minimumContainingLast;
      cleanProtectedTail = removableTail;
    }

    const outputs: PlanOutput[] = partitions.map((partition) => partition.target
      ? {
          address: input.recipient,
          scriptPubKey: recipientScript,
          valueSats: partition.valueSats,
          role: 'postage' as const,
        }
      : {
          ...ordinalChanges.get(partition.inscriptionId)!,
          valueSats: partition.valueSats,
        });
    const protectedOutputTotal = partitions.reduce(
      (sum, partition) => sum + partition.valueSats,
      0n,
    );
    const requiredPostageTopUp = protectedOutputTotal > required.valueSats
      ? protectedOutputTotal - required.valueSats
      : 0n;
    const protectedInput = inputFromUtxo(
      required,
      this.deriveForUtxo(definition, required),
      sequenceForInput('ordinal_transfer'),
    );
    let feeInputs: WalletUtxo[];
    try {
      feeInputs = selectCoins({
        utxos,
        eligibility,
        accountId: required.accountId!,
        account: required.account,
        feeRate,
        targetSats:
          requiredPostageTopUp +
          feeForVsize(inputVbytes(required.scriptPubKey), feeRate),
        recipientScripts: outputs.map((output) => output.scriptPubKey),
        changeScript: paymentChange.scriptPubKey,
        sendMax: false,
      }).inputs;
    } catch {
      throw new RpcError(
        'ERR_CLEAN_FEE_INPUTS_UNAVAILABLE',
        'cardinal-clean payment fee inputs are unavailable',
      );
    }
    if (feeInputs.some((utxo) =>
      utxo.lane !== 'payment' || utxo.facts?.primaryClass !== 'cardinal_clean')) {
      throw new RpcError('ERR_UNSAFE_TRANSACTION', 'protected input selected for transfer fee');
    }

    const inputs = [protectedInput, ...feeInputs.map((utxo) => inputFromUtxo(
      utxo,
      this.deriveForUtxo(definition, utxo),
      sequenceForInput('ordinal_transfer'),
    ))];
    let vsize = estimateVsize(
      inputs.map((item) => item.scriptPubKey),
      [...outputs.map((output) => output.scriptPubKey), paymentChange.scriptPubKey],
    );
    const minimumFee = feeForVsize(vsize, feeRate);
    const paymentTotal = feeInputs.reduce((sum, item) => sum + item.valueSats, 0n);
    const paymentRemainder = paymentTotal - minimumFee - requiredPostageTopUp;
    if (paymentRemainder < 0n) {
      throw new RpcError(
        'ERR_CLEAN_FEE_INPUTS_UNAVAILABLE',
        'cardinal-clean payment fee inputs are unavailable',
      );
    }
    const returnedBtc = cleanProtectedTail + paymentRemainder;
    if (returnedBtc > economicChangeThreshold(paymentChange.scriptPubKey, feeRate)) {
      outputs.push({ ...paymentChange, valueSats: returnedBtc });
    } else {
      vsize = estimateVsize(
        inputs.map((item) => item.scriptPubKey),
        outputs.map((output) => output.scriptPubKey),
      );
    }
    const totalInputSats = inputs.reduce((sum, item) => sum + item.valueSats, 0n);
    const totalOutputSats = outputs.reduce((sum, item) => sum + item.valueSats, 0n);
    const feeSats = totalInputSats - totalOutputSats;
    if (feeSats < feeForVsize(vsize, feeRate)) {
      throw new RpcError('ERR_UNSAFE_TRANSACTION', 'transfer fee is below the approved rate');
    }

    return {
      account: required.account,
      inputs,
      outputs,
      feeSats,
      vsize,
      protectedSatFlow: partitions.flatMap((partition, outputIndex) => {
        const group = groups.find((candidate) => candidate.key === partition.inscriptionId);
        if (!group) throw new RpcError('ERR_UNSAFE_TRANSACTION', 'inscription group changed');
        return group.items.map((item) => ({
          inputIndex: 0,
          inputOffset: partition.inputOffset,
          outputIndex,
          outputOffset: partition.outputOffset,
          inscriptionId: item.inscriptionId,
        }));
      }),
      rbf: false,
      parentTxid: null,
      replacesTxid: null,
    };
  }

  private async buildOrdinalBatchTransferLocked(
    vaultId: string,
    definition: PublicAccountDefinitionV1,
    input: Extract<TransactionPlanRequest, { kind: 'ordinal_batch_transfer' }>,
    utxos: WalletUtxo[],
    eligibility: EligibilityContext,
    feeRate: bigint,
  ) {
    const recipient = payableRecipient(input.recipient, this.deps.network);
    const canonicalSelections = canonicalOrdinalBatchSelections(input.selections);
    const recipientDust = scriptDustSats(recipient.scriptPubKey);
    const selectionBySource = new Map<string, typeof input.selections>();
    for (const selection of canonicalSelections) {
      const key = outpointKey(selection.outpoint);
      const existing = selectionBySource.get(key) ?? [];
      existing.push(selection);
      selectionBySource.set(key, existing);
    }
    const sources = [...selectionBySource.entries()].map(([key, selections]) => {
      const source = utxos.find((utxo) =>
        utxo.account === input.account && outpointKey(utxo.outpoint) === key);
      if (
        !source || source.accountId !== input.accountId || source.lane !== 'ordinals' ||
        source.height === null || source.flags.userFrozen || source.flags.dustQuarantined ||
        source.facts?.confidence !== 'authoritative' ||
        source.facts.classificationRevision !== eligibility.activeRevision ||
        selections.some((selection) =>
          selection.classificationRevision !== source.facts!.classificationRevision) ||
        !eligibility.freshness.spendEligible ||
        (source.facts.primaryClass !== 'inscribed' && source.facts.primaryClass !== 'mixed') ||
        source.facts.inscriptions.length === 0 || source.facts.unsupportedAssetDetected ||
        source.facts.satRanges?.some((range) =>
          range.rarity !== undefined && range.rarity !== 'common') ||
        eligibility.lockedOutpoints.has(key)
      ) {
        throw new RpcError('ERR_UNSAFE_TRANSACTION', `inscription source ${key} cannot be transferred safely`);
      }
      return { source, selections };
    });

    // One real P2WPKH change reservation per source supplies the exact economic
    // threshold. Additional source-local change outputs receive fresh indexes
    // below; no protected output ever reuses the final fee-change address.
    const sourceChangeTemplates = new Map<string, PlanOutput>();
    for (const { source } of sources) {
      sourceChangeTemplates.set(outpointKey(source.outpoint), await this.reserveOutputLocked(
        vaultId, definition, 'payment', source.account, 'payment_change',
      ));
    }
    let routing;
    try {
      routing = planOrdinalBatchSatFlow(sources.map(({ source, selections }) => {
        const template = sourceChangeTemplates.get(outpointKey(source.outpoint))!;
        return {
          txid: source.outpoint.txid,
          vout: source.outpoint.vout,
          valueSats: source.valueSats,
          classificationRevision: source.facts!.classificationRevision,
          inscriptions: source.facts!.inscriptions,
          selections,
          recipientMinimumOutputSats: recipientDust,
          preferredPostageSats: DEFAULT_POSTAGE_SATS > recipientDust
            ? DEFAULT_POSTAGE_SATS : recipientDust,
          sourceChangeMinimumSats: economicChangeThreshold(template.scriptPubKey, feeRate),
        };
      }));
    } catch (error) {
      if (error instanceof OrdinalBatchPlanError) {
        const source = error.outpoint ? ` ${outpointKey(error.outpoint)}` : '';
        if (error.reason === 'incomplete_source') {
          throw new RpcError('ERR_UNSAFE_TRANSACTION', `select every inscription from output${source}`);
        }
        if (error.reason === 'multiple_top_ups') {
          throw new RpcError('ERR_CLEAN_FEE_INPUTS_UNAVAILABLE', 'multiple inscription sources require postage top-up');
        }
        throw new RpcError('ERR_UNSAFE_TRANSACTION', error.message);
      }
      throw error;
    }

    const sourceByKey = new Map(sources.map((entry) => [outpointKey(entry.source.outpoint), entry.source]));
    const protectedInputs = routing.sources.map((sourcePlan) => {
      const source = sourceByKey.get(`${sourcePlan.txid}:${sourcePlan.vout}`);
      if (!source) throw new RpcError('ERR_UNSAFE_TRANSACTION', 'batch source order changed');
      return inputFromUtxo(
        source,
        this.deriveForUtxo(definition, source),
        sequenceForInput('ordinal_batch_transfer'),
      );
    });
    const outputs: PlanOutput[] = [];
    const protectedSatFlow: TransactionPlan['protectedSatFlow'] = [];
    for (let inputIndex = 0; inputIndex < routing.sources.length; inputIndex += 1) {
      const sourcePlan = routing.sources[inputIndex]!;
      let templateAvailable = true;
      const sourceOutputBase = outputs.length;
      for (const output of sourcePlan.outputs) {
        if (output.role === 'postage') {
          outputs.push({
            address: recipient.address,
            scriptPubKey: recipient.scriptPubKey,
            valueSats: output.valueSats,
            role: 'postage',
          });
          continue;
        }
        let change = sourceChangeTemplates.get(`${sourcePlan.txid}:${sourcePlan.vout}`)!;
        if (!templateAvailable) {
          change = await this.reserveOutputLocked(
            vaultId, definition, 'payment', input.account, 'payment_change',
          );
        }
        templateAvailable = false;
        outputs.push({ ...change, valueSats: output.valueSats });
      }
      for (const group of sourcePlan.groups) {
        for (const inscriptionId of group.inscriptionIds) {
          protectedSatFlow.push({
            inputIndex,
            inputOffset: group.inputOffset,
            outputIndex: sourceOutputBase + group.sourceOutputIndex,
            outputOffset: group.outputOffset,
            inscriptionId,
          });
        }
      }
    }

    const finalPaymentChange = await this.reserveOutputLocked(
      vaultId, definition, 'payment', input.account, 'payment_change',
    );
    const topUpSats = routing.sources.reduce(
      (sum, source) => sum + source.requiredTopUpSats, 0n,
    );
    const protectedInputFee = feeForVsize(protectedInputs.reduce(
      (sum, entry) => sum + inputVbytes(entry.scriptPubKey), 0n,
    ), feeRate);
    let selection;
    try {
      selection = selectCoins({
        utxos,
        eligibility,
        accountId: input.accountId,
        account: input.account,
        feeRate,
        targetSats: topUpSats + protectedInputFee,
        recipientScripts: outputs.map((output) => output.scriptPubKey),
        changeScript: finalPaymentChange.scriptPubKey,
        sendMax: false,
      });
    } catch {
      throw new RpcError(
        'ERR_CLEAN_FEE_INPUTS_UNAVAILABLE',
        'cardinal-clean payment inputs cannot cover batch postage and miner fee',
      );
    }
    if (selection.inputs.some((utxo) =>
      utxo.lane !== 'payment' || utxo.facts?.primaryClass !== 'cardinal_clean')) {
      throw new RpcError('ERR_UNSAFE_TRANSACTION', 'protected input selected for batch funding');
    }
    const feeInputs = selection.inputs.map((utxo) => inputFromUtxo(
      utxo,
      this.deriveForUtxo(definition, utxo),
      sequenceForInput('ordinal_batch_transfer'),
    ));
    const inputs = [...protectedInputs, ...feeInputs];
    if (selection.changeSats > 0n) {
      outputs.push({ ...finalPaymentChange, valueSats: selection.changeSats });
    }
    const vsize = estimateVsize(
      inputs.map((entry) => entry.scriptPubKey),
      outputs.map((output) => output.scriptPubKey),
    );
    const totalInputSats = inputs.reduce((sum, entry) => sum + entry.valueSats, 0n);
    const totalOutputSats = outputs.reduce((sum, output) => sum + output.valueSats, 0n);
    const feeSats = totalInputSats - totalOutputSats;
    if (feeSats < feeForVsize(vsize, feeRate)) {
      throw new RpcError('ERR_UNSAFE_TRANSACTION', 'batch fee is below the approved rate');
    }
    return {
      account: input.account,
      inputs,
      outputs,
      feeSats,
      vsize,
      protectedSatFlow,
      rbf: false,
      parentTxid: null,
      replacesTxid: null,
      canonicalRecipient: recipient.address,
    };
  }

  private async buildOrdinalPostageManageLocked(
    vaultId: string,
    definition: PublicAccountDefinitionV1,
    input: Extract<TransactionPlanRequest, { kind: 'ordinal_postage_manage' }>,
    utxos: WalletUtxo[],
    eligibility: EligibilityContext,
    feeRate: bigint,
  ) {
    const selections = canonicalOrdinalBatchSelections(input.selections);
    const ordinalTemplate = this.stableOutput(
      definition, 'ordinals', input.account, 'postage',
    );
    const paymentTemplates: PlanOutput[] = [];
    const sources = selections.map((selection) => {
      const key = outpointKey(selection.outpoint);
      const source = utxos.find((utxo) =>
        utxo.account === input.account && outpointKey(utxo.outpoint) === key);
      if (!source || source.accountId !== input.accountId || source.lane !== 'ordinals' ||
          source.height === null || source.flags.userFrozen || source.flags.dustQuarantined ||
          source.facts?.confidence !== 'authoritative' ||
          source.facts.classificationRevision !== eligibility.activeRevision ||
          selection.classificationRevision !== source.facts.classificationRevision ||
          !eligibility.freshness.spendEligible || source.facts.primaryClass !== 'inscribed' ||
          source.facts.unsupportedAssetDetected || source.facts.inscriptions.length !== 1 ||
          source.facts.inscriptions[0]?.inscriptionId !== selection.inscriptionId ||
          source.facts.inscriptions[0]?.satpoint !== selection.satpoint ||
          source.facts.satRanges === null ||
          source.facts.satRanges.some((range) =>
            range.rarity !== undefined && range.rarity !== 'common') ||
          eligibility.lockedOutpoints.has(key)) {
        throw new RpcError('ERR_UNSAFE_TRANSACTION', `postage source ${key} is not eligible`);
      }
      return source;
    });
    for (let index = 0; index < sources.length; index += 1) {
      paymentTemplates.push(await this.reserveOutputLocked(
        vaultId, definition, 'payment', input.account, 'payment_change',
      ));
    }
    let routing;
    try {
      routing = planOrdinalPostageManage(sources.map((source, index) => ({
        selection: selections[index]!,
        valueSats: source.valueSats,
        classificationRevision: source.facts!.classificationRevision,
        inscriptionIds: source.facts!.inscriptions.map((item) => item.inscriptionId),
        ordinalOutputDustSats: scriptDustSats(ordinalTemplate.scriptPubKey),
        paymentChangeDustSats: scriptDustSats(paymentTemplates[index]!.scriptPubKey),
      })), input.target);
    } catch (error) {
      if (error instanceof OrdinalPostagePlanError) {
        throw new RpcError(
          error.reason === 'multiple_top_ups'
            ? 'ERR_CLEAN_FEE_INPUTS_UNAVAILABLE'
            : 'ERR_UNSAFE_TRANSACTION',
          error.message,
        );
      }
      throw error;
    }
    const sourceByKey = new Map(sources.map((source) => [outpointKey(source.outpoint), source]));
    const protectedInputs = routing.sources.map((planned) => {
      const source = sourceByKey.get(outpointKey(planned.selection.outpoint));
      if (!source) throw new RpcError('ERR_UNSAFE_TRANSACTION', 'postage source order changed');
      return inputFromUtxo(
        source, this.deriveForUtxo(definition, source), sequenceForInput('ordinal_postage_manage'),
      );
    });
    const outputs: PlanOutput[] = [];
    const protectedSatFlow: TransactionPlan['protectedSatFlow'] = [];
    for (let index = 0; index < routing.sources.length; index += 1) {
      const planned = routing.sources[index]!;
      outputs.push({ ...ordinalTemplate, valueSats: planned.retainedPostageSats });
      protectedSatFlow.push({
        inputIndex: index,
        inputOffset: 0n,
        outputIndex: outputs.length - 1,
        outputOffset: 0n,
        inscriptionId: planned.selection.inscriptionId,
      });
      if (planned.returnedBtcSats > 0n) {
        const template = paymentTemplates[index]!;
        outputs.push({ ...template, valueSats: planned.returnedBtcSats });
      }
    }
    const finalPaymentChange = await this.reserveOutputLocked(
      vaultId, definition, 'payment', input.account, 'payment_change',
    );
    const protectedInputFee = feeForVsize(protectedInputs.reduce(
      (sum, entry) => sum + inputVbytes(entry.scriptPubKey), 0n,
    ), feeRate);
    let selection;
    try {
      selection = selectCoins({
        utxos,
        eligibility,
        accountId: input.accountId,
        account: input.account,
        feeRate,
        targetSats: routing.requiredTopUpSats + protectedInputFee,
        recipientScripts: outputs.map((output) => output.scriptPubKey),
        changeScript: finalPaymentChange.scriptPubKey,
        sendMax: false,
      });
    } catch {
      throw new RpcError(
        'ERR_CLEAN_FEE_INPUTS_UNAVAILABLE',
        'clean bitcoin cannot cover postage and the network fee',
      );
    }
    if (selection.inputs.some((utxo) =>
      utxo.lane !== 'payment' || utxo.facts?.primaryClass !== 'cardinal_clean')) {
      throw new RpcError('ERR_UNSAFE_TRANSACTION', 'protected input selected for postage funding');
    }
    const feeInputs = selection.inputs.map((utxo) => inputFromUtxo(
      utxo,
      this.deriveForUtxo(definition, utxo),
      sequenceForInput('ordinal_postage_manage'),
    ));
    const inputs = [...protectedInputs, ...feeInputs];
    if (selection.changeSats > 0n) {
      outputs.push({ ...finalPaymentChange, valueSats: selection.changeSats });
    }
    const vsize = estimateVsize(
      inputs.map((entry) => entry.scriptPubKey),
      outputs.map((output) => output.scriptPubKey),
    );
    const totalInputSats = inputs.reduce((sum, entry) => sum + entry.valueSats, 0n);
    const totalOutputSats = outputs.reduce((sum, output) => sum + output.valueSats, 0n);
    const feeSats = totalInputSats - totalOutputSats;
    if (feeSats < feeForVsize(vsize, feeRate)) {
      throw new RpcError('ERR_UNSAFE_TRANSACTION', 'postage transaction fee is below the approved rate');
    }
    if (routing.returnedBtcSats > 0n && routing.returnedBtcSats <= feeSats) {
      throw new RpcError('ERR_NO_SWEEPABLE_EXCESS', 'recovering this bitcoin would cost at least as much as it returns');
    }
    return {
      account: input.account,
      inputs,
      outputs,
      feeSats,
      vsize,
      protectedSatFlow,
      rbf: false,
      parentTxid: null,
      replacesTxid: null,
    };
  }

  private async buildConsolidationLocked(
    vaultId: string, definition: PublicAccountDefinitionV1,
    input: Extract<TransactionPlanRequest, { kind: 'consolidation' }>,
    utxos: WalletUtxo[], eligibility: EligibilityContext, feeRate: bigint,
  ) {
    const change = await this.reserveOutputLocked(
      vaultId, definition, 'payment', input.account, 'payment_change',
    );
    const selected = new Set(input.selectedOutpoints.map((entry) => `${entry.txid}:${entry.vout}`));
    let selection;
    try {
      selection = selectCoins({ utxos, eligibility, accountId: input.accountId,
        account: input.account, feeRate, targetSats: 0n,
        recipientScripts: [], changeScript: change.scriptPubKey, sendMax: false, selectedOutpoints: selected });
    } catch (error) {
      // Carry the reason like the native-send path does. A bare code reads as
      // "not enough money" even when the real cause is a selected input the
      // §11.2 predicate or the account filter rejected.
      throw new RpcError('ERR_INSUFFICIENT_FUNDS', error instanceof Error ? error.message : undefined);
    }
    if (selection.inputs.length < 2 || selection.changeSats <= 0n) throw new RpcError('ERR_INVALID_PAYLOAD', 'consolidation needs two economic inputs');
    return {
      account: input.account,
      inputs: selection.inputs.map((utxo) => inputFromUtxo(
        utxo, this.deriveForUtxo(definition, utxo), sequenceForInput('consolidation'),
      )),
      outputs: [{ ...change, valueSats: selection.changeSats }],
      feeSats: selection.feeSats, vsize: selection.vsize, protectedSatFlow: [], rbf: true,
      parentTxid: null, replacesTxid: null,
    };
  }

  private async buildRescueLocked(
    vaultId: string, definition: PublicAccountDefinitionV1,
    input: Extract<TransactionPlanRequest, { kind: 'rescue' }>,
    utxos: WalletUtxo[], eligibility: EligibilityContext, feeRate: bigint,
  ) {
    const required = utxos.find((u) => outpointKey(u.outpoint) === `${input.outpoint.txid}:${input.outpoint.vout}`);
    if (!required || laneState(required) !== 'protected_wrong_address' || required.height === null ||
        required.facts?.primaryClass !== 'inscribed' || required.facts.inscriptions.length !== 1 ||
        required.facts.unsupportedAssetDetected || eligibility.lockedOutpoints.has(outpointKey(required.outpoint))) {
      throw new RpcError('ERR_UNSAFE_TRANSACTION', 'inscription cannot be rescued safely');
    }
    const inscription = required.facts.inscriptions[0]!;
    const parts = inscription.satpoint.split(':');
    const offset = parts.length === 3 ? BigInt(parts[2] ?? '-1') : -1n;
    if (parts[0] !== required.outpoint.txid || Number(parts[1]) !== required.outpoint.vout || offset < 0n || offset >= required.valueSats) {
      throw new RpcError('ERR_UNSAFE_TRANSACTION', 'unprovable current satpoint');
    }
    const ordinal = this.stableOutput(definition, 'ordinals', required.account, 'postage');
    const paymentChange = await this.reserveOutputLocked(
      vaultId, definition, 'payment', required.account, 'payment_change',
    );
    const postage = offset + 1n > DEFAULT_POSTAGE_SATS ? offset + 1n : DEFAULT_POSTAGE_SATS;
    const protectedInput = inputFromUtxo(
      required, this.deriveForUtxo(definition, required), sequenceForInput('rescue'),
    );
    let feeInputs: WalletUtxo[] = [];
    const baseVsize = estimateVsize([required.scriptPubKey], [ordinal.scriptPubKey, paymentChange.scriptPubKey]);
    if (required.valueSats < postage + feeForVsize(baseVsize, feeRate)) {
      const shortage = postage + inputVbytes(required.scriptPubKey) * feeRate - required.valueSats;
      try {
        feeInputs = selectCoins({ utxos, eligibility, accountId: required.accountId!,
          account: required.account, feeRate,
          targetSats: shortage > 0n ? shortage : 0n, recipientScripts: [ordinal.scriptPubKey],
          changeScript: paymentChange.scriptPubKey, sendMax: false }).inputs;
      } catch {
        throw new RpcError(
          'ERR_CLEAN_FEE_INPUTS_UNAVAILABLE',
          'cardinal-clean payment fee inputs are unavailable',
        );
      }
    }
    const inputs = [protectedInput, ...feeInputs.map((u) => inputFromUtxo(
      u, this.deriveForUtxo(definition, u), sequenceForInput('rescue'),
    ))];
    let vsize = estimateVsize(inputs.map((i) => i.scriptPubKey), [ordinal.scriptPubKey, paymentChange.scriptPubKey]);
    let minimumFee = feeForVsize(vsize, feeRate);
    const total = inputs.reduce((sum, entry) => sum + entry.valueSats, 0n);
    let change = total - postage - minimumFee;
    const outputs: PlanOutput[] = [{ ...ordinal, valueSats: postage }];
    let feeSats = minimumFee;
    if (change > economicChangeThreshold(paymentChange.scriptPubKey, feeRate)) {
      outputs.push({ ...paymentChange, valueSats: change });
    } else {
      vsize = estimateVsize(inputs.map((i) => i.scriptPubKey), [ordinal.scriptPubKey]);
      minimumFee = feeForVsize(vsize, feeRate);
      change = total - postage - minimumFee;
      if (change < 0n) throw new RpcError('ERR_INSUFFICIENT_FUNDS');
      feeSats = total - postage;
    }
    return { account: required.account, inputs, outputs, feeSats, vsize,
      protectedSatFlow: [{ inputIndex: 0, inputOffset: offset, outputIndex: 0, outputOffset: offset, inscriptionId: inscription.inscriptionId }],
      rbf: false, parentTxid: null, replacesTxid: null };
  }

  private async buildSweepLocked(
    vaultId: string, definition: PublicAccountDefinitionV1,
    input: Extract<TransactionPlanRequest, { kind: 'ordinal_sweep' }>,
    utxos: WalletUtxo[], eligibility: EligibilityContext, feeRate: bigint,
  ) {
    const required = utxos.find((u) => outpointKey(u.outpoint) === `${input.outpoint.txid}:${input.outpoint.vout}`);
    if (!required || laneState(required) !== 'reserved_ordinal_lane_btc' || required.height === null ||
        required.flags.userFrozen || required.flags.dustQuarantined ||
        required.facts?.classificationRevision !== eligibility.activeRevision || !eligibility.freshness.spendEligible ||
        eligibility.lockedOutpoints.has(outpointKey(required.outpoint)) ||
        !evaluateEligibility(required, eligibility).eligible) {
      throw new RpcError('ERR_UNSAFE_TRANSACTION', 'ordinal-lane value cannot be swept');
    }
    const ordinal = await this.reserveOutputLocked(
      vaultId, definition, 'ordinals', required.account, 'ordinal_change',
    );
    const payment = await this.reserveOutputLocked(
      vaultId, definition, 'payment', required.account, 'payment_change',
    );
    const vsize = estimateVsize([required.scriptPubKey], [ordinal.scriptPubKey, payment.scriptPubKey]);
    const feeSats = feeForVsize(vsize, feeRate);
    const excess = required.valueSats - DEFAULT_POSTAGE_SATS - feeSats;
    if (excess <= economicChangeThreshold(payment.scriptPubKey, feeRate)) {
      throw new RpcError('ERR_NO_SWEEPABLE_EXCESS', 'no economic excess to sweep');
    }
    return { account: required.account,
      inputs: [inputFromUtxo(
        required, this.deriveForUtxo(definition, required), sequenceForInput('ordinal_sweep'),
      )],
      outputs: [{ ...ordinal, valueSats: DEFAULT_POSTAGE_SATS }, { ...payment, valueSats: excess }],
      feeSats, vsize, protectedSatFlow: [], rbf: false, parentTxid: null, replacesTxid: null };
  }

  private async buildRbfLocked(
    dek: Uint8Array, vaultId: string, definition: PublicAccountDefinitionV1,
    input: Extract<TransactionPlanRequest, { kind: 'rbf' }>,
    utxos: WalletUtxo[], eligibility: EligibilityContext, feeRate: bigint,
    incrementalRelayFeeRate: bigint,
  ) {
    const parent = (await this.loadTransactionsLocked(dek, vaultId)).find((tx) => tx.txid === input.txid);
    if (!parent || !isCurrentStoredTransaction(parent) || !parent.plan.rbf ||
        parent.status === 'conflicted' || parent.status === 'rejected') {
      throw new RpcError('ERR_NOT_ACCELERATABLE', 'transaction is not replaceable');
    }
    await this.assertPendingRbfParent(parent);
    const original = parent.plan;
    const currentByOutpoint = new Map(utxos.map((u) => [outpointKey(u.outpoint), u]));
    const replacementInputs: PlanInput[] = [];
    for (const oldInput of original.inputs) {
      const key = `${oldInput.txid}:${oldInput.vout}`;
      const current = currentByOutpoint.get(key);
      if (current) {
        const rebuilt = inputFromUtxo(
          current,
          this.deriveForUtxo(definition, current),
          sequenceForInput('rbf', oldInput.sequence),
        );
        if (!evaluateEligibility(current, eligibility).eligible ||
            !rbfInputMatchesParent(rebuilt, oldInput)) {
          throw new RpcError('ERR_NOT_ACCELERATABLE', 'original input state changed');
        }
        replacementInputs.push(rebuilt);
        continue;
      }
      const derivation = oldInput.derivation;
      if (oldInput.ownership !== 'wallet' || derivation === null ||
          derivation.accountId !== original.accountId || derivation.account !== original.account ||
          oldInput.classification.primaryClass !== 'cardinal_clean' ||
          oldInput.classification.confidence !== 'authoritative' ||
          oldInput.classification.classificationRevision !== eligibility.activeRevision ||
          eligibility.lockedOutpoints.has(key)) {
        throw new RpcError('ERR_NOT_ACCELERATABLE', 'original input authority changed');
      }
      const derived = derivePublicAccountAddress(
        definition,
        derivation.lane,
        derivation.chain,
        derivation.index,
      );
      if (derived.scriptPubKeyHex !== oldInput.scriptPubKey ||
          derived.path !== derivation.path || derived.publicKeyHex !== derivation.publicKeyHex) {
        throw new RpcError('ERR_NOT_ACCELERATABLE', 'original input ownership changed');
      }
      replacementInputs.push({
        ...oldInput,
        sequence: sequenceForInput('rbf', oldInput.sequence),
      });
    }
    const recipientOutputs = original.outputs.filter((o) => o.role === 'recipient');
    const originalChange = original.outputs.find((o) => o.role === 'payment_change');
    if (!originalChange) throw new RpcError('ERR_NOT_ACCELERATABLE', 'replacement has no reducible change');
    const originalKeys = new Set(replacementInputs.map((entry) => `${entry.txid}:${entry.vout}`));
    const additions = utxos
      .filter((utxo) => !originalKeys.has(outpointKey(utxo.outpoint)))
      .filter((utxo) => utxo.account === original.account && utxo.lane === 'payment')
      .filter((utxo) => evaluateEligibility(utxo, eligibility).eligible)
      .sort((a, b) => outpointKey(a.outpoint).localeCompare(outpointKey(b.outpoint)));
    const recipientTotal = recipientOutputs.reduce((sum, output) => sum + output.valueSats, 0n);
    let vsize = 0n;
    let feeSats = 0n;
    let newChange = 0n;
    for (;;) {
      vsize = estimateVsize(
        replacementInputs.map((entry) => entry.scriptPubKey),
        [...recipientOutputs, originalChange].map((output) => output.scriptPubKey),
      );
      const targetFee = feeForVsize(vsize, feeRate);
      const incremental = original.feeSats + feeForVsize(vsize, incrementalRelayFeeRate);
      feeSats = targetFee > incremental ? targetFee : incremental;
      const total = replacementInputs.reduce((sum, entry) => sum + entry.valueSats, 0n);
      newChange = total - recipientTotal - feeSats;
      if (newChange > economicChangeThreshold(originalChange.scriptPubKey, feeRate)) break;
      const addition = additions.shift();
      if (!addition) throw new RpcError('ERR_INSUFFICIENT_FUNDS', 'eligible inputs cannot fund replacement fee');
      replacementInputs.push(inputFromUtxo(
        addition,
        this.deriveForUtxo(definition, addition),
        sequenceForInput('rbf'),
      ));
    }
    return {
      account: original.account,
      inputs: replacementInputs,
      outputs: [...recipientOutputs, { ...originalChange, valueSats: newChange }],
      feeSats, vsize, protectedSatFlow: [], rbf: true, parentTxid: null, replacesTxid: parent.txid,
    };
  }

  private async buildCpfpLocked(
    dek: Uint8Array, vaultId: string, definition: PublicAccountDefinitionV1,
    input: Extract<TransactionPlanRequest, { kind: 'cpfp' }>,
    utxos: WalletUtxo[], eligibility: EligibilityContext, feeRate: bigint,
  ) {
    const history = (await this.loadHistoryLocked(
      dek, vaultId, definition.accountId,
    )).find((entry) => entry.txid === input.txid);
    if (!history?.cpfpEligible || history.packageFeeSats === null || history.packageVsize === null) {
      throw new RpcError('ERR_NOT_ACCELERATABLE', 'parent package metadata unavailable');
    }
    const childInput = utxos.find((u) => u.outpoint.txid === input.txid && u.walletCreatedChange);
    if (!childInput || !evaluateEligibility(childInput, eligibility).eligible) {
      throw new RpcError('ERR_NOT_ACCELERATABLE', 'no eligible wallet change output');
    }
    const output = await this.reserveOutputLocked(
      vaultId, definition, 'payment', childInput.account, 'payment_change',
    );
    const vsize = estimateVsize([childInput.scriptPubKey], [output.scriptPubKey]);
    const packageFee = BigInt(history.packageFeeSats);
    const totalPackageFee = feeForVsize(BigInt(history.packageVsize) + vsize, feeRate);
    const packageTarget = totalPackageFee > packageFee ? totalPackageFee - packageFee : 0n;
    const standalone = feeForVsize(vsize, feeRate);
    const feeSats = packageTarget > standalone ? packageTarget : standalone;
    const amount = childInput.valueSats - feeSats;
    if (amount <= economicChangeThreshold(output.scriptPubKey, feeRate)) {
      throw new RpcError('ERR_INSUFFICIENT_FUNDS', 'CPFP output would be uneconomic');
    }
    return {
      account: childInput.account,
      inputs: [inputFromUtxo(
        childInput, this.deriveForUtxo(definition, childInput), sequenceForInput('cpfp'),
      )],
      outputs: [{ ...output, valueSats: amount }], feeSats, vsize, protectedSatFlow: [],
      rbf: true, parentTxid: input.txid, replacesTxid: null,
    };
  }

  private deriveForUtxo(
    source: Uint8Array | PublicAccountDefinitionV1,
    utxo: WalletUtxo,
  ): PlanDerivation {
    if (!(source instanceof Uint8Array)) {
      if (source.accountId !== utxo.accountId ||
          source.derivationAccountIndex !== utxo.account) {
        throw new RpcError('ERR_UNSAFE_TRANSACTION', 'cached prevout account mismatch');
      }
      const info = derivePublicAccountAddress(
        source, utxo.lane, utxo.chain, utxo.addressIndex,
      );
      if (info.scriptPubKeyHex !== utxo.scriptPubKey) {
        throw new RpcError('ERR_UNSAFE_TRANSACTION', 'cached prevout ownership mismatch');
      }
      return {
        accountId: source.accountId,
        account: utxo.account,
        lane: utxo.lane,
        chain: utxo.chain,
        index: utxo.addressIndex,
        path: info.path,
        publicKeyHex: info.publicKeyHex,
      };
    }
    const seed = source;
    const account = deriveAccountNode(seed, utxo.lane, this.deps.network, utxo.account);
    const chain = account.deriveChild(utxo.chain);
    const key = chain.deriveChild(utxo.addressIndex);
    try {
      if (!key.publicKey) throw new RpcError('ERR_UNSAFE_TRANSACTION', 'derived key unavailable');
      const publicKeyHex = rawBytesToHex(key.publicKey);
      if (scriptPubKeyHex(publicKeyHex, utxo.lane, this.deps.network) !== utxo.scriptPubKey) {
        throw new RpcError('ERR_UNSAFE_TRANSACTION', 'cached prevout ownership mismatch');
      }
      return {
        accountId: utxo.accountId,
        account: utxo.account, lane: utxo.lane, chain: utxo.chain, index: utxo.addressIndex,
        path: this.utxoPath(utxo), publicKeyHex,
      };
    } finally {
      key.wipePrivateData(); chain.wipePrivateData(); account.wipePrivateData();
    }
  }

  private utxoPath(utxo: WalletUtxo): string {
    const purpose = utxo.lane === 'payment' ? 84 : 86;
    const coin = this.deps.network === 'mainnet' ? 0 : 1;
    return `m/${purpose}'/${coin}'/${utxo.account}'/${utxo.chain}/${utxo.addressIndex}`;
  }

  private async reserveOutputLocked<
    Lane extends 'payment' | 'ordinals',
    Role extends 'payment_change' | 'ordinal_change',
  >(
    vaultId: string,
    source: Uint8Array | PublicAccountDefinitionV1,
    lane: Lane,
    accountIndex: number,
    role: Role,
  ): Promise<PlanOutput & {
    role: Role;
    derivation: PlanDerivation & { lane: Lane; chain: 1 };
  }> {
    const accountId = source instanceof Uint8Array
      ? publicAccountFromSeed(source, this.deps.network, accountIndex).accountId
      : source.accountId;
    const state = await loadDerivationState(
      this.deps.local,
      vaultId,
      this.deps.network,
      lane,
      accountIndex,
      accountId,
      accountId === undefined,
    );
    const reserved = await reserveChangeIndexPersisted(
      this.deps.local, vaultId, state, accountId,
    );
    if (!(source instanceof Uint8Array)) {
      const info = derivePublicAccountAddress(source, lane, 1, reserved.index);
      const derivation: PlanDerivation & { lane: Lane; chain: 1 } = {
        accountId: source.accountId,
        account: accountIndex,
        lane,
        chain: 1,
        index: reserved.index,
        path: info.path,
        publicKeyHex: info.publicKeyHex,
      };
      return {
        address: info.address,
        scriptPubKey: info.scriptPubKeyHex,
        valueSats: 0n,
        role,
        derivation,
      };
    }
    const seed = source;
    const account = deriveAccountNode(seed, lane, this.deps.network, accountIndex);
    try {
      const info = deriveAddress(account, lane, this.deps.network, 1, reserved.index);
      const derivation: PlanDerivation & { lane: Lane; chain: 1 } = {
        accountId, account: accountIndex, lane, chain: 1, index: reserved.index, path: info.path,
        publicKeyHex: info.publicKeyHex,
      };
      return { address: info.address, scriptPubKey: scriptPubKeyHex(info.publicKeyHex, lane, this.deps.network),
        valueSats: 0n, role, derivation };
    } finally { account.wipePrivateData(); }
  }

  private stableOutput(
    source: Uint8Array | PublicAccountDefinitionV1,
    lane: 'payment' | 'ordinals',
    accountIndex: number,
    role: 'postage',
  ): PlanOutput & { derivation: PlanDerivation } {
    if (!(source instanceof Uint8Array)) {
      const info = derivePublicAccountAddress(source, lane, 0, 0);
      return {
        address: info.address,
        scriptPubKey: info.scriptPubKeyHex,
        valueSats: 0n,
        role,
        derivation: {
          accountId: source.accountId,
          account: accountIndex,
          lane,
          chain: 0,
          index: 0,
          path: info.path,
          publicKeyHex: info.publicKeyHex,
        },
      };
    }
    const seed = source;
    const account = deriveAccountNode(seed, lane, this.deps.network, accountIndex);
    try {
      const info = deriveAddress(account, lane, this.deps.network, 0, 0);
      return {
        address: info.address, scriptPubKey: scriptPubKeyHex(info.publicKeyHex, lane, this.deps.network),
        valueSats: 0n, role,
        derivation: { account: accountIndex, lane, chain: 0, index: 0, path: info.path, publicKeyHex: info.publicKeyHex },
      };
    } finally { account.wipePrivateData(); }
  }

  private async savePlanLocked(dek: Uint8Array, vaultId: string, plan: TransactionPlan): Promise<void> {
    await this.requireCache().put(sealRecord(dek, plan, this.cacheKey(vaultId, 'plans', plan.planId),
      this.deps.vaultDeps.random(24), this.deps.vaultDeps.now()));
  }

  private async loadPlanLocked(dek: Uint8Array, vaultId: string, planId: string): Promise<TransactionPlan | null> {
    const record = await this.requireCache().get(this.cacheKey(vaultId, 'plans', planId));
    if (!record) return null;
    try {
      const plan = openRecord(dek, record, storedPlanSchema);
      if (plan.version === 4) {
        assertPlanHash(plan);
        return plan;
      }
      // M9P preview binding cannot be reconstructed from a legacy pending
      // approval. Validate its old hash so corrupt cache data is still
      // rejected, then force the caller to build a fresh plan.
      if (plan.version === 3) assertLegacyCurrentPlanHash(plan);
      else if (plan.version === 2) assertLegacyAnalyzedPlanHash(plan);
      else assertLegacyPlanHash(plan);
      return null;
    } catch { return null; }
  }

  private async loadLockedOutpointsLocked(dek: Uint8Array, vaultId: string): Promise<Set<string>> {
    const cache = this.requireCache();
    const ids = await cache.listKeys(vaultId, this.deps.network, 'plans');
    const locked = new Set<string>();
    for (const id of ids) {
      const plan = await this.loadPlanLocked(dek, vaultId, id);
      if (!plan || plan.expiresAt <= this.deps.vaultDeps.now()) {
        await cache.delete(this.cacheKey(vaultId, 'plans', id));
        this.nativeInscriptionPreviews.delete(id);
        continue;
      }
      for (const entry of plan.inputs) locked.add(`${entry.txid}:${entry.vout}`);
    }
    const reservationIds = await cache.listKeys(vaultId, this.deps.network, 'marketplaceReservations');
    for (const outpoint of reservationIds) {
      const record = await cache.get(this.cacheKey(vaultId, 'marketplaceReservations', outpoint));
      if (!record) continue;
      try {
        const reservation = openRecord(dek, record, marketplaceReservationSchema);
        if (reservation.releasedAt === null) locked.add(reservation.outpoint);
      } catch {
        // A corrupt durable reservation cannot be treated as released. Its
        // cache key is the outpoint and remains conservatively unavailable.
        if (/^[0-9a-f]{64}:[0-9]+$/u.test(outpoint)) locked.add(outpoint);
      }
    }
    const workflowIds = await cache.listKeys(vaultId, this.deps.network, 'marketplaceWorkflows');
    for (const workflowId of workflowIds) {
      const record = await cache.get(this.cacheKey(vaultId, 'marketplaceWorkflows', workflowId));
      if (!record) continue;
      try {
        const workflows = workflowId.startsWith('group:')
          ? openRecord(dek, record, marketplaceWorkflowGroupJournalSchema).entries.map(
              (entry) => entry.journal.workflow,
            )
          : [openRecord(dek, record, marketplaceWorkflowJournalSchema).workflow];
        for (const workflow of workflows) {
          if (['signed_undelivered', 'delivered_site_broadcast', 'wallet_broadcast_pending'].includes(workflow.state)) {
            for (const outpoint of workflow.reservedOutpoints) locked.add(outpoint);
          }
        }
      } catch {
        // Durable reservation records remain authoritative if a workflow is
        // unreadable; a corrupt journal never actively releases an outpoint.
      }
    }
    return locked;
  }

  private assertLivePlan(plan: TransactionPlan): void {
    assertPlanHash(plan);
    if (plan.network !== this.deps.network) throw new RpcError('ERR_PLAN_CHANGED', 'network changed');
    if (plan.expiresAt <= this.deps.vaultDeps.now()) throw new RpcError('ERR_PLAN_EXPIRED');
  }

  private async livePreviewsForPlan(
    plan: TransactionPlan,
    forceRefetch = false,
  ): Promise<{ analysis: import('@drey/core/domain/transactions/analysis').TransactionAnalysis; previews: InscriptionPreviewSet }> {
    const analyzed = analyzePsbtHex(plan.psbtHex, analysisContextFromPlan(plan));
    if (!analyzed.ok || analyzed.analysisHash !== plan.analysisHash ||
        analyzed.analysis.hardViolations.length > 0 ||
        analyzed.analysis.assetEffects.effectSetHash !== plan.inscriptionPreviews.effectSetHash ||
        transactionCommitmentHash(plan) !== plan.transactionCommitmentHash ||
        plan.inscriptionPreviews.transactionCommitmentHash !== plan.transactionCommitmentHash ||
        plan.inscriptionPreviews.analysisHash !== plan.analysisHash ||
        plan.inscriptionPreviews.psbtHash !== plan.psbtHash ||
        plan.inscriptionPreviews.classificationRevision !== plan.source.classificationRevision) {
      throw new RpcError('ERR_PLAN_CHANGED', 'inscription preview plan binding changed');
    }
    const existing = this.nativeInscriptionPreviews.get(plan.planId);
    if (!forceRefetch && existing) {
      approvalInscriptionItems(analyzed.analysis, existing);
      return { analysis: analyzed.analysis, previews: existing };
    }
    if (analyzed.analysis.assetEffects.inscriptions.length === 0) {
      const empty: InscriptionPreviewSet = { ...plan.inscriptionPreviews, items: [] };
      this.nativeInscriptionPreviews.set(plan.planId, empty);
      return { analysis: analyzed.analysis, previews: empty };
    }
    const gateway = this.deps.gateway;
    if (!gateway || gateway.endpoint !== plan.source.backend) {
      throw new RpcError('ERR_PLAN_CHANGED', 'approved preview backend unavailable');
    }
    const request = inscriptionApprovalRequest({
      network: plan.network,
      analysis: analyzed.analysis,
      analysisHash: plan.analysisHash,
      psbtHash: plan.psbtHash,
      transactionCommitmentHash: plan.transactionCommitmentHash,
    });
    const fetched = await gateway.fetchInscriptionApprovalBatch(request);
    if (!fetched.ok || fetched.value.instanceId !== plan.source.instanceId ||
        !tipsEqual(fetched.value.coreTip, plan.source.coreTip) ||
        !tipsEqual(fetched.value.indexTip, plan.source.indexTip)) {
      throw new RpcError('ERR_PLAN_CHANGED', 'signed inscription previews changed');
    }
    const live = bindInscriptionPreviews({
      request,
      response: fetched.value,
      verifiedAtMs: fetched.verifiedAtMs,
    });
    const restorable = storedPreviewSet(live);
    const expectedStored = { ...plan.inscriptionPreviews, verifiedAtMs: restorable.verifiedAtMs };
    if (JSON.stringify(restorable) !== JSON.stringify(expectedStored)) {
      throw new RpcError('ERR_PLAN_CHANGED', 'inscription preview provenance changed');
    }
    approvalInscriptionItems(analyzed.analysis, live);
    this.nativeInscriptionPreviews.set(plan.planId, live);
    return { analysis: analyzed.analysis, previews: live };
  }

  private async planResultLocked(plan: TransactionPlan): Promise<TransactionPlanResult> {
    const config = await loadConfig(this.deps.local);
    const cached = this.deps.gateway
      ? await loadCachedStatus(this.deps.session, this.deps.gateway.endpoint, this.deps.gateway.protocolVersions)
      : null;
    const missingProtections = deriveGatewayView(
      cached,
      this.gatewayLastFailure,
      this.deps.vaultDeps.now(),
    ).missingProtections;
    const { analysis, previews } = await this.livePreviewsForPlan(plan);
    const inscriptions = approvalInscriptionItems(analysis, previews);
    const review = reviewFromPlan(plan, missingProtections, config.highSecurityMode);
    if (review.ordinalAction) {
      if (review.ordinalAction.action === 'batch_transfer') {
        const reviewed = new Set(review.ordinalAction.inscriptionIds);
        if (reviewed.size !== inscriptions.length || inscriptions.some((item) =>
          item.movement !== 'sent' || !reviewed.has(item.inscriptionId))) {
          throw new RpcError('ERR_UNSAFE_TRANSACTION', 'batch review differs from transaction analysis');
        }
      } else if (review.ordinalAction.action === 'transfer' ||
          review.ordinalAction.action === 'rescue' ||
          review.ordinalAction.action === 'sweep') {
        const ordinalAction = review.ordinalAction;
        const target = ordinalAction.inscriptionId === null
          ? null
          : inscriptions.find((item) =>
              item.inscriptionId === ordinalAction.inscriptionId);
        if (
          (ordinalAction.action === 'transfer' && target?.movement !== 'sent') ||
          (ordinalAction.action === 'rescue' && target?.movement !== 'retained') ||
          ordinalAction.retainedInscriptionIds.some((id) =>
            inscriptions.find((item) => item.inscriptionId === id)?.movement !== 'retained') ||
          (ordinalAction.action === 'sweep' && inscriptions.length !== 0)
        ) {
          throw new RpcError(
            'ERR_UNSAFE_TRANSACTION',
            'ordinal review differs from transaction analysis',
          );
        }
      }
    }
    return { planId: plan.planId, planHash: plan.planHash, expiresAt: plan.expiresAt,
      review: {
        ...review,
        effectCount: inscriptions.length,
        inscriptions,
        requiresPreviewAcknowledgement: requiresPreviewAcknowledgement(previews),
      } };
  }

  private async saveRecoveryLocked(dek: Uint8Array, vaultId: string, recovery: BroadcastRecovery): Promise<void> {
    await this.requireCache().put(sealRecord(dek, recovery, this.cacheKey(vaultId, 'broadcastRecovery', recovery.planId),
      this.deps.vaultDeps.random(24), this.deps.vaultDeps.now()));
  }

  private async loadRecoveriesLocked(dek: Uint8Array, vaultId: string): Promise<BroadcastRecovery[]> {
    const cache = this.requireCache();
    const ids = await cache.listKeys(vaultId, this.deps.network, 'broadcastRecovery');
    const out: BroadcastRecovery[] = [];
    for (const id of ids) {
      const record = await cache.get(this.cacheKey(vaultId, 'broadcastRecovery', id));
      if (!record) continue;
      try { out.push(openRecord(dek, record, broadcastRecoverySchema)); } catch { /* rescan/retry cannot trust it */ }
    }
    return out;
  }

  private async loadTransactionsLocked(dek: Uint8Array, vaultId: string): Promise<StoredTransaction[]> {
    const cache = this.requireCache();
    const ids = await cache.listKeys(vaultId, this.deps.network, 'transactions');
    const out: StoredTransaction[] = [];
    for (const id of ids) {
      const record = await cache.get(this.cacheKey(vaultId, 'transactions', id));
      if (!record) continue;
      try { out.push(openRecord(dek, record, storedTransactionSchema)); } catch { /* skip unreadable */ }
    }
    return out;
  }

  private async noteRecoveryFailure(
    input: ActiveSessionRequest, plan: TransactionPlan, failure: string,
  ): Promise<void> {
    await this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const recoveries = await this.loadRecoveriesLocked(dek, session.vaultId);
      const recovery = recoveries.find((entry) => entry.planId === plan.planId);
      if (!recovery) return;
      const attempts = recovery.attempts + 1;
      const delays = [5_000, 30_000, 120_000, 600_000];
      await this.saveRecoveryLocked(dek, session.vaultId, {
        ...recovery, attempts, nextRetryAt: this.deps.vaultDeps.now() + delays[Math.min(attempts - 1, delays.length - 1)]!,
        lastFailure: failure,
      });
    }));
  }

  private async finishBroadcast(
    input: ActiveSessionRequest, plan: TransactionPlan,
    status: 'accepted' | 'already_known' | 'confirmed' | 'conflicted' | 'rejected',
    detail: string | null, txid: string,
  ) {
    await this.runExclusive(() => this.withSessionDek(input, async (dek, session) => {
      const amount = plan.outputs.filter((o) => o.role === 'recipient' || o.role === 'postage').reduce((s,o) => s + o.valueSats, 0n);
      const stored: StoredTransaction = {
        planId: plan.planId, kind: plan.kind, txid, createdAt: plan.createdAt, amountSats: amount,
        feeSats: plan.feeSats, status, detail, parentTxid: plan.parentTxid, replacesTxid: plan.replacesTxid,
        plan,
      };
      await this.requireCache().put(sealRecord(dek, stored, this.cacheKey(session.vaultId, 'transactions', txid),
        this.deps.vaultDeps.random(24), this.deps.vaultDeps.now()));
      await this.requireCache().delete(this.cacheKey(session.vaultId, 'broadcastRecovery', plan.planId));
      await this.requireCache().delete(this.cacheKey(session.vaultId, 'plans', plan.planId));
      if (status === 'accepted' || status === 'already_known' || status === 'confirmed') {
        let addressBook = await this.loadAddressBookLocked(dek, session.vaultId);
        const kind = plan.kind === 'ordinal_transfer' || plan.kind === 'ordinal_batch_transfer' ||
          plan.kind === 'ordinal_postage_manage'
          ? 'ordinal' as const : 'bitcoin' as const;
        for (const address of new Set(plan.outputs
          .filter((output) => output.role === 'recipient' || output.role === 'postage')
          .map((output) => output.address))) {
          addressBook = recordRecentRecipient(addressBook, {
            address, kind, nowMs: this.deps.vaultDeps.now(),
          });
        }
        await this.saveAddressBookLocked(dek, session.vaultId, addressBook);
      }
      this.nativeInscriptionPreviews.delete(plan.planId);
      await this.touchSessionLocked(session);
    }));
    this.notifyWalletDataChanged('transaction');
    return { planId: plan.planId, txid, status, detail };
  }

  // ---- scan internals ------------------------------------------------------

  private async runScanLoop(
    prep: {
      scanId: string;
      scope: ScanScope;
      queue: ScanUnit[];
      done: ScanUnit[];
      activeUnits: ScanUnit[];
      confirmedUnits: ScanUnit[];
      emptyStandardAccountStreak: number;
      standardAccounts: number[];
      boundaryUnits: ScanUnit[];
      revision: string | null;
      hadConflict: boolean;
      historyPartial: boolean;
      maxIndexPerChain: number;
      startedAt: number;
      ring: AccountKeyRing;
      burned: Map<string, number>;
    },
    expectation: ActiveSessionRequest,
  ): Promise<void> {
    const gateway = this.deps.gateway;
    if (!gateway) {
      this.setScanPhase(prep.scanId, { kind: 'failed', scanId: prep.scanId, reason: 'gateway_unavailable' });
      return;
    }
    const ports: ScanUnitPorts = {
      network: this.deps.network,
      snapshot: (req) => gateway.fetchSnapshot(req),
      classify: (req) => gateway.classifyOutpoints(req),
      hashesFor: (unit, chain, from, to) => windowScriptHashes(prep.ring, unit, chain, from, to),
      shouldCancel: () => this.scanCancel,
    };
    let queue = [...prep.queue];
    const done = [...prep.done];
    const activeUnits = new Map(prep.activeUnits.map((unit) => [unitKey(unit), unit]));
    const confirmedUnits = new Map(
      prep.confirmedUnits.map((unit) => [unitKey(unit), unit]),
    );
    const boundaryUnits = [...prep.boundaryUnits];
    let revision: string | null = prep.revision;
    let hadConflict = prep.hadConflict;
    let historyPartial = prep.historyPartial;
    let emptyStandardAccountStreak = prep.emptyStandardAccountStreak;

    const checkpoint = (): ScanCheckpoint => ({
      scanId: prep.scanId,
      scope: prep.scope,
      queue: [...queue],
      done: [...done],
      activeUnits: [...activeUnits.values()],
      confirmedUnits: [...confirmedUnits.values()],
      emptyStandardAccountStreak,
      standardAccounts: [...prep.standardAccounts],
      revision,
      startedAt: prep.startedAt,
      maxIndexPerChain: prep.maxIndexPerChain,
      boundaryUnits: [...boundaryUnits],
      hadConflict,
      historyPartial,
    });

    try {
      while (queue.length > 0) {
        const unit = queue[0]!;
        if (this.scanCancel) {
          this.setScanPhase(prep.scanId, { kind: 'cancelled', scanId: prep.scanId, reason: 'user' });
          await this.persistCheckpointSafe(expectation, checkpoint());
          return;
        }
        this.setScanPhase(prep.scanId, {
          kind: 'running',
          scanId: prep.scanId,
          unit,
          unitsDone: done.length,
          unitsTotal: done.length + queue.length,
        });
        const result = await runScanUnit(unit, ports, {
          maxIndexPerChain: prep.maxIndexPerChain,
          burnedChangeCount: prep.burned.get(unitKey(unit)) ?? 0,
        });
        if (!result.ok) {
          if (result.failure === 'cancelled') {
            this.setScanPhase(prep.scanId, { kind: 'cancelled', scanId: prep.scanId, reason: 'user' });
            await this.persistCheckpointSafe(expectation, checkpoint());
            return;
          }
          if (result.failure === 'conflicting_sources') {
            // §11.4: gate preserved cache immediately. Persist both the
            // positive conflict and the advanced checkpoint before scanning
            // another unit, so a popup read or MV3 restart cannot expose the
            // prior record as spendable in the meantime.
            hadConflict = true;
            queue.shift();
            done.push(unit);
            // A source conflict already gates every spending path. Continuing
            // through the remaining discovery batch cannot make this pass safe and
            // can turn one inconsistent response into a rate-limit storm.
            // Finish the current account plus the bounded legacy checks; the
            // UI's one-shot clean refresh is what reconciles the gate.
            if (prep.scope === 'discovery' && unit.source === 'standard') {
              queue = stopStandardDiscoveryAfter(queue, unit.account, prep.standardAccounts);
              this.setScanUnitsTotal(prep.scanId, done.length + queue.length);
            }
            try {
              await this.persistScanConflict(expectation, checkpoint());
            } catch {
              this.setScanPhase(prep.scanId, { kind: 'cancelled', scanId: prep.scanId, reason: 'locked' });
              return;
            }
            continue;
          }
          this.setScanPhase(prep.scanId, {
            kind: 'failed',
            scanId: prep.scanId,
            reason: result.failure === 'data_limit' ? 'data_limit' : 'gateway',
          });
          await this.persistCheckpointSafe(expectation, checkpoint());
          return;
        }
        // Every successfully reconciled unit in one scan must bind to the
        // same revision. A rotated source is a conflict and its unit result
        // is not allowed to replace the last consistent cache record.
        if (revision !== null && result.revision !== revision) {
          hadConflict = true;
          queue.shift();
          done.push(unit);
          if (prep.scope === 'discovery' && unit.source === 'standard') {
            queue = stopStandardDiscoveryAfter(queue, unit.account, prep.standardAccounts);
            this.setScanUnitsTotal(prep.scanId, done.length + queue.length);
          }
          try {
            await this.persistScanConflict(expectation, checkpoint());
          } catch {
            this.setScanPhase(prep.scanId, { kind: 'cancelled', scanId: prep.scanId, reason: 'locked' });
            return;
          }
          continue;
        }
        if (revision === null) revision = result.revision;
        if (result.active) {
          activeUnits.set(unitKey(unit), unit);
        }
        if (result.confirmedActivity) {
          confirmedUnits.set(unitKey(unit), unit);
        }
        if (result.historyCoverage.status === 'partial') {
          historyPartial = true;
          this.scanHistoryPartial = true;
        }
        if (result.boundaryPrompt) boundaryUnits.push(unit);
        queue.shift();
        done.push(unit);
        if (prep.scope === 'discovery' && unit.source === 'standard' &&
            unit.lane === 'ordinals' && !hadConflict) {
          const accountConfirmed =
            confirmedUnits.has(unitKey({ ...unit, lane: 'payment' })) ||
            confirmedUnits.has(unitKey({ ...unit, lane: 'ordinals' }));
          emptyStandardAccountStreak = accountConfirmed
            ? 0
            : emptyStandardAccountStreak + 1;
          if (emptyStandardAccountStreak >= ACCOUNT_GAP_LIMIT) {
            queue = stopStandardDiscoveryAfter(queue, unit.account, prep.standardAccounts);
            this.setScanUnitsTotal(prep.scanId, done.length + queue.length);
          }
        }
        try {
          await this.runExclusive(() =>
            this.withSessionDek(expectation, async (dek, session) => {
              await this.persistUnitLocked(dek, session.vaultId, unit, result);
              await this.saveCheckpointLocked(dek, session.vaultId, checkpoint());
            }),
          );
        } catch {
          // Session lock/expiry mid-scan (§7.4/§7.5): stop and drop key material.
          this.setScanPhase(prep.scanId, { kind: 'cancelled', scanId: prep.scanId, reason: 'locked' });
          return;
        }
      }

      let recoveredCountsChanged = false;
      try {
        recoveredCountsChanged = await this.runExclusive(() =>
          this.withSessionDek(expectation, async (dek, session) => {
            const prior = await this.loadAccountsMetaLocked(dek, session.vaultId);
            const mergedActiveUnits = new Map(
              [...prior.activeUnits, ...activeUnits.values()].map((unit) => [unitKey(unit), unit]),
            );
            const partialHistoryUnits: ScanUnit[] = [];
            for (const candidate of mergedActiveUnits.values()) {
              const historyRecord = await this.requireCache().get(
                this.cacheKey(session.vaultId, 'history', unitKey(candidate)),
              );
              if (!historyRecord) {
                partialHistoryUnits.push(candidate);
                continue;
              }
              try {
                const stored = openRecord(
                  dek, historyRecord, storedHistoryReadSchema,
                ) as StoredHistoryRecord;
                if (stored.coverage.status === 'partial') partialHistoryUnits.push(candidate);
              } catch {
                // Unreadable history remains display-incomplete until a rescan rewrites it.
                partialHistoryUnits.push(candidate);
              }
            }
            const discoveredActiveAccounts = [...mergedActiveUnits.values()]
              .filter((unit) => unit.source === 'standard')
              .map((unit) => unit.account);
            const standardAccounts = includeIntermediateDiscoveredAccounts(
              normalizeAccountIndexes([
                ...prior.standardAccounts,
                ...prep.standardAccounts,
              ]),
              discoveredActiveAccounts,
            );
            let registeredPublicAccounts = prior.registeredPublicAccounts;
            const registeredStandardIndexes = new Set(
              registeredPublicAccounts
                .filter((account) => account.source === 'standard')
                .map((account) => account.account),
            );
            const missingStandardAccounts = standardAccounts.filter(
              (account) => !registeredStandardIndexes.has(account),
            );
            if (!hadConflict && missingStandardAccounts.length > 0) {
              const vaults = await loadVaults(this.deps.local);
              const vault = vaults[session.vaultId];
              if (!vault) throw new RpcError('ERR_VAULT_NOT_FOUND', 'active vault record missing');
              const seed = hexToBytes(openVaultPayload(vault, dek).seedHex);
              try {
                const additions: AccountsMeta['registeredPublicAccounts'] = [];
                for (const account of missingStandardAccounts) {
                  const migrated = migrateLegacySoftwareAccountV1(
                    seed, this.deps.network, account, session.vaultId,
                  );
                  await this.savePublicAccountDefinitionLocked(dek, session.vaultId, migrated.definition);
                  await this.saveAccountSigningBindingLocked(dek, session.vaultId, migrated.binding);
                  additions.push({
                    accountId: migrated.definition.accountId,
                    network: migrated.definition.network,
                    source: 'standard',
                    account,
                    name: `Account ${account + 1}`,
                  });
                }
                registeredPublicAccounts = [...registeredPublicAccounts, ...additions]
                  .sort((a, b) => a.account - b.account || a.accountId.localeCompare(b.accountId));
              } finally {
                zeroize(seed);
              }
            }
            const allUtxos = hadConflict
              ? []
              : await this.loadAllUtxosLocked(dek, session.vaultId);
            const recoveredAddressCounts = hadConflict
              ? prior.recoveredAddressCounts
              : summarizeRecoveredAddresses(allUtxos);
            const pendingAccounts = hadConflict
              ? []
              : [...await this.pendingAccountIndexesLocked(dek, session.vaultId)]
                  .filter((account) => account >= 0);
            const hiddenStandardAccounts = hadConflict
              ? prior.hiddenStandardAccounts
              : restoreOccupiedStandardAccounts(
                  prior.hiddenStandardAccounts,
                  [...allUtxos.map((utxo) => utxo.account), ...pendingAccounts],
                );
            const occupiedAccountIds = new Set(allUtxos.map((utxo) => utxo.accountId));
            const hiddenPublicAccountIds = hadConflict
              ? prior.hiddenPublicAccountIds
              : prior.hiddenPublicAccountIds.filter((accountId) => {
                  if (occupiedAccountIds.has(accountId)) return false;
                  const account = prior.registeredPublicAccounts.find(
                    (entry) => entry.accountId === accountId,
                  );
                  return account === undefined || !pendingAccounts.includes(account.account);
                });
            await this.saveAccountsMetaLocked(
              dek,
              session.vaultId,
              hadConflict
                ? { ...prior, hasConflictingSources: true }
                : {
                    ...prior,
                    lastCompletedScanId: prep.scanId,
                    lastSyncedAt: this.deps.vaultDeps.now(),
                    revision,
                    hasConflictingSources: false,
                    activeUnits: [...mergedActiveUnits.values()],
                    partialHistoryUnits,
                    standardAccounts,
                    registeredPublicAccounts,
                    hiddenPublicAccountIds,
                    hiddenStandardAccounts,
                    recoveredAddressCounts,
                  },
            );
            historyPartial = partialHistoryUnits.length > 0;
            this.scanHistoryPartial = historyPartial;
            await this.saveCheckpointLocked(dek, session.vaultId, checkpoint());
            return JSON.stringify({
              recoveredAddressCounts: prior.recoveredAddressCounts,
              hiddenStandardAccounts: prior.hiddenStandardAccounts,
              hiddenPublicAccountIds: prior.hiddenPublicAccountIds,
              registeredPublicAccounts: prior.registeredPublicAccounts,
            }) !== JSON.stringify({
              recoveredAddressCounts,
              hiddenStandardAccounts,
              hiddenPublicAccountIds,
              registeredPublicAccounts,
            });
          }),
        );
      } catch {
        this.setScanPhase(prep.scanId, { kind: 'cancelled', scanId: prep.scanId, reason: 'locked' });
        return;
      }
      this.setScanPhase(
        prep.scanId,
        boundaryUnits.length > 0
          ? { kind: 'awaiting_extend', scanId: prep.scanId, boundaryUnits }
          : {
              kind: 'completed',
              scanId: prep.scanId,
              finishedAt: this.deps.vaultDeps.now(),
              historyPartial,
            },
      );
      if (recoveredCountsChanged) this.notifyWalletDataChanged('account');
    } finally {
      // Drop the public-only account keys regardless of outcome (§18.5).
      prep.ring.standard.clear();
      prep.ring.descriptor.clear();
      prep.ring.legacy.clear();
    }
  }

  private setScanPhase(scanId: string, phase: ScanPhase): void {
    // A session change detached this loop (resetScanState nulled the id):
    // a draining old-vault loop must not stamp its state over the new vault's.
    if (this.currentScanId !== scanId) return;
    this.scanPhase = phase;
    try {
      this.deps.notifyScanProgress?.();
    } catch {
      // UI refresh is best-effort.
    }
  }

  /**
   * Same generation guard as setScanPhase. The unit total is read alongside the
   * phase by scanStatusView, so a detached loop writing it would pair the new
   * scan's unitsDone with the old scan's unitsTotal in the progress UI.
   */
  private setScanUnitsTotal(scanId: string, total: number): void {
    if (this.currentScanId !== scanId) return;
    this.scanUnitsTotal = total;
  }

  private notifyWalletDataChanged(reason: WalletDataChangeReason): void {
    try {
      this.deps.notifyWalletDataChanged?.(reason);
    } catch {
      // Persisted state is authoritative; UI invalidation is best-effort.
    }
  }

  private marketplaceWorkflowKey(plan: ProviderPsbtPlanV3, step?: number): string {
    if (!plan.marketplace) throw new RpcError('ERR_INTERNAL', 'marketplace plan missing');
    const workflowStep = step ?? plan.marketplace.context.step;
    const identity = new TextEncoder().encode(JSON.stringify({
      accountId: plan.accountId,
      workflowId: plan.marketplace.context.workflowId,
      step: workflowStep,
      origin: plan.provider.origin,
      tabId: plan.provider.tabId,
      frameId: plan.provider.frameId,
      documentId: plan.provider.documentId,
      network: plan.network,
      vaultId: plan.vaultId,
      sessionId: plan.sessionId,
      marketplaceId: plan.marketplace.context.marketplaceId,
      templateId: plan.marketplace.resolution.templateId,
      templateVersion: plan.marketplace.context.templateVersion,
      role: plan.marketplace.context.role,
      action: plan.marketplace.context.action,
      assetKind: plan.marketplace.context.assetKind,
      stepCount: plan.marketplace.context.stepCount,
      broadcaster: plan.marketplace.context.broadcaster,
    }));
    const bindingHash = bytesToHex(getCryptoProvider().sha256(identity));
    return `${plan.marketplace.context.workflowId}:${workflowStep}:${bindingHash}`;
  }

  private marketplaceWorkflowGroupKey(plan: ProviderPsbtGroupPlanV1, workflowId: string): string {
    return `group:${workflowId}:${plan.groupHash}`;
  }

  private async marketplaceWorkflowGroupsLocked(
    dek: Uint8Array,
    plan: ProviderPsbtPlanV3,
  ): Promise<MarketplaceWorkflowGroupJournal[]> {
    if (!plan.marketplace) return [];
    const cache = this.requireCache();
    const prefix = `group:${plan.marketplace.context.workflowId}:`;
    const keys = await cache.listKeys(plan.vaultId, plan.network, 'marketplaceWorkflows');
    const groups: MarketplaceWorkflowGroupJournal[] = [];
    for (const key of keys.filter((candidate) => candidate.startsWith(prefix))) {
      const record = await cache.get(this.cacheKey(plan.vaultId, 'marketplaceWorkflows', key));
      if (!record) continue;
      try {
        groups.push(openRecord(dek, record, marketplaceWorkflowGroupJournalSchema));
      } catch {
        throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow group journal is corrupt');
      }
    }
    return groups;
  }

  private async marketplaceWorkflowJournalsLocked(
    dek: Uint8Array,
    plan: ProviderPsbtPlanV3,
  ): Promise<MarketplaceWorkflowJournal[]> {
    if (!plan.marketplace) return [];
    const cache = this.requireCache();
    const prefix = `${plan.marketplace.context.workflowId}:`;
    const keys = await cache.listKeys(plan.vaultId, plan.network, 'marketplaceWorkflows');
    const journals: MarketplaceWorkflowJournal[] = [];
    for (const key of keys.filter((candidate) =>
      !candidate.startsWith('group:') && candidate.startsWith(prefix))) {
      const record = await cache.get(this.cacheKey(plan.vaultId, 'marketplaceWorkflows', key));
      if (!record) continue;
      try {
        journals.push(openRecord(dek, record, marketplaceWorkflowJournalSchema));
      } catch {
        throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow journal is corrupt');
      }
    }
    return journals;
  }

  private marketplaceGroupAuthorityMatches(
    group: MarketplaceWorkflowGroupJournal,
    plan: ProviderPsbtPlanV3,
    step: number,
    allowDifferentRequest: boolean,
  ): boolean {
    if (group.step !== step || group.entries.length === 0) return false;
    try {
      for (const entry of group.entries) {
        this.assertMarketplaceWorkflowJournal(
          entry.journal,
          plan,
          step,
          allowDifferentRequest,
        );
      }
      return true;
    } catch {
      return false;
    }
  }

  private marketplaceSignedGroupHash(group: MarketplaceWorkflowGroupJournal): string {
    const signed = group.entries.map((entry) => ({
      nodeId: entry.nodeId,
      signedPsbtBase64: entry.journal.workflow.signedPsbtBase64,
    }));
    if (signed.some((entry) => entry.signedPsbtBase64 === null)) {
      throw new RpcError('ERR_PLAN_CHANGED', 'prior marketplace workflow group is not signed');
    }
    return bytesToHex(getCryptoProvider().sha256(
      new TextEncoder().encode(JSON.stringify({ groupHash: group.groupHash, signed })),
    ));
  }

  private async marketplacePriorSignedHashLocked(
    dek: Uint8Array,
    plan: ProviderPsbtPlanV3,
    priorStep: number,
  ): Promise<string> {
    const signedStates = new Set([
      'signed_undelivered', 'delivered_site_broadcast', 'wallet_broadcast_pending', 'completed',
    ]);
    const candidates: string[] = [];
    for (const journal of await this.marketplaceWorkflowJournalsLocked(dek, plan)) {
      try {
        const workflow = this.assertMarketplaceWorkflowJournal(journal, plan, priorStep, true);
        if (!signedStates.has(workflow.state) || workflow.signedPsbtBase64 === null) {
          throw new RpcError('ERR_PLAN_CHANGED', 'prior marketplace workflow step is not signed');
        }
        candidates.push(hashHex(bytesToHex(base64ToBytes(workflow.signedPsbtBase64))));
      } catch (error) {
        if (error instanceof RpcError && error.message.includes('authority changed')) continue;
        if (journal.workflow.step === priorStep) throw error;
      }
    }
    for (const group of await this.marketplaceWorkflowGroupsLocked(dek, plan)) {
      if (!this.marketplaceGroupAuthorityMatches(group, plan, priorStep, true)) continue;
      if (group.entries.some((entry) => !signedStates.has(entry.journal.workflow.state))) {
        throw new RpcError('ERR_PLAN_CHANGED', 'prior marketplace workflow group is not signed');
      }
      candidates.push(this.marketplaceSignedGroupHash(group));
    }
    if (candidates.length !== 1) {
      throw new RpcError('ERR_PLAN_CHANGED', candidates.length === 0
        ? 'marketplace workflow step is out of order'
        : 'marketplace prior workflow step is ambiguous');
    }
    return candidates[0]!;
  }

  private marketplaceWorkflowJournal(
    plan: ProviderPsbtPlanV3,
    workflow: MarketplaceWorkflow,
  ): MarketplaceWorkflowJournal {
    return marketplaceWorkflowJournalSchema.parse({
      version: 1,
      accountId: plan.accountId,
      authority: {
        origin: plan.provider.origin,
        tabId: plan.provider.tabId,
        frameId: plan.provider.frameId,
        documentId: plan.provider.documentId,
        requestNonce: plan.provider.requestNonce,
        providerMethod: plan.provider.providerMethod,
      },
      workflow,
    });
  }

  private preparedMarketplaceWorkflow(
    plan: ProviderPsbtPlanV3,
    priorSignedHash: string | null,
    now: number,
  ): MarketplaceWorkflow {
    if (!plan.marketplace) throw new RpcError('ERR_PLAN_CHANGED', 'marketplace context missing');
    return marketplaceWorkflowSchema.parse({
      version: 1,
      workflowId: plan.marketplace.context.workflowId,
      marketplaceId: plan.marketplace.context.marketplaceId,
      templateId: plan.marketplace.resolution.templateId,
      templateVersion: plan.marketplace.context.templateVersion,
      origin: plan.provider.origin,
      network: plan.network,
      vaultId: plan.vaultId,
      sessionId: plan.sessionId,
      account: plan.account,
      role: plan.marketplace.context.role,
      action: plan.marketplace.context.action,
      assetKind: plan.marketplace.context.assetKind,
      step: plan.marketplace.context.step,
      stepCount: plan.marketplace.context.stepCount,
      state: 'prepared',
      requestHash: marketplaceRequestHash(plan),
      psbtHash: plan.psbtHash,
      analysisHash: plan.analysisHash,
      planHash: plan.planHash,
      priorSignedHash,
      signedPsbtBase64: null,
      reservedOutpoints: ['list', 'bulk_list', 'offer', 'collection_offer', 'trait_offer'].includes(
        plan.marketplace.context.action,
      ) ? plan.marketplace.selectedInputIndexes.flatMap((index) => {
          const selected = plan.inputs[index];
          return selected?.ownership === 'wallet' ? [`${selected.txid}:${selected.vout}`] : [];
        }) : [],
      broadcaster: plan.marketplace.context.broadcaster,
      revision: plan.marketplace.context.revision ?? null,
      expiresAt: Math.min(plan.expiresAt, plan.marketplace.context.expiresAt ?? plan.expiresAt),
      createdAt: now,
      updatedAt: now,
    });
  }

  private assertMarketplaceWorkflowJournal(
    journal: MarketplaceWorkflowJournal,
    plan: ProviderPsbtPlanV3,
    expectedStep: number,
    allowDifferentRequest = false,
  ): MarketplaceWorkflow {
    const marketplace = plan.marketplace;
    if (!marketplace) throw new RpcError('ERR_PLAN_CHANGED', 'marketplace context missing');
    const workflow = journal.workflow;
    const authorityMatches = journal.authority.origin === plan.provider.origin &&
      journal.authority.tabId === plan.provider.tabId &&
      journal.authority.frameId === plan.provider.frameId &&
      journal.authority.documentId === plan.provider.documentId &&
      (allowDifferentRequest || (
        journal.authority.requestNonce === plan.provider.requestNonce &&
        journal.authority.providerMethod === plan.provider.providerMethod
      ));
    if (journal.accountId !== plan.accountId || !authorityMatches ||
        workflow.workflowId !== marketplace.context.workflowId ||
        workflow.step !== expectedStep || workflow.stepCount !== marketplace.context.stepCount ||
        workflow.origin !== plan.provider.origin || workflow.network !== plan.network ||
        workflow.vaultId !== plan.vaultId || workflow.sessionId !== plan.sessionId ||
        workflow.account !== plan.account ||
        workflow.marketplaceId !== marketplace.context.marketplaceId ||
        workflow.templateId !== marketplace.resolution.templateId ||
        workflow.templateVersion !== marketplace.context.templateVersion ||
        workflow.role !== marketplace.context.role || workflow.action !== marketplace.context.action ||
        workflow.assetKind !== marketplace.context.assetKind ||
        workflow.broadcaster !== marketplace.context.broadcaster) {
      throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow authority changed');
    }
    return workflow;
  }

  private async persistMarketplacePreparedLocked(
    dek: Uint8Array,
    plan: ProviderPsbtPlanV3,
    write = true,
  ): Promise<WalletCacheRecord | undefined> {
    if (!plan.marketplace) return undefined;
    const cache = this.requireCache();
    const key = this.marketplaceWorkflowKey(plan);
    const recordKey = this.cacheKey(plan.vaultId, 'marketplaceWorkflows', key);
    const existingRecord = await cache.get(recordKey);
    if (existingRecord) {
      let existing: MarketplaceWorkflow;
      try {
        existing = this.assertMarketplaceWorkflowJournal(
          openRecord(dek, existingRecord, marketplaceWorkflowJournalSchema),
          plan,
          plan.marketplace.context.step,
        );
      }
      catch { throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow journal is corrupt'); }
      if (existing.planHash === plan.planHash && existing.psbtHash === plan.psbtHash &&
          existing.requestHash === marketplaceRequestHash(plan) &&
          ['prepared', 'needs_reapproval'].includes(existing.state)) return undefined;
      throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow step was replayed or changed');
    }
    const groupedAtStep = (await this.marketplaceWorkflowGroupsLocked(dek, plan)).some((group) =>
      this.marketplaceGroupAuthorityMatches(
        group,
        plan,
        plan.marketplace!.context.step,
        true,
      ));
    if (groupedAtStep) {
      throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow step was replayed or changed');
    }
    let priorSignedHash: string | null = null;
    if (plan.marketplace.context.step > 1) {
      priorSignedHash = await this.marketplacePriorSignedHashLocked(
        dek,
        plan,
        plan.marketplace.context.step - 1,
      );
    }
    const now = this.deps.vaultDeps.now();
    const workflow = this.preparedMarketplaceWorkflow(plan, priorSignedHash, now);
    const record = sealRecord(
      dek,
      this.marketplaceWorkflowJournal(plan, workflow),
      recordKey,
      this.deps.vaultDeps.random(24),
      now,
    );
    if (write) {
      await cache.put(record);
      return undefined;
    }
    return record;
  }

  /** One aggregate record makes a same-step marketplace group one replay unit. */
  private async persistMarketplaceGroupPreparedLocked(
    dek: Uint8Array,
    plan: ProviderPsbtGroupPlanV1,
    guard?: ProviderOperationGuard,
  ): Promise<void> {
    const marketplaceItems = plan.items.filter((item) => item.plan.marketplace !== undefined);
    if (marketplaceItems.length === 0) return;
    if (marketplaceItems.length !== plan.items.length) {
      throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow group is incomplete');
    }
    const first = marketplaceItems[0]!.plan;
    const workflowId = first.marketplace!.context.workflowId;
    const step = first.marketplace!.context.step;
    const templateId = first.marketplace!.resolution.templateId;
    const broadcaster = first.marketplace!.context.broadcaster;
    const linkedOmbListing = templateId === 'omb-wiki-ordnet-list-v1';
    if (marketplaceItems.some((item, index) =>
      item.plan.marketplace!.context.workflowId !== workflowId ||
      item.plan.marketplace!.context.step !== (linkedOmbListing ? index + 1 : step) ||
      item.plan.marketplace!.resolution.templateId !== templateId ||
      item.plan.marketplace!.context.broadcaster !== broadcaster) ||
      (linkedOmbListing && (marketplaceItems.length !== 3 || step !== 1))) {
      throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow steps require separate approvals');
    }
    const cache = this.requireCache();
    const recordKey = this.cacheKey(
      plan.vaultId,
      'marketplaceWorkflows',
      this.marketplaceWorkflowGroupKey(plan, workflowId),
    );
    const existingRecord = await cache.get(recordKey);
    if (existingRecord) {
      let existing: MarketplaceWorkflowGroupJournal;
      try { existing = openRecord(dek, existingRecord, marketplaceWorkflowGroupJournalSchema); }
      catch { throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow group journal is corrupt'); }
      if (existing.groupHash !== plan.groupHash || existing.entries.length !== marketplaceItems.length) {
        throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow group was replayed or changed');
      }
      for (let index = 0; index < marketplaceItems.length; index += 1) {
        const item = marketplaceItems[index]!;
        const entry = existing.entries[index];
        if (!entry || entry.nodeId !== item.nodeId) {
          throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow group was replayed or changed');
        }
        const workflow = this.assertMarketplaceWorkflowJournal(
          entry.journal,
          item.plan,
          linkedOmbListing ? index + 1 : step,
        );
        if (workflow.state !== 'prepared' || workflow.planHash !== item.plan.planHash ||
            workflow.psbtHash !== item.plan.psbtHash ||
            workflow.requestHash !== marketplaceRequestHash(item.plan)) {
          throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow group was replayed or changed');
        }
      }
      return;
    }
    const existingSingles = await this.marketplaceWorkflowJournalsLocked(dek, first);
    if (linkedOmbListing ? existingSingles.length > 0 : existingSingles.some((journal) => {
      try {
        this.assertMarketplaceWorkflowJournal(journal, first, step, true);
        return true;
      } catch { return false; }
    })) {
      throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow group was replayed or changed');
    }
    const existingGroups = await this.marketplaceWorkflowGroupsLocked(dek, first);
    if (linkedOmbListing ? existingGroups.length > 0 : existingGroups.some((group) =>
      this.marketplaceGroupAuthorityMatches(group, first, step, true))) {
      throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow group was replayed or changed');
    }
    const priorSignedHash = !linkedOmbListing && step > 1
      ? await this.marketplacePriorSignedHashLocked(dek, first, step - 1)
      : null;
    const now = this.deps.vaultDeps.now();
    const grouped = marketplaceWorkflowGroupJournalSchema.parse({
      version: 1,
      groupHash: plan.groupHash,
      workflowId,
      step,
      entries: marketplaceItems.map((item) => ({
        nodeId: item.nodeId,
        journal: this.marketplaceWorkflowJournal(
          item.plan,
          this.preparedMarketplaceWorkflow(item.plan, linkedOmbListing ? null : priorSignedHash, now),
        ),
      })),
      createdAt: now,
      updatedAt: now,
    });
    guard?.();
    await cache.put(sealRecord(dek, grouped, recordKey, this.deps.vaultDeps.random(24), now));
    guard?.();
  }

  private async persistMarketplaceSignedLocked(
    dek: Uint8Array,
    plan: ProviderPsbtPlanV3,
    signedPsbtBase64: string,
  ): Promise<void> {
    const cache = this.requireCache();
    const records = await this.buildMarketplaceSignedRecordsLocked(dek, plan, signedPsbtBase64);
    await cache.putMany(records);
  }

  private async persistMarketplaceGroupSignedLocked(
    dek: Uint8Array,
    plan: ProviderPsbtGroupPlanV1,
    results: readonly { nodeId: string; psbtBase64: string }[],
    guard?: ProviderOperationGuard,
  ): Promise<void> {
    const marketplaceItems = plan.items.filter((item) => item.plan.marketplace !== undefined);
    if (marketplaceItems.length === 0) return;
    if (marketplaceItems.length !== plan.items.length || results.length !== marketplaceItems.length) {
      throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow group changed');
    }
    const first = marketplaceItems[0]!.plan;
    const workflowId = first.marketplace!.context.workflowId;
    const recordKey = this.cacheKey(
      plan.vaultId,
      'marketplaceWorkflows',
      this.marketplaceWorkflowGroupKey(plan, workflowId),
    );
    const cache = this.requireCache();
    const record = await cache.get(recordKey);
    if (!record) throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow group journal is missing');
    let grouped: MarketplaceWorkflowGroupJournal;
    try { grouped = openRecord(dek, record, marketplaceWorkflowGroupJournalSchema); }
    catch { throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow group journal is corrupt'); }
    if (grouped.groupHash !== plan.groupHash || grouped.entries.length !== marketplaceItems.length) {
      throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow group state changed');
    }
    const resultByNode = new Map(results.map((result) => [result.nodeId, result.psbtBase64]));
    if (resultByNode.size !== results.length) {
      throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow group result changed');
    }
    const now = this.deps.vaultDeps.now();
    const pendingRecords = new Map<string, WalletCacheRecord>();
    const entries = [];
    for (let index = 0; index < marketplaceItems.length; index += 1) {
      guard?.();
      const item = marketplaceItems[index]!;
      const entry = grouped.entries[index];
      if (!entry || entry.nodeId !== item.nodeId) {
        throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow group state changed');
      }
      const workflow = this.assertMarketplaceWorkflowJournal(
        entry.journal,
        item.plan,
        item.plan.marketplace!.context.step,
      );
      const signedPsbtBase64 = resultByNode.get(item.nodeId);
      if (workflow.state !== 'prepared' || workflow.planHash !== item.plan.planHash ||
          workflow.psbtHash !== item.plan.psbtHash ||
          workflow.requestHash !== marketplaceRequestHash(item.plan) ||
          signedPsbtBase64 === undefined) {
        throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow group state changed');
      }
      const approved = transitionMarketplaceWorkflow(workflow, 'approved_unsigned', now);
      const signed = transitionMarketplaceWorkflow(
        approved,
        'signed_undelivered',
        now,
        { signedPsbtBase64 },
      );
      entries.push({
        nodeId: item.nodeId,
        journal: this.marketplaceWorkflowJournal(item.plan, signed),
      });
      const reservations = await this.buildMarketplaceReservationRecordsLocked(
        dek,
        item.plan,
        signed,
        pendingRecords,
      );
      for (const reservation of reservations) {
        pendingRecords.set(this.walletCacheRecordId(reservation), reservation);
      }
    }
    const signedGroup = marketplaceWorkflowGroupJournalSchema.parse({
      ...grouped,
      entries,
      updatedAt: now,
    });
    const signedGroupRecord = sealRecord(
      dek,
      signedGroup,
      recordKey,
      this.deps.vaultDeps.random(24),
      now,
    );
    guard?.();
    await cache.putMany([signedGroupRecord, ...pendingRecords.values()]);
    guard?.();
  }

  private async buildMarketplaceSignedRecordsLocked(
    dek: Uint8Array,
    plan: ProviderPsbtPlanV3,
    signedPsbtBase64: string,
    pendingRecords: ReadonlyMap<string, WalletCacheRecord> = new Map(),
  ): Promise<WalletCacheRecord[]> {
    if (!plan.marketplace) return [];
    const cache = this.requireCache();
    const recordKey = this.cacheKey(plan.vaultId, 'marketplaceWorkflows', this.marketplaceWorkflowKey(plan));
    const record = pendingRecords.get(this.walletCacheRecordId(recordKey)) ?? await cache.get(recordKey);
    if (!record) throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow journal is missing');
    let workflow: MarketplaceWorkflow;
    try {
      workflow = this.assertMarketplaceWorkflowJournal(
        openRecord(dek, record, marketplaceWorkflowJournalSchema),
        plan,
        plan.marketplace.context.step,
      );
    }
    catch { throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow journal is corrupt'); }
    if (workflow.planHash !== plan.planHash || workflow.psbtHash !== plan.psbtHash ||
        workflow.requestHash !== marketplaceRequestHash(plan) || workflow.state !== 'prepared') {
      throw new RpcError('ERR_PLAN_CHANGED', 'marketplace workflow state changed');
    }
    const now = this.deps.vaultDeps.now();
    const approved = transitionMarketplaceWorkflow(workflow, 'approved_unsigned', now);
    const signed = transitionMarketplaceWorkflow(approved, 'signed_undelivered', now, { signedPsbtBase64 });
    const records = [sealRecord(
      dek,
      this.marketplaceWorkflowJournal(plan, signed),
      recordKey,
      this.deps.vaultDeps.random(24),
      now,
    )];
    records.push(...await this.buildMarketplaceReservationRecordsLocked(
      dek,
      plan,
      signed,
      pendingRecords,
    ));
    return records;
  }

  private async buildMarketplaceReservationRecordsLocked(
    dek: Uint8Array,
    plan: ProviderPsbtPlanV3,
    signed: MarketplaceWorkflow,
    pendingRecords: ReadonlyMap<string, WalletCacheRecord> = new Map(),
  ): Promise<WalletCacheRecord[]> {
    if (!plan.marketplace ||
        !['list', 'bulk_list', 'offer', 'collection_offer', 'trait_offer'].includes(
          plan.marketplace.context.action,
        )) return [];
    const now = signed.updatedAt;
    const cache = this.requireCache();
    const records: WalletCacheRecord[] = [];
    for (const index of plan.marketplace.selectedInputIndexes) {
      const selected = plan.inputs[index];
      if (!selected || selected.ownership !== 'wallet') continue;
      const outpoint = `${selected.txid}:${selected.vout}`;
      const reservationKey = this.cacheKey(plan.vaultId, 'marketplaceReservations', outpoint);
      const existing = pendingRecords.get(this.walletCacheRecordId(reservationKey)) ??
        await cache.get(reservationKey);
      if (existing) {
        let reservation: MarketplaceReservation;
        try { reservation = openRecord(dek, existing, marketplaceReservationSchema); }
        catch { throw new RpcError('ERR_PLAN_CHANGED', 'marketplace reservation is corrupt'); }
        if (reservation.releasedAt === null && reservation.workflowId !== signed.workflowId) {
          throw new RpcError('ERR_PLAN_CHANGED', 'marketplace input is reserved by another workflow');
        }
      }
      const reservation: MarketplaceReservation = marketplaceReservationSchema.parse({
        version: 1,
        outpoint,
        workflowId: signed.workflowId,
        marketplaceId: signed.marketplaceId,
        templateId: signed.templateId,
        vaultId: signed.vaultId,
        network: signed.network,
        account: signed.account,
        reason: signed.action === 'list' || signed.action === 'bulk_list' ? 'exported_listing' : 'exported_offer',
        createdAt: now,
        expiresAt: null,
        releasedAt: null,
        releaseProof: null,
      });
      records.push(sealRecord(
        dek,
        reservation,
        reservationKey,
        this.deps.vaultDeps.random(24),
        now,
      ));
    }
    return records;
  }

  private requireCache(): WalletCachePort {
    const cache = this.deps.walletCache;
    if (!cache) throw new RpcError('ERR_INTERNAL', 'wallet cache unavailable');
    return cache;
  }

  /** Like withActiveDek but hands the raw DEK for cache sealing/opening. */
  private async withSessionDek<T>(
    expectation: ActiveSessionRequest,
    fn: (dek: Uint8Array, session: UnlockSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.requireSession(expectation);
    const dek = base64ToBytes(session.dekB64);
    try {
      return await fn(dek, session);
    } finally {
      zeroize(dek);
    }
  }

  private cacheKey(vaultId: string, type: WalletCacheRecordType, key: string): WalletCacheKey {
    return { vaultId, network: this.deps.network, type, key };
  }

  private walletCacheRecordId(key: WalletCacheKey): string {
    return `${key.vaultId}\0${key.network}\0${key.type}\0${key.key}`;
  }

  private async persistUnitLocked(
    dek: Uint8Array,
    vaultId: string,
    unit: ScanUnit,
    result: ScanUnitResult,
  ): Promise<void> {
    const cache = this.requireCache();
    const utxoKey = this.cacheKey(vaultId, 'utxos', unitKey(unit));
    // Carry the user-controlled flag forward from the record being replaced —
    // a rescan must never clear a §14.4 freeze. (dustQuarantined stays
    // scanner-owned and is recomputed.)
    const legacyUnitKey = unit.source === 'standard' && unit.accountId !== undefined
      ? `a${unit.account}:${unit.lane}`
      : null;
    const priorRecord = await cache.get(utxoKey) ?? (legacyUnitKey === null
      ? undefined
      : await cache.get(this.cacheKey(vaultId, 'utxos', legacyUnitKey)));
    if (priorRecord) {
      try {
        const prior = openRecord(dek, priorRecord, storedUtxosSchema) as WalletUtxo[];
        const frozen = new Set(
          prior
            .filter((u) => u.flags.userFrozen)
            .map((u) => `${u.outpoint.txid}:${u.outpoint.vout}`),
        );
        for (const utxo of result.utxos) {
          if (frozen.has(`${utxo.outpoint.txid}:${utxo.outpoint.vout}`)) {
            utxo.flags.userFrozen = true;
          }
        }
      } catch {
        // Unreadable prior record: nothing to carry forward.
      }
    }
    await cache.put(
      sealRecord(dek, result.utxos, utxoKey, this.deps.vaultDeps.random(24), this.deps.vaultDeps.now()),
    );
    // History is stored PER UNIT: each entry's deltaSats is relative to that
    // unit's requested scripts, so a tx touching several units carries several
    // partial deltas — summed across units at read time (loadHistoryLocked).
    const historyKey = this.cacheKey(vaultId, 'history', unitKey(unit));
    await cache.put(
      sealRecord(
        dek,
        {
          version: 2,
          entries: result.history,
          coverage: result.historyCoverage,
        },
        historyKey,
        this.deps.vaultDeps.random(24),
        this.deps.vaultDeps.now(),
      ),
    );
    if (legacyUnitKey !== null) {
      await cache.delete(this.cacheKey(vaultId, 'utxos', legacyUnitKey));
      await cache.delete(this.cacheKey(vaultId, 'history', legacyUnitKey));
    }
  }

  private async loadCheckpointLocked(dek: Uint8Array, vaultId: string): Promise<ScanCheckpoint | null> {
    const cache = this.deps.walletCache;
    if (!cache) return null;
    const record = await cache.get(this.cacheKey(vaultId, 'scanState', 'all'));
    if (!record) return null;
    try {
      return scanCheckpointSchema.parse(
        openRecord(dek, record, scanCheckpointSchema),
      ) as ScanCheckpoint;
    } catch {
      // An unreadable checkpoint (schema drift) means "no resumable scan".
      return null;
    }
  }

  private async saveCheckpointLocked(
    dek: Uint8Array,
    vaultId: string,
    checkpoint: ScanCheckpoint,
  ): Promise<void> {
    await this.requireCache().put(
      sealRecord(
        dek,
        checkpoint,
        this.cacheKey(vaultId, 'scanState', 'all'),
        this.deps.vaultDeps.random(24),
        this.deps.vaultDeps.now(),
      ),
    );
  }

  /** Best-effort checkpoint persist for cancel/failure paths (session may be gone). */
  private async persistCheckpointSafe(
    expectation: ActiveSessionRequest,
    checkpoint: ScanCheckpoint,
  ): Promise<void> {
    try {
      await this.runExclusive(() =>
        this.withSessionDek(expectation, (dek, session) =>
          this.saveCheckpointLocked(dek, session.vaultId, checkpoint),
        ),
      );
    } catch {
      // Locked mid-cancel: the durable checkpoint stays at its last good state.
    }
  }

  /** Durably gate preserved cache after any exact reconciliation failure. */
  private async persistScanConflict(
    expectation: ActiveSessionRequest,
    checkpoint: ScanCheckpoint,
  ): Promise<void> {
    await this.runExclusive(() =>
      this.withSessionDek(expectation, async (dek, session) => {
        const prior = await this.loadAccountsMetaLocked(dek, session.vaultId);
        // Meta first is fail-closed: even if checkpoint persistence fails,
        // the prior cache cannot be exposed as spendable after this conflict.
        await this.saveAccountsMetaLocked(dek, session.vaultId, {
          ...prior,
          hasConflictingSources: true,
        });
        await this.saveCheckpointLocked(dek, session.vaultId, checkpoint);
      }),
    );
  }

  private async loadAccountsMetaLocked(dek: Uint8Array, vaultId: string): Promise<AccountsMeta> {
    const cache = this.deps.walletCache;
    const empty: AccountsMeta = {
      lastCompletedScanId: null,
      lastSyncedAt: null,
      revision: null,
      hasConflictingSources: false,
      activeUnits: [],
      partialHistoryUnits: [],
      standardAccounts: [0],
      registeredPublicAccounts: [],
      activePublicAccountId: null,
      hiddenPublicAccountIds: [],
      hiddenStandardAccounts: [],
      recoveredAddressCounts: [],
      emptyAccountGapAcknowledged: false,
    };
    if (!cache) return empty;
    const record = await cache.get(this.cacheKey(vaultId, 'accountsMeta', 'all'));
    let stored: AccountsMeta | LegacyAccountsMeta = {
      lastCompletedScanId: null,
      lastSyncedAt: null,
      revision: null,
      hasConflictingSources: false,
      activeUnits: [],
      standardAccounts: [0],
      hiddenStandardAccounts: [],
      recoveredAddressCounts: [],
    };
    try {
      if (record) {
        stored = openRecord(dek, record, accountsMetaReadSchema) as
          AccountsMeta | LegacyAccountsMeta;
      }
    } catch {
      return empty;
    }
    if ('registeredPublicAccounts' in stored &&
        stored.registeredPublicAccounts.length > 0 &&
        stored.activePublicAccountId !== null) {
      return stored;
    }

    // v0.4 migration boundary: project every legacy numeric software account
    // into an encrypted public definition and an independently encrypted signer
    // binding. The registry is committed last, so an interrupted migration can
    // be retried without exposing a partially registered account.
    const config = await loadConfig(this.deps.local);
    const activeAccount = config.activeAccounts[activeAccountKey(vaultId, this.deps.network)] ?? 0;
    const accounts = normalizeAccountIndexes([
      ...stored.standardAccounts,
      activeAccount,
      ...stored.activeUnits
        .filter((unit) => unit.source === 'standard')
        .map((unit) => unit.account),
    ]);
    const vaults = await loadVaults(this.deps.local);
    const recordForVault = vaults[vaultId];
    if (!recordForVault) throw new RpcError('ERR_VAULT_NOT_FOUND', 'active vault record missing');
    const payload = openVaultPayload(recordForVault, dek);
    const seed = hexToBytes(payload.seedHex);
    try {
      const migrated = accounts.map((account) => ({
        account,
        ...migrateLegacySoftwareAccountV1(seed, this.deps.network, account, vaultId),
      }));
      for (const account of migrated) {
        await this.savePublicAccountDefinitionLocked(dek, vaultId, account.definition);
        await this.saveAccountSigningBindingLocked(dek, vaultId, account.binding);
      }
      const active = migrated.find((entry) => entry.account === activeAccount) ?? migrated[0];
      const registered = migrated.map((entry) => ({
          accountId: entry.definition.accountId,
          network: entry.definition.network,
          source: 'standard' as const,
          account: entry.account,
          name: `Account ${entry.account + 1}`,
        }));
      if (!active) throw new RpcError('ERR_INTERNAL', 'legacy active account unavailable');
      const legacyInput: LegacyAccountsMeta = {
        lastCompletedScanId: stored.lastCompletedScanId,
        lastSyncedAt: stored.lastSyncedAt,
        revision: stored.revision,
        hasConflictingSources: stored.hasConflictingSources,
        activeUnits: stored.activeUnits,
        standardAccounts: accounts,
        hiddenStandardAccounts: stored.hiddenStandardAccounts,
        recoveredAddressCounts: stored.recoveredAddressCounts.map((entry) => ({
          account: entry.account,
          payment: entry.payment,
          ordinals: entry.ordinals,
        })),
      };
      const meta = migrateLegacyAccountsMetaV04(
        legacyInput,
        registered,
        active.definition.accountId,
      );
      await this.saveAccountsMetaLocked(dek, vaultId, meta);
      return meta;
    } finally {
      zeroize(seed);
    }
  }

  private async loadPublicAccountDefinitionLocked(
    dek: Uint8Array,
    vaultId: string,
    accountId: string,
  ): Promise<PublicAccountDefinitionV1> {
    return (await this.loadPublicAccountPairLocked(dek, vaultId, accountId))
      .definitionRecord.definition;
  }

  private async savePublicAccountDefinitionLocked(
    dek: Uint8Array,
    vaultId: string,
    definition: PublicAccountDefinitionV1,
  ): Promise<void> {
    const value: PublicAccountDefinitionRecord = { version: 1, definition };
    publicAccountDefinitionRecordSchema.parse(value);
    await this.requireCache().put(sealRecord(
      dek,
      value,
      this.cacheKey(vaultId, 'publicAccountDefinition', definition.accountId),
      this.deps.vaultDeps.random(24),
      this.deps.vaultDeps.now(),
    ));
  }

  private async loadAccountSigningBindingLocked(
    dek: Uint8Array,
    vaultId: string,
    accountId: string,
  ): Promise<AccountSigningBinding> {
    return (await this.loadPublicAccountPairLocked(dek, vaultId, accountId)).signingBinding;
  }

  private async loadPublicAccountPairLocked(
    dek: Uint8Array,
    vaultId: string,
    accountId: string,
  ): Promise<ReturnType<typeof parsePublicAccountRecordPair>> {
    const cache = this.requireCache();
    const [definitionRecord, bindingRecord] = await Promise.all([
      cache.get(this.cacheKey(vaultId, 'publicAccountDefinition', accountId)),
      cache.get(this.cacheKey(vaultId, 'accountSigningBinding', accountId)),
    ]);
    if (!definitionRecord || !bindingRecord) {
      throw new RpcError('ERR_INVALID_PAYLOAD', 'public account record pair unavailable');
    }
    try {
      return parsePublicAccountRecordPair(
        openRecord(dek, definitionRecord, publicAccountDefinitionRecordSchema),
        openRecord(dek, bindingRecord, accountSigningBindingSchema),
      );
    } catch {
      throw new RpcError('ERR_PLAN_CHANGED', 'public account record pair differs');
    }
  }

  private async saveAccountSigningBindingLocked(
    dek: Uint8Array,
    vaultId: string,
    binding: AccountSigningBinding,
  ): Promise<void> {
    accountSigningBindingSchema.parse(binding);
    await this.requireCache().put(sealRecord(
      dek,
      binding,
      this.cacheKey(vaultId, 'accountSigningBinding', binding.accountId),
      this.deps.vaultDeps.random(24),
      this.deps.vaultDeps.now(),
    ));
  }

  private async accountSigningSourceLocked(
    dek: Uint8Array,
    vaultId: string,
    accountId: string,
  ): Promise<AccountSigningSourceV1> {
    return (await this.loadAccountSigningBindingLocked(dek, vaultId, accountId)).signingSource;
  }

  private async activePublicAccountContextLocked(
    dek: Uint8Array,
    vaultId: string,
  ): Promise<{
    account: AccountsMeta['registeredPublicAccounts'][number];
    signingSource: AccountSigningSourceV1;
    capabilities: AccountCapabilities;
  }> {
    const meta = await this.loadAccountsMetaLocked(dek, vaultId);
    const account = meta.registeredPublicAccounts.find(
      (entry) => entry.accountId === meta.activePublicAccountId,
    );
    if (!account) throw new RpcError('ERR_INVALID_PAYLOAD', 'active account unavailable');
    const signingSource = await this.accountSigningSourceLocked(dek, vaultId, account.accountId);
    return {
      account,
      signingSource,
      capabilities: derivePublicAccountCapabilities({
        unlocked: true,
        network: this.deps.network,
        signingSource: { kind: signingSource.kind },
      }),
    };
  }

  private async assertProviderAccountLocked(
    dek: Uint8Array,
    vaultId: string,
  ): Promise<AccountsMeta['registeredPublicAccounts'][number]> {
    const { account: active, capabilities } = await this.activePublicAccountContextLocked(
      dek, vaultId,
    );
    if (!capabilities.canExposeToProviders) {
      throw new RpcError('ERR_UNAUTHORIZED_CONTEXT', 'watch-only accounts cannot connect to sites');
    }
    return active;
  }

  private async assertMarketplaceAccountLocked(
    dek: Uint8Array,
    vaultId: string,
  ): Promise<AccountsMeta['registeredPublicAccounts'][number]> {
    const { account: active, capabilities } = await this.activePublicAccountContextLocked(
      dek, vaultId,
    );
    if (!capabilities.canExposeToProviders) {
      throw new RpcError('ERR_UNAUTHORIZED_CONTEXT', 'active account cannot connect to sites');
    }
    assertMarketplaceCapability(capabilities);
    return active;
  }

  private async saveAccountsMetaLocked(
    dek: Uint8Array,
    vaultId: string,
    meta: AccountsMeta,
  ): Promise<void> {
    await this.requireCache().put(
      sealRecord(
        dek,
        meta,
        this.cacheKey(vaultId, 'accountsMeta', 'all'),
        this.deps.vaultDeps.random(24),
        this.deps.vaultDeps.now(),
      ),
    );
  }

  private async accountRecordCoverageLocked(
    dek: Uint8Array,
    vaultId: string,
  ): Promise<Set<string>> {
    const cache = this.requireCache();
    const [utxoKeys, historyKeys] = await Promise.all([
      cache.listKeys(vaultId, this.deps.network, 'utxos'),
      cache.listKeys(vaultId, this.deps.network, 'history'),
    ]);
    const utxos = new Set(utxoKeys);
    const history = new Set(historyKeys);
    const meta = await this.loadAccountsMetaLocked(dek, vaultId);
    const covered = new Set<string>();
    for (const registered of meta.registeredPublicAccounts) {
      const publicKeys = (['payment', 'ordinals'] as const).map((lane) => unitKey({
        source: registered.source,
        accountId: registered.accountId,
        account: registered.account,
        lane,
      }));
      const legacyKeys = (['payment', 'ordinals'] as const).map(
        (lane) => `a${registered.account}:${lane}`,
      );
      const unitKeys = publicKeys.every((key) => utxos.has(key) && history.has(key))
        ? publicKeys
        : registered.source === 'standard' &&
            legacyKeys.every((key) => utxos.has(key) && history.has(key))
          ? legacyKeys
          : null;
      if (unitKeys === null) continue;
      try {
        for (const unitKey of unitKeys) {
          const utxoRecord = await cache.get(this.cacheKey(vaultId, 'utxos', unitKey));
          const historyRecord = await cache.get(this.cacheKey(vaultId, 'history', unitKey));
          if (!utxoRecord || !historyRecord) throw new Error('missing account record');
          openRecord(dek, utxoRecord, storedUtxosSchema);
          openRecord(dek, historyRecord, storedHistoryReadSchema);
        }
        covered.add(registered.accountId);
      } catch {
        // An unreadable record makes holdings uncertain, so hiding fails closed.
      }
    }
    return covered;
  }

  /** Confirmed Bitcoin or Ordinals activity opens the next standard-account slot. */
  private async confirmedStandardAccountIndexesLocked(
    dek: Uint8Array,
    vaultId: string,
    meta?: AccountsMeta,
  ): Promise<Set<number>> {
    const accountsMeta = meta ?? await this.loadAccountsMetaLocked(dek, vaultId);
    if (accountsMeta.hasConflictingSources) return new Set();
    const confirmed = new Set<number>();
    for (const utxo of await this.loadAllUtxosLocked(dek, vaultId)) {
      if (utxo.height !== null) confirmed.add(utxo.account);
    }
    const standardIndexById = new Map(
      accountsMeta.registeredPublicAccounts
        .filter((account) => account.source === 'standard')
        .map((account) => [account.accountId, account.account] as const),
    );
    const cache = this.requireCache();
    for (const key of await cache.listKeys(vaultId, this.deps.network, 'history')) {
      const legacy = /^a(0|[1-9][0-9]*):(payment|ordinals)$/u.exec(key);
      const stable = /^pub:(acct_(?:mainnet|signet|regtest)_[0-9a-f]{64}):(payment|ordinals)$/u.exec(key);
      const account = legacy
        ? Number(legacy[1])
        : stable
          ? standardIndexById.get(stable[1]!)
          : undefined;
      if (account === undefined) continue;
      const record = await cache.get(this.cacheKey(vaultId, 'history', key));
      if (!record) continue;
      try {
        const stored = openRecord(dek, record, storedHistoryReadSchema) as StoredHistoryRecord;
        if (stored.entries.some((entry) => entry.confirmationState === 'confirmed')) {
          confirmed.add(account);
        }
      } catch {
        // Unknown activity never opens another empty account slot.
      }
    }
    return confirmed;
  }

  /** -1 is an unreadable/global pending record, which blocks every account. */
  private async pendingAccountIndexesLocked(
    dek: Uint8Array,
    vaultId: string,
  ): Promise<Set<number>> {
    const cache = this.requireCache();
    const pending = new Set<number>();
    const plans = new Map<string, TransactionPlan>();
    const accountsMeta = await this.loadAccountsMetaLocked(dek, vaultId);
    const accountIndexById = new Map(
      accountsMeta.registeredPublicAccounts.map((account) => [account.accountId, account.account] as const),
    );
    for (const key of await cache.listKeys(vaultId, this.deps.network, 'history')) {
      const standard = /^a(0|[1-9][0-9]*):(payment|ordinals)$/u.exec(key);
      const publicUnit = /^pub:(acct_(?:mainnet|signet|regtest)_[0-9a-f]{64}):(payment|ordinals)$/u.exec(key);
      const account = standard
        ? Number(standard[1])
        : publicUnit
          ? accountIndexById.get(publicUnit[1]!) ?? -1
          : key.startsWith('xverse:') ? 0 : -1;
      const record = await cache.get(this.cacheKey(vaultId, 'history', key));
      if (!record) continue;
      try {
        const entries = (openRecord(
          dek, record, storedHistoryReadSchema,
        ) as StoredHistoryRecord).entries;
        if (entries.some((entry) => entry.confirmationState === 'mempool')) pending.add(account);
      } catch {
        pending.add(-1);
      }
    }
    for (const id of await cache.listKeys(vaultId, this.deps.network, 'plans')) {
      const record = await cache.get(this.cacheKey(vaultId, 'plans', id));
      if (!record) continue;
      try {
        const plan = openRecord(dek, record, storedPlanSchema) as TransactionPlan;
        plans.set(id, plan);
        if (plan.expiresAt > this.deps.vaultDeps.now()) pending.add(plan.account);
      } catch {
        pending.add(-1);
      }
    }
    for (const id of await cache.listKeys(vaultId, this.deps.network, 'broadcastRecovery')) {
      const plan = plans.get(id);
      pending.add(plan?.account ?? -1);
    }
    for (const id of await cache.listKeys(vaultId, this.deps.network, 'providerBroadcastRecovery')) {
      const record = await cache.get(this.cacheKey(vaultId, 'providerBroadcastRecovery', id));
      if (!record) continue;
      try {
        const recovery = openRecord(dek, record, providerBroadcastRecoverySchema);
        const account = (recovery.plan as { account?: unknown }).account;
        pending.add(Number.isInteger(account) ? account as number : -1);
      } catch {
        pending.add(-1);
      }
    }
    return pending;
  }

  private async accountVisibilityBlockerLocked(
    dek: Uint8Array,
    vaultId: string,
    accountId: string,
    meta: AccountsMeta,
  ): Promise<'active' | 'last_visible' | 'stale' | 'holdings' | 'pending' | null> {
    const registered = meta.registeredPublicAccounts.find(
      (account) => account.accountId === accountId,
    );
    if (!registered) return 'stale';
    if (accountId === meta.activePublicAccountId) return 'active';
    if (meta.registeredPublicAccounts.filter(
      (account) => !meta.hiddenPublicAccountIds.includes(account.accountId),
    ).length <= 1) {
      return 'last_visible';
    }
    const records = await this.accountRecordCoverageLocked(dek, vaultId);
    if (meta.lastSyncedAt === null || meta.revision === null || meta.hasConflictingSources ||
        !records.has(accountId)) return 'stale';
    if ((await this.loadAllUtxosLocked(dek, vaultId)).some(
      (utxo) => utxo.accountId === accountId,
    )) {
      return 'holdings';
    }
    const pending = await this.pendingAccountIndexesLocked(dek, vaultId);
    if (pending.has(registered.account) || pending.has(-1)) return 'pending';
    return null;
  }

  private async loadAllUtxosLocked(dek: Uint8Array, vaultId: string): Promise<WalletUtxo[]> {
    const cache = this.deps.walletCache;
    if (!cache) return [];
    const keys = await cache.listKeys(vaultId, this.deps.network, 'utxos');
    const present = new Set(keys);
    // Xverse legacy paths m/84'/86' at hardened account 0 COINCIDE with the
    // standard account-0 chains (the address-index quirk). Once the standard
    // record exists it is authoritative: refresh deliberately skips those
    // redundant legacy units, whose old records may otherwise retain spent
    // outputs. Genuinely distinct records are still deduped by outpoint.
    const byOutpoint = new Map<string, WalletUtxo>();
    const meta = await this.loadAccountsMetaLocked(dek, vaultId);
    const publicIdByIndex = new Map(
      meta.registeredPublicAccounts
        .filter((account) => account.source === 'standard')
        .map((account) => [account.account, account.accountId] as const),
    );
    for (const key of [...keys].sort()) {
      const shadow = shadowedByStandardKey(this.deps.network, key);
      const stableShadow = stableStandardShadowKey(
        this.deps.network, key, publicIdByIndex,
      );
      if ((shadow !== null && present.has(shadow)) ||
          (stableShadow !== null && stableShadow !== key && present.has(stableShadow))) continue;
      const record = await cache.get(this.cacheKey(vaultId, 'utxos', key));
      if (!record) continue;
      try {
        const opened = storedUtxosSchema.parse(openRecord(dek, record, storedUtxosSchema));
        const migrated = migrateLegacyStoredUtxos(
          opened,
          (utxo) => publicIdByIndex.get(utxo.account) ?? null,
        );
        for (const utxo of migrated) {
          const outpoint = `${utxo.outpoint.txid}:${utxo.outpoint.vout}`;
          if (!byOutpoint.has(outpoint)) byOutpoint.set(outpoint, utxo);
        }
      } catch {
        // Skip unreadable records; a rescan rewrites them.
      }
    }
    return [...byOutpoint.values()];
  }

  /**
   * Wallet-wide history: per-unit records aggregated by txid, summing each
   * unit's requested-set-relative deltaSats into the wallet-wide delta. Legacy
   * Xverse units whose paths coincide with a standard account-0 unit are
   * skipped when the standard record is present — their entries are
   * byte-identical and would double the sum (same reason loadAllUtxosLocked
   * dedupes by outpoint).
   */
  private async loadHistoryLocked(
    dek: Uint8Array,
    vaultId: string,
    accountId?: string,
  ): Promise<LaneAwareHistoryEntry[]> {
    const cache = this.deps.walletCache;
    if (!cache) return [];
    const keys = await cache.listKeys(vaultId, this.deps.network, 'history');
    const present = new Set(keys);
    const meta = await this.loadAccountsMetaLocked(dek, vaultId);
    const publicIdByIndex = new Map(
      meta.registeredPublicAccounts
        .filter((account) => account.source === 'standard')
        .map((account) => [account.account, account.accountId] as const),
    );
    let legacyAccount: number | null = null;
    if (accountId !== undefined) {
      const registered = meta.registeredPublicAccounts.find(
        (account) => account.accountId === accountId,
      );
      if (!registered) return [];
      legacyAccount = registered.source === 'standard' ? registered.account : null;
    }
    const byTxid = new Map<string, LaneAwareHistoryEntry>();
    for (const key of [...keys].sort()) {
      if (accountId !== undefined) {
        const isPublic = key.startsWith(`pub:${accountId}:`);
        const isLegacyStandard = legacyAccount !== null && key.startsWith(`a${legacyAccount}:`);
        const isLegacyManifest = legacyAccount === 0 && key.startsWith('xverse:');
        if (!isPublic && !isLegacyStandard && !isLegacyManifest) continue;
      }
      const shadow = shadowedByStandardKey(this.deps.network, key);
      const stableShadow = stableStandardShadowKey(
        this.deps.network, key, publicIdByIndex,
      );
      if ((shadow !== null && present.has(shadow)) ||
          (stableShadow !== null && stableShadow !== key && present.has(stableShadow))) continue;
      const record = await cache.get(this.cacheKey(vaultId, 'history', key));
      if (!record) continue;
      let entries: SnapshotHistoryEntry[];
      try {
        entries = (openRecord(
          dek, record, storedHistoryReadSchema,
        ) as StoredHistoryRecord).entries;
      } catch {
        continue; // Skip unreadable records; a rescan rewrites them.
      }
      const lane = unitLaneFromKey(this.deps.network, key);
      for (const entry of entries) {
        const laneEntry: LaneAwareHistoryEntry = {
          ...entry,
          ordinalsAddressFunded:
            lane === 'ordinals' && entry.fundedScriptHashes.length > 0,
          ordinalsAddressSpent:
            lane === 'ordinals' && entry.spentScriptHashes.length > 0,
        };
        const prior = byTxid.get(entry.txid);
        if (!prior) {
          byTxid.set(entry.txid, laneEntry);
          continue;
        }
        // Prefer the confirmed view for display fields; deltas always sum.
        const base = prior.height !== null ? prior : laneEntry;
        const activitySource =
          prior.activitySource !== undefined &&
          laneEntry.activitySource !== undefined
            ? prior.activitySource.inputCount === laneEntry.activitySource.inputCount &&
              prior.activitySource.singleInputAddress === laneEntry.activitySource.singleInputAddress
              ? prior.activitySource
              : undefined
            : prior.activitySource ?? laneEntry.activitySource;
        byTxid.set(entry.txid, {
          ...base,
          ordinalFlow: prior.ordinalFlow ?? laneEntry.ordinalFlow,
          // Both address lanes describe the same public transaction. Retain
          // the source only when their signed summaries agree; explicitly
          // overwrite a conflicting value inherited through `base`.
          activitySource,
          deltaSats: (BigInt(prior.deltaSats) + BigInt(entry.deltaSats)).toString(),
          ordinalsAddressFunded:
            prior.ordinalsAddressFunded === true || laneEntry.ordinalsAddressFunded === true,
          ordinalsAddressSpent:
            prior.ordinalsAddressSpent === true || laneEntry.ordinalsAddressSpent === true,
        });
      }
    }
    return [...byTxid.values()];
  }

  private async loadActivityEvidenceLocked(
    dek: Uint8Array,
    vaultId: string,
  ): Promise<ActivityEvidenceRecord> {
    const cache = this.deps.walletCache;
    if (!cache) return { version: 1, entries: [] };
    const record = await cache.get(this.cacheKey(vaultId, 'activityEvidence', 'all'));
    if (!record) return { version: 1, entries: [] };
    try {
      return openRecord(dek, record, activityEvidenceRecordSchema) as ActivityEvidenceRecord;
    } catch {
      return { version: 1, entries: [] };
    }
  }

  private async saveActivityEvidenceLocked(
    dek: Uint8Array,
    vaultId: string,
    evidence: ActivityEvidenceRecord,
  ): Promise<void> {
    const cache = this.deps.walletCache;
    if (!cache) return;
    const key = this.cacheKey(vaultId, 'activityEvidence', 'all');
    await cache.put(sealRecord(
      dek,
      evidence,
      key,
      this.deps.vaultDeps.random(24),
      this.deps.vaultDeps.now(),
    ));
  }

  // ---- passkey convenience unlock (ADR 0007 §5, Workstream A2) -------------
  //
  // The whole op surface lives in passkey-service.ts (extracted; see its
  // header for the two-tier lock contract). These methods only delegate, so
  // the dispatch table and every caller are unchanged; the context lends the
  // module this service's own serialization queue and session machinery
  // rather than letting it grow its own.

  /** The helper context plus the service hooks the extracted ops borrow. */
  private passkeyOpsContext(): PasskeyOpsContext {
    return {
      ...this.passkeyContext(),
      passkeyRpOrigin: this.deps.passkeyRpOrigin,
      newSessionId: () => this.deps.newSessionId(),
      runExclusive: <T,>(fn: () => Promise<T>) => this.runExclusive(fn),
      activeRecord: (expectation) => this.activeRecord(expectation),
      requireSession: (expectation) => this.requireSession(expectation),
      touchSessionLocked: (session) => this.touchSessionLocked(session),
      installSessionLocked: (vaultId, dek, profileKey) =>
        this.installSessionLocked(vaultId, dek, profileKey),
    };
  }

  async passkeyChallenge(input: PasskeyChallengeRequest): Promise<PasskeyChallengeResult> {
    return passkeyChallenge(this.passkeyOpsContext(), input);
  }

  async passkeyBeginEnrollment(
    input: PasskeyBeginEnrollmentRequest,
  ): Promise<PasskeyBeginEnrollmentResult> {
    return passkeyBeginEnrollment(this.passkeyOpsContext(), input);
  }

  async passkeyEnroll(input: PasskeyEnrollRequest): Promise<PasskeyEnrollResult> {
    return passkeyEnroll(this.passkeyOpsContext(), input);
  }

  async passkeyUnlock(
    input: PasskeyUnlockRequest,
  ): Promise<{ vaultId: string; sessionId: string; deadline: number }> {
    const result = await passkeyUnlock(this.passkeyOpsContext(), input);
    // Outside the queue, exactly as the password unlock does it.
    void this.retryBroadcasts().catch(() => undefined);
    return result;
  }

  async passkeyList(input: PasskeyListRequest): Promise<PasskeyListResult> {
    return passkeyList(this.passkeyOpsContext(), input);
  }

  async passkeyRename(input: PasskeyRenameRequest): Promise<{ renamed: boolean }> {
    return passkeyRename(this.passkeyOpsContext(), input);
  }

  async passkeyRemove(input: PasskeyRemoveRequest): Promise<{ removed: number }> {
    return passkeyRemove(this.passkeyOpsContext(), input);
  }

  // Community Vault is a separate mainnet-only product. These records never
  // enter the Spending vault map or the personal Vault coordinator namespace.
  private communityVaultContext(): CommunityVaultContext {
    return {
      local: this.deps.local,
      vaultDeps: this.deps.vaultDeps,
      calibrateKdf: () => this.deps.calibrateKdf(),
      runExclusive: <T,>(fn: () => Promise<T>) => this.runExclusive(fn),
      activeRecord: (expectation) => this.activeRecord(expectation),
      touchSessionLocked: (session) => this.touchSessionLocked(session),
    };
  }

  async communityVaultStatus(input: CommunityVaultStatusRequest): Promise<CommunityVaultStatusResult> {
    return communityVaultStatus(this.communityVaultContext(), input);
  }

  async communityVaultCreate(input: CommunityVaultCreateRequest): Promise<CommunityVaultOwnerResult> {
    const result = await communityVaultCreate(this.communityVaultContext(), input);
    await this.linkCommunityVaultOwner(input.campaignId, input.password);
    return result;
  }

  async communityVaultRestore(input: CommunityVaultRestoreRequest): Promise<CommunityVaultOwnerResult> {
    const result = await communityVaultRestore(this.communityVaultContext(), input);
    await this.linkCommunityVaultOwner(input.campaignId, input.password);
    return result;
  }

  private async linkCommunityVaultOwner(campaignId: string, password: string): Promise<void> {
    return this.runExclusive(async () => {
      const session = await this.liveSession();
      if (session?.profileKeyB64 === undefined) return;
      const profile = await loadProfileCredential(this.deps.local);
      if (profile === null) return;
      const owners = await loadCommunityVaultOwners(this.deps.local);
      const owner = owners.records.find((candidate) => candidate.campaignId === campaignId);
      if (owner === undefined || profile.secrets.some((secret) =>
        secret.kind === 'community-vault-owner-dek' && secret.secretId === owner.secret.vaultId)) return;
      const profileKey = base64ToBytes(session.profileKeyB64);
      const unlocked = await unlockVault(owner.secret, password);
      try {
        openVaultPayload(owner.secret, unlocked.dek);
        const wrapper = addProfileSecret({
          profileId: profile.credential.profileId,
          profileKey,
          secretId: owner.secret.vaultId,
          kind: 'community-vault-owner-dek',
          secret: unlocked.dek,
        }, this.deps.vaultDeps);
        await saveProfileCredential(this.deps.local, {
          ...profile,
          secrets: [...profile.secrets, wrapper],
        });
      } finally {
        profileKey.fill(0);
        unlocked.dek.fill(0);
      }
    });
  }

  async communityVaultRevealRecovery(
    input: CommunityVaultPasswordCampaignRequest,
  ): Promise<{ mnemonic: string }> {
    return communityVaultRevealRecovery(this.communityVaultContext(), input);
  }

  async communityVaultConfirmRecovery(
    input: CommunityVaultConfirmRecoveryRequest,
  ) {
    return communityVaultConfirmRecovery(this.communityVaultContext(), input);
  }

  async communityVaultAcceptPolicy(input: CommunityVaultAcceptPolicyRequest) {
    return communityVaultAcceptPolicy(this.communityVaultContext(), input);
  }

  async communityVaultSign(input: CommunityVaultSignRequest) {
    return communityVaultSign(this.communityVaultContext(), input);
  }

  // ---- Vault coordinator, disposable Desktop role A (ADR 0007, Workstream C)
  //
  // The whole coordinator surface lives in vault-coordinator-service.ts
  // (extracted; see its header for the capability refusal and lock contract).
  // These methods only delegate, so the dispatch table and every caller are
  // unchanged; the context lends the module this service's own serialization
  // queue and session machinery rather than letting it grow its own.

  /** Deps slice plus service hooks for the extracted coordinator surface. */
  private vaultCoordinatorContext(): VaultCoordinatorContext {
    return {
      local: this.deps.local,
      session: this.deps.session,
      network: this.deps.network,
      vaultDeps: this.deps.vaultDeps,
      gateway: this.deps.gateway,
      capability: this.deps.vaultCoordinatorCapability,
      passkeyRpOrigin: this.deps.passkeyRpOrigin,
      newVaultId: () => this.deps.newVaultId(),
      calibrateKdf: () => this.deps.calibrateKdf(),
      runExclusive: <T,>(fn: () => Promise<T>) => this.runExclusive(fn),
      activeRecord: (expectation) => this.activeRecord(expectation),
      touchSessionLocked: (session) => this.touchSessionLocked(session),
      withActiveDek: <T,>(
        expectation: ActiveSessionRequest,
        fn: (payload: VaultPayloadV1, vaultId: string, session: UnlockSession) => Promise<T> | T,
      ) => this.withActiveDek(expectation, fn),
      gatewayStatus: (input) => this.gatewayStatus(input),
      mintPasskeyChallenge: (vaultId) =>
        mintPasskeyUnlockChallenge(this.passkeyContext(), vaultId),
      consumePasskeyChallenge: (clientDataJSONB64, vaultId) =>
        consumePasskeyUnlockChallenge(this.passkeyContext(), clientDataJSONB64, vaultId),
    };
  }

  async vaultCoordinatorStatus(
    input: VaultCoordinatorStatusRequest,
  ): Promise<VaultCoordinatorStatusResult> {
    return vaultCoordinatorStatus(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorCreateRole(
    input: VaultCoordinatorCreateRoleRequest,
  ): Promise<VaultCoordinatorCreateRoleResult> {
    return vaultCoordinatorCreateRole(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorRestoreRole(
    input: VaultCoordinatorRestoreRoleRequest,
  ): Promise<VaultCoordinatorRestoreRoleResult> {
    return vaultCoordinatorRestoreRole(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorRoleOrigin(
    input: VaultCoordinatorRoleOriginRequest,
  ): Promise<VaultCoordinatorRoleOriginResult> {
    return vaultCoordinatorRoleOrigin(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorProveRole(
    input: VaultCoordinatorProveRoleRequest,
  ): Promise<VaultCoordinatorProveRoleResult> {
    return vaultCoordinatorProveRole(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorRevealRole(
    input: VaultCoordinatorRevealRoleRequest,
  ): Promise<{ mnemonic: string }> {
    return vaultCoordinatorRevealRole(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorBeginRoleRecoveryExport(
    input: VaultCoordinatorBeginRoleRecoveryExportRequest,
  ): Promise<VaultCoordinatorBeginRoleRecoveryExportResult> {
    return vaultCoordinatorBeginRoleRecoveryExport(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorExportRoleRecovery(
    input: VaultCoordinatorExportRoleRecoveryRequest,
  ): Promise<VaultCoordinatorExportRoleRecoveryResult> {
    return vaultCoordinatorExportRoleRecovery(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorRemoveRole(
    input: VaultCoordinatorRemoveRoleRequest,
  ): Promise<{ removed: boolean }> {
    return vaultCoordinatorRemoveRole(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorBeginImport(
    input: VaultCoordinatorBeginImportRequest,
  ): Promise<VaultCoordinatorBeginImportResult> {
    return vaultCoordinatorBeginImport(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorBeginRecoveryCSetup(
    input: VaultCoordinatorBeginRecoveryCSetupRequest,
  ): Promise<VaultCoordinatorRecoveryCChallengeResult> {
    return vaultCoordinatorBeginRecoveryCSetup(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorCancelRecoveryCSetup(
    input: VaultCoordinatorCancelRecoveryCSetupRequest,
  ): Promise<{ cancelled: true }> {
    return vaultCoordinatorCancelRecoveryCSetup(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorImportRecoveryCSetupResponse(
    input: VaultCoordinatorImportRecoveryCSetupResponseRequest,
  ): Promise<VaultCoordinatorImportSignerResult> {
    return vaultCoordinatorImportRecoveryCSetupResponse(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorImportSigner(
    input: VaultCoordinatorImportSignerRequest,
  ): Promise<VaultCoordinatorImportSignerResult> {
    return vaultCoordinatorImportSigner(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorCreatePolicy(
    input: VaultCoordinatorCreatePolicyRequest,
  ): Promise<VaultCoordinatorCreatePolicyResult> {
    return vaultCoordinatorCreatePolicy(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorPolicy(
    input: VaultCoordinatorPolicyRequest,
  ): Promise<VaultCoordinatorPolicyResult> {
    return vaultCoordinatorPolicy(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorPolicyPairingQr(
    input: VaultCoordinatorPolicyPairingQrRequest,
  ): Promise<VaultCoordinatorPolicyPairingQrResult> {
    return vaultCoordinatorPolicyPairingQr(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorAcknowledgePolicyPairing(
    input: VaultCoordinatorAcknowledgePolicyPairingRequest,
  ): Promise<VaultCoordinatorAcknowledgePolicyPairingResult> {
    return vaultCoordinatorAcknowledgePolicyPairing(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorRecoveryKit(
    input: VaultCoordinatorRecoveryKitRequest,
  ): Promise<VaultCoordinatorRecoveryKitResult> {
    return vaultCoordinatorRecoveryKit(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorAcknowledgeRecoveryKitExport(
    input: VaultCoordinatorAcknowledgeRecoveryKitExportRequest,
  ): Promise<{ policyId: string; kitExported: true }> {
    return vaultCoordinatorAcknowledgeRecoveryKitExport(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorBeginRecoveryCBackupCheck(
    input: VaultCoordinatorBeginRecoveryCBackupCheckRequest,
  ): Promise<VaultCoordinatorRecoveryCChallengeResult> {
    return vaultCoordinatorBeginRecoveryCBackupCheck(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorImportRecoveryCBackupCheckResponse(
    input: VaultCoordinatorImportRecoveryCBackupCheckResponseRequest,
  ): Promise<{ policyId: string; completed: true }> {
    return vaultCoordinatorImportRecoveryCBackupCheckResponse(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorRecoveryCReadiness(
    input: VaultCoordinatorRecoveryCReadinessRequest,
  ): Promise<VaultCoordinatorRecoveryCReadinessResult> {
    return vaultCoordinatorRecoveryCReadiness(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorRemovePolicy(
    input: VaultCoordinatorRemovePolicyRequest,
  ): Promise<{ removed: boolean }> {
    return vaultCoordinatorRemovePolicy(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorScan(
    input: VaultCoordinatorScanRequest,
  ): Promise<VaultCoordinatorScanResult> {
    return vaultCoordinatorScan(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorDepositAddress(
    input: VaultCoordinatorDepositAddressRequest,
  ): Promise<VaultCoordinatorDepositAddressResult> {
    return vaultCoordinatorDepositAddress(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorBuildPlan(
    input: VaultCoordinatorBuildPlanRequest,
  ): Promise<VaultCoordinatorBuildPlanResult> {
    return vaultCoordinatorBuildPlan(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorBuildCpfp(
    input: VaultCoordinatorBuildCpfpRequest,
  ): Promise<VaultCoordinatorBuildPlanResult> {
    return vaultCoordinatorBuildCpfp(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorPlan(
    input: VaultCoordinatorPlanRequest,
  ): Promise<VaultCoordinatorPlanResult> {
    return vaultCoordinatorPlan(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorSignPlan(
    input: VaultCoordinatorSignPlanRequest,
  ): Promise<VaultCoordinatorSignPlanResult> {
    return vaultCoordinatorSignPlan(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorSignMobileRequest(
    input: VaultCoordinatorSignMobileRequestRequest,
  ): Promise<VaultCoordinatorSignMobileRequestResult> {
    return vaultCoordinatorSignMobileRequest(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorCombinePlan(
    input: VaultCoordinatorCombinePlanRequest,
  ): Promise<VaultCoordinatorCombinePlanResult> {
    return vaultCoordinatorCombinePlan(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorFinalizePlan(
    input: VaultCoordinatorFinalizePlanRequest,
  ): Promise<VaultCoordinatorFinalizePlanResult> {
    return vaultCoordinatorFinalizePlan(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorBroadcastPlan(
    input: VaultCoordinatorBroadcastPlanRequest,
  ): Promise<VaultCoordinatorPlanBroadcast> {
    return vaultCoordinatorBroadcastPlan(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorReconcilePlan(
    input: VaultCoordinatorReconcilePlanRequest,
  ): Promise<VaultCoordinatorPlanBroadcast> {
    return vaultCoordinatorReconcilePlan(this.vaultCoordinatorContext(), input);
  }

  async vaultCoordinatorDiscardPlan(
    input: VaultCoordinatorDiscardPlanRequest,
  ): Promise<{ removed: boolean }> {
    return vaultCoordinatorDiscardPlan(this.vaultCoordinatorContext(), input);
  }

  // ---- internals -----------------------------------------------------------
  //
  // The passkey helper internals live in passkey-service.ts (extracted); they
  // run under this class's serialization queue via passkeyContext().

  /** Active vault record for a live session (already holding the lock). */
  private async activeRecord(
    expectation: ActiveSessionRequest,
  ): Promise<{ record: VaultRecordV1; session: UnlockSession }> {
    const session = await this.requireSession(expectation);
    const map = await loadVaults(this.deps.local);
    const record = map[session.vaultId];
    if (!record) throw new RpcError('ERR_VAULT_NOT_FOUND', 'active vault record missing');
    return { record, session };
  }

  /**
   * Decrypt the active vault's payload with the session DEK, run `fn`, and
   * zeroize the DEK on every path. The payload object itself contains hex
   * strings (not zeroizable); callers convert to bytes and zeroize those.
   */
  private async withActiveDek<T>(
    expectation: ActiveSessionRequest,
    fn: (payload: VaultPayloadV1, vaultId: string, session: UnlockSession) => Promise<T> | T,
  ): Promise<T> {
    const { record, session } = await this.activeRecord(expectation);
    const dek = base64ToBytes(session.dekB64);
    try {
      return await fn(openVaultPayload(record, dek), record.vaultId, session);
    } finally {
      zeroize(dek);
    }
  }

  /** Unlock core (already holding the serialization lock). Verifies the password
   * before clearing any prior session, so a wrong password is a no-op. */
  private async unlockLocked(
    input: { vaultId: string; password?: string },
  ): Promise<{ vaultId: string; sessionId: string; deadline: number }> {
    const map = await loadVaults(this.deps.local);
    const record = map[input.vaultId];
    if (!record) throw new RpcError('ERR_VAULT_NOT_FOUND', 'vault not found');

    const live = await this.liveSession();
    const profile = await loadProfileCredential(this.deps.local);
    if (live?.profileKeyB64 !== undefined && profile !== null) {
      const profileKey = base64ToBytes(live.profileKeyB64);
      let dek: Uint8Array | null = null;
      try {
        let wrapper = profileWalletSecret(profile, record.vaultId);
        if (wrapper === null) {
          if (input.password === undefined) {
            throw new RpcError('ERR_WRONG_PASSWORD', 'legacy wallet password required once');
          }
          wrapper = await linkLegacyVaultToProfile({
            record,
            password: input.password,
            profileId: profile.credential.profileId,
            profileKey,
          }, this.deps.vaultDeps);
          await saveProfileCredential(this.deps.local, {
            ...profile,
            secrets: [...profile.secrets, wrapper],
          });
        }
        dek = unwrapProfileSecret(wrapper, profileKey);
        openVaultPayload(record, dek);
        return await this.installSessionLocked(record.vaultId, dek, profileKey);
      } finally {
        dek?.fill(0);
        profileKey.fill(0);
      }
    }

    if (input.password === undefined) {
      throw new RpcError('ERR_WRONG_PASSWORD', 'app password required');
    }
    const unlocked = await this.unlockRecordWithProfile(map, record, input.password);
    try {
      // Single active vault (spec §7.3): drop any prior session only after the
      // new password has verified above.
      return await this.installSessionLocked(record.vaultId, unlocked.dek, unlocked.profileKey);
    } finally {
      zeroize(unlocked.dek);
      zeroize(unlocked.profileKey);
    }
  }

  private async createProfileFromLegacyPassword(
    map: VaultRecordMap,
    activeRecord: VaultRecordV1,
    password: string,
    activeDek: Uint8Array,
  ): Promise<{ state: StoredProfileCredentialV1; profileKey: Uint8Array }> {
    const kdfParams = await this.deps.calibrateKdf();
    const profileId = `profile:${this.deps.newVaultId()}`;
    const created = await createProfileCredential(
      { profileId, password, kdfParams }, this.deps.vaultDeps,
    );
    try {
      const secrets = [addProfileSecret({
        profileId,
        profileKey: created.profileKey,
        secretId: activeRecord.vaultId,
        kind: 'wallet-dek',
        secret: activeDek,
      }, this.deps.vaultDeps)];
      for (const record of Object.values(map)) {
        if (record.vaultId === activeRecord.vaultId) continue;
        try {
          secrets.push(await linkLegacyVaultToProfile({
            record, password, profileId, profileKey: created.profileKey,
          }, this.deps.vaultDeps));
        } catch (error) {
          // A record with another legacy password is retained and linked from
          // an authenticated profile session when the user selects it.
          if (!(error instanceof VaultError && error.code === 'wrong-password')) throw error;
        }
      }
      const community = await loadCommunityVaultOwners(this.deps.local);
      if (community.unusableCampaignIds.length > 0) {
        throw new VaultError('tampered', 'Community Vault owner record is unreadable');
      }
      for (const owner of community.records) {
        let unlocked: Awaited<ReturnType<typeof unlockVault>> | null = null;
        try {
          unlocked = await unlockVault(owner.secret, password);
          openVaultPayload(owner.secret, unlocked.dek);
          secrets.push(addProfileSecret({
            profileId,
            profileKey: created.profileKey,
            secretId: owner.secret.vaultId,
            kind: 'community-vault-owner-dek',
            secret: unlocked.dek,
          }, this.deps.vaultDeps));
        } catch (error) {
          if (!(error instanceof VaultError && error.code === 'wrong-password')) throw error;
        } finally {
          unlocked?.dek.fill(0);
        }
      }
      const state: StoredProfileCredentialV1 = {
        version: 1,
        credential: created.credential,
        secrets,
      };
      await saveProfileCredential(this.deps.local, state);
      return { state, profileKey: created.profileKey };
    } catch (error) {
      created.profileKey.fill(0);
      throw error;
    }
  }

  private async unlockRecordWithProfile(
    map: VaultRecordMap,
    record: VaultRecordV1,
    password: string,
  ): Promise<{ dek: Uint8Array; profileKey: Uint8Array }> {
    const profile = await loadProfileCredential(this.deps.local);
    if (profile === null) {
      const unlocked = await unlockVault(record, password);
      try {
        const created = await this.createProfileFromLegacyPassword(map, record, password, unlocked.dek);
        return { dek: unlocked.dek, profileKey: created.profileKey };
      } catch (error) {
        unlocked.dek.fill(0);
        throw error;
      }
    }
    const profileKey = await unlockProfileCredential(profile.credential, password);
    try {
      let wrapper = profileWalletSecret(profile, record.vaultId);
      if (wrapper === null) {
        try {
          wrapper = await linkLegacyVaultToProfile({
            record,
            password,
            profileId: profile.credential.profileId,
            profileKey,
          }, this.deps.vaultDeps);
        } catch (error) {
          if (!(error instanceof VaultError && error.code === 'wrong-password')) throw error;
          wrapper = await linkLegacyVaultToProfile({
            record,
            password: bytesToBase64(profileKey),
            profileId: profile.credential.profileId,
            profileKey,
          }, this.deps.vaultDeps);
        }
        await saveProfileCredential(this.deps.local, {
          ...profile,
          secrets: [...profile.secrets, wrapper],
        });
      }
      const dek = unwrapProfileSecret(wrapper, profileKey);
      openVaultPayload(record, dek);
      return { dek, profileKey };
    } catch (error) {
      profileKey.fill(0);
      throw error;
    }
  }

  private async verifyAppPassword(record: VaultRecordV1, password: string): Promise<void> {
    const profile = await loadProfileCredential(this.deps.local);
    if (profile === null) {
      await verifyVaultPassword(record, password);
      return;
    }
    const profileKey = await unlockProfileCredential(profile.credential, password);
    profileKey.fill(0);
  }

  /**
   * Installs a fresh session for an already-verified DEK — the shared tail of
   * password and passkey unlock. The caller keeps ownership of `dek` and
   * zeroizes it on every path.
   */
  private async installSessionLocked(
    vaultId: string,
    dek: Uint8Array,
    profileKey?: Uint8Array,
  ): Promise<{ vaultId: string; sessionId: string; deadline: number }> {
    const sessionId = this.deps.newSessionId();
    try {
      await this.clearSessionAndScanState();
      await saveActiveVaultId(this.deps.local, null);
      const deadline = await this.nextDeadline();
      // Commit the non-secret pointer before installing the DEK. Once the
      // session write succeeds there are no later fallible storage writes, so
      // an RPC can never fail after unlock material has gone live.
      await saveActiveVaultId(this.deps.local, vaultId);
      await putSession(this.deps.session, {
        sessionId,
        vaultId,
        dekB64: bytesToBase64(dek),
        ...(profileKey === undefined ? {} : { profileKeyB64: bytesToBase64(profileKey) }),
        deadline,
      });
      this.notifySessionChanged(false);
      return { vaultId, sessionId, deadline };
    } catch (err) {
      // Never report an unlock failure while leaving a newly installed DEK
      // live or a local pointer claiming the failed vault is active.
      await this.clearSessionAndScanState().catch(() => undefined);
      await saveActiveVaultId(this.deps.local, null).catch(() => undefined);
      this.notifySessionChanged(true);
      throw err;
    }
  }

  /** Read the session, clearing it if the idle deadline has passed. */
  private async liveSession(): Promise<UnlockSession | null> {
    const session = await getSession(this.deps.session);
    if (!session) return null;
    if (session.deadline <= this.deps.vaultDeps.now()) {
      await this.clearSessionAndScanState();
      this.notifySessionChanged(true);
      return null;
    }
    return session;
  }

  private async nextDeadline(): Promise<number> {
    const config = await loadConfig(this.deps.local);
    return this.deps.vaultDeps.now() + config.idleTimeoutMs;
  }

  private async requireSession(expectation: ActiveSessionRequest): Promise<UnlockSession> {
    const session = await this.liveSession();
    if (
      !session ||
      session.vaultId !== expectation.expectedVaultId ||
      session.sessionId !== expectation.expectedSessionId
    ) {
      // Treat a stale session identity exactly like a lock. This reveals no
      // information about whichever vault may now be active.
      throw new RpcError('ERR_LOCKED', 'wallet session changed');
    }
    return session;
  }

  /**
   * Exact-session check for detached, non-authoritative reads.
   *
   * Unlike `requireSession`, this never repairs session storage. Cleanup must
   * stay on the serialized lifecycle path so an expired or malformed value
   * observed before a concurrent unlock cannot clear the newly installed DEK.
   */
  private async peekExpectedSession(expectation: ActiveSessionRequest): Promise<UnlockSession> {
    const session = await peekSession(this.deps.session);
    if (
      !session ||
      session.deadline <= this.deps.vaultDeps.now() ||
      session.vaultId !== expectation.expectedVaultId ||
      session.sessionId !== expectation.expectedSessionId
    ) {
      throw new RpcError('ERR_LOCKED', 'wallet session changed');
    }
    return session;
  }

  private async touchSessionLocked(session: UnlockSession): Promise<void> {
    if (session.deadline <= this.deps.vaultDeps.now()) {
      await this.clearSessionAndScanState();
      this.notifySessionChanged(true);
      throw new RpcError('ERR_LOCKED', 'wallet session expired');
    }
    const deadline = await this.nextDeadline();
    await putSession(this.deps.session, { ...session, deadline });
    this.notifySessionChanged(false);
  }

  private notifySessionChanged(locked: boolean): void {
    try {
      this.deps.notifySessionChanged?.(locked);
    } catch {
      // UI invalidation is best-effort; storage remains the authority.
    }
  }

  private async persistNewVault(
    name: string,
    password: string | undefined,
    payload: VaultPayloadV1,
    operationId?: string,
    mode: 'create' | 'restore' = 'create',
  ): Promise<{ vaultId: string }> {
    const map = await loadVaults(this.deps.local);
    if ((await countQuarantinedVaults(this.deps.local)) > 0) {
      // Adding or rewrapping around an unreadable record could violate the
      // one-app-password invariant. Healthy vaults remain listable/unlockable,
      // but profile-wide mutations require recovery of quarantined records.
      throw new RpcError('ERR_VAULT_TAMPERED', 'profile contains quarantined vault records');
    }
    // A stable UI operation ID doubles as the vault ID namespace. If the worker
    // completed persistence but its response was lost, retry returns the same
    // durable record instead of generating a duplicate vault.
    const vaultId = operationId === undefined ? this.deps.newVaultId() : `operation:${mode}:${operationId}`;
    const live = password === undefined ? await this.liveSession() : null;
    const sessionProfileKey = live?.profileKeyB64 === undefined
      ? null
      : base64ToBytes(live.profileKeyB64);
    if (password === undefined && sessionProfileKey === null) {
      throw new RpcError('ERR_WRONG_PASSWORD', 'an unlocked profile is required');
    }
    const effectivePassword = password ?? bytesToBase64(sessionProfileKey!);
    const existing = map[vaultId];
    if (existing !== undefined) {
      let ownedProfileKey: Uint8Array | null = null;
      let unlocked: Awaited<ReturnType<typeof unlockVault>> | null = null;
      try {
        await this.assertIdempotentRetry(existing, name, effectivePassword, payload, mode);
        let profile = await loadProfileCredential(this.deps.local);
        if (profile === null || profileWalletSecret(profile, vaultId) === null) {
          let linkingKey = sessionProfileKey;
          if (linkingKey === null) {
            if (profile === null) {
              const created = await createProfileCredential({
                profileId: `profile:${vaultId}`,
                password: effectivePassword,
                kdfParams: existing.kdf,
              }, this.deps.vaultDeps);
              ownedProfileKey = created.profileKey;
              linkingKey = ownedProfileKey;
              profile = { version: 1, credential: created.credential, secrets: [] };
            } else {
              ownedProfileKey = await unlockProfileCredential(profile.credential, effectivePassword);
              linkingKey = ownedProfileKey;
            }
          }
          if (profile === null) throw new Error('profile credential unavailable');
          unlocked = await unlockVault(existing, effectivePassword);
          const wrapper = addProfileSecret({
            profileId: profile.credential.profileId,
            profileKey: linkingKey,
            secretId: vaultId,
            kind: 'wallet-dek',
            secret: unlocked.dek,
          }, this.deps.vaultDeps);
          await saveProfileCredential(this.deps.local, {
            ...profile,
            secrets: [...profile.secrets, wrapper],
          });
        }
        return { vaultId };
      } finally {
        unlocked?.dek.fill(0);
        ownedProfileKey?.fill(0);
        sessionProfileKey?.fill(0);
      }
    }

    let ownedProfileKey: Uint8Array | null = null;
    let unlocked: Awaited<ReturnType<typeof unlockVault>> | null = null;
    try {
      if (password !== undefined) await this.assertAppPassword(map, password);
      const kdfParams = await this.deps.calibrateKdf();
      const record = await createVaultRecord({
        vaultId, name, password: effectivePassword, payload, kdfParams,
      }, this.deps.vaultDeps);
      let profile = await loadProfileCredential(this.deps.local);
      let linkingKey = sessionProfileKey;
      if (linkingKey === null) {
        if (profile === null) {
          const created = await createProfileCredential({
            profileId: `profile:${vaultId}`,
            password: effectivePassword,
            kdfParams,
          }, this.deps.vaultDeps);
          ownedProfileKey = created.profileKey;
          linkingKey = ownedProfileKey;
          profile = { version: 1, credential: created.credential, secrets: [] };
        } else {
          ownedProfileKey = await unlockProfileCredential(profile.credential, effectivePassword);
          linkingKey = ownedProfileKey;
        }
      }
      if (profile === null) throw new Error('profile credential unavailable');
      unlocked = await unlockVault(record, effectivePassword);
      const wrapper = addProfileSecret({
        profileId: profile.credential.profileId,
        profileKey: linkingKey,
        secretId: vaultId,
        kind: 'wallet-dek',
        secret: unlocked.dek,
      }, this.deps.vaultDeps);
      const nextProfile = { ...profile, secrets: [...profile.secrets, wrapper] };

      map[vaultId] = record;
      // The password-wrapped record remains independently recoverable if the
      // following profile write is interrupted.
      await saveVaults(this.deps.local, map);
      await saveProfileCredential(this.deps.local, nextProfile);
      return { vaultId };
    } finally {
      unlocked?.dek.fill(0);
      ownedProfileKey?.fill(0);
      sessionProfileKey?.fill(0);
    }
  }

  private async assertAppPassword(map: VaultRecordMap, password: string): Promise<void> {
    for (const record of Object.values(map)) {
      const unlocked = await unlockVault(record, password);
      try {
        // Successful unwrap/open is the proof; no payload data leaves this scope.
      } finally {
        zeroize(unlocked.dek);
      }
    }
  }

  private async assertIdempotentRetry(
    record: VaultRecordV1,
    name: string,
    password: string,
    requestedPayload: VaultPayloadV1,
    mode: 'create' | 'restore',
  ): Promise<void> {
    const unlocked = await unlockVault(record, password);
    try {
      const sameName = record.name === name;
      const sameRestore =
        mode === 'create' ||
        (unlocked.payload.entropyHex === requestedPayload.entropyHex &&
          unlocked.payload.seedHex === requestedPayload.seedHex &&
          unlocked.payload.passphrase === requestedPayload.passphrase);
      if (!sameName || !sameRestore) {
        throw new RpcError('ERR_INVALID_PAYLOAD', 'operationId was reused with different vault input');
      }
    } finally {
      zeroize(unlocked.dek);
    }
  }
}
