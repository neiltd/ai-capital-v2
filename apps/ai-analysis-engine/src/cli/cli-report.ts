import 'dotenv/config'
import { join } from 'path'
import { readdirSync, readFileSync, existsSync } from 'fs'

const REPORTS_DIR = join(process.cwd(), 'data', 'reports')

if (!existsSync(REPORTS_DIR)) {
  console.log('No reports found. Run npm run analyze first.')
  process.exit(0)
}

const files = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md')).sort()

if (files.length === 0) {
  console.log('No reports found. Run npm run analyze first.')
  process.exit(0)
}

const latest = files[files.length - 1]
console.log(readFileSync(join(REPORTS_DIR, latest), 'utf-8'))
