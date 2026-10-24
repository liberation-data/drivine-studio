import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import '@liberation-data/desk/desk.css'
import '../studio/studio.css'

export const metadata: Metadata = {
  title: 'Drivine Studio',
  description: 'Browse a Drivine model, load it, and see the graph.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
