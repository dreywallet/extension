import { useEffect, useState, type ReactNode } from 'react';
import { CopyButton } from '../../ui/components/CopyButton';
import { useI18n } from '../../ui/i18n';
import { useRpc } from '../../ui/hooks/use-rpc';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import { PopupIcon } from './PopupIcon';
import styles from './popup.module.css';

interface Addresses {
  ordinals: string;
  payment: string;
}

interface CopyNotice {
  message: string;
  tone: 'danger' | 'success';
}

export function QuickAddresses(props: {
  expectation: ActiveSessionExpectation;
  activeAccountId: string;
}): ReactNode {
  const { t } = useI18n();
  const rpc = useRpc();
  const [addresses, setAddresses] = useState<Addresses | null>(null);
  const [notice, setNotice] = useState<CopyNotice | null>(null);
  const { expectedVaultId, expectedSessionId } = props.expectation;

  useEffect(() => {
    let cancelled = false;
    setAddresses(null);
    void Promise.all([
      rpc('address.receive', {
        kind: 'payment',
        accountId: props.activeAccountId,
        expectedVaultId,
        expectedSessionId,
      }),
      rpc('address.receive', {
        kind: 'ordinals',
        accountId: props.activeAccountId,
        expectedVaultId,
        expectedSessionId,
      }),
    ]).then(([payment, ordinals]) => {
      if (cancelled || !payment.ok || !ordinals.ok) return;
      setAddresses({
        payment: payment.result.address,
        ordinals: ordinals.result.address,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [expectedSessionId, expectedVaultId, props.activeAccountId, rpc]);

  useEffect(() => {
    if (notice === null) return undefined;
    const timer = setTimeout(() => setNotice(null), 2_000);
    return () => clearTimeout(timer);
  }, [notice]);

  if (addresses === null) return null;

  return (
    <>
      <div
        className={styles['quickAddressActions']}
        role="group"
        aria-label={t('home.addresses')}
      >
        {([
          ['payment', t('receive.tab.bitcoin'), addresses.payment],
          ['ordinals', t('receive.tab.ordinals'), addresses.ordinals],
        ] as const).map(([kind, label, address]) => (
          <CopyButton
            key={kind}
            value={address}
            kind="address"
            label={t('home.copyAddress', { kind: label })}
            className={styles['quickCopyButton']}
            icon={<PopupIcon name={kind === 'payment' ? 'bitcoin' : 'ordinals'} />}
            onCopyResult={(result) => {
              setNotice({
                message: t(
                  result === 'copied'
                    ? 'home.addressCopied'
                    : 'home.addressCopyFailed',
                  { kind: label },
                ),
                tone: result === 'copied' ? 'success' : 'danger',
              });
            }}
          />
        ))}
      </div>
      {notice !== null ? (
        <div
          className={styles['copyToast']}
          data-tone={notice.tone}
          role="status"
          aria-live="polite"
        >
          {notice.message}
        </div>
      ) : null}
    </>
  );
}
