export type ReconciliationState = 'none' | 'open' | 'matched' | 'mismatch' | 'review' | 'resolved' | 'dismissed'
export type ReconciliationEvent = 'OPEN' | 'MATCH' | 'FLAG_MISMATCH' | 'REQUEST_REVIEW' | 'RESOLVE' | 'REOPEN' | 'DISMISS'

const ALLOWED: Record<ReconciliationState, readonly ReconciliationEvent[]> = {
  none: ['OPEN'],
  open: ['MATCH','FLAG_MISMATCH','REQUEST_REVIEW','RESOLVE','DISMISS'],
  matched: ['REOPEN','RESOLVE'],
  mismatch: ['MATCH','RESOLVE','DISMISS'],
  review: ['MATCH','RESOLVE','DISMISS'],
  resolved: ['REOPEN'],
  dismissed: ['REOPEN'],
}

export function canTransition(state: ReconciliationState, event: ReconciliationEvent): boolean {
  return ALLOWED[state].includes(event)
}

export function transition(state: ReconciliationState, event: ReconciliationEvent): ReconciliationState {
  if (!canTransition(state, event)) throw new Error(`illegal reconciliation transition: ${state} -> ${event}`)
  switch (event) {
    case 'OPEN': case 'REOPEN': return 'open'
    case 'MATCH': return 'matched'
    case 'FLAG_MISMATCH': return 'mismatch'
    case 'REQUEST_REVIEW': return 'review'
    case 'RESOLVE': return 'resolved'
    case 'DISMISS': return 'dismissed'
  }
}
