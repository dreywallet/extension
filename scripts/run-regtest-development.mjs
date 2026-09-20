import { readRegtestProject, selectRegtestProject } from './lib/regtest-project.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const selection = selectRegtestProject(process.argv.slice(2), process.env.DREY_REGTEST_PROJECT);
const stateRoot = fileURLToPath(new URL('../../gateway/regtest/.state', import.meta.url));
const configuration = readRegtestProject(stateRoot, selection.project);
if (selection.args.some((argument) => argument === '--mode' || argument.startsWith('--mode='))) {
  throw new Error('the regtest development runner owns the WXT build mode');
}
const result = spawnSync('wxt', [...selection.args, '--mode', 'development'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DREY_REGTEST_PROJECT: configuration.project,
    DREY_REGTEST_GATEWAY_PUBLIC_KEY_HEX: configuration.publicKey,
    DREY_REGTEST_GATEWAY_PORT: configuration.gatewayPort,
    DREY_REGTEST_ORD_PORT: configuration.ordPort,
  },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
