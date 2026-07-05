import type { Edge } from '../types.js'

export function findPaths(
  forward: Map<string, Edge[]>,
  from: string,
  to: string,
  maxDepth: number = 4,
): Edge[][] {
  const results: Edge[][] = []

  function dfs(current: string, path: Edge[], visited: Set<string>): void {
    if (path.length >= maxDepth) return
    const neighbors = forward.get(current) ?? []
    for (const edge of neighbors) {
      if (visited.has(edge.to)) continue
      const newPath = [...path, edge]
      if (edge.to === to) {
        results.push(newPath)
      } else {
        visited.add(edge.to)
        dfs(edge.to, newPath, visited)
        visited.delete(edge.to)
      }
    }
  }

  dfs(from, [], new Set([from]))
  return results
}
