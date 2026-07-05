import { join } from 'path'
import { readdirSync, readFileSync } from 'fs'

const REPORTS_DIR = join(process.cwd(), 'data', 'reports')

try {
  const files = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md')).sort()
  if (files.length === 0) {
    console.log('No reports found. Run: npm run simulate')
  } else {
    console.log(readFileSync(join(REPORTS_DIR, files[files.length - 1]), 'utf-8'))
  }
} catch {
  console.log('No reports directory. Run: npm run simulate')
}
