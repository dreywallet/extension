import { describe, expect, it } from 'vitest';
import { previewObjectFit } from '../../src/entrypoints/inscription-preview/fit';

describe('inert preview fill mode', () => {
  it('letterboxes unless a browse grid asks to fill', () => {
    // The approval review never asks, so cropping what you are about to sign
    // away is not reachable from there.
    expect(previewObjectFit(undefined, 100, 100)).toBe('contain');
    expect(previewObjectFit('contain', 100, 100)).toBe('contain');
    expect(previewObjectFit('COVER', 100, 100)).toBe('contain');
  });

  it('fills a square tile for artwork close enough to square', () => {
    expect(previewObjectFit('cover', 512, 512)).toBe('cover');
    expect(previewObjectFit('cover', 512, 384)).toBe('cover');
    expect(previewObjectFit('cover', 384, 512)).toBe('cover');
  });

  it('letterboxes rather than reduce a banner to a slice', () => {
    // Past a third of the long edge, "slightly cropped" becomes meaningless.
    expect(previewObjectFit('cover', 512, 256)).toBe('contain');
    expect(previewObjectFit('cover', 512, 32)).toBe('contain');
    expect(previewObjectFit('cover', 32, 512)).toBe('contain');
  });

  it('holds the third-of-the-long-edge boundary', () => {
    expect(previewObjectFit('cover', 149, 100)).toBe('cover');
    expect(previewObjectFit('cover', 150, 100)).toBe('contain');
  });

  it('letterboxes a degenerate size rather than dividing by zero', () => {
    expect(previewObjectFit('cover', 0, 100)).toBe('contain');
    expect(previewObjectFit('cover', 100, 0)).toBe('contain');
  });
});
