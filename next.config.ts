import type { NextConfig } from 'next'

// Standalone, so the same build runs from `npm start`, inside Electron, and in a container. Traced from
// this directory, so server.js lands at .next/standalone/server.js wherever the checkout sits.
const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: __dirname,
}

export default config
