// Claim governance — the read-only handoff between an ephemeral agent and
// durable storage. Canonical protocol: .claude/agents/CLAIM-PROTOCOL.md
//
// THE RULE:
//   Agents decide and emit structured governance events. Orchestration
//   persists them. No agent receives direct write authority.
//
// That is enforced by PostgreSQL, not by this file. Specialists, Vizier and
// Warden authenticate as `ai_capital_agent` (SELECT only). Only orchestration
// holds `ai_capital_claim_writer`, which can write desk.agent_claims and
// desk.agent_runs and nothing else in the cluster.
//
// STRICTNESS IS THE POINT. The first version ignored unknown keys, which meant
// renaming a field would silently corrupt four agents' output, and a typo'd
// `invalidated-if` was swallowed into the previous field's text with no error.
// A malformed batch now fails as a batch: a partially-landed set reads as a
// complete record and is not one.

import pg from 'pg'
import { getPool, inTestRuntime, createPool } from './pool.js'

export const CLAIM_PROTOCOL = 'claim/1'

export type ClaimType = 'factual' | 'interpretation' | 'forecast' | 'recommendation' | 'risk_warning'
export type Confidence = 'high' | 'medium' | 'low'
export type CaptureMethod = 'self' | 'challenger' | 'orchestrator'
export type VerificationStatus = 'unverified' | 'verified' | 'unsupported' | 'unverifiable'
export type ResolutionType =
  | 'confirmed' | 'falsified' | 'invalidated' | 'retracted' | 'superseded' | 'expired'

const CLAIM_TYPES: ClaimType[] = ['factual', 'interpretation', 'forecast', 'recommendation', 'risk_warning']
const CONFIDENCES: Confidence[] = ['high', 'medium', 'low']
/** Types that assert something about the future and must be falsifiable. */
const FORWARD_LOOKING: ClaimType[] = ['forecast', 'risk_warning']

const CLAIM_KEYS = new Set([
  'protocol', 'claimant', 'domain', 'type', 'confidence', 'horizon',
  'claim', 'evidence', 'invalidated_if', 'supersedes_concept',
])
const CAPTURE_KEYS = new Set([...CLAIM_KEYS, 'recorded_by'])
const EVENT_KEYS = new Set(['protocol', 'event', 'claim_id', 'actor', 'evidence'])

export type ClaimEvent =
  | 'verify_supported' | 'verify_unsupported' | 'verify_unverifiable'
  | 'confirm' | 'falsify' | 'invalidate' | 'retract'

const EVENTS: ClaimEvent[] = [
  'verify_supported', 'verify_unsupported', 'verify_unverifiable',
  'confirm', 'falsify', 'invalidate', 'retract',
]

export interface ParsedClaim {
  claimant: string
  recordedBy: string
  captureMethod: CaptureMethod
  domain: string
  claim: string
  claimType: ClaimType
  confidence: Confidence
  horizon?: string | null
  invalidationCondition?: string | null
  evidence?: string | null
  /** Plain-language reference to a prior claim; orchestration resolves the id. */
  supersedesConcept?: string | null
}

export interface ParsedEvent {
  event: ClaimEvent
  claimId: number
  actor: string
  evidence?: string | null
}

/** Where the claim was actually made — so a reputation is always auditable. */
export interface ClaimProvenance {
  sourceSession?: string | null
  sourceAgentRun?: string | null
  sourceArtifact?: string | null
  sourceContext?: string | null
}

export class ClaimParseError extends Error {
  constructor(message: string, public readonly block?: string) {
    super(message)
    this.name = 'ClaimParseError'
  }
}

// ── Parsing ────────────────────────────────────────────────────────────────

function fieldsOf(raw: string, allowed: Set<string>, kind: string): Map<string, string> {
  const fields = new Map<string, string>()
  let currentKey: string | null = null
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/)
    if (m) {
      const key = m[1].toLowerCase()
      if (!allowed.has(key)) {
        throw new ClaimParseError(
          `unknown key "${key}" in a ${kind} block. Unknown keys are an error, not ignored — ` +
          `silently discarding one means a future rename corrupts every agent's output. ` +
          `Allowed: ${[...allowed].sort().join(', ')}`, raw)
      }
      if (fields.has(key)) {
        throw new ClaimParseError(`duplicate key "${key}" in a ${kind} block`, raw)
      }
      fields.set(key, m[2].trim())
      currentKey = key
    } else if (currentKey && line.trim() !== '') {
      fields.set(currentKey, `${fields.get(currentKey)} ${line.trim()}`.trim())
    }
  }
  return fields
}

function requireProtocol(fields: Map<string, string>, raw: string): void {
  const p = fields.get('protocol')
  if (!p) throw new ClaimParseError(`missing "protocol" — expected ${CLAIM_PROTOCOL}`, raw)
  if (p !== CLAIM_PROTOCOL) {
    throw new ClaimParseError(
      `protocol version mismatch: block says "${p}", this parser speaks ${CLAIM_PROTOCOL}`, raw)
  }
}

function blocksOf(text: string, fence: string): string[] {
  const re = new RegExp('```' + fence + '\\s*\\n([\\s\\S]*?)```', 'g')
  return [...text.matchAll(re)].map(m => m[1])
}

function parseClaimLike(raw: string, capture: CaptureMethod): ParsedClaim {
  const allowed = capture === 'challenger' ? CAPTURE_KEYS : CLAIM_KEYS
  const kind = capture === 'challenger' ? 'claim-capture' : 'claim'
  const f = fieldsOf(raw, allowed, kind)
  requireProtocol(f, raw)

  const need = (k: string): string => {
    const v = f.get(k)
    if (!v) throw new ClaimParseError(`missing required field "${k}" in a ${kind} block`, raw)
    return v
  }
  const opt = (k: string) => {
    const v = f.get(k)
    return v && v !== '-' && v.toLowerCase() !== 'none' ? v : null
  }

  const claimType = need('type').toLowerCase() as ClaimType
  if (!CLAIM_TYPES.includes(claimType)) {
    throw new ClaimParseError(
      `unknown claim type "${claimType}" (expected ${CLAIM_TYPES.join(', ')})`, raw)
  }
  const confidence = need('confidence').toLowerCase() as Confidence
  if (!CONFIDENCES.includes(confidence)) {
    throw new ClaimParseError(`unknown confidence "${confidence}" (expected high, medium or low)`, raw)
  }

  const invalidation = opt('invalidated_if')
  // Required for forward-looking types only. Demanding it of a plain fact would
  // just produce invented disconfirming conditions, which is worse than none.
  if (FORWARD_LOOKING.includes(claimType) && !invalidation) {
    throw new ClaimParseError(
      `a "${claimType}" claim must state invalidated_if — a claim nobody could disprove ` +
      'is not a claim. If no disconfirming observation exists, say so in that field.', raw)
  }

  const claimant = need('claimant').toLowerCase()
  const recordedBy = capture === 'challenger' ? need('recorded_by').toLowerCase() : claimant
  if (capture === 'challenger' && recordedBy === claimant) {
    throw new ClaimParseError(
      'a challenger capture must name a recorded_by different from the claimant — otherwise ' +
      'a reconstructed claim would masquerade as a voluntary self-declaration', raw)
  }

  return {
    claimant,
    recordedBy,
    captureMethod: capture,
    domain: need('domain').toLowerCase(),
    claim: need('claim'),
    claimType,
    confidence,
    horizon: opt('horizon'),
    invalidationCondition: invalidation,
    evidence: opt('evidence'),
    supersedesConcept: opt('supersedes_concept'),
  }
}

/** Self-declared ```claim blocks. Throws on the first malformed block. */
export function parseClaimBlocks(text: string): ParsedClaim[] {
  return blocksOf(text, 'claim').map(raw => parseClaimLike(raw, 'self'))
}

/** Challenger-captured ```claim-capture blocks (Vizier recording for someone else). */
export function parseCaptureBlocks(text: string): ParsedClaim[] {
  return blocksOf(text, 'claim-capture').map(raw => parseClaimLike(raw, 'challenger'))
}

/** ```claim-event blocks — verification and resolution. */
export function parseEventBlocks(text: string): ParsedEvent[] {
  return blocksOf(text, 'claim-event').map(raw => {
    const f = fieldsOf(raw, EVENT_KEYS, 'claim-event')
    requireProtocol(f, raw)
    const need = (k: string): string => {
      const v = f.get(k)
      if (!v) throw new ClaimParseError(`missing required field "${k}" in a claim-event block`, raw)
      return v
    }
    const event = need('event').toLowerCase() as ClaimEvent
    if (!EVENTS.includes(event)) {
      throw new ClaimParseError(`unknown event "${event}" (expected ${EVENTS.join(', ')})`, raw)
    }
    const idRaw = need('claim_id')
    if (!/^\d+$/.test(idRaw)) throw new ClaimParseError(`claim_id must be numeric, got "${idRaw}"`, raw)
    return { event, claimId: Number(idRaw), actor: need('actor').toLowerCase(), evidence: f.get('evidence') ?? null }
  })
}

// ── Persistence ────────────────────────────────────────────────────────────

/**
 * The claim-writer pool. Separate from getPool() on purpose: this is the ONLY
 * credential in the system that can write claims, and it can write nothing
 * else. Falls back to the default pool when unset so tests can exercise the
 * logic against the throwaway database.
 */
let writerPool: pg.Pool | null = null
function writer(): pg.Pool | ReturnType<typeof getPool> {
  // ── A HOLE I MADE, AND THE FIX ────────────────────────────────────────────
  // The first version of this function opened its own pool from
  // CLAIM_WRITER_DATABASE_URL unconditionally. That bypassed EVERY guard built
  // during the 2026-08-25 incident response — the vitest isolation setup clears
  // DATABASE_URL, not this variable; getPool()'s live-database refusal was never
  // consulted; and the claim-writer role legitimately holds production INSERT,
  // so PostgreSQL allowed it. Running the suite once put 16 fixture claims and
  // 6 run records into the production book.
  //
  // The lesson generalises: a NEW credential with a NEW pool re-opens a closed
  // hole, because every existing guard was written against the old path.
  //
  // Under vitest, the writer is ALWAYS the ordinary test pool — which the
  // bootstrap has already pointed at the throwaway database, and which cannot
  // reach production because ai_capital_test_runtime has no CONNECT there.
  if (inTestRuntime()) return getPool()

  const url = process.env.CLAIM_WRITER_DATABASE_URL
  if (!url) return getPool()
  // createPool carries the destination+runtime guard, so this path cannot
  // re-open the hole even if the check above is ever removed.
  if (!writerPool) writerPool = createPool(url, { max: 2 })
  return writerPool
}
export async function closeClaimWriter(): Promise<void> {
  if (writerPool) { await writerPool.end(); writerPool = null }
}

export interface PersistResult {
  detected: number
  parsed: number
  persisted: number
  ids: number[]
  ambiguous: Array<{ claim: string; concept: string; candidates: number[] }>
  errors: string[]
}

/**
 * Resolve a plain-language `supersedes_concept` to a prior claim id.
 *
 * Specialists start cold and cannot know database ids, so they describe what
 * they are replacing. Ambiguity is NOT guessed away — an incorrect lineage link
 * would quietly rewrite the history this table exists to preserve.
 */
async function resolveSupersedes(
  db: pg.Pool | ReturnType<typeof getPool>,
  claimant: string,
  domain: string,
): Promise<number[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM desk.agent_claims
      WHERE lower(claimant) = lower($1) AND lower(domain) = lower($2)
        AND resolution_type IS NULL
      ORDER BY asserted_at DESC LIMIT 5`,
    [claimant, domain],
  )
  return rows.map(r => Number(r.id))
}

/**
 * Persist a batch. ALL OR NOTHING — a partially-landed batch reads as a
 * complete record and is not one.
 */
export async function recordClaims(
  claims: ParsedClaim[],
  provenance: ClaimProvenance,
): Promise<PersistResult> {
  const result: PersistResult = { detected: claims.length, parsed: claims.length, persisted: 0, ids: [], ambiguous: [], errors: [] }
  if (claims.length === 0) return result

  if (!provenance.sourceSession && !provenance.sourceArtifact) {
    throw new ClaimParseError(
      'refusing to persist without provenance: at least one of sourceSession or sourceArtifact ' +
      'is required. A reputation record detached from its context is worse than none.')
  }

  const db = writer()
  const client = await (db as pg.Pool).connect()
  try {
    await client.query('BEGIN')
    for (const c of claims) {
      let supersedes: number | null = null
      if (c.supersedesConcept) {
        const candidates = await resolveSupersedes(client as unknown as pg.Pool, c.claimant, c.domain)
        if (candidates.length === 1) supersedes = candidates[0]
        else if (candidates.length > 1) {
          // Do not guess. Surface it; Vizier chooses explicitly.
          result.ambiguous.push({ claim: c.claim, concept: c.supersedesConcept, candidates })
        }
      }
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO desk.agent_claims
           (claimant, recorded_by, capture_method, protocol_version, domain, claim,
            claim_type, confidence, horizon, invalidation_condition, evidence,
            source_session, source_agent_run, source_artifact, source_context,
            supersedes_claim_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING id`,
        [c.claimant, c.recordedBy, c.captureMethod, CLAIM_PROTOCOL, c.domain, c.claim,
         c.claimType, c.confidence, c.horizon ?? null, c.invalidationCondition ?? null, c.evidence ?? null,
         provenance.sourceSession ?? null, provenance.sourceAgentRun ?? null,
         provenance.sourceArtifact ?? null, provenance.sourceContext ?? null,
         supersedes],
      )
      const id = Number(rows[0].id)
      result.ids.push(id)
      if (supersedes !== null) {
        await client.query(
          `UPDATE desk.agent_claims SET resolution_type='superseded', resolved_at=now(),
                  outcome_evidence=$2 WHERE id=$1 AND resolution_type IS NULL`,
          [supersedes, `superseded by claim ${id}`])
      }
    }
    await client.query('COMMIT')
    result.persisted = result.ids.length
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    result.errors.push((err as Error).message)
    throw err
  } finally {
    client.release()
  }
  return result
}

/** Apply a verification or resolution event emitted by Vizier. */
export async function applyEvent(e: ParsedEvent): Promise<void> {
  const db = writer()
  const VERIFY: Partial<Record<ClaimEvent, VerificationStatus>> = {
    verify_supported: 'verified', verify_unsupported: 'unsupported', verify_unverifiable: 'unverifiable',
  }
  const RESOLVE: Partial<Record<ClaimEvent, ResolutionType>> = {
    confirm: 'confirmed', falsify: 'falsified', invalidate: 'invalidated', retract: 'retracted',
  }
  if (VERIFY[e.event]) {
    await db.query(
      `UPDATE desk.agent_claims SET verification_status=$2, verified_by=$3,
              verification_evidence=$4, verified_at=now() WHERE id=$1`,
      [e.claimId, VERIFY[e.event], e.actor, e.evidence ?? null])
  } else if (RESOLVE[e.event]) {
    await db.query(
      `UPDATE desk.agent_claims SET resolution_type=$2, outcome_evidence=$3, resolved_at=now()
        WHERE id=$1`,
      [e.claimId, RESOLVE[e.event], e.evidence ?? null])
  }
}

/** Record that a run happened, so non-emission is measurable. */
export async function recordAgentRun(run: {
  agent: string
  sessionId?: string | null
  runRef?: string | null
  taskSummary?: string | null
  material: boolean
  detected: number
  parsed: number
  persisted: number
  parseErrors?: string | null
}): Promise<void> {
  await writer().query(
    `INSERT INTO desk.agent_runs
       (agent, session_id, run_ref, task_summary, material,
        blocks_detected, blocks_parsed, claims_persisted, parse_errors)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [run.agent, run.sessionId ?? null, run.runRef ?? null, run.taskSummary ?? null,
     run.material, run.detected, run.parsed, run.persisted, run.parseErrors ?? null])
}

/**
 * The whole orchestration path for one agent run: detect, parse, attach
 * provenance, persist, and report counts.
 *
 * Reports `detected` vs `parsed` vs `persisted` separately so "nobody emitted a
 * claim" is distinguishable from "a claim was emitted and failed to land".
 * Silent disappearance is the failure this function exists to prevent.
 */
export async function ingestAgentOutput(opts: {
  agent: string
  text: string
  material: boolean
  provenance: ClaimProvenance
  taskSummary?: string
}): Promise<PersistResult> {
  const { agent, text, material, provenance } = opts
  const detected = blocksOf(text, 'claim').length + blocksOf(text, 'claim-capture').length
  let parsed = 0
  let persisted = 0
  const errors: string[] = []
  let out: PersistResult = { detected, parsed: 0, persisted: 0, ids: [], ambiguous: [], errors }

  try {
    const claims = [...parseClaimBlocks(text), ...parseCaptureBlocks(text)]
    parsed = claims.length
    if (claims.length > 0) {
      const r = await recordClaims(claims, provenance)
      persisted = r.persisted
      out = { ...r, detected, errors }
    } else {
      out = { detected, parsed, persisted: 0, ids: [], ambiguous: [], errors }
    }
    for (const e of parseEventBlocks(text)) await applyEvent(e)
  } catch (err) {
    errors.push((err as Error).message)
    out = { detected, parsed, persisted, ids: out.ids, ambiguous: out.ambiguous, errors }
  }

  await recordAgentRun({
    agent, material, detected, parsed, persisted,
    sessionId: provenance.sourceSession, runRef: provenance.sourceAgentRun,
    taskSummary: opts.taskSummary ?? provenance.sourceContext,
    parseErrors: errors.length ? errors.join(' | ') : null,
  }).catch(e => errors.push(`run record failed: ${(e as Error).message}`))

  return out
}

export interface ClaimRow {
  id: number
  claimant: string
  recordedBy: string
  captureMethod: CaptureMethod
  domain: string
  claim: string
  claimType: ClaimType
  confidence: Confidence
  verificationStatus: VerificationStatus
  resolutionType: ResolutionType | null
  assertedAt: string
}

/**
 * Descriptive history for one claimant+domain. Returns rows, never a score —
 * the consumer is required to read this as context, and handing back a single
 * number would invite exactly the leaderboard this design excludes.
 */
export async function claimHistory(claimant: string, domain?: string, limit = 50): Promise<ClaimRow[]> {
  const { rows } = await getPool().query(
    `SELECT id, claimant, recorded_by, capture_method, domain, claim, claim_type,
            confidence, verification_status, resolution_type, asserted_at
       FROM desk.agent_claims
      WHERE lower(claimant) = lower($1) AND ($2::text IS NULL OR lower(domain) = lower($2))
      ORDER BY asserted_at DESC LIMIT $3`,
    [claimant, domain ?? null, limit])
  return rows.map(r => ({
    id: Number(r.id), claimant: r.claimant, recordedBy: r.recorded_by,
    captureMethod: r.capture_method, domain: r.domain, claim: r.claim,
    claimType: r.claim_type, confidence: r.confidence,
    verificationStatus: r.verification_status, resolutionType: r.resolution_type,
    assertedAt: r.asserted_at,
  }))
}
