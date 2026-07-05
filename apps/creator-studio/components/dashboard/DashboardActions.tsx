'use client'

import { useRouter } from 'next/navigation'
import { VideoForm } from './VideoForm'
import { GrowthForm } from './GrowthForm'

export function DashboardActions() {
  const router = useRouter()
  return (
    <div className="flex justify-end gap-2">
      <GrowthForm onSaved={() => router.refresh()} />
      <VideoForm onSaved={() => router.refresh()} />
    </div>
  )
}
