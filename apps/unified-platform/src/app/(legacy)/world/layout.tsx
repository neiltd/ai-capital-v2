import { WorldSidebar } from '@/components/world/WorldSidebar'

export default function WorldLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full">
      <WorldSidebar />
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  )
}
