// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { parseInscriptionReview } from '../../src/ui/components/InscriptionReview';
import { MediaBadgeTile, TextExcerptTile, formatContentLength } from '../../src/ui/components/PreviewTile';
import { I18nProvider } from '../../src/ui/i18n';

const ID = `${'a'.repeat(64)}i0`;
const TXID = 'a'.repeat(64);

function item(preview: unknown): Record<string, unknown> {
  return {
    inscriptionId: ID,
    number: 7,
    satpoint: `${TXID}:0:0`,
    outpoint: { txid: TXID, vout: 0 },
    movement: 'sent',
    coLocationGroup: 'g1',
    qualifiedPartialAuthorization: false,
    preview,
  };
}

describe('universal preview kinds', () => {
  it('parses signed text excerpts and media badges and rejects malformed ones', () => {
    const text = { kind: 'text', textMime: 'text/plain', excerpt: 'hello', truncated: false };
    const badge = { kind: 'mediaBadge', mediaKind: 'audio', contentLength: 2048 };
    const parsed = parseInscriptionReview([item(text), item(badge)]);
    expect(parsed.valid).toBe(false); // duplicate ids fail closed
    expect(parseInscriptionReview([item(text)]).items[0]?.preview).toEqual(text);
    expect(parseInscriptionReview([item(badge)]).items[0]?.preview).toEqual(badge);
    expect(parseInscriptionReview([item({ ...text, excerpt: '' })]).valid).toBe(false);
    expect(parseInscriptionReview([item({ ...badge, contentLength: -1 })]).valid).toBe(false);
    expect(parseInscriptionReview([item({ kind: 'placeholder', reason: 'render_pending' })])
      .items[0]?.preview).toEqual({ kind: 'placeholder', reason: 'render_pending' });
  });

  it('renders the excerpt as inert text and the badge with a formatted size', () => {
    render(
      <I18nProvider initial="en">
        <TextExcerptTile excerpt={'<script>alert(1)</script>'} truncated={true} />
        <MediaBadgeTile contentLength={3 * 1024 * 1024} mediaKind="video" />
      </I18nProvider>,
    );
    // The excerpt is text content, never markup.
    expect(screen.getByText('<script>alert(1)</script>').tagName).toBe('PRE');
    expect(screen.getByText('Excerpt truncated')).toBeTruthy();
    expect(screen.getByText('Video inscription')).toBeTruthy();
    expect(screen.getByText('3.0 MB')).toBeTruthy();
    expect(formatContentLength(512)).toBe('512 B');
    expect(formatContentLength(2048)).toBe('2.0 KB');
  });
});
