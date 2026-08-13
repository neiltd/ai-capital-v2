import { writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { ThaiGovFlowJSON } from '../types.js'
import { fetchThaiGovFlow } from './thai-procurement-fetcher.js'

export async function buildThaiGovFlow(): Promise<ThaiGovFlowJSON> {
  const contractors = await fetchThaiGovFlow()
  return {
    exportedAt:  new Date().toISOString(),
    asOf:        new Date().toISOString().slice(0, 10),
    source:      'ACT Ai (procurement.actai.co) — Thai e-GP procurement data',
    contractors,
  }
}

export async function exportThaiGovFlow(outputPath: string): Promise<ThaiGovFlowJSON> {
  const json = await buildThaiGovFlow()
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify(json, null, 2), 'utf-8')
  return json
}
