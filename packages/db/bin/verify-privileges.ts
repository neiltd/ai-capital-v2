// Verify the Phase 1 database authority boundary against the live cluster.
//
// DELIBERATELY NOT A VITEST TEST. Checking the agent role's object-level grants
// requires connecting to production with the agent credential — and handing the
// test suite a credential that can read production would widen exactly the
// boundary this phase exists to narrow. So this is a separate command, run by a
// human or by Warden, not by `pnpm -r test`.
//
// It closes the gap Warden identified in privilege-model.test.ts: that test
// inspects cluster catalogs only (pg_roles, pg_auth_members,
// has_database_privilege), so if `thanapold` ever granted ai_capital_agent
// INSERT/UPDATE/DELETE on a production table, the agent would gain a live write
// path and every assertion there would still pass.
//
//   pnpm --filter @common/db verify-privileges
//
// Read-only. Exits non-zero on any violation.

import { createClient } from '../src/pool.js'

const PRODUCTION = 'ai_capital'
const WRITE_PRIVS = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  if (ok) {
    console.log(`  ok    ${label}`)
  } else {
    failures++
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main(): Promise<void> {
  const agentUrl = process.env.AGENT_DATABASE_URL
  if (!agentUrl) {
    console.error('AGENT_DATABASE_URL is not set. Source the repo .env first.')
    process.exit(2)
  }

  // Not a test runtime, so the guard is inert here — but routed through the
  // factory anyway so there is exactly one construction path in the repo.
  const c = createClient(agentUrl)
  await c.connect()

  const { rows: who } = await c.query<{ u: string; d: string; su: boolean }>(
    `SELECT current_user AS u, current_database() AS d,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su`)
  console.log(`\nconnected as ${who[0].u} to ${who[0].d}\n`)
  check(who[0].u === 'ai_capital_agent', 'connected as the agent role', `got ${who[0].u}`)
  check(who[0].d === PRODUCTION, 'connected to production (reads must work)', `got ${who[0].d}`)
  check(who[0].su === false, 'agent is not a superuser')

  // ── The gap this file exists to close: object-level write grants ─────────
  const { rows: tables } = await c.query<{ schemaname: string; tablename: string }>(
    `SELECT schemaname, tablename FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog','information_schema')
      ORDER BY 1,2`)
  console.log(`\nchecking ${tables.length} production tables for write grants to the agent role`)

  const writable: string[] = []
  const unreadable: string[] = []
  for (const t of tables) {
    const fq = `${t.schemaname}.${t.tablename}`
    const { rows } = await c.query<Record<string, boolean>>(
      'SELECT ' + WRITE_PRIVS.map(p => `has_table_privilege($1, '${p}') AS "${p}"`).join(', '),
      [fq])
    for (const p of WRITE_PRIVS) if (rows[0][p]) writable.push(`${fq}:${p}`)

    const { rows: sel } = await c.query<{ s: boolean }>(
      `SELECT has_table_privilege($1, 'SELECT') AS s`, [fq])
    if (!sel[0].s) unreadable.push(fq)
  }
  check(writable.length === 0, 'agent holds NO write privilege on any production table',
    writable.length ? writable.slice(0, 8).join(', ') : '')
  check(unreadable.length === 0, 'agent can read every production table',
    unreadable.length ? `unreadable: ${unreadable.join(', ')}` : '')

  // ── Sequences: nextval/setval are writes ────────────────────────────────
  const { rows: seqs } = await c.query<{ fq: string }>(
    `SELECT schemaname||'.'||sequencename AS fq FROM pg_sequences
      WHERE schemaname NOT IN ('pg_catalog','information_schema')`)
  const seqWritable: string[] = []
  for (const s of seqs) {
    const { rows } = await c.query<{ u: boolean }>(
      `SELECT has_sequence_privilege($1, 'USAGE') OR has_sequence_privilege($1, 'UPDATE') AS u`, [s.fq])
    if (rows[0].u) seqWritable.push(s.fq)
  }
  check(seqWritable.length === 0, `agent cannot advance any of ${seqs.length} sequences`,
    seqWritable.join(', '))

  // ── Schema-level CREATE ─────────────────────────────────────────────────
  const { rows: schemas } = await c.query<{ n: string }>(
    `SELECT nspname AS n FROM pg_namespace
      WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'`)
  const creatable: string[] = []
  for (const s of schemas) {
    // Sequential: one Client cannot run concurrent queries.
    const { rows } = await c.query<{ c: boolean }>(`SELECT has_schema_privilege($1, 'CREATE') AS c`, [s.n])
    if (rows[0].c) creatable.push(s.n)
  }
  check(creatable.length === 0, 'agent cannot CREATE in any production schema', creatable.join(', '))

  // ── SECURITY DEFINER functions are an indirect write path ───────────────
  const { rows: secdef } = await c.query<{ n: string }>(
    `SELECT n.nspname||'.'||p.proname AS n FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'`)
  check(secdef.length === 0, 'no SECURITY DEFINER functions exist to elevate through',
    secdef.map(r => r.n).join(', '))

  // ── The test-runtime role must still be locked out ──────────────────────
  const { rows: tr } = await c.query<{ can: boolean }>(
    `SELECT has_database_privilege('ai_capital_test_runtime', $1, 'CONNECT') AS can`, [PRODUCTION])
  check(tr[0].can === false, 'test-runtime role cannot CONNECT to production')

  const { rows: pub } = await c.query<{ conn: boolean; temp: boolean }>(
    `SELECT has_database_privilege('public', $1, 'CONNECT') AS conn,
            has_database_privilege('public', $1, 'TEMP')    AS temp`, [PRODUCTION])
  check(pub[0].conn === false, 'PUBLIC cannot CONNECT to production')
  check(pub[0].temp === false, 'PUBLIC has no TEMP on production')

  const { rows: supers } = await c.query<{ rolname: string }>(
    `SELECT rolname FROM pg_roles WHERE rolsuper AND rolname NOT LIKE 'pg\\_%' ORDER BY 1`)
  check(supers.length === 1 && supers[0].rolname === 'thanapold',
    'exactly one superuser exists', supers.map(r => r.rolname).join(', '))

  const { rows: mem } = await c.query<{ member: string; granted: string }>(
    `SELECT r.rolname AS member, g.rolname AS granted
       FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.member
       JOIN pg_roles g ON g.oid = m.roleid
      WHERE r.rolname IN ('ai_capital_agent','ai_capital_test_runtime')`)
  check(mem.length === 0, 'restricted roles have no role memberships',
    mem.map(m => `${m.member}->${m.granted}`).join(', '))

  await c.end()

  console.log(failures === 0
    ? '\nAuthority boundary intact.\n'
    : `\n${failures} violation(s). The Phase 1 boundary has drifted.\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(2) })
