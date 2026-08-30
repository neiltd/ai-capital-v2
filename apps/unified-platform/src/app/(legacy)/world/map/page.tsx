import dynamic from 'next/dynamic'
import { CoverageCallout } from '@/components/next/coverage-notice'

const WorldMapClient = dynamic(() => import('./WorldMapClient'), { ssr: false })

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
