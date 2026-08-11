import { chromium } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const extensionRoot = fileURLToPath(new URL('..', import.meta.url));
const assetRoot = path.resolve(extensionRoot, '../docs/launch/store-assets/0.5.0');
const sourceUrl = pathToFileURL(path.join(assetRoot, 'asset-source.html')).href;

const outputs = [
  ['overview', 'screenshot-01-wallet-overview-1280x800.png'],
  ['protected', 'screenshot-02-protected-sats-1280x800.png'],
  ['small', 'small-promo-440x280.png'],
  ['marquee', 'marquee-promo-1400x560.png'],
  ['website', 'website-home-dark-764x1186.png'],
  ['icon512', 'website-icon-512.png'],
  ['icon128opaque', 'store-icon-128-noalpha-fallback.png'],
];

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1400 }, deviceScaleFactor: 1 });
  await page.goto(sourceUrl);
  await page.evaluate(() => globalThis.document.fonts.ready);
  const compactNetworkLabel = (await page.locator('#homeMarketing').innerText()).trim();
  if (compactNetworkLabel !== '') {
    throw new Error(`Marketing wallet header must use only the status dot; found: ${compactNetworkLabel}`);
  }
  await page.locator('#homeMarketing').screenshot({
    path: path.join(assetRoot, 'ui-home-marketing.png'),
    animations: 'disabled',
  });
  // Reload so every derivative reads the newly rendered connected-state
  // marketing source rather than a previous file from disk.
  await page.reload();
  await page.evaluate(() => globalThis.document.fonts.ready);
  for (const [selector, filename] of outputs) {
    await page.locator(`#${selector}`).screenshot({
      path: path.join(assetRoot, filename),
      animations: 'disabled',
      omitBackground: selector === 'icon512',
    });
  }
} finally {
  await browser.close();
}
