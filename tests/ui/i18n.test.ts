import { describe, expect, it } from 'vitest';
import { CATALOGS, format } from '../../src/ui/i18n';
import { en, type MessageKey } from '../../src/ui/i18n/en';
import { es } from '../../src/ui/i18n/es';
import { passkeyEn } from '../../src/ui/i18n/passkey-en';
import { vaultEn } from '../../src/ui/i18n/vault-en';

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/gu)].map((m) => m[1] ?? '').sort();
}

describe('i18n catalogs', () => {
  it('en and es use identical placeholders per key (§10.4)', () => {
    // Iterate the merged catalog so extension-only keys (passkey-en.ts) are
    // held to the same rule as the portable en.ts keys.
    for (const key of Object.keys(CATALOGS.en) as MessageKey[]) {
      expect(placeholders(CATALOGS.es[key]), key).toEqual(placeholders(CATALOGS.en[key]));
    }
  });

  it('keeps the portable catalogs free of extension-only keys', () => {
    // mobile mirrors en.ts/es.ts byte-for-byte. Passkey unlock has no mobile
    // counterpart at all, so none of its keys may appear there.
    for (const key of Object.keys(en)) {
      expect(key.startsWith('passkey.'), key).toBe(false);
      expect(key, key).not.toBe('settings.passkeys.entry');
    }
    // The Vault splits instead of hiding: shared role/policy/safety vocabulary
    // is portable (ADR 0007 §2 gives mobile role B), while build-channel and
    // coordinator-progress copy is not. Pin the extension-only side by name —
    // a blanket `vault.` prohibition would be wrong now, and silently letting
    // channel copy drift into the shared catalog would ship "signet test"
    // wording to mobile.
    for (const key of ['vault.title', 'vault.banner', 'vault.scope', 'vault.next',
      'vault.error.unavailable', 'vault.role.defaultLabel', 'settings.vault.entry']) {
      expect(key in en, key).toBe(false);
      expect(key in vaultEn, key).toBe(true);
    }
    // ...and the shared side really is shared, not duplicated.
    for (const key of ['vault.intro', 'vault.reveal.body', 'vault.remove.body',
      'vault.role.fingerprint', 'vault.error.notIndependent']) {
      expect(key in en, key).toBe(true);
    }
  });

  it('never lets test-channel wording reach the catalogs mobile mirrors', () => {
    // The concrete hazard of sharing: a "signet test" string copied into
    // en.ts/es.ts would ship that wording in a released mobile build.
    for (const catalog of [en, es]) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(value, key).not.toMatch(/signet|SIGNET|test-only|this build/u);
      }
    }
  });

  it('namespaces every extension-only key so a later shared move is mechanical', () => {
    // Mobile enforces the mirror of this rule on its own extra catalog. The
    // extension had no equivalent assertion before the Vault coordinator; it
    // matters more here than for passkeys, because multisig strings plausibly
    // DO become shared en.ts/es.ts keys once mobile ships role B, and a
    // stray un-namespaced key would collide silently at that point.
    const allowedUnprefixed = new Set(['settings.passkeys.entry', 'settings.vault.entry']);
    for (const [catalog, prefix] of [
      [passkeyEn, 'passkey.'],
      [vaultEn, 'vault.'],
    ] as const) {
      for (const key of Object.keys(catalog)) {
        if (allowedUnprefixed.has(key)) continue;
        expect(key.startsWith(prefix), key).toBe(true);
      }
    }
    // ...and the extension-only catalogs must not shadow each other or en.ts.
    const portable = new Set(Object.keys(en));
    for (const key of [...Object.keys(passkeyEn), ...Object.keys(vaultEn)]) {
      expect(portable.has(key), key).toBe(false);
    }
    for (const key of Object.keys(vaultEn)) {
      expect(key in passkeyEn, key).toBe(false);
    }
  });

  it('every catalog string is non-empty', () => {
    for (const catalog of Object.values(CATALOGS)) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.trim(), key).not.toBe('');
      }
    }
  });

  it('explains Recovery Kit loss and carries both files into the offline check', () => {
    expect(CATALOGS.en['vault.kit.body']).toContain('losing every copy can make recovery impossible');
    expect(CATALOGS.en['vault.kit.body']).toContain('Sharing it reveals every Vault address');
    expect(CATALOGS.es['vault.kit.body']).toContain('perder todas las copias');
    expect(CATALOGS.es['vault.kit.body']).toContain('revela todas las direcciones de la Bóveda');

    for (const key of ['vault.recoveryC.stepBackup', 'vault.recoveryC.backupDownloaded'] as const) {
      expect(CATALOGS.en[key], key).toMatch(/Recovery Kit.*paper-check challenge|paper-check challenge.*Recovery Kit/iu);
      expect(CATALOGS.es[key], key).toMatch(/kit de recuperación.*desafío|desafío.*kit de recuperación/iu);
    }
  });

  it('keeps catalogs structurally identical and removes stale launch promises', () => {
    expect(Object.keys(CATALOGS.es).sort()).toEqual(Object.keys(CATALOGS.en).sort());
    for (const catalog of Object.values(CATALOGS)) {
      const text = Object.values(catalog).join(' ');
      expect(text).not.toMatch(/coming (?:soon|later)|later update|próxima actualización/iu);
    }
    expect(Object.keys(CATALOGS.en)).not.toEqual(expect.arrayContaining([
      'home.send.soon',
      'onboarding.ledger.title',
      'onboarding.ledger.subtitle',
    ]));
  });
});

describe('format', () => {
  it('interpolates named placeholders and leaves unknown ones intact', () => {
    expect(format('Word #{position}', { position: 4 })).toBe('Word #4');
    expect(format('{a} and {b}', { a: 'x' })).toBe('x and {b}');
    expect(format('no params')).toBe('no params');
  });
});
