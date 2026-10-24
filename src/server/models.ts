import { readdir, readFile, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import type { Catalog, Fragment, ModelPath, ModelSource, RelationshipFragment, View } from '../studio/api'
import { readHomeFile, serially, writeHomeFile } from './home'
import type { Env } from './connections'

/** A path to look for model files in that the studio cannot take: the person can fix it, so it is a 400. */
export class ModelPathError extends Error {}

/**
 * Where the studio looks for model files: the paths DRIVINE_STUDIO_MODELS names, separated as PATH is, and those added
 * in the studio, kept in models.json in its home.
 */
const FILE = 'models.json'

async function stored(): Promise<string[]> {
  return ((await readHomeFile<{ paths?: unknown[] }>(FILE))?.paths ?? []).filter((p): p is string => typeof p === 'string')
}

export function fromEnvironment(env: Env = process.env): string[] {
  return (env.DRIVINE_STUDIO_MODELS ?? '').split(delimiter).map(p => p.trim()).filter(p => p !== '')
}

export async function listModelPaths(env: Env = process.env): Promise<ModelPath[]> {
  const environment = fromEnvironment(env).map(path => ({ path, source: 'environment' as const }))
  const own = (await stored()).map(path => ({ path, source: 'studio' as const }))
  return [...environment, ...own.filter(o => !environment.some(e => e.path === o.path))]
}

/** Adds a folder or a file to look in. It must be there, and absolute, as the studio may not run where it was asked. */
export async function addModelPath(path: unknown): Promise<ModelPath[]> {
  if (typeof path !== 'string' || path.trim() === '') throw new ModelPathError('Give a folder or a model file.')
  const trimmed = path.trim()
  if (!isAbsolute(trimmed)) throw new ModelPathError(`Give the whole path, from the root: ${trimmed} is relative.`)
  try {
    await stat(trimmed)
  } catch {
    throw new ModelPathError(`There is nothing at ${trimmed}.`)
  }
  await serially(async () => {
    const paths = await stored()
    if (!paths.includes(trimmed)) await writeHomeFile(FILE, { paths: [...paths, trimmed] })
  })
  return listModelPaths()
}

export async function removeModelPath(path: unknown): Promise<ModelPath[]> {
  if (typeof path !== 'string') throw new ModelPathError('Name the path to stop looking in.')
  if (fromEnvironment().includes(path)) throw new ModelPathError('DRIVINE_STUDIO_MODELS names that path; change it in the environment.')
  await serially(async () => writeHomeFile(FILE, { paths: (await stored()).filter(p => p !== path) }))
  return listModelPaths()
}

/** Folders no model file is in, and which can be large. */
const SKIPPED = new Set(['node_modules', '.git', 'build', 'target', 'dist', 'out', '.next', '.gradle', '.idea', '.venv', 'venv', '__pycache__'])
/** How far below a folder the studio looks: far enough for a module of a module, not the whole disk. */
const DEPTH = 6

/** Every model file under a folder: `.drivine/model.json` beside each module's build file. */
export async function findModelFiles(path: string): Promise<string[]> {
  const info = await stat(path)
  if (info.isFile()) return [resolve(path)]
  const found: string[] = []
  const walk = async (dir: string, depth: number) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const child = join(dir, entry.name)
      if (entry.name === '.drivine') {
        const model = join(child, 'model.json')
        if (await stat(model).then(s => s.isFile(), () => false)) found.push(model)
      } else if (depth < DEPTH && !SKIPPED.has(entry.name)) {
        await walk(child, depth + 1)
      }
    }
  }
  await walk(resolve(path), 0)
  return found.sort()
}

/** The format's major version, which a reader must know. Within it, keys a reader does not know are skipped. */
const FORMAT = 'drivine-model/1'

interface ModelFile {
  format: string
  generator: ModelSource['generator']
  module: string
  fragments: Omit<Fragment, 'module'>[]
  relationshipFragments: Omit<RelationshipFragment, 'module'>[]
  views: Omit<View, 'module'>[]
}

/** A model file's text as the studio reads it, or why it cannot. */
export function parseModel(text: string): ModelFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`It is not JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  const model = parsed as Partial<ModelFile> | null
  if (!model || typeof model !== 'object') throw new Error('It is not a model file.')
  if (model.format !== FORMAT) {
    throw new Error(`Its format is ${String(model.format)}, which this studio does not read: it reads ${FORMAT}.`)
  }
  for (const key of ['fragments', 'relationshipFragments', 'views'] as const) {
    if (!Array.isArray(model[key])) throw new Error(`It has no list of ${key}.`)
  }
  return {
    format: model.format,
    generator: model.generator ?? { library: 'unknown', version: '', language: '' },
    module: typeof model.module === 'string' ? model.module : 'unknown',
    fragments: model.fragments!,
    relationshipFragments: model.relationshipFragments!,
    views: model.views!,
  }
}

type Merged<T> = Map<string, T & { module: string; removed?: boolean }>

/**
 * Puts one module's entries among those already read, by id. An id current in one file and removed in another is
 * the current one, as when a class moves. The same id current in two modules is a mistake the studio names.
 */
function merge<T extends { id: string; removed?: boolean }>(
  into: Merged<T>,
  entries: T[],
  module: string,
  problem: (message: string) => void,
): void {
  for (const entry of entries) {
    const known = into.get(entry.id)
    const placed = { ...entry, module }
    if (!known || (known.removed && !entry.removed)) {
      into.set(entry.id, placed)
    } else if (!known.removed && !entry.removed) {
      problem(`${entry.id} is declared in ${known.module} and in ${module}; the studio shows the first.`)
    }
  }
}

const sorted = <T extends { id: string }>(entries: Iterable<T>): T[] => [...entries].sort((a, b) => a.id.localeCompare(b.id))

/** Reads every model file under the paths, and merges them into one catalogue. */
export async function readCatalog(paths: string[]): Promise<Catalog> {
  const catalog: Catalog = { models: [], fragments: [], relationshipFragments: [], views: [], problems: [] }
  const fragments: Merged<Omit<Fragment, 'module'>> = new Map()
  const relationshipFragments: Merged<Omit<RelationshipFragment, 'module'>> = new Map()
  const views: Merged<Omit<View, 'module'>> = new Map()
  const seen = new Set<string>()
  for (const path of paths) {
    let files: string[]
    try {
      files = await findModelFiles(path)
    } catch {
      catalog.problems.push({ file: path, message: 'There is nothing there.' })
      continue
    }
    for (const found of files) {
      // A file under two of the paths is read once.
      if (seen.has(found)) continue
      seen.add(found)
      try {
        const model = parseModel(await readFile(found, 'utf8'))
        catalog.models.push({ module: model.module, file: found, generator: model.generator })
        const problem = (message: string) => catalog.problems.push({ file: found, message })
        merge(fragments, model.fragments, model.module, problem)
        merge(relationshipFragments, model.relationshipFragments, model.module, problem)
        merge(views, model.views, model.module, problem)
      } catch (e) {
        catalog.problems.push({ file: found, message: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  catalog.fragments = sorted(fragments.values())
  catalog.relationshipFragments = sorted(relationshipFragments.values())
  catalog.views = sorted(views.values())
  return catalog
}
