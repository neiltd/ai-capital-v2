// Plain data — kept out of holdings-table.tsx deliberately. That file is
// 'use client' (for row-expansion state), and Next.js's RSC boundary treats
// every export of a 'use client' module as an opaque client reference, even
// plain constants. page.tsx (a server component) needs to .map() over
// CLASS_ORDER directly, which breaks if it's re-exported from a client file.
import type { AssetClass } from '../_shared/types'

export const CLASS_META: Record<AssetClass, { label: string; color: string }> = {
  us_equity: { label: 'US equity', color: 'var(--cat-1)' },
  th_equity: { label: 'Thai equity', color: 'var(--cat-2)' },
  gold: { label: 'Gold', color: 'var(--cat-3)' },
  th_fund: { label: 'Thai funds', color: 'var(--cat-4)' },
  cash: { label: 'Cash', color: '#898781' },
}

export const CLASS_ORDER: AssetClass[] = ['us_equity', 'th_equity', 'th_fund', 'gold', 'cash']
