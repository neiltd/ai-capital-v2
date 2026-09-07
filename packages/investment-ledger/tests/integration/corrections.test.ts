// F2 + F3: correction integrity, enforced by PostgreSQL.
//
// F2. 011 required a correction row to have SOME group; it never constrained
// the group's TYPE, and 012's validator returns early unless the group is
// `correction`. A reversal parked in a `switch` group therefore escaped every
// correction check while current_transactions still dropped its target.
//
// F3. 012 compared components with
//   `... FULL OUTER JOIN r ON ... WHERE o.transaction_id = original_id`.
// The WHERE applies after the join, discarding every row contributed only by
// the reversal, so the join degenerated to a left join from the original. A
// reversal carrying a component the original does not have passed as "the exact
// economic inverse". The CONTROL test at the bottom reproduces that.

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import {
  connectToTestDatabase, expectRejected, flushDeferredConstraints, withRollback,
} from './support.js'

let client: Client
beforeAll(async () => { client = await connectToTestDatabase() })
afterAll(() => client.end())

async function scaffold(): Promise<{ account: string; instrument: string }> {
  const key = `TEST:correction:${randomUUID()}`
  const account = await client.query<{ id: string }>(
    `INSERT INTO investment_ledger.accounts
       (account_key, platform, external_account_id, display_name, resolution_status)
     VALUES ($1,'TestBroker',$1,$1,'resolved') RETURNING id`, [key])
  const instrument = await client.query<{ id: string }>(
    `INSERT INTO investment_ledger.instruments (canonical_key, display_name, instrument_type)
     VALUES ($1,$1,'equity') RETURNING id`, [`TEST-INSTR-${randomUUID()}`])
  return { account: account.rows[0].id, instrument: instrument.rows[0].id }
}

async function makeGroup(type: 'correction' | 'switch' | 'multi_fill' = 'correction'): Promise<string> {
  const g = await client.query<{ id: string }>(
    `INSERT INTO investment_ledger.transaction_groups (group_type, group_key, description)
     VALUES ($1,$2,'test group') RETURNING id`, [type, `${type}:${randomUUID()}`])
  return g.rows[0].id
}

async function makeTx(
  account: string, instrument: string, group: string | null,
  correctionOf: string | null, role: 'reversal' | 'replacement' | null, units: string,
): Promise<string> {
  const t = await client.query<{ id: string }>(
    `INSERT INTO investment_ledger.transactions
       (account_id, instrument_id, transaction_group_id, correction_of_id, correction_role,
        occurred_on, transaction_type, units, business_fingerprint, record_source)
     VALUES ($1,$2,$3,$4,$5,'2024-01-01','BUY',$6,$7,'manual') RETURNING id`,
    [account, instrument, group, correctionOf, role, units,
     randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64)])
  return t.rows[0].id
}

async function addAmount(
  tx: string, type: string, amount: string,
  currency = 'THB', representation: 'native' | 'broker_converted' = 'native',
  role: 'economic' | 'informational' = 'economic',
): Promise<void> {
  await client.query(
    `INSERT INTO investment_ledger.transaction_amount_components
       (transaction_id, component_type, amount, currency, representation_kind, counting_role)
     VALUES ($1,$2,$3,$4,$5,$6)`, [tx, type, amount, currency, representation, role])
}

describe('F2 a correction may only live in a correction group', () => {
  for (const wrongType of ['switch', 'multi_fill'] as const) {
    it(`rejects a reversal placed in a ${wrongType} group — the round-1 bypass`, async () => {
      await withRollback(client, async () => {
        const { account, instrument } = await scaffold()
        const group = await makeGroup(wrongType)
        const target = await makeTx(account, instrument, null, null, null, '10')
        await expectRejected(
          client,
          () => makeTx(account, instrument, group, target, 'reversal', '-10'),
          new RegExp(`require a transaction group of type correction, got ${wrongType}`),
        )
      })
    })
  }

  it('rejects a correction with no group at all', async () => {
    await withRollback(client, async () => {
      const { account, instrument } = await scaffold()
      const target = await makeTx(account, instrument, null, null, null, '10')
      await expectRejected(
        client, () => makeTx(account, instrument, null, target, 'reversal', '-10'),
        /must belong to a correction group|transactions_check/,
      )
    })
  })

  it('a correction group rejects a second non-correction member', async () => {
    await withRollback(client, async () => {
      const { account, instrument } = await scaffold()
      const group = await makeGroup()
      const original = await makeTx(account, instrument, group, null, null, '10')
      await addAmount(original, 'gross', '1000')
      const reversal = await makeTx(account, instrument, group, original, 'reversal', '-10')
      await addAmount(reversal, 'gross', '-1000')
      // A plain member with no correction_role is a second "original".
      await makeTx(account, instrument, group, null, null, '7')
      await expectRejected(client, () => flushDeferredConstraints(client), /exactly one original/)
    })
  })
})

describe('F3 a reversal must be the exact economic inverse, in both directions', () => {
  async function coherent(): Promise<{ group: string; original: string; account: string; instrument: string }> {
    const { account, instrument } = await scaffold()
    const group = await makeGroup()
    const original = await makeTx(account, instrument, group, null, null, '10')
    await addAmount(original, 'gross', '1000')
    await addAmount(original, 'cash_flow', '-1000')
    return { group, original, account, instrument }
  }

  it('accepts a coherent original and its exact inverse, and projects the correction', async () => {
    await withRollback(client, async () => {
      const { group, original, account, instrument } = await coherent()
      const reversal = await makeTx(account, instrument, group, original, 'reversal', '-10')
      await addAmount(reversal, 'gross', '-1000')
      await addAmount(reversal, 'cash_flow', '1000')
      await flushDeferredConstraints(client)

      // Defined projection: the reversed original and the reversal both leave.
      const current = await client.query(
        'SELECT id FROM investment_ledger.current_transactions WHERE transaction_group_id = $1', [group])
      expect(current.rowCount).toBe(0)
    })
  })

  it('a replacement survives the projection while the original and reversal leave', async () => {
    await withRollback(client, async () => {
      const { group, original, account, instrument } = await coherent()
      const reversal = await makeTx(account, instrument, group, original, 'reversal', '-10')
      await addAmount(reversal, 'gross', '-1000')
      await addAmount(reversal, 'cash_flow', '1000')
      const replacement = await makeTx(account, instrument, group, original, 'replacement', '11')
      await addAmount(replacement, 'gross', '1100')
      await addAmount(replacement, 'cash_flow', '-1100')
      await flushDeferredConstraints(client)

      const current = await client.query<{ id: string }>(
        'SELECT id FROM investment_ledger.current_transactions WHERE transaction_group_id = $1', [group])
      expect(current.rows.map(r => r.id)).toEqual([replacement])
    })
  })

  const malformed: Array<[string, (ctx: { group: string; original: string; account: string; instrument: string }) => Promise<void>, RegExp]> = [
    ['a wrong magnitude', async ({ group, original, account, instrument }) => {
      const rev = await makeTx(account, instrument, group, original, 'reversal', '-10')
      await addAmount(rev, 'gross', '-999'); await addAmount(rev, 'cash_flow', '1000')
    }, /is -999, expected 1000|expected -1000|not the exact economic inverse/],

    ['a MISSING component', async ({ group, original, account, instrument }) => {
      const rev = await makeTx(account, instrument, group, original, 'reversal', '-10')
      await addAmount(rev, 'gross', '-1000')            // cash_flow omitted
    }, /missing the cash_flow component/],

    ['an EXTRA component the original never had', async ({ group, original, account, instrument }) => {
      const rev = await makeTx(account, instrument, group, original, 'reversal', '-10')
      await addAmount(rev, 'gross', '-1000'); await addAmount(rev, 'cash_flow', '1000')
      await addAmount(rev, 'fee', '-25')                // the original has no fee
    }, /extra fee component/],

    ['the wrong currency', async ({ group, original, account, instrument }) => {
      const rev = await makeTx(account, instrument, group, original, 'reversal', '-10')
      await addAmount(rev, 'gross', '-1000', 'USD'); await addAmount(rev, 'cash_flow', '1000')
    }, /extra gross component in USD|missing the gross component in THB/],

    ['the wrong representation kind', async ({ group, original, account, instrument }) => {
      const rev = await makeTx(account, instrument, group, original, 'reversal', '-10')
      await addAmount(rev, 'gross', '-1000', 'THB', 'broker_converted')
      await addAmount(rev, 'cash_flow', '1000')
    }, /broker_converted|missing the gross component/],

    ['a component demoted to informational', async ({ group, original, account, instrument }) => {
      const rev = await makeTx(account, instrument, group, original, 'reversal', '-10')
      await addAmount(rev, 'gross', '-1000', 'THB', 'native', 'informational')
      await addAmount(rev, 'cash_flow', '1000')
    }, /missing the gross component/],
  ]

  for (const [label, build, match] of malformed) {
    it(`rejects a reversal with ${label}`, async () => {
      await withRollback(client, async () => {
        const ctx = await coherent()
        await build(ctx)
        await expectRejected(client, () => flushDeferredConstraints(client), match)
      })
    })
  }

  it('rejects an original with no economic components, so absence cannot satisfy the check', async () => {
    await withRollback(client, async () => {
      const { account, instrument } = await scaffold()
      const group = await makeGroup()
      const original = await makeTx(account, instrument, group, null, null, '10')
      const rev = await makeTx(account, instrument, group, original, 'reversal', '-10')
      await addAmount(rev, 'gross', '-1000')
      await expectRejected(client, () => flushDeferredConstraints(client), /no economic amount components to reverse/)
    })
  })

  it('rejects a correction group with no original', async () => {
    await withRollback(client, async () => {
      const { account, instrument } = await scaffold()
      const group = await makeGroup()
      const other = await makeTx(account, instrument, null, null, null, '1')
      await makeTx(account, instrument, group, other, 'reversal', '-1')
      await expectRejected(client, () => flushDeferredConstraints(client), /exactly one original/)
    })
  })

  it('rejects mixed correction targets in one group', async () => {
    await withRollback(client, async () => {
      const { group, original, account, instrument } = await coherent()
      const rev = await makeTx(account, instrument, group, original, 'reversal', '-10')
      await addAmount(rev, 'gross', '-1000'); await addAmount(rev, 'cash_flow', '1000')
      const foreign = await makeTx(account, instrument, null, null, null, '5')
      await makeTx(account, instrument, group, foreign, 'replacement', '5')
      await expectRejected(client, () => flushDeferredConstraints(client), /mixes correction targets/)
    })
  })

  it('rejects a correction group with no reversal', async () => {
    await withRollback(client, async () => {
      const { group, original, account, instrument } = await coherent()
      await makeTx(account, instrument, group, original, 'replacement', '11')
      await expectRejected(client, () => flushDeferredConstraints(client), /at least one reversal/)
    })
  })

  it('a rejected correction leaves nothing behind', async () => {
    await withRollback(client, async () => {
      const { account, instrument } = await scaffold()
      // The whole correction is ONE atomic attempt: build it inside a savepoint,
      // let validation reject it, and prove the unit left no partial group.
      await client.query('SAVEPOINT attempt')
      const group = await makeGroup()
      const original = await makeTx(account, instrument, group, null, null, '10')
      await addAmount(original, 'gross', '1000')
      await addAmount(original, 'cash_flow', '-1000')
      const rev = await makeTx(account, instrument, group, original, 'reversal', '-10')
      await addAmount(rev, 'gross', '-1')

      let rejection: Error | null = null
      try { await flushDeferredConstraints(client) } catch (caught) { rejection = caught as Error }
      await client.query('ROLLBACK TO SAVEPOINT attempt')

      expect(rejection?.message).toMatch(/not the exact economic inverse/)
      const left = await client.query(
        'SELECT id FROM investment_ledger.transactions WHERE transaction_group_id = $1', [group])
      expect(left.rowCount, 'no member of the rejected group survives').toBe(0)
      const groupRow = await client.query(
        'SELECT id FROM investment_ledger.transaction_groups WHERE id = $1', [group])
      expect(groupRow.rowCount, 'not even the group itself').toBe(0)
    })
  })

  it('CONTROL: the round-1 predicate accepts the extra-component reversal the new one rejects', async () => {
    await withRollback(client, async () => {
      const { account, instrument } = await scaffold()
      // Built OUTSIDE a correction group so the live validator stays out of the
      // way and the two predicates can be compared on identical data.
      const original = await makeTx(account, instrument, null, null, null, '10')
      await addAmount(original, 'gross', '1000')
      await addAmount(original, 'cash_flow', '-1000')
      const reversal = await makeTx(account, instrument, null, null, null, '-10')
      await addAmount(reversal, 'gross', '-1000')
      await addAmount(reversal, 'cash_flow', '1000')
      await addAmount(reversal, 'fee', '-25')          // present only on the reversal

      // The 012 predicate, verbatim: the WHERE on `o` runs after the join and
      // throws away every row the reversal alone contributed.
      const old = await client.query<{ bad: number }>(
        `SELECT count(*)::int AS bad FROM (
           SELECT o.component_type, o.currency, o.amount AS original_amount, r.amount AS reversal_amount
             FROM investment_ledger.transaction_amount_components o
             FULL OUTER JOIN investment_ledger.transaction_amount_components r
               ON r.transaction_id = $2
              AND r.component_type = o.component_type
              AND r.currency = o.currency
              AND r.representation_kind = o.representation_kind
            WHERE o.transaction_id = $1 AND o.counting_role = 'economic'
         ) pairs
         WHERE reversal_amount IS NULL OR original_amount IS NULL
            OR reversal_amount <> -original_amount`, [original, reversal])
      expect(old.rows[0].bad, 'the round-1 predicate saw no problem — this is the defect').toBe(0)

      // The 013 predicate, on the same two transactions.
      const now = await client.query<{ bad: number }>(
        `SELECT count(*)::int AS bad FROM (
           SELECT component_type, currency, representation_kind, o.amount AS oa, r.amount AS ra
             FROM (SELECT component_type, currency, representation_kind, amount
                     FROM investment_ledger.transaction_amount_components
                    WHERE transaction_id = $1 AND counting_role = 'economic') o
             FULL OUTER JOIN (SELECT component_type, currency, representation_kind, amount
                     FROM investment_ledger.transaction_amount_components
                    WHERE transaction_id = $2 AND counting_role = 'economic') r
               USING (component_type, currency, representation_kind)
         ) pair
         WHERE oa IS NULL OR ra IS NULL OR ra <> -oa`, [original, reversal])
      expect(now.rows[0].bad, 'the round-2 predicate catches the extra component').toBe(1)
    })
  })
})
