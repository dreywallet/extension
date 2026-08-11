/**
 * Resolves the signed gateway fixture corpus from the installed @drey/core
 * package (ADR 0005): the fixtures live in core beside the suites that own
 * them, and the extension asserts against exactly the pinned core it ships.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

export const coreRootDir = dirname(require.resolve('@drey/core/package.json'));
export const coreFixturesDir = join(coreRootDir, 'tests', 'fixtures');
