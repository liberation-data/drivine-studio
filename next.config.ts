import type { NextConfig } from 'next'

// Standalone, so the same build runs from `npm start`, inside Electron, and in a container.
const config: NextConfig = {
  output: 'standalone',
}

export default config
