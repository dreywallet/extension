import { defineContentScript } from 'wxt/utils/define-content-script';
import { createDreyProvider, createWindowProviderTransport, type DreyProvider } from '../provider/facade';
import { registerProviderDiscovery, type ProviderDiscoveryWindow } from '../provider/discovery';

type ProviderWindow = Window & ProviderDiscoveryWindow & {
  drey?: DreyProvider;
};

export default defineContentScript({
  matches: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
  allFrames: true,
  runAt: 'document_start',
  world: 'MAIN',
  noScriptStartedPostMessage: true,
  main() {
    const providerWindow = window as ProviderWindow;
    // Never overwrite a value installed by the page or another wallet. The
    // static facade advertises method names only and contains no account data.
    if (Object.prototype.hasOwnProperty.call(providerWindow, 'drey')) return;
    const transport = createWindowProviderTransport(window, window.location.origin);
    const provider = createDreyProvider(transport);
    Object.defineProperty(providerWindow, 'drey', {
      value: provider,
      configurable: false,
      enumerable: true,
      writable: false,
    });
    // Do not claim generic or another wallet's legacy namespace. Those APIs
    // have different contracts; truthful discovery points consumers to drey.
    registerProviderDiscovery(providerWindow, provider);
    window.dispatchEvent(new Event('drey#initialized'));
  },
});
