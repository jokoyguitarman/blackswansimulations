/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'robotic-yellow': '#FFB800',
        'robotic-orange': '#FF6B35',
        'robotic-gold': '#FFD700',
        'robotic-dark': '#0f0f0f',
        'robotic-green': '#00FF88',
        'robotic-red': '#FF4444',
        'robotic-gray': {
          50: '#4a4a4a',
          100: '#3a3a3a',
          200: '#2d2d2d',
          300: '#1a1a1a',
          400: '#0f0f0f',
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
      backgroundImage: {
        'gradient-robotic': 'linear-gradient(135deg, #0f0f0f 0%, #1a1a1a 50%, #0f0f0f 100%)',
        'gradient-yellow-orange': 'linear-gradient(135deg, #FFB800 0%, #FF6B35 100%)',
        'gradient-grey': 'linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%)',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'monospace'],
        orbitron: ['Orbitron', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
