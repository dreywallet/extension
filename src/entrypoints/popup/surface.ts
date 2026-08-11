export type WalletSurface = 'popup' | 'sidepanel';

export function isPersistentSurface(surface: WalletSurface): boolean {
  return surface === 'sidepanel';
}
