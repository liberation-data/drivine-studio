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
  //
  // And onnxruntime-node, which the icons' model runs on: transformers loads it through createRequire, which tracing
  // can't follow, so without this it is left out and the model never loads in a packaged app. Its binding only for
  // the platform and architecture building, as each is tens of megabytes and the app is packaged on the one it's for.
  outputFileTracingIncludes: {
    '/api/icons/**': [
      './src/server/icons/icon-vectors.*', './node_modules/lucide-static/icons/*.svg', './node_modules/lucide-static/tags.json',
      './node_modules/onnxruntime-node/package.json', './node_modules/onnxruntime-node/dist/*.js',
      // onnxruntime-node requires onnxruntime-common's CommonJS build; tracing found only the ESM one transformers imports.
      './node_modules/onnxruntime-common/dist/cjs/**',
      `./node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}/*`,
    ],
  },
  // Lucide's fonts, sprite and scripts, which tracing takes with the rest of the package, and nothing reads; and the
  // icons' sources and tests, which it takes with the vectors beside them.
  outputFileTracingExcludes: {
    '/api/icons/**': ['./src/server/icons/*.ts', './node_modules/lucide-static/font/**', './node_modules/lucide-static/dist/**', './node_modules/lucide-static/sprite.svg', './node_modules/lucide-static/icon-nodes.json'],
  },
}

export default config
