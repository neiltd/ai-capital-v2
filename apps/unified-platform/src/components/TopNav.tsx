'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

const WORKSPACES = [
  { href: '/capital/briefing', label: 'Capital Intel',      prefix: '/capital' },
  { href: '/world/intel',      label: 'World Intelligence', prefix: '/world'   },
  { href: '/studio/dashboard', label: 'Creator Studio',     prefix: '/studio'  },
]

export function TopNav() {
  const pathname = usePathname()
  const [stale, setStale] = useState(false)

  useEffect(() => {
    fetch('/api/status')
      .then(r => r.json())
      .then(d => setStale(d.stale))
      .catch(() => {})
  }, [])

  return (
    <header className="flex items-center gap-0.5 px-4 border-b border-[#23252a] bg-[#010102] flex-shrink-0 h-14">
      <span className="text-[13px] font-semibold tracking-[-0.2px] text-[#5e6ad2] mr-5 select-none">
        ⬡ Intelligence Hub
      </span>
      {WORKSPACES.map(({ href, label, prefix }) => {
        const active = pathname.startsWith(prefix)
        return (
          <Link key={href} href={href}
            className={`inline-flex items-center px-3 py-1.5 rounded-[8px] text-sm border transition-colors ${
              active
                ? 'bg-[#141516] text-[#f7f8f8] font-medium border-[#23252a]'
                : 'text-[#8a8f98] hover:text-[#d0d6e0] font-normal border-transparent'
            }`}>
            {label}
          </Link>
        )
      })}
      {stale && (
        <span className="ml-auto text-xs text-amber-signal bg-[#141516] border border-[#23252a] rounded-full px-2.5 py-0.5">
          ⚠ Stale data — run ./daily.sh
        </span>
      )}
    </header>
  )
}
