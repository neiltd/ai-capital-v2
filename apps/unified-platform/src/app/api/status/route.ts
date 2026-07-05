export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export async function GET() {
  const root = process.env.DATA_ROOT
  if (!root) return NextResponse.json({ stale: true, reason: 'DATA_ROOT not set' })

  const today = new Date().toISOString().split('T')[0]
  const briefingPath = path.join(root, `investment-analyst-agents/briefings/${today}.md`)
  const stale = !fs.existsSync(briefingPath)
  return NextResponse.json({ stale, date: today })
}
