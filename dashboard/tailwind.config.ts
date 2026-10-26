import type { Config } from 'tailwindcss';

// Colors are full CSS colors (OKLCH), not HSL channels, so opacity modifiers
// (bg-primary/90) are applied with color-mix instead of <alpha-value>.
// Tailwind passes either a number ("0.9") or "var(--tw-*-opacity)".
const tok = (name: string) =>
  (({ opacityValue }: { opacityValue?: string }) => {
    if (opacityValue === undefined || opacityValue === '1') return `var(--${name})`;
    const pct = /^[d.]+$/.test(opacityValue) ? `${Number(opacityValue) * 100}%` : `calc(${opacityValue} * 100%)`;
    return `color-mix(in oklch, var(--${name}) ${pct}, transparent)`;
  }) as unknown as string;

const config: Config = {
  // Prefix every utility with :root so it out-ranks the hand-written rules in
  // globals.css (.panel, .pill, .nav-item, ".panel-head h3" …) without !important.
  important: ':root',
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
      // Dense type scale. New steps keep line-height inherited (the body sets 1.4)
      // so swapping text-[Npx] for a named step never shifts layout.
      fontSize: {
        '3xs': ['9px', { lineHeight: 'inherit' }],
        '2xs': ['10px', { lineHeight: '14px' }],
        xs: ['11px', { lineHeight: '16px' }],
        label: ['12px', { lineHeight: 'inherit' }],
        body: ['13px', { lineHeight: 'inherit' }],
        title: ['15px', { lineHeight: 'inherit' }],
        stat: ['22px', { lineHeight: 'inherit' }],
        hero: ['34px', { lineHeight: 'inherit' }],
      },
      colors: {
        // Design system tokens (OKLCH via CSS vars)
        ink: tok('ink'),
        'ink-2': tok('ink-2'),
        'ink-3': tok('ink-3'),
        'ink-4': tok('ink-4'),
        'ink-5': tok('ink-5'),
        bg: tok('bg'),
        'bg-sub': tok('bg-sub'),
        'bg-panel': tok('bg-panel'),
        'bg-soft': tok('bg-soft'),
        hover: tok('hover'),
        selected: tok('selected'),
        line: tok('line'),
        'line-2': tok('line-2'),
        'line-strong': tok('line-strong'),
        up: tok('up'),
        down: tok('down'),
        warn: tok('warn'),
        'warn-fg': tok('warn-fg'),
        info: tok('info'),
        'accent-weak': tok('accent-weak'),
        'accent-mid': tok('accent-mid'),
        'accent-fg': tok('accent-fg'),
        'a-master': tok('a-master'),
        'a-discovery': tok('a-discovery'),
        'a-enrichment': tok('a-enrichment'),
        'a-scoring': tok('a-scoring'),
        'a-outreach': tok('a-outreach'),
        'a-reply': tok('a-reply'),
        'a-action': tok('a-action'),

        // Shadcn compatibility tokens
        border: tok('border'),
        input: tok('input'),
        ring: tok('ring'),
        background: tok('background'),
        foreground: tok('foreground'),
        primary: {
          DEFAULT: tok('primary'),
          foreground: tok('primary-foreground'),
        },
        secondary: {
          DEFAULT: tok('secondary'),
          foreground: tok('secondary-foreground'),
        },
        destructive: {
          DEFAULT: tok('destructive'),
          foreground: tok('destructive-foreground'),
        },
        muted: {
          DEFAULT: tok('muted'),
          foreground: tok('muted-foreground'),
        },
        accent: {
          DEFAULT: tok('accent'),
          foreground: tok('accent-fg'),
        },
        card: {
          DEFAULT: tok('card'),
          foreground: tok('card-foreground'),
        },
        popover: {
          DEFAULT: tok('popover'),
          foreground: tok('popover-foreground'),
        },
        sidebar: {
          DEFAULT: tok('sidebar'),
          foreground: tok('sidebar-foreground'),
          border: tok('sidebar-border'),
          accent: tok('sidebar-accent'),
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
