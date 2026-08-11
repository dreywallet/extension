import { test, expect } from './fixtures';

test('@m9p isolates inert previews from extension APIs, storage, provider state, and networking', async ({
  extensionContext, extensionId,
}) => {
  const page = await extensionContext.newPage();
  const remoteRequests: string[] = [];
  const inspectRequest = (request: { url(): string }): void => {
    const url = request.url();
    if (!url.startsWith(`chrome-extension://${extensionId}/`) && !url.startsWith('blob:null/')) {
      remoteRequests.push(url);
    }
  };
  extensionContext.on('request', inspectRequest);
  try {
    await page.goto(`chrome-extension://${extensionId}/inscription-preview.html`);
    const isolation = await page.evaluate(async () => {
      let storage = 'available';
      try { window.localStorage.setItem('m9p', 'must-not-persist'); } catch { storage = 'blocked'; }
      let networking = 'available';
      try { await fetch('https://example.com/m9p-must-not-load'); } catch { networking = 'blocked'; }
      return {
        origin: window.origin,
        extensionRuntime: typeof globalThis.chrome !== 'undefined' && Boolean(globalThis.chrome.runtime),
        provider: 'drey' in window,
        storage,
        networking,
      };
    });
    expect(isolation).toEqual({
      origin: 'null', extensionRuntime: false, provider: false, storage: 'blocked', networking: 'blocked',
    });

    await page.evaluate(async () => {
      const rasterBase64 = [
        'iVBORw0KGgoAAAA', 'NSUhEUgAAAAEAAA', 'ABCAYAAAAfFcSJ', 'AAAADUlEQVR42mNk',
        '+M/wHwAEAQH/2b', 'zqWQAAAABJRU5E', 'rkJggg==',
      ].join('');
      const bytes = Uint8Array.from(atob(rasterBase64), (character) => character.charCodeAt(0));
      const pngSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (byte) => byte.toString(16).padStart(2, '0')).join('');
      window.postMessage({
        type: 'drey:inert-inscription-preview', protocolVersion: 1,
        inscriptionId: `${'a'.repeat(64)}i0`, rasterBase64, pngSha256, pngWidth: 1, pngHeight: 1,
      }, '*');
    });
    await expect(page.getByRole('img', { name: `Inert preview for inscription ${'a'.repeat(64)}i0` }))
      .toBeVisible();
    expect(remoteRequests).toEqual([]);

    await page.reload();
    await expect(page.getByRole('img')).toHaveCount(0);
    await page.evaluate(() => {
      const rasterBase64 = [
        'iVBORw0KGgoAAAA', 'NSUhEUgAAAAEAAA', 'ABCAYAAAAfFcSJ', 'AAAADUlEQVR42mNk',
        '+M/wHwAEAQH/2b', 'zqWQAAAABJRU5E', 'rkJggg==',
      ].join('');
      window.postMessage({
        type: 'drey:inert-inscription-preview', protocolVersion: 1,
        inscriptionId: `${'a'.repeat(64)}i0`, rasterBase64, pngSha256: '0'.repeat(64),
        pngWidth: 1, pngHeight: 1,
      }, '*');
    });
    await expect(page.getByRole('img')).toHaveCount(0);
    const persisted = await page.evaluate(() => {
      try { return window.localStorage.getItem('m9p'); } catch { return null; }
    });
    expect(persisted).toBeNull();
  } finally {
    extensionContext.off('request', inspectRequest);
    await page.close();
  }
});

test('@gallery isolates verified media in an opaque, storage-free, networkless sandbox', async ({
  extensionContext, extensionId,
}) => {
  const page = await extensionContext.newPage();
  const remoteRequests: string[] = [];
  const inspectRequest = (request: { url(): string }): void => {
    const url = request.url();
    if (!url.startsWith(`chrome-extension://${extensionId}/`) && !url.startsWith('blob:null/')) {
      remoteRequests.push(url);
    }
  };
  extensionContext.on('request', inspectRequest);
  try {
    await page.goto(`chrome-extension://${extensionId}/inscription-media.html`);
    const isolation = await page.evaluate(async () => {
      let storage = 'available';
      try { window.localStorage.setItem('gallery', 'forbidden'); } catch { storage = 'blocked'; }
      let networking = 'available';
      try { await fetch('https://example.com/gallery-must-not-load'); } catch { networking = 'blocked'; }
      return {
        origin: window.origin,
        extensionRuntime: typeof globalThis.chrome !== 'undefined' && Boolean(globalThis.chrome.runtime),
        opener: window.opener,
        provider: 'drey' in window,
        storage,
        networking,
      };
    });
    expect(isolation).toEqual({
      origin: 'null', extensionRuntime: false, opener: null, provider: false,
      storage: 'blocked', networking: 'blocked',
    });

    await page.evaluate(async () => {
      const bytes = new TextEncoder().encode('verified plain-text inscription');
      const contentSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (byte) => byte.toString(16).padStart(2, '0')).join('');
      const bytesBase64 = btoa(String.fromCharCode(...bytes));
      window.postMessage({
        type: 'drey:verified-inscription-media',
        protocolVersion: 1,
        inscriptionId: `${'b'.repeat(64)}i1`,
        contentType: 'text/plain',
        contentSha256,
        contentByteLength: bytes.length,
        bytesBase64,
      }, '*');
    });
    await expect(page.getByText('verified plain-text inscription')).toBeVisible();
    expect(remoteRequests).toEqual([]);

    for (const candidate of [
      {
        contentType: 'image/webp',
        bytesBase64: 'UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoCAAEAAUAmJaACdLoB+AADsAD+6Wkf+uA/OA/OA/mW//NgQM0PnQAA',
      },
      {
        contentType: 'image/gif',
        bytesBase64: 'R0lGODlhAgABAIAAAExpcTN33SH5BAUAAAAALAAAAAACAAEAAAICTAoAOw==',
      },
    ]) {
      await page.evaluate(async (media) => {
        const bytes = Uint8Array.from(
          atob(media.bytesBase64),
          (character) => character.charCodeAt(0),
        );
        const contentSha256 = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
          (byte) => byte.toString(16).padStart(2, '0'),
        ).join('');
        window.postMessage({
          type: 'drey:verified-inscription-media',
          protocolVersion: 1,
          inscriptionId: `${'b'.repeat(64)}i1`,
          contentType: media.contentType,
          contentSha256,
          contentByteLength: bytes.length,
          bytesBase64: media.bytesBase64,
        }, '*');
      }, candidate);
      await expect(page.getByRole('img', {
        name: `Verified media for inscription ${'b'.repeat(64)}i1`,
      })).toBeVisible();
      expect(remoteRequests).toEqual([]);
    }

    await page.reload();
    await expect(page.locator('pre')).toHaveCount(0);
    await page.evaluate(() => {
      const bytes = new TextEncoder().encode('<script>attack()</script>');
      window.postMessage({
        type: 'drey:verified-inscription-media',
        protocolVersion: 1,
        inscriptionId: `${'b'.repeat(64)}i1`,
        contentType: 'text/html',
        contentSha256: '0'.repeat(64),
        contentByteLength: bytes.length,
        bytesBase64: btoa(String.fromCharCode(...bytes)),
      }, '*');
    });
    await expect(page.locator('img, audio, video, pre')).toHaveCount(0);
    expect(remoteRequests).toEqual([]);
  } finally {
    extensionContext.off('request', inspectRequest);
    await page.close();
  }
});
