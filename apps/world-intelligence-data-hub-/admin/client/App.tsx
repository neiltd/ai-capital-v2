import React, { useState } from 'react'
import Submit from './Submit'
import Draft  from './Draft'
import Briefs from './Briefs'
import type { EventAnalysis, AdminHumanIntelRecord } from '../types'

type View = 'submit' | 'draft' | 'briefs'

export default function App() {
  const [view,            setView]            = useState<View>('submit')
  const [pendingRecord,   setPendingRecord]   = useState<AdminHumanIntelRecord | null>(null)
  const [pendingAnalysis, setPendingAnalysis] = useState<EventAnalysis | null>(null)

  function handleAnalyseSuccess(record: AdminHumanIntelRecord, analysis: EventAnalysis) {
    setPendingRecord(record)
    setPendingAnalysis(analysis)
    setView('draft')
  }

  function handlePublishDone() {
    setPendingRecord(null)
    setPendingAnalysis(null)
    setView('submit')
  }

  return (
    <div className="app">
      <nav className="nav">
        <button className={view === 'submit' ? 'active' : ''} onClick={() => setView('submit')}>
          Submit News
        </button>
        <button
          className={view === 'draft' ? 'active' : ''}
          onClick={() => setView('draft')}
          disabled={!pendingRecord}
        >
          Review Draft
        </button>
        <button className={view === 'briefs' ? 'active' : ''} onClick={() => setView('briefs')}>
          Country Briefs
        </button>
      </nav>
      <main className="main">
        {view === 'submit' && <Submit onSuccess={handleAnalyseSuccess} />}
        {view === 'draft' && pendingRecord && pendingAnalysis && (
          <Draft
            initialRecord={pendingRecord}
            initialAnalysis={pendingAnalysis}
            onPublish={handlePublishDone}
          />
        )}
        {view === 'briefs' && <Briefs />}
      </main>
    </div>
  )
}
