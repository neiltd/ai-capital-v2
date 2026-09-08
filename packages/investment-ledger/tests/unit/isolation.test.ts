import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('portfolio projection isolation', () => {
  it('contains no write reference to legacy position or decision-log tables', () => {
    const root = new URL('../../', import.meta.url).pathname
    const files = [...readdirSync(join(root, 'src')).map(file => join(root, 'src', file)), join(root, 'bin/import-archive.ts')]
      .filter(file => file.endsWith('.ts'))
    const source = files.map(file => readFileSync(file, 'utf8')).join('\n')
    expect(source).not.toMatch(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+portfolio\.(?:positions|trade_log)/i)
  })
})
