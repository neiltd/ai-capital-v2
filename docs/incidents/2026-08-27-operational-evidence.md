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
