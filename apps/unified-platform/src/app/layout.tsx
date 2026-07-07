import type { Metadata } from 'next'
import './globals.css'
import './tokens.css'

export const metadata: Metadata = { title: 'Intelligence Hub' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-screen overflow-hidden"
        style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
        {children}
      </body>
    </html>
  )
}
