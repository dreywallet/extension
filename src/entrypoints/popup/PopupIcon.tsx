import type { ReactNode } from 'react';

export type PopupIconName =
  | 'activity'
  | 'bitcoin'
  | 'expand'
  | 'eye'
  | 'eyeOff'
  | 'imageOff'
  | 'lock'
  | 'ordinals'
  | 'sidePanel'
  | 'settings';

/** Small, dependency-free outline icons used by the compact popup shell. */
export function PopupIcon(props: { name: PopupIconName }): ReactNode {
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

  switch (props.name) {
    case 'sidePanel':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M14 4v16" />
        </svg>
      );
    case 'eye':
      return (
        <svg {...common}>
          <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
          <circle cx="12" cy="12" r="2.5" />
        </svg>
      );
    case 'eyeOff':
      return (
        <svg {...common}>
          <path d="M3 3l18 18M10.6 6.15A8.3 8.3 0 0 1 12 6c6 0 9.5 6 9.5 6a15 15 0 0 1-2.15 2.8M6.25 7.1C3.85 8.85 2.5 12 2.5 12s3.5 6 9.5 6a8.7 8.7 0 0 0 3.05-.55M9.9 9.9a3 3 0 0 0 4.2 4.2" />
        </svg>
      );
    case 'imageOff':
      return (
        <svg {...common}>
          <path d="M3 3l18 18" />
          <path d="M10.5 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 1.5-.68" />
          <path d="M14.5 4H18a2 2 0 0 1 2 2v8.5M7 16l3.5-3.5 2 2 1-1" />
          <circle cx="8.25" cy="8.25" r="1.25" />
        </svg>
      );
    case 'expand':
      return (
        <svg {...common}>
          <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.55v-.1a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4.05 15a1.7 1.7 0 0 0-1.55-1H2.4V10h.1a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.5 4.2l.06.06A1.7 1.7 0 0 0 8.45 4a1.7 1.7 0 0 0 1-1.55V2.4h4.05v.1a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19 8.45a1.7 1.7 0 0 0 1.55 1h.1v4.05h-.1a1.7 1.7 0 0 0-1.15 1.5Z" />
        </svg>
      );
    case 'lock':
      return (
        <svg {...common}>
          <rect x="5" y="10" width="14" height="11" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
        </svg>
      );
    case 'bitcoin':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.25 7.25h4.2a2.35 2.35 0 0 1 0 4.7h-4.2m0 0h4.8a2.4 2.4 0 0 1 0 4.8h-4.8M11 5.5v2m3-2v2M11 16.75v1.75m3-1.75v1.75M9.25 7.25v9.5" />
        </svg>
      );
    case 'ordinals':
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
          <circle cx="8.25" cy="8.25" r="1.25" />
          <path d="m6 17 4-4 2.5 2.5 2.75-4L18 17" />
        </svg>
      );
    case 'activity':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3.5 2M7 3.75 4.75 6M17 3.75 19.25 6" />
        </svg>
      );
  }
}
