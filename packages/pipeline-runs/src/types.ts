export type PipelineRunStatus =
  | 'running'   // started, no ended_at yet
  | 'success'   // completed cleanly
  | 'failed'    // completed with caught error
  | 'killed'    // SIGTERM/SIGKILL — see metadata for context
  | 'timeout'   // exceeded stage SLA (orphan reaper or explicit timeout)

export interface PipelineRun {
  id:            string
  parentRunId:   string | null
  stage:         string             // e.g. 'capital-ingestion', 'YahooNews', 'ai-analysis-engine'
  source:        string | null      // sub-stage source key (e.g. 'yahoo_news') or null at top level
  startedAt:     string             // ISO timestamp
  endedAt:       string | null      // null while in-flight
  durationMs:    number | null      // computed at recordEnd
  status:        PipelineRunStatus
  docCount:      number | null
  chunkCount:    number | null
  tickerCount:   number | null
  errorMessage:  string | null
  errorStack:    string | null
  metadata:      Record<string, unknown> | null
}

export interface RecordStartInput {
  stage:        string
  source?:      string | null
  parentRunId?: string | null
  metadata?:    Record<string, unknown> | null
}

export interface RecordEndInput {
  status:       Exclude<PipelineRunStatus, 'running'>
  docCount?:    number | null
  chunkCount?:  number | null
  tickerCount?: number | null
  error?:       Error | { message: string; stack?: string } | null
  metadata?:    Record<string, unknown> | null
}

export interface StageSummary {
  stage:       string
  latestRuns:  PipelineRun[]        // newest first, length ≤ 7
}

export interface DashboardSummary {
  generatedAt:  string
  stages:       StageSummary[]
  inFlight:     PipelineRun[]
}
