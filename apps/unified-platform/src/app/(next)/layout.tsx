import type { ReactNode } from 'react'
import { AppShell } from '@/components/next/AppShell'

export default function NextLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>
}
