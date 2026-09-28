/**
 * Open a full-page wallet section. From the popup or side panel this reuses a
 * wallet tab that is already open instead of piling up duplicates; inside the
 * full page it just changes section.
 */
export async function openWalletPage(hash: string): Promise<void> {
  if (window.location.pathname.endsWith('/fullpage.html')) {
    window.location.hash = hash;
    return;
  }
  const base = chrome.runtime.getURL('/fullpage.html');
  const url = `${base}${hash}`;
  try {
    // getContexts needs no extra permission and only sees Drey's own pages.
    const contexts = typeof chrome.runtime.getContexts === 'function'
      ? await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.TAB] })
      : [];
    const existing = contexts.find((context) =>
      context.tabId >= 0 && context.documentUrl?.split('#')[0] === base);
    if (existing !== undefined) {
      await chrome.tabs.update(existing.tabId, existing.documentUrl === url
        ? { active: true }
        : { active: true, url });
      if (existing.windowId >= 0) await chrome.windows.update(existing.windowId, { focused: true });
      return;
    }
  } catch {
    // Fall through to a fresh tab: finding an old one is only a convenience.
  }
  await chrome.tabs.create({ url });
}
