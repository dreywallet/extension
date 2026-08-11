import { useState, type ReactNode } from 'react';
import { useI18n } from '../../ui/i18n';
import { PopupIcon } from './PopupIcon';
import styles from './popup.module.css';

export function sidePanelOpeningSupported(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.sidePanel?.open === 'function';
}

export async function openSidePanel(): Promise<void> {
  if (!sidePanelOpeningSupported()) throw new Error('side panel API unavailable');
  const current = await chrome.windows.getCurrent();
  if (current.id === undefined || (current.type !== undefined && current.type !== 'normal')) {
    throw new Error('side panel requires a normal browser window');
  }
  await chrome.sidePanel.open({ windowId: current.id });
}

export function OpenSidePanelButton(props: {
  onErrorChange?: ((message: string | null) => void) | undefined;
}): ReactNode {
  const { t } = useI18n();
  const [opening, setOpening] = useState(false);

  if (!sidePanelOpeningSupported()) return null;

  return (
    <button
      type="button"
      className={styles['iconButton']}
      aria-label={t('sidePanel.open')}
      title={t('sidePanel.open')}
      disabled={opening}
      onClick={() => {
        setOpening(true);
        props.onErrorChange?.(null);
        void openSidePanel()
          .catch(() => props.onErrorChange?.(t('sidePanel.openError')))
          .finally(() => setOpening(false));
      }}
    >
      <PopupIcon name="sidePanel" />
    </button>
  );
}
