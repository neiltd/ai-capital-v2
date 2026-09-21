import nextDynamic from 'next/dynamic'
import { CoverageCallout } from '@/components/next/coverage-notice'

const WorldMapClient = nextDynamic(() => import('./WorldMapClient'), { ssr: false })

// REQUEST-TIME, NOT BUILD-TIME. CoverageCallout reads live coverage state under
// DATA_ROOT, which is mutable runtime data and absent during `next build`. Static
// evaluation therefore threw "DATA_ROOT env var is not set" and failed the export
// of this path. The page belongs with the other data-backed world surfaces: it is
// rendered per request.
//
// (`next/dynamic`'s default export is imported as `nextDynamic` because the route
// segment config below owns the name `dynamic`.)
export const dynamic = 'force-dynamic'

// The map displays ARTICLE-derived events (its events.json carries
// source: "rss_intelligence" and the article exporter's timestamp), so it takes
// article-domain provenance like the other world surfaces. The callout renders
// nothing when every enabled feed is current, so the map stays full-bleed on a
// healthy day.
export default function WorldMapPage() {
  return (
    <>
      <div className="px-4 pt-3 empty:hidden"><CoverageCallout where="the events plotted below" /></div>
      <WorldMapClient />
    </>
  )
}
