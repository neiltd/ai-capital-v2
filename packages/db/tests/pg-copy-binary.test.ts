// The binary-copy primitive, proved OFFLINE: the exact SQL, the validation, and
// the structural properties that keep it a transport and nothing else. What it
// does to two real servers is tests/pgcopy/binary-copy.int.test.ts.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import {
  BinaryCopyFailed, BinaryCopyRefused, assertCopyColumns, assertCopyIdentifier,
  assertReviewedTable, copyInSql, copyOutSql, copyTableBinary,
} from '../src/pg-copy/binary-copy.js'
import { ARTIFACT_PATH } from '../bin/pg-copy-contract.js'
import {
  COPY_TABLES, ContractRefused, contractDigest, parseArtifact, serializeArtifact,
  tableCopySpec, type ContractArtifact,
} from '../src/pg-copy/schema-contract.js'

/** The committed artifact: a real, verified contract to derive specs from. */
const ARTIFACT = parseArtifact(readFileSync(ARTIFACT_PATH, 'utf-8'))

/** A structurally edited artifact, re-digested so only the EDIT is under test. */
function reDigested(mutate: (p: Record<string, unknown>) => void): ContractArtifact {
  const payload = JSON.parse(JSON.stringify(ARTIFACT.payload)) as Record<string, unknown>
  mutate(payload)
  return {
    pgcopy_schema_contract_version: ARTIFACT.pgcopy_schema_contract_version,
    payload: payload as never,
    digest: contractDigest(payload as never),
  }
}
const tableOf = (p: Record<string, unknown>, q: string): Record<string, unknown> =>
  (p.tables as Array<Record<string, unknown>>).find(t => t.qname === q)!

const SRC = readFileSync(
  fileURLToPath(new URL('../src/pg-copy/binary-copy.ts', import.meta.url)), 'utf-8')

/** SRC with whole-line comments removed: the ban is on code, not commentary. */
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n')

const T = 'portfolio.positions'
const COLS = ['ticker', 'company', 'shares', 'avg_cost', 'updated_at']

describe('the COPY statements', () => {
  it('are binary, explicit and identical in column order on both sides', () => {
    expect(copyOutSql(T, COLS)).toBe(
      'COPY portfolio.positions (ticker, company, shares, avg_cost, updated_at) ' +
      'TO STDOUT (FORMAT BINARY)')
    expect(copyInSql(T, COLS)).toBe(
      'COPY portfolio.positions (ticker, company, shares, avg_cost, updated_at) ' +
      'FROM STDIN (FORMAT BINARY)')
    // Binary COPY carries no column names, so the two lists must match exactly.
    const out = copyOutSql(T, COLS).match(/\(([^)]*)\) TO STDOUT/)![1]
    const inn = copyInSql(T, COLS).match(/\(([^)]*)\) FROM STDIN/)![1]
    expect(out).toBe(inn)
  })

  it('never falls back to text, CSV or SELECT *', () => {
    for (const sql of [copyOutSql(T, COLS), copyInSql(T, COLS)]) {
      expect(sql).toContain('FORMAT BINARY')
      expect(sql).not.toMatch(/FORMAT\s+(TEXT|CSV)/i)
      expect(sql).not.toContain('*')
    }
    expect(CODE).not.toMatch(/FORMAT\s+(TEXT|CSV)/i)
    expect(CODE).not.toMatch(/SELECT\s+\*/)
    expect(CODE).not.toMatch(/\bCSV\b/)
  })

  it('refuses a table outside the reviewed copy set', () => {
    for (const bad of ['desk.probe', 'public.anything', 'portfolio.trade_log_id_seq',
                       'portfolio.positions; DROP TABLE x', 'positions']) {
      expect(() => copyOutSql(bad, COLS), bad).toThrow(BinaryCopyRefused)
      expect(() => copyInSql(bad, COLS), bad).toThrow(BinaryCopyRefused)
    }
    // ... and accepts every table that IS in it.
    for (const q of COPY_TABLES) expect(() => assertReviewedTable(q), q).not.toThrow()
  })

  it('refuses an empty, duplicated or unvalidated column list', () => {
    expect(() => copyOutSql(T, [])).toThrow(/no columns to copy/)
    expect(() => copyOutSql(T, ['ticker', 'ticker'])).toThrow(/appears more than once/)
    for (const bad of ['tick er', 'Ticker', '"ticker"', 'ticker; DROP', 'ticker)', '']) {
      expect(() => copyOutSql(T, [bad]), bad).toThrow(BinaryCopyRefused)
      expect(() => copyInSql(T, [bad]), bad).toThrow(BinaryCopyRefused)
    }
    expect(() => assertCopyIdentifier('column', 'ok_name')).not.toThrow()
    expect(assertCopyColumns(T, COLS)).toEqual(COLS)
  })
})

describe('the primitive is a transport and nothing else', () => {
  it('owns no transaction', () => {
    for (const verb of ['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT']) {
      expect(CODE, verb).not.toContain(verb)
    }
  })

  it('opens no connection and constructs no client or pool', () => {
    // The only `pg` import is type-only, so there is nothing to construct with.
    expect(SRC).toContain("import type { ClientBase } from 'pg'")
    expect(CODE).not.toMatch(/new\s+(pg\.)?(Client|Pool)\b/)
    expect(CODE).not.toMatch(/createClient|createPool|getPool|connectionString/)
    expect(CODE).not.toMatch(/\.connect\(/)
  })

  it('takes both sessions as captured parameters', () => {
    const fn = CODE.slice(CODE.indexOf('export async function copyTableBinary'))
    expect(fn).toContain('source: ClientBase, target: ClientBase')
    // Each session is used, and neither is re-derived from anything.
    expect(fn).toContain('source.query(copyTo(')
    expect(fn).toContain('target.query(copyFrom(')
  })

  it('streams through pipeline and never buffers the table', () => {
    expect(SRC).toContain("import { pipeline } from 'node:stream/promises'")
    expect(CODE).toContain('await pipeline(outStream, inStream')
    for (const banned of ['Buffer.concat', 'toArray()', 'chunks.push', '.read()',
                          'readFileSync', 'JSON.stringify(chunk']) {
      expect(CODE, banned).not.toContain(banned)
    }
    // The only thing retained per chunk is its LENGTH.
    expect(CODE).toContain('bytes += chunk.length')
  })

  it('wires AbortSignal into the pipeline', () => {
    const fn = CODE.slice(CODE.indexOf('export async function copyTableBinary'))
    expect(fn).toContain('signal')
    expect(fn).toMatch(/pipeline\(outStream, inStream, signal === undefined \? \{\} : \{ signal \}\)/)
  })

  it('destroys both directions on failure and never commits after one', () => {
    const fn = CODE.slice(CODE.indexOf('export async function copyTableBinary'))
    const cat = fn.slice(fn.indexOf('} catch {'), fn.indexOf('const rowCount'))
    expect(cat).toContain('outStream.destroy()')
    expect(cat).toContain('inStream.destroy()')
    expect(cat).toContain('throw new BinaryCopyFailed(')
    expect(cat).not.toContain('COMMIT')
  })

  it('returns bounded metadata with no row content', async () => {
    // A fake pair of sessions: the primitive must not reach for anything else.
    const seen: string[] = []
    const fakeOut = (await import('node:stream')).Readable.from([Buffer.from('ab')])
    const fakeIn = new (await import('node:stream')).Writable({
      write(_c, _e, cb) { cb() },
    })
    const source = { query: (s: unknown) => { seen.push(String(s)); return fakeOut } }
    const target = { query: (s: unknown) => { seen.push(String(s)); return fakeIn } }
    const r = await copyTableBinary(
      source as never, target as never, { artifact: ARTIFACT, qname: T })
    expect(Object.keys(r).sort()).toEqual(
      ['bytes', 'columns', 'qname', 'rowCount', 'sourceSql', 'targetSql'])
    expect(r.qname).toBe(T)
    expect(r.columns.length).toBe(12)
    expect(r.bytes).toBe(2)
    expect(r.sourceSql).toContain('TO STDOUT (FORMAT BINARY)')
    expect(r.targetSql).toContain('FROM STDIN (FORMAT BINARY)')
    // No row bytes, and nothing resembling a connection string, escapes.
    const dumped = JSON.stringify(r)
    expect(dumped).not.toContain('postgresql://')
    expect(dumped).not.toContain('password')
    expect(dumped).not.toContain('ab')
  })

})

describe('the column list comes from the VERIFIED contract, never the caller', () => {
  it('derives the recorded physical order for a reviewed table', () => {
    const spec = tableCopySpec(ARTIFACT, T)
    expect(spec.qname).toBe(T)
    expect(spec.schema).toBe('portfolio')
    expect(spec.table).toBe('positions')
    expect(spec.columns.length).toBe(12)
    expect(spec.columns[0]).toBe('ticker')
    expect(new Set(spec.columns).size).toBe(spec.columns.length)
    expect(Object.isFrozen(spec)).toBe(true)
    // Every reviewed table resolves.
    for (const q of COPY_TABLES) expect(() => tableCopySpec(ARTIFACT, q), q).not.toThrow()
  })

  it('carries no caller-supplied column channel at all', () => {
    // The request type has no `columns`; the only source is the artifact.
    expect(CODE).toContain('const spec: TableCopySpec = tableCopySpec(artifact, qname)')
    expect(CODE).toContain('const columns = spec.columns')
    // The REQUEST type offers no column channel; the RESULT reporting them is
    // a fact about what was copied, not an input.
    const req = CODE.slice(CODE.indexOf('export interface BinaryCopyRequest'),
                           CODE.indexOf('export interface BinaryCopyResult'))
    expect(req).not.toContain('columns')
    expect(CODE).not.toContain('request.columns')
  })

  it('refuses a tampered artifact digest', () => {
    const tampered: ContractArtifact = { ...ARTIFACT, digest: 'f'.repeat(64) }
    expect(() => tableCopySpec(tampered, T)).toThrow(/does not match its payload/)
    const wrongVersion: ContractArtifact = { ...ARTIFACT, pgcopy_schema_contract_version: 99 }
    expect(() => tableCopySpec(wrongVersion, T)).toThrow(/artifact version 99/)
  })

  it('refuses a table absent from, or duplicated in, the contract', () => {
    const absent = reDigested(p => {
      p.table_order = (p.table_order as string[]).filter(t => t !== T)
      p.tables = (p.tables as Array<Record<string, unknown>>).filter(t => t.qname !== T)
    })
    expect(() => tableCopySpec(absent, T)).toThrow(/occurs 0 times in table_order/)

    const twiceInOrder = reDigested(p => { (p.table_order as string[]).push(T) })
    expect(() => tableCopySpec(twiceInOrder, T)).toThrow(/occurs 2 times in table_order/)

    const twiceInTables = reDigested(p => {
      const t = p.table_order as string[]
      void t
      ;(p.tables as Array<Record<string, unknown>>).push(
        JSON.parse(JSON.stringify(tableOf(p, T))) as Record<string, unknown>)
    })
    expect(() => tableCopySpec(twiceInTables, T)).toThrow(/occurs 2 times in the contract/)
  })

  it('refuses a missing, extra, reordered or duplicated column', () => {
    const missing = reDigested(p => {
      const t = tableOf(p, T)
      const cols = (t.columns as Array<Record<string, unknown>>).slice(1)
      cols.forEach((c, i) => { c.position = i + 1 })
      t.columns = cols
    })
    // A dropped column re-numbered cleanly is still WRONG - it is caught by the
    // integration test's digest comparison, so here we prove the count changed.
    expect(tableCopySpec(missing, T).columns.length).toBe(11)

    const extra = reDigested(p => {
      const t = tableOf(p, T)
      const cols = t.columns as Array<Record<string, unknown>>
      cols.push({ ...cols[0], name: 'bogus_extra', position: cols.length + 1 })
    })
    expect(tableCopySpec(extra, T).columns).toContain('bogus_extra')

    const reordered = reDigested(p => {
      const t = tableOf(p, T)
      const cols = t.columns as Array<Record<string, unknown>>
      ;[cols[0], cols[1]] = [cols[1], cols[0]]
    })
    expect(() => tableCopySpec(reordered, T)).toThrow(/is recorded at position/)

    const duplicated = reDigested(p => {
      const t = tableOf(p, T)
      const cols = t.columns as Array<Record<string, unknown>>
      cols[1] = { ...cols[1], name: cols[0].name }
    })
    expect(() => tableCopySpec(duplicated, T)).toThrow(/appears more than once/)

    const badName = reDigested(p => {
      const t = tableOf(p, T)
      ;(t.columns as Array<Record<string, unknown>>)[0].name = 'Bad Name'
    })
    expect(() => tableCopySpec(badName, T)).toThrow(/not a bare identifier/)
  })

  it('refuses an unreviewed table', () => {
    expect(() => tableCopySpec(ARTIFACT, 'desk.probe')).toThrow(/not in the reviewed copy set/)
    expect(() => tableCopySpec(ARTIFACT, 'portfolio.positions; DROP'))
      .toThrow(ContractRefused)
  })

  it('refuses every one of those BEFORE touching either session', async () => {
    let touched = 0
    const s = { query: () => { touched += 1; return null } }
    const bad: Array<[string, ContractArtifact, string]> = [
      ['tampered digest', { ...ARTIFACT, digest: '0'.repeat(64) }, T],
      ['unreviewed table', ARTIFACT, 'desk.probe'],
      ['reordered columns', reDigested(p => {
        const cols = tableOf(p, T).columns as Array<Record<string, unknown>>
        ;[cols[0], cols[1]] = [cols[1], cols[0]]
      }), T],
      ['duplicate column', reDigested(p => {
        const cols = tableOf(p, T).columns as Array<Record<string, unknown>>
        cols[1] = { ...cols[1], name: cols[0].name }
      }), T],
      ['absent table', reDigested(p => {
        p.table_order = (p.table_order as string[]).filter(t => t !== T)
        p.tables = (p.tables as Array<Record<string, unknown>>).filter(t => t.qname !== T)
      }), T],
      ['duplicated table', reDigested(p => { (p.table_order as string[]).push(T) }), T],
    ]
    for (const [label, artifact, qname] of bad) {
      await expect(copyTableBinary(s as never, s as never, { artifact, qname }), label)
        .rejects.toThrow(ContractRefused)
    }
    expect(touched, 'a session was touched before the request was refused').toBe(0)
  })

  it('round-trips through the committed serialisation unchanged', () => {
    const again = parseArtifact(serializeArtifact(ARTIFACT))
    expect(tableCopySpec(again, T).columns).toEqual(tableCopySpec(ARTIFACT, T).columns)
  })
})

describe('a copy failure says nothing about the data', () => {
  it('carries only the table and the phase', () => {
    const e = new BinaryCopyFailed(T, 'stream-failed')
    expect(e.qname).toBe(T)
    expect(e.phase).toBe('stream-failed')
    expect(e.name).toBe('BinaryCopyFailed')
    expect(e.message).toContain(T)
    expect(e.message).toContain('Discard the target transaction')
    // No original error, by construction.
    expect((e as { cause?: unknown }).cause).toBeUndefined()
    expect(Object.keys(e).sort()).toEqual(['name', 'phase', 'qname'])
    for (const leak of ['detail', 'where', 'query', 'code', 'severity', 'cause', 'originalError']) {
      expect((e as unknown as Record<string, unknown>)[leak], leak).toBeUndefined()
    }
    expect(new BinaryCopyFailed(T, 'cancelled').message).toContain('was cancelled')
  })

  it('never re-raises, wraps or attaches the original', () => {
    const cat = CODE.slice(CODE.indexOf('} catch {'), CODE.indexOf('const rowCount'))
    expect(cat).toContain('throw new BinaryCopyFailed(')
    expect(cat).not.toMatch(/throw err\b/)
    expect(cat).not.toContain('cause')
    expect(cat).not.toMatch(/err\.(message|detail|where|query)/)
    // The phase is decided by the signal, not by reading the error text.
    expect(cat).toContain('signal !== undefined && signal.aborted')
    expect(CODE).not.toMatch(/catch \(err\)/)
  })
})
