import type { SVGProps } from 'react';

export type WordIconName =
  | 'align-center'
  | 'align-justify'
  | 'align-left'
  | 'align-right'
  | 'arrow-left'
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'cloud-check'
  | 'copy'
  | 'document'
  | 'list-bulleted'
  | 'list-numbered'
  | 'menu'
  | 'more'
  | 'plus'
  | 'redo'
  | 'review'
  | 'send'
  | 'sparkle'
  | 'trash'
  | 'undo'
  | 'x';

export function WordIcon({
  name,
  size = 18,
  ...props
}: { name: WordIconName; size?: number } & SVGProps<SVGSVGElement>) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  switch (name) {
    case 'align-left':
      return (
        <svg {...common} {...props}>
          <path d="M4 6h16M4 10h10M4 14h16M4 18h12" />
        </svg>
      );
    case 'align-center':
      return (
        <svg {...common} {...props}>
          <path d="M4 6h16M7 10h10M4 14h16M6 18h12" />
        </svg>
      );
    case 'align-right':
      return (
        <svg {...common} {...props}>
          <path d="M4 6h16M10 10h10M4 14h16M8 18h12" />
        </svg>
      );
    case 'align-justify':
      return (
        <svg {...common} {...props}>
          <path d="M4 6h16M4 10h16M4 14h16M4 18h16" />
        </svg>
      );
    case 'arrow-left':
      return (
        <svg {...common} {...props}>
          <path d="m15 18-6-6 6-6" />
        </svg>
      );
    case 'check':
      return (
        <svg {...common} {...props}>
          <path d="m5 12 4 4L19 6" />
        </svg>
      );
    case 'chevron-down':
      return (
        <svg {...common} {...props}>
          <path d="m7 10 5 5 5-5" />
        </svg>
      );
    case 'chevron-right':
      return (
        <svg {...common} {...props}>
          <path d="m9 6 6 6-6 6" />
        </svg>
      );
    case 'cloud-check':
      return (
        <svg {...common} {...props}>
          <path d="M5 17a4 4 0 0 1-.5-7.97A7 7 0 0 1 18 8a4.5 4.5 0 0 1 .5 9H5Z" />
          <path d="m9 13 2 2 4-4" />
        </svg>
      );
    case 'copy':
      return (
        <svg {...common} {...props}>
          <rect x="8" y="8" width="11" height="11" rx="2" />
          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
        </svg>
      );
    case 'document':
      return (
        <svg {...common} {...props}>
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M14 3v5h5M9 12h6M9 16h6" />
        </svg>
      );
    case 'menu':
      return (
        <svg {...common} {...props}>
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      );
    case 'list-bulleted':
      return (
        <svg {...common} {...props}>
          <circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" />
          <circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" />
          <path d="M8 6h12M8 12h12M8 18h12" />
        </svg>
      );
    case 'list-numbered':
      return (
        <svg {...common} {...props}>
          <text x="1.8" y="8" fill="currentColor" stroke="none" fontSize="6.5" fontWeight="600">
            1
          </text>
          <text x="1.5" y="14" fill="currentColor" stroke="none" fontSize="6.5" fontWeight="600">
            2
          </text>
          <text x="1.5" y="20" fill="currentColor" stroke="none" fontSize="6.5" fontWeight="600">
            3
          </text>
          <path d="M8 6h12M8 12h12M8 18h12" />
        </svg>
      );
    case 'more':
      return (
        <svg {...common} {...props}>
          <circle cx="5" cy="12" r="1" fill="currentColor" />
          <circle cx="12" cy="12" r="1" fill="currentColor" />
          <circle cx="19" cy="12" r="1" fill="currentColor" />
        </svg>
      );
    case 'plus':
      return (
        <svg {...common} {...props}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case 'redo':
      return (
        <svg {...common} {...props}>
          <path d="m15 7 4 4-4 4" />
          <path d="M19 11h-8a6 6 0 0 0-6 6" />
        </svg>
      );
    case 'review':
      return (
        <svg {...common} {...props}>
          <path d="M4 5h16v12H8l-4 3z" />
          <path d="m8 11 2 2 5-5" />
        </svg>
      );
    case 'send':
      return (
        <svg {...common} {...props}>
          <path d="m22 2-7 20-4-9-9-4zM22 2 11 13" />
        </svg>
      );
    case 'sparkle':
      return (
        <svg {...common} {...props}>
          <path d="m12 3 1.4 3.6L17 8l-3.6 1.4L12 13l-1.4-3.6L7 8l3.6-1.4z" />
          <path d="m18 14 .9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9z" />
          <path d="m5 13 .7 1.3L7 15l-1.3.7L5 17l-.7-1.3L3 15l1.3-.7z" />
        </svg>
      );
    case 'trash':
      return (
        <svg {...common} {...props}>
          <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
        </svg>
      );
    case 'undo':
      return (
        <svg {...common} {...props}>
          <path d="m9 7-4 4 4 4" />
          <path d="M5 11h8a6 6 0 0 1 6 6" />
        </svg>
      );
    case 'x':
      return (
        <svg {...common} {...props}>
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      );
  }
}
