/**
 * Non-secret UI preferences (accent, language, display unit) in
 * chrome.storage.local, written directly by UI contexts. These are presentation state, not wallet state —
 * they deliberately bypass the worker's op surface and must never grow a
 * secret or security-relevant field (those belong to WalletConfig behind
 * config.get/config.set).
 */
import { z } from 'zod';
import { UI_PREFS_KEY } from '../adapters/storage/keys';
import { ACCENT_PREFS, type AccentPref } from './accent';
import type { Language } from './i18n';

export interface UiPrefs {
  accent: AccentPref;
  activityUnit: ActivityUnit;
  hidePortfolioAmounts: boolean;
  language: Language;
}

export type ActivityUnit = 'btc' | 'sats';

export const DEFAULT_UI_PREFS: UiPrefs = {
  accent: 'white',
  activityUnit: 'sats',
  hidePortfolioAmounts: false,
  language: 'en',
};

const accentSchema = z.enum(ACCENT_PREFS);
const activityUnitSchema = z.enum(['btc', 'sats']);

const uiPrefsSchema = z
  .object({
    language: z.enum(['en', 'es']),
    accent: z.unknown().optional(),
    activityUnit: z.unknown().optional(),
    hidePortfolioAmounts: z.unknown().optional(),
    // Accepted only so records written by the former theme selector retain
    // their language while migrating to the default white accent.
    theme: z.unknown().optional(),
  })
  .strip()
  .transform(({ accent, activityUnit, hidePortfolioAmounts, language }) => {
    const parsedAccent = accentSchema.safeParse(accent);
    const parsedActivityUnit = activityUnitSchema.safeParse(activityUnit);
    return {
      accent: parsedAccent.success ? parsedAccent.data : DEFAULT_UI_PREFS.accent,
      activityUnit: parsedActivityUnit.success
        ? parsedActivityUnit.data
        : DEFAULT_UI_PREFS.activityUnit,
      hidePortfolioAmounts: typeof hidePortfolioAmounts === 'boolean'
        ? hidePortfolioAmounts
        : DEFAULT_UI_PREFS.hidePortfolioAmounts,
      language,
    };
  });

export function parseUiPrefs(raw: unknown): UiPrefs {
  const parsed = uiPrefsSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_UI_PREFS;
}

export async function loadUiPrefs(): Promise<UiPrefs> {
  const raw = (await chrome.storage.local.get(UI_PREFS_KEY))[UI_PREFS_KEY];
  return parseUiPrefs(raw);
}

export async function saveUiPrefs(prefs: UiPrefs): Promise<void> {
  await chrome.storage.local.set({ [UI_PREFS_KEY]: prefs });
}
