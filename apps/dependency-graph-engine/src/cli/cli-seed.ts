import 'dotenv/config'
import { join } from 'path'
import { mkdirSync, existsSync } from 'fs'
import { createGraphStore } from '../store/graph-store.js'
import { loadSeed } from '../seed/seed-loader.js'

const DATA_DIR = join(process.cwd(), 'data')
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

async function main() {
  const store = createGraphStore(join(DATA_DIR, 'graph.db'))
  const { nodes, edges } = await loadSeed(store)
  console.log(`Seed complete: ${nodes} nodes, ${edges} new edges loaded`)
  await store.close()
}

main().catch(err => { console.error(err); process.exit(1) })
