import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const extension = fileURLToPath(new URL('..', import.meta.url));

function run(script) {
  process.stdout.write(`\n> pnpm ${script}\n`);
  const result = spawnSync('pnpm', [script], { cwd: extension, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('ci:m8t');
for (const script of ['fixtures:marketplaces:check', 'test:marketplace-contracts', 'audit:marketplaces']) run(script);
console.log('\nM9 local fixture-backed CI gate passed. Live marketplace interoperability remains release-gated.');
