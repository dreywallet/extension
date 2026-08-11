import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const extension = fileURLToPath(new URL('..', import.meta.url));
const workspace = fileURLToPath(new URL('../..', import.meta.url));
const gateway = fileURLToPath(new URL('../../gateway', import.meta.url));

function run(command, args, cwd, options = {}) {
  process.stdout.write(`\n> ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: options.env ?? process.env,
  });
  if (result.error) throw result.error;
  if (options.expectFailure) {
    if (result.status === 0) throw new Error(`${command} ${args.join(' ')} unexpectedly succeeded`);
    return;
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const script of ['test', 'typecheck', 'lint']) run('pnpm', [script], gateway);
for (const script of ['test', 'typecheck', 'lint', 'build']) {
  run('pnpm', [script], extension);
}
const channelSource = readFileSync(
  new URL('../src/build/channel.ts', import.meta.url),
  'utf8',
);
const productionPackagingEnabled =
  /export const PRODUCTION_PACKAGING_ENABLED = true;/u.test(channelSource);
run('pnpm', ['zip'], extension, { expectFailure: !productionPackagingEnabled });
run('pnpm', ['audit:production'], extension, {
  expectFailure: !productionPackagingEnabled,
});
run('pnpm', ['build:test'], extension);
run('pnpm', ['audit:test'], extension);
run('pnpm', ['test:e2e'], extension);
run('pnpm', ['audit:e2e-artifacts'], extension);
run(process.execPath, ['../scripts/check-agent-instructions.mjs'], extension);

// A local preview without the three external public values must fail closed.
const previewEnvironment = { ...process.env };
delete previewEnvironment['DREY_PREVIEW_GATEWAY_ORIGIN'];
delete previewEnvironment['DREY_PREVIEW_GATEWAY_PUBLIC_KEY_HEX'];
delete previewEnvironment['DREY_PREVIEW_MANIFEST_PUBLIC_KEY'];
run('pnpm', ['build:preview'], extension, { env: previewEnvironment, expectFailure: true });
run('pnpm', ['test:preview-package'], extension);

run('git', ['diff', '--check'], workspace);
run('git', ['diff', '--check'], extension);
run('git', ['diff', '--check'], gateway);
console.log(
  `\nM8T local CI gate passed. Preview remains correctly blocked on external values; ` +
  `production packaging is ${productionPackagingEnabled ? 'enabled and audited' : 'fail-closed on its public identity/source gate'}.`,
);
