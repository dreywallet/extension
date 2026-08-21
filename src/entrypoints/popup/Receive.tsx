import { useEffect, useRef, useState, type ReactNode } from 'react';
import { buildBip321 } from '@drey/core/domain/payments/bip321';
import { parseSats } from '@drey/core/domain/sats';
import { useI18n } from '../../ui/i18n';
import { useRpc } from '../../ui/hooks/use-rpc';
import { errorMessageKey } from '../../ui/errors';
import { Button } from '../../ui/components/Button';
import { Field } from '../../ui/components/Field';
import { QrCode } from '../../ui/components/QrCode';
import { CopyButton } from '../../ui/components/CopyButton';
import { handleRadioKey } from '../../ui/radio-keyboard';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import {
  paymentRequestCardModel,
  paymentRequestQrFits,
  renderPaymentRequestPng,
  shareOrSavePaymentRequest,
} from './payment-request-card';
import styles from './popup.module.css';

type Kind = 'payment' | 'ordinals';

const SATS_INT = /^[1-9][0-9]*$/;
const RECEIVE_KINDS = ['payment', 'ordinals'] as const;

/**
 * §10.6 receive screens: stable address, copy, QR, and (Bitcoin lane only) an
 * optional amount/label building a BIP-321 URI. The label stays local — it is
 * only ever encoded into the URI the user chooses to share.
 */
export function Receive(props: {
  initialKind: Kind;
  expectation: ActiveSessionExpectation;
  activeAccountId: string;
  onClose: () => void;
}): ReactNode {
  const { t } = useI18n();
  const rpc = useRpc();
  const { expectedVaultId, expectedSessionId } = props.expectation;
  const [kind, setKind] = useState<Kind>(props.initialKind);
  const [address, setAddress] = useState<string | null>(null);
  const [network, setNetwork] = useState<'mainnet' | 'signet' | 'regtest' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [label, setLabel] = useState('');
  const [sharing, setSharing] = useState(false);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const shareIdentityRef = useRef<string | null>(null);

  useEffect(() => {
    setAddress(null);
    setError(null);
    let cancelled = false;
    void rpc('address.receive', {
      kind,
      accountId: props.activeAccountId,
      expectedVaultId,
      expectedSessionId,
    }).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setAddress(result.result.address);
        setNetwork(result.result.network);
      } else {
        setError(t(errorMessageKey(result.code)));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [expectedSessionId, expectedVaultId, kind, props.activeAccountId, rpc, t]);

  useEffect(() => () => {
    shareIdentityRef.current = null;
  }, []);

  let amountSats: bigint | undefined;
  let amountValid = amount === '';
  if (amount !== '' && amount.length <= 16 && SATS_INT.test(amount)) {
    try {
      amountSats = parseSats(amount);
      amountValid = true;
    } catch {
      amountValid = false;
    }
  }

  let uri: string | null = null;
  let uriInvalid = false;
  if (address !== null && kind === 'payment' && (amountSats !== undefined || label !== '')) {
    try {
      uri = buildBip321({
        address,
        ...(amountSats !== undefined ? { amountSats } : {}),
        ...(label !== '' ? { label } : {}),
      });
    } catch {
      uriInvalid = true;
    }
  }

  const shareIdentity = address === null || network === null || kind !== 'payment'
    ? null
    : [expectedVaultId, expectedSessionId, props.activeAccountId, network, address, uri ?? address, label]
        .join(':');
  shareIdentityRef.current = shareIdentity;
  const requestModel = address === null || network === null || kind !== 'payment'
    ? null
    : paymentRequestCardModel({
        address,
        amountSats,
        label: uriInvalid ? '' : label,
        network,
        qrValue: uri ?? address,
      });
  const requestQrValid = requestModel !== null && paymentRequestQrFits(requestModel.qrValue);

  useEffect(() => {
    setShareStatus(null);
    setSharing(false);
  }, [shareIdentity]);

  const shareRequest = async (): Promise<void> => {
    if (requestModel === null || shareIdentity === null || !amountValid || uriInvalid || !requestQrValid) return;
    setSharing(true);
    setShareStatus(null);
    const expectedIdentity = shareIdentity;
    try {
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-accent');
      const blob = await renderPaymentRequestPng({
        model: requestModel,
        accent,
        testNetworkWarning: t('receive.request.testNetworkWarning'),
        title: t('receive.request.title'),
      });
      if (shareIdentityRef.current !== expectedIdentity) return;
      const result = await shareOrSavePaymentRequest(blob);
      if (shareIdentityRef.current !== expectedIdentity) return;
      setShareStatus(t(result === 'shared' ? 'receive.request.shared' : 'receive.request.saved'));
    } catch (shareError) {
      if (shareIdentityRef.current !== expectedIdentity) return;
      // Cancelling the native/browser share sheet is not a successful share.
      if (shareError instanceof DOMException && shareError.name === 'AbortError') return;
      setShareStatus(t('receive.request.shareFailed'));
    } finally {
      if (shareIdentityRef.current === expectedIdentity) setSharing(false);
    }
  };

  return (
    <div className={styles['receiveCard']}>
      <div className={styles['segmented']} role="radiogroup" aria-label={t('receive.title')}>
        {RECEIVE_KINDS.map((option) => (
          <Button
            key={option}
            variant={kind === option ? 'primary' : 'secondary'}
            role="radio"
            aria-checked={kind === option}
            tabIndex={kind === option ? 0 : -1}
            onClick={() => setKind(option)}
            onKeyDown={(event) => handleRadioKey(event, RECEIVE_KINDS, kind, setKind)}
          >
            {option === 'payment' ? t('receive.tab.bitcoin') : t('receive.tab.ordinals')}
          </Button>
        ))}
      </div>

      {network !== null ? (
        <p className={styles['explain']}>
          {(() => {
          // The network comes from the worker's channel-pinned answer, never a
          // UI-side assumption (M6 network unification).
          const networkLabel = network === 'regtest'
            ? t('home.network.regtest')
            : network === 'signet'
              ? t('home.network.signet')
              : t('home.network.mainnet');
          return kind === 'payment'
            ? t('receive.bitcoin.explain', { network: networkLabel })
            : t('receive.ordinals.explain', { network: networkLabel });
          })()}
        </p>
      ) : null}

      {error !== null ? (
        <p role="alert" className={styles['error']}>
          {error}
        </p>
      ) : null}
      {uriInvalid ? (
        <p role="alert" className={styles['error']}>{t('receive.qr.tooLong')}</p>
      ) : null}

      {address !== null ? (
        <>
          <QrCode
            value={uri ?? address}
            alt={t('receive.qr.alt')}
            errorText={t('receive.qr.tooLong')}
          />
          <div className={styles['address']} data-testid="receive-address">{address}</div>
          <CopyButton value={address} kind="address" label={t('receive.copyAddress')} />

          {kind === 'payment' ? (
            <>
              <Field
                label={t('receive.amount')}
                value={amount}
                inputMode="numeric"
                maxLength={16}
                error={amountValid ? undefined : t('receive.amount.invalid')}
                onChange={(e) => setAmount(e.target.value.trim())}
              />
              <Field
                label={t('receive.label')}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={200}
              />
              <Button
                disabled={!amountValid || uriInvalid || !requestQrValid || sharing}
                onClick={() => { void shareRequest(); }}
              >
                {sharing ? t('receive.request.sharing') : t('receive.request.share')}
              </Button>
              {uri !== null ? (
                <CopyButton value={uri} kind="uri" label={t('receive.copyUri')} />
              ) : null}
              <p className={styles['paymentRequestPrivacy']}>{t('receive.request.privacy')}</p>
              {shareStatus !== null ? <p role="status" className={styles['shareStatus']}>{shareStatus}</p> : null}
            </>
          ) : null}
        </>
      ) : error === null ? (
        <p>{t('common.loading')}</p>
      ) : null}

      <Button variant="secondary" onClick={props.onClose}>
        {t('common.close')}
      </Button>
    </div>
  );
}
