// Claim-level specialist memory — the read-only handoff between an ephemeral
// specialist agent and durable storage.
//
// THE CONSTRAINT THAT SHAPES THIS FILE: the investment specialists (Atlas,
// Cassandra, Ledger, Sentinel) are read-only by design. They advise; Neil
// decides; only then does deterministic execution touch anything. Giving them
// database write access purely to support calibration would trade a real safety
// property for a bookkeeping convenience.
//
// So they emit a fenced ```claim block at the end of material analysis, exactly
// the way Glenn already emits `VOCAB:` lines. The orchestration layer parses it
// and writes. The agent never holds a connection.
//
// Emitting a claim is an ASSERTION, never a verification. See verifyClaim.

import { getPool } from './pool.js'

export type ClaimType = 'factual' | 'interpretation' | 'forecast' | 'recommendation' | 'risk_warning'
export type Confidence = 'high' | 'medium' | 'low'
export type VerificationStatus = 'unverified' | 'verified' | 'unsupported' | 'unverifiable'
export type ResolutionType =
  | 'confirmed' | 'falsified' | 'invalidated' | 'retracted' | 'superseded' | 'expired'

export interface ParsedClaim {
  agent:                  string
  domain:                 string
  claim:                  string
  claimType:              ClaimType
  confidence:             Confidence
  horizon?:               string | null
  invalidationCondition?: string | null
  evidence?:              string | null
  /** Set when a specialist explicitly marks this as replacing an earlier claim. */
  supersedesClaimId?:     number | null
}

/** Where the claim was actually made — so a reputation is always auditable. */
export interface ClaimProvenance {
  sourceSession?:  string | null
  sourceAgentRun?: string | null
  sourceArtifact?: string | null
  sourceContext?:  string | null
}

const CLAIM_TYPES: ClaimType[] = ['factual', 'interpretation', 'forecast', 'recommendation', 'risk_warning']
const CONFIDENCES: Confidence[] = ['high', 'medium', 'low']

export class ClaimParseError extends Error {
  constructor(message: string, public readonly block: string) {
    super(message)
    this.name = 'ClaimParseError'
  }
}

/**
 * Extract ```claim blocks from an agent's output.
 *
 * Deliberately strict about the five required keys and permissive about
 * everything else: a malformed block should fail loudly at parse time rather
 * than land a half-populated row that later reads as a real claim.
 *
 * Unknown keys are ignored rather than rejected, so adding a field to the block
 * format never breaks agents still emitting the old shape.
 */
export function parseClaimBlocks(text: string): ParsedClaim[] {
  const blocks = [...text.matchAll(/```claim\s*\n([\s\S]*?)```/g)].map(m => m[1])
  return blocks.map(raw => {
    const fields = new Map<string, string>()
    let currentKey: string | null = null
    for (const line of raw.split('\n')) {
      const m = line.match(/^([a-z_]+):\s*(.*)$/)
      if (m) {
        currentKey = m[1]
        fields.set(currentKey, m[2].trim())
      } else if (currentKey && line.trim() !== '') {
        // continuation line — claims and evidence are often more than one line
        fields.set(currentKey, `${fields.get(currentKey)} ${line.trim()}`.trim())
      }
    }

    const need = (k: string): string => {
      const v = fields.get(k)
      if (!v) throw new ClaimParseError(`claim block is missing required field "${k}"`, raw)
      return v
    }

    const claimType = need('type') as ClaimType
    if (!CLAIM_TYPES.includes(claimType)) {
      throw new ClaimParseError(`unknown claim type "${claimType}" (expected one of ${CLAIM_TYPES.join(', ')})`, raw)
    }
    const confidence = need('confidence').toLowerCase() as Confidence
    if (!CONFIDENCES.includes(confidence)) {
      throw new ClaimParseError(`unknown confidence "${confidence}" (expected high, medium or low)`, raw)
    }

    const supersedes = fields.get('supersedes')
    const opt = (k: string) => {
      const v = fields.get(k)
      return v && v !== '-' && v.toLowerCase() !== 'none' ? v : null
    }

    return {
      agent:                 need('agent').toLowerCase(),
      domain:                need('domain').toLowerCase(),
      claim:                 need('claim'),
      claimType,
      confidence,
      horizon:               opt('horizon'),
      invalidationCondition: opt('invalidated_if'),
      evidence:              opt('evidence'),
      supersedesClaimId:     supersedes && /^\d+$/.test(supersedes) ? Number(supersedes) : null,
    }
  })
}

/**
 * Persist asserted claims. Always lands as `unverified` — the emitting agent
 * does not get to certify its own work, and the schema enforces that too.
 */
export async function recordClaims(
  claims: ParsedClaim[],
  provenance: ClaimProvenance = {},
): Promise<number[]> {
  if (claims.length === 0) return []
  const pool = getPool()
  const ids: number[] = []
  for (const c of claims) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO desk.agent_claims
         (agent, domain, claim, claim_type, confidence, horizon,
          invalidation_condition, evidence,
          source_session, source_agent_run, source_artifact, source_context,
          supersedes_claim_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        c.agent, c.domain, c.claim, c.claimType, c.confidence, c.horizon ?? null,
        c.invalidationCondition ?? null, c.evidence ?? null,
        provenance.sourceSession ?? null, provenance.sourceAgentRun ?? null,
        provenance.sourceArtifact ?? null, provenance.sourceContext ?? null,
        c.supersedesClaimId ?? null,
      ],
    )
    ids.push(Number(rows[0].id))
  }
  return ids
}

/**
 * Record an INDEPENDENT check of whether the evidence supports a claim.
 *
 * This is not "was the claim right" — that is resolveClaim. A forecast can be
 * properly supported when made and still be overtaken by events; conflating the
 * two would punish a well-reasoned call that reality happened to contradict,
 * and that is precisely the calibration error this design exists to avoid.
 *
 * The database refuses `verifiedBy === agent`.
 */
export async function verifyClaim(
  claimId: number,
  opts: { status: Exclude<VerificationStatus, 'unverified'>; verifiedBy: string; evidence?: string },
): Promise<void> {
  await getPool().query(
    `UPDATE desk.agent_claims
        SET verification_status = $2, verified_by = $3,
            verification_evidence = $4, verified_at = now()
      WHERE id = $1`,
    [claimId, opts.status, opts.verifiedBy, opts.evidence ?? null],
  )
}

/**
 * Record what eventually happened. The six resolution types are not
 * interchangeable calibration events:
 *
 *   confirmed   — happened as claimed
 *   falsified   — the predicted outcome did not occur
 *   invalidated — the claim's OWN stated invalidation condition fired
 *   retracted   — withdrawn; the original evidence never supported it
 *   superseded  — replaced on genuinely new information
 *   expired     — horizon passed, outcome not determinable
 *
 * A specialist who updates rationally when the world changes ('superseded')
 * must not be scored like one who asserted something unsupported ('retracted').
 */
export async function resolveClaim(
  claimId: number,
  opts: { resolution: ResolutionType; evidence?: string },
): Promise<void> {
  await getPool().query(
    `UPDATE desk.agent_claims
        SET resolution_type = $2, outcome_evidence = $3, resolved_at = now()
      WHERE id = $1`,
    [claimId, opts.resolution, opts.evidence ?? null],
  )
}

/**
 * Replace an earlier claim with a later one, preserving both.
 *
 * The old row keeps its original text forever (the table's UPDATE trigger
 * refuses any edit to the assertion). It is marked `superseded`; the new row
 * points back at it. That is what makes "Atlas changed his mind because new
 * data arrived" legible three months later.
 */
export async function supersedeClaim(
  oldClaimId: number,
  newClaim: ParsedClaim,
  provenance: ClaimProvenance = {},
  reason?: string,
): Promise<number> {
  const [newId] = await recordClaims(
    [{ ...newClaim, supersedesClaimId: oldClaimId }],
    provenance,
  )
  await resolveClaim(oldClaimId, {
    resolution: 'superseded',
    evidence: reason ?? `superseded by claim ${newId}`,
  })
  return newId
}

export interface ClaimRow {
  id: number
  agent: string
  domain: string
  claim: string
  claimType: ClaimType
  confidence: Confidence
  horizon: string | null
  verificationStatus: VerificationStatus
  resolutionType: ResolutionType | null
  assertedAt: string
}

/**
 * Descriptive history for one agent+domain. Deliberately returns rows rather
 * than a score: the consumer (Vizier) is required to read this as context, not
 * to reduce it to a multiplier, and handing back a single number would invite
 * exactly that.
 */
export async function claimHistory(
  agent: string,
  domain?: string,
  limit = 50,
): Promise<ClaimRow[]> {
  const { rows } = await getPool().query(
    `SELECT id, agent, domain, claim, claim_type, confidence, horizon,
            verification_status, resolution_type, asserted_at
       FROM desk.agent_claims
      WHERE lower(agent) = lower($1)
        AND ($2::text IS NULL OR lower(domain) = lower($2))
      ORDER BY asserted_at DESC
      LIMIT $3`,
    [agent, domain ?? null, limit],
  )
  return rows.map(r => ({
    id: Number(r.id),
    agent: r.agent,
    domain: r.domain,
    claim: r.claim,
    claimType: r.claim_type,
    confidence: r.confidence,
    horizon: r.horizon,
    verificationStatus: r.verification_status,
    resolutionType: r.resolution_type,
    assertedAt: r.asserted_at,
  }))
}
