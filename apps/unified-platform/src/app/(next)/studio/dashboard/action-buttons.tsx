'use client'

// Thin client wrappers so the real GrowthForm/VideoForm (legacy components,
// kept functional per the studio-v2 README) can call router.refresh() after
// saving — page.tsx itself is a server component and can't use the hook.

import { useRouter } from 'next/navigation'
import { GrowthForm } from '@/components/studio/dashboard/GrowthForm'
import { VideoForm } from '@/components/studio/dashboard/VideoForm'

export function GrowthFormAction() {
  const router = useRouter()
  return <GrowthForm onSaved={() => router.refresh()} />
}

export function VideoFormAction() {
  const router = useRouter()
  return <VideoForm onSaved={() => router.refresh()} />
}
