/** Profile-wide presentation accent shared by every extension UI entrypoint. */

export const ACCENT_PREFS = ['white', 'orange', 'green'] as const;

export type AccentPref = (typeof ACCENT_PREFS)[number];

/** Apply the selected palette through the document-level design-token switch. */
export function applyAccent(accent: AccentPref): void {
  document.documentElement.dataset['accent'] = accent;
}
