/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── Semantic design tokens (light theme; driven by CSS vars) ──
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        ink: 'var(--ink)',
        muted: 'var(--muted)',
        brand: {
          DEFAULT: 'var(--brand)',
          strong: 'var(--brand-strong)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          strong: 'var(--accent-strong)',
        },
        border: {
          DEFAULT: 'var(--border)',
          strong: 'var(--border-strong)',
        },
        success: 'var(--success)',
        warning: 'var(--warning)',
        danger: 'var(--danger)',
        // ── Legacy robotic-* names, temporarily aliased to the new
        //    tokens so un-migrated screens still render in the new skin.
        //    Removed in Phase 3 once no references remain. ──
        'robotic-yellow': 'var(--ink)',
        'robotic-orange': 'var(--accent)',
        'robotic-gold': 'var(--accent)',
        'robotic-dark': 'var(--bg)',
        'robotic-green': 'var(--success)',
        'robotic-red': 'var(--danger)',
        'robotic-gray': {
          50: 'var(--muted)',
          100: 'var(--border-strong)',
          200: 'var(--surface-2)',
          300: 'var(--surface)',
          400: 'var(--bg)',
        },
        wa: {
          bg: '#0B141A',
          header: '#1F2C34',
          sent: '#005C4B',
          received: '#202C33',
          input: '#2A3942',
          teal: '#00A884',
          'teal-light': '#06CF9C',
          text: '#E9EDEF',
          'text-secondary': '#8696A0',
          border: '#86969626',
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
