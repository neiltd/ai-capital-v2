export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { todayLocal } from '@/lib/data'

export async function GET() {
  const root = process.env.DATA_ROOT
  if (!root) return NextResponse.json({ stale: true, reason: 'DATA_ROOT not set' })

  const today = todayLocal()
  const briefingPath = path.join(root, `investment-analyst-agents/briefings/${today}.md`)
  const stale = !fs.existsSync(briefingPath)
  return NextResponse.json({ stale, date: today })
}
