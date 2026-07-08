// Shared lateral sub-nav across the 4 Studio pages. Studio stays "an app
// switch, not a sibling nav item" in the main sidebar (design-system.md §8's
// navigation-model decision, which the 2026-07 theme-unification reversal
// did NOT touch — only the token/color decision was reversed) — this in-page
// strip is how you move between Board/Today's topic/Dashboard/Archive once
// you're there.

const ITEMS = [
  { id: 'board', label: 'Board', href: '/studio' },
  { id: 'chat', label: "Today's topic", href: '/studio/chat' },
  { id: 'dashboard', label: 'Dashboard', href: '/studio/dashboard' },
  { id: 'archive', label: 'Archive', href: '/studio/archive' },
] as const

export function StudioNav({ current }: { current: (typeof ITEMS)[number]['id'] }) {
  return (
    <nav className="flex items-center gap-4 text-[12px]">
      {ITEMS.map((it) => (
        <a
          key={it.id}
          href={it.href}
          className={it.id === current ? 'font-semibold text-ink' : 'text-ink-3 hover:text-ink-2'}
        >
          {it.label}
        </a>
      ))}
    </nav>
  )
}
