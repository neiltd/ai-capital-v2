'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const NAV = [
  { href: '/studio',           icon: '✦',   label: 'Today'     },
  { href: '/studio/dashboard', icon: '📊',  label: 'Dashboard' },
  { href: '/studio/archive',   icon: '🗂',  label: 'Archive'   },
]

export function StudioSidebar() {
  const pathname = usePathname()
  return (
    <aside className="w-44 flex-shrink-0 bg-[#0f1011] border-r border-[#23252a] flex flex-col">
      <div className="px-4 py-4 border-b border-[#23252a]">
        <div className="text-sm font-medium tracking-[-0.1px] text-[#f7f8f8]">Creator Studio</div>
      </div>
      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {NAV.map(({ href, icon, label }) => {
          const active = pathname === href || (href !== '/studio' && pathname.startsWith(href + '/'))
          return (
            <Link key={href} href={href}
              className={`flex items-center gap-1.5 px-2.5 py-2 rounded-[8px] text-sm border transition-colors ${
                active
                  ? 'bg-[#141516] text-[#f7f8f8] font-medium border-[#23252a]'
                  : 'text-[#8a8f98] hover:text-[#d0d6e0] font-normal border-transparent'
              }`}>
              <span className="text-xs">{icon}</span>
              <span>{label}</span>
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
