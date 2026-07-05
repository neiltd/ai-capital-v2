import 'dotenv/config'
import { join } from 'path'
import { exportGovFlow } from '../exporter.js'

const OUTPUT = join(process.cwd(), 'data', 'govflow.json')
exportGovFlow(OUTPUT).catch(err => { console.error('[govflow] Fatal:', err); process.exit(1) })
