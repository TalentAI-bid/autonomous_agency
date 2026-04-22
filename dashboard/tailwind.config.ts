import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--ff-sans)', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['var(--ff-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        display: ['var(--ff-display)', 'Georgia', 'serif'],
      },
      fontSize: {
        '2xs': ['10px', { lineHeight: '14px' }],
        xs: ['11px', { lineHeight: '16px' }],
      },
      colors: {
        // Design system tokens (OKLCH via CSS vars)
        ink: 'var(--ink)',
        'ink-2': 'var(--ink-2)',
        'ink-3': 'var(--ink-3)',
        'ink-4': 'var(--ink-4)',
        'ink-5': 'var(--ink-5)',
        bg: 'var(--bg)',
        'bg-sub': 'var(--bg-sub)',
        'bg-panel': 'var(--bg-panel)',
        'bg-soft': 'var(--bg-soft)',
        hover: 'var(--hover)',
        selected: 'var(--selected)',
        line: 'var(--line)',
        'line-2': 'var(--line-2)',
        'line-strong': 'var(--line-strong)',
        up: 'var(--up)',
        down: 'var(--down)',
        warn: 'var(--warn)',
        'accent-weak': 'var(--accent-weak)',
        'accent-mid': 'var(--accent-mid)',
        'accent-fg': 'var(--accent-fg)',
        'a-master': 'var(--a-master)',
        'a-discovery': 'var(--a-discovery)',
        'a-enrichment': 'var(--a-enrichment)',
        'a-scoring': 'var(--a-scoring)',
        'a-outreach': 'var(--a-outreach)',
        'a-reply': 'var(--a-reply)',
        'a-action': 'var(--a-action)',

        // Shadcn compatibility tokens
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-fg)',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar))',
          foreground: 'hsl(var(--sidebar-foreground))',
          border: 'hsl(var(--sidebar-border))',
          accent: 'hsl(var(--sidebar-accent))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-in-out',
        'slide-in': 'slide-in 0.3s ease-out',
        'pulse-dot': 'pulse-dot 1.8s ease-in-out infinite',
        heartbeat: 'hb 1.6s ease-in-out infinite',
        pulse: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-in': { from: { transform: 'translateY(-8px)', opacity: '0' }, to: { transform: 'translateY(0)', opacity: '1' } },
        'pulse-dot': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(34,197,94,.4)' },
          '50%': { boxShadow: '0 0 0 6px rgba(34,197,94,0)' },
        },
        hb: {
          '0%, 100%': { opacity: '.75' },
          '50%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};

export default config;
