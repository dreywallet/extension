import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const publicKeyPath = fileURLToPath(
  new URL('../../gateway/regtest/.state/response-signing.pub', import.meta.url),
);

let publicKey;
try {
  publicKey = readFileSync(publicKeyPath, 'utf8').trim();
} catch {
  process.stderr.write('Local regtest is not initialized. Run `pnpm regtest:init` from gateway/ first.\n');
  process.exitCode = 1;
}

if (process.exitCode !== 1) {
  if (!/^[0-9a-f]{64}$/u.test(publicKey)) {
    throw new Error('local regtest gateway public key is malformed');
  }
  const wxtArgs = process.argv.slice(2);
  if (wxtArgs.includes('--mode')) {
    throw new Error('the regtest development runner owns the WXT build mode');
  }
  const result = spawnSync('wxt', [...wxtArgs, '--mode', 'development'], {
    stdio: 'inherit',
    env: { ...process.env, DREY_REGTEST_GATEWAY_PUBLIC_KEY_HEX: publicKey },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
