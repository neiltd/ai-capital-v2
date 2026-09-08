// F6: an unverified document observation can become verified without rewriting
// history.
//
// THE DEFECT. 012 let the ledger say "unverified" honestly but never let it
// move on: document_file_variants rejects UPDATE and DELETE, content_sha256 is
// settable only at INSERT, and UNIQUE (logical_document_id, variant_kind,
// observed_path) blocked recording a second observation of the same path. The
// Phase-2 verification pass the architecture document promises had no way in.
//
// NOTE ON SCOPE. No archive PDF is opened, parsed, copied or hashed here or
// anywhere in Phase 1. These tests write synthetic digests to exercise the
// SHAPE a separately authorised verification pass would use.

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { connectToTestDatabase, expectRejected, withRollback } from './support.js'

let client: Client
beforeAll(async () => { client = await connectToTestDatabase() })
afterAll(() => client.end())

/** A synthetic digest. Deliberately not derived from any file. */
const digest = () => `${randomUUID()}${randomUUID()}`.replace(/-/g, '').slice(0, 64)

async function makeVariant(): Promise<{ variant: string; path: string }> {
  const doc = await client.query<{ id: string }>(
    `INSERT INTO investment_ledger.logical_documents (platform, logical_key, document_type, source_filename)
     VALUES ('TestBroker',$1,'confirmation',$1) RETURNING id`, [`doc-${randomUUID()}`])
  const path = `/nonexistent/${randomUUID()}.pdf`
  const variant = await client.query<{ id: string }>(
    `INSERT INTO investment_ledger.document_file_variants (logical_document_id, variant_kind, observed_path)
     VALUES ($1,'unlocked',$2) RETURNING id`, [doc.rows[0].id, path])
  return { variant: variant.rows[0].id, path }
}

async function record(
  variant: string, kind: 'verified' | 'failed' | 'retracted',
  sha: string | null, supersedes: string | null = null, actor = 'phase-2-verifier',
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO investment_ledger.document_verification_events
       (variant_id, event_kind, content_sha256, supersedes_id, actor, reason, evidence)
     VALUES ($1,$2,$3,$4,$5,'integration test',$6::jsonb) RETURNING id`,
    [variant, kind, sha, supersedes, actor, JSON.stringify({ ticket: 'LEDGER-2' })])
  return r.rows[0].id
}

async function state(variant: string) {
  const { rows } = await client.query(
    `SELECT verification_state, content_sha256, verified_by, verification_event_id
       FROM investment_ledger.current_document_verification WHERE variant_id = $1`, [variant])
  return rows[0]
}

describe('F6 document verification is an append-only observation chain', () => {
  it('a path-only observation projects as unverified', async () => {
    await withRollback(client, async () => {
      const { variant } = await makeVariant()
      const now = await state(variant)
      expect(now.verification_state).toBe('unverified')
      expect(now.content_sha256).toBeNull()
      expect(now.verification_event_id).toBeNull()
    })
  })

  it('moves unverified -> verified without touching the original observation', async () => {
    await withRollback(client, async () => {
      const { variant, path } = await makeVariant()
      const sha = digest()
      const event = await record(variant, 'verified', sha)

      const now = await state(variant)
      expect(now.verification_state).toBe('verified')
      expect(now.content_sha256).toBe(sha)
      expect(now.verified_by).toBe('phase-2-verifier')
      expect(now.verification_event_id).toBe(event)

      // The original observation is preserved verbatim, frozen as it was.
      const original = await client.query<{ observed_path: string; verification_status: string; content_sha256: string | null }>(
        'SELECT observed_path, verification_status, content_sha256 FROM investment_ledger.document_file_variants WHERE id = $1',
        [variant])
      expect(original.rows[0]).toEqual({ observed_path: path, verification_status: 'unverified', content_sha256: null })
    })
  })

  it('records actor, time, reason and evidence for every verification', async () => {
    await withRollback(client, async () => {
      const { variant } = await makeVariant()
      const id = await record(variant, 'verified', digest())
      const row = await client.query(
        'SELECT actor, reason, evidence, observed_at FROM investment_ledger.document_verification_events WHERE id = $1', [id])
      expect(row.rows[0].actor).toBe('phase-2-verifier')
      expect(row.rows[0].reason).toBe('integration test')
      expect(row.rows[0].evidence).toEqual({ ticket: 'LEDGER-2' })
      expect(row.rows[0].observed_at).toBeInstanceOf(Date)
    })
  })

  it('rejects a conflicting second verification unless it supersedes explicitly', async () => {
    await withRollback(client, async () => {
      const { variant } = await makeVariant()
      const first = await record(variant, 'verified', digest())
      await expectRejected(client, () => record(variant, 'verified', digest()),
        /already has an active verification event; supersede it explicitly/)

      // The correct move: a superseding event, with both preserved.
      const corrected = digest()
      const second = await record(variant, 'verified', corrected, first)
      expect((await state(variant)).content_sha256).toBe(corrected)
      expect((await state(variant)).verification_event_id).toBe(second)
      const history = await client.query(
        'SELECT id FROM investment_ledger.document_verification_events WHERE variant_id = $1', [variant])
      expect(history.rowCount, 'both observations survive as the audit trail').toBe(2)
    })
  })

  it('a retraction returns the variant to unverified without deleting anything', async () => {
    await withRollback(client, async () => {
      const { variant } = await makeVariant()
      const first = await record(variant, 'verified', digest())
      await record(variant, 'retracted', null, first)
      const now = await state(variant)
      expect(now.verification_state).toBe('unverified')
      expect(now.content_sha256).toBeNull()
      const history = await client.query(
        'SELECT id FROM investment_ledger.document_verification_events WHERE variant_id = $1', [variant])
      expect(history.rowCount).toBe(2)
    })
  })

  it('a failed read is sayable and is not verification', async () => {
    await withRollback(client, async () => {
      const { variant } = await makeVariant()
      await record(variant, 'failed', null)
      expect((await state(variant)).verification_state).toBe('failed')
      expect((await state(variant)).content_sha256).toBeNull()
    })
  })

  it('refuses to claim verified without a checksum, or to attach one to a failure', async () => {
    await withRollback(client, async () => {
      const { variant } = await makeVariant()
      await expectRejected(client, () => record(variant, 'verified', null), /document_verification_events_check/)
      await expectRejected(client, () => record(variant, 'failed', digest()), /document_verification_events_check/)
    })
  })

  it('refuses to supersede an event that is already superseded, or one for another variant', async () => {
    await withRollback(client, async () => {
      const a = await makeVariant()
      const b = await makeVariant()
      const first = await record(a.variant, 'verified', digest())
      await record(a.variant, 'verified', digest(), first)
      await expectRejected(client, () => record(a.variant, 'verified', digest(), first),
        /already been superseded|document_verification_events_supersedes_id_key|duplicate key/)
      const other = await record(b.variant, 'verified', digest())
      await expectRejected(client, () => record(a.variant, 'verified', digest(), other),
        /only supersede one for the same variant/)
    })
  })

  it('is append-only: UPDATE and DELETE are rejected', async () => {
    await withRollback(client, async () => {
      const { variant } = await makeVariant()
      const id = await record(variant, 'verified', digest())
      await expectRejected(client, () => client.query(
        "UPDATE investment_ledger.document_verification_events SET reason = 'x' WHERE id = $1", [id]), /append-only/)
      // DELETE no longer reaches the trigger: 014 revoked the privilege.
      await expectRejected(client, () => client.query(
        'DELETE FROM investment_ledger.document_verification_events WHERE id = $1', [id]), /permission denied|append-only/)
    })
  })
})
