import { useCallback, useEffect, useRef, useState } from 'react';
import { isSessionStateChangedEvent, isWalletDataChangedEvent } from '@drey/core/messaging/events';
import { loadActiveVaultId } from '../../adapters/storage/vault-store';
import { useRpc } from './use-rpc';
import type { AccountCapabilities } from '@drey/core/domain/accounts/capabilities';
import type { AccountAddState } from '@drey/core/messaging/ops';

/** UI-level wallet state; error is distinct from an actually empty profile. */
export type WalletUiState = 'loading' | 'error' | 'no-vault' | 'locked' | 'unverified' | 'ready';

export interface ActiveSessionExpectation {
  expectedVaultId: string;
  expectedSessionId: string;
}

export interface SessionView {
  state: WalletUiState;
  activeVaultId: string | null;
  /** Last successfully unlocked wallet, used only to seed the locked UI. */
  preferredUnlockVaultId: string | null;
  vaults: { vaultId: string; name: string }[];
  expectation: ActiveSessionExpectation | null;
  deadline: number | null;
  quarantinedVaultCount: number;
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
  capabilities: AccountCapabilities;
  refresh: () => void;
}

type StoredView = Omit<SessionView, 'refresh'>;

const INITIAL_VIEW: StoredView = {
  state: 'loading',
  activeVaultId: null,
  preferredUnlockVaultId: null,
  vaults: [],
  expectation: null,
  deadline: null,
  quarantinedVaultCount: 0,
  activeAccountId: null,
  activeAccount: 0,
  selectableAccounts: [0],
  accountSummaries: [],
  accountAddState: null,
  activeRecoveredAddressCount: 0,
  capabilities: {
    canView: false, canDeriveAddresses: false, canPlanTransactions: false,
    canSignTransactions: false, canSignMessages: false, canBroadcast: false,
    canExposeToProviders: false, canUseMarketplaces: false,
    signMethod: 'none', canBuildUnsignedPsbt: false, canSignPsbt: false,
    canSignBip322: false, canRevealSeed: false, canExportPublicAccount: false,
    canVerifyAddress: false,
  },
};

export function useSession(): SessionView {
  const rpc = useRpc();
  const [view, setView] = useState<StoredView>(INITIAL_VIEW);
  const generation = useRef(0);

  const refresh = useCallback(() => {
    const requestGeneration = ++generation.current;
    // Start the non-secret preference read with the worker snapshot so the
    // locked screen never first renders (or requests a passkey challenge for)
    // the wrong wallet. Preference failures must not affect wallet routing.
    void Promise.all([
      rpc('session.snapshot', {}),
      loadActiveVaultId(chrome.storage.local).catch(() => null),
    ]).then(([snapshot, storedActiveVaultId]) => {
      if (requestGeneration !== generation.current) return;
      if (!snapshot.ok) {
        setView((previous) => ({ ...previous, state: 'error', expectation: null, deadline: null }));
        return;
      }
      const result = snapshot.result;
      const vaults = result.vaults.map(({ vaultId, name }) => ({ vaultId, name }));
      const preferredUnlockVaultId = storedActiveVaultId !== null &&
          vaults.some((vault) => vault.vaultId === storedActiveVaultId)
        ? storedActiveVaultId
        : null;
      if (vaults.length === 0) {
        setView({
          state: result.quarantinedVaultCount > 0 ? 'error' : 'no-vault',
          activeVaultId: null,
          preferredUnlockVaultId: null,
          vaults,
          expectation: null,
          deadline: null,
          quarantinedVaultCount: result.quarantinedVaultCount,
          activeAccountId: result.activeAccountId,
          activeAccount: result.activeAccount,
          selectableAccounts: result.selectableAccounts,
          accountSummaries: result.accountSummaries,
          accountAddState: result.accountAddState,
          activeRecoveredAddressCount: result.activeRecoveredAddressCount,
          capabilities: result.capabilities,
        });
        return;
      }
      if (result.locked || result.activeVaultId === null || result.sessionId === null) {
        setView({
          state: 'locked',
          activeVaultId: null,
          preferredUnlockVaultId,
          vaults,
          expectation: null,
          deadline: null,
          quarantinedVaultCount: result.quarantinedVaultCount,
          activeAccountId: result.activeAccountId,
          activeAccount: result.activeAccount,
          selectableAccounts: result.selectableAccounts,
          accountSummaries: result.accountSummaries,
          accountAddState: result.accountAddState,
          activeRecoveredAddressCount: result.activeRecoveredAddressCount,
          capabilities: result.capabilities,
        });
        return;
      }
      const activeVaultId = result.activeVaultId;
      const sessionId = result.sessionId;
      setView((previous) => ({
        // Backup verification protects a software signer. A descriptor-only
        // account has no seed to reveal or acknowledge, so it remains usable
        // for its read-only capabilities even when the containing vault's
        // software account is still awaiting backup verification.
        state: result.backupVerified || result.capabilities.signMethod === 'none'
          ? 'ready'
          : 'unverified',
        activeVaultId,
        preferredUnlockVaultId: activeVaultId,
        vaults,
        // Preserve referential identity for an unchanged live session. Several
        // screens bind local reads and secret-clearing effects to this object;
        // replacing it for an unrelated account/config refresh can otherwise
        // restart those effects even though their security scope did not move.
        expectation: previous.expectation?.expectedVaultId === activeVaultId &&
          previous.expectation.expectedSessionId === sessionId
          ? previous.expectation
          : {
              expectedVaultId: activeVaultId,
              expectedSessionId: sessionId,
            },
        deadline: result.deadline,
        quarantinedVaultCount: result.quarantinedVaultCount,
        activeAccountId: result.activeAccountId,
        activeAccount: result.activeAccount,
        selectableAccounts: result.selectableAccounts,
        accountSummaries: result.accountSummaries,
        accountAddState: result.accountAddState,
        activeRecoveredAddressCount: result.activeRecoveredAddressCount,
        capabilities: result.capabilities,
      }));
    });
  }, [rpc]);

  useEffect(() => {
    refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    const onMessage = (message: unknown): void => {
      if (isSessionStateChangedEvent(message)) {
        if (message.locked) {
          setView((previous) => ({
            ...previous,
            state: previous.vaults.length === 0 ? 'loading' : 'locked',
            activeVaultId: null,
            expectation: null,
            deadline: null,
          }));
        }
        refresh();
        return;
      }
      if (isWalletDataChangedEvent(message) &&
          (message.reason === 'account' || message.reason === 'config')) refresh();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [refresh]);

  useEffect(() => {
    if (view.deadline === null) return undefined;
    const delay = Math.max(0, view.deadline - Date.now());
    const timer = setTimeout(refresh, delay);
    return () => clearTimeout(timer);
  }, [refresh, view.deadline]);

  return { ...view, refresh };
}
