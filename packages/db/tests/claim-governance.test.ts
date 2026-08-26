import { describe, it, expect, afterAll } from 'vitest'
import {
  parseClaimBlocks, parseCaptureBlocks, parseEventBlocks,
  recordClaims, applyEvent, ingestAgentOutput, claimHistory,
  ClaimParseError, CLAIM_PROTOCOL,
} from '../src/agent-claims.js'
import { getPool, closePool, usePostgres } from '../src/pool.js'

// Claim governance, protocol claim/1.
// Canonical spec: .claude/agents/CLAIM-PROTOCOL.md
//
// The properties under test are the ones the 2026-08-25 incident and Warden's
// review of migration 008 said actually matter:
//   - a challenger-captured claim can never look self-declared
//   - a malformed batch lands NOTHING
//   - unknown keys are an error, not silently dropped
//   - provenance is mandatory
//   - assertion and provenance are immutable once written
//   - "emitted nothing" is distinguishable from "emitted and failed to land"

const hasDb = usePostgres()
const dbIt = hasDb ? it : it.skip

const SELF = `
Ordinary analysis prose that must be ignored.

\`\`\`claim
protocol: ${CLAIM_PROTOCOL}
claimant: atlas
domain: monetary-liquidity
type: forecast
confidence: medium
horizon: 3mo
claim: With overnight RRP exhausted, further TGA rebuild drains bank reserves
  directly rather than being absorbed.
evidence: macro.json — overnight RRP $0.38bn, TGA $953.6bn
invalidated_if: RRP rebuilds above ~$50bn, or TGA stops growing for 4+ weeks
\`\`\`
`

const CAPTURE = `
\`\`\`claim-capture
protocol: ${CLAIM_PROTOCOL}
claimant: atlas
recorded_by: vizier
domain: emerging-markets
type: interpretation
confidence: high
claim: The finalized plan contains zero EM exposure, so selling the EM funds
  leaves a genuine structural hole.
evidence: Surfaced under challenge; Atlas retracted it when shown Thailand is
  itself an emerging market.
\`\`\`
`

const PROV = { sourceSession: 'test-session', sourceContext: 'unit test' }
const created: number[] = []

afterAll(async () => {
  if (!hasDb) return
  if (created.length) {
    await getPool().query('DELETE FROM desk.agent_claims WHERE id = ANY($1::bigint[])', [created])
  }
  await getPool().query("DELETE FROM desk.agent_runs WHERE session_id = 'test-session'")
  await closePool()
})

describe('parsing — strict by design', () => {
  it('parses a self-declared claim and joins continuation lines', () => {
    const [c] = parseClaimBlocks(SELF)
    expect(c.claimant).toBe('atlas')
    expect(c.captureMethod).toBe('self')
    expect(c.recordedBy).toBe('atlas')   // a self-declaration is BY the claimant
    expect(c.claim).toBe(
      'With overnight RRP exhausted, further TGA rebuild drains bank reserves directly rather than being absorbed.')
  })

  it('rejects an unknown key rather than silently dropping it', () => {
    // A typo'd key used to be swallowed into the previous field's text.
    expect(() => parseClaimBlocks(SELF.replace('horizon: 3mo', 'horizen: 3mo')))
      .toThrow(/unknown key "horizen"/)
  })

  it('rejects a duplicate key', () => {
    expect(() => parseClaimBlocks(SELF.replace('confidence: medium', 'confidence: medium\nconfidence: low')))
      .toThrow(/duplicate key "confidence"/)
  })

  it('rejects a protocol mismatch and a missing protocol', () => {
    expect(() => parseClaimBlocks(SELF.replace(CLAIM_PROTOCOL, 'claim/99'))).toThrow(/protocol version mismatch/)
    expect(() => parseClaimBlocks(SELF.replace(`protocol: ${CLAIM_PROTOCOL}\n`, ''))).toThrow(/missing "protocol"/)
  })

  it('requires invalidated_if for forward-looking claims', () => {
    expect(() => parseClaimBlocks(SELF.replace(/invalidated_if:.*\n/, '')))
      .toThrow(/must state invalidated_if/)
  })

  it('does NOT require invalidated_if for a purely factual claim', () => {
    // Forcing a fake disconfirming condition onto a fact is worse than omitting it.
    const factual = SELF.replace('type: forecast', 'type: factual')
      .replace(/horizon:.*\n/, '').replace(/invalidated_if:.*\n/, '')
    expect(parseClaimBlocks(factual)[0].claimType).toBe('factual')
  })

  it('rejects invalid enums, accepts any casing for valid ones', () => {
    expect(() => parseClaimBlocks(SELF.replace('type: forecast', 'type: vibes'))).toThrow(/unknown claim type/)
    expect(() => parseClaimBlocks(SELF.replace('confidence: medium', 'confidence: certain'))).toThrow(/unknown confidence/)
    const shouty = SELF.replace('type: forecast', 'type: FORECAST').replace('confidence: medium', 'confidence: Medium')
    expect(parseClaimBlocks(shouty)[0].claimType).toBe('forecast')
  })

  it('returns nothing when no blocks are present', () => {
    expect(parseClaimBlocks('just an ordinary answer')).toEqual([])
  })
})

describe('challenger capture — cannot masquerade as self-declared', () => {
  it('parses a capture and marks it challenger', () => {
    const [c] = parseCaptureBlocks(CAPTURE)
    expect(c.claimant).toBe('atlas')
    expect(c.recordedBy).toBe('vizier')
    expect(c.captureMethod).toBe('challenger')
  })

  it('refuses a capture whose recorder is the claimant', () => {
    expect(() => parseCaptureBlocks(CAPTURE.replace('recorded_by: vizier', 'recorded_by: atlas')))
      .toThrow(/masquerade as a voluntary self-declaration/)
  })

  it('refuses a capture with no recorded_by', () => {
    expect(() => parseCaptureBlocks(CAPTURE.replace(/recorded_by:.*\n/, '')))
      .toThrow(/missing required field "recorded_by"/)
  })

  it('does not allow recorded_by inside a plain self claim', () => {
    expect(() => parseClaimBlocks(SELF.replace('claimant: atlas', 'claimant: atlas\nrecorded_by: vizier')))
      .toThrow(/unknown key "recorded_by"/)
  })
})

describe('claim-event parsing', () => {
  const ev = (e: string) => `\`\`\`claim-event
protocol: ${CLAIM_PROTOCOL}
event: ${e}
claim_id: 41
actor: vizier
evidence: checked the primary source
\`\`\``

  it('parses each lifecycle event', () => {
    for (const e of ['verify_supported', 'verify_unsupported', 'confirm', 'falsify', 'invalidate', 'retract']) {
      expect(parseEventBlocks(ev(e))[0].event).toBe(e)
    }
  })

  it('rejects an unknown event and a non-numeric claim_id', () => {
    expect(() => parseEventBlocks(ev('vibes'))).toThrow(/unknown event "vibes"/)
    expect(() => parseEventBlocks(ev('confirm').replace('claim_id: 41', 'claim_id: abc')))
      .toThrow(/claim_id must be numeric/)
  })
})

describe('persistence', () => {
  dbIt('refuses to persist without provenance', async () => {
    await expect(recordClaims(parseClaimBlocks(SELF), {})).rejects.toThrow(/without provenance/)
  })

  dbIt('persists a self-declared claim as unverified and unresolved', async () => {
    const r = await recordClaims(parseClaimBlocks(SELF), PROV)
    created.push(...r.ids)
    expect(r.persisted).toBe(1)
    const { rows } = await getPool().query(
      `SELECT claimant, recorded_by, capture_method, protocol_version,
              verification_status, resolution_type, source_session
         FROM desk.agent_claims WHERE id=$1`, [r.ids[0]])
    expect(rows[0].capture_method).toBe('self')
    expect(rows[0].recorded_by).toBe('atlas')
    expect(rows[0].protocol_version).toBe(CLAIM_PROTOCOL)
    expect(rows[0].verification_status).toBe('unverified')   // emitting is not verifying
    expect(rows[0].resolution_type).toBeNull()
    expect(rows[0].source_session).toBe('test-session')
  })

  dbIt('persists a challenger capture with the claimant/recorder split intact', async () => {
    const r = await recordClaims(parseCaptureBlocks(CAPTURE), PROV)
    created.push(...r.ids)
    const { rows } = await getPool().query(
      'SELECT claimant, recorded_by, capture_method FROM desk.agent_claims WHERE id=$1', [r.ids[0]])
    expect(rows[0].claimant).toBe('atlas')
    expect(rows[0].recorded_by).toBe('vizier')
    expect(rows[0].capture_method).toBe('challenger')
  })

  dbIt('the DATABASE refuses a challenger capture recorded by the claimant', async () => {
    await expect(getPool().query(
      `INSERT INTO desk.agent_claims
         (claimant, recorded_by, capture_method, protocol_version, domain, claim,
          claim_type, confidence, source_session)
       VALUES ('atlas','atlas','challenger','claim/1','d','c','factual','low','t')`),
    ).rejects.toThrow(/challenger_is_not_claimant/)
  })

  dbIt('the DATABASE refuses a row with no provenance', async () => {
    await expect(getPool().query(
      `INSERT INTO desk.agent_claims
         (claimant, recorded_by, capture_method, protocol_version, domain, claim, claim_type, confidence)
       VALUES ('atlas','atlas','self','claim/1','d','c','factual','low')`),
    ).rejects.toThrow(/provenance_required/)
  })

  dbIt('a malformed batch lands NOTHING', async () => {
    const before = (await getPool().query('SELECT count(*)::int n FROM desk.agent_claims')).rows[0].n
    const mixed = SELF + SELF.replace('type: forecast', 'type: vibes')
    expect(() => parseClaimBlocks(mixed)).toThrow(ClaimParseError)
    const after = (await getPool().query('SELECT count(*)::int n FROM desk.agent_claims')).rows[0].n
    expect(after).toBe(before)   // the well-formed block did not sneak in
  })

  dbIt('verification and resolution stay separate events', async () => {
    const r = await recordClaims(parseClaimBlocks(SELF), PROV)
    created.push(...r.ids)
    await applyEvent({ event: 'verify_supported', claimId: r.ids[0], actor: 'vizier', evidence: 'checked macro.json' })
    // Properly supported when made — and still overtaken by events later.
    await applyEvent({ event: 'falsify', claimId: r.ids[0], actor: 'vizier', evidence: 'RRP rebuilt to $80bn' })
    const { rows } = await getPool().query(
      'SELECT verification_status, resolution_type FROM desk.agent_claims WHERE id=$1', [r.ids[0]])
    expect(rows[0].verification_status).toBe('verified')
    expect(rows[0].resolution_type).toBe('falsified')
  })

  dbIt('a claimant cannot verify its own claim', async () => {
    const r = await recordClaims(parseClaimBlocks(SELF), PROV)
    created.push(...r.ids)
    await expect(applyEvent({ event: 'verify_supported', claimId: r.ids[0], actor: 'atlas' }))
      .rejects.toThrow(/independent_verification/)
  })

  dbIt('assertion AND provenance are immutable', async () => {
    const r = await recordClaims(parseClaimBlocks(SELF), PROV)
    created.push(...r.ids)
    for (const [col, val] of [['claim', 'tidier'], ['claimant', 'ledger'], ['source_session', 'x']]) {
      await expect(getPool().query(`UPDATE desk.agent_claims SET ${col} = $2 WHERE id = $1`, [r.ids[0], val]))
        .rejects.toThrow(/immutable/)
    }
  })

  dbIt('supersession by concept preserves the original and links the replacement', async () => {
    // A domain of its own, so exactly one prior claim is a candidate. With
    // several open claims in a domain the resolver deliberately refuses to
    // guess — see the ambiguity test below.
    const base = SELF.replace('domain: monetary-liquidity', 'domain: supersede-probe')
    const first = await recordClaims(parseClaimBlocks(base), PROV)
    created.push(...first.ids)
    const revised = base
      .replace(/claim: With overnight[\s\S]*?absorbed\./, 'claim: Reserves are ample again after the RRP rebuild.')
      .replace('invalidated_if:', 'supersedes_concept: the prior claim that reserves are draining\ninvalidated_if:')
    const second = await recordClaims(parseClaimBlocks(revised), PROV)
    created.push(...second.ids)

    const { rows } = await getPool().query(
      `SELECT id, claim, resolution_type, supersedes_claim_id FROM desk.agent_claims
        WHERE id = ANY($1::bigint[]) ORDER BY id`, [[first.ids[0], second.ids[0]]])
    expect(rows[0].claim).toMatch(/^With overnight RRP exhausted/)   // original text untouched
    expect(rows[0].resolution_type).toBe('superseded')               // NOT 'retracted'
    expect(Number(rows[1].supersedes_claim_id)).toBe(first.ids[0])
  })

  dbIt('refuses to GUESS when several prior claims plausibly match', async () => {
    // Wrongly linking lineage would quietly rewrite the history this table
    // exists to preserve, so ambiguity is surfaced for Vizier to settle.
    const dom = SELF.replace('domain: monetary-liquidity', 'domain: ambiguity-probe')
    for (const _ of [1, 2]) {
      const r = await recordClaims(parseClaimBlocks(dom), PROV)
      created.push(...r.ids)
    }
    const revised = dom.replace('invalidated_if:', 'supersedes_concept: the earlier reserves claim\ninvalidated_if:')
    const r = await recordClaims(parseClaimBlocks(revised), PROV)
    created.push(...r.ids)

    expect(r.ambiguous).toHaveLength(1)
    expect(r.ambiguous[0].candidates.length).toBeGreaterThan(1)
    // The new claim still lands — with NO lineage link rather than a guessed one.
    const { rows } = await getPool().query(
      'SELECT supersedes_claim_id FROM desk.agent_claims WHERE id=$1', [r.ids[0]])
    expect(rows[0].supersedes_claim_id).toBeNull()
  })
})

describe('orchestration — detected / parsed / persisted', () => {
  dbIt('reports counts and records the run', async () => {
    const r = await ingestAgentOutput({
      agent: 'atlas', text: SELF, material: true, provenance: PROV, taskSummary: 'unit test' })
    created.push(...r.ids)
    expect([r.detected, r.parsed, r.persisted]).toEqual([1, 1, 1])
    const { rows } = await getPool().query(
      `SELECT blocks_detected, claims_persisted FROM desk.agent_runs
        WHERE session_id='test-session' ORDER BY id DESC LIMIT 1`)
    expect(rows[0].blocks_detected).toBe(1)
    expect(rows[0].claims_persisted).toBe(1)
  })

  dbIt('distinguishes "emitted nothing" from "emitted and failed to land"', async () => {
    const silent = await ingestAgentOutput({
      agent: 'ledger', text: 'a material recommendation with no claim block',
      material: true, provenance: PROV })
    expect(silent.detected).toBe(0)
    expect(silent.persisted).toBe(0)
    expect(silent.errors).toEqual([])          // nothing emitted — not a failure

    const broken = await ingestAgentOutput({
      agent: 'ledger', text: SELF.replace('type: forecast', 'type: vibes'),
      material: true, provenance: PROV })
    expect(broken.detected).toBe(1)            // a block WAS emitted...
    expect(broken.persisted).toBe(0)           // ...and did not land
    expect(broken.errors[0]).toMatch(/unknown claim type/)   // loudly
  })

  dbIt('non-emission is measurable per agent', async () => {
    const { rows } = await getPool().query(
      `SELECT runs_with_no_claim FROM desk.non_emission WHERE agent='ledger'`)
    expect(rows.length).toBe(1)
    expect(Number(rows[0].runs_with_no_claim)).toBeGreaterThan(0)
  })

  dbIt('claimHistory returns rows, never a score', async () => {
    const hist = await claimHistory('atlas', 'monetary-liquidity')
    expect(Array.isArray(hist)).toBe(true)
    expect(hist[0]).toHaveProperty('captureMethod')
    expect(hist[0]).not.toHaveProperty('accuracy')
  })
})
