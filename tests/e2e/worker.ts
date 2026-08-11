import { expect, type BrowserContext, type Page } from '@playwright/test';

/** Force-closes the MV3 worker through CDP, matching Chrome's termination test guidance. */
export async function terminateExtensionWorker(
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  const controlPage = context.pages()[0] ?? await context.newPage();
  const cdp = await context.newCDPSession(controlPage);
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const target = targetInfos.find((candidate) =>
      candidate.type === 'service_worker' &&
      candidate.url.startsWith(`chrome-extension://${extensionId}/`),
    );
    if (!target) throw new Error(`No live service worker target for extension ${extensionId}`);
    const closed = await cdp.send('Target.closeTarget', { targetId: target.targetId });
    if (!closed.success) throw new Error(`Chrome refused to close service worker ${target.targetId}`);
    // Playwright deliberately keeps an MV3 Worker handle alive across worker
    // lifetimes, so Target.getTargets is not a reliable stopped-state oracle.
    // Target.closeTarget's success response is Chrome's acknowledgement; the
    // next extension event below proves the worker can cold-start and respond.
  } finally {
    await cdp.detach();
  }
}

/** Trigger an extension event and wait for the terminated worker to service it. */
export async function wakeExtensionWorker(page: Page, extensionId: string): Promise<void> {
  if (!page.url().startsWith(`chrome-extension://${extensionId}/`)) {
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
  } else {
    await page.reload();
  }
  await expect(page.locator('body')).not.toHaveText(/Loading…/u);
}
