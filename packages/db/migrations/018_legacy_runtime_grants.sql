-- ═══════════════════════════════════════════════════════════════════════════
-- LEGACY RUNTIME GRANTS. Object privileges for the two runtime identities that
-- operate the pre-tenancy schemas: `ai_capital_pipeline` and
-- `ai_capital_claim_writer`.
--
-- WHAT THIS FILE IS FOR. Migrations 001-010 built eight application schemas and
-- never granted anything: until now the scheduled pipeline connected as a
-- cluster SUPERUSER, which bypasses row-level security unconditionally, so
-- every boundary 011-017 installs would have been decorative on the one
-- connection that runs every night. This file is the least-privilege
-- replacement for that superuser.
--
-- WHERE CONNECT COMES FROM, AND WHY NOT HERE. `ops/bootstrap/010_database_bootstrap.sql`
-- grants both roles CONNECT on the database. It cannot be done here: migrations
-- execute under `SET LOCAL ROLE ai_capital_owner`, and that role holds CONNECT
-- without the right to re-grant it and does not own the database, so a
-- GRANT CONNECT issued from a migration is refused with SQLSTATE 42501.
-- Database access and object access are deliberately granted in two different
-- places by two different principals.
--
-- HOW THE MATRIX WAS DERIVED. Every privilege below is reachable from one of
-- the 23 stages of DAILY_PIPELINE in `packages/queue/src/jobs.ts`, traced
-- through the import graph to an actually-invoked store method. A privilege
-- whose only call site is a manual CLI is NOT here, even where the same file
-- defines it: `portfolio.positions` DELETE (`removePosition`, cli-portfolio),
-- `capital.pending_manual_input` UPDATE (`resolvePendingManualInput`,
-- cli-config), every `graph.*` and `trade.*` write (dependency-graph-engine and
-- trade-graph are not DAG stages). Those paths keep running under the
-- administrator credential until a manual-mutation role is separately designed.
-- Two methods have no callers at all — `capital.api_budget`'s pair and
-- `thesis.theme_memberships`' writer — so neither table appears below.
--
-- ROLE STATE. `migrate.ts` enters this file with `SET LOCAL ROLE
-- ai_capital_owner` already in force and a pinned `search_path`. Every GRANT
-- here is issued by the owner, which owns every object named. This file
-- contains no RESET ROLE, no SET ROLE, and no transaction control: the runner
-- supplies exactly one transaction per migration.
--
-- WHAT THIS FILE DOES NOT DO. It creates nothing, drops nothing, alters no
-- ownership, sets no default privileges, grants no role membership, names no
-- credential, and touches `identity`, `investment_ledger`, `cash_ledger` and
-- `graph` not at all.
-- ═══════════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. ai_capital_pipeline — SCHEMA USAGE
--
-- USAGE only. CREATE is granted to nobody: every application object belongs to
-- ai_capital_owner and is created by a migration, never by a runtime role.
-- ─────────────────────────────────────────────────────────────────────────────

GRANT USAGE ON SCHEMA capital   TO ai_capital_pipeline;
GRANT USAGE ON SCHEMA thesis    TO ai_capital_pipeline;
GRANT USAGE ON SCHEMA portfolio TO ai_capital_pipeline;
GRANT USAGE ON SCHEMA briefing  TO ai_capital_pipeline;
GRANT USAGE ON SCHEMA trade     TO ai_capital_pipeline;

-- WHY `public`, WHICH 010 REVOKED FROM PUBLIC AND GRANTED ONLY TO THE OWNER.
-- `packages/db/src/vector-store/pg.ts` builds `$N::vector` and
-- `ORDER BY embedding <=> $N` inside search(). The `vector` TYPE and pgvector's
-- `<=>` OPERATOR both live in `public`, and PostgreSQL requires USAGE on a
-- schema to resolve any object in it by name. search() is reachable from the
-- retrieval paths of ai-analysis-engine, investment-analyst-agents and
-- scenario-discover, so without this grant those stages fail with
-- "permission denied for schema public" — a privilege error that reads like a
-- missing extension. USAGE only; CREATE on `public` is still granted to nobody.
GRANT USAGE ON SCHEMA public TO ai_capital_pipeline;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. ai_capital_pipeline — TABLE PRIVILEGES
--
-- One statement per relation, so the privilege set of each is readable — and
-- checkable — without parsing a grouped grantee list.
--
-- Where a statement carries UPDATE that the source's verb does not obviously
-- require, it is because `INSERT ... ON CONFLICT DO UPDATE` needs UPDATE on the
-- target: capital.watchlist (ticker), capital.short_interest (date, ticker) and
-- briefing.predictions (date) are all upserts.
-- ─────────────────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE ON capital.watchlist            TO ai_capital_pipeline;
GRANT SELECT, INSERT         ON capital.documents            TO ai_capital_pipeline;
GRANT SELECT, INSERT         ON capital.fetch_log            TO ai_capital_pipeline;
GRANT SELECT, INSERT         ON capital.pending_manual_input TO ai_capital_pipeline;
GRANT SELECT, INSERT, UPDATE ON capital.short_interest       TO ai_capital_pipeline;
GRANT SELECT, INSERT         ON capital.chunks               TO ai_capital_pipeline;

GRANT SELECT                 ON thesis.theses                TO ai_capital_pipeline;
GRANT SELECT                 ON thesis.assumptions           TO ai_capital_pipeline;
GRANT SELECT                 ON thesis.narratives            TO ai_capital_pipeline;
GRANT SELECT, INSERT         ON thesis.proposals             TO ai_capital_pipeline;
GRANT INSERT                 ON thesis.proposal_changes      TO ai_capital_pipeline;

-- SELECT and UPDATE only. The pipeline reads positions and refreshes prices;
-- creating, deleting and re-strategising a position are manual acts.
GRANT SELECT, UPDATE         ON portfolio.positions          TO ai_capital_pipeline;
GRANT SELECT, UPDATE         ON portfolio.trade_log          TO ai_capital_pipeline;

GRANT INSERT, UPDATE         ON briefing.predictions         TO ai_capital_pipeline;

GRANT SELECT                 ON trade.ticker_dependencies    TO ai_capital_pipeline;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. ai_capital_pipeline — SEQUENCE PRIVILEGES
--
-- Exactly one. `logFetch` omits `id`, so capital.fetch_log's SERIAL default
-- calls nextval, which needs USAGE. No other DAG-reachable INSERT targets a
-- table with a sequence-backed column: portfolio.trade_log's only INSERT
-- (`logTrade`) is manual, and briefing.predictions has no sequence.
--
-- USAGE, never SELECT. SELECT on a sequence is what `currval` and `lastval`
-- need, and a repository-wide search for nextval/currval/lastval/setval in
-- apps/, packages/ and scripts/ returns zero hits.
-- ─────────────────────────────────────────────────────────────────────────────

GRANT USAGE ON SEQUENCE capital.fetch_log_id_seq TO ai_capital_pipeline;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. ai_capital_claim_writer — THE CLAIM PROTOCOL, AND NOTHING ELSE
--
-- `packages/db/src/agent-claims.ts` reaches these two tables through its own
-- CLAIM_WRITER_DATABASE_URL. The separation from ai_capital_pipeline is the
-- point: the desk's record of what an agent asserted is not the pipeline's to
-- write, and a leaked pipeline credential must not be able to fabricate a claim.
--
-- UPDATE on agent_claims is bounded by the trigger, not by the grant. The
-- BEFORE UPDATE trigger `agent_claims_assertion_immutable` (008, redefined in
-- 009) refuses any edit to the assertion or its provenance, so this privilege
-- permits a status or resolution transition and not a revision of history.
--
-- No SELECT on agent_runs: no statement anywhere reads it. `RETURNING id` on
-- the agent_claims INSERT reads the table row, not the sequence, and is covered
-- by the SELECT granted below.
-- ─────────────────────────────────────────────────────────────────────────────

GRANT USAGE ON SCHEMA desk TO ai_capital_claim_writer;

GRANT SELECT, INSERT, UPDATE ON desk.agent_claims TO ai_capital_claim_writer;
GRANT INSERT                 ON desk.agent_runs   TO ai_capital_claim_writer;

GRANT USAGE ON SEQUENCE desk.agent_claims_id_seq TO ai_capital_claim_writer;
GRANT USAGE ON SEQUENCE desk.agent_runs_id_seq   TO ai_capital_claim_writer;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. TRIGGER-FUNCTION HARDENING — separate from every grant above
--
-- `desk.agent_claims_assertion_is_immutable()` carries a NULL proacl, which is
-- not "no grants": a NULL ACL means the built-in default, and for a FUNCTION
-- that default is EXECUTE TO PUBLIC. Every role in the cluster can call it
-- directly.
--
-- NO COMPENSATING GRANT ACCOMPANIES THIS REVOKE, DELIBERATELY. PostgreSQL
-- checks EXECUTE on a trigger function when the trigger is CREATED, against the
-- trigger's creator — not on every firing. Revoking PUBLIC EXECUTE therefore
-- leaves `agent_claims_assertion_immutable` firing exactly as before for every
-- writer, including ai_capital_claim_writer, while removing the ability to
-- invoke the function outside a trigger context.
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION desk.agent_claims_assertion_is_immutable() FROM PUBLIC;
