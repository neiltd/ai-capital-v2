import 'dotenv/config'
import { join } from 'path'
import { createGraphStore } from '../store/graph-store.js'
import { createGraphEngine } from '../graph/engine.js'
import type { RelType } from '../types.js'

const DATA_DIR = join(process.cwd(), 'data')

const args = process.argv.slice(2)

function getArg(name: string): string | undefined {
  const eqIdx = args.findIndex(a => a === `--${name}`)
  if (eqIdx !== -1 && args[eqIdx + 1] !== undefined) return args[eqIdx + 1]
  return args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
}

const ticker = getArg('ticker')
const from   = getArg('from')
const to     = getArg('to')
const dir    = getArg('direction')
const type   = getArg('type') as RelType | undefined

const USAGE = `Usage:
  npm run query -- --ticker NVDA --direction upstream
  npm run query -- --ticker NVDA --direction downstream --type supply_chain
  npm run query -- --ticker TSM --direction downstream --type customer
  npm run query -- --from CRWV --to ASML`

async function main() {
  const store = createGraphStore(join(DATA_DIR, 'graph.db'))
  const nodes = await store.getNodes()
  const edges = await store.getActiveEdges()
  const engine = createGraphEngine(nodes, edges)
  await store.close()

  if (from && to) {
    const paths = engine.paths(from, to)
    if (paths.length === 0) {
      console.log(`No paths found from ${from} to ${to} (within 4 hops)`)
    } else {
      console.log(`\n${paths.length} path(s) from ${from} to ${to}:\n`)
      for (const path of paths) {
        console.log('  ' + path.map(e => `${e.from} -[${e.type}]→ ${e.to}`).join(' → '))
      }
    }
  } else if (ticker) {
    const results =
      dir === 'upstream'   ? engine.upstream(ticker, type)
      : dir === 'downstream' ? engine.downstream(ticker, type)
      : engine.neighbors(ticker, type)

    const label = dir ?? 'neighbors'
    if (results.length === 0) {
      console.log(`No ${label} edges found for ${ticker}${type ? ` (type: ${type})` : ''}`)
    } else {
      console.log(`\n${results.length} ${label} edge(s) for ${ticker}:\n`)
      for (const e of results) {
        console.log(`  ${e.from} -[${e.type}, ${e.strength}]→ ${e.to}`)
        console.log(`    ${e.description}`)
      }
    }
  } else {
    console.log(USAGE)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
