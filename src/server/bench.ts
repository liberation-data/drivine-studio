import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import { readHomeFile, serially, studioHome, writeHomeFile } from './home'

/*
 * Graph Bench's results, to read and compare in the studio: the ones it publishes, fetched from its repository, and
 * those of a checkout linked here, where `run.sh` writes them. A set is a folder of `<engine>-sf<scale>.json`, one
 * file an engine: `results/` itself, or a folder in it of a run's own (GBENCH_RESULTS). Only those files are read.
 */

export class BenchError extends Error {}

/** One workload's numbers, as Graph Bench writes them, in milliseconds. */
export interface Outcome {
  group: string
  name: string
  calls: number
  p50: number
  p95: number
  mean: number
  min: number
  max: number
  throughput: number | null
  digest: string | null
}

export interface RunDetails {
  at: string
  machine: string
  jvm: string
  drivine: string | null
  bench: string | null
  image: string | null
  imageId: string | null
  limits: string | null
}

export interface EngineResults {
  engine: string
  /** The kind of database, for a run of the studio's own, whose engines are its connections by name. */
  type?: string
  scale: number
  load: { nodes: number; edges: number; schemaSeconds: number; nodeSeconds: number; edgeSeconds: number } | null
  outcomes: Outcome[]
  run?: RunDetails | null
}

/** A set of results: where it is, and the scales and engines in it. */
export interface BenchSet {
  source: string
  set: string
  label: string
  scales: number[]
  engines: string[]
}

export const PUBLISHED = 'published'
/** The studio's own runs, kept in its home's bench folder. */
export const STUDIO = 'studio'
const REPO = 'liberation-data/graph-bench'
const ENGINES = ['neo4j', 'falkordb', 'oracle', 'postgres'] as const
const FILE = /^(.+)-sf([0-9.]+)\.json$/
const LINKS = 'bench.json'
/** In a run of the studio's own, beside its results: the name it was given. */
export const RUN_FILE = 'run.json'

/** The Graph Bench checkouts linked, by path. */
export async function linkedBenches(): Promise<string[]> {
  return ((await readHomeFile<{ paths?: unknown[] }>(LINKS))?.paths ?? []).filter((p): p is string => typeof p === 'string')
}

/** Links a Graph Bench checkout: it must be one, with its `run.sh` and a `results` folder. */
export const linkBench = (path: unknown): Promise<string[]> => serially(async () => {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new BenchError('Give the full path of a Graph Bench checkout.')
  const root = resolve(path)
  const isBench = await stat(join(root, 'run.sh')).then(s => s.isFile(), () => false)
  if (!isBench) throw new BenchError(`${root} is not a Graph Bench checkout: it has no run.sh.`)
  const now = [...new Set([...(await linkedBenches()), root])]
  await writeHomeFile(LINKS, { paths: now })
  return now
})

export const unlinkBench = (path: unknown): Promise<string[]> => serially(async () => {
  const now = (await linkedBenches()).filter(p => p !== path)
  await writeHomeFile(LINKS, { paths: now })
  return now
})

/** The sets of results there are: the published one, and each linked checkout's `results/` and its folders. */
export async function benchSets(fetchText: (url: string) => Promise<string> = published): Promise<BenchSet[]> {
  const sets: BenchSet[] = []
  const files = await publishedFiles(fetchText).catch(() => [])
  if (files.length) sets.push({ source: PUBLISHED, set: '', label: 'Published', ...inventory(files) })
  // The studio's own runs, newest first: each a folder of a file a connection.
  const own = join(studioHome(), 'bench')
  const runs = (await readdir(own, { withFileTypes: true }).catch(() => [])).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort().reverse()
  for (const run of runs) {
    const inside = await jsonFiles(join(own, run))
    if (!inside.length) continue
    const given = await readFile(join(own, run, RUN_FILE), 'utf8').then(text => (JSON.parse(text) as { name?: unknown }).name, () => null)
    sets.push({ source: STUDIO, set: run, label: typeof given === 'string' && given ? given : run.replace(/^[a-z0-9]+-/, ''), ...inventory(inside), engines: inside.map(f => FILE.exec(f)![1]!) })
  }
  for (const root of await linkedBenches()) {
    const results = join(root, 'results')
    const here = await jsonFiles(results)
    if (here.length) sets.push({ source: root, set: '', label: 'results', ...inventory(here) })
    for (const entry of await readdir(results, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const inside = await jsonFiles(join(results, entry.name))
      if (inside.length) sets.push({ source: root, set: entry.name, label: entry.name, ...inventory(inside) })
    }
  }
  return sets
}

/** Each engine's results in a set, at a scale, in the order Graph Bench reports them. */
export async function benchResults(source: string, set: string, scale: number, fetchText: (url: string) => Promise<string> = published): Promise<EngineResults[]> {
  if (!Number.isFinite(scale) || scale <= 0) throw new BenchError('Give a scale, such as 1.')
  const out: EngineResults[] = []
  if (source === PUBLISHED) {
    if (set) throw new BenchError('The published results are one set.')
    for (const engine of ENGINES) {
      const text = await fetchText(`https://raw.githubusercontent.com/${REPO}/main/results/${engine}-sf${scaleText(scale)}.json`).catch(() => null)
      if (text) out.push(JSON.parse(text) as EngineResults)
    }
    return out
  }
  if (source === STUDIO) {
    if (!set || set.includes('/') || set.includes('\\') || set.startsWith('.')) throw new BenchError(`There is no run ${set}.`)
    const folder = join(studioHome(), 'bench', set)
    const files = (await jsonFiles(folder)).filter(f => FILE.exec(f)![2] === scaleText(scale))
    return Promise.all(files.map(async f => JSON.parse(await readFile(join(folder, f), 'utf8')) as EngineResults))
  }
  if (!(await linkedBenches()).includes(source)) throw new BenchError('That is not a linked Graph Bench checkout.')
  // A set is a folder's name, in results/ itself: never a path that reaches anywhere else.
  if (set && (set.includes('/') || set.includes('\\') || set.startsWith('.'))) throw new BenchError(`There is no set ${set}.`)
  const folder = join(source, 'results', set)
  for (const engine of ENGINES) {
    const text = await readFile(join(folder, `${engine}-sf${scaleText(scale)}.json`), 'utf8').catch(() => null)
    if (text) out.push(JSON.parse(text) as EngineResults)
  }
  return out
}

/** As Graph Bench names its files: `1.0`, `0.05`. */
const scaleText = (scale: number) => (Number.isInteger(scale) ? scale.toFixed(1) : String(scale))

function inventory(files: string[]): { scales: number[]; engines: string[] } {
  const scales = new Set<number>()
  const engines = new Set<string>()
  for (const file of files) {
    const match = FILE.exec(file)
    if (!match) continue
    engines.add(match[1]!)
    scales.add(Number(match[2]))
  }
  return { scales: [...scales].sort((a, b) => b - a), engines: ENGINES.filter(e => engines.has(e)) as string[] }
}

async function jsonFiles(folder: string): Promise<string[]> {
  return (await readdir(folder).catch(() => [] as string[])).filter(f => FILE.test(f))
}

async function publishedFiles(fetchText: (url: string) => Promise<string>): Promise<string[]> {
  const listing = JSON.parse(await fetchText(`https://api.github.com/repos/${REPO}/contents/results`)) as { name: string }[]
  return listing.map(f => f.name).filter(f => FILE.test(f))
}

// Fetched once a while, not on every look: GitHub limits calls that carry no token.
const cache = new Map<string, { at: number; text: Promise<string> }>()
const FRESH_MS = 10 * 60_000

function published(url: string): Promise<string> {
  const known = cache.get(url)
  if (known && Date.now() - known.at < FRESH_MS) return known.text
  const text = fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'drivine-studio' } }).then(async response => {
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${url}`)
    return response.text()
  })
  cache.set(url, { at: Date.now(), text })
  text.catch(() => cache.delete(url))
  return text
}
