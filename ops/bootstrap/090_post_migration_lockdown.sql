-- ═══════════════════════════════════════════════════════════════════════════
-- POST-MIGRATION LOCKDOWN. Closes the migration window.
--
-- RUN AS: a cluster administrator (REASSIGN OWNED needs membership in both the
-- source and target roles).
-- RUN WITH:
--   psql --no-psqlrc -v ON_ERROR_STOP=1 --single-transaction \
--        -d "$TARGET_DB" -v dbname="$TARGET_DB" \
--        -f ops/bootstrap/090_post_migration_lockdown.sql
--
-- WHY REASSIGN OWNED AND NOT JUST REVOKES. Revoking CREATE and role memberships
-- does not remove an object OWNER's ability to ALTER, DROP or GRANT on its own
-- objects. Leaving anything owned by the LOGIN role ai_capital_migrator would
-- make the steady-state claim false — an ACL assertion dressed up as a
-- guarantee. migrate.ts's MIGRATION_OWNER_ROLE should already have created
-- everything as ai_capital_owner; this is the backstop that makes it a fact
-- about pg_class/pg_proc/pg_namespace rather than a hope.
--
-- SCOPE: this reassigns only objects owned by ai_capital_migrator. PostgreSQL
-- system objects and extension-owned objects (btree_gist) are owned by other
-- roles and are untouched.
-- ═══════════════════════════════════════════════════════════════════════════

REASSIGN OWNED BY ai_capital_migrator TO ai_capital_owner;

-- The authority role needed CREATE only to define its own functions in 012 and
-- 017. USAGE is retained so those functions can still resolve their schemas.
REVOKE CREATE ON SCHEMA identity          FROM ai_capital_identity_authority;
REVOKE CREATE ON SCHEMA investment_ledger FROM ai_capital_identity_authority;

-- BOTH halves of the migrator's create authority, because 010 grants both and
-- either one left behind reopens the window by accident:
--   CREATE on the DATABASE  — what `CREATE SCHEMA IF NOT EXISTS db` checks
--   CREATE on SCHEMA db     — what `CREATE TABLE IF NOT EXISTS db.schema_migrations`
--                             checks, before its IF-NOT-EXISTS short-circuit
-- An earlier version revoked only the first, so `CREATE TABLE db.anything`
-- still succeeded after lockdown and the window was not actually closed.
REVOKE CREATE ON DATABASE :"dbname" FROM ai_capital_migrator;
REVOKE CREATE ON SCHEMA db          FROM ai_capital_migrator;

REVOKE ai_capital_owner              FROM ai_capital_migrator;
REVOKE ai_capital_identity_authority FROM ai_capital_migrator;

-- THE MIGRATION LEDGER ITSELF. Appending to db.schema_migrations is a
-- migration-window privilege, so it is revoked here with the rest of them.
--
-- An earlier version retained `SELECT, INSERT` permanently, reasoning that
-- re-opening a window should not also require repairing the runner's own
-- bookkeeping. That got the risk backwards. The ledger is the artefact every
-- downstream check trusts to say WHICH migrations are applied and with what
-- hashes; leaving a deployment login able to append to it after lockdown means
-- a closed window still admits a row claiming a migration ran when it could
-- not have. No repair is needed to reopen: re-running
-- ops/bootstrap/010_database_bootstrap.sql is the deliberate act that opens a
-- window, and it re-grants this INSERT as part of that act.
REVOKE INSERT ON db.schema_migrations FROM ai_capital_migrator;

-- DELIBERATELY NOT REVOKED: `USAGE ON SCHEMA db` and `SELECT ON
-- db.schema_migrations`. Reading a closed ledger is not a window privilege —
-- "which migrations are applied" must be answerable at any time, including by
-- monitoring that never opens a window.
--
-- After this file the migrator can READ db.schema_migrations and nothing else:
-- it owns nothing, inherits nothing, creates nothing, and appends nothing.
