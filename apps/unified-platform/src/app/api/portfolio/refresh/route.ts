export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'

const execFileAsync = promisify(execFile)

import { isMarketOpen } from '@/lib/market-hours'

export async function POST() {
  if (!isMarketOpen()) {
    return NextResponse.json(
      { ok: false, error: 'Markets are closed right now — prices would not have moved.' },
      { status: 409 },
    )
  }

  // process.cwd() is apps/unified-platform when Next is running; walk up to
  // the monorepo root to reach the sibling scenario-simulator app and its tsx.
  const workspaceRoot = path.resolve(process.cwd(), '..', '..')
  const cwd    = path.join(workspaceRoot, 'apps', 'scenario-simulator')
  const tsxBin = path.join(workspaceRoot, 'node_modules', '.bin', 'tsx')

  try {
    const { stdout, stderr } = await execFileAsync(tsxBin, ['src/cli/cli-refresh.ts'], {
      cwd,
      env: {
        ...process.env,
        PATH:      `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ''}`,
        DATA_ROOT: path.join(workspaceRoot, 'apps'),
        // This app's own DATABASE_URL is the Prisma sqlite URL
        // (file:...creator-studio/prisma/dev.db). Forwarding it makes
        // @common/db's usePostgres() pick the pg backend and hand pg a file:
        // connection string. Give the child the pipeline's Postgres URL
        // instead (same one daily-queue.worker.plist sets).
        DATABASE_URL: process.env.PIPELINE_DATABASE_URL
          ?? 'postgres://thanapold@localhost:5432/ai_capital',
      },
      timeout: 30_000,
    })
    return NextResponse.json({ ok: true, log: (stdout + stderr).trim() })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Refresh failed'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
