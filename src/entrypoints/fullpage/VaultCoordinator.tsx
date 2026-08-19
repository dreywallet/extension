/**
 * Vault coordinator surface: roles, policy, and balance (ADR 0007 §8,
 * Workstreams C0-C2).
 *
 * This page exists only in test and production builds. It is gated twice
 * and independently: `vaultCoordinatorChannelEnabled()` decides whether it
 * renders at all, and the worker refuses every op unless its own injected
 * coordinator capability is present. Neither gate consults storage, the
 * gateway, or the page.
 *
 * The banner is chosen from the worker's reported movement, and the pilot's
 * limits are shown from the worker's own capability rather than from a
 * UI-side copy of them. That is presentation, not control: what a build may
 * move is decided by the capability the composition root injected, and the
 * numbers a user reads here are the numbers the worker will refuse on.
 *
 * The plan lifecycle — build, sign, combine, finalize, send — lives in
 * `vault/VaultPlanPanel.tsx`, and the form captions live in `vault/modes.ts`.
 * Both were split out rather than added here: this component already carried
 * ten ceremonies, and the one surface that can move real value should not be
 * the hardest one to read.
 *
 * The role's recovery words are rendered only after explicit password
 * reauthentication. Secret input and reveal bytes use uncontrolled DOM refs,
 * never React state; leaving the ceremony wipes both nodes. They are not the
 * Spending Recovery Phrase and the copy says so.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../ui/i18n';
import { useRpc } from '../../ui/hooks/use-rpc';
import { errorMessageKey } from '../../ui/errors';
import { Button } from '../../ui/components/Button';
import { QrCode } from '../../ui/components/QrCode';
import { Field } from '../../ui/components/Field';
import styles from './fullpage.module.css';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import { VAULT_MODE_SPECS, type VaultModeKind } from './vault/modes';
import { VaultPlanPanel } from './vault/VaultPlanPanel';
import { VaultKitTransport } from './vault/VaultKitTransport';
import { VaultRoleARecoveryExport } from './vault/VaultRoleARecoveryExport';
import {
  downloadRecoveryCRecord,
  readRecoveryCRecord,
} from './vault/recovery-c-files';
import type { VaultTransportPayload } from './vault/VaultTransportScanner';
import type { VaultPairingEnvelopeV1 } from '@drey/core/domain/vault/multisig-contracts';

const VaultTransportScanner =
  typeof __BUILD_CHANNEL__ !== 'undefined' &&
    (__BUILD_CHANNEL__ === 'test' || __BUILD_CHANNEL__ === 'production')
    ? lazy(() => import('./vault/VaultTransportScanner'))
    : null;

interface RoleSummary {
  roleId: string;
  label: string;
  createdAt: number;
  origin: {
    masterFingerprintHex: string;
    originPath: string;
    accountXpub: string;
  };
}

type ImportableRole = 'mobile-b' | 'recovery-c';

interface Challenge {
  sessionIdHex: string;
  challengeNonceHex: string;
  transcriptHashHex: string;
  expiresAtMs: string;
  challengeQrFrames?: readonly string[] | null;
}

interface PolicySummary {
  policyId: string;
  createdAt: number;
  vaultLabel: string;
  birthdayHeight: number | null;
  signers: ReadonlyArray<{
    role: string;
    masterFingerprintHex: string;
    originPath: string;
    accountXpub: string;
    label: string;
  }>;
  receiveDescriptor: string;
  changeDescriptor: string;
  receiveChecksum: string;
  changeChecksum: string;
  firstReceiveAddress: string | null;
}

interface RecoveryKit {
  kitHex: string;
  standaloneToolPublished: boolean;
  standaloneToolCoreTag: string;
  standaloneToolSourceDigest: string;
  standaloneToolArtifactDigest: string;
}

interface RecoveryCChallenge {
  challengeHex: string;
  challengeDigestHex: string;
  fingerprint: string;
  network: 'mainnet' | 'signet';
  expiresAtMs: string;
  fileName: string;
}

interface RecoveryCReadiness {
  state:
    | 'not_started'
    | 'setup_open'
    | 'setup_complete'
    | 'kit_required'
    | 'backup_required'
    | 'backup_open'
    | 'ready'
    | 'unusable';
  policyId: string | null;
  setupComplete: boolean;
  kitExported: boolean;
  backupCheckComplete: boolean;
  ready: boolean;
}

type ScanView = {
  refusal:
    | 'gateway_unavailable'
    | 'capabilities_insufficient'
    | 'conflicting_source'
    | 'stale_evidence'
    | 'scan_incomplete'
    | null;
  balance: {
    totalSats: string;
    movableSats: string;
    immovableSats: string;
    inscriptionCount: number;
  } | null;
  tip: { height: number; hash: string } | null;
  utxos: ReadonlyArray<{
    txid: string;
    vout: number;
    valueSats: string;
    branch: string;
    derivationIndex: number;
    confirmations: number;
    primaryClass: string;
    inscriptionCount: number;
    refusal: string | null;
  }>;
};

type Mode = { kind: VaultModeKind };

const IMPORTABLE_ROLES: readonly ImportableRole[] = ['mobile-b', 'recovery-c'];

export function VaultCoordinator(props: {
  expectation: ActiveSessionExpectation;
  onBack: () => void;
}): ReactNode {
  const { t, lang } = useI18n();
  const rpc = useRpc();
  const [roleState, setRoleState] = useState<'absent' | 'present' | 'unusable'>('absent');
  const [movement, setMovement] = useState<'full' | 'unsigned-only' | 'production-mainnet' | null>(null);
  const [policyState, setPolicyState] = useState<'absent' | 'present' | 'unusable'>('absent');
  const [role, setRole] = useState<RoleSummary | null>(null);
  const [policy, setPolicy] = useState<PolicySummary | null>(null);
  const [pending, setPending] = useState<readonly ImportableRole[]>([]);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [kit, setKit] = useState<RecoveryKit | null>(null);
  const [kitDownloadStarted, setKitDownloadStarted] = useState(false);
  const [recoveryC, setRecoveryC] = useState<RecoveryCReadiness | null>(null);
  const [setupChallenge, setSetupChallenge] = useState<RecoveryCChallenge | null>(null);
  const [backupChallenge, setBackupChallenge] = useState<RecoveryCChallenge | null>(null);
  const [scan, setScan] = useState<ScanView | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'view' });
  const [password, setPassword] = useState('');
  const [label, setLabel] = useState('');
  const [importRole, setImportRole] = useState<ImportableRole>('mobile-b');
  const [originHex, setOriginHex] = useState('');
  const [proofHex, setProofHex] = useState('');
  const [originEnvelope, setOriginEnvelope] = useState<VaultPairingEnvelopeV1 | null>(null);
  const [proofEnvelope, setProofEnvelope] = useState<VaultPairingEnvelopeV1 | null>(null);
  const restoreWordsRef = useRef<HTMLInputElement>(null);
  const revealedWordsRef = useRef<HTMLParagraphElement>(null);
  const [restoreWordsPresent, setRestoreWordsPresent] = useState(false);
  const [wordsVisible, setWordsVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [transportScannerKind, setTransportScannerKind] = useState<'origin' | 'context' | null>(null);
  const [challengeQrIndex, setChallengeQrIndex] = useState(0);
  const [policyQrFrames, setPolicyQrFrames] = useState<readonly string[]>([]);
  const [policyQrIndex, setPolicyQrIndex] = useState(0);
  const [mobilePairingComplete, setMobilePairingComplete] = useState(false);
  const generation = useRef(0);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const recoveryCAction = useRef(false);

  const refresh = useCallback(() => {
    const requestGeneration = ++generation.current;
    void rpc('vaultCoordinator.status', { ...props.expectation }).then(async (status) => {
      if (requestGeneration !== generation.current) return;
      if (!status.ok) {
        setError(t(errorMessageKey(status.code)));
        return;
      }
      setRoleState(status.result.role);
      setMovement(status.result.movement);
      setPolicyState(status.result.policy);
      setPending(status.result.importPending);
      if (status.result.role !== 'present') {
        setRole(null);
        setPolicy(null);
        setRecoveryC(null);
        setPolicyQrFrames([]);
        setMobilePairingComplete(false);
        return;
      }
      const origin = await rpc('vaultCoordinator.roleOrigin', { ...props.expectation });
      if (requestGeneration !== generation.current) return;
      if (!origin.ok) {
        setError(t(errorMessageKey(origin.code)));
        return;
      }
      setRole(origin.result.role);
      const readiness = await rpc('vaultCoordinator.recoveryCReadiness', { ...props.expectation });
      if (requestGeneration !== generation.current) return;
      if (!readiness.ok) {
        setError(t(errorMessageKey(readiness.code)));
        return;
      }
      setRecoveryC(readiness.result);
      if (status.result.policy !== 'present') {
        setPolicy(null);
        setPolicyQrFrames([]);
        setMobilePairingComplete(false);
        return;
      }
      const stored = await rpc('vaultCoordinator.policy', { ...props.expectation });
      if (requestGeneration !== generation.current) return;
      if (!stored.ok) {
        setError(t(errorMessageKey(stored.code)));
        return;
      }
      setPolicy(stored.result.policy);
      setPolicyQrFrames(stored.result.policyQrFrames ?? []);
      setPolicyQrIndex(0);
      setMobilePairingComplete(stored.result.mobilePairingComplete);
    });
  }, [rpc, props.expectation, t]);

  useEffect(() => {
    refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    if (error !== null || notice !== null) statusRef.current?.focus();
  }, [error, notice]);

  function enterMode(next: Mode): void {
    setMode(next);
    setPassword('');
    setError(null);
    setNotice(null);
    setOriginHex('');
    setProofHex('');
    setTransportScannerKind(null);
    setChallengeQrIndex(0);
    // Secrets never enter React state and never survive a mode change.
    if (restoreWordsRef.current !== null) restoreWordsRef.current.value = '';
    if (revealedWordsRef.current !== null) revealedWordsRef.current.textContent = '';
    setRestoreWordsPresent(false);
    setWordsVisible(false);
  }

  async function beginImport(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const started = await rpc('vaultCoordinator.beginImport', { ...props.expectation });
      if (!started.ok) {
        setError(t(errorMessageKey(started.code)));
        return;
      }
      setChallenge(started.result);
      setChallengeQrIndex(0);
      setPending(started.result.pending);
      setSetupChallenge(null);
      setBackupChallenge(null);
      setRecoveryC({
        state: 'not_started',
        policyId: null,
        setupComplete: false,
        kitExported: false,
        backupCheckComplete: false,
        ready: false,
      });
      enterMode({ kind: 'import' });
    } finally {
      setBusy(false);
    }
  }

  function acceptScannedVaultPayload(payload: VaultTransportPayload): void {
    if (payload.kind === 'origin') {
      setOriginHex(payload.originHex);
      setOriginEnvelope(null);
      setTransportScannerKind(null);
      return;
    }
    if (payload.kind !== 'context' || payload.context.kind !== 'pairing') return;
    const envelope = payload.context.envelope;
    if (challenge === null || envelope.sessionIdHex !== challenge.sessionIdHex ||
        envelope.transcriptHashHex !== challenge.transcriptHashHex ||
        BigInt(Date.now()) > BigInt(envelope.expiresAtMs)) {
      setError(t('vault.transportScanner.error.mixed'));
      return;
    }
    if (envelope.messageType === 'signer-origin') {
      setOriginHex(envelope.payloadHex);
      setOriginEnvelope(envelope);
    } else if (envelope.messageType === 'pop-result') {
      setProofHex(envelope.payloadHex);
      setProofEnvelope(envelope);
    }
    setTransportScannerKind(null);
  }

  async function createMobileChallengeQr(): Promise<void> {
    if (originHex.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      const started = await rpc('vaultCoordinator.beginImport', {
        ...props.expectation,
        mobileOriginHex: originHex,
        password,
      });
      if (!started.ok) {
        setError(t(errorMessageKey(started.code)));
        return;
      }
      setChallenge(started.result);
      setPassword('');
      setChallengeQrIndex(0);
      setPending(started.result.pending);
    } finally {
      setBusy(false);
    }
  }

  async function reloadRecoveryC(): Promise<void> {
    const result = await rpc('vaultCoordinator.recoveryCReadiness', { ...props.expectation });
    if (!result.ok) {
      setError(t(errorMessageKey(result.code)));
      return;
    }
    setRecoveryC(result.result);
    if (result.result.kitExported) setKitDownloadStarted(false);
    if (result.result.ready) {
      const stored = await rpc('vaultCoordinator.policy', { ...props.expectation });
      if (!stored.ok) {
        setError(t(errorMessageKey(stored.code)));
        return;
      }
      setPolicy(stored.result.policy);
    }
  }

  async function beginRecoveryCSetup(): Promise<void> {
    if (recoveryCAction.current) return;
    recoveryCAction.current = true;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await rpc('vaultCoordinator.beginRecoveryCSetup', { ...props.expectation });
      if (!result.ok) {
        setError(t(errorMessageKey(result.code)));
        return;
      }
      setSetupChallenge(result.result);
      setRecoveryC((current) =>
        current === null ? current : { ...current, state: 'setup_open' },
      );
      downloadRecoveryCRecord(result.result.challengeHex, result.result.fileName);
      setNotice(t('vault.recoveryC.setupDownloaded'));
    } catch {
      setError(t('vault.recoveryC.downloadFailed'));
    } finally {
      recoveryCAction.current = false;
      setBusy(false);
    }
  }

  async function cancelRecoveryCSetup(): Promise<void> {
    if (recoveryCAction.current) return;
    recoveryCAction.current = true;
    setError(null);
    setBusy(true);
    try {
      const result = await rpc('vaultCoordinator.cancelRecoveryCSetup', { ...props.expectation });
      if (!result.ok) {
        setError(t(errorMessageKey(result.code)));
        return;
      }
      setSetupChallenge(null);
      await reloadRecoveryC();
      setNotice(t('vault.recoveryC.setupCancelled'));
    } finally {
      recoveryCAction.current = false;
      setBusy(false);
    }
  }

  async function importRecoveryCFile(file: File, kind: 'setup' | 'backup'): Promise<void> {
    if (recoveryCAction.current) return;
    recoveryCAction.current = true;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const responseHex = await readRecoveryCRecord(file);
      if (kind === 'setup') {
        const result = await rpc('vaultCoordinator.importRecoveryCSetupResponse', {
          responseHex,
          ...props.expectation,
        });
        if (!result.ok) {
          setError(t(errorMessageKey(result.code)));
          return;
        }
        setPending(result.result.pending);
        setSetupChallenge(null);
        setNotice(t('vault.recoveryC.setupComplete'));
      } else {
        const result = await rpc('vaultCoordinator.importRecoveryCBackupCheckResponse', {
          responseHex,
          ...props.expectation,
        });
        if (!result.ok) {
          setError(t(errorMessageKey(result.code)));
          return;
        }
        setBackupChallenge(null);
        setNotice(t('vault.recoveryC.ready'));
      }
      await reloadRecoveryC();
    } catch (caught) {
      setError(
        caught instanceof RangeError
          ? t('vault.recoveryC.fileSize')
          : t('vault.recoveryC.fileReadFailed'),
      );
    } finally {
      recoveryCAction.current = false;
      setBusy(false);
    }
  }

  async function acknowledgeKitExport(): Promise<void> {
    if (policy === null) return;
    if (recoveryCAction.current) return;
    recoveryCAction.current = true;
    setError(null);
    setBusy(true);
    try {
      const result = await rpc('vaultCoordinator.acknowledgeRecoveryKitExport', {
        policyId: policy.policyId,
        ...props.expectation,
      });
      if (!result.ok) {
        setError(t(errorMessageKey(result.code)));
        return;
      }
      await reloadRecoveryC();
      setKitDownloadStarted(false);
      setNotice(t('vault.recoveryC.kitComplete'));
    } finally {
      recoveryCAction.current = false;
      setBusy(false);
    }
  }

  async function beginRecoveryCBackupCheck(): Promise<void> {
    if (recoveryCAction.current) return;
    recoveryCAction.current = true;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await rpc('vaultCoordinator.beginRecoveryCBackupCheck', {
        ...props.expectation,
      });
      if (!result.ok) {
        setError(t(errorMessageKey(result.code)));
        return;
      }
      setBackupChallenge(result.result);
      setRecoveryC((current) =>
        current === null ? current : { ...current, state: 'backup_open' },
      );
      downloadRecoveryCRecord(result.result.challengeHex, result.result.fileName);
      setNotice(t('vault.recoveryC.backupDownloaded'));
    } catch {
      setError(t('vault.recoveryC.downloadFailed'));
    } finally {
      recoveryCAction.current = false;
      setBusy(false);
    }
  }

  async function refreshScan(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await rpc('vaultCoordinator.scan', { ...props.expectation });
      if (!result.ok) {
        setError(t(errorMessageKey(result.code)));
        return;
      }
      setScan(result.result);
    } finally {
      setBusy(false);
    }
  }

  async function loadKit(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await rpc('vaultCoordinator.recoveryKit', { ...props.expectation });
      if (!result.ok) {
        setError(t(errorMessageKey(result.code)));
        return;
      }
      // Project rather than storing the whole response: this surface renders
      // the hex blob and the two digests a user acts on, and nothing else.
      setKit({
        kitHex: result.result.kitHex,
        standaloneToolPublished: result.result.standaloneToolPublished,
        standaloneToolCoreTag: result.result.standaloneToolCoreTag,
        standaloneToolSourceDigest: result.result.kit.standaloneToolSourceDigest,
        standaloneToolArtifactDigest: result.result.kit.standaloneToolArtifactDigest,
      });
      setKitDownloadStarted(false);
    } finally {
      setBusy(false);
    }
  }

  async function refreshPolicyPairingQr(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await rpc('vaultCoordinator.policyPairingQr', {
        password,
        ...props.expectation,
      });
      if (!result.ok) {
        setError(t(errorMessageKey(result.code)));
        return;
      }
      setPolicyQrFrames(result.result.policyQrFrames);
      setPolicyQrIndex(0);
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  async function acknowledgePolicyPairing(): Promise<void> {
    if (policy === null) return;
    setError(null);
    setBusy(true);
    try {
      const result = await rpc('vaultCoordinator.acknowledgePolicyPairing', {
        policyId: policy.policyId,
        ...props.expectation,
      });
      if (!result.ok) {
        setError(t(errorMessageKey(result.code)));
        return;
      }
      setMobilePairingComplete(true);
      setPolicyQrFrames([]);
      setNotice(t('vault.policy.qrComplete'));
    } finally {
      setBusy(false);
    }
  }

  async function submit(): Promise<void> {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (mode.kind === 'create') {
        const created = await rpc('vaultCoordinator.createRole', {
          password,
          label: label === '' ? t('vault.role.defaultLabel') : label,
          ...props.expectation,
        });
        if (!created.ok) {
          setError(t(errorMessageKey(created.code)));
          return;
        }
        setRole(created.result.role);
        setRoleState('present');
        enterMode({ kind: 'view' });
        return;
      }
      if (mode.kind === 'restore') {
        const restoreInput = restoreWordsRef.current;
        const mnemonic = restoreInput?.value.trim().replace(/\s+/gu, ' ') ?? '';
        if (restoreInput !== null && restoreInput !== undefined) restoreInput.value = '';
        setRestoreWordsPresent(false);
        const restored = await rpc('vaultCoordinator.restoreRole', {
          password,
          label: label === '' ? t('vault.role.defaultLabel') : label,
          mnemonic,
          ...props.expectation,
        });
        if (!restored.ok) {
          // A mistyped phrase fails the wire schema's checksum, and the
          // generic internal-error copy would send the user looking for a bug
          // instead of a misspelled word.
          setError(
            t(
              restored.code === 'ERR_INVALID_PAYLOAD'
                ? 'vault.error.restoreWords'
                : errorMessageKey(restored.code),
            ),
          );
          return;
        }
        setRole(restored.result.role);
        setRoleState('present');
        enterMode({ kind: 'view' });
        setNotice(t('vault.restore.done'));
        return;
      }
      if (mode.kind === 'import') {
        if (originEnvelope === null || proofEnvelope === null) {
          setError(t('vault.transportScanner.error.mixed'));
          return;
        }
        const imported = await rpc('vaultCoordinator.importSigner', {
          role: importRole,
          originHex: originHex.trim().toLowerCase(),
          proofResultHex: proofHex.trim().toLowerCase(),
          originEnvelope,
          proofEnvelope,
          ...props.expectation,
        });
        if (!imported.ok) {
          setError(t(errorMessageKey(imported.code)));
          return;
        }
        setPending(imported.result.pending);
        setOriginHex('');
        setProofHex('');
        setOriginEnvelope(null);
        setProofEnvelope(null);
        const next = imported.result.pending[0];
        if (next !== undefined) setImportRole(next);
        setNotice(
          imported.result.complete
            ? t('vault.import.done')
            : t('vault.import.pending', { roles: imported.result.pending.map(roleName).join(', ') }),
        );
        return;
      }
      if (mode.kind === 'createPolicy') {
        const created = await rpc('vaultCoordinator.createPolicy', {
          password,
          vaultLabel: label === '' ? t('vault.policy.defaultLabel') : label,
          signerLabels: [t('vault.role.heading'), t('vault.role.mobileB'), t('vault.role.recoveryC')],
          birthdayHeight: null,
          ...props.expectation,
        });
        if (!created.ok) {
          setError(t(errorMessageKey(created.code)));
          return;
        }
        setPolicy(created.result.policy);
        setPolicyQrFrames(created.result.policyQrFrames);
        setPolicyQrIndex(0);
        setPolicyState('present');
        setMobilePairingComplete(false);
        setChallenge(null);
        setPending([]);
        enterMode({ kind: 'view' });
        await reloadRecoveryC();
        return;
      }
      if (mode.kind === 'removePolicy' || mode.kind === 'purgePolicy') {
        const removed = await rpc('vaultCoordinator.removePolicy', {
          password,
          ...(mode.kind === 'purgePolicy'
            ? { purgeUnusable: true }
            : { policyId: policy?.policyId ?? '' }),
          ...props.expectation,
        });
        if (!removed.ok) {
          setError(t(errorMessageKey(removed.code)));
          return;
        }
        setPolicy(null);
        setPolicyState('absent');
        setKit(null);
        setKitDownloadStarted(false);
        setRecoveryC(null);
        setMobilePairingComplete(false);
        setBackupChallenge(null);
        enterMode({ kind: 'view' });
        setNotice(t('vault.policy.remove.done'));
        return;
      }
      if (mode.kind === 'reveal') {
        const revealed = await rpc('vaultCoordinator.revealRole', {
          password,
          ...props.expectation,
        });
        if (!revealed.ok) {
          setError(t(errorMessageKey(revealed.code)));
          return;
        }
        if (revealedWordsRef.current !== null) {
          revealedWordsRef.current.textContent = revealed.result.mnemonic;
        }
        setWordsVisible(true);
        setPassword('');
        return;
      }
      const removed = await rpc('vaultCoordinator.removeRole', {
        password,
        ...(mode.kind === 'purge' ? { purgeUnusable: true } : { roleId: role?.roleId ?? '' }),
        ...props.expectation,
      });
      if (!removed.ok) {
        setError(t(errorMessageKey(removed.code)));
        return;
      }
      setRole(null);
      setRoleState('absent');
      setRecoveryC(null);
      setSetupChallenge(null);
      setBackupChallenge(null);
      enterMode({ kind: 'view' });
      setNotice(t('vault.remove.done'));
    } finally {
      setBusy(false);
      if (mode.kind !== 'reveal') setPassword('');
    }
  }

  function roleName(value: ImportableRole): string {
    return value === 'mobile-b' ? t('vault.role.mobileB') : t('vault.role.recoveryC');
  }

  function formatDate(ms: number): string {
    return new Intl.DateTimeFormat(lang, { dateStyle: 'medium' }).format(new Date(ms));
  }

  function detail(term: string, value: string, code = false): ReactNode {
    return (
      <div>
        <dt>{term}</dt>
        <dd className={code ? styles['code'] : undefined}>{value}</dd>
      </div>
    );
  }

  // One descriptor per mode (see `vault/modes.ts`): the caption tables and the
  // password set used to be four switch statements that had to be kept in
  // agreement by hand, and disagreeing silently produced a working-looking form
  // that could not submit.
  const spec = mode.kind === 'view' ? null : VAULT_MODE_SPECS[mode.kind];

  return (
    <>
      <h1 className={styles['title']}>{t('vault.title')}</h1>
      <section className={styles['section']}>
        <p className={styles['warning']}>
          {movement === 'unsigned-only'
            ? t('vault.mainnet.banner')
            : movement === 'production-mainnet'
              ? t('vault.production.banner')
              : t('vault.banner')}
        </p>
        {mode.kind === 'view' && roleState === 'absent' ? (
          <>
            <p className={styles['rowLabel']}>{t('vault.intro')}</p>
            <p className={styles['rowLabel']}>{t('vault.scope')}</p>
          </>
        ) : null}
        <div className={styles['vaultFeedback']}>
          {notice !== null ? (
            <p ref={statusRef} tabIndex={-1} role="status">
              {notice}
            </p>
          ) : null}
        </div>

        {mode.kind === 'view' ? (
          <>
            {roleState === 'unusable' ? (
              <p className={styles['advisory']}>{t('vault.role.unusable')}</p>
            ) : null}
            {roleState === 'absent' ? (
              <p className={styles['rowLabel']}>{t('vault.role.none')}</p>
            ) : null}
            {role !== null && policyState === 'absent' ? (
              <section className={styles['vaultNextStep']} aria-labelledby="vault-next-step-heading">
                <p className={styles['vaultStepLabel']}>
                  {pending.length === 0 && recoveryC?.setupComplete === true
                    ? t('vault.setup.rolesReady')
                    : !pending.includes('mobile-b') && pending.includes('recovery-c')
                      ? t('vault.setup.mobileReady')
                      : t('vault.setup.desktopReady')}
                </p>
                <h2 id="vault-next-step-heading" className={styles['sectionTitle']}>
                  {pending.length === 0 && recoveryC?.setupComplete === true
                    ? t('vault.setup.createTitle')
                    : !pending.includes('mobile-b') && pending.includes('recovery-c')
                      ? t('vault.setup.recoveryTitle')
                      : t('vault.setup.connectTitle')}
                </h2>
                <p className={styles['rowLabel']}>
                  {pending.length === 0 && recoveryC?.setupComplete === true
                    ? t('vault.setup.createBody')
                    : !pending.includes('mobile-b') && pending.includes('recovery-c')
                      ? t('vault.setup.recoveryBody')
                      : t('vault.setup.connectBody')}
                </p>
                {pending.length === 0 && recoveryC?.setupComplete === true ? (
                  <Button onClick={() => enterMode({ kind: 'createPolicy' })}>
                    {t('vault.policy.create.submit')}
                  </Button>
                ) : (
                  <Button disabled={busy} onClick={() => void beginImport()}>
                    {challenge !== null || recoveryC?.state === 'setup_open'
                      ? t('vault.import.restart')
                      : pending.length > 0
                        ? t('vault.import.continue')
                        : t('vault.import.begin')}
                  </Button>
                )}
              </section>
            ) : null}
            {policy !== null && !mobilePairingComplete ? (
              <section
                className={styles['vaultNextStep']}
                aria-labelledby="vault-policy-qr-heading"
              >
                <p className={styles['vaultStepLabel']}>{t('vault.policy.mobileStep')}</p>
                <h2 id="vault-policy-qr-heading" className={styles['sectionTitle']}>
                  {t('vault.policy.qrHeading')}
                </h2>
                <p className={styles['rowLabel']}>{t('vault.policy.qrBody')}</p>
                {policyQrFrames.length > 0 ? (
                  <>
                    <QrCode
                      value={policyQrFrames[policyQrIndex]!}
                      alt={t('vault.policy.qrAlt', {
                        index: policyQrIndex + 1,
                        count: policyQrFrames.length,
                      })}
                      size={260}
                    />
                    <p>{t('vault.policy.qrPart', {
                      index: policyQrIndex + 1,
                      count: policyQrFrames.length,
                    })}</p>
                    {policyQrFrames.length > 1 ? (
                      <div className={styles['row']}>
                        <Button
                          variant="secondary"
                          disabled={policyQrIndex === 0}
                          onClick={() => setPolicyQrIndex((index) => Math.max(0, index - 1))}
                        >
                          {t('vault.import.challengeQrPrevious')}
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={policyQrIndex >= policyQrFrames.length - 1}
                          onClick={() => setPolicyQrIndex((index) =>
                            Math.min(policyQrFrames.length - 1, index + 1))}
                        >
                          {t('vault.import.challengeQrNext')}
                        </Button>
                      </div>
                    ) : null}
                    <Button disabled={busy} onClick={() => void acknowledgePolicyPairing()}>
                      {t('vault.policy.qrCompleteAction')}
                    </Button>
                  </>
                ) : (
                  <>
                    <p className={styles['advisory']}>{t('vault.policy.qrMissing')}</p>
                    <Field
                      label={t('unlock.password')}
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="current-password"
                    />
                    <Button
                      disabled={busy || password.length === 0}
                      onClick={() => void refreshPolicyPairingQr()}
                    >
                      {t('vault.policy.qrRefresh')}
                    </Button>
                  </>
                )}
              </section>
            ) : null}
            {role !== null ? (
              <>
                <details className={styles['inlineDetails']}>
                  <summary>{t('vault.role.details')}</summary>
                  <dl className={styles['details']}>
                    {detail(t('vault.role.label'), role.label)}
                    {detail(t('vault.role.fingerprint'), role.origin.masterFingerprintHex, true)}
                    {detail(t('vault.role.origin'), role.origin.originPath, true)}
                    {detail(t('vault.role.xpub'), role.origin.accountXpub, true)}
                    {detail(t('vault.role.created'), formatDate(role.createdAt))}
                  </dl>
                </details>
                <details className={styles['inlineDetails']}>
                  <summary>{t('vault.role.recoveryTools')}</summary>
                  <VaultRoleARecoveryExport expectation={props.expectation} />
                </details>
              </>
            ) : null}

            {policyState === 'unusable' ? (
              <p className={styles['advisory']}>{t('vault.policy.unusable')}</p>
            ) : null}
            {role !== null && policyState === 'absent' ? (
              <>
                {recoveryC?.state === 'setup_open' ? (
                  <p className={styles['advisory']}>{t('vault.recoveryC.setupInterrupted')}</p>
                ) : null}
                {pending.length > 0 && pending.length < IMPORTABLE_ROLES.length ? (
                  <p className={styles['rowLabel']}>
                    {t('vault.import.pending', { roles: pending.map(roleName).join(', ') })}
                  </p>
                ) : null}
              </>
            ) : null}

            {policy !== null ? (
              <>
                <h2 className={styles['sectionTitle']}>{t('vault.policy.heading')}</h2>
                <dl className={styles['details']}>
                  {detail(t('vault.policy.label'), policy.vaultLabel)}
                  {detail(t('vault.policy.id'), policy.policyId, true)}
                  {detail(t('vault.policy.threshold'), t('vault.policy.thresholdValue'))}
                  {policy.signers.map((signer) => (
                    <div key={signer.role}>
                      <dt>{signer.label}</dt>
                      <dd className={styles['code']}>{signer.masterFingerprintHex}</dd>
                    </div>
                  ))}
                  {detail(
                    `${t('vault.policy.receiveDescriptor')} — ${t('vault.policy.checksum')}`,
                    policy.receiveChecksum,
                    true,
                  )}
                  {detail(
                    `${t('vault.policy.changeDescriptor')} — ${t('vault.policy.checksum')}`,
                    policy.changeChecksum,
                    true,
                  )}
                  {recoveryC?.ready === true && policy.firstReceiveAddress !== null
                    ? detail(t('vault.policy.firstAddress'), policy.firstReceiveAddress, true)
                    : null}
                </dl>
                {/* An unsigned-only build shows the address because it is already
                    implied by the descriptor above; what it must not do is
                    present it as somewhere to send coins. */}
                {movement === 'unsigned-only' ? (
                  <p className={styles['warning']}>{t('vault.mainnet.doNotFund')}</p>
                ) : null}
                <p className={styles['advisory']}>{t('vault.policy.verify')}</p>

                {recoveryC !== null ? (
                  <section aria-labelledby="vault-recovery-c-heading">
                    <h2 id="vault-recovery-c-heading" className={styles['sectionTitle']}>
                      {t('vault.recoveryC.heading')}
                    </h2>
                    <p className={styles['rowLabel']}>{t('vault.recoveryC.summary')}</p>
                    <ol>
                      <li>
                        {recoveryC.setupComplete
                          ? t('vault.recoveryC.stepSetupDone')
                          : t('vault.recoveryC.stepSetup')}
                      </li>
                      <li>
                        {recoveryC.kitExported
                          ? t('vault.recoveryC.stepKitDone')
                          : t('vault.recoveryC.stepKit')}
                      </li>
                      <li>
                        {recoveryC.backupCheckComplete
                          ? t('vault.recoveryC.stepBackupDone')
                          : t('vault.recoveryC.stepBackup')}
                      </li>
                    </ol>
                    {recoveryC.state === 'unusable' ? (
                      <p className={styles['warning']}>{t('vault.recoveryC.unusable')}</p>
                    ) : null}
                    {recoveryC.state === 'kit_required' ? (
                      <p className={styles['advisory']}>{t('vault.recoveryC.kitRequired')}</p>
                    ) : null}
                    {recoveryC.state === 'backup_required' || recoveryC.state === 'backup_open' ? (
                      <Button
                        disabled={busy}
                        onClick={() => void beginRecoveryCBackupCheck()}
                        data-testid="vault-recovery-c-backup-start"
                      >
                        {recoveryC.state === 'backup_open'
                          ? t('vault.recoveryC.backupReplace')
                          : t('vault.recoveryC.backupStart')}
                      </Button>
                    ) : null}
                    {backupChallenge !== null ? (
                      <div>
                        <p className={styles['rowLabel']}>
                          {t('vault.recoveryC.backupWaiting', {
                            fingerprint: backupChallenge.fingerprint,
                          })}
                        </p>
                        <Field
                          label={t('vault.recoveryC.responseFile')}
                          type="file"
                          disabled={busy}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = '';
                            if (file === undefined) {
                              setNotice(t('vault.recoveryC.noFile'));
                              return;
                            }
                            void importRecoveryCFile(file, 'backup');
                          }}
                          data-testid="vault-recovery-c-backup-file"
                        />
                      </div>
                    ) : null}
                    {!recoveryC.ready ? (
                      <p className={styles['warning']}>{t('vault.recoveryC.fundingBlocked')}</p>
                    ) : (
                      <p role="status">{t('vault.recoveryC.ready')}</p>
                    )}
                  </section>
                ) : null}

                <h2 className={styles['sectionTitle']}>{t('vault.balance.heading')}</h2>
                {scan !== null && scan.refusal !== null ? (
                  <>
                    <p className={styles['warning']}>{t('vault.readOnly.heading')}</p>
                    <p className={styles['advisory']} data-testid="vault-read-only">
                      {t(`vault.readOnly.${scan.refusal}` as never)}
                    </p>
                  </>
                ) : null}
                {scan !== null && scan.balance !== null ? (
                  <>
                    <dl className={styles['details']}>
                      {detail(t('vault.balance.total'), `${scan.balance.totalSats} sats`)}
                      {detail(t('vault.balance.movable'), `${scan.balance.movableSats} sats`)}
                      {detail(t('vault.balance.immovable'), `${scan.balance.immovableSats} sats`)}
                      {detail(
                        t('vault.balance.inscriptions'),
                        String(scan.balance.inscriptionCount),
                      )}
                      {scan.tip !== null
                        ? detail(
                            t('vault.balance.outputs'),
                            t('vault.balance.checkedAt', { height: scan.tip.height }),
                          )
                        : null}
                    </dl>
                    {scan.utxos.length === 0 ? (
                      <p className={styles['rowLabel']}>{t('vault.balance.empty')}</p>
                    ) : (
                      <ul data-testid="vault-utxos">
                        {scan.utxos.map((utxo) => (
                          <li key={`${utxo.txid}:${utxo.vout}`} className={styles['rowLabel']}>
                            <span className={styles['code']}>
                              {`${utxo.txid.slice(0, 12)}…:${utxo.vout}`}
                            </span>{' '}
                            {utxo.valueSats} sats
                            {utxo.refusal !== null
                              ? ` — ${t(`vault.utxo.${utxo.refusal}` as never)}`
                              : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : null}
                {/* Only a build that may move value gets a plan surface. The
                    panel checks the same fact; the worker decides it. */}
                {recoveryC?.ready === true ? (
                  <VaultPlanPanel
                    expectation={props.expectation}
                    canSign={movement === 'full' || movement === 'production-mainnet'}
                    TransportScanner={VaultTransportScanner}
                  />
                ) : null}
                {kit !== null ? (
                  <>
                    {/* Printing shows exactly this block (fullpage.module.css
                        @media print): the kit is the paper artifact, the
                        transport buttons below it are screen chrome. */}
                    <div className={styles['kitPrintArea']}>
                    <h2 className={styles['sectionTitle']}>{t('vault.kit.title')}</h2>
                    <p className={styles['rowLabel']}>{t('vault.kit.body')}</p>
                    {kit.standaloneToolPublished ? (
                      <>
                        <h3 className={styles['sectionTitle']}>{t('vault.tool.heading')}</h3>
                        <p className={styles['rowLabel']}>{t('vault.tool.body')}</p>
                        <p className={styles['rowLabel']}>{t('vault.tool.source')}</p>
                        <p className={styles['code']} data-testid="vault-tool-source">
                          {`core ${kit.standaloneToolCoreTag} — ${kit.standaloneToolSourceDigest}`}
                        </p>
                        <p className={styles['rowLabel']}>{t('vault.tool.artifact')}</p>
                        <p className={styles['code']} data-testid="vault-tool-artifact">
                          {kit.standaloneToolArtifactDigest}
                        </p>
                        <p className={styles['rowLabel']}>{t('vault.tool.reproduce')}</p>
                      </>
                    ) : (
                      <p className={styles['advisory']}>{t('vault.kit.unpublished')}</p>
                    )}
                    <p className={styles['code']} data-testid="vault-recovery-kit">
                      {kit.kitHex}
                    </p>
                    </div>
                    <VaultKitTransport
                      kitHex={kit.kitHex}
                      policyId={policy.policyId}
                      onDownloadStarted={() => {
                        if (recoveryC?.kitExported !== true) {
                          setKitDownloadStarted(true);
                          setNotice(t('vault.recoveryC.kitDownloadStarted'));
                        }
                      }}
                    />
                    {recoveryC?.kitExported !== true && kitDownloadStarted ? (
                      <Button
                        disabled={busy}
                        onClick={() => void acknowledgeKitExport()}
                        data-testid="vault-recovery-c-kit-confirm"
                      >
                        {t('vault.recoveryC.kitConfirm')}
                      </Button>
                    ) : null}
                  </>
                ) : null}
              </>
            ) : null}

            <div className={styles['formFeedback']}>
              {error !== null ? (
                <p ref={statusRef} tabIndex={-1} role="alert" className={styles['error']}>
                  {error}
                </p>
              ) : null}
            </div>
            {policyState === 'present' ? (
              <p className={styles['rowLabel']}>{t('vault.next')}</p>
            ) : null}
            <div className={styles['row']}>
              <Button variant="secondary" onClick={props.onBack}>
                {t('common.back')}
              </Button>
              {roleState === 'absent' ? (
                <>
                  <Button onClick={() => enterMode({ kind: 'create' })}>
                    {t('vault.create.submit')}
                  </Button>
                  <Button variant="secondary" onClick={() => enterMode({ kind: 'restore' })}>
                    {t('vault.restore.start')}
                  </Button>
                </>
              ) : null}
              {policyState === 'present' ? (
                <>
                  <Button disabled={busy} onClick={() => void refreshScan()}>
                    {t('vault.balance.refresh')}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      if (kit === null) void loadKit();
                      else {
                        setKit(null);
                        setKitDownloadStarted(false);
                      }
                    }}
                  >
                    {kit === null ? t('vault.kit.show') : t('vault.kit.hide')}
                  </Button>
                  <Button variant="danger" onClick={() => enterMode({ kind: 'removePolicy' })}>
                    {t('vault.policy.remove.submit')}
                  </Button>
                </>
              ) : null}
              {policyState === 'unusable' ? (
                <Button variant="danger" onClick={() => enterMode({ kind: 'purgePolicy' })}>
                  {t('vault.policy.remove.submit')}
                </Button>
              ) : null}
              {roleState === 'present' && policyState === 'absent' ? (
                <>
                  <Button variant="secondary" onClick={() => enterMode({ kind: 'reveal' })}>
                    {t('vault.reveal.submit')}
                  </Button>
                  <Button variant="danger" onClick={() => enterMode({ kind: 'remove' })}>
                    {t('vault.remove.submit')}
                  </Button>
                </>
              ) : null}
              {roleState === 'unusable' ? (
                <Button variant="danger" onClick={() => enterMode({ kind: 'purge' })}>
                  {t('vault.remove.submit')}
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <form
            className={styles['form']}
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <h2 className={styles['sectionTitle']}>{t(spec!.title)}</h2>
            <p className={styles['rowLabel']}>{t(spec!.body)}</p>
            {mode.kind === 'create' ? (
              <p className={styles['vaultFormNext']}>{t('vault.create.after')}</p>
            ) : null}
            {spec!.needsLabel ? (
              <Field
                label={
                  mode.kind === 'createPolicy'
                    ? t('vault.policy.label')
                    : t('vault.role.inputLabel')
                }
                hint={
                  mode.kind === 'createPolicy'
                    ? t('vault.policy.hint')
                    : t('vault.role.hint')
                }
                placeholder={
                  mode.kind === 'createPolicy'
                    ? t('vault.policy.placeholder')
                    : t('vault.role.placeholder')
                }
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={64}
              />
            ) : null}
            {mode.kind === 'import' && challenge !== null ? (
              <>
                {pending.includes('mobile-b') ? (
                  <section
                    className={styles['vaultSetupStep']}
                    aria-labelledby="vault-mobile-b-import-heading"
                  >
                    <p className={styles['vaultStepLabel']}>{t('vault.import.mobileStep')}</p>
                    <h3 id="vault-mobile-b-import-heading" className={styles['sectionTitle']}>
                      {t('vault.import.mobileTitle')}
                    </h3>
                    <p className={styles['rowLabel']}>{t('vault.import.mobileIntro')}</p>
                    {originHex === '' ? (
                      <>
                        <p className={styles['vaultFormNext']}>
                          {t('vault.import.scanIdentityHelp')}
                        </p>
                        {VaultTransportScanner !== null ? (
                          <Button
                            onClick={() => setTransportScannerKind('origin')}
                            data-testid="vault-origin-scanner-toggle"
                          >
                            {t('vault.transportScanner.scanOrigin')}
                          </Button>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <p role="status" className={styles['success']}>
                          {t('vault.import.identityScanned')}
                        </p>
                        {challenge.challengeQrFrames === null ||
                        challenge.challengeQrFrames === undefined ||
                        challenge.challengeQrFrames.length === 0 ? (
                          <>
                            <Field
                              label={t('unlock.password')}
                              hint={t('vault.import.passwordHint')}
                              type="password"
                              value={password}
                              onChange={(e) => setPassword(e.target.value)}
                              autoComplete="current-password"
                            />
                            <Button
                              disabled={busy || password.length === 0}
                              onClick={() => void createMobileChallengeQr()}
                            >
                              {t('vault.import.challengeQrCreate')}
                            </Button>
                          </>
                        ) : (
                          <div className={styles['vaultQrStage']}>
                            <p className={styles['vaultFormNext']}>
                              {t('vault.import.scanChallengeHelp')}
                            </p>
                            <QrCode
                              value={challenge.challengeQrFrames[challengeQrIndex]!}
                              alt={t('vault.import.challengeQrAlt', {
                                index: challengeQrIndex + 1,
                                count: challenge.challengeQrFrames.length,
                              })}
                              size={260}
                            />
                            <p>
                              {t('vault.import.challengeQrPart', {
                                index: challengeQrIndex + 1,
                                count: challenge.challengeQrFrames.length,
                              })}
                            </p>
                            <div className={styles['row']}>
                              <Button
                                variant="secondary"
                                disabled={challengeQrIndex === 0}
                                onClick={() =>
                                  setChallengeQrIndex((index) => Math.max(0, index - 1))
                                }
                              >
                                {t('vault.import.challengeQrPrevious')}
                              </Button>
                              <Button
                                variant="secondary"
                                disabled={
                                  challengeQrIndex >= challenge.challengeQrFrames.length - 1
                                }
                                onClick={() =>
                                  setChallengeQrIndex((index) =>
                                    Math.min(
                                      challenge.challengeQrFrames!.length - 1,
                                      index + 1,
                                    ))
                                }
                              >
                                {t('vault.import.challengeQrNext')}
                              </Button>
                            </div>
                            {proofHex === '' ? (
                              VaultTransportScanner !== null ? (
                                <>
                                  {originEnvelope !== null ? (
                                    <p role="status" className={styles['success']}>
                                      {t('vault.import.responseOneScanned')}
                                    </p>
                                  ) : null}
                                  <Button
                                    onClick={() => setTransportScannerKind('context')}
                                    data-testid="vault-transport-scanner-toggle"
                                  >
                                    {originEnvelope === null
                                      ? t('vault.transportScanner.scanResponseOne')
                                      : t('vault.transportScanner.scanResponseTwo')}
                                  </Button>
                                </>
                              ) : null
                            ) : (
                              <p role="status" className={styles['success']}>
                                {t('vault.import.responseScanned')}
                              </p>
                            )}
                          </div>
                        )}
                      </>
                    )}
                    {VaultTransportScanner !== null && transportScannerKind !== null ? (
                      <Suspense fallback={<p>{t('common.loading')}</p>}>
                        <VaultTransportScanner
                          kind={transportScannerKind}
                          onComplete={acceptScannedVaultPayload}
                          onClose={() => setTransportScannerKind(null)}
                        />
                      </Suspense>
                    ) : null}
                    <details className={styles['inlineDetails']}>
                      <summary>{t('vault.import.technical')}</summary>
                      <p className={styles['rowLabel']}>{t('vault.import.challenge')}</p>
                      <p className={styles['code']} data-testid="vault-import-challenge">
                        {`${challenge.sessionIdHex}:${challenge.challengeNonceHex}:${challenge.transcriptHashHex}:${challenge.expiresAtMs}`}
                      </p>
                      <Field
                        label={t('vault.import.origin')}
                        value={originHex}
                        onChange={(event) => setOriginHex(event.target.value)}
                        maxLength={4096}
                      />
                      <Field
                        label={t('vault.import.proof')}
                        value={proofHex}
                        onChange={(event) => setProofHex(event.target.value)}
                        maxLength={4096}
                      />
                    </details>
                  </section>
                ) : null}
                {pending.length === 0 ? (
                  <p className={styles['rowLabel']}>{t('vault.import.done')}</p>
                ) : null}
                {!pending.includes('mobile-b') && pending.includes('recovery-c') ? (
                  <section
                    className={styles['vaultSetupStep']}
                    aria-labelledby="vault-recovery-c-setup-heading"
                  >
                    <p className={styles['vaultStepLabel']}>{t('vault.import.recoveryStep')}</p>
                    <h3 id="vault-recovery-c-setup-heading" className={styles['sectionTitle']}>
                      {t('vault.recoveryC.setupHeading')}
                    </h3>
                    <p className={styles['advisory']}>{t('vault.recoveryC.setupBody')}</p>
                    <ol>
                      <li>{t('vault.recoveryC.prepareOffline')}</li>
                      <li>{t('vault.recoveryC.preparePaper')}</li>
                      <li>{t('vault.recoveryC.prepareSeparate')}</li>
                      <li>{t('vault.recoveryC.preparePowerOff')}</li>
                    </ol>
                    <div className={styles['row']}>
                      <Button
                        variant="secondary"
                        disabled={busy}
                        data-testid="vault-recovery-c-setup-start"
                        onClick={() => void beginRecoveryCSetup()}
                      >
                        {setupChallenge !== null || recoveryC?.state === 'setup_open'
                          ? t('vault.recoveryC.setupReplace')
                          : t('vault.recoveryC.setupStart')}
                      </Button>
                      {setupChallenge !== null ? (
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() => void cancelRecoveryCSetup()}
                        >
                          {t('common.cancel')}
                        </Button>
                      ) : null}
                    </div>
                    {setupChallenge === null && recoveryC?.state === 'setup_open' ? (
                      <p className={styles['advisory']}>
                        {t('vault.recoveryC.setupInterrupted')}
                      </p>
                    ) : null}
                    {setupChallenge !== null ? (
                      <div>
                        <p className={styles['rowLabel']}>
                          {t('vault.recoveryC.setupWaiting', {
                            fingerprint: setupChallenge.fingerprint,
                          })}
                        </p>
                        <Field
                          label={t('vault.recoveryC.responseFile')}
                          type="file"
                          disabled={busy}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = '';
                            if (file === undefined) {
                              setNotice(t('vault.recoveryC.noFile'));
                              return;
                            }
                            void importRecoveryCFile(file, 'setup');
                          }}
                          data-testid="vault-recovery-c-setup-file"
                        />
                      </div>
                    ) : null}
                  </section>
                ) : null}
              </>
            ) : null}
            {mode.kind === 'restore' ? (
              <Field
                ref={restoreWordsRef}
                label={t('vault.restore.words')}
                defaultValue=""
                onInput={(event) => setRestoreWordsPresent(event.currentTarget.value.trim().length > 0)}
                autoComplete="off"
                spellCheck={false}
                data-testid="vault-restore-words"
                maxLength={512}
              />
            ) : null}
            <p
              ref={revealedWordsRef}
              hidden={!wordsVisible}
              className={styles['code']}
              data-testid="vault-role-words"
            />
            {!wordsVisible && spec!.needsPassword ? (
              <Field
                label={t('unlock.password')}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            ) : null}
            <div className={styles['formFeedback']}>
              {error !== null ? (
                <p ref={statusRef} tabIndex={-1} role="alert" className={styles['error']}>
                  {error}
                </p>
              ) : null}
            </div>
            <div className={styles['row']}>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  enterMode({ kind: 'view' });
                }}
              >
                {!wordsVisible
                  ? mode.kind === 'import' && !pending.includes('mobile-b')
                    ? t('vault.import.backToOverview')
                    : t('common.cancel')
                  : t('vault.reveal.hide')}
              </Button>
              {!wordsVisible && (mode.kind !== 'import' || pending.includes('mobile-b')) ? (
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    (spec!.needsPassword && password === '') ||
                    (mode.kind === 'import' && (originHex === '' || proofHex === '')) ||
                    (mode.kind === 'restore' && !restoreWordsPresent)
                  }
                >
                  {t(spec!.submit)}
                </Button>
              ) : null}
            </div>
          </form>
        )}
      </section>
    </>
  );
}
