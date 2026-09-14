-- ═══════════════════════════════════════════════════════════════════════════
-- CLUSTER ROLES. Creates roles and NOTHING else — no database objects, no
-- grants on any schema, no extensions.
--
-- RUN AS: a cluster administrator (superuser, or a role with CREATEROLE).
-- RUN WITH:
--   psql --no-psqlrc -v ON_ERROR_STOP=1 --single-transaction \
--        -d postgres -f ops/roles/000_cluster_roles.sql
--
-- This file is NOT a migration. `packages/db/src/migrate.ts` connects as the
-- application's migrator, which deliberately has no CREATEROLE; putting role
-- creation in the ordinary migration path would require giving the application
-- cluster-level authority it must never hold.
--
-- WHY EVERY RUNTIME ROLE HAS ZERO MEMBERSHIPS. `SET ROLE` can only target a
-- role you are a member of. With no memberships, a runtime login cannot assume
-- another service's identity at all — which is what makes `session_user` a
-- trustworthy basis for authorization in identity.* . The only statement that
-- rewrites `session_user` is SET SESSION AUTHORIZATION, and that needs
-- superuser, which none of these roles has.
-- ═══════════════════════════════════════════════════════════════════════════

-- Owns every schema, table, view, index and trigger. NOLOGIN: no credential
-- exists for it. This matters because FORCE ROW LEVEL SECURITY binds the table
-- owner, so an owner with a password would be a way around every policy.
CREATE ROLE ai_capital_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT NOREPLICATION;

-- Owns the SECURITY DEFINER functions, and only those. It exists because those
-- functions read identity tables that carry FORCE RLS: a function owned by
-- ai_capital_owner would hit default-deny and silently return zero rows.
CREATE ROLE ai_capital_identity_authority
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT NOREPLICATION;

-- Deployment identity. Assumes ai_capital_owner during a migration window only.
CREATE ROLE ai_capital_migrator
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;

-- Human request runtime. Holds NO tenant privilege in this foundation: there is
-- no session mechanism yet, so there is no trustworthy way to derive a
-- workspace for a person. Activated at the OIDC gate.
CREATE ROLE ai_capital_app
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;

-- The archive importer and the manual-entry domain API.
CREATE ROLE ai_capital_importer
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;

-- Specialist agents: SELECT only, and now bound by row-level security like
-- everyone else. Denied raw import rows and every document table.
CREATE ROLE ai_capital_agent
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;

-- The scheduled pipeline's own identity: the daily DAG, every stage app it
-- spawns, and the alert/price scripts. It reads and writes the six legacy
-- schemas (briefing, capital, graph, portfolio, thesis, trade) and holds
-- NOTHING in identity, desk or investment_ledger.
--
-- WHY IT EXISTS AT ALL. Until now the pipeline connected as a cluster
-- SUPERUSER, which bypasses row-level security unconditionally — so every
-- boundary 011-017 install would have been decorative on the one connection
-- that runs every night. Swapping the endpoint without swapping the identity
-- would have preserved exactly that.
--
-- WHY NOT ai_capital_agent. That role is the specialist agents' SELECT-only
-- identity and migration 017 deliberately gives it no ledger privilege. A role
-- that writes portfolio.positions every day is a different thing with a
-- different blast radius, and conflating them would silently hand six
-- read-only subagents the ability to mutate the book.
CREATE ROLE ai_capital_pipeline
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT NOREPLICATION;

-- The claim protocol's identity, and only that: packages/db/src/agent-claims.ts
-- reaches desk.agent_claims and desk.agent_runs through its own
-- CLAIM_WRITER_DATABASE_URL, deliberately separate from every other credential.
--
-- WHY IT IS NOT FOLDED INTO ai_capital_pipeline. The separation is the point.
-- The claim tables are the desk's record of what an agent asserted and when;
-- the pipeline has no business writing them, and a leaked pipeline credential
-- must not be able to fabricate a claim. Its UPDATE is further constrained by
-- desk.agent_claims_assertion_immutable, which refuses to let an assertion be
-- rewritten in place — the grant permits a status transition, the trigger
-- forbids revising history.
CREATE ROLE ai_capital_claim_writer
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT NOREPLICATION;

-- GLOBAL GRANT ADMINISTRATOR — read this before granting it to anyone.
--
-- This role can cancel or revoke a capability grant in ANY workspace. That is
-- deliberate and unavoidable: grant administration is a cross-tenant function,
-- and scoping it per workspace would require a grant to administer grants,
-- which is circular.
--
-- Its blast radius is bounded by what it is NOT given rather than by scoping:
--   * CONNECT on the database
--   * USAGE on schema identity
--   * EXECUTE on identity.terminate_service_grant
-- and nothing else. NO table privilege of any kind, no role membership, no
-- schema access to investment_ledger. It cannot read a transaction, an account,
-- a document or an archive row. It can only end a grant, and every termination
-- it performs records an immutable reason and its own principal id.
CREATE ROLE ai_capital_operator
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;

COMMENT ON ROLE ai_capital_operator IS
  'Global grant administrator. Terminates capability grants in any workspace. '
  'Holds no table privileges and no role memberships.';


-- THE OPERATOR DASHBOARD'S READ IDENTITY — slice S4A.
--
-- `apps/unified-platform` serves one PostgreSQL route,
-- `src/app/api/trade-graph/route.ts`, which issues six SELECTs against five
-- tables in schema `trade` and nothing else. Until now that route called
-- getPool() and therefore connected on DATABASE_URL — which in the Next process
-- is Prisma's SQLite `file:` URL, so the route's behaviour depended on how the
-- server happened to be launched. This role gives it a credential of its own.
--
-- WHY IT IS NOT ai_capital_agent. Both are read-only, which makes them look
-- interchangeable, and they are not. `ai_capital_agent` is handed to specialist
-- subagents that compose arbitrary SQL; the dashboard executes six fixed
-- statements. Sharing one role would mean a leaked dashboard credential reads
-- everything the agents can, and every future widening of the agents' surface
-- silently widens a network-facing route's.
--
-- WHY IT IS NOT ai_capital_app, and never becomes it. `ai_capital_app` is the
-- future friend-facing multi-tenant identity whose whole premise is per-workspace
-- RLS bound to an authenticated session. This role is a single-operator,
-- trusted-device surface. The separation is structural, not policy: 019 gives
-- this role nothing in `identity` or `investment_ledger`, so it cannot read the
-- tenancy substrate at all. ai_capital_app remains unprovisioned and blocked.
--
-- WHAT IT DELIBERATELY DOES NOT GET. No TEMPORARY, no CREATE anywhere, no USAGE
-- on `public` — it runs no pgvector query, and withholding `public` is the
-- cheapest proof it cannot. No write of any kind, no sequence, no function
-- EXECUTE, no membership, no grant option. Its object privileges are granted by
-- packages/db/migrations/019_dashboard_read_grants.sql; its CONNECT comes from
-- ops/bootstrap/010_database_bootstrap.sql, because the database is not an
-- owner-owned object and a migration cannot grant on it.
CREATE ROLE ai_capital_dashboard
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT NOREPLICATION;

COMMENT ON ROLE ai_capital_dashboard IS
  'Operator dashboard read identity. SELECT on five trade tables and nothing '
  'else. Never the friend-facing ai_capital_app role.';
