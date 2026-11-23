// Checks that a packaged Studio app carries, and can load, the native modules its server needs: sharp, and
// onnxruntime-node, which the icons' model runs on. Run it under the packaged app's own Electron, as its server runs:
//
//   ELECTRON_RUN_AS_NODE=1 <app's executable> scripts/check-native-modules.cjs <app's standalone node_modules> <repo's node_modules>
//
// A module left out of the package, or one built for another platform or architecture, fails here instead of on a
// user's first icon lookup, where the studio quietly falls back to the common words' icons. v0.1.0 shipped that way.
//
// One exception passes with a warning: a platform and architecture onnxruntime-node ships no binding for at all (Intel
// Macs, as of 1.30). The model can't run there whatever the package holds, and the studio falls back by design.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const [packaged, installed] = process.argv.slice(2).map(p => p && path.resolve(p))
if (!packaged || !installed) {
  console.error('usage: check-native-modules.cjs <packaged standalone node_modules> <repo node_modules>')
  process.exit(2)
}

function fail(message) {
  console.log(`::error::${message}`)
  process.exit(1)
}

// The app is packaged inside the checkout (dist/), so a module, or a module's dependency, left out of the package still
// resolves upward to the repo's node_modules and loads. Fail on any file loaded from outside the package.
const packagedReal = fs.realpathSync(packaged) + path.sep
function fromPackage(what) {
  const outside = Object.keys(require.cache).filter(file => file !== __filename && !file.startsWith(packagedReal))
  if (outside.length) fail(`${what} loads ${outside.length} files from outside the packaged app, which lacks them: ${outside.slice(0, 3).join(', ')}…`)
}

const target = `${process.platform}/${process.arch}`
console.log(`Checking the native modules for ${target} in ${packaged}`)

const sharp = require(require.resolve('sharp', { paths: [packaged] }))
fromPackage('sharp')
console.log(`sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}: loads`)

if (!fs.existsSync(path.join(packaged, 'onnxruntime-node'))) fail('onnxruntime-node is not in the packaged app')
// The folder onnxruntime-node's dist/binding.js loads its binding from. Should a new version move it, or the repo's
// node_modules be given wrongly, the repo would seem to ship no binding and the check would pass with a warning on
// every target; fail instead.
const bindings = 'onnxruntime-node/bin/napi-v6'
if (!fs.existsSync(path.join(installed, bindings))) fail(`the repo has no ${bindings} to compare the package with; has onnxruntime-node moved its bindings?`)
const binding = `${bindings}/${target}/onnxruntime_binding.node`
if (!fs.existsSync(path.join(packaged, binding))) {
  if (fs.existsSync(path.join(installed, binding))) fail(`the packaged app has no ${binding}, though onnxruntime-node ships one`)
  console.log(`::warning::onnxruntime-node ships no binding for ${target}, so the icons' model can't run here; the studio uses the common words' icons`)
  process.exit(0)
}
require(path.join(packaged, binding))
console.log(`${binding}: loads`)

// As transformers loads it, which takes in onnxruntime-common's CommonJS build too.
const ort = require(require.resolve('onnxruntime-node', { paths: [packaged] }))
if (typeof ort.InferenceSession !== 'function') fail('onnxruntime-node loads but has no InferenceSession')
fromPackage('onnxruntime-node')
console.log('onnxruntime-node: loads')
