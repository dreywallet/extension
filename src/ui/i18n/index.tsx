/**
 * Minimal typed i18n (spec §10.4): en/es catalogs, {placeholder}
 * interpolation, runtime language switching via React context. Layouts must
 * tolerate ≥35% text expansion — enforced by design review, not code.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en, type MessageKey as PortableMessageKey } from './en';
import { es } from './es';
import { passkeyEn, type PasskeyMessageKey } from './passkey-en';
import { passkeyEs } from './passkey-es';
import { vaultEn, type VaultMessageKey } from './vault-en';
import { vaultEs } from './vault-es';
import { watchAccountEn, type WatchAccountMessageKey } from './watch-account-en';
import { watchAccountEs } from './watch-account-es';

export type Language = 'en' | 'es';
/**
 * Portable keys (en.ts/es.ts, mirrored byte-for-byte by mobile) plus the
 * extension-only catalogs: passkey unlock, the browser-first public-account
 * transfer ceremony, and the signet Vault coordinator.
 */
export type MessageKey = PortableMessageKey | PasskeyMessageKey | VaultMessageKey | WatchAccountMessageKey;

export const CATALOGS: Record<Language, Record<MessageKey, string>> = {
  en: { ...en, ...passkeyEn, ...vaultEn, ...watchAccountEn },
  es: { ...es, ...passkeyEs, ...vaultEs, ...watchAccountEs },
};

export function format(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export interface I18n {
  lang: Language;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
  setLang: (lang: Language) => void;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider(props: {
  initial: Language;
  onChange?: (lang: Language) => void;
  children: ReactNode;
}): ReactNode {
  const [lang, setLangState] = useState<Language>(props.initial);
  const { onChange } = props;
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const setLang = useCallback(
    (next: Language) => {
      setLangState(next);
      onChange?.(next);
    },
    [onChange],
  );
  const value = useMemo<I18n>(
    () => ({
      lang,
      setLang,
      t: (key, params) => format(CATALOGS[lang][key], params),
    }),
    [lang, setLang],
  );
  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}
