import { useEffect, useState, type ReactNode } from 'react';
import { bytesToBase64 } from '@drey/core/domain/vault/encoding';
import { passkeyPrfEvalInput } from '@drey/core/domain/vault/passkey-envelope';
import { zeroize } from '@drey/core/domain/vault/vault';
import type { ActiveSessionExpectation } from '../../../ui/hooks/use-session';
import { useRpc } from '../../../ui/hooks/use-rpc';
import { useI18n } from '../../../ui/i18n';
import { errorMessageKey } from '../../../ui/errors';
import { getPrfAssertion, PasskeyCeremonyError } from '../../../ui/passkey/webauthn';
import { Button } from '../../../ui/components/Button';
import { Field } from '../../../ui/components/Field';
import styles from '../fullpage.module.css';

interface CredentialEntry {
  credentialIdB64: string;
  label: string;
}

function downloadJson(value: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([value], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Creates the passkey-encrypted Role A package. No Role A words or DEK enter
 * this component; the worker opens and re-wraps the record only after it has
 * verified both the app password and the fresh WebAuthn assertion.
 */
export function VaultRoleARecoveryExport(props: {
  expectation: ActiveSessionExpectation;
}): ReactNode {
  const rpc = useRpc();
  const { t } = useI18n();
  const [entries, setEntries] = useState<CredentialEntry[]>([]);
  const [selected, setSelected] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void rpc('passkey.list', props.expectation).then((result) => {
      if (!current || !result.ok) return;
      setEntries(result.result.entries);
      setSelected((prior) => prior || result.result.entries[0]?.credentialIdB64 || '');
    });
    return () => { current = false; };
  }, [props.expectation, rpc]);

  async function exportPackage(): Promise<void> {
    if (selected === '' || password === '') return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const prfSalt = crypto.getRandomValues(new Uint8Array(32));
    try {
      const begun = await rpc('vaultCoordinator.beginRoleRecoveryExport', props.expectation);
      if (!begun.ok) {
        setError(t(errorMessageKey(begun.code)));
        return;
      }
      const assertion = await getPrfAssertion({
        challengeB64: begun.result.challengeB64,
        entries: [{
          credentialIdB64: selected,
          prfEvalInputB64: bytesToBase64(passkeyPrfEvalInput(prfSalt)),
        }],
      });
      try {
        const result = await rpc('vaultCoordinator.exportRoleRecovery', {
          password,
          credentialIdB64: assertion.credentialIdB64,
          prfSaltB64: bytesToBase64(prfSalt),
          prfOutputB64: bytesToBase64(assertion.prfOutput),
          assertionClientDataJSONB64: assertion.clientDataJSONB64,
          assertionAuthenticatorDataB64: assertion.authenticatorDataB64,
          assertionSignatureB64: assertion.signatureB64,
          ...props.expectation,
        });
        if (!result.ok) {
          setError(t(errorMessageKey(result.code)));
          return;
        }
        downloadJson(result.result.packageJson, result.result.fileName);
        setNotice(t('vault.roleARecovery.exported'));
      } finally {
        zeroize(assertion.prfOutput);
      }
    } catch (cause) {
      if (cause instanceof PasskeyCeremonyError && cause.reason === 'cancelled') return;
      setError(t('vault.roleARecovery.failed'));
    } finally {
      zeroize(prfSalt);
      setPassword('');
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="vault-role-a-recovery-heading">
      <h2 id="vault-role-a-recovery-heading" className={styles['sectionTitle']}>
        {t('vault.roleARecovery.title')}
      </h2>
      <p className={styles['rowLabel']}>{t('vault.roleARecovery.body')}</p>
      {entries.length === 0 ? (
        <p className={styles['advisory']}>{t('vault.roleARecovery.passkeyRequired')}</p>
      ) : (
        <>
          <label>
            <span>{t('vault.roleARecovery.passkey')}</span>
            <select value={selected} onChange={(event) => setSelected(event.target.value)}>
              {entries.map((entry) => (
                <option key={entry.credentialIdB64} value={entry.credentialIdB64}>
                  {entry.label || t('passkey.settings.defaultLabel')}
                </option>
              ))}
            </select>
          </label>
          <Field
            label={t('unlock.password')}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
          <Button disabled={busy || selected === '' || password === ''} onClick={() => void exportPackage()}>
            {t('vault.roleARecovery.export')}
          </Button>
        </>
      )}
      <Button
        variant="secondary"
        onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('/vault-recovery.html') })}
      >
        {t('vault.roleARecovery.openOffline')}
      </Button>
      {notice !== null ? <p role="status">{notice}</p> : null}
      {error !== null ? <p role="alert" className={styles['error']}>{error}</p> : null}
    </section>
  );
}
