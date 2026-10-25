import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readHomeFile, serially, studioHome, writeHomeFile } from '../home'

/**
 * An icon for each label, from Lucide's set: the one chosen for it in the studio; else the one a short list of common
 * words gives; else the one a small local model finds nearest the label's words, when it is near enough. A label the
 * model is unsure of gets none, as a wrong icon reads worse than a plain node.
 */
export interface LabelIcon {
  /** A Lucide icon's name, or null for none. */
  icon: string | null
  source: 'chosen' | 'common' | 'nearest' | 'none'
  /** How near the label the model found the icon, from -1 to 1: only for `nearest`. */
  score?: number
}

/** Below this, the nearest icon was as often wrong as right, in a test of sixty labels; above it, four in five right. */
export const NEAREST = 0.45

/** Words that say how a class is used, not what it is: `ChunkNode` is a chunk. */
const NOISE = new Set(['node', 'fragment', 'view', 'sample', 'core', 'element', 'entity', 'model', 'record', 'item'])

/**
 * Common words and their icons, which a general model gets wrong: Order is a sort order to it, Note a note in music,
 * Project a projector. A label's whole words are looked up first, then each from the last.
 */
const COMMON: Record<string, string> = {
  person: 'user', user: 'user', people: 'users', customer: 'user', member: 'user', account: 'user',
  author: 'user-pen', actor: 'user-round', team: 'users', group: 'users', membership: 'users', role: 'shield-user',
  permission: 'key-round', organization: 'building', organisation: 'building', company: 'building',
  issue: 'circle-dot', bug: 'circle-dot', project: 'folder-kanban', task: 'list-todo', todo: 'list-todo',
  note: 'sticky-note', doc: 'file-text', document: 'file-text', file: 'file', article: 'newspaper', post: 'newspaper',
  paper: 'file-text', book: 'book-open', chunk: 'layers', movie: 'clapperboard', film: 'film', video: 'video',
  image: 'image', photo: 'image', product: 'package', order: 'shopping-cart', invoice: 'receipt',
  payment: 'credit-card', country: 'flag', location: 'map-pin', place: 'map-pin', address: 'map-pinned',
  city: 'landmark', email: 'mail', mail: 'mail', message: 'message-square', comment: 'message-circle',
  event: 'calendar', meeting: 'calendar-clock', skill: 'award', server: 'server', database: 'database',
  tag: 'tag', label: 'tag', topic: 'hash', commit: 'git-commit-horizontal', repository: 'folder-git-2',
  repo: 'folder-git-2', branch: 'git-branch', vehicle: 'car', car: 'car', animal: 'dog', recipe: 'chef-hat',
  ingredient: 'apple', link: 'link', url: 'link', notification: 'bell', ticket: 'ticket', store: 'store',
  shop: 'store', wallet: 'wallet', bank: 'landmark', course: 'graduation-cap', job: 'briefcase',
  embedding: 'sparkles', vector: 'sparkles', concept: 'brain', network: 'network',
}

/**
 * A label's words, lowercased, without those that say how it is used, and without bare numbers: `SampleDocNode` gives
 * `doc`, and `Address2` gives `address`. Letters are any script's, so `Größe` is a word, not two.
 */
export function words(label: string): string[] {
  const all = label
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .map(it => it.toLowerCase())
    .filter(it => it !== '')
  const meaningful = all.filter(it => !NOISE.has(it) && !/^\p{N}+$/u.test(it))
  return meaningful.length ? meaningful : all
}

/** The common word a label's words name, the whole of them first, then each from the last. */
export function common(label: string): string | undefined {
  const found = words(label)
  // Only the list's own words: an object's own `constructor` is no label's icon.
  const icon = (word: string) => (Object.hasOwn(COMMON, word) ? COMMON[word] : undefined)
  return icon(found.join('')) ?? [...found].reverse().map(icon).find(Boolean)
}

// Chosen icons

const FILE = 'icons.json'

/** The icons chosen in the studio, by label, kept in its home: null for a label chosen to have none. */
export async function chosen(): Promise<Record<string, string | null>> {
  return (await readHomeFile<{ labels?: Record<string, string | null> }>(FILE))?.labels ?? {}
}

/** Chooses a label's icon, or none with null; undefined forgets the choice, so the label's icon is found again. */
export function choose(label: string, icon: string | null | undefined): Promise<void> {
  return serially(async () => {
    // With no prototype, so a label such as `__proto__` is a key like any other.
    const labels: Record<string, string | null> = Object.assign(Object.create(null), await chosen())
    if (icon === undefined) delete labels[label]
    else labels[label] = icon
    await writeHomeFile(FILE, { labels })
  })
}

// The nearest icon

interface Vectors {
  model: string
  dimensions: number
  names: string[]
  values: Int8Array
}

let vectors: Vectors | undefined
function iconVectors(): Vectors {
  if (!vectors) {
    const dir = join(process.cwd(), 'src', 'server', 'icons')
    const meta = JSON.parse(readFileSync(join(dir, 'icon-vectors.json'), 'utf8')) as Omit<Vectors, 'values'>
    const bytes = readFileSync(join(dir, 'icon-vectors.bin'))
    vectors = { ...meta, values: new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
  }
  return vectors
}

/** A text as a unit vector, as the icons' vectors were made. */
export type Embed = (text: string) => Promise<number[]>

/** How long the studio goes without a model it couldn't load before it tries again, as the network may be back. */
export const RETRY = 60_000

/**
 * The model, loaded once, on first use: downloaded then, to the studio's home, and read from there after. Null when it
 * can't be had, as offline before it ever was: labels then get the common words' icons alone, until RETRY has passed.
 * On globalThis, as Next may give each route its own copy of this module.
 */
const shared = globalThis as typeof globalThis & { drivineStudioEmbed?: { model: Promise<Embed | null>; failed?: number } }
export function embedder(load: () => Promise<Embed> = loadModel, now: number = Date.now()): Promise<Embed | null> {
  const failed = shared.drivineStudioEmbed?.failed
  if (failed !== undefined && now - failed >= RETRY) shared.drivineStudioEmbed = undefined
  if (!shared.drivineStudioEmbed) {
    const loading: { model: Promise<Embed | null>; failed?: number } = { model: Promise.resolve(null) }
    loading.model = load().catch((e: unknown) => {
      loading.failed = now
      process.stderr.write(`Drivine Studio: no model to find labels' icons with: ${e instanceof Error ? e.message : String(e)}\n`)
      return null
    })
    shared.drivineStudioEmbed = loading
  }
  return shared.drivineStudioEmbed.model
}

async function loadModel(): Promise<Embed> {
  const { env, pipeline } = await import('@huggingface/transformers')
  env.cacheDir = join(studioHome(), 'models')
  const extract = await pipeline('feature-extraction', iconVectors().model, { dtype: 'q8' })
  return async (text: string) => {
    const output = await extract(text, { pooling: 'mean', normalize: true })
    return Array.from(output.data as Float32Array)
  }
}

/** The icon whose words are nearest the label's, and how near, or undefined when there is no model or no word. */
export async function nearest(label: string, embed: Embed | null = null): Promise<{ icon: string; score: number } | undefined> {
  const said = words(label)
  if (!said.length) return undefined
  const model = embed ?? (await embedder())
  if (!model) return undefined
  const query = await model(said.join(' '))
  return nearestTo(query, iconVectors())
}

/** The icon nearest a unit vector: the stored vectors are unit vectors in bytes, at 127 to 1. */
export function nearestTo(query: number[], icons: Vectors): { icon: string; score: number } {
  let best = 0
  let score = -Infinity
  for (let i = 0; i < icons.names.length; i++) {
    let dot = 0
    for (let j = 0; j < icons.dimensions; j++) dot += query[j]! * icons.values[i * icons.dimensions + j]!
    if (dot > score) {
      score = dot
      best = i
    }
  }
  return { icon: icons.names[best]!, score: score / 127 }
}

/** The icon of each label, as LabelIcon says it is found; by the model given, or the studio's own. */
export async function iconsOf(labels: string[], embed: Embed | null = null): Promise<Record<string, LabelIcon>> {
  const picked = await chosen()
  const found: Record<string, LabelIcon> = Object.create(null)
  for (const label of new Set(labels)) {
    if (Object.hasOwn(picked, label)) {
      found[label] = { icon: picked[label] ?? null, source: 'chosen' }
      continue
    }
    const word = common(label)
    if (word) {
      found[label] = { icon: word, source: 'common' }
      continue
    }
    // A label the model fails on gets none, rather than costing the labels asked with it theirs.
    const near = await nearest(label, embed).catch(() => undefined)
    found[label] = near && near.score >= NEAREST
      ? { icon: near.icon, source: 'nearest', score: Math.round(near.score * 1000) / 1000 }
      : { icon: null, source: 'none', ...(near ? { score: Math.round(near.score * 1000) / 1000 } : {}) }
  }
  return found
}
