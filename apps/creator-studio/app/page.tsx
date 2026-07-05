export const dynamic = 'force-dynamic'

import { pickDailyTopic } from '@/lib/topic-engine'
import { ChatInterface } from '@/components/chat/ChatInterface'
import Link from 'next/link'

export default function Home() {
  const topic = pickDailyTopic()

  return (
    <div className="flex flex-col h-full">
      <nav className="flex justify-end px-4 py-2 border-b border-zinc-800 bg-zinc-950 shrink-0">
        <Link href="/archive" className="text-xs text-zinc-500 hover:text-zinc-300">Archive</Link>
        <span className="mx-2 text-zinc-700">·</span>
        <Link href="/dashboard" className="text-xs text-zinc-500 hover:text-zinc-300">Dashboard</Link>
      </nav>
      <div className="flex-1 min-h-0">
        <ChatInterface topic={topic} />
      </div>
    </div>
  )
}
