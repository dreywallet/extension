/**
 * RPC dispatcher (spec §5.2, §7.5). Validates an already-parsed envelope against
 * the op registry, gates sender context, enforces the locked-privacy unlock gate,
 * runs the state-machine method, and maps every failure onto a stable ErrorCode.
 * Chrome-agnostic: it only touches the injected WalletService and the registry.
 */
import { VaultError } from '@drey/core/domain/vault/errors';
import type { MessageEnvelope } from '@drey/core/messaging/envelope';
import {
  EXTENSION_OP_SCHEMAS,
  type ExtensionLocalOp,
  type WireErrorCode,
} from '../messaging/extension-ops';
import {
  type PasskeyBeginEnrollmentRequest,
  type PasskeyChallengeRequest,
  type PasskeyEnrollRequest,
  type PasskeyListRequest,
  type PasskeyOp,
  type PasskeyRemoveRequest,
  type PasskeyRenameRequest,
  type PasskeyUnlockRequest,
} from '../messaging/passkey-ops';
import {
  type VaultCoordinatorBeginImportRequest,
  type VaultCoordinatorBeginRoleRecoveryExportRequest,
  type VaultCoordinatorBeginRecoveryCBackupCheckRequest,
  type VaultCoordinatorBeginRecoveryCSetupRequest,
  type VaultCoordinatorCancelRecoveryCSetupRequest,
  type VaultCoordinatorAcknowledgeRecoveryKitExportRequest,
  type VaultCoordinatorCreatePolicyRequest,
  type VaultCoordinatorCreateRoleRequest,
  type VaultCoordinatorImportSignerRequest,
  type VaultCoordinatorImportRecoveryCBackupCheckResponseRequest,
  type VaultCoordinatorImportRecoveryCSetupResponseRequest,
  type VaultCoordinatorOp,
  type VaultCoordinatorPolicyRequest,
  type VaultCoordinatorProveRoleRequest,
  type VaultCoordinatorRecoveryKitRequest,
  type VaultCoordinatorRecoveryCReadinessRequest,
  type VaultCoordinatorRemovePolicyRequest,
  type VaultCoordinatorRemoveRoleRequest,
  type VaultCoordinatorRestoreRoleRequest,
  type VaultCoordinatorRevealRoleRequest,
  type VaultCoordinatorExportRoleRecoveryRequest,
  type VaultCoordinatorScanRequest,
  type VaultCoordinatorBroadcastPlanRequest,
  type VaultCoordinatorReconcilePlanRequest,
  type VaultCoordinatorBuildPlanRequest,
  type VaultCoordinatorBuildCpfpRequest,
  type VaultCoordinatorCombinePlanRequest,
  type VaultCoordinatorDepositAddressRequest,
  type VaultCoordinatorDiscardPlanRequest,
  type VaultCoordinatorFinalizePlanRequest,
  type VaultCoordinatorPlanRequest,
  type VaultCoordinatorSignPlanRequest,
  type VaultCoordinatorSignMobileRequestRequest,
  type VaultCoordinatorRoleOriginRequest,
  type VaultCoordinatorStatusRequest,
} from '../messaging/vault-coordinator-ops';
import {
  type AccountVisibilitySetRequest,
  type ActiveSessionRequest,
  type ActivityInscriptionPreviewBatchRequest,
  type ActivityInscriptionPreviewRequest,
  type ActivityListRequest,
  type ActiveAccountSetRequest,
  type PublicAccountExportRequest,
  type PublicAccountImportRequest,
  type PublicAccountRemoveRequest,
  type ConnectedSiteRevokeRequest,
  type AddressReceiveRequest,
  type PaymentInstructionResolveRequest,
  type AddressBookAddRequest,
  type AddressBookImportRequest,
  type AddressBookDismissRecentRequest,
  type AddressBookRemoveRequest,
  type AddressBookRenameRequest,
  type ConfigSetRequest,
  type GatewayStatusRequest,
  type GalleryCachedRequest,
  type GalleryListRequest,
  type GalleryMediaLeaseRequest,
  type GalleryMediaOpenRequest,
  type GalleryUpdateRequest,
  type FeeQuoteRequest,
  type Op,
  type OpRegistry,
  type ScanCancelRequest,
  type ScanStartRequest,
  type UtxoSetFrozenRequest,
  type UtxoSetLabelRequest,
  type UtxoListRequest,
  type TransactionApproveRequest,
  type TransactionPlanRequest,
  type TransactionReviewRequest,
  type MessageSignRequest,
  type VaultChangePasswordRequest,
  type VaultCreateRequest,
  type VaultRestoreRequest,
  type VaultRemoveRequest,
  type VaultRevealMnemonicRequest,
  type VaultUnlockRequest,
  type VaultVerifyBackupRequest,
  type VaultVerifyFullRecoveryRequest,
} from '@drey/core/messaging/ops';
import { RpcError, vaultErrorToCode } from './errors';
import type { WalletService } from './wallet-service';

/** Core RpcResponse widened to the extension-local wire error codes. */
export type LocalRpcResponse =
  | { ok: true; result: unknown }
  | { ok: false; code: WireErrorCode };

export async function dispatch(
  envelope: MessageEnvelope,
  service: WalletService,
  registry: OpRegistry = EXTENSION_OP_SCHEMAS,
): Promise<LocalRpcResponse> {
  const spec = registry[envelope.op];
  if (!spec) return { ok: false, code: 'ERR_UNKNOWN_OPERATION' };
  if (!spec.allowedSenders.includes(envelope.sender)) {
    return { ok: false, code: 'ERR_UNAUTHORIZED_CONTEXT' };
  }

  const parsed = spec.request.safeParse(envelope.payload);
  if (!parsed.success) return { ok: false, code: 'ERR_INVALID_PAYLOAD' };

  // Locked-privacy gate (spec §7.5): reads that require an active session get a
  // locked error while the wallet is locked, before any handler runs. This runs
  // through the service's exclusive queue, so an op flagged
  // handlerEnforcesUnlock opts out and applies the same gate itself rather than
  // waiting behind whatever currently holds that queue.
  if (spec.requiresUnlock && spec.handlerEnforcesUnlock !== true) {
    if ((await service.sessionStatus()).locked) return { ok: false, code: 'ERR_LOCKED' };
  }

  try {
    const result = await handle(envelope.op, parsed.data, service);
    // Response backstop: never emit a shape the registry did not sanction.
    const checked = spec.response.safeParse(result);
    if (!checked.success) return { ok: false, code: 'ERR_INTERNAL' };
    return { ok: true, result: checked.data };
  } catch (err) {
    return { ok: false, code: errorToCode(err) };
  }
}

function errorToCode(err: unknown): WireErrorCode {
  if (err instanceof RpcError) return err.code;
  if (err instanceof VaultError) return vaultErrorToCode(err.code);
  return 'ERR_INTERNAL';
}

async function handle(op: string, payload: unknown, service: WalletService): Promise<unknown> {
  // op has already been confirmed present in the registry; the known ops route
  // to typed methods, any custom (test-injected) op falls through to internal.
  switch (op as Op | ExtensionLocalOp | PasskeyOp | VaultCoordinatorOp) {
    case 'wallet.home.snapshot':
      return service.homeSnapshot(payload as ActiveSessionRequest & { accountId: string });
    case 'gallery.home.cached':
      return service.galleryHomeCached(payload as GalleryCachedRequest);
    case 'vaultCoordinator.status':
      return service.vaultCoordinatorStatus(payload as VaultCoordinatorStatusRequest);
    case 'vaultCoordinator.createRole':
      return service.vaultCoordinatorCreateRole(payload as VaultCoordinatorCreateRoleRequest);
    case 'vaultCoordinator.restoreRole':
      return service.vaultCoordinatorRestoreRole(payload as VaultCoordinatorRestoreRoleRequest);
    case 'vaultCoordinator.roleOrigin':
      return service.vaultCoordinatorRoleOrigin(payload as VaultCoordinatorRoleOriginRequest);
    case 'vaultCoordinator.proveRole':
      return service.vaultCoordinatorProveRole(payload as VaultCoordinatorProveRoleRequest);
    case 'vaultCoordinator.revealRole':
      return service.vaultCoordinatorRevealRole(payload as VaultCoordinatorRevealRoleRequest);
    case 'vaultCoordinator.beginRoleRecoveryExport':
      return service.vaultCoordinatorBeginRoleRecoveryExport(
        payload as VaultCoordinatorBeginRoleRecoveryExportRequest,
      );
    case 'vaultCoordinator.exportRoleRecovery':
      return service.vaultCoordinatorExportRoleRecovery(
        payload as VaultCoordinatorExportRoleRecoveryRequest,
      );
    case 'vaultCoordinator.removeRole':
      return service.vaultCoordinatorRemoveRole(payload as VaultCoordinatorRemoveRoleRequest);
    case 'vaultCoordinator.beginImport':
      return service.vaultCoordinatorBeginImport(payload as VaultCoordinatorBeginImportRequest);
    case 'vaultCoordinator.beginRecoveryCSetup':
      return service.vaultCoordinatorBeginRecoveryCSetup(
        payload as VaultCoordinatorBeginRecoveryCSetupRequest,
      );
    case 'vaultCoordinator.cancelRecoveryCSetup':
      return service.vaultCoordinatorCancelRecoveryCSetup(
        payload as VaultCoordinatorCancelRecoveryCSetupRequest,
      );
    case 'vaultCoordinator.importRecoveryCSetupResponse':
      return service.vaultCoordinatorImportRecoveryCSetupResponse(
        payload as VaultCoordinatorImportRecoveryCSetupResponseRequest,
      );
    case 'vaultCoordinator.importSigner':
      return service.vaultCoordinatorImportSigner(payload as VaultCoordinatorImportSignerRequest);
    case 'vaultCoordinator.createPolicy':
      return service.vaultCoordinatorCreatePolicy(payload as VaultCoordinatorCreatePolicyRequest);
    case 'vaultCoordinator.policy':
      return service.vaultCoordinatorPolicy(payload as VaultCoordinatorPolicyRequest);
    case 'vaultCoordinator.recoveryKit':
      return service.vaultCoordinatorRecoveryKit(payload as VaultCoordinatorRecoveryKitRequest);
    case 'vaultCoordinator.acknowledgeRecoveryKitExport':
      return service.vaultCoordinatorAcknowledgeRecoveryKitExport(
        payload as VaultCoordinatorAcknowledgeRecoveryKitExportRequest,
      );
    case 'vaultCoordinator.beginRecoveryCBackupCheck':
      return service.vaultCoordinatorBeginRecoveryCBackupCheck(
        payload as VaultCoordinatorBeginRecoveryCBackupCheckRequest,
      );
    case 'vaultCoordinator.importRecoveryCBackupCheckResponse':
      return service.vaultCoordinatorImportRecoveryCBackupCheckResponse(
        payload as VaultCoordinatorImportRecoveryCBackupCheckResponseRequest,
      );
    case 'vaultCoordinator.recoveryCReadiness':
      return service.vaultCoordinatorRecoveryCReadiness(
        payload as VaultCoordinatorRecoveryCReadinessRequest,
      );
    case 'vaultCoordinator.removePolicy':
      return service.vaultCoordinatorRemovePolicy(payload as VaultCoordinatorRemovePolicyRequest);
    case 'vaultCoordinator.scan':
      return service.vaultCoordinatorScan(payload as VaultCoordinatorScanRequest);
    case 'vaultCoordinator.depositAddress':
      return service.vaultCoordinatorDepositAddress(
        payload as VaultCoordinatorDepositAddressRequest,
      );
    case 'vaultCoordinator.buildPlan':
      return service.vaultCoordinatorBuildPlan(payload as VaultCoordinatorBuildPlanRequest);
    case 'vaultCoordinator.buildCpfp':
      return service.vaultCoordinatorBuildCpfp(payload as VaultCoordinatorBuildCpfpRequest);
    case 'vaultCoordinator.plan':
      return service.vaultCoordinatorPlan(payload as VaultCoordinatorPlanRequest);
    case 'vaultCoordinator.signPlan':
      return service.vaultCoordinatorSignPlan(payload as VaultCoordinatorSignPlanRequest);
    case 'vaultCoordinator.signMobileRequest':
      return service.vaultCoordinatorSignMobileRequest(
        payload as VaultCoordinatorSignMobileRequestRequest,
      );
    case 'vaultCoordinator.combinePlan':
      return service.vaultCoordinatorCombinePlan(payload as VaultCoordinatorCombinePlanRequest);
    case 'vaultCoordinator.finalizePlan':
      return service.vaultCoordinatorFinalizePlan(payload as VaultCoordinatorFinalizePlanRequest);
    case 'vaultCoordinator.broadcastPlan':
      return service.vaultCoordinatorBroadcastPlan(
        payload as VaultCoordinatorBroadcastPlanRequest,
      );
    case 'vaultCoordinator.reconcilePlan':
      return service.vaultCoordinatorReconcilePlan(
        payload as VaultCoordinatorReconcilePlanRequest,
      );
    case 'vaultCoordinator.discardPlan':
      return service.vaultCoordinatorDiscardPlan(payload as VaultCoordinatorDiscardPlanRequest);
    case 'passkey.challenge':
      return service.passkeyChallenge(payload as PasskeyChallengeRequest);
    case 'passkey.beginEnrollment':
      return service.passkeyBeginEnrollment(payload as PasskeyBeginEnrollmentRequest);
    case 'passkey.enroll':
      return service.passkeyEnroll(payload as PasskeyEnrollRequest);
    case 'passkey.unlock':
      return service.passkeyUnlock(payload as PasskeyUnlockRequest);
    case 'passkey.list':
      return service.passkeyList(payload as PasskeyListRequest);
    case 'passkey.rename':
      return service.passkeyRename(payload as PasskeyRenameRequest);
    case 'passkey.remove':
      return service.passkeyRemove(payload as PasskeyRemoveRequest);
    case 'vault.create':
      return service.create(payload as VaultCreateRequest);
    case 'vault.restore':
      return service.restore(payload as VaultRestoreRequest);
    case 'vault.unlock':
      return service.unlock(payload as VaultUnlockRequest);
    case 'vault.lock':
      return service.lock();
    case 'vault.list':
      return service.list();
    case 'vault.switch':
      return service.switchVault(payload as VaultUnlockRequest);
    case 'vault.remove':
      return service.removeVault(payload as VaultRemoveRequest);
    case 'vault.changePassword':
      return service.changePassword(payload as VaultChangePasswordRequest);
    case 'session.status':
      return service.sessionStatus();
    case 'session.snapshot':
      return service.sessionSnapshot();
    case 'session.touch': {
      const deadline = await service.touchSession(payload as ActiveSessionRequest);
      if (deadline === null) throw new RpcError('ERR_LOCKED', 'wallet session expired');
      return { deadline };
    }
    case 'vault.revealMnemonic':
      return service.revealMnemonic(payload as VaultRevealMnemonicRequest);
    case 'vault.verifyBackup':
      return service.verifyBackup(payload as VaultVerifyBackupRequest);
    case 'vault.verifyFullRecovery':
      return service.verifyFullRecovery(payload as VaultVerifyFullRecoveryRequest);
    case 'backup.status':
      return service.backupStatus(payload as ActiveSessionRequest);
    case 'address.receive':
      return service.receiveAddress(payload as AddressReceiveRequest);
    case 'paymentInstruction.resolve':
      return service.resolvePaymentInstruction(payload as PaymentInstructionResolveRequest);
    case 'message.sign':
      return service.signMessage(payload as MessageSignRequest);
    case 'addressBook.list':
      return service.addressBook(payload as ActiveSessionRequest);
    case 'addressBook.add':
      return service.addAddressBookRecipient(payload as AddressBookAddRequest);
    case 'addressBook.rename':
      return service.renameAddressBookRecipient(payload as AddressBookRenameRequest);
    case 'addressBook.remove':
      return service.removeAddressBookRecipient(payload as AddressBookRemoveRequest);
    case 'addressBook.import':
      return service.importAddressBookRecipients(payload as AddressBookImportRequest);
    case 'addressBook.dismissRecent':
      return service.dismissRecentAddressBookRecipient(
        payload as AddressBookDismissRecentRequest,
      );
    case 'addressBook.clearRecent':
      return service.clearRecentAddressBookRecipients(payload as ActiveSessionRequest);
    case 'config.get':
      return service.getConfig();
    case 'config.set':
      return service.setConfig(payload as ConfigSetRequest);
    case 'account.active.get':
      return service.getActiveAccount(payload as ActiveSessionRequest);
    case 'account.active.set':
      return service.setActiveAccount(payload as ActiveAccountSetRequest);
    case 'account.add':
      return service.addAccount(payload as ActiveSessionRequest);
    case 'account.list':
      return service.listAccounts(payload as ActiveSessionRequest);
    case 'account.visibility.set':
      return service.setAccountVisibility(payload as AccountVisibilitySetRequest);
    case 'account.watch.import':
      return service.importWatchAccount(payload as PublicAccountImportRequest);
    case 'account.public.export':
      return service.exportPublicAccount(payload as PublicAccountExportRequest);
    case 'account.remove':
      return service.removeWatchAccount(payload as PublicAccountRemoveRequest);
    case 'provider.sites.list':
      return service.connectedSites(payload as ActiveSessionRequest);
    case 'provider.sites.revoke':
      return service.revokeConnectedSite(payload as ConnectedSiteRevokeRequest);
    case 'gateway.status':
      return service.gatewayStatus(payload as GatewayStatusRequest);
    case 'price.quote':
      return service.fiatPriceQuote();
    case 'wallet.home':
      return service.homeView(payload as ActiveSessionRequest & { accountId: string });
    case 'activity.list':
      return service.activityList(payload as ActivityListRequest);
    case 'activity.inscriptionPreview':
      return service.activityInscriptionPreview(payload as ActivityInscriptionPreviewRequest);
    case 'activity.inscriptionPreviewBatch':
      return service.activityInscriptionPreviewBatch(
        payload as ActivityInscriptionPreviewBatchRequest,
      );
    case 'gallery.list':
      return service.galleryList(payload as GalleryListRequest);
    case 'gallery.cached':
      return service.galleryCached(payload as GalleryCachedRequest);
    case 'gallery.update':
      return service.galleryUpdate(payload as GalleryUpdateRequest);
    case 'gallery.media.open':
      return service.galleryMediaOpen(payload as GalleryMediaOpenRequest);
    case 'gallery.media.lease':
      return service.galleryMediaLease(payload as GalleryMediaLeaseRequest);
    case 'scan.start':
      return service.startScan(payload as ScanStartRequest);
    case 'scan.status':
      return service.scanStatus(payload as ActiveSessionRequest);
    case 'scan.cancel':
      return service.cancelScan(payload as ScanCancelRequest);
    case 'scan.extend':
      return service.extendScan(payload as ScanCancelRequest);
    case 'utxo.setFrozen':
      return service.setUtxoFrozen(payload as UtxoSetFrozenRequest);
    case 'utxo.setLabel':
      return service.setUtxoLabel(payload as UtxoSetLabelRequest);
    case 'fees.quote':
      return service.feeQuote(payload as FeeQuoteRequest);
    case 'utxo.list':
      return service.listUtxos(payload as UtxoListRequest);
    case 'transaction.plan':
      return service.createTransactionPlan(payload as TransactionPlanRequest);
    case 'transaction.review':
      return service.reviewTransactionPlan(payload as TransactionReviewRequest);
    case 'transaction.approve':
      return service.approveTransaction(payload as TransactionApproveRequest);
    case 'transaction.cancel':
      return service.cancelTransactionPlan(payload as TransactionReviewRequest);
    case 'transaction.status':
      return service.transactionStatus(payload as ActiveSessionRequest & { accountId: string });
    default:
      throw new RpcError('ERR_UNKNOWN_OPERATION', `no handler for op ${op}`);
  }
}
