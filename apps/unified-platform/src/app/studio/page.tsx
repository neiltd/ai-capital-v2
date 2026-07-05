export const dynamic = 'force-dynamic'

import { anthropic, buildSystemPrompt } from '@/lib/studio/agent'
import { pickDailyTopic } from '@/lib/studio/topic-engine'
import { ChatInterface } from '@/components/studio/chat/ChatInterface'
import { EmptyState } from '@/components/capital/ui/EmptyState'
import { Badge } from '@/components/capital/ui/Badge'

export default async function StudioPage() {
  let topic
  try {
    topic = pickDailyTopic()
  } catch {
    return (
      <div className="max-w-lg">
        <EmptyState
          tone="warning"
          title="No world intelligence data"
          description={
            <>
              Run <code className="font-mono text-indigo-active">npm run pipeline</code> in world-intelligence-data-hub- first.
            </>
          }
        />
      </div>
    )
  }

  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: [{ type: 'text', text: buildSystemPrompt(topic), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'morning' }],
  })
  const opening = res.content[0].type === 'text' ? res.content[0].text : "Morning! Let's talk about today's story."

  return (
    <div className="flex flex-col bg-bg-card text-text-primary rounded-xl overflow-hidden border border-border-subtle" style={{ height: 'calc(100vh - 4rem)' }}>
      {/* Topic header */}
      <div className="border-b border-border-subtle px-4 py-3 shrink-0 space-y-2">
        <p className="text-[10px] font-semibold text-text-inactive uppercase tracking-[0.12em]">Today's Topic</p>
        <p className="text-sm font-semibold leading-tight text-text-primary">{topic.title}</p>
        <p className="text-xs text-text-muted leading-relaxed line-clamp-2">{topic.summary}</p>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge tone="accent" size="xs">{topic.suggestedVisualType}</Badge>
          <span className="text-[10px] text-text-inactive italic">{topic.suggestedAngle}</span>
        </div>
      </div>

      {/* Chat */}
      <div className="flex-1 min-h-0">
        <ChatInterface topic={topic} initialMessage={opening} />
      </div>
    </div>
  )
}
