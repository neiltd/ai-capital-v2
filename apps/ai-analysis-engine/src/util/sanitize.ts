// Strip unpaired UTF-16 surrogate code units from text before it goes into an
// Anthropic API request. External content (news headlines, SEC/transcript
// chunks) can get truncated mid-emoji during ingestion, leaving a lone high or
// low surrogate. Serializing that into the JSON request body produces
// "invalid_request_error: ... no low surrogate in string" and the whole call
// fails — which took down ai-analysis-engine + scenario-simulate on 2026-08-06.
// Removing the orphaned surrogate makes the body valid while preserving all
// surrounding text.
export function stripLoneSurrogates(s: string): string {
  return s.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '',
  )
}
