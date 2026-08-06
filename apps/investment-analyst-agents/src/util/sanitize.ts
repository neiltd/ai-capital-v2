// API-request robustness helpers. Kept local per this repo's no-cross-app-import
// convention (siblings in ai-analysis-engine / scenario-simulator).

// Strip unpaired UTF-16 surrogate code units from text before it goes into an
// Anthropic request. External content truncated mid-emoji leaves a lone
// surrogate → "invalid_request_error: ... no low surrogate in string".
export function stripLoneSurrogates(s: string): string {
  return s.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '',
  )
}

// Coerce a forced-tool-call array field into a real array. Sonnet 5 sometimes
// returns it as a JSON-encoded STRING (sometimes of the whole wrapper object,
// e.g. field "actions" = '{"actions":[...]}'). Returns null if unrecoverable.
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
