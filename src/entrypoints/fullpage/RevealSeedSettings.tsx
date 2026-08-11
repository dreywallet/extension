import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../../ui/i18n';
import { useRpc } from '../../ui/hooks/use-rpc';
import { errorMessageKey } from '../../ui/errors';
import { Button } from '../../ui/components/Button';
import { Field } from '../../ui/components/Field';
import { CountdownMask } from '../../ui/components/CountdownMask';
import { MnemonicGrid } from '../../ui/components/MnemonicGrid';
import styles from './fullpage.module.css';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';

const REVEAL_SECONDS = 60;

/**
 * Seed reveal (§7.6): password reauthentication, timed masking, no clipboard
 * path. The words live only in this component's state and are cleared on
 * remask, hide, back, and unmount.
 */
export function RevealSeedSettings(props: {
  expectation: ActiveSessionExpectation;
  onBack: () => void;
}): ReactNode {
  const { t } = useI18n();
  const rpc = useRpc();
  const [password, setPassword] = useState('');
  const [words, setWords] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hide = useCallback(() => setWords(null), []);
  useEffect(() => () => setWords(null), []);

  async function reveal(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await rpc('vault.revealMnemonic', { password, ...props.expectation });
      if (!result.ok) {
        setError(t(errorMessageKey(result.code)));
        return;
      }
      setPassword('');
      setWords(result.result.mnemonic.split(' '));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className={styles['title']}>{t('reveal.title')}</h1>
      <section className={styles['section']}>
        <div className={styles['warning']} role="note">
          {t('reveal.warning')}
        </div>
        {words === null ? (
          <form
            className={styles['form']}
            onSubmit={(e) => {
              e.preventDefault();
              void reveal();
            }}
          >
            <p className={styles['rowLabel']}>{t('reveal.reauth.body')}</p>
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
              <Button variant="secondary" onClick={props.onBack} disabled={busy}>
                {t('common.back')}
              </Button>
              <Button type="submit" disabled={busy || password === ''}>
                {t('reveal.reauth.submit')}
              </Button>
            </div>
          </form>
        ) : (
          <>
            <CountdownMask seconds={REVEAL_SECONDS} onExpire={hide}>
              <MnemonicGrid words={words} />
            </CountdownMask>
            <div className={styles['row']}>
              <Button variant="secondary" onClick={props.onBack}>
                {t('common.back')}
              </Button>
            </div>
          </>
        )}
      </section>
    </>
  );
}
