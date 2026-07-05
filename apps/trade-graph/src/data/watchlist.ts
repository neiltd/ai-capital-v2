// Reads the canonical watchlist at docs/watchlist/full-watchlist.md.
// Owned by the user — see memory/reference_watchlist_ir_docs.md.
//
// Format expected (markdown table):
//   | **TICKER** | Company Name | theme1, theme2 |

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

export interface WatchlistEntry {
  ticker:  string
  company: string
  themes:  string
}

/** Walk up from cwd until we find the workspace root (the dir holding pnpm-workspace.yaml). */
function workspaceRoot(): string {
  let dir = process.cwd()
  while (dir !== '/') {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    dir = join(dir, '..')
  }
  return process.cwd()
}

export function readWatchlist(): WatchlistEntry[] {
  const path = join(workspaceRoot(), 'docs', 'watchlist', 'full-watchlist.md')
  if (!existsSync(path)) throw new Error(`watchlist not found at ${path}`)
  const content = readFileSync(path, 'utf-8')
  const out: WatchlistEntry[] = []

  for (const line of content.split('\n')) {
    // Match `| **TICKER** | Company | themes |`. Skip table header / divider rows.
    const m = line.match(/^\|\s*\*\*([A-Z0-9._-]+)\*\*\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|/)
    if (!m) continue
    const [, ticker, company, themes] = m
    if (ticker.toUpperCase() === 'TICKER') continue
    out.push({ ticker: ticker.trim(), company: company.trim(), themes: themes.trim() })
  }

  return out
}
