'use client'

interface Props {
  role: 'user' | 'assistant'
  content: string
}

export function MessageBubble({ role, content }: Props) {
  const isUser = role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
          isUser
            ? 'bg-accent-primary text-white rounded-br-sm'
            : 'bg-bg-elevated text-text-primary border border-border-subtle rounded-bl-sm'
        }`}
      >
        {content}
      </div>
    </div>
  )
}
