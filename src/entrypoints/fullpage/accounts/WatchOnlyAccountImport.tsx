import { useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import type { AccountListResult } from '@drey/core/messaging/ops';
import type { Network } from '@drey/core/domain/keys/derivation';
import {
  decodeAccountDescriptor,
  definitionFromAccountKeys,
  parsePublicAccountText,
  PublicAccountInterchangeError,
  type PublicAccountInterchangeCandidate,
  type PublicAccountInterchangeFormat,
} from '@drey/core/domain/accounts/public-account-interchange';
import {
  derivePublicAccountAddress,
  type PublicAccountDefinitionV1,
} from '@drey/core/domain/accounts/public-account';
import type { ActiveSessionExpectation } from '../../../ui/hooks/use-session';
import { useRpc } from '../../../ui/hooks/use-rpc';
import { useI18n } from '../../../ui/i18n';
import { Button } from '../../../ui/components/Button';
import { decodeQrImageFile } from '../../../ui/vault/qr-scanner/frame-decoder';
import { AccountUrFrameDecoder } from '../../../ui/accounts/account-ur-decoder';
import { WatchAccountScanner, type WatchQrPayload } from './WatchAccountScanner';
import styles from '../fullpage.module.css';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const TEXT_TYPES = new Set(['application/json', 'text/plain', 'application/cbor', 'application/octet-stream', '']);

function sourceLabel(format: PublicAccountInterchangeFormat): string {
  return {
    'account-descriptor-v2': 'BCR account-descriptor v2',
    'crypto-account-v1': 'Legacy BCR crypto-account',
    'bitcoin-core-json': 'Bitcoin Core descriptor JSON',
    'bip380-descriptors': 'BIP-380 output descriptors',
    'account-key-expressions': 'Origin-qualified public keys',
  }[format];
}

function explain(error: unknown): string {
  if (!(error instanceof PublicAccountInterchangeError)) {
    return error instanceof Error ? error.message : 'This public account could not be read.';
  }
  switch (error.code) {
    case 'missing-payment': return 'BIP84 payment account data is missing. Add its receive and change data.';
    case 'missing-ordinals': return 'Taproot account data is missing. Add its BIP86 receive and change data.';
    case 'wrong-network': return error.message;
    case 'invalid-checksum': return 'The descriptor checksum does not match.';
    case 'private-material': return 'Private keys and recovery phrases are not accepted here.';
    case 'conflicting-account': return error.message;
    case 'limit-exceeded': return 'This file or account document is too large.';
    case 'unsupported-policy': return error.message;
    case 'invalid-format': return error.message;
  }
}

function candidateFromQr(payload: WatchQrPayload, network: Network): PublicAccountInterchangeCandidate {
  if (payload.kind === 'text') return parsePublicAccountText(payload.value, network);
  if (payload.type !== 'account-descriptor' && payload.type !== 'crypto-account') {
    throw new PublicAccountInterchangeError('invalid-format', `ur:${payload.type} is not a public-account QR.`);
  }
  return decodeAccountDescriptor(payload.cbor, payload.type, network);
}

export function WatchOnlyAccountImport(props: {
  expectation: ActiveSessionExpectation;
  accounts: AccountListResult['accounts'];
  network: Network;
  onClose(): void;
  onImported(): void;
}): ReactNode {
  const rpc = useRpc();
  const { t } = useI18n();
  const imageCanvasRef = useRef<HTMLCanvasElement>(null);
  const [method, setMethod] = useState<'scan' | 'paste' | 'file'>('scan');
  const [draft, setDraft] = useState('');
  const [candidate, setCandidate] = useState<PublicAccountInterchangeCandidate | null>(null);
  const [name, setName] = useState('Watch-only account');
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState({
    fingerprint: '', account: '0', payment: '', ordinals: '',
    paymentReceive: '', paymentChange: '', ordinalsReceive: '', ordinalsChange: '',
  });

  function accept(next: PublicAccountInterchangeCandidate): void {
    setCandidate(next);
    setName(next.suggestedName?.slice(0, 80) || 'Watch-only account');
    setAcknowledged(false);
    setError(null);
  }

  function processText(value: string, append = false): void {
    const combined = append && draft.trim() !== '' ? `${draft.trim()}\n${value.trim()}` : value;
    setDraft(combined);
    try {
      accept(parsePublicAccountText(combined, props.network));
    } catch (nextError) {
      setCandidate(null);
      setError(explain(nextError));
    }
  }

  function processQr(payload: WatchQrPayload): void {
    try {
      if (payload.kind === 'text') {
        processText(payload.value, true);
        return;
      }
      accept(candidateFromQr(payload, props.network));
    } catch (nextError) {
      setError(explain(nextError));
    }
  }

  async function chooseFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    setError(null);
    if (file.size === 0 || file.size > MAX_FILE_BYTES) {
      setError('Choose a non-empty file no larger than 2 MB.');
      return;
    }
    if (/\.(?:svg|html?|xml)$/iu.test(file.name) || /(?:svg|html|xml)/iu.test(file.type)) {
      setError('SVG, HTML, and XML files are not accepted.');
      return;
    }
    if (RASTER_TYPES.has(file.type) || /\.(?:png|jpe?g|webp)$/iu.test(file.name)) {
      const canvas = imageCanvasRef.current;
      if (canvas === null) return;
      try {
        const result = await decodeQrImageFile(file, canvas);
        if (result.status !== 'decoded') throw new Error('No readable QR code was found in this image.');
        if (!result.value.toLowerCase().startsWith('ur:')) processText(result.value, true);
        else {
          const decoded = new AccountUrFrameDecoder().receive(result.value);
          if (decoded.status !== 'complete') {
            throw new Error('This image is one frame of an animated QR. Use Scan QR to capture the sequence.');
          }
          processQr({ kind: 'ur', type: decoded.type, cbor: decoded.cbor });
        }
      } catch (nextError) {
        setError(explain(nextError));
      }
      return;
    }
    if (!TEXT_TYPES.has(file.type) && !/\.(?:json|txt|cbor)$/iu.test(file.name)) {
      setError('Choose JSON, text, CBOR, PNG, JPEG, or WebP.');
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (/\.cbor$/iu.test(file.name) || file.type === 'application/cbor') {
        try {
          accept(decodeAccountDescriptor(bytes, 'account-descriptor', props.network));
        } catch {
          accept(decodeAccountDescriptor(bytes, 'crypto-account', props.network));
        }
      } else {
        processText(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      }
    } catch (nextError) {
      setError(explain(nextError));
    }
  }

  function useAdvancedKeys(): void {
    try {
      const definition = definitionFromAccountKeys({
        network: props.network,
        masterFingerprintHex: advanced.fingerprint,
        accountIndex: Number(advanced.account),
        paymentAccountXpub: advanced.payment,
        ordinalsAccountXpub: advanced.ordinals,
      });
      accept({ format: 'account-key-expressions', definition });
    } catch (nextError) {
      setError(explain(nextError));
    }
  }

  async function importAccount(definition: PublicAccountDefinitionV1): Promise<void> {
    const duplicate = props.accounts.find((account) => account.accountId === definition.accountId);
    if (duplicate !== undefined) {
      setBusy(true);
      const selected = await rpc('account.active.set', { accountId: duplicate.accountId, ...props.expectation });
      setBusy(false);
      if (selected.ok) props.onImported();
      else setError('The existing account could not be selected.');
      return;
    }
    setBusy(true);
    const result = await rpc('account.watch.import', {
      name: name.trim(),
      network: definition.network,
      paymentReceiveDescriptor: definition.lanes.payment.receiveDescriptor,
      paymentChangeDescriptor: definition.lanes.payment.changeDescriptor,
      ordinalsReceiveDescriptor: definition.lanes.ordinals.receiveDescriptor,
      ordinalsChangeDescriptor: definition.lanes.ordinals.changeDescriptor,
      ...props.expectation,
    });
    if (!result.ok) {
      setError('The account changed or could not be imported. Your input has been kept.');
      setBusy(false);
      return;
    }
    void rpc('scan.start', { mode: 'rescan', ...props.expectation });
    setBusy(false);
    props.onImported();
  }

  const definition = candidate?.definition;
  const duplicate = definition === undefined ? undefined
    : props.accounts.find((account) => account.accountId === definition.accountId);
  const paymentAddress = definition === undefined ? null
    : derivePublicAccountAddress(definition, 'payment', 0, 0).address;
  const ordinalsAddress = definition === undefined ? null
    : derivePublicAccountAddress(definition, 'ordinals', 0, 0).address;

  return (
    <section className={styles['section']} aria-labelledby="watch-import-title">
      <h2 id="watch-import-title" className={styles['sectionTitle']}>{t('watch.import.title')}</h2>
      <p className={styles['advisory']}>{t('watch.import.body')}</p>
      <div className={styles['importMethods']} role="group" aria-label="Import method">
        {(['scan', 'paste', 'file'] as const).map((value) => (
          <Button
            key={value}
            aria-pressed={method === value}
            variant={method === value ? 'primary' : 'secondary'}
            onClick={() => setMethod(value)}
          >
            {t(value === 'scan' ? 'watch.import.scan' : value === 'paste' ? 'watch.import.paste' : 'watch.import.file')}
          </Button>
        ))}
      </div>
      {method === 'scan' ? <WatchAccountScanner onPayload={processQr} /> : null}
      {method === 'paste' ? (
        <div className={styles['pastePanel']}>
          <div className={styles['pasteField']}>
            <label htmlFor="watch-import-data" className={styles['pasteLabel']}>
              {t('watch.import.data')}
            </label>
            <p id="watch-import-paste-hint" className={styles['pasteHint']}>
              {t('watch.import.pasteHint')}
            </p>
            <textarea
              id="watch-import-data"
              className={styles['pasteTextarea']}
              value={draft}
              rows={8}
              autoFocus
              spellCheck={false}
              aria-describedby="watch-import-paste-hint"
              placeholder={t('watch.import.placeholder')}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
          <div className={styles['pasteActions']}>
            <Button disabled={draft.trim() === ''} onClick={() => processText(draft)}>
              {t('watch.import.detect')}
            </Button>
          </div>
        </div>
      ) : null}
      {method === 'file' ? (
        <label>
          {t('watch.import.fileLabel')}
          <input type="file" accept=".json,.txt,.cbor,image/png,image/jpeg,image/webp" onChange={(event) => void chooseFile(event)} />
          <small>{t('watch.import.fileHint')}</small>
        </label>
      ) : null}
      <canvas ref={imageCanvasRef} hidden />
      {error !== null ? <p role="alert" className={styles['error']}>{error}</p> : null}
      {candidate === null ? (
        <details className={styles['importDisclosure']}>
          <summary>{t('watch.import.advanced')}</summary>
          <div className={styles['advancedImportPanel']}>
            <div className={styles['advancedMetaGrid']}>
              <label className={styles['advancedField']}>
                <span>{t('watch.import.fingerprint')}</span>
                <input
                  className={styles['advancedInput']}
                  value={advanced.fingerprint}
                  spellCheck={false}
                  onChange={(event) => setAdvanced({ ...advanced, fingerprint: event.target.value })}
                />
              </label>
              <label className={styles['advancedField']}>
                <span>{t('watch.import.account')}</span>
                <input
                  className={styles['advancedInput']}
                  type="number"
                  min="0"
                  value={advanced.account}
                  onChange={(event) => setAdvanced({ ...advanced, account: event.target.value })}
                />
              </label>
            </div>
            <label className={styles['advancedField']}>
              <span>{t('watch.import.paymentKey')}</span>
              <textarea
                className={styles['advancedTextarea']}
                value={advanced.payment}
                spellCheck={false}
                onChange={(event) => setAdvanced({ ...advanced, payment: event.target.value.trim() })}
              />
            </label>
            <label className={styles['advancedField']}>
              <span>{t('watch.import.ordinalsKey')}</span>
              <textarea
                className={styles['advancedTextarea']}
                value={advanced.ordinals}
                spellCheck={false}
                onChange={(event) => setAdvanced({ ...advanced, ordinals: event.target.value.trim() })}
              />
            </label>
            <div className={styles['advancedActions']}>
              <Button
                variant="secondary"
                disabled={advanced.fingerprint.trim() === '' || advanced.payment === '' || advanced.ordinals === ''}
                onClick={useAdvancedKeys}
              >
                {t('watch.import.reviewKeys')}
              </Button>
            </div>
          </div>
          <details className={styles['descriptorDisclosure']}>
            <summary>{t('watch.import.fourDescriptors')}</summary>
            <div className={styles['descriptorPanel']}>
              <div className={styles['descriptorGrid']}>
                {([
                  ['paymentReceive', 'account.manage.paymentReceive'],
                  ['paymentChange', 'account.manage.paymentChange'],
                  ['ordinalsReceive', 'account.manage.ordinalsReceive'],
                  ['ordinalsChange', 'account.manage.ordinalsChange'],
                ] as const).map(([field, message]) => (
                  <label key={field} className={styles['advancedField']}>
                    <span>{t(message)}</span>
                    <textarea
                      className={styles['advancedTextarea']}
                      value={advanced[field]}
                      spellCheck={false}
                      onChange={(event) => setAdvanced({ ...advanced, [field]: event.target.value })}
                    />
                  </label>
                ))}
              </div>
              <div className={styles['advancedActions']}>
                <Button
                  variant="secondary"
                  disabled={[
                    advanced.paymentReceive, advanced.paymentChange,
                    advanced.ordinalsReceive, advanced.ordinalsChange,
                  ].some((value) => value.trim() === '')}
                  onClick={() => processText([
                    advanced.paymentReceive, advanced.paymentChange,
                    advanced.ordinalsReceive, advanced.ordinalsChange,
                  ].join('\n'))}
                >
                  {t('watch.import.reviewDescriptors')}
                </Button>
              </div>
            </div>
          </details>
        </details>
      ) : null}
      {definition !== undefined ? (
        <section className={styles['advisory']} aria-labelledby="watch-review-title">
          <h3 id="watch-review-title">{t('watch.import.reviewTitle')}</h3>
          <label>{t('account.manage.name')}<input maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <dl>
            <dt>{t('watch.import.network')}</dt><dd>{definition.network}</dd>
            <dt>{t('watch.import.account')}</dt><dd>{definition.derivationAccountIndex}</dd>
            <dt>{t('watch.import.fingerprint')}</dt><dd><code>{definition.lanes.payment.origin.masterFingerprintHex}</code></dd>
            <dt>{t('watch.import.format')}</dt><dd>{sourceLabel(candidate!.format)}</dd>
            <dt>{t('watch.import.paymentStatus')}</dt><dd>{t('watch.import.complete')}</dd>
            <dt>{t('watch.import.ordinalsStatus')}</dt><dd>{t('watch.import.complete')}</dd>
          </dl>
          <p><strong>{t('watch.import.paymentAddress')}</strong><br /><code>{paymentAddress}</code></p>
          <p><strong>{t('watch.import.ordinalsAddress')}</strong><br /><code>{ordinalsAddress}</code></p>
          <details>
            <summary>{t('watch.import.details')}</summary>
            <p><code>{definition.lanes.payment.origin.path}</code></p>
            <pre className={styles['code']}>{[
              definition.lanes.payment.receiveDescriptor,
              definition.lanes.payment.changeDescriptor,
              definition.lanes.ordinals.receiveDescriptor,
              definition.lanes.ordinals.changeDescriptor,
            ].join('\n\n')}</pre>
          </details>
          {duplicate !== undefined ? (
            <p role="status">{t('watch.import.existing', { name: duplicate.name })}</p>
          ) : (
            <label>
              <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
              {t('watch.import.ack')}
            </label>
          )}
          <div className={styles['row']}>
            <Button
              disabled={busy || name.trim() === '' || (duplicate === undefined && !acknowledged)}
              onClick={() => void importAccount(definition)}
            >
              {duplicate === undefined ? t('watch.import.action') : t('watch.import.select', { name: duplicate.name })}
            </Button>
            <Button variant="secondary" onClick={() => setCandidate(null)}>{t('watch.import.change')}</Button>
          </div>
        </section>
      ) : null}
      <Button variant="ghost" onClick={props.onClose}>{t('watch.import.close')}</Button>
    </section>
  );
}
