'use client'

import App from '@/worldmap/App'
import '@/worldmap/index.css'

export default function WorldMapClient() {
  return (
    <div style={{ width: '100%', height: 'calc(100vh - 40px)' }}>
      <App />
    </div>
  )
}
