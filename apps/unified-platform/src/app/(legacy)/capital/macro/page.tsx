export const dynamic = 'force-dynamic'

import type { MacroJSON } from '@/types'
import { readMacro } from '@/lib/data'
import { MacroAssetCard } from '@/components/capital/MacroAssetCard'
import { EconomicIndicatorGroups } from '@/components/capital/EconomicIndicatorGroups'
import { LiquidityIndicatorCards } from '@/components/capital/LiquidityIndicatorCards'
import { PageHeader, MetaDot, SectionTitle } from '@/components/capital/ui/PageHeader'
import { EmptyState } from '@/components/capital/ui/EmptyState'

const CATEGORY_ORDER = ['us-equity', 'rates', 'dollar', 'commodities', 'volatility', 'global-equity', 'credit']

export default async function MacroPage() {
  let macro: MacroJSON | null = null
  let error: string | null = null

  try {
    macro = readMacro()
  } catch (e) {
    error = e instanceof Error ? e.message : 'Failed to load macro data'
  }

  if (error || !macro) {
    return (
      <div className="max-w-4xl">
        <PageHeader title="Macro Monitor" subtitle="Cross-asset market pulse and economic indicators" />
        <EmptyState
          tone="error"
          title="No macro data available"
          description={error ?? 'macro.json was not found at the configured data root.'}
          hint={<>Run <code className="font-mono text-indigo-active">./daily.sh</code> to fetch macro data.</>}
        />
      </div>
    )
  }

  const sortedAssets = [...macro.marketAssets].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
  )

  return (
    <div className="max-w-6xl space-y-8">
      <PageHeader
        title="Macro Monitor"
        subtitle="Cross-asset market pulse and economic indicators"
        meta={
          <>
            <span>as of {macro.asOf}</span>
            <MetaDot />
            <span>{sortedAssets.length} assets</span>
            <MetaDot />
            <span>{macro.economicIndicators.length} indicators</span>
          </>
        }
      />

      <section>
        <SectionTitle count={sortedAssets.length}>Market Pulse</SectionTitle>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
          {sortedAssets.map(asset => (
            <MacroAssetCard key={asset.ticker} asset={asset} />
          ))}
        </div>
      </section>

      <EconomicIndicatorGroups indicators={macro.economicIndicators} />

      {macro.liquidityIndicators?.length > 0 && (
        <LiquidityIndicatorCards indicators={macro.liquidityIndicators} />
      )}
    </div>
  )
}
