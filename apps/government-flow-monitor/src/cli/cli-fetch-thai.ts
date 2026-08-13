import 'dotenv/config'
import { join } from 'path'
import { exportThaiGovFlow } from '../thai/thai-exporter.js'

const OUTPUT = join(process.cwd(), 'data', 'thai-govflow.json')
exportThaiGovFlow(OUTPUT)
  .then(j => console.log(`[thai-govflow] Exported ${j.contractors.length} contractors to ${OUTPUT} (asOf ${j.asOf})`))
  .catch(err => { console.error('[thai-govflow] Fatal:', err); process.exit(1) })
