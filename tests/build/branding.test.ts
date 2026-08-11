import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.ts', '.tsx']);
const LEGACY_BRAND = new RegExp(['s', 'q', 'r', 'l'].join(''), 'iu');

function livingFiles(path: string): string[] {
  const entries = readdirSync(path, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return livingFiles(child);
    return TEXT_EXTENSIONS.has(extname(child)) ? [child] : [];
  });
}

describe('Drey product branding', () => {
  const files = [
    'package.json',
    'README.md',
    'CHANGELOG.md',
    ...livingFiles('docs'),
    ...livingFiles('scripts'),
    ...livingFiles('src'),
  ];

  it('contains no legacy namespace in living product files', () => {
    const violations = files.filter((path) => LEGACY_BRAND.test(readFileSync(path, 'utf8')));
    expect(violations).toEqual([]);
  });
});
