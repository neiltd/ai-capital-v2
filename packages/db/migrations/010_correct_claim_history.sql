-- Corrects a factually false statement in 009. Comments only — no schema,
-- constraint, index, trigger or data behaviour changes.
--
-- WHY THIS MIGRATION EXISTS RATHER THAN AN EDIT TO 009. Migration files are
-- checksum-locked once applied; editing 009 in place broke `db-migrate` when it
-- was attempted on 2026-08-25. More importantly, rewriting an applied migration
-- to make history look tidy is the same instinct this desk keeps having to
-- resist. Historical truth matters more than a clean migration log.
--
-- WHAT WAS WRONG. 009 line 20-21 states:
--
--   "Safe to rename — the table has never held a row, because nothing was ever
--    wired to write to it."
--
-- That was true when written and false by the time 009 was applied. On
-- 2026-08-26, between roughly 10:57 and 11:03 Asia/Bangkok, a test run carrying
-- CLAIM_WRITER_DATABASE_URL wrote 16 fixture claims and 6 run records into
-- production. They were removed the same hour and no fixture data survives, but
-- pg_stat_all_tables still records 79 insert and 73 delete events against
-- desk.agent_claims and 6/6 against desk.agent_runs.
--
-- The id sequences were subsequently setval-reset to 1, which means SEQUENCE
-- STATE IS NOT EVIDENCE OF ANYTHING on these two tables. A future reader
-- reconstructing history from `last_value` would conclude the tables had never
-- been written. They had. Anyone auditing these tables should use the tuple
-- counters, not the sequences.

COMMENT ON TABLE desk.agent_claims IS
  'Specialist agent claims under protocol claim/1. HISTORY: received 16 fixture '
  'rows from a test run on 2026-08-26 ~10:57-11:03 Asia/Bangkok (incident #2); '
  'all removed the same hour, no fixture data survives. The id sequence was '
  'setval-reset afterwards, so sequence state does NOT reflect insert history — '
  'use pg_stat_all_tables tuple counters when auditing. See migration 010 and '
  'docs/findings/2026-08-25-follow-ups.md.';

COMMENT ON TABLE desk.agent_runs IS
  'Per-run emission record (the denominator for strategic non-emission). '
  'HISTORY: received 6 fixture rows from the same 2026-08-26 test run as '
  'desk.agent_claims; all removed the same hour. Sequence was setval-reset and '
  'is not evidence of insert history. See migration 010.';

COMMENT ON SEQUENCE desk.agent_claims_id_seq IS
  'NOT TAMPER-EVIDENT. Reset to 1 on 2026-08-26 after incident #2 cleanup, '
  'despite 79 prior insert events. Do not cite last_value as proof that no rows '
  'were ever inserted.';

COMMENT ON SEQUENCE desk.agent_runs_id_seq IS
  'NOT TAMPER-EVIDENT. Reset to 1 on 2026-08-26 after incident #2 cleanup, '
  'despite 6 prior insert events. Do not cite last_value as proof that no rows '
  'were ever inserted.';
