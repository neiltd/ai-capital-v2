export function severityLabel(level: number): string {
  if (level >= 5) return 'Critical'
  if (level >= 4) return 'High'
  if (level >= 3) return 'Medium'
  return 'Low'
}

export function escalationLabel(potential: number): string {
  if (potential >= 0.7) return 'High escalation risk'
  if (potential >= 0.4) return 'Moderate escalation risk'
  return 'Low escalation risk'
}

export const SEVERITY_ORDER = ['Critical', 'High', 'Medium', 'Low']

/**
 * Maps a raw 1-5 severity score to a Badge tone, keeping color usage
 * consistent across severity-driven UI (histograms, exposure lists, etc).
 */
export function severityTone(severity: number): 'danger' | 'warning' | 'accent' | 'neutral' {
  if (severity >= 5) return 'danger'
  if (severity >= 4) return 'warning'
  if (severity >= 3) return 'accent'
  return 'neutral'
}
