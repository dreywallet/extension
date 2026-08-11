/**
 * Shared test bootstrap for the CryptoProvider seam: installs the libsodium
 * provider exactly as the composition root does, so every suite exercises the
 * shipping crypto path. Await it from beforeAll in any suite that touches
 * vault crypto, hashing, signing, or gateway verification.
 */
import { createLibsodiumCryptoProvider } from '../../src/adapters/crypto/libsodium-provider';
import { setCryptoProvider } from '@drey/core/domain/vault/crypto-provider';

export async function installTestCryptoProvider(): Promise<void> {
  setCryptoProvider(await createLibsodiumCryptoProvider());
}
