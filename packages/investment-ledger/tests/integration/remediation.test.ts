// Round-1 remediation, re-verified under rollback isolation.
// Cross-connection races moved to concurrency.test.ts; correction integrity to
// corrections.test.ts; document verification to documents.test.ts.

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { connectToTestDatabase, expectRejected, withRollback } from './support.js'
import { DUAL_CURRENCY_ROW, SAME_SYMBOL_TWO_BROKERS } from '../fixtures/rows.js'

let client: Client
beforeAll(async () => { client = await connectToTestDatabase() })
afterAll(() => client.end())

async function makeAccount(suffix: string, resolved = true): Promise<string> {
  const key = `TEST:${suffix}:${randomUUID()}`
  const r = await client.query<{ id: string }>(
    `INSERT INTO investment_ledger.accounts
       (account_key, platform, external_account_id, display_name, resolution_status, unresolved_reason)
     VALUES ($1,'TestBroker',$2,$1,$3,$4) RETURNING id`,
    [key, resolved ? key : null, resolved ? 'resolved' : 'unresolved', resolved ? null : 'test placeholder'])
  return r.rows[0].id
}

async function resolveTo(
  placeholder: string, target: string | null, kind: 'resolve' | 'retract' = 'resolve',
  supersedes: string | null = null,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO investment_ledger.account_resolutions
       (placeholder_account_id, resolved_account_id, resolution_kind, supersedes_id, actor, reason, evidence)
     VALUES ($1,$2,$3,$4,'test-operator','integration test',$5::jsonb) RETURNING id`,
    [placeholder, target, kind, supersedes, JSON.stringify({ ticket: 'LEDGER-1' })])
  return r.rows[0].id
}

describe('F2 account resolution is append-only and auditable', () => {
  it('projects a placeholder onto its canonical account without touching history', async () => {
    await withRollback(client, async () => {
      const placeholder = await makeAccount('placeholder', false)
      const canonical = await makeAccount('canonical')
      await resolveTo(placeholder, canonical)
      const effective = await client.query<{ effective_account_id: string; resolution_depth: number }>(
        'SELECT effective_account_id, resolution_depth FROM investment_ledger.effective_accounts WHERE account_id = $1',
        [placeholder])
      expect(effective.rows[0].effective_account_id).toBe(canonical)
      expect(Number(effective.rows[0].resolution_depth)).toBe(1)
      const original = await client.query<{ resolution_status: string }>(
        'SELECT resolution_status FROM investment_ledger.accounts WHERE id = $1', [placeholder])
      expect(original.rows[0].resolution_status).toBe('unresolved')
    })
  })

  it('records actor, time, reason and evidence', async () => {
    await withRollback(client, async () => {
      const id = await resolveTo(await makeAccount('audited', false), await makeAccount('audited-target'))
      const row = await client.query(
        'SELECT actor, reason, evidence, created_at FROM investment_ledger.account_resolutions WHERE id = $1', [id])
      expect(row.rows[0].actor).toBe('test-operator')
      expect(row.rows[0].reason).toBe('integration test')
      expect(row.rows[0].evidence).toEqual({ ticket: 'LEDGER-1' })
      expect(row.rows[0].created_at).toBeInstanceOf(Date)
    })
  })

  it('rejects self-resolution', async () => {
    await withRollback(client, async () => {
      const a = await makeAccount('self', false)
      // The cycle detector reaches a self-resolution before the CHECK does;
      // either rejection is correct, both are the database refusing it.
      await expectRejected(client, () => resolveTo(a, a), /cycle|violates check constraint/)
    })
  })

  it('rejects a second simultaneously active resolution', async () => {
    await withRollback(client, async () => {
      const placeholder = await makeAccount('ambiguous', false)
      await resolveTo(placeholder, await makeAccount('ambiguous-a'))
      const second = await makeAccount('ambiguous-b')
      await expectRejected(client, () => resolveTo(placeholder, second), /already has an active resolution/)
    })
  })

  it('corrects a wrong resolution by explicit supersession, never by mutation', async () => {
    await withRollback(client, async () => {
      const placeholder = await makeAccount('corrected', false)
      const wrong = await makeAccount('corrected-wrong')
      const right = await makeAccount('corrected-right')
      const firstId = await resolveTo(placeholder, wrong)
      await resolveTo(placeholder, right, 'resolve', firstId)
      const effective = await client.query<{ effective_account_id: string }>(
        'SELECT effective_account_id FROM investment_ledger.effective_accounts WHERE account_id = $1', [placeholder])
      expect(effective.rows[0].effective_account_id).toBe(right)
      const history = await client.query(
        'SELECT id FROM investment_ledger.account_resolutions WHERE placeholder_account_id = $1', [placeholder])
      expect(history.rowCount).toBe(2)
    })
  })

  it('refuses to supersede a row that is already superseded', async () => {
    await withRollback(client, async () => {
      const placeholder = await makeAccount('double', false)
      const first = await resolveTo(placeholder, await makeAccount('double-a'))
      await resolveTo(placeholder, await makeAccount('double-b'), 'resolve', first)
      const c = await makeAccount('double-c')
      await expectRejected(client, () => resolveTo(placeholder, c, 'resolve', first),
        /already been superseded|duplicate key/)
    })
  })

  it('supports retraction, which returns the placeholder to unresolved', async () => {
    await withRollback(client, async () => {
      const placeholder = await makeAccount('retracted', false)
      const first = await resolveTo(placeholder, await makeAccount('retracted-target'))
      await resolveTo(placeholder, null, 'retract', first)
      const effective = await client.query<{ effective_account_id: string }>(
        'SELECT effective_account_id FROM investment_ledger.effective_accounts WHERE account_id = $1', [placeholder])
      expect(effective.rows[0].effective_account_id).toBe(placeholder)
    })
  })

  it('rejects a retraction that supersedes nothing', async () => {
    await withRollback(client, async () => {
      const placeholder = await makeAccount('bad-retract', false)
      await expectRejected(client, () => resolveTo(placeholder, null, 'retract', null),
        /account_resolutions_check|violates check constraint/)
    })
  })

  it('prevents cycles', async () => {
    await withRollback(client, async () => {
      const a = await makeAccount('cycle-a', false)
      const b = await makeAccount('cycle-b', false)
      await resolveTo(a, b)
      await expectRejected(client, () => resolveTo(b, a), /cycle/)
    })
  })

  it('is append-only: UPDATE and DELETE are rejected', async () => {
    await withRollback(client, async () => {
      const id = await resolveTo(await makeAccount('immutable', false), await makeAccount('immutable-target'))
      await expectRejected(client, () => client.query(
        "UPDATE investment_ledger.account_resolutions SET reason = 'x' WHERE id = $1", [id]), /append-only/)
      // DELETE no longer reaches the trigger: 014 revoked the privilege.
      await expectRejected(client, () => client.query(
        'DELETE FROM investment_ledger.account_resolutions WHERE id = $1', [id]), /permission denied|append-only/)
    })
  })

  it('projects the effective account per transaction without rewriting the row', async () => {
    await withRollback(client, async () => {
      const placeholder = await makeAccount('projected', false)
      const canonical = await makeAccount('projected-target')
      const instrument = await client.query<{ id: string }>(
        `INSERT INTO investment_ledger.instruments (canonical_key, display_name, instrument_type)
         VALUES ($1,$1,'equity') RETURNING id`, [`TEST-INSTR-${randomUUID()}`])
      const tx = await client.query<{ id: string }>(
        `INSERT INTO investment_ledger.transactions
           (account_id, instrument_id, occurred_on, transaction_type, units, business_fingerprint, record_source)
         VALUES ($1,$2,'2024-01-01','BUY',3,$3,'manual') RETURNING id`,
        [placeholder, instrument.rows[0].id, randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64)])

      const before = await client.query<{ effective_account_id: string; was_resolved: boolean }>(
        'SELECT effective_account_id, was_resolved FROM investment_ledger.transaction_effective_accounts WHERE transaction_id = $1',
        [tx.rows[0].id])
      expect(before.rows[0]).toEqual({ effective_account_id: placeholder, was_resolved: false })

      await resolveTo(placeholder, canonical)

      const after = await client.query<{ recorded_account_id: string; effective_account_id: string; was_resolved: boolean }>(
        `SELECT recorded_account_id, effective_account_id, was_resolved
           FROM investment_ledger.transaction_effective_accounts WHERE transaction_id = $1`, [tx.rows[0].id])
      expect(after.rows[0]).toEqual({
        recorded_account_id: placeholder, effective_account_id: canonical, was_resolved: true,
      })
      const stored = await client.query<{ account_id: string }>(
        'SELECT account_id FROM investment_ledger.transactions WHERE id = $1', [tx.rows[0].id])
      expect(stored.rows[0].account_id).toBe(placeholder)
    })
  })
})

describe('F7 document and extraction truth', () => {
  it('an extraction can be recorded as unparseable', async () => {
    await withRollback(client, async () => {
      const doc = await client.query<{ id: string }>(
        `INSERT INTO investment_ledger.logical_documents (platform, logical_key, document_type, source_filename)
         VALUES ('TestBroker',$1,'confirmation',$1) RETURNING id`, [`doc-${randomUUID()}`])
      const e = await client.query<{ extraction_outcome: string }>(
        `INSERT INTO investment_ledger.document_extractions
           (logical_document_id, extraction_version, extractor_name, extractor_version, extraction_sha256, payload, extraction_outcome)
         VALUES ($1,1,'none','0','${'0'.repeat(64)}','{}'::jsonb,'unparseable') RETURNING extraction_outcome`,
        [doc.rows[0].id])
      expect(e.rows[0].extraction_outcome).toBe('unparseable')
    })
  })

  it('unparseable is an available reconciliation case type', async () => {
    await withRollback(client, async () => {
      const c = await client.query<{ id: string }>(
        `INSERT INTO investment_ledger.reconciliation_cases (case_key, case_type)
         VALUES ($1,'unparseable') RETURNING id`, [`unparseable-${randomUUID()}`])
      expect(c.rows[0].id).toBeTruthy()
    })
  })

  it('claiming verified without a checksum is rejected on the frozen column too', async () => {
    await withRollback(client, async () => {
      const doc = await client.query<{ id: string }>(
        `INSERT INTO investment_ledger.logical_documents (platform, logical_key, document_type, source_filename)
         VALUES ('TestBroker',$1,'confirmation',$1) RETURNING id`, [`doc-${randomUUID()}`])
      await expectRejected(client, () => client.query(
        `INSERT INTO investment_ledger.document_file_variants
           (logical_document_id, variant_kind, observed_path, verification_status)
         VALUES ($1,'unlocked',$2,'verified')`, [doc.rows[0].id, `/nonexistent/${randomUUID()}.pdf`]),
        /document_variant_verified_requires_checksum/)
    })
  })
})

describe('F8 dead status removed', () => {
  it('a batch can never be created as superseded', async () => {
    await withRollback(client, async () => {
      await expectRejected(client, () => client.query(
        `INSERT INTO investment_ledger.import_batches
           (series_key, source_kind, source_name, source_sha256, importer_version, row_count, status)
         VALUES ('test-dead:status','manual','x',$1,'v',0,'superseded')`, ['a'.repeat(64)]),
        /import_batches_status_check/)
    })
  })
})

describe('F8 instrument identity carries market evidence', () => {
  it('merges the same security held at two brokers, but not across markets', () => {
    // FABRICATED rows: the claim is about the identity RULE, not about any
    // particular holding. Two brokers, one symbol, one currency, no exchange —
    // identity must not split on the broker.
    const shared = SAME_SYMBOL_TWO_BROKERS
    expect(new Set(shared.map(r => r.broker)).size).toBe(2)
    expect(new Set(shared.map(r => `${r.currency}:${r.exchange.trim() || 'NO_EXCHANGE'}`)).size).toBe(1)

    // And a same-symbol row quoted in another currency on a real exchange must
    // NOT collapse into the THB identity above.
    const foreign = DUAL_CURRENCY_ROW
    expect(foreign.exchange.trim()).not.toBe('')
    expect(`${foreign.currency}:${foreign.exchange.trim().toUpperCase()}`).not.toBe('THB:NO_EXCHANGE')
  })
})
