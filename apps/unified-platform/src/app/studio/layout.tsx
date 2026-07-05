import { StudioSidebar } from '@/components/studio/StudioSidebar'

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full">
      <StudioSidebar />
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  )
}
