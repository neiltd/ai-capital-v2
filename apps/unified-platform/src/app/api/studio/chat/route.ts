import { NextRequest, NextResponse } from 'next/server'
import { buildSystemPrompt, type ChatMessage } from '@/lib/studio/agent'
import { ScoredStory } from '@/lib/studio/topic-engine'
import { checkRateLimit } from '@/lib/rate-limit'

const MAX_MESSAGES = 60
const MAX_CONTENT_LENGTH = 8000

function isValidMessages(messages: unknown): messages is ChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return false
  }
  return messages.every(
    (m) =>
      m &&
      typeof m === 'object' &&
      (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string' &&
      m.content.length <= MAX_CONTENT_LENGTH
  )
}

export async function POST(req: NextRequest) {
  if (!checkRateLimit('studio:chat')) {
    return NextResponse.json({ error: 'Rate limit exceeded, try again shortly' }, { status: 429 })
  }

  let body: { messages?: unknown; topic?: ScoredStory }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { messages, topic } = body
  if (!isValidMessages(messages)) {
    return NextResponse.json(
      { error: `messages must be a non-empty array of up to ${MAX_MESSAGES} { role, content } items, each content up to ${MAX_CONTENT_LENGTH} characters` },
      { status: 400 }
    )
  }
  if (!topic) {
    return NextResponse.json({ error: 'topic is required' }, { status: 400 })
  }

  let stream
  try {
    // Spending authority is acquired INSIDE the handler, after the request has
  // crossed this route's guards. It must never be held at module scope: Next
  // evaluates a route module's whole static graph on ANY request that routes to
  // it — including the GET/HEAD it answers 405 to, and twice during `next build`
  // — so a module-scope client is constructed on traffic nobody chose to send.
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    stream = await anthropic.messages.stream({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      system: [
        {
          type: 'text',
          text: buildSystemPrompt(topic),
          cache_control: { type: 'ephemeral' }, // prompt cache — saves cost on long conversations
        },
      ],
      messages,
    })
  } catch {
    return NextResponse.json({ error: 'Chat stream failed to start' }, { status: 502 })
  }

  const readable = new ReadableStream({
    async start(controller) {
      for await (const chunk of stream) {
        if (
          chunk.type === 'content_block_delta' &&
          chunk.delta.type === 'text_delta'
        ) {
          controller.enqueue(new TextEncoder().encode(chunk.delta.text))
        }
      }
      controller.close()
    },
  })

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
    },
  })
}
