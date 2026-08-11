import { describe, expect, it } from 'vitest';
import {
  deriveTrustedExtensionContext,
  isExpectedApprovalPort,
  parseProviderAuthority,
  providerSessionIdentityChanged,
  type RuntimeMessageSenderLike,
} from '../../src/provider/authority';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const sender = (overrides: Partial<RuntimeMessageSenderLike> = {}): RuntimeMessageSenderLike => ({
  id: EXTENSION_ID,
  tab: { id: 7, url: 'https://app.example/' },
  frameId: 3,
  url: 'https://wallet.example/path?x=1',
  origin: 'https://wallet.example',
  documentId: '00000000-0000-4000-8000-000000000001',
  documentLifecycle: 'active',
  ...overrides,
});

describe('provider MessageSender authority', () => {
  it('derives normalized origin/tab/frame/document exclusively from the sender', () => {
    expect(parseProviderAuthority(sender(), EXTENSION_ID)).toEqual({
      ok: true,
      authority: {
        origin: 'https://wallet.example',
        tabId: 7,
        frameId: 3,
        documentId: '00000000-0000-4000-8000-000000000001',
        url: 'https://wallet.example/path?x=1',
      },
    });
  });

  it('accepts Chromium\'s compact 128-bit document ID representation', () => {
    const compactId = '0123456789abcdef0123456789abcdef';
    expect(parseProviderAuthority(sender({ documentId: compactId }), EXTENSION_ID)).toMatchObject({
      ok: true,
      authority: { documentId: compactId },
    });
  });

  it('rejects missing or mismatched authority metadata', () => {
    const missingTab = sender();
    delete missingTab.tab;
    const missingFrame = sender();
    delete missingFrame.frameId;
    const missingDocument = sender();
    delete missingDocument.documentId;
    const missingLifecycle = sender();
    delete missingLifecycle.documentLifecycle;
    expect(parseProviderAuthority(sender({ id: 'other' }), EXTENSION_ID)).toMatchObject({ ok: false });
    expect(parseProviderAuthority(missingTab, EXTENSION_ID)).toMatchObject({ ok: false });
    expect(parseProviderAuthority(missingFrame, EXTENSION_ID)).toMatchObject({ ok: false });
    expect(parseProviderAuthority(missingDocument, EXTENSION_ID)).toEqual({
      ok: false,
      reason: 'invalid_document',
    });
    expect(parseProviderAuthority(missingLifecycle, EXTENSION_ID)).toEqual({
      ok: false,
      reason: 'inactive_document',
    });
    expect(parseProviderAuthority(sender({ origin: 'https://evil.example' }), EXTENSION_ID)).toEqual({
      ok: false,
      reason: 'origin_mismatch',
    });
    expect(parseProviderAuthority(sender({ origin: 'https://wallet.example:443' }), EXTENSION_ID)).toEqual({
      ok: false,
      reason: 'origin_mismatch',
    });
    expect(parseProviderAuthority(sender({ documentId: '' }), EXTENSION_ID)).toEqual({
      ok: false,
      reason: 'invalid_document',
    });
    expect(parseProviderAuthority(sender({ documentLifecycle: 'prerender' }), EXTENSION_ID)).toEqual({
      ok: false,
      reason: 'inactive_document',
    });
  });

  it('rejects extension, file, opaque, and browser-internal schemes', () => {
    for (const value of [
      { url: `chrome-extension://${EXTENSION_ID}/popup.html`, origin: `chrome-extension://${EXTENSION_ID}` },
      { url: 'file:///tmp/a.html', origin: 'file://' },
      { url: 'about:blank', origin: 'null' },
      { url: 'chrome://settings', origin: 'chrome://settings' },
    ]) {
      expect(parseProviderAuthority(sender(value), EXTENSION_ID)).toMatchObject({ ok: false });
    }
  });
});

describe('trusted extension context authority', () => {
  it.each([
    ['/popup.html', 'popup'],
    ['/sidepanel.html', 'sidepanel'],
    ['/fullpage.html', 'fullpage'],
    ['/onboarding.html', 'onboarding'],
    ['/approval.html', 'approval'],
  ] as const)('derives %s as %s', (path, context) => {
    expect(
      deriveTrustedExtensionContext(
        {
          id: EXTENSION_ID,
          url: `chrome-extension://${EXTENSION_ID}${path}#/route`,
          origin: `chrome-extension://${EXTENSION_ID}`,
        },
        EXTENSION_ID,
      ),
    ).toBe(context);
  });

  it('rejects unknown pages, wrong extensions, and origin disagreement', () => {
    expect(
      deriveTrustedExtensionContext(
        { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/popup.html`, origin: 'https://evil.example' },
        EXTENSION_ID,
      ),
    ).toBeNull();
    expect(
      deriveTrustedExtensionContext({ id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/unknown.html` }, EXTENSION_ID),
    ).toBeNull();
    expect(
      deriveTrustedExtensionContext({ id: 'other', url: `chrome-extension://${EXTENSION_ID}/approval.html` }, EXTENSION_ID),
    ).toBeNull();
  });
});

describe('approval and session authority', () => {
  const approvalSender: RuntimeMessageSenderLike = {
    id: EXTENSION_ID,
    origin: `chrome-extension://${EXTENSION_ID}`,
    url: `chrome-extension://${EXTENSION_ID}/approval.html`,
    tab: {
      id: 41,
      windowId: 17,
      url: `chrome-extension://${EXTENSION_ID}/approval.html`,
    },
  };

  it('accepts approval commands only from the exact created popup window and tab', () => {
    expect(isExpectedApprovalPort(approvalSender, EXTENSION_ID, 17, 41)).toBe(true);
    expect(isExpectedApprovalPort(approvalSender, EXTENSION_ID, 18, 41)).toBe(false);
    expect(isExpectedApprovalPort(approvalSender, EXTENSION_ID, 17, 42)).toBe(false);
    expect(isExpectedApprovalPort(approvalSender, EXTENSION_ID, null, null)).toBe(false);
    expect(isExpectedApprovalPort({
      ...approvalSender,
      tab: { ...approvalSender.tab, url: undefined },
    }, EXTENSION_ID, 17, 41)).toBe(false);
    expect(isExpectedApprovalPort(
      {
        ...approvalSender,
        tab: {
          ...approvalSender.tab,
          url: `chrome-extension://${EXTENSION_ID}/fullpage.html`,
        },
      },
      EXTENSION_ID,
      17,
      41,
    )).toBe(false);
  });

  it('distinguishes initialization/unlock-after-lock from a live session switch', () => {
    expect(providerSessionIdentityChanged(null, 'vault-a:session-a')).toBe(false);
    expect(providerSessionIdentityChanged('vault-a:session-a', 'vault-a:session-a')).toBe(false);
    expect(providerSessionIdentityChanged('vault-a:session-a', 'vault-a:session-b')).toBe(true);
    expect(providerSessionIdentityChanged('vault-a:session-a', 'vault-b:session-c')).toBe(true);
    expect(providerSessionIdentityChanged('vault-a:session-a', null)).toBe(true);
  });
});
