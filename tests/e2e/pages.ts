import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';

export async function fillPrivate(locator: Locator, value: string): Promise<void> {
  // Playwright's normal fill step records its value in the HTML report. Drive
  // React through the native setter so disposable phrases/passwords never
  // enter reporter metadata (secret-safe projects also disable media/traces).
  await locator.evaluate((element, nextValue) => {
    if (!(element instanceof HTMLInputElement)) throw new Error('Private field is not an input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Native input value setter is unavailable');
    setter.call(element, nextValue);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

export class ExtensionPage {
  constructor(
    readonly page: Page,
    readonly context: BrowserContext,
    readonly extensionId: string,
  ) {}

  url(pathname: string): string {
    return `chrome-extension://${this.extensionId}/${pathname.replace(/^\//u, '')}`;
  }

  async goto(pathname: string): Promise<void> {
    await this.page.goto(this.url(pathname));
  }
}

export class PopupPage {
  constructor(readonly extension: ExtensionPage) {}

  get page(): Page { return this.extension.page; }

  async open(): Promise<void> {
    await this.extension.goto('popup.html');
  }

  async lock(): Promise<void> {
    await this.page.getByRole('button', { name: 'Lock' }).click();
    await expect(this.page.getByRole('heading', { name: 'Unlock Drey' })).toBeVisible();
  }

  async unlock(password: string): Promise<void> {
    await fillPrivate(this.page.getByLabel('App password'), password);
    await this.page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(this.page.getByRole('button', { name: 'Lock' })).toBeVisible();
  }
}

export class OnboardingPage {
  constructor(readonly extension: ExtensionPage) {}

  get page(): Page { return this.extension.page; }

  async open(): Promise<void> {
    await this.extension.goto('onboarding.html');
    await expect(this.page.getByRole('heading', { name: 'Welcome to Drey' })).toBeVisible();
  }

  private async skipOptionalPasskeyOffer(): Promise<void> {
    const offer = this.page.getByRole('heading', { name: 'Unlock faster with a passkey' });
    const ready = this.page.getByRole('heading', { name: 'Your wallet is ready' });
    const offered = await Promise.race([
      offer.waitFor({ state: 'visible' }).then(() => true),
      ready.waitFor({ state: 'visible' }).then(() => false),
    ]);
    if (offered) {
      await this.page.getByRole('button', { name: 'Not now' }).click();
    }
  }

  async restorePublicFixture(args: {
    mnemonic: string;
    password: string;
    name?: string;
    passphrase?: string;
  }): Promise<void> {
    await this.beginRestorePublicFixture(args);
    await this.finishRestoreScan();
  }

  async beginRestorePublicFixture(args: {
    mnemonic: string;
    password: string;
    name?: string;
    passphrase?: string;
  }): Promise<void> {
    await this.page.getByRole('button', { name: /Restore a wallet/u }).click();
    await fillPrivate(this.page.getByLabel('Word 1', { exact: true }), args.mnemonic);
    if (args.passphrase !== undefined) {
      await this.page.getByText('BIP39 passphrase (advanced, optional)').click();
      await fillPrivate(this.page.getByLabel('Passphrase', { exact: true }), args.passphrase);
    }
    await this.page.getByRole('button', { name: 'Continue' }).click();
    await this.page.getByLabel('Wallet name').fill(args.name ?? 'Public signet fixture');
    await fillPrivate(this.page.getByLabel('App password', { exact: true }), args.password);
    const confirmation = this.page.getByLabel('Confirm app password');
    if (await confirmation.count() > 0) await fillPrivate(confirmation, args.password);
    await this.page.getByRole('button', { name: 'Continue' }).click();
    await expect(this.page.getByRole('heading', { name: 'Account scan' })).toBeVisible();
  }

  async finishRestoreScan(timeout = 45_000): Promise<void> {
    await expect(this.page.getByText('Scan complete.')).toBeVisible({ timeout });
    await this.page.getByRole('button', { name: 'Continue' }).click();
    await this.skipOptionalPasskeyOffer();
    await expect(this.page.getByRole('heading', { name: 'Your wallet is ready' })).toBeVisible();
  }

  async createDisposable(args: {
    password: string;
    name?: string;
    reviewPhrase?: boolean;
  }): Promise<void> {
    await this.page.getByRole('button', { name: /Create a new wallet/u }).click();
    await this.page.getByLabel('Wallet name').fill(args.name ?? 'Disposable E2E wallet');
    await fillPrivate(this.page.getByLabel('App password', { exact: true }), args.password);
    await fillPrivate(this.page.getByLabel('Confirm app password'), args.password);
    await this.page.getByRole('button', { name: 'Continue' }).click();
    await expect(this.page.getByRole('heading', { name: 'Write down your recovery phrase' })).toBeVisible();

    // Keep the freshly generated phrase in this stack frame only. It is never
    // logged, attached, returned, or persisted in a browser profile.
    const words = await this.page.locator('ol li').evaluateAll((items) =>
      items.map((item) => (item.textContent ?? '').replace(/^\s*\d+\s*/u, '').trim()),
    );
    await this.page.getByRole('button', { name: 'I wrote the words down' }).click();
    if (args.reviewPhrase === true) {
      await expect(this.page.getByRole('heading', { name: 'Confirm your recovery phrase' }))
        .toBeVisible();
      await this.page.getByRole('button', { name: 'Review recovery phrase' }).click();
      await expect(this.page.locator('input[type="text"]')).toHaveCount(0);
      await expect(this.page.locator('ol li')).toHaveCount(0);
      await fillPrivate(this.page.getByLabel('App password'), args.password);
      await this.page.getByRole('button', { name: 'Reveal' }).click();
      await expect(this.page.getByRole('heading', { name: 'Write down your recovery phrase' }))
        .toBeVisible();
      await this.page.getByRole('button', { name: 'I wrote the words down' }).click();
    }
    const verification = this.page.locator('input[type="text"]');
    const count = await verification.count();
    for (let index = 0; index < count; index += 1) {
      const input = verification.nth(index);
      const label = await input.getAttribute('aria-label') ?? await input.evaluate((node) => {
        const id = node.getAttribute('id');
        return id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent ?? '' : '';
      });
      const position = Number(/#(\d+)/u.exec(label)?.[1]);
      if (!Number.isInteger(position) || !words[position - 1]) {
        throw new Error(`Could not resolve backup verification position from ${JSON.stringify(label)}`);
      }
      await fillPrivate(input, words[position - 1]!);
    }
    words.fill('');
    await this.page.getByRole('button', { name: 'Verify' }).click();
    await this.skipOptionalPasskeyOffer();
    await expect(this.page.getByRole('heading', { name: 'Your wallet is ready' })).toBeVisible();
  }
}

export class ApprovalPage {
  constructor(readonly page: Page) {}

  async expectMethod(method: string): Promise<void> {
    const titles: Record<string, string> = {
      wallet_connect: 'Connect this site?',
      wallet_requestPermissions: 'Share wallet information?',
      signMessage: 'Sign this message?',
      signPsbt: 'Sign this transaction?',
      sendTransfer: 'Send bitcoin?',
      ord_sendInscriptions: 'Send this inscription?',
    };
    await expect(this.page.getByRole('heading', { name: titles[method] ?? 'Review site request' })).toBeVisible();
  }

  async reject(): Promise<void> {
    try {
      await this.page.getByTestId('approval-reject').click();
    } catch (error) {
      if (!this.page.isClosed()) throw error;
    }
  }

  async approve(options: {
    password?: string;
    confirmation?: string;
    previewUnavailableAcknowledged?: boolean;
  } = {}): Promise<void> {
    if (options.password) {
      const password = this.page.getByLabel('App password');
      if (await password.count() > 0) await fillPrivate(password, options.password);
    }
    if (options.confirmation) await this.page.getByLabel(new RegExp(options.confirmation, 'u')).fill(options.confirmation);
    if (options.previewUnavailableAcknowledged) {
      await this.page.getByLabel(/verified the inscription identifier and transaction effects/iu).check();
    }
    // Identified by test id, not by copy: the approval action's label is
    // method-specific ("Connect", "Sign transaction", "Sign and send"), so a
    // name selector here would break every time that copy is improved — which
    // is exactly what happened. tests/ui/approval.test.tsx asserts the labels.
    try {
      await this.page.getByTestId('approval-approve').click();
    } catch (error) {
      if (!this.page.isClosed()) throw error;
    }
  }
}

export class DappPage {
  constructor(readonly page: Page, readonly context: BrowserContext) {}

  async open(): Promise<void> {
    await this.page.goto('http://127.0.0.1:4173/');
    await expect.poll(() => this.page.evaluate(() => Boolean((window as Window & { drey?: unknown }).drey)))
      .toBe(true);
  }

  async invoke(button: string): Promise<void> {
    await this.page.getByRole('button', { name: button, exact: true }).click();
  }

  async invokeWithApproval(button: string): Promise<ApprovalPage> {
    const existingPages = new Set(this.context.pages());
    const popupPromise = this.context.waitForEvent('page', {
      // Chrome emits the page event while windows.create is still at
      // about:blank, before the extension URL commits.
      predicate: (candidate) => !existingPages.has(candidate),
      timeout: 10_000,
    });
    await this.invoke(button);
    let approval: Page;
    try {
      approval = await popupPromise;
    } catch (cause) {
      const output = await this.output().textContent();
      let safeDetail = 'no provider error was returned';
      try {
        const parsed = JSON.parse(output ?? '') as { error?: { code?: unknown; message?: unknown } };
        if (parsed.error) {
          safeDetail = `provider error ${String(parsed.error.code)}: ${String(parsed.error.message)}`;
        }
      } catch {
        // Never include a successful provider response: it may contain wallet data.
      }
      throw new Error(`Approval window did not open; ${safeDetail}`, { cause });
    }
    await approval.waitForURL((url) => url.pathname.endsWith('/approval.html'), { timeout: 10_000 });
    await approval.waitForLoadState('domcontentloaded');
    return new ApprovalPage(approval);
  }

  output(): Locator {
    return this.page.locator('#output');
  }
}
