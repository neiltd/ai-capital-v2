// THE LOCKFILE IS PART OF THE SOURCE UNIT, AND IT WAS SILENTLY DAMAGED.
//
// During slice S4D a `pnpm install` ran in a worktree where the
// apps/capital-intelligence-ingestion submodule was not checked out. pnpm did
// exactly what it is supposed to do with a manifest it cannot see: it dropped
// that importer and every package entry only it needed — 714 deleted lines —
// and the change looked, at a glance, like an ordinary lockfile update.
//
// The repository's supported source unit is "this repository plus the pinned
// submodule revision", so a lockfile that no longer describes the submodule is
// not a smaller lockfile; it is a wrong one. This test pins the two properties
// that make the damage visible immediately rather than at the next install.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const LOCK = readFileSync(fileURLToPath(new URL('../../../pnpm-lock.yaml', import.meta.url)), 'utf-8')

/** The lines of one importer, bounded by the next key at the same indent. */
function importerBlock(name: string): string {
  const header = `\n  ${name}:\n`
  const start = LOCK.indexOf(header)
  if (start === -1) return ''
  const rest = LOCK.slice(start + header.length)
  const end = rest.search(/\n {0,2}\S/)
  return header + (end === -1 ? rest : rest.slice(0, end))
}

describe('pnpm-lock.yaml scope', () => {
  it('still describes the ingestion submodule importer', () => {
    expect(LOCK).toContain('\n  apps/capital-intelligence-ingestion:\n')
  })

  it('still carries that importer\'s own dependencies', () => {
    // A truncated importer would keep the heading and lose the body.
    const block = importerBlock('apps/capital-intelligence-ingestion')
    expect(block).toContain('@huggingface/transformers')
    expect(block).toContain('@lancedb/lancedb')
  })

  it('declares what packages/queue actually imports', () => {
    // packages/queue is the LAST importer, so "up to the next `  packages/`"
    // would run to the end of the file and find another importer's entries.
    // Bound it at the next key indented by exactly two spaces, or by the
    // top-level `packages:` section that follows the importers.
    const block = importerBlock('packages/queue')
    expect(block).toContain("'@common/db':")
    expect(block).toContain('dotenv:')
    // Non-vacuity: the slice really is the queue importer, and only it.
    expect(block).toContain('bullmq:')
    expect(block).not.toContain('apps/')
  })
})
