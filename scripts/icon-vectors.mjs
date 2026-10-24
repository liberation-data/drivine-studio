// Embeds each Lucide icon's name and tags once, with the same model the server embeds a label with, and writes the
// vectors beside the server's code, so the server compares a label with every icon without embedding them itself.
// Run it again after a Lucide or model upgrade:
//
//   node scripts/icon-vectors.mjs
import { pipeline } from '@huggingface/transformers'
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const tags = require('lucide-static/tags.json')
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server', 'icons')

// Kept in step with src/server/icons/labels.ts: the model, and the icons a label may get.
const MODEL = 'Xenova/all-MiniLM-L6-v2'
// An icon of something crossed out, added or checked off is a variant of another, and wins too often for a plain word.
const VARIANT = /-(off|x|minus|plus|check|alert|question|slash|dashed|lock|unlock|cog|search|heart|star|pen|sync|up|down|left|right|in|out|\d+)$/

const names = Object.keys(tags).filter(name => !VARIANT.test(name)).sort()
const embed = await pipeline('feature-extraction', MODEL, { dtype: 'q8' })
const texts = names.map(name => [name.replaceAll('-', ' '), ...tags[name]].join(', '))
const vectors = []
for (let i = 0; i < texts.length; i += 64) {
  const batch = await embed(texts.slice(i, i + 64), { pooling: 'mean', normalize: true })
  vectors.push(...batch.tolist())
}
// A unit vector's components lie in [-1, 1]: a byte each, at 127 to 1, keeps the file small and the order of scores.
const dimensions = vectors[0].length
const bytes = new Int8Array(names.length * dimensions)
vectors.forEach((vector, i) => vector.forEach((value, j) => { bytes[i * dimensions + j] = Math.round(value * 127) }))
writeFileSync(join(out, 'icon-vectors.bin'), bytes)
writeFileSync(join(out, 'icon-vectors.json'), `${JSON.stringify({ model: MODEL, dimensions, names }, null, 0)}\n`)
console.log(`Wrote ${names.length} icons of ${dimensions} dimensions to ${out}`)
