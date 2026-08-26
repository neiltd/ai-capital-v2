import { describe, it, expect, afterAll } from 'vitest'
import { parseClaimBlocks, ClaimParseError } from '../src/agent-claims.js'
import {
  recordClaims, verifyClaim, resolveClaim, supersedeClaim, claimHistory,
} from '../src/agent-claims.js'
import { getPool, closePool, usePostgres } from '../src/pool.js'

// The parser needs no database. The lifecycle tests do, and they are skipped
// when DATABASE_URL is unset so the suite still runs on a bare checkout.
const hasDb = usePostgres()
const dbIt = hasDb ? it : it.skip

const SAMPLE = `
Some ordinary analysis prose that should be ignored entirely.

\`\`\`claim
agent: atlas
domain: monetary-liquidity
type: forecast
confidence: medium
horizon: 3mo
claim: With overnight RRP exhausted, further TGA rebuild drains bank reserves
  directly rather than being absorbed.
evidence: macro.json — overnight RRP $0.38bn, TGA $953.6bn (+14.9bn/4wk)
invalidated_if: RRP rebuilds above ~$50bn, or TGA stops growing for 4+ weeks
\`\`\`

More prose.

\`\`\`claim
agent: sentinel
domain: sanctions
type: factual
confidence: high
claim: Treasury has deliberately spared the major Chinese banks from the
  60-entity action.
evidence: Reuters via BOE Report, 2026-08-24
invalidated_if: a major Chinese bank is named in a subsequent tranche
\`\`\`
`

describe('parseClaimBlocks', () => {
  it('extracts every claim block and ignores surrounding prose', () => {
    const claims = parseClaimBlocks(SAMPLE)
    expect(claims).toHaveLength(2)
    expect(claims.map(c => c.agent)).toEqual(['atlas', 'sentinel'])
  })

  it('joins continuation lines so a multi-line claim survives intact', () => {
    const [atlas] = parseClaimBlocks(SAMPLE)
    expect(atlas.claim).toBe(
      'With overnight RRP exhausted, further TGA rebuild drains bank reserves directly rather than being absorbed.',
    )
  })

  it('captures the invalidation condition — the field that makes a claim falsifiable', () => {
    const [atlas] = parseClaimBlocks(SAMPLE)
    expect(atlas.invalidationCondition).toMatch(/RRP rebuilds above/)
  })

  it('treats horizon as optional — a factual claim need not have one', () => {
    const [, sentinel] = parseClaimBlocks(SAMPLE)
    expect(sentinel.horizon).toBeNull()
    expect(sentinel.claimType).toBe('factual')
  })

  it('returns nothing when the text has no claim blocks', () => {
    expect(parseClaimBlocks('just an ordinary answer with no blocks')).toEqual([])
  })

  it('fails loudly on a missing required field rather than landing a half-row', () => {
    const bad = '```claim\nagent: atlas\ndomain: x\ntype: forecast\nconfidence: low\n```'
    expect(() => parseClaimBlocks(bad)).toThrow(ClaimParseError)
    expect(() => parseClaimBlocks(bad)).toThrow(/missing required field "claim"/)
  })

  it('rejects an unknown claim type', () => {
    const bad = '```claim\nagent: a\ndomain: d\ntype: vibes\nconfidence: low\nclaim: c\n```'
    expect(() => parseClaimBlocks(bad)).toThrow(/unknown claim type "vibes"/)
  })

  it('rejects an unknown confidence level', () => {
    const bad = '```claim\nagent: a\ndomain: d\ntype: forecast\nconfidence: certain\nclaim: c\n```'
    expect(() => parseClaimBlocks(bad)).toThrow(/unknown confidence "certain"/)
  })

  it('accepts type and confidence in any casing — a capitalised word must not discard the block', () => {
    const shouty = '```claim\nagent: Atlas\ndomain: Liquidity\ntype: Forecast\nconfidence: MEDIUM\nclaim: c\n```'
    const [c] = parseClaimBlocks(shouty)
    expect(c.claimType).toBe('forecast')
    expect(c.confidence).toBe('medium')
    expect(c.agent).toBe('atlas')
    expect(c.domain).toBe('liquidity')
  })

  it('ignores unknown keys so the format can grow without breaking old agents', () => {
    const withExtra =
      '```claim\nagent: a\ndomain: d\ntype: forecast\nconfidence: low\nclaim: c\nfuture_field: whatever\n```'
    expect(parseClaimBlocks(withExtra)[0].claim).toBe('c')
  })

  it('reads an explicit supersedes pointer', () => {
    const s = '```claim\nagent: a\ndomain: d\ntype: forecast\nconfidence: low\nclaim: c\nsupersedes: 42\n```'
    expect(parseClaimBlocks(s)[0].supersedesClaimId).toBe(42)
  })
})

describe('claim lifecycle (Postgres)', () => {
  const created: number[] = []

  afterAll(async () => {
    if (!hasDb) return
    if (created.length) {
      await getPool().query(
        'DELETE FROM desk.agent_claims WHERE id = ANY($1::bigint[])',
        [created],
      )
    }
    await closePool()
  })

  dbIt('an asserted claim lands unverified — emitting is not verifying', async () => {
    const [id] = await recordClaims(parseClaimBlocks(SAMPLE).slice(0, 1), {
      sourceSession: 'test', sourceContext: 'unit test',
    })
    created.push(id)
    const { rows } = await getPool().query(
      'SELECT verification_status, resolution_type, source_context FROM desk.agent_claims WHERE id=$1', [id])
    expect(rows[0].verification_status).toBe('unverified')
    expect(rows[0].resolution_type).toBeNull()
    expect(rows[0].source_context).toBe('unit test')   // provenance is retained
  })

  dbIt('the database refuses a specialist verifying its own claim', async () => {
    const [id] = await recordClaims(parseClaimBlocks(SAMPLE).slice(0, 1))
    created.push(id)
    await expect(
      verifyClaim(id, { status: 'verified', verifiedBy: 'atlas' }),
    ).rejects.toThrow(/independent_verification/)
    // ...but an independent party is fine
    await expect(
      verifyClaim(id, { status: 'verified', verifiedBy: 'vizier', evidence: 'checked macro.json' }),
    ).resolves.toBeUndefined()
  })

  dbIt('verification and resolution are separate events', async () => {
    const [id] = await recordClaims(parseClaimBlocks(SAMPLE).slice(0, 1))
    created.push(id)
    // properly supported when made...
    await verifyClaim(id, { status: 'verified', verifiedBy: 'vizier', evidence: 'primary source' })
    // ...and still overtaken by events later. That is NOT an integrity failure.
    await resolveClaim(id, { resolution: 'falsified', evidence: 'RRP rebuilt to $80bn' })
    const { rows } = await getPool().query(
      'SELECT verification_status, resolution_type FROM desk.agent_claims WHERE id=$1', [id])
    expect(rows[0].verification_status).toBe('verified')
    expect(rows[0].resolution_type).toBe('falsified')
  })

  dbIt('refuses to rewrite what was asserted — history is append-only', async () => {
    const [id] = await recordClaims(parseClaimBlocks(SAMPLE).slice(0, 1))
    created.push(id)
    await expect(
      getPool().query('UPDATE desk.agent_claims SET claim = $2 WHERE id = $1', [id, 'a tidier version']),
    ).rejects.toThrow(/assertion is immutable/)
  })

  dbIt('superseding preserves the original and links the replacement', async () => {
    const [oldId] = await recordClaims(parseClaimBlocks(SAMPLE).slice(0, 1))
    created.push(oldId)
    const next = { ...parseClaimBlocks(SAMPLE)[0], claim: 'Revised: reserves are ample after the RRP rebuild.' }
    const newId = await supersedeClaim(oldId, next, {}, 'RRP rebuilt above $50bn on 2026-09-14')
    created.push(newId)

    const { rows } = await getPool().query(
      'SELECT id, claim, resolution_type, supersedes_claim_id FROM desk.agent_claims WHERE id = ANY($1::bigint[]) ORDER BY id',
      [[oldId, newId]])
    // the original text is untouched and marked superseded, not retracted
    expect(rows[0].claim).toMatch(/^With overnight RRP exhausted/)
    expect(rows[0].resolution_type).toBe('superseded')
    // the new claim points back at what it replaced
    expect(Number(rows[1].supersedes_claim_id)).toBe(oldId)
  })

  dbIt('claimHistory returns rows, not a score', async () => {
    const [id] = await recordClaims(parseClaimBlocks(SAMPLE).slice(0, 1))
    created.push(id)
    const hist = await claimHistory('atlas', 'monetary-liquidity')
    expect(Array.isArray(hist)).toBe(true)
    expect(hist.length).toBeGreaterThan(0)
    expect(hist[0]).toHaveProperty('verificationStatus')
    expect(hist[0]).not.toHaveProperty('accuracy')   // by design
  })
})
