import dynamic from 'next/dynamic'

const WorldMapClient = dynamic(() => import('./WorldMapClient'), { ssr: false })

export default function WorldMapPage() {
  return <WorldMapClient />
}
