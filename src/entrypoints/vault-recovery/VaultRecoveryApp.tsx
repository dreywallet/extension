import { useEffect, useRef, useState, type ReactNode } from 'react';
import { base64ToBytes, bytesToBase64 } from '@drey/core/domain/vault/encoding';
import { passkeyPrfEvalInput } from '@drey/core/domain/vault/passkey-envelope';
import { zeroize } from '@drey/core/domain/vault/vault';
import { getPrfAssertion, PasskeyCeremonyError } from '../../ui/passkey/webauthn';
import {
  decodeVaultRoleARecoveryPackage,
  unwrapVaultRoleARecoveryPackage,
  type VaultRoleARecoveryPackageV1,
} from '../../vault-recovery/role-a-recovery-package';

const MAX_FILE_BYTES = 256 * 1024;

export function VaultRecoveryApp(): ReactNode {
  const [recoveryPackage, setRecoveryPackage] = useState<VaultRoleARecoveryPackageV1 | null>(null);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const wordsRef = useRef<HTMLParagraphElement>(null);

  function clearWords(): void {
    if (wordsRef.current !== null) wordsRef.current.textContent = '';
    setRevealed(false);
  }

  useEffect(() => {
    const onOnline = () => {
      setOffline(false);
      clearWords();
      setError('Networking became available. Disconnect every network before trying again.');
    };
    const onOffline = () => setOffline(true);
    const onVisibility = () => { if (document.hidden) clearWords(); };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearWords();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  async function loadFile(file: File): Promise<void> {
    clearWords();
    setError(null);
    setRecoveryPackage(null);
    if (file.size === 0 || file.size > MAX_FILE_BYTES) {
      setError('Choose a non-empty Drey Role A recovery file smaller than 256 KiB.');
      return;
    }
    try {
      setRecoveryPackage(decodeVaultRoleARecoveryPackage(await file.text()));
    } catch {
      setError('This is not a valid Drey Vault Role A recovery package.');
    }
  }

  async function recover(): Promise<void> {
    if (recoveryPackage === null || busy) return;
    clearWords();
    setError(null);
    if (navigator.onLine) {
      setOffline(false);
      setError('Disconnect Wi-Fi, Ethernet, cellular, and every other network before recovery.');
      return;
    }
    if (recoveryPackage.passkeyEnvelope.rpOrigin !== window.location.origin) {
      setError('This package belongs to a different Drey extension identity. Use the original production Store item.');
      return;
    }
    setBusy(true);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const prfSalt = base64ToBytes(recoveryPackage.passkeyEnvelope.prfSaltB64);
    try {
      const assertion = await getPrfAssertion({
        challengeB64: bytesToBase64(challenge),
        entries: [{
          credentialIdB64: recoveryPackage.passkeyEnvelope.credentialIdB64,
          prfEvalInputB64: bytesToBase64(passkeyPrfEvalInput(prfSalt)),
        }],
      });
      try {
        if (assertion.credentialIdB64 !== recoveryPackage.passkeyEnvelope.credentialIdB64) {
          throw new Error('credential identity mismatch');
        }
        const recovered = unwrapVaultRoleARecoveryPackage(recoveryPackage, assertion.prfOutput);
        try {
          if (navigator.onLine) throw new Error('network became available during recovery');
          if (wordsRef.current !== null) wordsRef.current.textContent = recovered.mnemonic;
          setRevealed(true);
        } finally {
          zeroize(recovered.entropy);
        }
      } finally {
        zeroize(assertion.prfOutput);
      }
    } catch (cause) {
      if (!(cause instanceof PasskeyCeremonyError && cause.reason === 'cancelled')) {
        setError('Recovery failed. The passkey, extension identity, or package did not authenticate.');
      }
    } finally {
      zeroize(challenge);
      zeroize(prfSalt);
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Offline Vault Role A recovery</h1>
      <p>
        This page recovers only Desktop Role A. It does not recover your Spending wallet,
        Mobile B, or Recovery C, and Role A cannot spend from a 2-of-3 Vault alone.
      </p>
      <p className="warning">
        Disconnect every network before selecting the file. The page refuses while the browser
        reports any network connection, clears the words when hidden, and never contacts Drey.
      </p>
      <p role="status">Network check: {offline ? 'offline' : 'online — recovery blocked'}</p>
      <section aria-labelledby="package-heading">
        <h2 id="package-heading">1. Choose the encrypted Role A package</h2>
        <input
          type="file"
          accept="application/json,.json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file !== undefined) void loadFile(file);
          }}
        />
        {recoveryPackage !== null ? (
          <dl>
            <dt>Network</dt><dd>{recoveryPackage.network}</dd>
            <dt>Role fingerprint</dt>
            <dd className="code">{recoveryPackage.origin.masterFingerprintHex}</dd>
            <dt>Passkey identity</dt>
            <dd className="code">{recoveryPackage.passkeyEnvelope.rpOrigin}</dd>
          </dl>
        ) : null}
      </section>
      <section aria-labelledby="recover-heading">
        <h2 id="recover-heading">2. Verify your passkey and reveal Role A</h2>
        <button disabled={!offline || recoveryPackage === null || busy} onClick={() => void recover()}>
          Verify passkey and reveal Role A words
        </button>
        <button disabled={!revealed} onClick={clearWords}>Clear words</button>
        <p ref={wordsRef} className="words code" aria-live="polite" />
        {revealed ? (
          <p className="warning">
            Write these Role A words on durable offline media, then clear them. To exit without
            Drey, enter them as desktop-a in the verified standalone recovery package and combine
            them with either Mobile B or Recovery C.
          </p>
        ) : null}
      </section>
      {error !== null ? <p role="alert" className="error">{error}</p> : null}
    </main>
  );
}
