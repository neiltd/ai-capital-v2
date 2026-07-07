'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import type { GraphJSON, GraphEdge } from '@/types'

// next/dynamic's LoadableComponent doesn't forward refs (it's a plain function
// component, not React.forwardRef), which silently breaks fgRef below. Loading
// the module directly via useEffect + import() bypasses that wrapper so the
// library's own forwardRef-based component receives the ref correctly.

const PALETTE = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#f87171', '#a78bfa', '#34d399', '#60a5fa']

function tickerColor(ticker: string): string {
  let hash = 0
  for (const c of ticker) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff
  return PALETTE[Math.abs(hash) % PALETTE.length]
}

interface NodeObject {
  ticker: string
  company: string
  themes: string[]
  degree: number
  x?: number
  y?: number
  vx?: number
  vy?: number
}

interface LinkObject {
  source: string | NodeObject
  target: string | NodeObject
  type: string
  strength: string
}

interface Props {
  data: GraphJSON
}

const STRENGTH_WIDTH: Record<string, number> = { strong: 2, medium: 1.2, weak: 0.6 }
const STRENGTH_ALPHA: Record<string, number>  = { strong: 0.7, medium: 0.45, weak: 0.25 }

export function GraphClient({ data }: Props) {
  const [selectedNode, setSelectedNode] = useState<NodeObject | null>(null)
  const [hoveredNode, setHoveredNode]   = useState<NodeObject | null>(null)
  const [ForceGraph2D, setForceGraph2D] = useState<ComponentType<Record<string, unknown>> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const fgRef        = useRef<any>(null)

  useEffect(() => {
    import('react-force-graph-2d')
      .then(mod => setForceGraph2D(() => mod.default as unknown as ComponentType<Record<string, unknown>>))
      .catch(err => console.error('[GraphClient] failed to load react-force-graph-2d:', err))
  }, [])

  // Refs so force callback always reads latest values without stale closure
  const focusPosRef       = useRef({ x: 0, y: 0 })
  const selectedTickerRef = useRef<string | null>(null)
  const connectedSetRef   = useRef<Set<string>>(new Set())

  // Memoized so clicking/hovering a node (which only updates selectedNode/
  // hoveredNode state) doesn't hand ForceGraph2D a brand-new graphData object
  // every render — react-force-graph treats a new graphData reference as a
  // fresh dataset and restarts its simulation from scratch, which is what was
  // causing every node click to make the whole graph blank out for several
  // seconds before resettling into the same layout.
  const graphData = useMemo(() => {
    const degreeMap = new Map<string, number>()
    for (const e of data.edges) {
      degreeMap.set(e.from, (degreeMap.get(e.from) ?? 0) + 1)
      degreeMap.set(e.to,   (degreeMap.get(e.to)   ?? 0) + 1)
    }

    const nodes: NodeObject[] = data.nodes.map(n => ({
      ...n,
      degree: degreeMap.get(n.ticker) ?? 0,
    }))

    const links: LinkObject[] = data.edges.map(e => ({
      source: e.from, target: e.to, type: e.type, strength: e.strength,
    }))

    return { nodes, links }
  }, [data])

  // Default spread forces — applied once the graph component (and its ref) is ready
  useEffect(() => {
    if (!fgRef.current) return
    fgRef.current.d3Force('charge')?.strength(-600)
    fgRef.current.d3Force('link')?.distance(160)
  }, [ForceGraph2D])

  const handleEngineStop = useCallback(() => {
    fgRef.current?.pauseAnimation()
  }, [])

  // Install the focus force (reads refs, so no stale closures)
  const installFocusForce = useCallback(() => {
    const fg = fgRef.current
    if (!fg) return

    fg.d3Force('focus', (alpha: number) => {
      const ticker    = selectedTickerRef.current
      const connected = connectedSetRef.current
      const fx        = focusPosRef.current.x
      const fy        = focusPosRef.current.y

      if (!ticker) return

      const graphNodes: NodeObject[] = fg.graphData().nodes
      const connectedNodes = graphNodes.filter(n => connected.has(n.ticker) && n.ticker !== ticker)

      for (const n of graphNodes) {
        if (n.x == null || n.y == null) continue

        if (n.ticker === ticker) {
          // Lock selected node at its click position (centre of view)
          n.vx = ((n.vx ?? 0) + (fx - n.x) * alpha * 1.5)
          n.vy = ((n.vy ?? 0) + (fy - n.y) * alpha * 1.5)
        } else if (connected.has(n.ticker)) {
          // Pull connected nodes into a ring ~200px around focus
          const dx   = n.x - fx
          const dy   = n.y - fy
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          const target = 200
          const pull   = (dist - target) / dist
          n.vx = ((n.vx ?? 0) + -dx * pull * alpha * 2.0)
          n.vy = ((n.vy ?? 0) + -dy * pull * alpha * 2.0)

          // Spread connected nodes around the ring (mutual repulsion)
          for (const other of connectedNodes) {
            if (other.ticker === n.ticker || other.x == null || other.y == null) continue
            const odx  = n.x - other.x
            const ody  = n.y - other.y
            const odist = Math.sqrt(odx * odx + ody * ody) || 1
            if (odist < 150) {
              const repel = 100 / (odist * odist)
              n.vx = ((n.vx ?? 0) + odx * repel * alpha)
              n.vy = ((n.vy ?? 0) + ody * repel * alpha)
            }
          }
        } else {
          // Push unconnected nodes far away from focus
          const dx   = n.x - fx
          const dy   = n.y - fy
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          n.vx = ((n.vx ?? 0) + (dx / dist) * 700 * alpha)
          n.vy = ((n.vy ?? 0) + (dy / dist) * 700 * alpha)
        }
      }
    })
  }, [])

  const runPhysics = useCallback((ms: number) => {
    fgRef.current?.d3ReheatSimulation()
    fgRef.current?.resumeAnimation()
    setTimeout(() => fgRef.current?.pauseAnimation(), ms)
  }, [])

  const handleNodeClick = useCallback((node: object) => {
    const n = node as NodeObject
    setSelectedNode(n)

    // Record focus position and connected set in refs
    focusPosRef.current       = { x: n.x ?? 0, y: n.y ?? 0 }
    selectedTickerRef.current = n.ticker
    connectedSetRef.current   = new Set(
      data.edges
        .filter(e => e.from === n.ticker || e.to === n.ticker)
        .flatMap(e => [e.from, e.to])
    )

    // Centre the camera on the clicked node
    fgRef.current?.centerAt(n.x, n.y, 600)

    // Zero out link + weaken charge so focus force fully controls layout
    const fg = fgRef.current
    if (fg) {
      fg.d3Force('link')?.strength(0)
      fg.d3Force('charge')?.strength(-40)
    }

    installFocusForce()
    runPhysics(3000)
  }, [data.edges, installFocusForce, runPhysics])

  const handleBgClick = useCallback(() => {
    setSelectedNode(null)
    selectedTickerRef.current = null
    connectedSetRef.current   = new Set()

    // Remove focus force, restore defaults, re-spread
    const fg = fgRef.current
    if (!fg) return
    fg.d3Force('focus', null)
    fg.d3Force('charge')?.strength(-600)
    fg.d3Force('link')?.strength(1).distance(160)

    // Zoom back out to full graph
    fg.centerAt(0, 0, 600)
    fg.zoom(1, 600)
    runPhysics(2000)
  }, [runPhysics])

  const handleNodeHover = useCallback((node: object | null) => {
    setHoveredNode(node ? node as NodeObject : null)
  }, [])

  // Derive connected set for rendering (from state, not ref)
  const nodeEdges = selectedNode
    ? data.edges.filter(e => e.from === selectedNode.ticker || e.to === selectedNode.ticker)
    : []

  const paintNode = useCallback((node: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const n = node as NodeObject
    if (n.x == null || n.y == null) return

    const radius     = Math.max(8, Math.min(26, n.degree * 1.8 + 8))
    const color      = tickerColor(n.ticker)
    const isSelected  = selectedTickerRef.current === n.ticker
    const isConnected = connectedSetRef.current.has(n.ticker)
    const isHovered   = hoveredNode?.ticker === n.ticker
    const dimmed      = selectedTickerRef.current && !isSelected && !isConnected

    // Glow for selected / hovered
    if (isSelected || isHovered) {
      ctx.beginPath()
      ctx.arc(n.x, n.y, radius + 6, 0, 2 * Math.PI)
      ctx.fillStyle = isSelected ? color + '55' : color + '22'
      ctx.fill()
    }

    // Circle
    ctx.beginPath()
    ctx.arc(n.x, n.y, radius, 0, 2 * Math.PI)
    ctx.fillStyle = dimmed ? color + '18' : color
    ctx.fill()

    // Border
    ctx.beginPath()
    ctx.arc(n.x, n.y, radius, 0, 2 * Math.PI)
    ctx.strokeStyle = isSelected ? '#ffffff' : dimmed ? color + '10' : color + 'cc'
    ctx.lineWidth   = isSelected ? 2.5 : 1.5
    ctx.stroke()

    // Ticker text inside node
    const fontSize = Math.max(7, Math.min(radius * 0.65, 13 / globalScale))
    ctx.font         = `700 ${fontSize}px -apple-system, sans-serif`
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle    = dimmed ? '#ffffff10' : '#ffffff'
    ctx.fillText(n.ticker.length > 5 ? n.ticker.slice(0, 5) : n.ticker, n.x, n.y)

    // Company label: always for selected/connected/hovered; only when zoomed for others
    const showLabel = isSelected || isConnected || isHovered || (!selectedTickerRef.current && globalScale > 1.0)
    if (showLabel && !dimmed) {
      const lfs   = Math.max(6, (isSelected ? 10 : 8) / globalScale)
      const label = n.company.length > 22 ? n.company.slice(0, 20) + '…' : n.company
      ctx.font    = `${isSelected ? 600 : 400} ${lfs}px -apple-system, sans-serif`
      const lw    = ctx.measureText(label).width
      const ly    = n.y + radius + lfs * 1.4

      const pad = lfs * 0.4
      const rx = n.x - lw / 2 - pad, ry = ly - lfs * 0.8
      const rw = lw + pad * 2,        rh = lfs * 1.6
      const r  = 3
      ctx.fillStyle = '#0a0a0fee'
      ctx.beginPath()
      ctx.moveTo(rx + r, ry);           ctx.lineTo(rx + rw - r, ry)
      ctx.arcTo(rx + rw, ry, rx + rw, ry + r, r)
      ctx.lineTo(rx + rw, ry + rh - r)
      ctx.arcTo(rx + rw, ry + rh, rx + rw - r, ry + rh, r)
      ctx.lineTo(rx + r, ry + rh)
      ctx.arcTo(rx, ry + rh, rx, ry + rh - r, r)
      ctx.lineTo(rx, ry + r);           ctx.arcTo(rx, ry, rx + r, ry, r)
      ctx.closePath(); ctx.fill()

      ctx.fillStyle    = isSelected ? '#e2e8f0' : '#94a3b8'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, n.x, ly)
    }
  }, [hoveredNode])

  const paintLink = useCallback((link: object, ctx: CanvasRenderingContext2D) => {
    const l   = link as LinkObject
    const src = l.source as NodeObject
    const tgt = l.target as NodeObject
    if (src.x == null || src.y == null || tgt.x == null || tgt.y == null) return

    const srcTicker = (typeof l.source === 'object') ? (l.source as NodeObject).ticker : l.source as string
    const tgtTicker = (typeof l.target === 'object') ? (l.target as NodeObject).ticker : l.target as string
    const sel        = selectedTickerRef.current
    const isHighlighted = sel && (srcTicker === sel || tgtTicker === sel)
    const alpha = isHighlighted ? 1.0 : (sel ? 0.03 : (STRENGTH_ALPHA[l.strength] ?? 0.4))
    const baseWidth = STRENGTH_WIDTH[l.strength] ?? 1

    ctx.strokeStyle = isHighlighted ? '#818cf8' : `rgba(156,163,175,${alpha})`
    ctx.lineWidth   = isHighlighted ? baseWidth * 2.5 : baseWidth
    ctx.beginPath()
    ctx.moveTo(src.x, src.y)
    ctx.lineTo(tgt.x, tgt.y)
    ctx.stroke()
  }, [])

  return (
    <div className="flex h-full gap-4">
      <div
        className="flex-1 bg-bg-card border border-border-subtle rounded-lg overflow-hidden relative"
        ref={containerRef}
      >
        {/* Legend */}
        <div className="absolute top-3 left-3 z-10 flex flex-col gap-1 pointer-events-none">
          {[
            { label: 'Strong', w: 'w-6', opacity: 'opacity-90' },
            { label: 'Medium', w: 'w-4', opacity: 'opacity-50' },
            { label: 'Weak',   w: 'w-3', opacity: 'opacity-25' },
          ].map(({ label, w, opacity }) => (
            <div key={label} className="flex items-center gap-2">
              <div className={`h-px ${w} bg-indigo-active ${opacity}`} />
              <span className="text-[9px] text-text-muted">{label}</span>
            </div>
          ))}
        </div>

        <div className="absolute top-3 right-3 z-10 text-[9px] text-text-muted pointer-events-none">
          {selectedNode ? 'Click background to reset' : 'Click node to focus · Scroll to zoom'}
        </div>

        {ForceGraph2D && (
          <ForceGraph2D
            ref={fgRef}
            graphData={graphData}
            nodeId="ticker"
            nodeVal={(node: object) => Math.max(8, Math.min(26, (node as NodeObject).degree * 1.8 + 8))}
            linkColor={() => 'rgba(156,163,175,0.35)'}
            backgroundColor="#111118"
            onNodeClick={handleNodeClick}
            onNodeHover={handleNodeHover}
            onBackgroundClick={handleBgClick}
            onEngineStop={handleEngineStop}
            nodeCanvasObjectMode={() => 'replace'}
            nodeCanvasObject={paintNode}
            linkCanvasObjectMode={() => 'replace'}
            linkCanvasObject={paintLink}
            warmupTicks={100}
            cooldownTicks={150}
            d3AlphaDecay={0.03}
            d3VelocityDecay={0.45}
            width={containerRef.current?.clientWidth ?? 700}
            height={containerRef.current?.clientHeight ?? 560}
          />
        )}
      </div>

      {/* Detail panel */}
      {selectedNode && (
        <div className="w-72 bg-bg-card border border-border-subtle rounded-lg p-4 flex-shrink-0 overflow-y-auto space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-sm font-bold mb-0.5" style={{ color: tickerColor(selectedNode.ticker) }}>
                {selectedNode.ticker}
              </div>
              <div className="text-[11px] text-text-secondary leading-snug">{selectedNode.company}</div>
            </div>
            <button onClick={handleBgClick} className="text-text-muted hover:text-text-primary text-xs mt-0.5 flex-shrink-0">✕</button>
          </div>

          <div className="text-[10px] text-text-muted">
            <span className="text-text-secondary font-medium">{selectedNode.degree}</span> connections
          </div>

          {selectedNode.themes?.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-text-muted mb-1.5">Themes</div>
              <div className="flex flex-wrap gap-1">
                {selectedNode.themes.map(t => (
                  <span key={t} className="bg-accent-primary/10 text-indigo-active text-[10px] px-2 py-0.5 rounded-full border border-accent-primary/20">{t}</span>
                ))}
              </div>
            </div>
          )}

          {nodeEdges.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-text-muted mb-1.5">Edges ({nodeEdges.length})</div>
              <div className="space-y-2">
                {nodeEdges.map((e: GraphEdge, i: number) => {
                  const peer = e.from === selectedNode.ticker ? e.to : e.from
                  const dir  = e.from === selectedNode.ticker ? '→' : '←'
                  return (
                    <div key={i} className="bg-bg-sidebar rounded p-2 text-[10px]">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-text-muted">{dir}</span>
                        <span className="font-semibold text-indigo-active">{peer}</span>
                        <span className={`ml-auto px-1.5 py-0.5 rounded text-[9px] font-medium ${
                          e.strength === 'strong' ? 'bg-green-signal/10 text-green-signal' :
                          e.strength === 'medium' ? 'bg-amber-signal/10 text-amber-signal' :
                          'bg-border-subtle text-text-muted'
                        }`}>{e.strength}</span>
                      </div>
                      <div className="text-text-muted">{e.type}</div>
                      {e.description && <div className="text-text-muted mt-0.5 leading-snug">{e.description}</div>}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
