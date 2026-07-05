import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

export function writeBriefing(date: string, content: string, briefingsDir: string): string {
  mkdirSync(briefingsDir, { recursive: true })
  const outputPath = join(briefingsDir, `${date}.md`)
  writeFileSync(outputPath, content, 'utf-8')
  return outputPath
}
