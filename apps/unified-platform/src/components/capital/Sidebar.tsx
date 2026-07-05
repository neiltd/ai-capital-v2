'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'

/* ────────────────────────────────────────────────────────────────────────── */
/*  Icon set — inline SVGs (Lucide-style, 16px, 1.5px stroke)                  */
/* ────────────────────────────────────────────────────────────────────────── */

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.75"
      strokeLinecap="round" strokeLinejoin="round"
      className="flex-shrink-0"
    >
      {children}
    </svg>
  )
}

const Icons = {
  briefing:  <Icon><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></Icon>,
  portfolio: <Icon><path d="M20 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2Z"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></Icon>,
  discovery: <Icon><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6M8 11h6"/></Icon>,
  thesis:    <Icon><path d="M12 2a8 8 0 0 0-8 8c0 2.5 1.2 4.7 3 6l1 5h8l1-5c1.8-1.3 3-3.5 3-6a8 8 0 0 0-8-8Z"/><path d="M9 21h6"/></Icon>,
  graph:     <Icon><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 7l4 9M17 7l-4 9"/></Icon>,
  macro:     <Icon><path d="M3 3v18h18"/><path d="m7 14 4-4 4 4 5-5"/></Icon>,
  waves:     <Icon><path d="M2 12c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/><path d="M2 17c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/></Icon>,
  trade:     <Icon><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/></Icon>,
  gov:       <Icon><path d="M3 21h18M5 21V10l7-5 7 5v11"/><path d="M9 21v-6h6v6"/></Icon>,
  ask:       <Icon><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/></Icon>,
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Nav structure — grouped into sections                                     */
/* ────────────────────────────────────────────────────────────────────────── */

interface NavItem {
  href: string
  label: string
  icon: ReactNode
}

interface NavSection {
  label: string
  items: NavItem[]
}

const SECTIONS: NavSection[] = [
  {
    label: 'Overview',
    items: [
      { href: '/capital/briefing',  label: 'Briefing',  icon: Icons.briefing  },
      { href: '/capital/portfolio', label: 'Portfolio', icon: Icons.portfolio },
    ],
  },
  {
    label: 'Research',
    items: [
      { href: '/capital/discovery', label: 'Discovery', icon: Icons.discovery },
      { href: '/capital/thesis',    label: 'Thesis',    icon: Icons.thesis    },
      { href: '/capital/graph',     label: 'Graph',     icon: Icons.graph     },
    ],
  },
  {
    label: 'Markets',
    items: [
      { href: '/capital/macro', label: 'Macro', icon: Icons.macro },
      { href: '/capital/waves', label: 'Waves', icon: Icons.waves },
      { href: '/capital/gov',   label: 'Gov',   icon: Icons.gov   },
    ],
  },
  {
    label: 'Execution',
    items: [
      { href: '/capital/trade', label: 'Trade', icon: Icons.trade },
      { href: '/capital/ask',   label: 'Ask',   icon: Icons.ask   },
    ],
  },
]

/* ────────────────────────────────────────────────────────────────────────── */
/*  Sidebar                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

export function Sidebar() {
  const pathname = usePathname()
  const [stamp, setStamp] = useState<{ date: string; time: string } | null>(null)

  useEffect(() => {
    const tick = () => {
      const now = new Date()
      setStamp({
        date: now.toISOString().split('T')[0],
        time: now.toLocaleTimeString('en-US', {
          hour: '2-digit', minute: '2-digit', hour12: false,
        }),
      })
    }
    tick()
    const id = window.setInterval(tick, 60_000)
    return () => window.clearInterval(id)
  }, [])

  return (
    <aside className="w-56 flex-shrink-0 bg-gradient-sidebar border-r border-border-subtle flex flex-col">
      {/* Brand header */}
      <div className="px-5 py-5 border-b border-border-subtle">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent-primary to-accent-violet flex items-center justify-center text-[13px] font-bold text-white shadow-glow-indigo">
            C
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold tracking-tight text-text-primary leading-none">
              Capital Intel
            </div>
            <div className="text-[10px] text-text-inactive mt-1 font-medium uppercase tracking-wider">
              Investment Desk
            </div>
          </div>
        </div>
      </div>

      {/* Sections */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
        {SECTIONS.map(section => (
          <div key={section.label}>
            <div className="px-2.5 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-inactive">
              {section.label}
            </div>
            <div className="space-y-0.5">
              {section.items.map(({ href, label, icon }) => {
                const active = pathname === href || pathname.startsWith(href + '/')
                return (
                  <Link
                    key={href}
                    href={href}
                    className={`group relative flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] transition-all ${
                      active
                        ? 'bg-bg-card text-text-primary font-medium shadow-card'
                        : 'text-text-muted hover:text-text-primary hover:bg-bg-card/50 font-normal'
                    }`}
                  >
                    {active && (
                      <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r bg-gradient-to-b from-accent-primary to-accent-violet" />
                    )}
                    <span className={`${active ? 'text-indigo-active' : 'text-text-inactive group-hover:text-text-secondary'} transition-colors`}>
                      {icon}
                    </span>
                    <span className="truncate">{label}</span>
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Status footer */}
      <div className="px-4 py-3.5 border-t border-border-subtle">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-signal/40" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-signal" />
          </span>
          <span className="text-[11px] font-medium text-text-secondary">Live</span>
        </div>
        <div className="text-[10px] text-text-inactive leading-snug min-h-[14px]">
          {stamp ? (
            <>
              Updated <span className="text-text-muted">{stamp.date}</span>
              <span className="text-text-faint mx-1">·</span>
              <span className="text-text-muted">{stamp.time}</span>
            </>
          ) : (
            <span className="text-text-faint">Loading…</span>
          )}
        </div>
      </div>
    </aside>
  )
}
