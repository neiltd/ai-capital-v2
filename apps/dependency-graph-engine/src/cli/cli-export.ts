import 'dotenv/config'
import { join } from 'path'
import { createGraphStore } from '../store/graph-store.js'
import { exportGraph } from '../export/exporter.js'

const DATA_DIR = join(process.cwd(), 'data')
const OUT_PATH = join(DATA_DIR, 'graph.json')

async function main() {
  const store = createGraphStore(join(DATA_DIR, 'graph.db'))
  const graph = await exportGraph(store, OUT_PATH)
  console.log(`Exported ${graph.nodes.length} nodes, ${graph.edges.length} edges → ${OUT_PATH}`)
  await store.close()
}

main().catch(err => { console.error(err); process.exit(1) })
