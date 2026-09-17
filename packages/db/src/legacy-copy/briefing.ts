// BRIEFING adapter: apps/investment-analyst-agents/archive/*.jsonl
//   predictions.jsonl -> briefing.predictions
//   qa.jsonl          -> briefing.qa          (cold-preserved; BIGSERIAL id)
//
// MALFORMED LINES ARE NOT SWALLOWED. The tool this replaces wrapped each line
// in `try { ... } catch { /* skip malformed lines */ }`, so a corrupt archive
// produced a smaller count and no error at all - the one shape of data loss
// that looks exactly like success. A line that does not parse, or that is
// missing a required field, now fails the whole copy.
//
// AN ABSENT FILE IS REFUSED; AN EMPTY FILE IS ZERO ROWS. The old tool treated
// both as zero. A file that should be in the snapshot and is not means the
// snapshot is incomplete.

import { existsSync, readFileSync } from 'node:fs'

import type { CopyClient, CopyContext, TableResult } from '../legacy-copy.js'
import { CopyRefused, resolveUnderRoot } from '../legacy-copy.js'

export interface PredictionRecord {
  date: string
  regime: string
  confidence: string
  scenarios: unknown
  actions: unknown
}

export interface QaRecord {
  date: string
  timestamp: string
  mode: string
  exchanges: unknown
}

/** Split on newlines, keeping the 1-based line number for error messages. A
 *  trailing newline is normal and does not make an empty final record. */
export function jsonlLines(text: string): { lineNumber: number; text: string }[] {
  const out: { lineNumber: number; text: string }[] = []
  const raw = text.split('\n')
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]
    if (line.trim() === '') continue
    out.push({ lineNumber: i + 1, text: line })
  }
  return out
}

export function readJsonlRequired(path: string): { lineNumber: number; value: unknown }[] {
  if (!existsSync(path)) {
    throw new CopyRefused(
      `required JSONL source is missing from the snapshot: ${path}. An absent file is ` +
      'not zero rows - an empty but present file is.',
    )
  }
  const text = readFileSync(path, 'utf-8')
  return jsonlLines(text).map(l => {
    try {
      return { lineNumber: l.lineNumber, value: JSON.parse(l.text) as unknown }
    } catch (err) {
      throw new CopyRefused(
        `${path}:${l.lineNumber} is not valid JSON: ` +
        `${err instanceof Error ? err.message : String(err)}. Malformed archive lines are ` +
        'refused, never skipped.',
      )
    }
  })
}

function requireString(path: string, lineNumber: number, field: string, value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new CopyRefused(
      `${path}:${lineNumber} field "${field}" must be a non-empty string; got ` +
      `${JSON.stringify(value)}.`,
    )
  }
  return value
}

function requireDefined(path: string, lineNumber: number, field: string, value: unknown): unknown {
  if (value === undefined) {
    throw new CopyRefused(`${path}:${lineNumber} field "${field}" is missing.`)
  }
  return value
}

export async function copyBriefing(client: CopyClient, ctx: CopyContext): Promise<TableResult[]> {
  const predictionsPath = resolveUnderRoot(
    ctx.sourceRoot, 'apps/investment-analyst-agents/archive/predictions.jsonl',
  )
  const qaPath = resolveUnderRoot(
    ctx.sourceRoot, 'apps/investment-analyst-agents/archive/qa.jsonl',
  )

  const predictions = readJsonlRequired(predictionsPath)
  const qa = readJsonlRequired(qaPath)

  // RESTART IDENTITY resets briefing.qa_id_seq - the third generated sequence,
  // and the one an earlier pass forgot.
  await client.query('TRUNCATE briefing.predictions, briefing.qa RESTART IDENTITY')

  // `date` is the primary key. A duplicate is refused rather than absorbed by
  // an upsert: the old tool's ON CONFLICT DO UPDATE silently kept the last of
  // several entries for a day, so the row count and the file line count
  // disagreed with no way to tell which was right.
  const seenDates = new Set<string>()
  for (const { lineNumber, value } of predictions) {
    const r = value as Partial<PredictionRecord>
    const date = requireString(predictionsPath, lineNumber, 'date', r.date)
    if (seenDates.has(date)) {
      throw new CopyRefused(
        `${predictionsPath}:${lineNumber} repeats date ${date}. briefing.predictions.date ` +
        'is the primary key; a duplicate is a source defect, not something to absorb.',
      )
    }
    seenDates.add(date)
    await client.query(
      `INSERT INTO briefing.predictions (date, regime, confidence, scenarios, actions)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        date,
        requireString(predictionsPath, lineNumber, 'regime', r.regime),
        requireString(predictionsPath, lineNumber, 'confidence', r.confidence),
        JSON.stringify(requireDefined(predictionsPath, lineNumber, 'scenarios', r.scenarios)),
        JSON.stringify(requireDefined(predictionsPath, lineNumber, 'actions', r.actions)),
      ],
    )
  }

  for (const { lineNumber, value } of qa) {
    const r = value as Partial<QaRecord>
    await client.query(
      `INSERT INTO briefing.qa (date, asked_at, mode, exchanges) VALUES ($1,$2,$3,$4)`,
      [
        requireString(qaPath, lineNumber, 'date', r.date),
        requireString(qaPath, lineNumber, 'timestamp', r.timestamp),
        requireString(qaPath, lineNumber, 'mode', r.mode),
        JSON.stringify(requireDefined(qaPath, lineNumber, 'exchanges', r.exchanges)),
      ],
    )
  }

  return [
    { table: 'briefing.predictions', rows: predictions.length },
    { table: 'briefing.qa', rows: qa.length },
  ]
}
