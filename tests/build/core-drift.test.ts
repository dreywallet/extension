/**
 * Core drift guard (ADR 0005): the extension must consume @drey/core by an
 * exact reviewed git tag, the resolved package must be that version, and the
 * sibling core/ checkout — when present — must sit cleanly on the same tag,
 * with the lockfile's resolved commit being exactly that tag's commit.
 * Catches a committed link:/branch pin, a stale or off-tag pnpm-lock
 * resolution, and local core edits that never made it into a tagged release.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const extensionRoot = resolve(import.meta.dirname, '..', '..');
const coreCheckout = resolve(extensionRoot, process.env.CORE_REPO ?? '../core');
const hasSiblingCore = existsSync(join(coreCheckout, 'package.json'));

const PIN_PATTERN = /^git\+https:\/\/github\.com\/dreywallet\/core\.git#(v\d+\.\d+\.\d+)$/;

function pinnedSpec(): string {
  const manifest = JSON.parse(readFileSync(join(extensionRoot, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  return manifest.dependencies['@drey/core'] ?? '';
}

function git(args: readonly string[]): string {
  return execFileSync('git', ['-C', coreCheckout, ...args], { encoding: 'utf8' }).trim();
}

function lockfileResolvedCommit(): string | undefined {
  const lock = readFileSync(join(extensionRoot, 'pnpm-lock.yaml'), 'utf8');
  return /@drey\/core@git\+https:\/\/github\.com\/dreywallet\/core\.git#([0-9a-f]{40})/.exec(lock)?.[1];
}

describe('@drey/core drift guard', () => {
  it('pins core by exact git tag — never link:, a branch, or a bare commit', () => {
    expect(pinnedSpec()).toMatch(PIN_PATTERN);
  });

  it('an explicitly configured CORE_REPO must exist — never silently skip the sibling checks', () => {
    if (process.env.CORE_REPO) {
      expect(hasSiblingCore, `CORE_REPO=${process.env.CORE_REPO} does not contain a core checkout`).toBe(true);
    }
  });

  it('resolves the installed core package to exactly the pinned version', () => {
    const tag = PIN_PATTERN.exec(pinnedSpec())?.[1];
    expect(tag).toBeDefined();
    const require = createRequire(import.meta.url);
    const installed = JSON.parse(
      readFileSync(require.resolve('@drey/core/package.json'), 'utf8'),
    ) as { version: string };
    expect(`v${installed.version}`).toBe(tag);
  });

  it.skipIf(!hasSiblingCore)('sibling core worktree is clean', () => {
    expect(git(['status', '--porcelain']), 'core worktree is dirty — commit, tag, and bump the pin').toBe('');
  });

  it.skipIf(!hasSiblingCore)('sibling core HEAD is exactly the pinned tag', () => {
    const tag = PIN_PATTERN.exec(pinnedSpec())?.[1];
    expect(tag).toBeDefined();
    let headTag = '';
    try {
      headTag = git(['describe', '--tags', '--exact-match', 'HEAD']);
    } catch {
      // no exact tag at HEAD → fails below with a clear message
    }
    expect(headTag, 'sibling core HEAD is not the pinned tag — tag a release and bump the pin').toBe(tag);
  });

  it.skipIf(!hasSiblingCore)('lockfile resolves core to exactly the pinned tag commit', () => {
    // Version agreement alone is spoofable: a different commit can still
    // declare the pinned version. Bind the lockfile's resolved SHA to the
    // commit the tag actually points at.
    const tag = PIN_PATTERN.exec(pinnedSpec())?.[1];
    expect(tag).toBeDefined();
    const resolved = lockfileResolvedCommit();
    expect(resolved, 'pnpm-lock.yaml has no git resolution for @drey/core').toBeDefined();
    expect(resolved, 'lockfile resolves core to a commit that is not the pinned tag — reinstall from the tag').toBe(
      git(['rev-parse', `${tag}^{commit}`]),
    );
  });

  it('duplicated Trezor BIP39 fixture stays byte-identical to the installed core copy', () => {
    // tests/fixtures/bip39-trezor-vectors.json is deliberately duplicated for
    // the Playwright specs (public third-party data); it must mirror core's.
    const require = createRequire(import.meta.url);
    const ours = readFileSync(join(extensionRoot, 'tests', 'fixtures', 'bip39-trezor-vectors.json'));
    const theirs = readFileSync(require.resolve('@drey/core/fixtures/bip39-trezor-vectors.json'));
    expect(ours.equals(theirs), 'extension Trezor fixture drifted from core — re-copy it from core').toBe(true);
  });
});
