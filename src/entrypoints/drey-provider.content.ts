import { defineContentScript } from 'wxt/utils/define-content-script';
import {
  attachReconnectingIsolatedBridge,
  PROVIDER_PORT_NAME,
  type ProviderRuntimePort,
} from '../provider/bridge';

export default defineContentScript({
  matches: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
  allFrames: true,
  runAt: 'document_start',
  world: 'ISOLATED',
  noScriptStartedPostMessage: true,
  main(ctx) {
    const attach = (): (() => void) => attachReconnectingIsolatedBridge({
        window,
        connectPort: () => chrome.runtime.connect({ name: PROVIDER_PORT_NAME }) as ProviderRuntimePort,
        randomUUID: () => globalThis.crypto.randomUUID(),
        targetOrigin: window.location.origin,
      });
    let stop = attach();

    // WXT reports same-document History API navigation. Rotate the port so all
    // old requests become stale and the new URL receives fresh sender binding.
    ctx.addEventListener(window, 'wxt:locationchange', () => {
      stop();
      stop = attach();
    });
    ctx.onInvalidated(() => stop());
  },
});
