// Strip unpaired UTF-16 surrogate code units from text before it goes into an
// Anthropic API request. External content (news headlines, SEC/transcript
// chunks) can get truncated mid-emoji during ingestion, leaving a lone high or
// low surrogate. Serializing that into the JSON request body produces
// "invalid_request_error: ... no low surrogate in string" and the whole call
// fails — which took down scenario-simulate + ai-analysis-engine on 2026-08-06.
// (Kept local rather than shared per this repo's no-cross-app-import convention.)
export function stripLoneSurrogates(s: string): string {
  return s.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '',
  )
}

// Coerce a forced-tool-call array field into an actual array. Sonnet 5
// sometimes returns a nested-array tool field not as an array but as a
// JSON-encoded STRING — and sometimes that string is the ENTIRE wrapper object
// (e.g. field "scenarios" = '{"scenarios":[...]}'), observed 2026-08-06.
// Handles: real array → itself; string → JSON.parse; parsed-or-passed object
// with a [key] array → unwrap it. Returns null if no array can be recovered.
export function coerceToolArray(value: unknown, key: string): unknown[] | null {
  let v = value
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return null }
  }
  if (Array.isArray(v)) return v
  if (v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>)[key])) {
    return (v as Record<string, unknown>)[key] as unknown[]
  }
  return null
}
