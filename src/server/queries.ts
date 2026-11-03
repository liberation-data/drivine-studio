import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { serially, studioHome } from './home'

/*
 * Statements kept to run again, one file each: `<name>.cypher` in the `queries` folder of the studio's home, on this
 * machine, never in a database. A file is Cypher as it is written anywhere, so it opens in an editor, runs in
 * cypher-shell, and can be kept in git. Its parameters, when it has any, lead it in a comment:
 *
 *   /* parameters
 *   {"name": "Ada"}
 *   *\/
 *   MATCH (p:Person {name: $name}) RETURN p
 */

export interface SavedQuery {
  /** Its file's path in the folder: its folder's, then its name and `.cypher`, as `Films/Keanu.cypher`. */
  id: string
  name: string
  /** The folder it is in, as `Films`, or '' for the top. */
  folder: string
  statement: string
  /** The parameters as typed, a JSON object or nothing: kept as text, so a half-written one is kept as it was. */
  parameters: string
  /** When its file was last written, as an ISO date. */
  saved: string
}

export type QueryInput = Pick<SavedQuery, 'name' | 'statement' | 'parameters' | 'folder'>

/** A folder of queries: its path, as `Films/Keanu`, and what it holds directly. */
export interface QueryFolder {
  path: string
  name: string
  folders: number
  queries: number
}

export interface QueryShelf {
  folders: QueryFolder[]
  queries: SavedQuery[]
}

/** A query's name or statement is wrong, or it is not there: the person can fix it, so it is a 400. */
export class QueryError extends Error {}

const EXTENSION = '.cypher'
const NAME_LENGTH = 120
const OPEN = '/* parameters\n'
const CLOSE = '\n*/\n'

export const queriesFolder = (): string => join(studioHome(), 'queries')

/** How deep folders go: enough to keep things tidy, not a tree to get lost in. */
const DEPTH = 4

/** A name as a file or folder can carry it: what no file system takes, or reads as a path, is left out. */
export function safeName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    // Leading dots would hide the file, or climb out of the folder.
    .replace(/^[.\s]+/, '')
    .trim()
}

/** A file's name for a query's name. */
export const fileOf = (name: string): string => `${safeName(name)}${EXTENSION}`

/** A folder's path checked, each part a name as a folder carries it, or a QueryError. '' is the top. */
export function folderOf(path: string): string {
  if (path === '') return ''
  const parts = path.split('/')
  if (parts.length > DEPTH || parts.some(part => part === '' || part !== safeName(part))) throw new QueryError(`There is no folder ${path}.`)
  return path
}

const within = (folder: string, file: string) => (folder ? `${folder}/${file}` : file)
const exists = (path: string) => stat(path).then(() => true, () => false)

/** The file an id names, or a QueryError for one that would be anywhere but in the queries folder. */
function fileFor(id: string): string {
  const slash = id.lastIndexOf('/')
  const file = id.slice(slash + 1)
  try {
    folderOf(slash < 0 ? '' : id.slice(0, slash))
  } catch {
    throw new QueryError(`There is no saved query ${id}.`)
  }
  if (!file.endsWith(EXTENSION) || file !== fileOf(file.slice(0, -EXTENSION.length))) throw new QueryError(`There is no saved query ${id}.`)
  return join(queriesFolder(), id)
}

/** A query's file as written: its parameters in the leading comment, when it has any, then the statement. */
export function written(input: QueryInput): string {
  const parameters = input.parameters.trim()
  const statement = input.statement.endsWith('\n') ? input.statement : `${input.statement}\n`
  return parameters ? `${OPEN}${parameters}${CLOSE}${statement}` : statement
}

/** A file read back: the leading comment's parameters, and the statement after it. */
export function readBack(text: string): Pick<SavedQuery, 'statement' | 'parameters'> {
  if (text.startsWith(OPEN)) {
    const end = text.indexOf(CLOSE, OPEN.length)
    if (end >= 0) return { parameters: text.slice(OPEN.length, end), statement: text.slice(end + CLOSE.length).replace(/\n$/, '') }
  }
  return { parameters: '', statement: text.replace(/\n$/, '') }
}

async function readQuery(id: string): Promise<SavedQuery> {
  const path = join(queriesFolder(), id)
  const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
  const slash = id.lastIndexOf('/')
  return {
    id,
    name: id.slice(slash + 1, -EXTENSION.length),
    folder: slash < 0 ? '' : id.slice(0, slash),
    ...readBack(text),
    saved: info.mtime.toISOString(),
  }
}

/**
 * Every saved query and every folder, by name, walked from the top. A folder not made yet holds none. What is not a
 * query or a folder a query could be in (a hidden file, a name no query would have) is passed over.
 */
export async function listQueries(): Promise<QueryShelf> {
  const folders: QueryFolder[] = []
  const ids: string[] = []
  const walk = async (folder: string, depth: number): Promise<boolean> => {
    let entries
    try {
      entries = await readdir(join(queriesFolder(), folder), { withFileTypes: true })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw e
    }
    let held = { folders: 0, queries: 0 }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isFile() && entry.name.endsWith(EXTENSION) && entry.name === fileOf(entry.name.slice(0, -EXTENSION.length))) {
        ids.push(within(folder, entry.name))
        held = { ...held, queries: held.queries + 1 }
      } else if (entry.isDirectory() && depth < DEPTH && entry.name === safeName(entry.name)) {
        if (await walk(within(folder, entry.name), depth + 1)) held = { ...held, folders: held.folders + 1 }
      }
    }
    if (folder) folders.push({ path: folder, name: folder.slice(folder.lastIndexOf('/') + 1), ...held })
    return true
  }
  await walk('', 0)
  const queries = await Promise.all(ids.map(readQuery))
  return {
    folders: folders.sort((a, b) => a.path.localeCompare(b.path)),
    queries: queries.sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/** Makes a folder, in one that is there or at the top. */
export const addFolder = (path: unknown): Promise<QueryFolder> => serially(async () => {
  const folder = folderOf(typeof path === 'string' ? path.trim() : '')
  if (!folder) throw new QueryError('Give the folder a name.')
  const slash = folder.lastIndexOf('/')
  if (slash >= 0 && !(await exists(join(queriesFolder(), folder.slice(0, slash))))) throw new QueryError(`There is no folder ${folder.slice(0, slash)}.`)
  if (await exists(join(queriesFolder(), folder))) throw new QueryError(`There is a folder named ${folder} already.`)
  await mkdir(join(queriesFolder(), folder), { recursive: true, mode: 0o700 })
  return { path: folder, name: folder.slice(slash + 1), folders: 0, queries: 0 }
})

/** Removes a folder with nothing in it: one with queries in it is not thrown away with them. */
export const removeFolder = (path: unknown): Promise<void> => serially(async () => {
  const folder = folderOf(typeof path === 'string' ? path : '')
  if (!folder) throw new QueryError('The top of the queries is not a folder to remove.')
  const entries = await readdir(join(queriesFolder(), folder)).catch(() => null)
  if (entries === null) throw new QueryError(`There is no folder ${folder}.`)
  if (entries.some(e => !e.startsWith('.'))) throw new QueryError(`${folder} is not empty. Move or delete what is in it first.`)
  await rm(join(queriesFolder(), folder), { recursive: true })
})

/** The input checked, or a QueryError saying what to fix. */
export function validateQuery(input: unknown): QueryInput {
  if (typeof input !== 'object' || input === null) throw new QueryError('A query is an object.')
  const raw = input as Record<string, unknown>
  const text = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : '')
  const name = text('name').trim()
  if (!name || fileOf(name) === EXTENSION) throw new QueryError('Give the query a name.')
  if (name.length > NAME_LENGTH) throw new QueryError(`A query's name is at most ${NAME_LENGTH} characters.`)
  const statement = text('statement')
  if (!statement.trim()) throw new QueryError('There is no statement to save.')
  const parameters = text('parameters')
  // The comment they are kept in would end early.
  if (parameters.includes('*/')) throw new QueryError('Parameters with */ in them cannot be kept in the file’s comment.')
  return { name, statement, parameters, folder: folderOf(text('folder')) }
}

async function write(id: string, input: QueryInput): Promise<SavedQuery> {
  if (input.folder && !(await exists(join(queriesFolder(), input.folder)))) throw new QueryError(`There is no folder ${input.folder}.`)
  await mkdir(queriesFolder(), { recursive: true, mode: 0o700 })
  const path = join(queriesFolder(), id)
  // Beside it first, then over it, so a crash part way leaves the old file whole.
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, written(input), { mode: 0o600 })
  await rename(temporary, path)
  return readQuery(id)
}

/** Saves a new query. A name another query has is refused, rather than saved over it. */
export const addQuery = (input: QueryInput): Promise<SavedQuery> => serially(async () => {
  const id = within(input.folder, fileOf(input.name))
  if (await exists(join(queriesFolder(), id))) throw new QueryError(`There is a saved query named ${input.name} there already. Choose another name.`)
  return write(id, input)
})

/** Saves over a query, under the name given: a new name renames its file. */
export const updateQuery = (id: string, input: QueryInput): Promise<SavedQuery> => serially(async () => {
  const from = fileFor(id)
  if (!(await exists(from))) throw new QueryError(`There is no saved query ${id}.`)
  const to = within(input.folder, fileOf(input.name))
  if (to !== id && (await exists(join(queriesFolder(), to)))) {
    throw new QueryError(`There is a saved query named ${input.name} there already. Choose another name.`)
  }
  const saved = await write(to, input)
  if (to !== id) await unlink(from)
  return saved
})

export const removeQuery = (id: string): Promise<void> => serially(async () => {
  const path = fileFor(id)
  if (!(await exists(path))) throw new QueryError(`There is no saved query ${id}.`)
  await unlink(path)
})
