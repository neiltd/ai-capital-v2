-- 019_dashboard_read_grants.sql — the operator dashboard's read privileges.
--
-- SLICE S4A. Grants `ai_capital_dashboard` exactly what
-- `apps/unified-platform/src/app/api/trade-graph/route.ts` reads, and nothing
-- else. That route is the ENTIRE PostgreSQL surface of the dashboard: every
-- other page reads JSON off disk, creator-studio uses Prisma SQLite, and
-- `src/lib/thesis-db.ts` and `markets/waves/trade/data.ts` use better-sqlite3.
-- Those SQLite writes confer no PostgreSQL privilege and none is granted here.
--
-- THE SURFACE, TRACED RATHER THAN ASSUMED. Six query sites, five tables, all
-- schema-qualified, all SELECT:
--
--   route.ts:68   select … from trade.countries
--   route.ts:69   select … from trade.chokepoints
--   route.ts:70   select … from trade.chokepoint_routes
--   route.ts:72   select … from trade.ticker_dependencies where ticker = $1
--   route.ts:77   select … from trade.ticker_dependencies
--   route.ts:86   select distinct on … from trade.flows f
--                   where exists (select 1 from trade.ticker_dependencies td …)
--
-- Every reference is schema-qualified, so this role needs no search_path
-- accommodation and no second schema for name resolution.
-- `apps/unified-platform/tests/credential-boundary.test.ts` pins that table set
-- against this file in both directions, so a sixth table added to the route
-- fails the unit gate rather than production.
--
-- WHAT IS DELIBERATELY ABSENT, AND WHY EACH ABSENCE IS LOAD-BEARING.
--
--   * NO write of any kind. `grep` for `pool.query` combined with
--     INSERT/UPDATE/DELETE across the whole app returns nothing. A network-facing
--     route that cannot write is a smaller problem than one that is merely not
--     currently writing.
--   * NO `USAGE ON SCHEMA public`. The route resolves no type, operator or
--     function there — it issues no `::vector` and no `<=>`. Withholding it is
--     the cheapest available proof, and the isolated gate asserts the positive
--     consequence: `SELECT 1::vector` as this role fails with SQLSTATE 42704.
--   * NO privilege in `identity` or `investment_ledger`. This is what keeps the
--     operator-dashboard domain and the future friend-facing `ai_capital_app`
--     domain structurally separate rather than separate by policy. The dashboard
--     cannot read the tenancy substrate at all.
--   * NO privilege in `capital`, `portfolio`, `thesis`, `briefing`, `graph`,
--     `desk`, `cash_ledger` or `db`.
--   * NO `ON ALL TABLES`, no `ALTER DEFAULT PRIVILEGES`. Both would silently
--     widen this role the next time a table is added to `trade`. The 2026-09-06
--     B3 remediation rejected exactly that shape when a broad diagnostic grant
--     was mistaken for a design.
--   * NO `WITH GRANT OPTION`, no role membership, no sequence `USAGE`, no
--     function `EXECUTE`, no `TEMPORARY`, no `CREATE`.
--
-- WHERE CONNECT COMES FROM. Not here. `ops/bootstrap/010_database_bootstrap.sql`
-- grants it, because the DATABASE is not an owner-owned object: this migration
-- executes under `SET LOCAL ROLE ai_capital_owner`, and a `GRANT ... ON DATABASE`
-- from that principal is refused outright with SQLSTATE 42501. The companion
-- rule — and the one that is far easier to get wrong — is that a
-- `GRANT ... ON SCHEMA public` from here would NOT be refused: it is silently
-- discarded with SQLSTATE 01007, `no privileges were granted`, which neither
-- ON_ERROR_STOP nor the node-postgres runner can observe. Migration 018 shipped
-- with exactly such a statement and granted nothing for it. The rule both files
-- now encode: 010 grants on DATABASE-OWNED objects, migrations grant on
-- OWNER-OWNED application objects.

GRANT USAGE ON SCHEMA trade TO ai_capital_dashboard;

GRANT SELECT ON trade.countries           TO ai_capital_dashboard;
GRANT SELECT ON trade.chokepoints         TO ai_capital_dashboard;
GRANT SELECT ON trade.chokepoint_routes   TO ai_capital_dashboard;
GRANT SELECT ON trade.ticker_dependencies TO ai_capital_dashboard;
GRANT SELECT ON trade.flows               TO ai_capital_dashboard;
