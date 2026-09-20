import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AddressBookV1 } from '@drey/core/domain/address-book';
import { resolvePayableAddress } from '@drey/core/domain/transactions/native-send';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import { useRpc } from '../../ui/hooks/use-rpc';
import { useI18n } from '../../ui/i18n';
import { Button } from '../../ui/components/Button';
import { Field } from '../../ui/components/Field';
import styles from './Runes.module.css';

/** Inline disclosure keeps keyboard navigation native, including in the popup. */
export function RuneRecipients(props: { children: ReactNode; expectation: ActiveSessionExpectation; disabled: boolean; onChoose: (address: string) => void }): ReactNode {
  const rpc = useRpc(); const { t } = useI18n();
  const [open, setOpen] = useState(false); const [search, setSearch] = useState('');
  const [book, setBook] = useState<AddressBookV1 | null>(null);
  const [failed, setFailed] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { expectedVaultId, expectedSessionId } = props.expectation;
  useEffect(() => {
    if (!open) return;
    let active = true;
    setFailed(false);
    void rpc('addressBook.list', { expectedVaultId, expectedSessionId }).then((result) => {
      if (!active) return;
      if (result.ok) setBook(result.result); else setFailed(true);
    });
    return () => { active = false; };
  }, [rpc, open, expectedVaultId, expectedSessionId]);
  const seen = new Set<string>();
  const entries = book ? [
    ...book.saved.map((entry) => ({ address: entry.address, label: entry.label })),
    ...book.recent.map((entry) => ({ address: entry.address, label: t('contacts.recentAddress') })),
  ].filter((entry) => {
    const resolved = resolvePayableAddress(entry.address, book.network);
    if (!resolved.ok || resolved.value.scriptKind !== 'p2tr' || seen.has(entry.address.toLowerCase())) return false;
    seen.add(entry.address.toLowerCase());
    return `${entry.label} ${entry.address}`.toLowerCase().includes(search.trim().toLowerCase());
  }) : [];
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return <>
    <div className={styles['recipientField']}>{props.children}<Button ref={trigger} variant="ghost" className={styles['contactTrigger']} disabled={props.disabled} aria-label={t('contacts.addressBook')} title={t('contacts.addressBook')} aria-expanded={open} onClick={() => setOpen(!open)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="5" y="3" width="15" height="18" rx="2" /><path d="M2 7h5M2 12h5M2 17h5M9 17c0-4 7-4 7 0" /><circle cx="12.5" cy="9" r="2" /></svg></Button></div>
    {open ? <section className={styles['contacts']} aria-label={t('contacts.choose')} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <div className={styles['contactHeader']}><strong>{t('contacts.choose')}</strong><Button variant="ghost" onClick={close}>{t('common.close')}</Button></div>
      <Field label={t('contacts.search')} value={search} onChange={(event) => setSearch(event.target.value)} autoFocus />
      {failed ? <p role="status">{t('runes.contactsFailed')}</p> : !book ? <p role="status">{t('contacts.loading')}</p> : entries.length === 0 ? <p className={styles['hint']}>{t(search ? 'contacts.noMatches' : 'runes.contactsEmpty')}</p> : null}
      <div className={styles['contactList']}>{entries.map((entry) => <button type="button" className={styles['entry']} key={entry.address} disabled={props.disabled} onClick={() => { props.onChoose(entry.address); close(); }}><span className={styles['identity']}><strong>{entry.label}</strong><small>{entry.address}</small></span></button>)}</div>
    </section> : null}
  </>;
}
