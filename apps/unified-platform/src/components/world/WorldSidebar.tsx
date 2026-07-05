'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const NAV = [
  { href: '/world/intel', icon: '🌐', label: 'World Intel' },
  { href: '/world/map',   icon: '🗺', label: 'World Map'  },
]

export function WorldSidebar() {
  const pathname = usePathname()
  return (
    <aside className="w-44 flex-shrink-0 bg-bg-sidebar border-r border-border-subtle flex flex-col">
      <div className="px-4 py-4 border-b border-border-subtle">
        <div className="text-sm font-bold"
          style={{ background: 'linear-gradient(90deg,#8b5cf6,#6366f1)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          World Intel
        </div>
      </div>
      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {NAV.map(({ href, icon, label }) => {
          const active = pathname === href || pathname.startsWith(href + '/')
          return (
            <Link key={href} href={href}
              className={`flex items-center gap-1.5 px-2.5 py-2 rounded text-xs transition-colors ${
                active
                  ? 'bg-border-subtle text-indigo-active border-l-2 border-accent-violet'
                  : 'text-text-inactive hover:text-text-muted'
              }`}>
              <span>{icon}</span>
              <span className={active ? 'font-medium' : ''}>{label}</span>
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
