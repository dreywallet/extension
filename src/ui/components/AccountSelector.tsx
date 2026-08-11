import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { SessionView } from '../hooks/use-session';
import { useI18n } from '../i18n';
import { useRpc } from '../hooks/use-rpc';
import { FULLPAGE_HASH } from '../../entrypoints/fullpage/routes';
import { AccountMark } from './AccountMark';
import styles from './AccountSelector.module.css';

function openFullpage(hash: string): void {
  if (window.location.pathname.endsWith('/fullpage.html')) {
    window.location.hash = hash;
    return;
  }
  void chrome.tabs.create({ url: chrome.runtime.getURL(`/fullpage.html${hash}`) });
}

/** Worker-authoritative standard-account menu shared by popup and settings. */
export function AccountSelector(props: {
  session: SessionView;
  compact?: boolean;
  showManageAction?: boolean;
}): ReactNode {
  const { t } = useI18n();
  const rpc = useRpc();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [addFailed, setAddFailed] = useState(false);
  const [showAddUnavailable, setShowAddUnavailable] = useState(false);
  const expectedVaultId = props.session.expectation?.expectedVaultId ?? null;
  const expectedSessionId = props.session.expectation?.expectedSessionId ?? null;
  const refresh = props.session.refresh;
  const disabled = busy || expectedVaultId === null || expectedSessionId === null;
  const accounts = props.session.accountSummaries;
  // Marks exist to tell accounts apart, so a lone account never shows one.
  const showMarks = accounts.length > 1;
  const active = accounts.find((account) => account.accountId === props.session.activeAccountId);
  const activeVault = props.session.vaults.find((vault) => vault.vaultId === props.session.activeVaultId);
  const activeVaultNumber = Math.max(
    1,
    props.session.vaults.findIndex((vault) => vault.vaultId === props.session.activeVaultId) + 1,
  );
  const activeAccountName = active?.name ?? t('account.number', {
    account: props.session.activeAccount + 1,
  });
  const addUnavailable = props.session.accountAddRequirement === null
    ? t('account.addExhausted')
    : t('account.addUnavailable', {
        fundAccount: props.session.accountAddRequirement.fundAccount + 1,
        nextAccount: props.session.accountAddRequirement.nextAccount + 1,
      });

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    setAddFailed(false);
    setShowAddUnavailable(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [closeMenu, open]);

  const selectAccount = useCallback(
    async (accountId: string) => {
      if (
        expectedVaultId === null ||
        expectedSessionId === null ||
        !accounts.some((account) => account.accountId === accountId)
      ) return;
      closeMenu(true);
      if (accountId === props.session.activeAccountId) return;
      setBusy(true);
      try {
        const result = await rpc('account.active.set', {
          accountId,
          expectedVaultId,
          expectedSessionId,
        });
        if (result.ok) refresh();
      } finally {
        setBusy(false);
      }
    },
    [
      closeMenu,
      expectedSessionId,
      expectedVaultId,
      props.session.activeAccountId,
      refresh,
      rpc,
      accounts,
    ],
  );

  const addAccount = useCallback(async () => {
    if (
      expectedVaultId === null ||
      expectedSessionId === null
    ) return;
    if (!props.session.canAddAccount) {
      setShowAddUnavailable(true);
      return;
    }
    setBusy(true);
    setAddFailed(false);
    try {
      const result = await rpc('account.add', { expectedVaultId, expectedSessionId });
      if (!result.ok) {
        setAddFailed(true);
        return;
      }
      closeMenu(true);
      refresh();
    } finally {
      setBusy(false);
    }
  }, [
    closeMenu,
    expectedSessionId,
    expectedVaultId,
    props.session.canAddAccount,
    refresh,
    rpc,
  ]);

  const openDestination = useCallback((hash: string) => {
    closeMenu();
    openFullpage(hash);
  }, [closeMenu]);

  const moveMenuFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="menuitemradio"], [role="menuitem"]',
    )].filter((item) => !item.disabled);
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      event.key === 'Home' ? 0 :
      event.key === 'End' ? items.length - 1 :
      event.key === 'ArrowDown' ? (current + 1) % items.length :
      (current <= 0 ? items.length : current) - 1;
    items[nextIndex]?.focus();
  };

  return (
    <div
      ref={rootRef}
      className={[styles['selector'], props.compact ? styles['compact'] : null]
        .filter(Boolean)
        .join(' ')}
    >
      {props.compact ? null : (
        <span className={styles['label']}>{t('account.active')}</span>
      )}
      <button
        ref={triggerRef}
        type="button"
        className={styles['trigger']}
        aria-label={t('account.active')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={`${activeVault?.name ?? t('settings.vaults')} / ${activeAccountName}`}
        disabled={disabled}
        onClick={() => {
          if (open) closeMenu();
          else setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
            requestAnimationFrame(() => {
              const current = rootRef.current?.querySelector<HTMLButtonElement>(
                '[role="menuitemradio"][aria-checked="true"]',
              );
              current?.focus();
            });
          }
        }}
      >
        {props.session.vaults.length > 1 ? (
          <span className={styles['walletCue']} aria-hidden="true">W{activeVaultNumber}</span>
        ) : null}
        <span className={styles['accountName']}>{activeAccountName}</span>
        <span className={styles['chevron']} aria-hidden="true" />
      </button>
      {open ? (
        <div
          id={menuId}
          className={styles['menu']}
          role="menu"
          aria-label={t('account.active')}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeMenu(true);
              return;
            }
            moveMenuFocus(event);
          }}
        >
          {props.session.vaults.length > 1 && activeVault !== undefined ? (
            <button
              type="button"
              className={[styles['option'], styles['walletEntry']].join(' ')}
              role="menuitem"
              onClick={() => openDestination(FULLPAGE_HASH.walletAccounts)}
            >
              <span className={styles['walletDot']} aria-hidden="true" />
              <span className={styles['optionLabel']}>{activeVault.name}</span>
              <span className={styles['trailing']} aria-hidden="true">›</span>
            </button>
          ) : null}
          {accounts.map((account) => {
            const selected = account.accountId === props.session.activeAccountId;
            return (
              <button
                key={account.accountId}
                type="button"
                className={styles['option']}
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => void selectAccount(account.accountId)}
              >
                <span className={styles['check']} aria-hidden="true">
                  {selected ? '✓' : ''}
                </span>
                {showMarks ? <AccountMark seed={account.accountId} /> : null}
                <span className={styles['optionLabel']}>{account.name}</span>
                {account.signingSource === 'none' ? (
                  <span className={styles['meta']}>{t('account.watchOnly')}</span>
                ) : null}
              </button>
            );
          })}
          <button
            type="button"
            className={[styles['option'], styles['add']].join(' ')}
            role="menuitem"
            disabled={busy}
            onClick={() => void addAccount()}
          >
            <span className={styles['check']} aria-hidden="true">+</span>
            {showMarks ? <span className={styles['markGap']} aria-hidden="true" /> : null}
            <span className={styles['optionLabel']}>{t('account.add')}</span>
          </button>
          {props.showManageAction === false ? null : (
            <button type="button" className={styles['option']} role="menuitem"
              onClick={() => openDestination(FULLPAGE_HASH.walletAccounts)}>
              <span className={styles['check']} aria-hidden="true">⚙</span>
              {showMarks ? <span className={styles['markGap']} aria-hidden="true" /> : null}
              <span className={styles['optionLabel']}>{t('account.selector.manage')}</span>
            </button>
          )}
          {showAddUnavailable ? (
            <p className={styles['hint']} role="status">{addUnavailable}</p>
          ) : null}
          {addFailed ? (
            <p className={styles['error']} role="alert">{t('account.addError')}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
