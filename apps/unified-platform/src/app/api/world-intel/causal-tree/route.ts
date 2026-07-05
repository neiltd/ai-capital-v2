export const dynamic = 'force-dynamic'

import { NextResponse, type NextRequest } from 'next/server'
import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'

// Given an event_id, returns the target event + its predecessors (events the
// target was caused_by) + its successors (events whose causal_links reference
// the target). Powers the worldmap's click-an-event-to-see-its-tree UI.

interface RawCausalLink {
  event_id:   string
  kind:       'caused_by' | 'expected_consequence'
  confidence: number
  rationale:  string
}
interface RawEvent {
  event_id:   string
  event:      { title: string; summary: string; severity: number; event_type: string; status: string }
  geography:  { countries?: string[] }
  identity:   { first_seen_at?: string }
  graph?: {
    causal_links?:           RawCausalLink[]
    expected_consequences?:  string[]
    causal_confidence?:      number
    counterfactual?:         string
  }
}

interface TreeEventDto {
  eventId:        string
  title:          string
  summary:        string
  eventType:      string
  severity:       number
  status:         string
  countries:      string[]
  occurredAt:     string
}

interface TreeLinkDto {
  event:        TreeEventDto
  confidence:   number
  rationale:    string
}

export interface CausalTreeResponse {
  target: TreeEventDto & {
    causalConfidence:     number | null
    counterfactual:       string | null
    expectedConsequences: string[]
  }
  predecessors: TreeLinkDto[]   // events the target was caused_by, sorted by confidence desc
  successors:   TreeLinkDto[]   // events that named target as a cause
}

function workspaceRoot(): string {
  let dir = process.cwd()
  while (dir !== '/') {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    dir = join(dir, '..')
  }
  return process.cwd()
}

function eventsDir(): string {
  return join(workspaceRoot(),
    'apps', 'world-intelligence-data-hub-', 'intelligence', 'outputs', 'events')
}

function listEventFiles(days: number): string[] {
  const dir = eventsDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .slice(-days)
    .map(f => join(dir, f))
}

function loadAllEvents(days: number): Map<string, RawEvent> {
  const out = new Map<string, RawEvent>()
  for (const file of listEventFiles(days)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as RawEvent[] | { events?: RawEvent[] }
      const arr: RawEvent[] = Array.isArray(raw) ? raw : (raw.events ?? [])
      for (const e of arr) {
        if (e.event_id) out.set(e.event_id, e)
      }
    } catch { /* skip unreadable files */ }
  }
  return out
}

function toTreeEvent(e: RawEvent): TreeEventDto {
  return {
    eventId:    e.event_id,
    title:      e.event.title,
    summary:    e.event.summary,
    eventType:  e.event.event_type,
    severity:   e.event.severity,
    status:     e.event.status,
    countries:  e.geography?.countries ?? [],
    occurredAt: e.identity?.first_seen_at ?? '',
  }
}

export async function GET(req: NextRequest) {
  try {
    const eventId = req.nextUrl.searchParams.get('eventId')
    if (!eventId) {
      return NextResponse.json({ error: 'eventId query param required' }, { status: 400 })
    }

    const index = loadAllEvents(90)
    const target = index.get(eventId)
    if (!target) {
      return NextResponse.json({ error: `event ${eventId} not found in last 90 days` }, { status: 404 })
    }

    // Predecessors: events the target was caused_by. Walk target.graph.causal_links.
    const predecessors: TreeLinkDto[] = (target.graph?.causal_links ?? [])
      .filter(l => l.kind === 'caused_by')
      .sort((a, b) => b.confidence - a.confidence)
      .map(l => {
        const ev = index.get(l.event_id)
        return ev ? {
          event:      toTreeEvent(ev),
          confidence: l.confidence,
          rationale:  l.rationale,
        } : null
      })
      .filter((x): x is TreeLinkDto => x !== null)

    // Successors: any event whose causal_links reference target.event_id.
    const successors: TreeLinkDto[] = []
    index.forEach((ev) => {
      if (ev.event_id === target.event_id) return
      const link = ev.graph?.causal_links?.find(
        (l: RawCausalLink) => l.event_id === target.event_id && l.kind === 'caused_by',
      )
      if (link) {
        successors.push({
          event:      toTreeEvent(ev),
          confidence: link.confidence,
          rationale:  link.rationale,
        })
      }
    })
    successors.sort((a, b) => b.confidence - a.confidence)

    const response: CausalTreeResponse = {
      target: {
        ...toTreeEvent(target),
        causalConfidence:     target.graph?.causal_confidence ?? null,
        counterfactual:       target.graph?.counterfactual ?? null,
        expectedConsequences: target.graph?.expected_consequences ?? [],
      },
      predecessors,
      successors,
    }

    return NextResponse.json(response)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[api/world-intel/causal-tree] error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
