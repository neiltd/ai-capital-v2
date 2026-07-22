'use client'

// Thin client wrapper (page.tsx stays a server component) so the briefing
// date can be changed without a full client-side rewrite of /today. Only
// offers dates that actually have an archived briefings/{date}.json — see
// listBriefingDates() in @/lib/data.

import { useRouter } from 'next/navigation'

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function label(date: string, today: string) {
  // New Date('YYYY-MM-DD') parses as UTC midnight; fine here since we only
  // need the weekday, not a display of "now".
  const wd = WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()]
  return `${wd} · ${date}${date === today ? ' (today)' : ''}`
}

export function DatePicker({ dates, selected, today }: { dates: string[]; selected: string; today: string }) {
  const router = useRouter()
  const idx = dates.indexOf(selected)
  const hasOlder = idx !== -1 && idx < dates.length - 1
  const hasNewer = idx > 0

  function go(date: string) {
    router.push(date === today ? '/today' : `/today?date=${date}`)
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-label="Previous day"
        title="Previous day"
        disabled={!hasOlder}
        onClick={() => go(dates[idx + 1])}
        className="flex h-7 w-7 items-center justify-center rounded-chip border border-hairline text-[13px] text-ink-2 hover:bg-surface-2 disabled:opacity-30 disabled:hover:bg-transparent"
      >
        ‹
      </button>
      <select
        value={idx === -1 ? selected : selected}
        onChange={(e) => go(e.target.value)}
        className="rounded-chip border border-hairline bg-surface px-2 py-1 text-[13px] text-ink tnum"
        aria-label="Briefing date"
      >
        {idx === -1 && <option value={selected}>{selected} (unavailable)</option>}
        {dates.map((d) => (
          <option key={d} value={d}>{label(d, today)}</option>
        ))}
      </select>
      <button
        type="button"
        aria-label="Next day"
        title="Next day"
        disabled={!hasNewer}
        onClick={() => go(dates[idx - 1])}
        className="flex h-7 w-7 items-center justify-center rounded-chip border border-hairline text-[13px] text-ink-2 hover:bg-surface-2 disabled:opacity-30 disabled:hover:bg-transparent"
      >
        ›
      </button>
    </div>
  )
}
