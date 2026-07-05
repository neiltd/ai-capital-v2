import { useState } from 'react'
import Fuse from 'fuse.js'
import { useMapStore } from '../../../store/useMapStore'
import countryIndex from '../../../data/country-index.json'
import { T, flag } from './tokens'

interface Entry { id: string; iso2: string; name: string; region: string }

const allEntries = countryIndex as Entry[]
const fuse = new Fuse(allEntries, { keys: ['name'], threshold: 0.3 })

export function CompareSearch() {
  const { setCompare, compareData, clearCompare, compareLoading } = useMapStore()
  const [q, setQ] = useState('')
  const [res, setRes] = useState<Entry[]>([])

  if (compareData) {
    return (
      <div className={`flex items-center gap-2 mt-3 px-3 py-2 ${T.card} min-w-0`}>
        <span className="flex-shrink-0 text-base">{flag(compareData.iso2)}</span>
        <span className="text-[12px] text-purple-300 flex-1 truncate min-w-0">{compareData.name}</span>
        <button onClick={clearCompare}
          className="flex-shrink-0 text-text-inactive hover:text-text-primary text-lg leading-none">×</button>
      </div>
    )
  }

  return (
    <div className="relative mt-3">
      <input
        value={q}
        onChange={e => {
          setQ(e.target.value)
          setRes(e.target.value ? fuse.search(e.target.value).slice(0, 6).map(r => r.item) : [])
        }}
        placeholder="Compare with another country…"
        className={`w-full text-[12px] px-3 py-2 ${T.card} text-text-secondary placeholder-text-faint outline-none bg-bg-card`}
      />
      {compareLoading && <p className="text-[11px] text-text-inactive mt-1">Loading…</p>}
      {res.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-bg-base border border-border-subtle rounded-lg overflow-hidden z-20 shadow-2xl">
          {res.map(e => (
            <button key={e.id}
              onClick={() => { setCompare(e.id); setQ(''); setRes([]) }}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-bg-card-hover text-left min-w-0">
              <span className="flex-shrink-0">{flag(e.iso2)}</span>
              <div className="min-w-0">
                <p className="text-[12px] text-text-secondary truncate">{e.name}</p>
                <p className="text-[11px] text-text-inactive">{e.region}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
