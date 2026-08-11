/**
 * Workstream A2 E2E: passkey enrollment, unlock, rename, and removal against
 * the packaged test-channel build, driven through CDP virtual authenticators
 * (the A0 probe pattern). Only a disposable wallet and synthetic credentials
 * exist here; nothing real is enrolled. Virtual-authenticator results prove
 * Chromium plumbing and the extension's fail-closed behavior — they do NOT
 * stand in for the A0 §6 real-device checklist (Touch ID, Windows Hello,
 * Brave), which remains a separate manual gate before production enablement.
 */
import type { CDPSession, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { fillPrivate } from './pages';

const TEST_PASSWORD = ['public', 'e2e', 'password', 'only'].join('-');
const ENVELOPES_KEY = 'squirrel:passkeyEnvelopes';
const CREDENTIALS_KEY = 'squirrel:passkeyCredentials';

async function addAuthenticator(page: Page, options: { hasPrf: boolean }): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: options.hasPrf,
    },
  });
  return cdp;
}

async function openPasskeySettings(page: Page, extensionId: string): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/fullpage.html#/settings/passkeys`);
  await expect(page.getByRole('heading', { name: 'Passkey unlock' })).toBeVisible();
}

async function enroll(page: Page, label?: string): Promise<void> {
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  if (label !== undefined) await page.getByLabel('Passkey name').fill(label);
  await fillPrivate(page.getByLabel('App password', { exact: true }), TEST_PASSWORD);
  await page.getByRole('button', { name: 'Add a passkey' }).click();
}

test.describe('passkey unlock (virtual authenticator)', () => {
  test('enrolls, unlocks, renames, and removes a passkey end to end', async ({
    onboarding, extensionPage, extensionWorker, extensionId,
  }) => {
    await onboarding.open();
    await onboarding.createDisposable({ password: TEST_PASSWORD });

    const page = extensionPage.page;
    await addAuthenticator(page, { hasPrf: true });

    // The settings entry is visible on the test channel (pinned manifest key).
    await page.goto(`chrome-extension://${extensionId}/fullpage.html#/settings`);
    await page.getByRole('button', { name: 'Passkey unlock' }).click();
    await expect(page.getByRole('heading', { name: 'Passkey unlock' })).toBeVisible();
    await expect(page.getByText('No passkeys are set up for this wallet.')).toBeVisible();

    // Enrollment: password reauth + create + authoritative get() round-trip.
    await enroll(page, 'Virtual key');
    await expect(page.getByText(/Virtual key · Added/u)).toBeVisible();

    // One envelope, schema-valid, persisted only after verification.
    const stored = await extensionWorker.evaluate(
      async (key) => (await chrome.storage.local.get(key))[key] as unknown[],
      ENVELOPES_KEY,
    );
    expect(Array.isArray(stored)).toBe(true);
    expect(stored).toHaveLength(1);
    // A2.1: the bound credential public key persists beside the envelope —
    // it is what the worker verifies every unlock assertion against.
    const boundKeys = await extensionWorker.evaluate(
      async (key) => (await chrome.storage.local.get(key))[key] as unknown[],
      CREDENTIALS_KEY,
    );
    expect(boundKeys).toHaveLength(1);

    // Lock, then unlock through the passkey path (fresh UV assertion).
    await extensionPage.goto('popup.html');
    await page.getByRole('button', { name: 'Lock' }).click();
    await expect(page.getByRole('heading', { name: 'Unlock Drey' })).toBeVisible();
    const passkeyButton = page.getByRole('button', { name: 'Unlock with a passkey' });
    await expect(passkeyButton).toBeVisible();
    // The password path stays rendered as a full peer.
    await expect(page.getByLabel('Password')).toBeVisible();
    await passkeyButton.click();
    // Generous timeout: the post-unlock discovery scan keeps the worker's
    // serialized queue busy, so the session snapshot can lag several seconds.
    await expect(page.getByRole('button', { name: 'Lock', exact: true })).toBeVisible({ timeout: 65_000 });

    // Rename is display-only and must not break later unlocks.
    await openPasskeySettings(page, extensionId);
    await page.getByRole('button', { name: 'Rename' }).click();
    await page.getByLabel('Passkey name').fill('Renamed key');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(/Renamed key · Added/u)).toBeVisible();

    await extensionPage.goto('popup.html');
    await page.getByRole('button', { name: 'Lock' }).click();
    await page.getByRole('button', { name: 'Unlock with a passkey' }).click();
    await expect(page.getByRole('button', { name: 'Lock', exact: true })).toBeVisible({ timeout: 65_000 });

    // Removal requires the password and disables the credential for good.
    await openPasskeySettings(page, extensionId);
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await fillPrivate(page.getByLabel('App password', { exact: true }), TEST_PASSWORD);
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.getByText('Passkey removed.')).toBeVisible();
    await expect(page.getByText('No passkeys are set up for this wallet.')).toBeVisible();

    const remaining = await extensionWorker.evaluate(
      async (key) => (await chrome.storage.local.get(key))[key] as unknown[] | undefined,
      ENVELOPES_KEY,
    );
    expect(remaining ?? []).toHaveLength(0);
    const remainingKeys = await extensionWorker.evaluate(
      async (key) => (await chrome.storage.local.get(key))[key] as unknown[] | undefined,
      CREDENTIALS_KEY,
    );
    expect(remainingKeys ?? []).toHaveLength(0);

    await extensionPage.goto('popup.html');
    await page.getByRole('button', { name: 'Lock' }).click();
    await expect(page.getByRole('heading', { name: 'Unlock Drey' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unlock with a passkey' })).toHaveCount(0);
  });

  test('a PRF-less authenticator aborts enrollment with nothing persisted', async ({
    onboarding, extensionPage, extensionWorker, extensionId,
  }) => {
    await onboarding.open();
    await onboarding.createDisposable({ password: TEST_PASSWORD });

    const page = extensionPage.page;
    await addAuthenticator(page, { hasPrf: false });
    await openPasskeySettings(page, extensionId);
    await enroll(page);
    // A0 §4: the UI names the PRF failure and admits the possible dangling
    // platform-side credential; Drey records nothing.
    await expect(page.getByText(/does not support the required key-derivation/u)).toBeVisible();

    const stored = await extensionWorker.evaluate(
      async (key) => (await chrome.storage.local.get(key))[key] as unknown[] | undefined,
      ENVELOPES_KEY,
    );
    expect(stored ?? []).toHaveLength(0);
  });

  test('a tampered stored envelope is never offered for a ceremony', async ({
    onboarding, extensionPage, extensionWorker, extensionId,
  }) => {
    await onboarding.open();
    await onboarding.createDisposable({ password: TEST_PASSWORD });

    const page = extensionPage.page;
    await addAuthenticator(page, { hasPrf: true });
    await openPasskeySettings(page, extensionId);
    await enroll(page, 'Doomed key');
    await expect(page.getByText(/Doomed key · Added/u)).toBeVisible();

    // Storage-level tamper: bump the version to an unknown value.
    await extensionWorker.evaluate(async (key) => {
      const stored = (await chrome.storage.local.get(key))[key] as Record<string, unknown>[];
      await chrome.storage.local.set({ [key]: stored.map((e) => ({ ...e, version: 2 })) });
    }, ENVELOPES_KEY);

    // Locked surface: fail closed — no passkey button, password path intact.
    await extensionPage.goto('popup.html');
    await page.getByRole('button', { name: 'Lock' }).click();
    await expect(page.getByRole('heading', { name: 'Unlock Drey' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unlock with a passkey' })).toHaveCount(0);

    // Password unlock still works; settings surfaces the unusable record and
    // can purge it with reauthentication.
    await fillPrivate(page.getByLabel('Password'), TEST_PASSWORD);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Lock' })).toBeVisible();
    await openPasskeySettings(page, extensionId);
    await expect(page.getByText(/1 stored passkey record/u)).toBeVisible();
    await page.getByRole('button', { name: 'Remove unusable records' }).click();
    await fillPrivate(page.getByLabel('App password', { exact: true }), TEST_PASSWORD);
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.getByText('Passkey removed.')).toBeVisible();
    const remaining = await extensionWorker.evaluate(
      async (key) => (await chrome.storage.local.get(key))[key] as unknown[] | undefined,
      ENVELOPES_KEY,
    );
    expect(remaining ?? []).toHaveLength(0);
  });
});
