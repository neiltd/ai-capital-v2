import { describe, it, expect, vi } from 'vitest'
import { POST, GET } from '@/app/api/videos/route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    video: {
      create: vi.fn().mockResolvedValue({ id: 'v1', title: 'Test video', views: 1000, likes: 50, comments: 10, shares: 5, topicType: 'ai-news', tiktokId: null, sessionId: null, postedAt: new Date(), createdAt: new Date(), updatedAt: new Date() }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}))

describe('POST /api/videos', () => {
  it('creates a video record and returns it', async () => {
    const req = new NextRequest('http://localhost/api/videos', {
      method: 'POST',
      body: JSON.stringify({ title: 'Test video', views: 1000, likes: 50, comments: 10, shares: 5 }),
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.id).toBe('v1')
  })

  it('rejects missing title with 400', async () => {
    const req = new NextRequest('http://localhost/api/videos', {
      method: 'POST',
      body: JSON.stringify({ views: 1000 }),
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })
})

describe('GET /api/videos', () => {
  it('returns an array of videos', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(Array.isArray(json)).toBe(true)
  })
})
