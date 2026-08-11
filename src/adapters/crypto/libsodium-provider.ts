/**
 * Extension CryptoProvider implementation (spec §7.2): packaged libsodium
 * WASM behind the platform-free CryptoProvider port. Construction awaits the
 * WASM load; the returned provider is fully synchronous except argon2id,
 * whose Promise shape exists for implementations that run it off-thread.
 */
import type { Argon2idParams } from '@drey/core/domain/vault/record';
import type { CryptoProvider } from '@drey/core/domain/vault/crypto-provider';
import { getSodium, initSodium } from './sodium';

export async function createLibsodiumCryptoProvider(): Promise<CryptoProvider> {
  await initSodium();
  const sodium = getSodium();
  return {
    argon2id(password: Uint8Array, salt: Uint8Array, params: Argon2idParams): Promise<Uint8Array> {
      // libsodium hardcodes parallelism 1; the record schema pins the same,
      // so a record demanding anything else must fail loudly, not silently
      // derive a different key.
      if (params.parallelism !== 1) {
        return Promise.reject(new Error('libsodium argon2id supports only parallelism 1'));
      }
      try {
        return Promise.resolve(
          sodium.crypto_pwhash(
            32,
            password,
            salt,
            params.opsLimit,
            params.memLimitBytes,
            sodium.crypto_pwhash_ALG_ARGON2ID13,
          ),
        );
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
    xchaEncrypt(plaintext, aad, nonce, key) {
      return sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, key);
    },
    xchaDecrypt(box, aad, nonce, key) {
      return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, box, aad, nonce, key);
    },
    sha256(data) {
      return sodium.crypto_hash_sha256(data);
    },
    ed25519Verify(signature, message, publicKey) {
      try {
        return sodium.crypto_sign_verify_detached(signature, message, publicKey);
      } catch {
        return false;
      }
    },
    randomBytes(byteLength) {
      return sodium.randombytes_buf(byteLength);
    },
  };
}
