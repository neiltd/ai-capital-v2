import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { BriefingJSON } from '@common/types'

export function writeBriefing(date: string, content: string, briefingsDir: string): string {
  mkdirSync(briefingsDir, { recursive: true })
  const outputPath = join(briefingsDir, `${date}.md`)
  writeFileSync(outputPath, content, 'utf-8')
  return outputPath
}

export function writeBriefingJson(date: string, envelope: BriefingJSON, briefingsDir: string): string {
  mkdirSync(briefingsDir, { recursive: true })
  const outputPath = join(briefingsDir, `${date}.json`)
  writeFileSync(outputPath, JSON.stringify(envelope, null, 2), 'utf-8')
  return outputPath
}
