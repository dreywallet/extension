import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AddressBookV1 } from '@drey/core/domain/address-book';
import {
  createContactTransferRequest,
  openContactTransfer,
  parseContactTransfer,
  sealContactTransfer,
  serializeContactTransfer,
  type ContactTransferReceiverState,
} from '@drey/core/domain/contact-transfer';
import { FixedRateUrEncoder } from '@drey/core/domain/ur/fixed-rate';
import { useI18n } from '../../ui/i18n';
import { useRpc } from '../../ui/hooks/use-rpc';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import { Button } from '../../ui/components/Button';
import { Field } from '../../ui/components/Field';
import { QrCode } from '../../ui/components/QrCode';
import { WatchAccountScanner, type WatchQrPayload } from './accounts/WatchAccountScanner';
import styles from './fullpage.module.css';

type TransferStep = 'idle' | 'receive-request' | 'receive-scan' | 'send-scan' | 'send-response' | 'done';

function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

function TransferQr(props: { type: string; payload: Uint8Array }): ReactNode {
  const { t } = useI18n();
  const encoder = useMemo(
    () => new FixedRateUrEncoder(props.type, props.payload),
    [props.payload, props.type],
  );
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0);
    if (encoder.frames.length === 1) return undefined;
    const timer = window.setInterval(
      () => setIndex((current) => (current + 1) % encoder.frames.length), 350,
    );
    return () => window.clearInterval(timer);
  }, [encoder]);
  return (
    <div className={styles['exportQr']}>
      <QrCode value={encoder.frames[index]!} size={260}
        alt={t('contacts.transfer.qrAlt', { current: index + 1, total: encoder.frames.length })} />
      <p role="status">{t('contacts.transfer.frame', {
        current: index + 1, total: encoder.frames.length,
      })}</p>
    </div>
  );
}

export function AddressBook(props: {
  expectation: ActiveSessionExpectation;
  onBack: () => void;
  onSend?: (address: string) => void;
}): ReactNode {
  const { t } = useI18n();
  const rpc = useRpc();
  const [book, setBook] = useState<AddressBookV1 | null>(null);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [transferStep, setTransferStep] = useState<TransferStep>('idle');
  const [transferPayload, setTransferPayload] = useState<{
    type: string; bytes: Uint8Array;
  } | null>(null);
  const [transferResult, setTransferResult] = useState<{ added: number; skipped: number } | null>(null);
  const receiver = useRef<ContactTransferReceiverState | null>(null);
  const addSection = useRef<HTMLElement | null>(null);

  function wipeReceiver(): void {
    receiver.current?.privateKey.fill(0);
    receiver.current = null;
  }

  useEffect(() => {
    let active = true;
    void rpc('addressBook.list', props.expectation).then((response) => {
      if (!active) return;
      if (response.ok) setBook(response.result);
      else setError(t('common.error.internal'));
    });
    return () => { active = false; };
  }, [props.expectation, rpc, t]);

  useEffect(() => () => wipeReceiver(), []);

  function closeTransfer(): void {
    wipeReceiver();
    setTransferStep('idle');
    setTransferPayload(null);
    setTransferResult(null);
    setError(null);
  }

  function beginReceive(): void {
    if (book === null) return;
    wipeReceiver();
    const created = createContactTransferRequest({
      network: book.network, nowMs: Date.now(), random: randomBytes,
    });
    receiver.current = created;
    setTransferPayload({ type: created.request.type, bytes: serializeContactTransfer(created.request) });
    setTransferResult(null);
    setError(null);
    setTransferStep('receive-request');
  }

  function beginSend(): void {
    if (book === null) return;
    if (book.saved.length === 0) {
      setError(t('contacts.transfer.none'));
      return;
    }
    wipeReceiver();
    setTransferPayload(null);
    setTransferResult(null);
    setError(null);
    setTransferStep('send-scan');
  }

  async function receiveTransfer(payload: WatchQrPayload): Promise<void> {
    try {
      if (payload.kind !== 'ur' || book === null) throw new Error('invalid transfer');
      const parsed = parseContactTransfer(payload.cbor);
      if (payload.type !== parsed.type) throw new Error('transfer type mismatch');
      if (transferStep === 'send-scan') {
        if (parsed.type !== 'drey-contacts-request') throw new Error('expected request');
        const response = sealContactTransfer({
          request: parsed, addressBook: book, nowMs: Date.now(), random: randomBytes,
        });
        setTransferPayload({ type: response.type, bytes: serializeContactTransfer(response) });
        setTransferStep('send-response');
        return;
      }
      if (transferStep !== 'receive-scan' || parsed.type !== 'drey-contacts-response' ||
          receiver.current === null) throw new Error('expected response');
      const recipients = openContactTransfer({
        receiver: receiver.current, response: parsed, nowMs: Date.now(),
      });
      wipeReceiver();
      const result = await rpc('addressBook.import', {
        recipients: [...recipients], ...props.expectation,
      });
      if (!result.ok) throw new Error('contact import failed');
      setBook(result.result.addressBook);
      setTransferResult({ added: result.result.added, skipped: result.result.skipped });
      setTransferPayload(null);
      setTransferStep('done');
    } catch {
      if (transferStep === 'receive-scan') wipeReceiver();
      setError(t('contacts.transfer.invalid'));
    }
  }

  async function mutate(
    operation: () => ReturnType<typeof rpc>,
  ): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const response = await operation();
      if (!response.ok) {
        setError(t('contacts.invalid'));
        return false;
      }
      setBook(response.result as AddressBookV1);
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function add(): Promise<void> {
    if (!await mutate(() => rpc('addressBook.add', {
      label, address, ...props.expectation,
    }))) return;
    setLabel('');
    setAddress('');
    setAdding(false);
  }

  function beginAdd(prefilledAddress = ''): void {
    setAdding(true);
    setLabel('');
    setAddress(prefilledAddress);
    setError(null);
    requestAnimationFrame(() => addSection.current?.scrollIntoView?.({ block: 'nearest' }));
  }

  async function copyAddress(id: string, value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(id);
      setError(null);
    } catch {
      setError(t('common.copyFailed'));
    }
  }

  async function rename(): Promise<void> {
    if (renamingId === null || !await mutate(() => rpc('addressBook.rename', {
      id: renamingId, label: renameValue, ...props.expectation,
    }))) return;
    setRenamingId(null);
    setRenameValue('');
  }

  async function remove(id: string): Promise<void> {
    if (await mutate(() => rpc('addressBook.remove', { id, ...props.expectation }))) {
      setPendingRemoval(null);
    }
  }

  const normalizedSearch = search.trim().toLowerCase();
  const savedEntries = (book?.saved ?? []).filter((entry) => normalizedSearch === '' ||
    `${entry.label} ${entry.address}`.toLowerCase().includes(normalizedSearch));
  const savedAddresses = new Set((book?.saved ?? []).map((entry) => entry.address.toLowerCase()));

  return (
    <>
      <Button variant="ghost" onClick={props.onBack}>{t('common.back')}</Button>
      <div className={styles['addressBookHeader']}>
        <div>
          <h1 className={styles['title']}>{t('contacts.title')}</h1>
          <p className={styles['rowLabel']}>{t('contacts.intro')}</p>
        </div>
        {!adding ? <Button onClick={() => beginAdd()}>{t('contacts.add')}</Button> : null}
      </div>
      {error !== null ? <p role="alert" className={styles['error']}>{error}</p> : null}
      {book === null && error === null ? <p role="status">{t('common.loading')}</p> : null}
      {book !== null && book.saved.length > 0 ? (
        <Field className={styles['contactSearch']} label={t('contacts.searchSaved')}
          value={search} onChange={(event) => setSearch(event.target.value)} />
      ) : null}
      {adding ? (
        <section ref={addSection} className={styles['section']}>
          <h2 className={styles['sectionTitle']}>{t('contacts.add')}</h2>
          <Field label={t('contacts.label')} value={label} autoFocus
            onChange={(event) => setLabel(event.target.value)} />
          <Field label={t('contacts.address')} value={address} autoCapitalize="none"
            autoCorrect="off" spellCheck={false}
            onChange={(event) => setAddress(event.target.value)} />
          <div className={styles['row']}>
            <Button variant="secondary" onClick={() => { setAdding(false); setLabel(''); setAddress(''); }}>
              {t('contacts.cancel')}
            </Button>
            <Button disabled={busy || label.trim() === '' || address.trim() === ''}
              onClick={() => void add()}>{t('contacts.save')}</Button>
          </div>
        </section>
      ) : null}
      {book?.saved.length === 0 && !adding ? (
        <section className={styles['section']}><p className={styles['rowLabel']}>{t('contacts.empty')}</p></section>
      ) : null}
      {book !== null && book.saved.length > 0 && savedEntries.length === 0 ? (
        <section className={styles['section']}><p className={styles['rowLabel']}>{t('contacts.noMatches')}</p></section>
      ) : null}
      {savedEntries.map((entry) => (
        <section className={`${styles['section']} ${styles['contactEntry']}`} key={entry.id}>
          {renamingId === entry.id ? (
            <>
              <Field label={t('contacts.label')} value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)} />
              <div className={styles['row']}>
                <Button variant="secondary" onClick={() => { setRenamingId(null); setRenameValue(''); }}>
                  {t('contacts.cancel')}
                </Button>
                <Button disabled={busy || renameValue.trim() === ''} onClick={() => void rename()}>
                  {t('contacts.save')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className={styles['contactIdentity']}>
                <strong>{entry.label}</strong>
                <code title={entry.address}>{entry.address}</code>
              </div>
              {pendingRemoval === entry.id ? (
                <div className={styles['removeConfirmation']} role="alert">
                  <strong>{t('contacts.removeTitle', { name: entry.label })}</strong>
                  <p>{t('contacts.removeBody')}</p>
                  <div className={styles['row']}>
                    <Button variant="secondary" onClick={() => setPendingRemoval(null)}>
                      {t('contacts.cancel')}
                    </Button>
                    <Button variant="danger" disabled={busy} onClick={() => void remove(entry.id)}>
                      {t('contacts.remove')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className={styles['contactActions']}>
                  <Button variant="secondary" onClick={() => {
                    setRenamingId(entry.id); setRenameValue(entry.label); setPendingRemoval(null);
                  }}>{t('contacts.rename')}</Button>
                  <Button variant="secondary" onClick={() => void copyAddress(entry.id, entry.address)}>
                    {copiedId === entry.id ? t('common.copied') : t('common.copy')}
                  </Button>
                  {props.onSend ? (
                    <Button variant="secondary" onClick={() => props.onSend?.(entry.address)}>
                      {t('home.send')}
                    </Button>
                  ) : null}
                  <Button variant="danger" onClick={() => {
                    setPendingRemoval(entry.id); setRenamingId(null);
                  }}>{t('contacts.remove')}</Button>
                </div>
              )}
            </>
          )}
        </section>
      ))}
      <details className={styles['disclosureSection']} open={transferStep !== 'idle' || undefined}>
        <summary><span>
          <strong>{t('contacts.transfer')}</strong>
          <small>{t('contacts.transfer.intro')}</small>
        </span></summary>
        <div className={styles['disclosureContent']}>
        {transferStep === 'idle' ? (
          <div className={styles['row']}>
            <Button variant="secondary" disabled={book === null} onClick={beginReceive}>
              {t('contacts.transfer.receive')}
            </Button>
            <Button variant="secondary" disabled={book === null} onClick={beginSend}>
              {t('contacts.transfer.send')}
            </Button>
          </div>
        ) : null}
        {transferStep === 'receive-request' && transferPayload !== null ? (
          <>
            <h3>{t('contacts.transfer.receiveTitle')}</h3>
            <p>{t('contacts.transfer.receiveBody')}</p>
            <TransferQr type={transferPayload.type} payload={transferPayload.bytes} />
            <Button onClick={() => setTransferStep('receive-scan')}>
              {t('contacts.transfer.scanResponse')}
            </Button>
          </>
        ) : null}
        {transferStep === 'send-scan' ? (
          <>
            <h3>{t('contacts.transfer.sendTitle')}</h3>
            <p>{t('contacts.transfer.sendBody')}</p>
            <WatchAccountScanner maxPayloadBytes={262_144}
              onPayload={(payload) => void receiveTransfer(payload)} />
          </>
        ) : null}
        {transferStep === 'receive-scan' ? (
          <WatchAccountScanner maxPayloadBytes={262_144}
            onPayload={(payload) => void receiveTransfer(payload)} />
        ) : null}
        {transferStep === 'send-response' && transferPayload !== null ? (
          <>
            <h3>{t('contacts.transfer.responseTitle')}</h3>
            <p>{t('contacts.transfer.responseBody')}</p>
            <TransferQr type={transferPayload.type} payload={transferPayload.bytes} />
          </>
        ) : null}
        {transferStep === 'done' && transferResult !== null ? (
          <p role="status">{t('contacts.transfer.done', transferResult)}</p>
        ) : null}
        {transferStep !== 'idle' ? (
          <Button variant="ghost" onClick={closeTransfer}>{t('contacts.transfer.cancel')}</Button>
        ) : null}
        </div>
      </details>
      <section className={styles['section']}>
        <h2 className={styles['sectionTitle']}>{t('contacts.recent')}</h2>
        {book?.recent.length ? book.recent.map((entry) => (
          <div className={styles['recentRecipient']} key={entry.address}>
            <code title={entry.address}>{entry.address}</code>
            <div className={styles['contactActions']}>
              {!savedAddresses.has(entry.address.toLowerCase()) ? (
                <Button variant="secondary" onClick={() => beginAdd(entry.address)}>
                  {t('contacts.saveRecent')}
                </Button>
              ) : null}
              <Button variant="ghost" onClick={() => void mutate(() => rpc(
                'addressBook.dismissRecent', { address: entry.address, ...props.expectation },
              ))}>{t('contacts.remove')}</Button>
            </div>
          </div>
        )) : <p className={styles['rowLabel']}>{t('contacts.recent.empty')}</p>}
        {book?.recent.length ? (
          <Button variant="secondary" onClick={() => void mutate(() => rpc(
            'addressBook.clearRecent', props.expectation,
          ))}>{t('contacts.clearRecent')}</Button>
        ) : null}
      </section>
    </>
  );
}
