/**
 * The standalone recovery package's digests must describe the core revision
 * this extension actually consumes (ADR 0007 §6, Workstream C7).
 *
 * A recovery kit tells its holder: here is the program that can open your
 * Vault without us, and here is the digest to check you have the right one.
 * That is only true while `VAULT_STANDALONE_TOOL_RELEASE` names the same core
 * revision the extension is pinned to. The source digest covers all of
 * `core/src`, so it changes on every core release — including releases that
 * never touch `core/recovery/` — and a routine pin bump would otherwise mint
 * kits pointing at a revision whose digest no longer reproduces, with nothing
 * about the tool looking wrong.
 *
 * The failure this guards against is quiet and it lands in the one document a
 * user is explicitly told to verify against, which is why it is a test rather
 * than a note in a release checklist.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  VAULT_STANDALONE_TOOL_DIGEST_UNPUBLISHED,
  VAULT_STANDALONE_TOOL_RELEASE,
  vaultStandaloneToolPublished,
} from '../../src/background/vault-policy';

const extensionRoot = resolve(import.meta.dirname, '..', '..');
const PIN_PATTERN = /^git\+https:\/\/github\.com\/dreywallet\/core\.git#(v\d+\.\d+\.\d+)$/;

function pinnedCoreTag(): string | undefined {
  const manifest = JSON.parse(readFileSync(join(extensionRoot, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  return PIN_PATTERN.exec(manifest.dependencies['@drey/core'] ?? '')?.[1];
}

describe('standalone recovery package digests', () => {
  it('names exactly the pinned core tag', () => {
    expect(
      VAULT_STANDALONE_TOOL_RELEASE.coreTag,
      'the recovery-kit digests name a different core revision than the extension consumes — ' +
      'rebuild the package at the pinned tag (pnpm recovery:verify in core/), update ' +
      'VAULT_STANDALONE_TOOL_RELEASE, and append the row to core/recovery/RELEASES.md',
    ).toBe(pinnedCoreTag());
  });

  it('carries two distinct, well-formed, non-sentinel digests', () => {
    const { sourceDigest, artifactDigest } = VAULT_STANDALONE_TOOL_RELEASE;
    for (const digest of [sourceDigest, artifactDigest]) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(digest).not.toBe(VAULT_STANDALONE_TOOL_DIGEST_UNPUBLISHED);
    }
    // Two digests over different things. Equal values would mean one had been
    // copied over the other, which no honest build produces.
    expect(sourceDigest).not.toBe(artifactDigest);
  });

  it('reports published from the digests rather than from a hardcoded claim', () => {
    expect(vaultStandaloneToolPublished()).toBe(true);
    // The sentinel must remain exactly 32 zero bytes: kits minted before the
    // first release carry it, and readers must keep accepting those forever.
    expect(VAULT_STANDALONE_TOOL_DIGEST_UNPUBLISHED).toBe('00'.repeat(32));
    expect(VAULT_STANDALONE_TOOL_DIGEST_UNPUBLISHED).toHaveLength(64);
  });

  it('is frozen, so no runtime path can rewrite what a kit claims', () => {
    expect(Object.isFrozen(VAULT_STANDALONE_TOOL_RELEASE)).toBe(true);
  });
});
