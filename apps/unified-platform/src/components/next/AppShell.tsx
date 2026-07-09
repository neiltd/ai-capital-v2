'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { StatusStrip } from './StatusStrip'

interface NavItem {
  href: string
  label: string
}

interface NavSection {
  label: string
  items: NavItem[]
}

// design-system.md §1 — information architecture, ordered by the question
// Neil is asking each morning, not by which backend app produces the data.
const SECTIONS: NavSection[] = [
  { label: 'Today', items: [{ href: '/today', label: 'Briefing' }] },
  {
    label: 'Portfolio',
    items: [
      { href: '/portfolio', label: 'Holdings' },
      { href: '/portfolio/risk', label: 'Risk' },
      { href: '/portfolio/tax-planner', label: 'Tax Planner' },
      { href: '/portfolio/tax', label: 'Harvesting' },
      { href: '/portfolio/theses', label: 'Theses' },
    ],
  },
  {
    label: 'Markets',
    items: [
      { href: '/markets', label: 'Macro & Prices' },
      { href: '/markets/waves', label: 'Wave Signals' },
      { href: '/markets/gov', label: 'Gov Contracts' },
    ],
  },
  { label: 'World', items: [{ href: '/world', label: 'Events & Map' }] },
  {
    label: 'Discover',
    items: [
      { href: '/discover', label: 'Discovery Agent' },
      { href: '/discover/graph', label: 'Dependency Graph' },
    ],
  },
  { label: 'System', items: [{ href: '/system/pipeline', label: 'Pipeline' }] },
]

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()

  return (
    <div className="flex h-screen overflow-hidden bg-page text-ink">
      <aside className="w-60 flex-shrink-0 border-r border-hairline flex flex-col overflow-y-auto">
        <div className="px-4 py-4">
          <span className="text-[13px] font-semibold tracking-[-0.2px] text-ink select-none">
            AI CAPITAL
          </span>
        </div>
        <nav className="flex-1 px-3 pb-4 space-y-5">
          {SECTIONS.map((section) => (
            <div key={section.label}>
              <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                {section.label}
              </div>
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`block px-2 py-1.5 rounded-chip text-[13px] transition-colors ${
                        active
                          ? 'bg-surface-2 text-ink font-medium'
                          : 'text-ink-2 hover:text-ink hover:bg-surface'
                      }`}
                    >
                      {item.label}
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>
        <div className="border-t border-hairline px-3 py-3 space-y-0.5">
          <Link
            href="/studio"
            className="block px-2 py-1.5 rounded-chip text-[13px] text-ink-2 hover:text-ink hover:bg-surface transition-colors"
          >
            ◧ Creator Studio
          </Link>
          {/* Temporary during migration — remove once every screen has a (next) counterpart. */}
          <Link
            href="/capital/briefing"
            className="block px-2 py-1.5 rounded-chip text-[12px] text-ink-3 hover:text-ink-2 hover:bg-surface transition-colors"
          >
            ← Legacy UI
          </Link>
        </div>
      </aside>
      <div className="flex-1 flex flex-col overflow-hidden">
        <StatusStrip />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
