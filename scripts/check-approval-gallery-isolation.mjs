import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const outputRoot = resolve(process.argv[2] ?? '.output/production/chrome-mv3');
const forbiddenFixtures = [
  { marker: 'DREY_APPROVAL_GALLERY_ONLY', path: /approval-gallery/iu, name: 'approval gallery' },
  {
    marker: 'DREY_RECOVERY_CENTER_E2E_ONLY',
    path: /recovery-center-e2e-fixtures/iu,
    name: 'Recovery Center E2E fixture',
  },
  {
    marker: 'dreyRecoveryScenario=',
    path: /$a/u,
    name: 'Recovery Center E2E selector',
  },
];

if (!existsSync(outputRoot) || !statSync(outputRoot).isDirectory()) {
  throw new Error(`extension output does not exist: ${outputRoot}`);
}

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

for (const file of filesBelow(outputRoot)) {
  const relative = file.slice(outputRoot.length);
  const contents = readFileSync(file);
  for (const fixture of forbiddenFixtures) {
    if (fixture.path.test(relative)) {
      throw new Error(`${fixture.name} path leaked into extension output: ${file}`);
    }
    if (contents.includes(fixture.marker)) {
      throw new Error(`${fixture.name} leaked into extension output: ${file}`);
    }
  }
}

console.log('Test-only galleries and presentation fixtures are absent from the extension artifact.');
