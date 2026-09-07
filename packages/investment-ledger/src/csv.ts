import { COLUMNS, type ArchiveRow } from './types.js'

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index++ }
      else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === ',') { row.push(field); field = '' }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = '' }
    else field += char
  }
  if (quoted) throw new Error('CSV ended inside a quoted field')
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row) }
  return rows
}

export function parseArchiveCsv(text: string): ArchiveRow[] {
  const parsed = parseCsv(text.replace(/^\uFEFF/, ''))
  const header = parsed.shift()
  if (!header) throw new Error('archive CSV is empty')
  const missing = COLUMNS.filter(column => !header.includes(column))
  if (missing.length) throw new Error(`archive CSV missing columns: ${missing.join(', ')}`)
  return parsed.filter(row => row.some(value => value !== '')).map((row, index) => {
    if (row.length !== header.length) throw new Error(`row ${index + 2}: expected ${header.length} fields, got ${row.length}`)
    return Object.fromEntries(COLUMNS.map(column => [column, row[header.indexOf(column)] ?? ''])) as ArchiveRow
  })
}

export function serializeCanonicalRow(row: ArchiveRow): string {
  return COLUMNS.map(column => `${column}=${row[column]}`).join('\u001f')
}
