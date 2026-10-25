import type { NextConfig } from 'next'

// Standalone, so the same build runs from `npm start`, inside Electron, and in a container. Traced from
// this directory, so server.js lands at .next/standalone/server.js wherever the checkout sits.
const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: __dirname,
  // Drivine and the database clients it loads run on the server as Node has them, not bundled.
  serverExternalPackages: [
    '@liberation-data/drivine', 'neo4j-driver', 'falkordb', 'oracledb', 'pg', 'pg-cursor', '@huggingface/transformers',
  ],
  // Read from disk by the icon routes, which tracing can't see: the icons' vectors, and Lucide's icons and tags.
  outputFileTracingIncludes: {
    '/api/icons/**': ['./src/server/icons/icon-vectors.*', './node_modules/lucide-static/icons/*.svg', './node_modules/lucide-static/tags.json'],
  },
  // Lucide's fonts, sprite and scripts, which tracing takes with the rest of the package, and nothing reads; and the
  // icons' sources and tests, which it takes with the vectors beside them.
  outputFileTracingExcludes: {
    '/api/icons/**': ['./src/server/icons/*.ts', './node_modules/lucide-static/font/**', './node_modules/lucide-static/dist/**', './node_modules/lucide-static/sprite.svg', './node_modules/lucide-static/icon-nodes.json'],
  },
}

export default config
