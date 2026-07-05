import { Sidebar } from '@/components/capital/Sidebar'

export default function CapitalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full bg-bg-base">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="px-6 py-6 md:px-8 md:py-7">
          {children}
        </div>
      </main>
    </div>
  )
}
