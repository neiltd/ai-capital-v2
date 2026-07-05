import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Layered surface palette (darker → lighter) — mapped from DESIGN.md's
        // Linear-inspired system: canvas → surface-1 → surface-2 → surface-3.
        'bg-base':       '#010102',
        'bg-sidebar':    '#010102',
        'bg-elevated':   '#18191a',
        'bg-card':       '#0f1011',
        'bg-card-hover': '#141516',
        'bg-subtle':     '#0f1011',
        'bg-row-alt':    '#141516',

        // Borders — three levels of emphasis (DESIGN.md hairline / hairline-strong / hairline-tertiary)
        'border-subtle':  '#23252a',
        'border-default': '#34343a',
        'border-strong':  '#3e3e44',

        // Brand accent — DESIGN.md primary lavender-blue, scarce chromatic accent
        'accent-primary': '#5e6ad2',
        'accent-violet':  '#8b5cf6',
        'accent-cyan':    '#22d3ee',
        'indigo-active':  '#828fff',
        'indigo-soft':    '#5e69d1',

        // Text hierarchy (DESIGN.md ink / ink-muted / ink-subtle / ink-tertiary)
        'text-primary':   '#f7f8f8',
        'text-secondary': '#d0d6e0',
        'text-muted':     '#8a8f98',
        'text-inactive':  '#62666d',
        'text-faint':     '#4a4d52',

        // Semantic signals
        'green-signal':  '#4ade80',
        'green-soft':    '#22c55e',
        'amber-signal':  '#fbbf24',
        'amber-soft':    '#f59e0b',
        'red-signal':    '#f87171',
        'red-soft':      '#ef4444',
        'blue-signal':   '#60a5fa',
      },
      boxShadow: {
        'glow-indigo': '0 0 0 1px rgba(94, 106, 210, 0.25), 0 4px 24px -8px rgba(94, 106, 210, 0.45)',
        'card':        '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 1px 2px 0 rgba(0,0,0,0.4)',
        'card-hover':  '0 1px 0 0 rgba(255,255,255,0.05) inset, 0 6px 20px -8px rgba(0,0,0,0.6)',
      },
      backgroundImage: {
        'gradient-card':     'linear-gradient(180deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0) 100%)',
        'gradient-card-up':  'linear-gradient(180deg, rgba(74, 222, 128, 0.06) 0%, rgba(74, 222, 128, 0) 70%)',
        'gradient-card-dn':  'linear-gradient(180deg, rgba(248, 113, 113, 0.06) 0%, rgba(248, 113, 113, 0) 70%)',
        'gradient-sidebar':  'linear-gradient(180deg, #010102 0%, #010102 100%)',
      },
      fontSize: {
        '2xs': ['10px', '14px'],
      },
    },
  },
  plugins: [],
}
export default config
