export const COLUMNS = [
  'trade_date', 'broker', 'account', 'doc_type', 'side', 'asset', 'exchange',
  'currency', 'units', 'unit_price', 'gross_amount', 'fee', 'vat',
  'withholding_tax', 'net_amount', 'cash_flow', 'gross_thb', 'fee_thb',
  'wht_thb', 'net_thb', 'is_switch', 'reference', 'source_file',
] as const

export type Column = typeof COLUMNS[number]
export type ArchiveRow = Record<Column, string>

export interface ValidationFinding {
  rowNumber?: number
  code: string
  severity: 'info' | 'warning' | 'error'
  details: Record<string, string | number | boolean | null>
}

export interface ArchiveInspection {
  sha256: string
  rows: ArchiveRow[]
  logicalSourceFiles: number
  currencyRows: Record<string, number>
  cashFlowByCurrency: Record<string, string>
  missingAccounts: number
  missingNetAmounts: number
  exactDuplicateRows: number
  multiRowReferenceGroups: number
  negativePositionKeys: string[]
  switchGroupKeys: string[]
  incompleteSwitchGroups: string[]
  findings: ValidationFinding[]
}

export interface PublishResult {
  batchId: string
  /** The dataset series this batch belongs to; supersession is scoped to it. */
  seriesKey: string
  insertedTransactions: number
  exactRerun: boolean
  priorBatchId: string | null
}
