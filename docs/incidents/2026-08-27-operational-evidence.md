# Evidence baseline — captured 2026-08-27 16:11:13 +07 (+0700)

Captured BEFORE any repair. Read-only. Nothing in production was mutated.

## Wall clock
```
local   : 2026-08-27 16:11:13 +07 (+0700)
UTC     : 2026-08-27 09:11:13 UTC
```

## launchd state
```
PID	Status	Label
-	0	com.thanapol.ai-capital.alerts
81390	0	com.thanapol.ai-capital.worker
-	0	com.thanapol.ai-capital.daily

--- com.thanapol.ai-capital.daily ---
	state = not running
	program = /bin/bash
	runs = 3
	last exit code = 0
		state = active
		state = active
	properties = runatload | inferred program
--- com.thanapol.ai-capital.worker ---
	state = running
	program = /usr/bin/caffeinate
		PIPELINE_RUNS_DB => /Users/thanapold/Desktop/Projects.nosync/data/pipeline-runs.db
	runs = 1
	last exit code = (never exited)
		state = active
		state = active
	job state = running
--- com.thanapol.ai-capital.alerts ---
	state = not running
	program = /bin/bash
	runs = 2358
	last exit code = 0
		state = active
		state = active
	job state = exited
	properties = inferred program
```

## P1 — scheduler evidence
```
daily agent: runs=3 total; log shows exactly 3 fires:
[2026-08-26 21:03:32]
[2026-08-26 21:03:32]
[2026-08-26 21:03:33]

machine state (pmset), 07:00 window:
  2026-08-25  awake (Wake 06:51:39) -> agent fired 09:20 and 21:12
  2026-08-26  ASLEEP since 08-25 22:05:23; first power event 11:56:14 -> agent never fired
  2026-08-27  ASLEEP since 08-26 22:22:58; first power event 10:13:25 -> agent never fired

uptime: 52 days  (boot Mon Jul  6 12:07:40 2026 — no reboot, so RunAtLoad has not re-fired)
alerts agent: runs=2358, still firing (last write Aug 27 16:13)
  alerts StartCalendarInterval covers US session 6:00-13:00 PT = 20:00-03:00 Asia/Bangkok — hours the machine is awake.
  daily StartCalendarInterval is 07:00 Asia/Bangkok — an hour the machine is reliably asleep.
```

## P2 — SEC Form-4 evidence
```
fetch_log(sec_form4) productive days, entire history:  2026-06-06=14  2026-06-07=16  2026-06-10=4  2026-07-18=3   (all other runs 0)
upstream reachable      : data.sec.gov HTTP 200 with the code's own placeholder User-Agent
upstream has data       : NVDA 562 Form 4/4A in recent feed; filings 2026-08-24, 08-12, 08-07
filing XML reachable    : all three fetched HTTP 200 (2044 / 6527 / 5283 bytes)
parser works            : 2 of 3 contain nonDerivativeTransaction entries
client works in isolation: read-only probe over 4 tickers returned 4 documents
  NVDA published=2026-08-12 | AAPL 2026-08-20 | AMD 2026-08-26 | CRWD 2026-08-25
PRODUCTION SCALE        : 83 Form-4 targets (SQLite watchlist), COMPANY_CONCURRENCY=6,
                          plus up to 10 XML fetches each at concurrency 3
ROOT CAUSE              : 579 x '[SEC-Form4] <TICKER>: Request failed with status code 429'
                          545 of them in logs/queue-worker.err.log (written 2026-08-26 22:26)
                          429s appear for NO other source
```

## P3 — IR Pages evidence
```
fetch_log(ir_page)      : 21 docs/run every run; chunk_count 1 on 08-11/13/14, 0 from 08-15
docHash = ticker+docType+publishedDate+url  (NOT content)
IR pubDate/url come from the RSS item itself, so they move when a genuinely new release appears
getLastFetched(ticker) returns NULL (fetch_log stores ticker='*'), so the incremental
  filter 'pubDate <= lastFetched' never fires -> all current RSS items re-offered every run
  -> processDocuments dedups them by hash -> 0 chunks. This is CORRECT behaviour.
COVERAGE               : ir_feed_status = discovered:3, pending:103
chunks(ir_page) total  : 35, newest published_date 2026-08-13
```

---

## CORRECTION appended 2026-08-27 16:35 +07 — do not delete

The P1 analysis recorded above is **wrong in two material ways**. The captured
data is left exactly as it was; this section corrects the interpretation.

**1. "The agent has fired 3 times ever" was an artefact of my own `tail -3`.**
The complete `logs/daily-catchup.log` fire history shows the agent fired at
**07:00:0x every single day from 2026-07-06 through 2026-08-22** — seven weeks
of clean on-time fires. `launchctl`'s `runs = 3` counts only since the agent was
last re-bootstrapped (~2026-08-24), not lifetime.

So "a 07:00 StartCalendarInterval never fires on this machine" is false. It
fired on time for seven weeks. The regression begins **2026-08-23**:

```
2026-07-06 .. 2026-08-22   07:00:0x   every day (except 07-27..08-01, which fired 10:00-10:04)
2026-08-23                 21:00:03
2026-08-24                 21:06:48, 21:23:24
2026-08-25                 09:20:41, 21:12:19
2026-08-26                 21:03:32
2026-08-27                 (none as of 16:35 +07)
```

**2. "2026-08-26 never started" is false.** The 21:03:32 fire DID trigger a
catch-up run: `[run-daily] submitting daily pipeline at 2026-08-26T14:03:33.586Z`.
Thirteen stages executed. The run is still in state `running` more than 24 hours
later — an **orphan**, not an absence:

```
2026-08-26 daily-pipeline        running   14:03:33Z   <-- never received recordEnd
2026-08-26 scenario-simulate     failed    14:04:14Z   (later succeeded on retry 15:20:59Z)
2026-08-26 world-intel-pipeline  failed    14:04:16Z, 14:44:51Z
2026-08-26 risk-metrics          success   15:29:31Z   <-- last stage to complete
```

2026-08-27 genuinely has no rows of any kind.

**Why this correction matters to the repair:** `daily-catchup.sh` counts
`status IN ('running','success')` as "already handled". The 08-26 orphan will
therefore look like a completed run for its own logical date forever. An
absence and a permanent `running` are different failures and the current logic
cannot tell them apart — which is precisely the "running forever != running
normally" distinction the repair has to encode.
