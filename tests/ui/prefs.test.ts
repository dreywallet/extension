import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UI_PREFS_KEY } from '../../src/adapters/storage/keys';
import { DEFAULT_UI_PREFS, loadUiPrefs, saveUiPrefs } from '../../src/ui/prefs';

describe('UI preferences', () => {
  let stored: Record<string, unknown>;
  let set: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stored = {};
    set = vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(stored, structuredClone(items));
    });
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => structuredClone(stored)),
          set,
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to white and English when no preferences are stored', async () => {
    await expect(loadUiPrefs()).resolves.toEqual(DEFAULT_UI_PREFS);
  });

  it.each(['system', 'light', 'dark'] as const)(
    'preserves language while migrating the legacy %s theme',
    async (theme) => {
      stored[UI_PREFS_KEY] = { theme, language: 'es' };
      await expect(loadUiPrefs()).resolves.toEqual({
        accent: 'white',
        activityUnit: 'sats',
        hidePortfolioAmounts: false,
        language: 'es',
      });
    },
  );

  it('migrates the language-only shape to the white accent', async () => {
    stored[UI_PREFS_KEY] = { language: 'es' };
    await expect(loadUiPrefs()).resolves.toEqual({
      accent: 'white',
      activityUnit: 'sats',
      hidePortfolioAmounts: false,
      language: 'es',
    });
  });

  it.each(['white', 'orange', 'green'] as const)('loads the %s accent', async (accent) => {
    stored[UI_PREFS_KEY] = { accent, language: 'en' };
    await expect(loadUiPrefs()).resolves.toEqual({
      accent,
      activityUnit: 'sats',
      hidePortfolioAmounts: false,
      language: 'en',
    });
  });

  it('defaults an invalid accent while preserving a valid language', async () => {
    stored[UI_PREFS_KEY] = { accent: 'purple', language: 'es' };
    await expect(loadUiPrefs()).resolves.toEqual({
      accent: 'white',
      activityUnit: 'sats',
      hidePortfolioAmounts: false,
      language: 'es',
    });
  });

  it('falls back for a malformed language', async () => {
    stored[UI_PREFS_KEY] = { theme: 'sepia', language: 'fr' };
    await expect(loadUiPrefs()).resolves.toEqual(DEFAULT_UI_PREFS);
  });

  it('loads and writes the remembered activity unit with the appearance preferences', async () => {
    stored[UI_PREFS_KEY] = { accent: 'green', activityUnit: 'btc', language: 'es' };
    await expect(loadUiPrefs()).resolves.toEqual({
      accent: 'green',
      activityUnit: 'btc',
      hidePortfolioAmounts: false,
      language: 'es',
    });

    await saveUiPrefs({
      accent: 'green',
      activityUnit: 'btc',
      hidePortfolioAmounts: true,
      language: 'es',
    });
    expect(set).toHaveBeenCalledWith({
      [UI_PREFS_KEY]: {
        accent: 'green',
        activityUnit: 'btc',
        hidePortfolioAmounts: true,
        language: 'es',
      },
    });
    expect(stored[UI_PREFS_KEY]).toEqual({
      accent: 'green',
      activityUnit: 'btc',
      hidePortfolioAmounts: true,
      language: 'es',
    });
  });
});
