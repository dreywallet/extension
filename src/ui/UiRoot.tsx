/**
 * Shared root for every UI entrypoint: loads non-secret appearance prefs and
 * mounts accent, i18n, and typed RPC providers. Children render only after
 * prefs resolve so there is no accent or language flash.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { SenderContext } from '@drey/core/messaging/envelope';
import { applyAccent, type AccentPref } from './accent';
import { I18nProvider, type Language } from './i18n';
import {
  DEFAULT_UI_PREFS,
  loadUiPrefs,
  parseUiPrefs,
  saveUiPrefs,
  type ActivityUnit,
  type UiPrefs,
} from './prefs';
import { UI_PREFS_KEY } from '../adapters/storage/keys';
import { RpcProvider } from './hooks/use-rpc';
import styles from './BuildChannelBanner.module.css';

interface AccentControl {
  accent: AccentPref;
  setAccent: (accent: AccentPref) => void;
}

const AccentContext = createContext<AccentControl | null>(null);

interface ActivityUnitControl {
  activityUnit: ActivityUnit;
  setActivityUnit: (unit: ActivityUnit) => void;
}

const ActivityUnitContext = createContext<ActivityUnitControl>({
  activityUnit: DEFAULT_UI_PREFS.activityUnit,
  setActivityUnit: () => undefined,
});

interface PortfolioPrivacyControl {
  amountsHidden: boolean;
  saveFailed: boolean;
  setAmountsHidden: (hidden: boolean) => void;
}

const PortfolioPrivacyContext = createContext<PortfolioPrivacyControl>({
  amountsHidden: DEFAULT_UI_PREFS.hidePortfolioAmounts,
  saveFailed: false,
  setAmountsHidden: () => undefined,
});

export function useAccent(): AccentControl {
  const context = useContext(AccentContext);
  if (!context) throw new Error('useAccent outside UiRoot');
  return context;
}

export function useActivityUnit(): ActivityUnitControl {
  return useContext(ActivityUnitContext);
}

export function usePortfolioPrivacy(): PortfolioPrivacyControl {
  return useContext(PortfolioPrivacyContext);
}

export function UiRoot(props: { sender: SenderContext; children: ReactNode }): ReactNode {
  const [prefs, setPrefs] = useState<UiPrefs | null>(null);
  const prefsRef = useRef<UiPrefs | null>(null);
  const saveTail = useRef<Promise<void>>(Promise.resolve());
  const [prefsSaveFailed, setPrefsSaveFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadUiPrefs()
      .catch(() => DEFAULT_UI_PREFS)
      .then((loaded) => {
        if (cancelled) return;
        applyAccent(loaded.accent);
        prefsRef.current = loaded;
        setPrefs(loaded);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (areaName !== 'local' || !(UI_PREFS_KEY in changes)) return;
      const next = parseUiPrefs(changes[UI_PREFS_KEY]?.newValue);
      applyAccent(next.accent);
      prefsRef.current = next;
      setPrefs(next);
      setPrefsSaveFailed(false);
    };
    chrome.storage.onChanged?.addListener(onChanged);
    return () => chrome.storage.onChanged?.removeListener(onChanged);
  }, []);

  const updatePrefs = useCallback((partial: Partial<UiPrefs>) => {
    const current = prefsRef.current;
    if (!current) return;
    const next = { ...current, ...partial };
    prefsRef.current = next;
    setPrefs(next);
    setPrefsSaveFailed(false);
    saveTail.current = saveTail.current
      .catch(() => undefined)
      .then(() => saveUiPrefs(next))
      .catch(() => {
        if ('hidePortfolioAmounts' in partial) setPrefsSaveFailed(true);
      });
  }, []);

  const setAccent = useCallback((accent: AccentPref) => {
    applyAccent(accent);
    updatePrefs({ accent });
  }, [updatePrefs]);

  const onLangChange = useCallback((language: Language) => {
    updatePrefs({ language });
  }, [updatePrefs]);

  const setActivityUnit = useCallback((activityUnit: ActivityUnit) => {
    updatePrefs({ activityUnit });
  }, [updatePrefs]);

  const setAmountsHidden = useCallback((hidePortfolioAmounts: boolean) => {
    updatePrefs({ hidePortfolioAmounts });
  }, [updatePrefs]);

  const accentControl = useMemo<AccentControl>(() => ({
    accent: prefs?.accent ?? DEFAULT_UI_PREFS.accent,
    setAccent,
  }), [prefs?.accent, setAccent]);

  const activityUnitControl = useMemo<ActivityUnitControl>(() => ({
    activityUnit: prefs?.activityUnit ?? DEFAULT_UI_PREFS.activityUnit,
    setActivityUnit,
  }), [prefs?.activityUnit, setActivityUnit]);

  const portfolioPrivacyControl = useMemo<PortfolioPrivacyControl>(() => ({
    amountsHidden: prefs?.hidePortfolioAmounts ?? DEFAULT_UI_PREFS.hidePortfolioAmounts,
    saveFailed: prefsSaveFailed,
    setAmountsHidden,
  }), [prefs?.hidePortfolioAmounts, prefsSaveFailed, setAmountsHidden]);

  if (!prefs) return null;

  const isPreview = typeof __BUILD_CHANNEL__ !== 'undefined' && __BUILD_CHANNEL__ === 'preview';

  return (
    <RpcProvider sender={props.sender}>
      <AccentContext.Provider value={accentControl}>
        <ActivityUnitContext.Provider value={activityUnitControl}>
          <PortfolioPrivacyContext.Provider value={portfolioPrivacyControl}>
            <I18nProvider initial={prefs.language} onChange={onLangChange}>
              {isPreview ? (
                <div className={styles.banner} role="status" data-testid="preview-build-banner">
                  BETA — SIGNET ONLY · NO REAL FUNDS
                </div>
              ) : null}
              {props.children}
            </I18nProvider>
          </PortfolioPrivacyContext.Provider>
        </ActivityUnitContext.Provider>
      </AccentContext.Provider>
    </RpcProvider>
  );
}
