import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { bytesToBase64 } from '@drey/core/domain/vault/encoding';
import { zeroize } from '@drey/core/domain/vault/vault';
import { useI18n } from '../i18n';
import { useRpc } from '../hooks/use-rpc';
import { errorMessageKey } from '../errors';
import { Button } from './Button';
import { Field } from './Field';
import { getPrfAssertion, PasskeyCeremonyError } from '../passkey/webauthn';
import styles from './Unlock.module.css';

interface PasskeyOffering {
  vaultId: string;
  entries: { credentialIdB64: string; prfEvalInputB64: string; label: string }[];
  /** Worker-issued single-use assertion challenge (A2.1). */
  challengeB64: string;
}

function preferredVaultId(
  vaults: { vaultId: string }[],
  preferredUnlockVaultId: string | null,
): string {
  return preferredUnlockVaultId !== null &&
      vaults.some((vault) => vault.vaultId === preferredUnlockVaultId)
    ? preferredUnlockVaultId
    : (vaults[0]?.vaultId ?? '');
}

/** Unlock form shared by popup and fullpage (§7.2: paste stays enabled). */
export function Unlock(props: {
  vaults: { vaultId: string; name: string }[];
  preferredUnlockVaultId: string | null;
  onUnlocked: () => void;
}): ReactNode {
  const { t } = useI18n();
  const rpc = useRpc();
  const selectId = useId();
  const [vaultId, setVaultId] = useState(() =>
    preferredVaultId(props.vaults, props.preferredUnlockVaultId));
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Per-vault passkey offering (ADR 0007 §5 A2): non-secret credential IDs and
  // fail-closed-parsed PRF eval inputs. The password field is always rendered
  // and always functional — the passkey button is additive convenience.
  const [passkeys, setPasskeys] = useState<PasskeyOffering | null>(null);
  const passkeyGeneration = useRef(0);

  // Another extension surface can change the wallet set while this locked
  // form is mounted. Preserve an in-progress choice while it remains valid;
  // otherwise reconcile to the last successful wallet or the first survivor.
  useEffect(() => {
    setVaultId((current) => props.vaults.some((vault) => vault.vaultId === current)
      ? current
      : preferredVaultId(props.vaults, props.preferredUnlockVaultId));
  }, [props.preferredUnlockVaultId, props.vaults]);

  const refreshPasskeys = useCallback(() => {
    if (vaultId === '' || typeof PublicKeyCredential === 'undefined') {
      setPasskeys(null);
      return;
    }
    const generation = ++passkeyGeneration.current;
    void rpc('passkey.challenge', { vaultId }).then((result) => {
      if (generation !== passkeyGeneration.current) return;
      setPasskeys(
        result.ok &&
          result.result.available &&
          result.result.entries.length > 0 &&
          result.result.challengeB64 !== undefined
          ? {
              vaultId,
              entries: result.result.entries,
              challengeB64: result.result.challengeB64,
            }
          : null,
      );
    });
  }, [rpc, vaultId]);

  useEffect(() => {
    refreshPasskeys();
    return () => {
      passkeyGeneration.current += 1;
    };
  }, [refreshPasskeys]);

  async function submit(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await rpc('vault.unlock', { vaultId, password });
      if (!result.ok) {
        setError(t(errorMessageKey(result.code)));
        return;
      }
      setPassword('');
      props.onUnlocked();
    } finally {
      setBusy(false);
    }
  }

  async function passkeyUnlock(): Promise<void> {
    if (passkeys === null || passkeys.vaultId !== vaultId) return;
    setError(null);
    setBusy(true);
    try {
      // Fresh OS user verification for every unwrap (ADR 0007 §5), over the
      // worker-issued single-use challenge; the worker verifies the returned
      // assertion before accepting the PRF output. The PRF output exists here
      // only long enough to be encoded for the worker.
      const assertion = await getPrfAssertion({
        challengeB64: passkeys.challengeB64,
        entries: passkeys.entries,
      });
      const prfOutputB64 = bytesToBase64(assertion.prfOutput);
      zeroize(assertion.prfOutput);
      const result = await rpc('passkey.unlock', {
        vaultId,
        credentialIdB64: assertion.credentialIdB64,
        prfOutputB64,
        assertionClientDataJSONB64: assertion.clientDataJSONB64,
        assertionAuthenticatorDataB64: assertion.authenticatorDataB64,
        assertionSignatureB64: assertion.signatureB64,
      });
      if (!result.ok) {
        // Every failure degrades to the password path with no extra ceremony.
        // The challenge was consumed either way, so fetch a fresh one to keep
        // the passkey button usable for a retry.
        setError(t('passkey.unlock.failed'));
        refreshPasskeys();
        return;
      }
      setPassword('');
      props.onUnlocked();
    } catch (err) {
      // A dismissed/failed ceremony leaves the challenge unconsumed and valid.
      if (err instanceof PasskeyCeremonyError && err.reason === 'cancelled') return;
      setError(t('passkey.unlock.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className={styles['form']}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h1 className={styles['title']}>{t('unlock.title')}</h1>
      {props.vaults.length > 1 ? (
        <>
          <label htmlFor={selectId} className={styles['label']}>
            {t('unlock.vault')}
          </label>
          <div className={styles['selectShell']}>
            <select
              id={selectId}
              className={styles['select']}
              value={vaultId}
              disabled={busy}
              onChange={(e) => setVaultId(e.target.value)}
            >
              {props.vaults.map((v) => (
                <option key={v.vaultId} value={v.vaultId}>
                  {v.name}
                </option>
              ))}
            </select>
            <span className={styles['chevron']} aria-hidden="true" />
          </div>
        </>
      ) : null}
      <Field
        label={t('unlock.password')}
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        autoFocus
      />
      {error !== null ? (
        <p role="alert" className={styles['error']}>
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy || password === '' || vaultId === ''}>
        {t('unlock.submit')}
      </Button>
      {passkeys !== null && passkeys.vaultId === vaultId ? (
        <Button variant="secondary" disabled={busy} onClick={() => void passkeyUnlock()}>
          {t('passkey.unlock.button')}
        </Button>
      ) : null}
    </form>
  );
}
