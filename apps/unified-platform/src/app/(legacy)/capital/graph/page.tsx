export const dynamic = 'force-dynamic'

import { GraphClient } from './GraphClient'
import type { GraphJSON } from '@/types'
import { readGraph } from '@/lib/data'

export default async function GraphPage() {
  let graph: GraphJSON | null = null
  let fetchError: string | null = null

  try {
    graph = readGraph()
  } catch (e) {
    fetchError = e instanceof Error ? e.message : 'Failed to load graph data'
  }

  if (fetchError || !graph) {
    return (
      <div className="max-w-5xl">
        <h1 className="text-base font-bold text-text-primary mb-4">Dependency Graph</h1>
        <div className="bg-red-signal/10 border border-red-signal/20 rounded-lg p-4 text-sm text-red-signal">
          {fetchError ?? 'Failed to load data'}
        </div>
      </div>
    )
  }

  return (
    <div className="h-[calc(100vh-3rem)]">
      <h1 className="text-base font-bold text-text-primary mb-4">Dependency Graph</h1>
      <GraphClient data={graph} />
    </div>
  )
}
