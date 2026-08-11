/**
 * How a verified inert preview fills its frame.
 *
 * The default letterboxes, which is right for an approval review: cropping
 * artwork you are about to sign away could hide part of what is moving. A
 * browse grid wants the opposite — tiles that fill rather than float in empty
 * space — so it asks for 'cover'.
 *
 * Cover crops the long edge down to the short one, so on an extreme aspect
 * ratio it stops being "slightly cropped" and becomes a meaningless slice of a
 * banner. Grant it only while at most a third of the long edge is hidden, which
 * is exactly a ratio below 1.5. Callers that ask for it render a square tile, so
 * the image's own ratio is what decides.
 */
export const MAX_COVER_RATIO = 1.5;

export function previewObjectFit(
  requested: unknown,
  pngWidth: number,
  pngHeight: number,
): 'cover' | 'contain' {
  if (requested !== 'cover') return 'contain';
  // A zero or NaN dimension divides to Infinity or NaN, and neither is below
  // the threshold, so a degenerate size letterboxes without a special case.
  const ratio = Math.max(pngWidth, pngHeight) / Math.min(pngWidth, pngHeight);
  return ratio < MAX_COVER_RATIO ? 'cover' : 'contain';
}
