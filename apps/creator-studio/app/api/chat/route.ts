import { NextRequest } from 'next/server'
import { anthropic, buildSystemPrompt, ChatMessage } from '@/lib/agent'
import { ScoredStory } from '@/lib/topic-engine'

export async function POST(req: NextRequest) {
  const { messages, topic }: { messages: ChatMessage[]; topic: ScoredStory } =
    await req.json()

  const windowed = messages.slice(-30)

  const stream = await anthropic.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: buildSystemPrompt(topic),
        cache_control: { type: 'ephemeral' }, // prompt cache — saves cost on long conversations
      },
    ],
    messages: windowed,
  })

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
