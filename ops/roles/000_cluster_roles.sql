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
