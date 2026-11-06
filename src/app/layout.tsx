import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { EARLY_APPEARANCE } from '../studio/appearance'
import '@liberation-data/desk/desk.css'
import '../studio/theme.css'
import '../studio/studio.css'

export const metadata: Metadata = {
  title: 'Drivine Studio',
  description: 'Browse a Drivine model, load it, and see the graph.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The appearance chosen is set on the root before React starts, so React finds an attribute it didn't render.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: EARLY_APPEARANCE }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
