/** Runtime-derived provider and extension-page authority (spec §20.1). */
import type { SenderContext } from '@drey/core/messaging/envelope';

export interface RuntimeMessageSenderLike {
  id?: string | undefined;
  tab?: {
    id?: number | undefined;
    windowId?: number | undefined;
    url?: string | undefined;
  } | undefined;
  frameId?: number | undefined;
  url?: string | undefined;
  origin?: string | undefined;
  documentId?: string | undefined;
  documentLifecycle?: string | undefined;
}

export interface ProviderAuthority {
  origin: string;
  tabId: number;
  frameId: number;
  documentId: string;
  url: string;
}

export type AuthorityFailure =
  | 'wrong_extension'
  | 'missing_tab'
  | 'missing_frame'
  | 'missing_url'
  | 'missing_origin'
  | 'unsupported_scheme'
  | 'origin_mismatch'
  | 'invalid_document'
  | 'inactive_document';

export type ParseAuthorityResult =
  | { ok: true; authority: ProviderAuthority }
  | { ok: false; reason: AuthorityFailure };

function isNonnegativeId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// Chrome documents this as a UUID, but current Chromium serializes the same
// 128-bit identifier as 32 hexadecimal characters without hyphens. Accept
// both browser representations while rejecting arbitrary page-controlled IDs.
const DOCUMENT_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;

/**
 * Derive exact page authority only from a content-script Port's MessageSender.
 * Page-declared origins, account fields, icons, and names are never accepted.
 */
export function parseProviderAuthority(
  sender: RuntimeMessageSenderLike | undefined,
  extensionId: string,
): ParseAuthorityResult {
  if (!sender || sender.id !== extensionId) return { ok: false, reason: 'wrong_extension' };
  if (!isNonnegativeId(sender.tab?.id)) return { ok: false, reason: 'missing_tab' };
  if (!isNonnegativeId(sender.frameId)) return { ok: false, reason: 'missing_frame' };
  if (typeof sender.url !== 'string') return { ok: false, reason: 'missing_url' };
  if (typeof sender.origin !== 'string') return { ok: false, reason: 'missing_origin' };

  let url: URL;
  let originUrl: URL;
  try {
    url = new URL(sender.url);
    originUrl = new URL(sender.origin);
  } catch {
    return { ok: false, reason: 'missing_url' };
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') ||
      (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:')) {
    return { ok: false, reason: 'unsupported_scheme' };
  }
  // MessageSender.origin is already a serialized origin. Reject path/query,
  // Unicode/default-port aliases, or any disagreement with sender.url.
  if (originUrl.origin !== sender.origin || url.origin !== sender.origin) {
    return { ok: false, reason: 'origin_mismatch' };
  }
  if (typeof sender.documentId !== 'string' || !DOCUMENT_ID.test(sender.documentId)) {
    return { ok: false, reason: 'invalid_document' };
  }
  if (sender.documentLifecycle !== 'active') {
    return { ok: false, reason: 'inactive_document' };
  }
  return {
    ok: true,
    authority: {
      origin: sender.origin,
      tabId: sender.tab.id,
      frameId: sender.frameId,
      documentId: sender.documentId,
      url: url.href,
    },
  };
}

const EXTENSION_PATH_CONTEXT: Readonly<Record<string, SenderContext>> = Object.freeze({
  '/popup.html': 'popup',
  '/sidepanel.html': 'sidepanel',
  '/fullpage.html': 'fullpage',
  '/onboarding.html': 'onboarding',
  '/approval.html': 'approval',
});

/**
 * Map a trusted extension page to its real context. Callers compare this value
 * with envelope.sender; a popup can no longer claim to be an approval window.
 */
export function deriveTrustedExtensionContext(
  sender: RuntimeMessageSenderLike | undefined,
  extensionId: string,
): SenderContext | null {
  if (!sender || sender.id !== extensionId || typeof sender.url !== 'string') return null;
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'chrome-extension:' || url.hostname !== extensionId) return null;
  if (sender.origin !== undefined && sender.origin !== `chrome-extension://${extensionId}`) return null;
  return EXTENSION_PATH_CONTEXT[url.pathname] ?? null;
}

/**
 * Approval commands are more privileged than ordinary extension-page RPC.
 * Bind their Port to the exact popup window/tab created for the active queue;
 * merely loading approval.html elsewhere is insufficient authority.
 */
export function isExpectedApprovalPort(
  sender: RuntimeMessageSenderLike | undefined,
  extensionId: string,
  expectedWindowId: number | null,
  expectedTabId: number | null,
): boolean {
  if (expectedWindowId === null || expectedTabId === null) return false;
  return (
    deriveTrustedExtensionContext(sender, extensionId) === 'approval' &&
    sender?.tab?.windowId === expectedWindowId &&
    sender.tab.id === expectedTabId &&
    sender.tab.url === sender.url
  );
}

/** A null prior identity is initialization/unlock-after-lock, not a switch. */
export function providerSessionIdentityChanged(
  previous: string | null,
  next: string | null,
): boolean {
  return previous !== null && previous !== next;
}
