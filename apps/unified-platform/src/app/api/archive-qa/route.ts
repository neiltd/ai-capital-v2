import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { qaArchivePath } from '@/lib/data'

export async function POST(req: NextRequest) {
  let body: { question?: string; answer?: string }
  try {
    body = await req.json() as { question: string; answer: string }
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  if (!body.question || !body.answer) {
    return NextResponse.json({ error: 'question and answer required' }, { status: 400 })
  }

  const archivePath = qaArchivePath()
  fs.mkdirSync(path.dirname(archivePath), { recursive: true })

  const entry = {
    date: new Date().toISOString().split('T')[0],
    timestamp: new Date().toISOString(),
    question: body.question,
    answer: body.answer,
  }
  fs.appendFileSync(archivePath, JSON.stringify(entry) + '\n', 'utf-8')

  return NextResponse.json({ ok: true })
}
