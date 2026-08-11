import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { Button } from './Button';

/**
 * Timed masking for revealed secrets (§7.6): shows children for `seconds`,
 * then calls onExpire — the parent must clear the secret from its state (the
 * mask never keeps a hidden copy behind it).
 */
export function CountdownMask(props: {
  seconds: number;
  onExpire: () => void;
  children: ReactNode;
}): ReactNode {
  const { t } = useI18n();
  const { seconds, onExpire } = props;
  const [remaining, setRemaining] = useState(seconds);
  const onExpireRef = useRef(onExpire);

  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  useEffect(() => {
    const expiresAt = Date.now() + seconds * 1000;
    let expired = false;
    const update = (): void => {
      const next = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setRemaining(next);
      if (next === 0 && !expired) {
        expired = true;
        clearInterval(interval);
        onExpireRef.current();
      }
    };
    const interval = setInterval(update, 250);
    update();
    const onVisibility = (): void => update();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
    };
  }, [seconds]);

  return (
    <div>
      {props.children}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: 'var(--space-3)',
        }}
      >
        <span role="timer" style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
          {t('reveal.countdown', { seconds: remaining })}
        </span>
        <Button variant="secondary" onClick={onExpire}>
          {t('reveal.hideNow')}
        </Button>
      </div>
    </div>
  );
}
