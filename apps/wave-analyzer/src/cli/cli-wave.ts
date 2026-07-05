import 'dotenv/config'
import { join } from 'path'
import { exportWaves } from '../exporter.js'

const OUTPUT_PATH = join(process.cwd(), 'data/waves.json')

exportWaves(OUTPUT_PATH).catch(err => { console.error(err); process.exit(1) })
