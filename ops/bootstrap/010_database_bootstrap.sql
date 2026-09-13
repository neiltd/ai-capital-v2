-- ═══════════════════════════════════════════════════════════════════════════
-- DATABASE BOOTSTRAP. Prepares ONE database so that migrations 011-017 can run.
--
-- RUN AS: a cluster administrator. It needs CREATE EXTENSION (superuser) and
-- the ability to SET ROLE ai_capital_owner.
-- RUN WITH:
--   psql --no-psqlrc -v ON_ERROR_STOP=1 --single-transaction \
--        -d "$TARGET_DB" -v dbname="$TARGET_DB" \
--        -f ops/bootstrap/010_database_bootstrap.sql
--
-- ON TRANSACTIONS: this file contains NO BEGIN/COMMIT. psql's
-- --single-transaction supplies exactly one, which is what makes `SET LOCAL
-- ROLE` below govern the CREATE statements that follow it. Combining the flag
-- with internal transaction control would silently break that.
--
-- ON ON_ERROR_STOP: mandatory. Without it psql continues after a failed SET
-- ROLE and creates objects under the wrong owner — the precise failure this
-- ordering exists to prevent.
--
-- NOTHING HERE GRANTS ANYTHING ON `identity`. That schema does not exist until
-- migration 011 creates it; its grants live there, after the CREATE SCHEMA.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Extensions. BOTH of them, and BEFORE the revoke below. ─────────────────
--
-- Extension creation needs superuser, which is why it is here and not in a
-- migration — and why every extension a migration expects must be provisioned
-- HERE, not just the one this file originally remembered.
--
-- btree_gist: required by the exclusion constraint on
--   identity.workspace_service_grants, which needs `=` operators on uuid and on
--   an enum inside a gist index.
--
-- vector: required by migration 006, which is PUBLISHED AND IMMUTABLE and says
--   `CREATE EXTENSION IF NOT EXISTS vector` unqualified. Omitting it here broke
--   the chain twice over on a fresh database: the statement resolves into
--   `public`, where ai_capital_owner has no CREATE (and must not be given any),
--   and extension creation needs superuser, which the owner deliberately is
--   not. Pre-creating it as the administrator makes 006's statement the no-op
--   its IF NOT EXISTS promises.
-- `WITH SCHEMA public`, EXPLICITLY, ON BOTH.
--
-- Both extensions are RELOCATABLE, so an unqualified CREATE EXTENSION installs
-- into the first schema of the creating session's effective `search_path`.
-- `--no-psqlrc` does not settle that: a `search_path` set with
-- ALTER DATABASE ... SET or ALTER ROLE ... SET is applied by the SERVER at
-- connect time, before psql runs anything, and PGOPTIONS can override it again.
-- So an administrator whose role or database carries a custom search_path would
-- silently place `vector` and `btree_gist` somewhere else — and everything
-- downstream assumes `public`: the single USAGE grant below, the lockdown that
-- preserves it, and the runtime assertion that both extensions live there.
-- Naming the schema makes the placement a property of this file rather than of
-- whoever happens to run it.
--
-- LIMIT, stated rather than implied: `IF NOT EXISTS` means this pins placement
-- on a FRESH database, which is this file's contract. It does not RELOCATE an
-- extension a previous run put elsewhere — that would need
-- `ALTER EXTENSION ... SET SCHEMA`, which mutates existing state and is not a
-- bootstrap's business. So the WITH SCHEMA clause is necessary and NOT
-- sufficient, and the postcondition below closes the gap: this file refuses to
-- continue rather than proceeding on an assumption it has not checked.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS vector     WITH SCHEMA public;

-- ── POSTCONDITION: both extensions ARE in `public`. Fail closed. ───────────
--
-- WHY A CHECK AND NOT JUST THE CLAUSE ABOVE. `CREATE EXTENSION IF NOT EXISTS
-- ... WITH SCHEMA public` is a no-op when the extension already exists — in ANY
-- schema. It emits a notice and returns success, so on a database where a
-- previous run (or a different operator, or a packaging default) installed
-- `vector` into, say, `extensions`, every statement in this file still succeeds
-- and the bootstrap reports a clean run. Everything downstream then quietly
-- assumes something untrue: the single `GRANT USAGE ON SCHEMA public TO
-- ai_capital_owner` below would not make the type visible, migration 006 would
-- fail with `type "vector" does not exist`, and the failure would surface as a
-- migration bug rather than a placement one.
--
-- The whole point of a bootstrap is that what follows it may rely on it. A
-- check that would rather stop than be relied upon wrongly is the only honest
-- way to earn that.
--
-- WHAT IT DELIBERATELY DOES NOT DO: it does not move, drop or recreate a
-- misplaced extension. Relocating one silently would be exactly the kind of
-- unrequested mutation of existing state this design refuses; the message names
-- the remedy and leaves the decision to an operator.
--
-- It reads only `pg_extension` and `pg_namespace`, needs no privilege beyond
-- the cluster-administrator authority this file already requires, and contains
-- no transaction control — `--single-transaction` supplies the one transaction,
-- and RAISE aborts it, which is what "fail closed" means here.
DO $$
DECLARE wrong text;
BEGIN
  SELECT string_agg(
           required.name || ' is ' ||
           coalesce(
             (SELECT 'installed in schema ' || n.nspname
                FROM pg_extension x
                JOIN pg_namespace n ON n.oid = x.extnamespace
               WHERE x.extname = required.name),
             'not installed'),
           '; ' ORDER BY required.name)
    INTO wrong
    FROM (VALUES ('btree_gist'), ('vector')) AS required(name)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_extension x
       JOIN pg_namespace n ON n.oid = x.extnamespace
      WHERE x.extname = required.name
        AND n.nspname = 'public');

  IF wrong IS NOT NULL THEN
    RAISE EXCEPTION
      'bootstrap postcondition failed: every required extension must exist in schema public, but %',
      wrong
      USING HINT =
        'CREATE EXTENSION ... WITH SCHEMA public is a no-op when the extension already '
        'exists in another schema. Relocate it deliberately with '
        'ALTER EXTENSION <name> SET SCHEMA public (or drop and recreate it), then re-run '
        'this bootstrap. This script does not move an existing extension.';
  END IF;

  RAISE NOTICE 'bootstrap: btree_gist and vector are both present in schema public';
END $$;

-- `ALL` already covers CREATE and USAGE. (An earlier draft wrote
-- `REVOKE ALL, CREATE ON SCHEMA public`, which is not valid syntax.)
--
-- ORDER MATTERS: the extensions above land in `public`, so they must be created
-- BEFORE this revoke — and the revoke must not be softened afterwards.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- ── The single exception to "nothing may use public". ──────────────────────
--
-- USAGE, to ai_capital_owner, and to nobody else.
--
-- WHY IT IS NEEDED. Revoking from PUBLIC removes the ability to SEE anything in
-- `public` — including the extension objects this file just installed there.
-- Three DDL name resolutions performed by the owner (via MIGRATION_OWNER_ROLE)
-- land in that schema:
--   006  `embedding vector(384)`              — the TYPE lives in public
--   006  `USING hnsw (embedding vector_cosine_ops)`
--                                             — a pgvector OPERATOR CLASS does
--   011  `EXCLUDE USING gist (...)`           — btree_gist OPERATOR CLASSES do
-- Without USAGE the first fails with `type "vector" does not exist`, which
-- reads like a missing extension rather than a missing privilege.
--
-- WHY IT IS ONLY THE OWNER. Source tracing over migrations 011-017 finds
-- exactly one reference from the tenancy schemas into `public` — 011's gist
-- opclass lookup, performed at DDL time by the owner. No runtime role holds any
-- grant on `capital.*` (where the only `vector` column lives) or on `public`,
-- and once the exclusion constraint exists its index references opclasses by
-- OID, so DML needs no schema lookup. A broader grant would be privilege
-- nobody has been shown to need.
--
-- WHY NOT CREATE. The owner creating objects in `public` is exactly what the
-- revoke above exists to prevent; every application object belongs in a named
-- schema this design owns.
GRANT USAGE ON SCHEMA public TO ai_capital_owner;

-- CONNECT AND NOTHING ELSE. Every role here receives the right to open a
-- connection and no privilege inside the database; what each may then do is
-- granted per-object by the migrations, never here. `ai_capital_pipeline` and
-- `ai_capital_claim_writer` are on this list for exactly that reason: without
-- CONNECT they cannot reach the database at all, and a migration cannot supply
-- it for them --- migrations run as `ai_capital_owner`, which holds CONNECT
-- without the right to re-grant it and does not own the database, so a GRANT
-- CONNECT issued from a migration is refused with SQLSTATE 42501. This file is
-- the only place it can be said. Nothing in ops/ confers a re-grant right on
-- any role, deliberately: a role able to pass CONNECT on could widen database
-- access from inside a migration.
GRANT CONNECT ON DATABASE :"dbname"
  TO ai_capital_migrator, ai_capital_app, ai_capital_importer,
     ai_capital_agent, ai_capital_operator,
     ai_capital_pipeline, ai_capital_claim_writer;
GRANT CREATE, CONNECT ON DATABASE :"dbname" TO ai_capital_owner;

-- ── Migration-window authority ──────────────────────────────────────────────
-- WITH INHERIT FALSE grants ONLY the right to SET ROLE, never ambient
-- privilege: an accidental connection as the migrator has none of the owner's
-- rights until it deliberately assumes the role. (PostgreSQL 16+ syntax; the
-- server is 17.) ops/bootstrap/090_post_migration_lockdown.sql revokes both.
GRANT ai_capital_owner              TO ai_capital_migrator WITH INHERIT FALSE, SET TRUE;
GRANT ai_capital_identity_authority TO ai_capital_migrator WITH INHERIT FALSE, SET TRUE;

-- migrate.ts runs BOOTSTRAP_SQL (`CREATE SCHEMA IF NOT EXISTS db; CREATE TABLE
-- IF NOT EXISTS db.schema_migrations`) outside any transaction, as the
-- connecting role, so the migrator needs the privileges those two statements
-- check — for the duration of the window, and no longer.
--
-- `CREATE SCHEMA IF NOT EXISTS db` checks CREATE on the DATABASE.
GRANT CREATE ON DATABASE :"dbname" TO ai_capital_migrator;

-- The runner's targets, pre-created and OWNED BY the owner so that migrate.ts's
-- own bootstrap creates nothing and owns nothing.
SET LOCAL ROLE ai_capital_owner;
  CREATE SCHEMA IF NOT EXISTS db;
  CREATE TABLE IF NOT EXISTS db.schema_migrations (
    filename    TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    sha256      TEXT NOT NULL
  );
RESET ROLE;

-- PERMANENT: READING the migration ledger. `USAGE ON SCHEMA db` and `SELECT`
-- survive lockdown so a closed window can still be INSPECTED — "which
-- migrations are applied, and with what hashes" must be answerable at any time,
-- including by monitoring that never opens a window.
GRANT USAGE ON SCHEMA db TO ai_capital_migrator;
GRANT SELECT ON db.schema_migrations TO ai_capital_migrator;

-- WINDOW-ONLY: APPENDING to it. An earlier version granted `SELECT, INSERT`
-- here and 090 deliberately retained both, on the reasoning that the runner's
-- bookkeeping should not need repairing to reopen a window. That reasoning was
-- backwards: a permanent INSERT means a closed window still admits a row into
-- db.schema_migrations, so a deployment login can record that a migration ran
-- when it could not have run — the ledger is exactly the artefact that must not
-- be writable outside a window, because everything downstream trusts it to say
-- what the schema is.
--
-- Reopening needs no repair step: re-running THIS FILE is the deliberate act
-- that opens a window, and this grant is part of it. 090 revokes it again.
GRANT INSERT ON db.schema_migrations TO ai_capital_migrator;

-- TEMPORARY, and the half an earlier version of this file got wrong.
--
-- `CREATE TABLE IF NOT EXISTS db.schema_migrations` checks CREATE on the
-- SCHEMA, and it does so BEFORE the IF-NOT-EXISTS short-circuit. The table
-- above already exists, so the statement is a no-op — but a no-op is still a
-- statement, and PostgreSQL resolves its creation namespace and checks
-- ACL_CREATE there first. The file previously reasoned only about CREATE on the
-- DATABASE and concluded "both statements are no-ops once the objects below
-- exist"; the first is, the second is not, and every fresh database failed on
-- the migration runner's very first statement with:
--
--     permission denied for schema db
--
-- ops/bootstrap/090_post_migration_lockdown.sql revokes exactly this, and
-- nothing else in this block, when the window closes.
GRANT CREATE ON SCHEMA db TO ai_capital_migrator;
