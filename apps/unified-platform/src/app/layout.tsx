import type { Metadata } from 'next'
import './globals.css'
import { TopNav } from '@/components/TopNav'
import { ErrorFilter } from '@/components/ErrorFilter'

export const metadata: Metadata = { title: 'Intelligence Hub' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex flex-col h-screen overflow-hidden bg-bg-base text-text-primary"
        style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
        <ErrorFilter />
        <TopNav />
        <div className="flex-1 overflow-hidden">
          {children}
        </div>
      </body>
    </html>
  )
}
