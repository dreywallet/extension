import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { Button } from './Button';

/**
 * Clipboard writer for non-secret values only. The `kind` prop is a
 * deliberate speed bump: every call site declares what it copies, and nothing
 * accepts a mnemonic (§7.1 — the complete mnemonic must never reach the
 * clipboard; MnemonicGrid has no copy path at all).
 */
export function CopyButton(props: {
  value: string;
  kind: 'address' | 'uri';
  label: string;
  className?: string | undefined;
  icon?: ReactNode;
  onCopyResult?: ((result: 'copied' | 'failed') => void) | undefined;
}): ReactNode {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const statusLabel = copied
    ? t('common.copied')
    : failed
      ? t('common.copyFailed')
      : props.label;

  return (
    <Button
      variant="secondary"
      className={props.className}
      aria-label={props.icon ? statusLabel : undefined}
      title={props.icon ? statusLabel : undefined}
      data-copy-state={copied ? 'copied' : failed ? 'failed' : 'idle'}
      onClick={() => {
        setFailed(false);
        void navigator.clipboard
          .writeText(props.value)
          .then(() => {
            if (!mounted.current) return;
            setCopied(true);
            props.onCopyResult?.('copied');
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {
            if (!mounted.current) return;
            setFailed(true);
            props.onCopyResult?.('failed');
          });
      }}
    >
      {props.icon ?? statusLabel}
    </Button>
  );
}
