import { useEffect, useState, type ReactNode } from 'react';
import { bytesToBase64 } from '@drey/core/domain/vault/encoding';
import { passkeyPrfEvalInput } from '@drey/core/domain/vault/passkey-envelope';
import { zeroize } from '@drey/core/domain/vault/vault';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import { useI18n } from '../../ui/i18n';
import { useRpc } from '../../ui/hooks/use-rpc';
import { errorMessageKey } from '../../ui/errors';
import { Button } from '../../ui/components/Button';
import { Field } from '../../ui/components/Field';
import {
  createPasskeyCredential,
  detectPasskeySupport,
  getPrfAssertion,
  PasskeyCeremonyError,
} from '../../ui/passkey/webauthn';
import styles from './onboarding.module.css';

export function PasskeyOffer(props: {
  expectation: ActiveSessionExpectation;
  onDone: () => void;
}): ReactNode {
  const { t } = useI18n();
  const rpc = useRpc();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [supportChecked, setSupportChecked] = useState(false);

  useEffect(() => {
    let active = true;
    void detectPasskeySupport().then((support) => {
      if (!active) return;
      if (!support.supported) props.onDone();
      else setSupportChecked(true);
    });
    return () => { active = false; };
  }, [props.onDone]);

  async function enroll(): Promise<void> {
    setBusy(true);
    setError(null);
    let created = false;
    try {
      if (!(await detectPasskeySupport()).supported) {
        props.onDone();
        return;
      }
      const begin = await rpc('passkey.beginEnrollment', { password, ...props.expectation });
      if (!begin.ok) {
        setError(t(errorMessageKey(begin.code)));
        return;
      }
      const credential = await createPasskeyCredential({
        challengeB64: begin.result.createChallengeB64,
        excludeCredentialIdsB64: [],
      });
      created = true;
      const prfSalt = crypto.getRandomValues(new Uint8Array(32));
      const assertion = await getPrfAssertion({
        challengeB64: begin.result.getChallengeB64,
        entries: [{
          credentialIdB64: credential.credentialIdB64,
          prfEvalInputB64: bytesToBase64(passkeyPrfEvalInput(prfSalt)),
        }],
      });
      const prfOutputB64 = bytesToBase64(assertion.prfOutput);
      zeroize(assertion.prfOutput);
      const result = await rpc('passkey.enroll', {
        authorizationId: begin.result.authorizationId,
        credentialIdB64: credential.credentialIdB64,
        prfSaltB64: bytesToBase64(prfSalt),
        prfOutputB64,
        label: t('passkey.settings.defaultLabel'),
        publicKeySpkiB64: credential.publicKeySpkiB64,
        publicKeyAlg: credential.publicKeyAlg,
        createClientDataJSONB64: credential.clientDataJSONB64,
        assertionClientDataJSONB64: assertion.clientDataJSONB64,
        assertionAuthenticatorDataB64: assertion.authenticatorDataB64,
        assertionSignatureB64: assertion.signatureB64,
        ...props.expectation,
      });
      if (!result.ok) {
        setError(t('passkey.settings.verifyFailed'));
        return;
      }
      props.onDone();
    } catch (cause) {
      if (cause instanceof PasskeyCeremonyError && cause.reason === 'cancelled') return;
      setError(t(created ? 'passkey.settings.verifyFailed' : 'passkey.settings.unsupported'));
    } finally {
      setPassword('');
      setBusy(false);
    }
  }

  if (!supportChecked) return <p role="status">{t('common.loading')}</p>;

  return (
    <form className={styles['form']} onSubmit={(event) => { event.preventDefault(); void enroll(); }}>
      <h1 className={styles['title']}>{t('passkey.onboarding.title')}</h1>
      <p className={styles['subtitle']}>{t('passkey.onboarding.body')}</p>
      <Field label={t('unlock.password')} type="password" value={password}
        onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
      {error === null ? null : <p role="alert" className={styles['error']}>{error}</p>}
      <div className={styles['actions']}>
        <Button variant="secondary" onClick={props.onDone} disabled={busy}>
          {t('passkey.onboarding.skip')}
        </Button>
        <Button type="submit" disabled={busy || password === ''}>
          {t('passkey.onboarding.setup')}
        </Button>
      </div>
    </form>
  );
}
