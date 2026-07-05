import 'dotenv/config'
import { join } from 'path'
import { createGraphStore } from '../store/graph-store.js'
import { runScan } from '../scanner/scanner.js'

const DATA_DIR = join(process.cwd(), 'data')
const store = createGraphStore(join(DATA_DIR, 'graph.db'))

const args = process.argv.slice(2)
const tickerArg = args.find(a => a.startsWith('--ticker='))?.split('=')[1]

console.log('Scanning ingested documents for new relationships...')
const count = await runScan(store, { ticker: tickerArg })
console.log(`\nScan complete: ${count} new proposal edge(s) created. Run npm run review to approve.`)
store.close()
