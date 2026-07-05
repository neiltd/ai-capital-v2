import { describe, it, expect, vi } from 'vitest'
import { POST, GET } from '@/app/api/growth/route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    growthSnapshot: {
      create: vi.fn().mockResolvedValue({ id: 'g1', followers: 500, profileViews: 200, source: 'manual', date: new Date() }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}))

describe('POST /api/growth', () => {
  it('creates a growth snapshot and returns it', async () => {
    const req = new NextRequest('http://localhost/api/growth', {
      method: 'POST',
      body: JSON.stringify({ followers: 500, profileViews: 200 }),
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.followers).toBe(500)
  })

  it('rejects missing followers with 400', async () => {
    const req = new NextRequest('http://localhost/api/growth', {
      method: 'POST',
      body: JSON.stringify({ profileViews: 200 }),
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })
})

describe('GET /api/growth', () => {
  it('returns an array of growth snapshots', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(Array.isArray(json)).toBe(true)
  })
})
