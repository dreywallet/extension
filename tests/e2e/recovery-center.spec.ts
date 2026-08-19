import { test, expect } from './fixtures';

type Scenario = {
  id: string;
  language: 'en' | 'es';
  accent: 'white' | 'orange' | 'green';
  viewport: { width: number; height: number };
  title: string;
  spendingHeading: string;
  vaultHeading: string;
  primaryAction: string;
  expectedLists: number;
  expectedStates: { ready: number; actionNeeded: number; notChecked: number };
};

const SCENARIOS: readonly Scenario[] = [
  {
    id: 'spending-never-rechecked', language: 'en', accent: 'white',
    viewport: { width: 360, height: 720 }, title: 'Recovery center',
    spendingHeading: 'Spending recovery', vaultHeading: 'Vault protection',
    primaryAction: 'Test complete Spending recovery',
    expectedLists: 1,
    expectedStates: { ready: 1, actionNeeded: 0, notChecked: 2 },
  },
  {
    id: 'spending-healthy', language: 'es', accent: 'orange',
    viewport: { width: 1280, height: 900 }, title: 'Centro de recuperación',
    spendingHeading: 'Recuperación de Gastos', vaultHeading: 'Protección de la Bóveda',
    primaryAction: 'Configurar la Bóveda',
    expectedLists: 1,
    expectedStates: { ready: 3, actionNeeded: 0, notChecked: 0 },
  },
  {
    id: 'vault-partial', language: 'en', accent: 'green',
    viewport: { width: 1280, height: 900 }, title: 'Recovery center',
    spendingHeading: 'Spending recovery', vaultHeading: 'Vault protection',
    primaryAction: 'Save the Recovery Kit',
    expectedLists: 2,
    expectedStates: { ready: 6, actionNeeded: 2, notChecked: 0 },
  },
  {
    id: 'vault-ready', language: 'es', accent: 'white',
    viewport: { width: 360, height: 720 }, title: 'Centro de recuperación',
    spendingHeading: 'Recuperación de Gastos', vaultHeading: 'Protección de la Bóveda',
    primaryAction: 'Abrir la Bóveda',
    expectedLists: 2,
    expectedStates: { ready: 8, actionNeeded: 0, notChecked: 0 },
  },
  {
    id: 'vault-unusable', language: 'en', accent: 'orange',
    viewport: { width: 1280, height: 900 }, title: 'Recovery center',
    spendingHeading: 'Spending recovery', vaultHeading: 'Vault protection',
    primaryAction: 'Review Vault setup',
    expectedLists: 2,
    expectedStates: { ready: 3, actionNeeded: 3, notChecked: 2 },
  },
];

test('renders and captures the safe Recovery Center overview matrix', async ({
  extensionPage, extensionWorker,
}, testInfo) => {
  for (const scenario of SCENARIOS) {
    await test.step(scenario.id, async () => {
    await extensionWorker.evaluate(async (prefs) => {
      await chrome.storage.local.set({
        'squirrel:uiPrefs': {
          language: prefs.language,
          accent: prefs.accent,
          activityUnit: 'sats',
          hidePortfolioAmounts: false,
        },
      });
    }, { language: scenario.language, accent: scenario.accent });
    await extensionPage.page.setViewportSize(scenario.viewport);
    await extensionPage.goto(
      `fullpage.html?dreyRecoveryScenario=${scenario.id}#/settings/recovery`,
    );

    await expect(extensionPage.page.getByRole('heading', { level: 1, name: scenario.title }))
      .toBeVisible();
    await expect(extensionPage.page.getByRole('heading', {
      level: 2, name: scenario.spendingHeading, exact: true,
    })).toBeVisible();
    await expect(extensionPage.page.getByRole('heading', {
      level: 2, name: scenario.vaultHeading, exact: true,
    })).toBeVisible();
    await expect(extensionPage.page.getByRole('button', { name: scenario.primaryAction }))
      .toBeVisible();
    await expect(extensionPage.page.locator('ul')).toHaveCount(scenario.expectedLists);
    await expect(extensionPage.page.locator('li[data-state="ready"]'))
      .toHaveCount(scenario.expectedStates.ready);
    await expect(extensionPage.page.locator('li[data-state="action_needed"]'))
      .toHaveCount(scenario.expectedStates.actionNeeded);
    await expect(extensionPage.page.locator('li[data-state="not_checked"]'))
      .toHaveCount(scenario.expectedStates.notChecked);

    const layout = await extensionPage.page.evaluate(() => ({
      bodyScrollWidth: document.body.scrollWidth,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      h1Count: document.querySelectorAll('h1').length,
      lang: document.documentElement.lang,
      listItemsMissingName: [...document.querySelectorAll('li[data-state]')]
        .filter((item) => !item.getAttribute('aria-label')).length,
      selectedAccent: document.documentElement.dataset['accent'],
    }));
    expect(layout).toMatchObject({
      colorScheme: 'dark',
      h1Count: 1,
      lang: scenario.language,
      listItemsMissingName: 0,
      selectedAccent: scenario.accent,
    });
    expect(layout.documentClientWidth).toBeLessThanOrEqual(scenario.viewport.width);
    expect(layout.documentClientWidth).toBeGreaterThan(0);
    expect(layout.bodyScrollWidth).toBeLessThanOrEqual(layout.documentClientWidth);
    expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.documentClientWidth);

    const primary = extensionPage.page.getByRole('button', { name: scenario.primaryAction });
    await primary.focus();
    await expect(primary).toBeFocused();
    expect(await primary.evaluate((element) => element.matches(':focus-visible'))).toBe(true);

    const showedBusyOverviewDuringRefresh = await extensionPage.page.evaluate(async () => {
      let observed = document.querySelector('[aria-busy="true"]') !== null;
      const observer = new MutationObserver(() => {
        if (document.querySelector('[aria-busy="true"]') !== null) observed = true;
      });
      observer.observe(document.body, { attributes: true, childList: true, subtree: true });
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((resolve) => setTimeout(resolve, 100));
      observer.disconnect();
      return observed;
    });
    expect(showedBusyOverviewDuringRefresh).toBe(false);
    await expect(extensionPage.page.getByRole('heading', {
      level: 2, name: scenario.spendingHeading, exact: true,
    })).toBeVisible();

    await extensionPage.page.screenshot({
      path: testInfo.outputPath(
        `recovery-center-${scenario.id}-${scenario.language}-${scenario.accent}-${scenario.viewport.width}.png`,
      ),
      fullPage: true,
    });
    });
  }
});
