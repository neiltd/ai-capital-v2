import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Props {
  role: 'user' | 'analyst'
  content: string
  streaming?: boolean
}

export function ChatMessage({ role, content, streaming }: Props) {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="bg-gradient-to-br from-accent-primary/15 to-accent-violet/10 border border-accent-primary/25 rounded-xl px-4 py-2.5 max-w-[75%] shadow-card">
          <p className="text-[13px] text-text-primary leading-relaxed">{content}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-start">
      <div className="bg-bg-card bg-gradient-card border border-border-subtle rounded-xl px-4 py-3 max-w-[85%] shadow-card">
        <div className="text-[10px] text-indigo-active font-semibold uppercase tracking-[0.14em] mb-2 flex items-center gap-1.5">
          <span className="inline-block w-1 h-1 rounded-full bg-indigo-active" />
          Analyst {streaming && <span className="animate-pulse text-text-faint">·</span>}
        </div>
        <div className="prose-dark text-[12px]">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      </div>
    </div>
  )
}
