'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'

/**
 * Collapsed-by-default section for the lower-priority event tier. Matches
 * the collapse-toggle pattern already used in ShortSetupsTable — a small
 * client leaf around otherwise server-rendered content.
 */
export function CollapsibleGroup({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string
  count: number
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between mb-3"
      >
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted flex items-center gap-2">
          <span className="inline-block w-1 h-3 bg-border-strong rounded-full" />
          {title}
          <span className="text-text-faint font-normal normal-case tracking-normal">({count})</span>
        </h2>
        <span className="text-[10px] text-indigo-active hover:underline">{open ? 'hide' : 'show'}</span>
      </button>
      {open && <div className="space-y-3">{children}</div>}
    </section>
  )
}
