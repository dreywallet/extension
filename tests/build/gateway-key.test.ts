/**
 * The public dev fixture key signs the committed test corpus in @drey/core.
 * It must never appear as this build's hosted production key (spec §18.1) —
 * that would let fixture-signed responses verify against a production build.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coreFixturesDir } from '../helpers/core-fixtures';

const extensionRoot = join(import.meta.dirname, '..', '..');

describe('gateway key hygiene', () => {
  it('never pins the public dev fixture key as the hosted production key', () => {
    const config = readFileSync(join(extensionRoot, 'src', 'build', 'channel.ts'), 'utf8');
    const hosted = /export const PRODUCTION_GATEWAY_PUBLIC_KEY_HEX = '([0-9a-f]*)'/.exec(config);
    expect(hosted, 'PRODUCTION_GATEWAY_PUBLIC_KEY_HEX must exist in channel.ts').not.toBeNull();
    const devKey = (
      JSON.parse(readFileSync(join(coreFixturesDir, 'gateway', 'dev-public-key.json'), 'utf8')) as {
        publicKeyHex: string;
      }
    ).publicKeyHex;
    expect(hosted![1]).not.toBe(devKey);
    // Until the hosted key is provisioned, the sentinel must be empty ('' →
    // fail-closed key_unprovisioned), never some placeholder that could verify.
    expect(hosted![1] === '' || /^[0-9a-f]{64}$/.test(hosted![1]!)).toBe(true);
  });
});
