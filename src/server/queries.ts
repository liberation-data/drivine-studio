import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
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
  /** Its file's name, which is its name and `.cypher`. */
  id: string
  name: string
  statement: string
  /** The parameters as typed, a JSON object or nothing: kept as text, so a half-written one is kept as it was. */
  parameters: string
  /** When its file was last written, as an ISO date. */
  saved: string
}

export type QueryInput = Pick<SavedQuery, 'name' | 'statement' | 'parameters'>

/** A query's name or statement is wrong, or it is not there: the person can fix it, so it is a 400. */
export class QueryError extends Error {}

const EXTENSION = '.cypher'
const NAME_LENGTH = 120
const OPEN = '/* parameters\n'
const CLOSE = '\n*/\n'

export const queriesFolder = (): string => join(studioHome(), 'queries')

/** A file's name for a query's name: what no file system takes, or reads as a path, is left out. */
export function fileOf(name: string): string {
  const safe = name
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    // Leading dots would hide the file, or climb out of the folder.
    .replace(/^[.\s]+/, '')
    .trim()
  return `${safe}${EXTENSION}`
}

/** The file an id names, or a QueryError for one that would be anywhere but in the folder. */
function fileFor(id: string): string {
  if (!id.endsWith(EXTENSION) || id !== fileOf(id.slice(0, -EXTENSION.length))) throw new QueryError(`There is no saved query ${id}.`)
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

async function readQuery(file: string): Promise<SavedQuery> {
  const path = join(queriesFolder(), file)
  const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
  return { id: file, name: file.slice(0, -EXTENSION.length), ...readBack(text), saved: info.mtime.toISOString() }
}

/** The saved queries, by name. A folder not made yet has none. */
export async function listQueries(): Promise<SavedQuery[]> {
  let files: string[]
  try {
    files = (await readdir(queriesFolder())).filter(f => f.endsWith(EXTENSION) && !f.startsWith('.'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  return (await Promise.all(files.map(readQuery))).sort((a, b) => a.name.localeCompare(b.name))
}

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
  return { name, statement, parameters }
}

const exists = (path: string) => stat(path).then(() => true, () => false)

async function write(file: string, input: QueryInput): Promise<SavedQuery> {
  await mkdir(queriesFolder(), { recursive: true, mode: 0o700 })
  const path = join(queriesFolder(), file)
  // Beside it first, then over it, so a crash part way leaves the old file whole.
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, written(input), { mode: 0o600 })
  await rename(temporary, path)
  return readQuery(file)
}

/** Saves a new query. A name another query has is refused, rather than saved over it. */
export const addQuery = (input: QueryInput): Promise<SavedQuery> => serially(async () => {
  const file = fileOf(input.name)
  if (await exists(join(queriesFolder(), file))) throw new QueryError(`There is a saved query named ${input.name} already. Choose another name.`)
  return write(file, input)
})

/** Saves over a query, under the name given: a new name renames its file. */
export const updateQuery = (id: string, input: QueryInput): Promise<SavedQuery> => serially(async () => {
  const from = fileFor(id)
  if (!(await exists(from))) throw new QueryError(`There is no saved query ${id}.`)
  const file = fileOf(input.name)
  if (file !== id && (await exists(join(queriesFolder(), file)))) {
    throw new QueryError(`There is a saved query named ${input.name} already. Choose another name.`)
  }
  const saved = await write(file, input)
  if (file !== id) await unlink(from)
  return saved
})

export const removeQuery = (id: string): Promise<void> => serially(async () => {
  const path = fileFor(id)
  if (!(await exists(path))) throw new QueryError(`There is no saved query ${id}.`)
  await unlink(path)
})
