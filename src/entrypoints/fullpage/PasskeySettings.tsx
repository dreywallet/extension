/**
 * Passkey enrollment management (ADR 0007 §5, Workstream A2/A2.1).
 *
 * Enrollment sequence (A0 §4, hardened per the independent review): the
 * password is verified by the worker FIRST (passkey.beginEnrollment — a wrong
 * password stops the flow before any platform credential exists), then
 * create() with PRF required over the worker's create challenge, then the
 * authoritative get()-based PRF evaluation over the worker's get challenge,
 * whose evidence and output the worker verifies and round-trips before
 * persisting anything. PRF output exists here only long enough to be
 * base64-encoded for the worker and is zeroized immediately. Failures leave
 * the wallet password-only; a platform-side credential that was created but
 * not verified is called out explicitly because Drey cannot delete it (only
 * the platform credential manager can).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { bytesToBase64 } from '@drey/core/domain/vault/encoding';
import { passkeyPrfEvalInput } from '@drey/core/domain/vault/passkey-envelope';
import { zeroize } from '@drey/core/domain/vault/vault';
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
import styles from './fullpage.module.css';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';

interface Enrollment {
  credentialIdB64: string;
  label: string;
  createdAtMs: number;
}

type Mode =
  | { kind: 'list' }
  | { kind: 'add' }
  | { kind: 'remove'; credentialIdB64: string; label: string }
  | { kind: 'purge' };

export function PasskeySettings(props: {
  expectation: ActiveSessionExpectation;
  onBack: () => void;
}): ReactNode {
  const { t, lang } = useI18n();
  const rpc = useRpc();
  const [entries, setEntries] = useState<Enrollment[]>([]);
  const [invalidCount, setInvalidCount] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [password, setPassword] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ credentialIdB64: string; value: string } | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(() => {
    const requestGeneration = ++generation.current;
    void rpc('passkey.list', { ...props.expectation }).then((result) => {
      if (requestGeneration !== generation.current || !result.ok) return;
      setEntries(result.result.entries);
      setInvalidCount(result.result.invalidCount);
    });
  }, [rpc, props.expectation]);

  useEffect(() => {
    refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  function enterMode(next: Mode): void {
    setMode(next);
    setPassword('');
    setError(null);
    setNotice(null);
  }

  async function enroll(): Promise<void> {
    setError(null);
    setNotice(null);
    setBusy(true);
    let created = false;
    try {
      const support = await detectPasskeySupport();
      if (!support.supported) {
        setError(t('passkey.settings.unsupported'));
        return;
      }
      // Worker-side password reauthentication BEFORE any ceremony (A2.1
      // review Finding 5): a wrong password ends the flow with no platform
      // credential created. The grant is single-use and short-lived.
      const begin = await rpc('passkey.beginEnrollment', { password, ...props.expectation });
      if (!begin.ok) {
        setError(t(errorMessageKey(begin.code)));
        return;
      }
      const credential = await createPasskeyCredential({
        challengeB64: begin.result.createChallengeB64,
        excludeCredentialIdsB64: entries.map((entry) => entry.credentialIdB64),
      });
      created = true;
      // Authoritative gate (A0 §4 step 5): fresh get()-time PRF output under
      // the real derivation input; create-time PRF results are never used.
      const prfSalt = crypto.getRandomValues(new Uint8Array(32));
      const assertion = await getPrfAssertion({
        challengeB64: begin.result.getChallengeB64,
        entries: [
          {
            credentialIdB64: credential.credentialIdB64,
            prfEvalInputB64: bytesToBase64(passkeyPrfEvalInput(prfSalt)),
          },
        ],
      });
      const prfOutputB64 = bytesToBase64(assertion.prfOutput);
      zeroize(assertion.prfOutput);
      const result = await rpc('passkey.enroll', {
        authorizationId: begin.result.authorizationId,
        credentialIdB64: credential.credentialIdB64,
        prfSaltB64: bytesToBase64(prfSalt),
        prfOutputB64,
        label: label.trim() === '' ? t('passkey.settings.defaultLabel') : label.trim(),
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
      setLabel('');
      enterMode({ kind: 'list' });
      refresh();
    } catch (err) {
      if (err instanceof PasskeyCeremonyError) {
        if (err.reason === 'cancelled') return;
        if (err.reason === 'prf-unavailable') {
          // The platform may have created a PRF-less credential Drey cannot
          // delete; nothing was stored and nothing will be (A0 §4).
          setError(t('passkey.settings.prfMissing'));
          return;
        }
      }
      setError(created ? t('passkey.settings.verifyFailed') : t('passkey.settings.unsupported'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(target: { credentialIdB64?: string; purgeInvalid?: true }): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await rpc('passkey.remove', {
        password,
        ...target,
        ...props.expectation,
      });
      if (!result.ok) {
        setError(t(errorMessageKey(result.code)));
        return;
      }
      enterMode({ kind: 'list' });
      setNotice(t('passkey.settings.removed'));
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function saveRename(): Promise<void> {
    if (renaming === null) return;
    const result = await rpc('passkey.rename', {
      credentialIdB64: renaming.credentialIdB64,
      label: renaming.value.trim() === '' ? t('passkey.settings.defaultLabel') : renaming.value.trim(),
      ...props.expectation,
    });
    if (result.ok) {
      setRenaming(null);
      refresh();
    } else {
      setError(t(errorMessageKey(result.code)));
    }
  }

  const formatDate = (ms: number): string => new Date(ms).toLocaleDateString(lang);

  return (
    <>
      <h1 className={styles['title']}>{t('passkey.settings.title')}</h1>
      <section className={styles['section']}>
        <p className={styles['rowLabel']}>{t('passkey.settings.intro')}</p>
        {notice !== null ? <p role="status">{notice}</p> : null}
        {mode.kind === 'list' ? (
          <>
            {entries.length === 0 ? (
              <p className={styles['rowLabel']}>{t('passkey.settings.none')}</p>
            ) : (
              entries.map((entry) => (
                <div className={styles['row']} key={entry.credentialIdB64}>
                  {renaming?.credentialIdB64 === entry.credentialIdB64 ? (
                    <>
                      <Field
                        label={t('passkey.settings.label')}
                        value={renaming.value}
                        onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                        maxLength={64}
                      />
                      <Button variant="secondary" onClick={() => setRenaming(null)}>
                        {t('common.cancel')}
                      </Button>
                      <Button onClick={() => void saveRename()}>{t('passkey.settings.save')}</Button>
                    </>
                  ) : (
                    <>
                      <span className={styles['rowLabel']}>
                        {entry.label === '' ? t('passkey.settings.defaultLabel') : entry.label}{' '}
                        · {t('passkey.settings.added', { date: formatDate(entry.createdAtMs) })}
                      </span>
                      <Button
                        variant="secondary"
                        onClick={() =>
                          setRenaming({ credentialIdB64: entry.credentialIdB64, value: entry.label })
                        }
                      >
                        {t('passkey.settings.rename')}
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() =>
                          enterMode({
                            kind: 'remove',
                            credentialIdB64: entry.credentialIdB64,
                            label: entry.label,
                          })
                        }
                      >
                        {t('passkey.settings.remove')}
                      </Button>
                    </>
                  )}
                </div>
              ))
            )}
            {invalidCount > 0 ? (
              <div className={styles['row']}>
                <span className={styles['rowLabel']}>
                  {t('passkey.settings.invalid.notice', { count: invalidCount })}
                </span>
                <Button variant="danger" onClick={() => enterMode({ kind: 'purge' })}>
                  {t('passkey.settings.invalid.purge')}
                </Button>
              </div>
            ) : null}
            {error !== null ? (
              <p role="alert" className={styles['error']}>
                {error}
              </p>
            ) : null}
            <div className={styles['row']}>
              <Button variant="secondary" onClick={props.onBack}>
                {t('common.back')}
              </Button>
              <Button onClick={() => enterMode({ kind: 'add' })}>
                {t('passkey.settings.add')}
              </Button>
            </div>
          </>
        ) : (
          <form
            className={styles['form']}
            onSubmit={(e) => {
              e.preventDefault();
              if (mode.kind === 'add') void enroll();
              else if (mode.kind === 'remove') void remove({ credentialIdB64: mode.credentialIdB64 });
              else void remove({ purgeInvalid: true });
            }}
          >
            <p className={styles['rowLabel']}>
              {mode.kind === 'add' ? t('passkey.settings.add.body') : t('passkey.settings.remove.body')}
            </p>
            {mode.kind === 'add' ? (
              <Field
                label={t('passkey.settings.label')}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={64}
              />
            ) : null}
            <Field
              label={t('unlock.password')}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
            {error !== null ? (
              <p role="alert" className={styles['error']}>
                {error}
              </p>
            ) : null}
            <div className={styles['row']}>
              <Button variant="secondary" disabled={busy} onClick={() => enterMode({ kind: 'list' })}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={busy || password === ''}>
                {mode.kind === 'add' ? t('passkey.settings.add') : t('passkey.settings.remove')}
              </Button>
            </div>
          </form>
        )}
      </section>
    </>
  );
}
