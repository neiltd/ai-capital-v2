import { TopNav } from '@/components/TopNav'
import { ErrorFilter } from '@/components/ErrorFilter'

export default function LegacyLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col h-screen overflow-hidden bg-bg-base text-text-primary"
      style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      <ErrorFilter />
      <TopNav />
      <div className="flex-1 overflow-hidden">
        {children}
      </div>
    </div>
  )
}
