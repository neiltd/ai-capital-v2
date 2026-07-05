import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { writeBriefing } from '../src/briefing/briefing-writer.js'

const TMP = 'tests/tmp-writer'

afterEach(() => { try { rmSync(TMP, { recursive: true }) } catch {} })

describe('writeBriefing', () => {
  it('creates the directory and writes the file', () => {
    const path = writeBriefing('2026-05-26', '# Test Briefing', TMP)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe('# Test Briefing')
  })

  it('returns the correct file path', () => {
    const path = writeBriefing('2026-05-26', 'content', TMP)
    expect(path).toBe(join(TMP, '2026-05-26.md'))
  })

  it('overwrites existing file on same date', () => {
    writeBriefing('2026-05-26', 'first', TMP)
    writeBriefing('2026-05-26', 'second', TMP)
    expect(readFileSync(join(TMP, '2026-05-26.md'), 'utf-8')).toBe('second')
  })
})
