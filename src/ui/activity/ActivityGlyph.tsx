import type { ReactNode } from 'react';

/** Dependency-free asset glyphs shared by every extension activity surface. */
export function ActivityGlyph(props: { name: 'bitcoin' | 'ordinals' }): ReactNode {
  const common = {
    'aria-hidden': true,
    fill: 'none',
    focusable: false,
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 1.8,
    viewBox: '0 0 24 24',
  };
  if (props.name === 'bitcoin') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.25 7.25h4.2a2.35 2.35 0 0 1 0 4.7h-4.2m0 0h4.8a2.4 2.4 0 0 1 0 4.8h-4.8M11 5.5v2m3-2v2M11 16.75v1.75m3-1.75v1.75M9.25 7.25v9.5" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <circle cx="8.25" cy="8.25" r="1.25" />
      <path d="m6 17 4-4 2.5 2.5 2.75-4L18 17" />
    </svg>
  );
}
