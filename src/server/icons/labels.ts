import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readHomeFile, serially, studioHome, writeHomeFile } from '../home'

/**
 * An icon for each label, from Lucide's set: the one chosen for it in the studio; else the one a short list of common
 * words gives, with the person's own words added in Settings; else the one a small local model finds nearest the
 * label's words, when it is near enough. A label the model is unsure of gets none, as a wrong icon reads worse than a
 * plain node.
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
export const COMMON: Record<string, string> = {
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
  embedding: 'sparkles', vector: 'sparkles', concept: 'brain', network: 'network', content: 'file-text',
  persona: 'venetian-mask',
}

/**
 * Icons of one particular thing, which the model picks for a label that is only like it: Patient and Drug a cigarette,
 * Disease a rat, Plan a phone, Category a cat. One of them is taken only for a label that names it, as `Cigarette` or
 * `PhoneNumber`; for any other label the next nearest icon is, if it is near enough. Add to it when a label gets one
 * of these: `npm run test:icons` says what a change does to the labels it checks.
 */
export const ONLY_BY_NAME: ReadonlySet<string> = new Set([
  'bell-dot', 'cat', 'cigarette', 'circle-fading-play', 'diamond-percent', 'focus', 'mail', 'phone', 'rat', 'satellite',
])

/**
 * Whether the label's words allow the icon: any icon, unless it is ONLY_BY_NAME, or on the person's own list beside it,
 * and none of its words are said.
 */
export function allows(said: string[], icon: string, own: readonly string[] = []): boolean {
  return !(ONLY_BY_NAME.has(icon) || own.includes(icon)) || icon.split('-').some(it => said.includes(it))
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

/** The icon of the common word a label's words name, from the person's own words or COMMON. */
export function common(label: string, own: Readonly<Record<string, string>> = {}): string | undefined {
  return commonWord(label, own)?.icon
}

/**
 * The common word a label's words name, the whole of them first, then each from the last; and its icon, and whether
 * the word is the person's own. Their own word comes before COMMON's, so a word of theirs can give COMMON's another icon.
 */
export function commonWord(label: string, own: Readonly<Record<string, string>> = {}): { word: string; icon: string; own: boolean } | undefined {
  const found = words(label)
  // Only the lists' own words: an object's own `constructor` is no label's icon.
  const look = (word: string) =>
    Object.hasOwn(own, word) ? { word, icon: own[word]!, own: true }
      : Object.hasOwn(COMMON, word) ? { word, icon: COMMON[word]!, own: false }
        : undefined
  return look(found.join('')) ?? [...found].reverse().map(look).find(it => it !== undefined)
}

/**
 * A word for the person's own list, as a label's words are looked up: `Work History` and `WorkHistory` are both
 * `workhistory`, and `ChunkNode` is `chunk`, as the label ChunkNode is looked up. Empty for a text with no word.
 */
export const wordOf = (text: string): string => words(text).join('')

// The studio's icons file

const FILE = 'icons.json'

/**
 * What the studio keeps of icons, in icons.json in its home: the icons chosen for labels, by label, null for none; and
 * the person's own common words and icons taken only by name, added to COMMON and ONLY_BY_NAME. A file from before the
 * lists has only `labels`.
 */
export interface IconsFile {
  labels: Record<string, string | null>
  words: Record<string, string>
  onlyByName: string[]
}

/** A record read from the file, with no prototype, so a label such as `__proto__` is a key like any other. */
function recordOf<T>(value: unknown, takes: (it: unknown) => it is T): Record<string, T> {
  const record: Record<string, T> = Object.create(null)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return record
  for (const [key, it] of Object.entries(value)) if (takes(it)) record[key] = it
  return record
}

/** The studio's icons file, as it is now: empty lists where it is not there yet, or has none of them. */
export async function iconsFile(): Promise<IconsFile> {
  const file = await readHomeFile<Record<string, unknown>>(FILE)
  return {
    labels: recordOf(file?.labels, (it): it is string | null => it === null || typeof it === 'string'),
    words: recordOf(file?.words, (it): it is string => typeof it === 'string'),
    onlyByName: Array.isArray(file?.onlyByName) ? file.onlyByName.filter((it): it is string => typeof it === 'string') : [],
  }
}

/** Changes the icons file, once every change before it has finished, so two at once cannot each lose the other's. */
function change(edit: (file: IconsFile) => void): Promise<void> {
  return serially(async () => {
    const file = await iconsFile()
    edit(file)
    await writeHomeFile(FILE, file)
  })
}

/** The icons chosen in the studio, by label, kept in its home: null for a label chosen to have none. */
export async function chosen(): Promise<Record<string, string | null>> {
  return (await iconsFile()).labels
}

/** Chooses a label's icon, or none with null; undefined forgets the choice, so the label's icon is found again. */
export function choose(label: string, icon: string | null | undefined): Promise<void> {
  return change(file => {
    if (icon === undefined) delete file.labels[label]
    else file.labels[label] = icon
  })
}

/** Gives a word of the person's own its icon, or with undefined takes the word off their list. */
export function chooseWord(word: string, icon: string | undefined): Promise<void> {
  return change(file => {
    if (icon === undefined) delete file.words[word]
    else file.words[word] = icon
  })
}

/** Puts an icon on the person's own list of icons taken only by name, or takes it off. */
export function takeOnlyByName(icon: string, listed: boolean): Promise<void> {
  return change(file => {
    const rest = file.onlyByName.filter(it => it !== icon)
    file.onlyByName = listed ? [...rest, icon].sort() : rest
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

/** An icon the model found for a label, and how near, from -1 to 1. */
export interface Pick {
  icon: string
  score: number
}

/** How many of the model's nearest icons are shown for a label: enough to choose from with a click. */
export const PICKS = 5

/**
 * The icons whose words are nearest the label's, nearest first, of those its words allow; none when there is no model
 * or no word. `own` is the person's own list of icons taken only by name.
 */
export async function nearestFew(label: string, count: number, embed: Embed | null = null, own: readonly string[] = []): Promise<Pick[]> {
  const said = words(label)
  if (!said.length) return []
  const model = embed ?? (await embedder())
  if (!model) return []
  const query = await model(said.join(' '))
  return rankTo(query, iconVectors(), icon => allows(said, icon, own), count)
}

/** The icon whose words are nearest the label's, and how near, or undefined when there is no model or no word. */
export async function nearest(label: string, embed: Embed | null = null, own: readonly string[] = []): Promise<Pick | undefined> {
  return (await nearestFew(label, 1, embed, own))[0]
}

/**
 * The icon nearest a unit vector, of those `allowed` takes: the stored vectors are unit vectors in bytes, at 127 to 1.
 */
export function nearestTo(query: number[], icons: Vectors, allowed: (icon: string) => boolean = () => true): Pick {
  return rankTo(query, icons, allowed, 1)[0] ?? { icon: icons.names[0]!, score: -Infinity }
}

/** The `count` icons nearest a unit vector, nearest first, of those `allowed` takes. */
export function rankTo(query: number[], icons: Vectors, allowed: (icon: string) => boolean, count: number): Pick[] {
  // The nearest so far, nearest first: few enough that keeping them in order as each icon is scored is cheap.
  const best: { at: number; dot: number }[] = []
  if (count < 1) return []
  for (let i = 0; i < icons.names.length; i++) {
    if (!allowed(icons.names[i]!)) continue
    let dot = 0
    for (let j = 0; j < icons.dimensions; j++) dot += query[j]! * icons.values[i * icons.dimensions + j]!
    if (best.length === count && dot <= best[count - 1]!.dot) continue
    const at = best.findIndex(it => dot > it.dot)
    best.splice(at < 0 ? best.length : at, 0, { at: i, dot })
    if (best.length > count) best.pop()
  }
  return best.map(it => ({ icon: icons.names[it.at]!, score: it.dot / 127 }))
}

const rounded = (score: number) => Math.round(score * 1000) / 1000

/**
 * A label's icon from what the file holds: chosen, else a common word's, else the nearest when it is near enough.
 * `near` asks the model only when it comes to that, as most labels never need it.
 */
async function iconOf(label: string, file: IconsFile, near: () => Promise<Pick | undefined>): Promise<LabelIcon> {
  if (Object.hasOwn(file.labels, label)) return { icon: file.labels[label] ?? null, source: 'chosen' }
  const word = common(label, file.words)
  if (word) return { icon: word, source: 'common' }
  // A label the model fails on gets none, rather than costing the labels asked with it theirs.
  const found = await near().catch(() => undefined)
  return found && found.score >= NEAREST
    ? { icon: found.icon, source: 'nearest', score: rounded(found.score) }
    : { icon: null, source: 'none', ...(found ? { score: rounded(found.score) } : {}) }
}

/** The icon of each label, as LabelIcon says it is found; by the model given, or the studio's own. */
export async function iconsOf(labels: string[], embed: Embed | null = null): Promise<Record<string, LabelIcon>> {
  const file = await iconsFile()
  const found: Record<string, LabelIcon> = Object.create(null)
  for (const label of new Set(labels)) found[label] = await iconOf(label, file, () => nearest(label, embed, file.onlyByName))
  return found
}

/** A label's icon, and why: the common word it was found from, and the model's nearest icons whatever it was found from. */
export interface Explained extends LabelIcon {
  /** The word of the label that gave the icon, and whether it is the person's own: only for `common`. */
  word?: string
  own?: boolean
  /** The model's nearest icons that the label's words allow, nearest first: none without a model. */
  picks: Pick[]
}

/**
 * Each label's icon and why, for Settings to show: as iconsOf finds it, with the model's `count` nearest icons beside
 * it, so a label with none, or the wrong one, is given a better with a click.
 */
export async function explain(labels: string[], count: number = PICKS, embed: Embed | null = null): Promise<Record<string, Explained>> {
  const file = await iconsFile()
  const found: Record<string, Explained> = Object.create(null)
  for (const label of new Set(labels)) {
    // Asked once, for the picks and the icon alike; a model that fails gives neither.
    const near = await nearestFew(label, count, embed, file.onlyByName).catch(() => [])
    const icon = await iconOf(label, file, async () => near[0])
    const word = icon.source === 'common' ? commonWord(label, file.words) : undefined
    found[label] = { ...icon, ...(word ? { word: word.word, own: word.own } : {}), picks: near.map(it => ({ icon: it.icon, score: rounded(it.score) })) }
  }
  return found
}
