import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { DATABASE_TYPES } from '../studio/database'
import type { DatabaseType } from '../studio/database'

/** A connection as the studio keeps it, password and all. Never sent to the browser: see toPublic. */
export interface Connection {
  id: string
  name: string
  type: DatabaseType
  host: string
  port?: number
  user?: string
  password?: string
  /** The database to use: Neo4j's database, Postgres's and Oracle's service. */
  database?: string
  /** Oracle's property graph, `drivine` unless named. */
  graph?: string
  /** 'environment' for the one Drivine's environment variables describe, which the studio cannot change. */
  source: 'studio' | 'environment'
}

/** A connection as the browser sees it: whether it has a password, never the password. */
export type PublicConnection = Omit<Connection, 'password'> & { hasPassword: boolean }

/** What the browser sends to add or change a connection. A change without a password keeps the one there. */
export type ConnectionInput = Omit<Connection, 'id' | 'source'> & { clearPassword?: boolean }

/** A connection's settings are wrong, or it is not there: the person can fix it, so it is a 400. */
export class ConnectionError extends Error {}

/** The environment, or as much of one as a test gives. */
export type Env = Record<string, string | undefined>

export const toPublic = ({ password, ...rest }: Connection): PublicConnection => ({ ...rest, hasPassword: !!password })

/**
 * Where the studio keeps its connections: `connections.json` in DRIVINE_STUDIO_HOME, or `~/.drivine-studio`. The file
 * holds passwords, so only its owner may read it.
 */
export const studioHome = (): string => process.env.DRIVINE_STUDIO_HOME ?? join(homedir(), '.drivine-studio')
const file = () => join(studioHome(), 'connections.json')

async function readStored(): Promise<Connection[]> {
  let text: string
  try {
    text = await readFile(file(), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const parsed = JSON.parse(text) as { connections?: Connection[] }
  return (parsed.connections ?? []).map(c => ({ ...c, source: 'studio' as const }))
}

async function writeStored(connections: Connection[]): Promise<void> {
  await mkdir(studioHome(), { recursive: true, mode: 0o700 })
  const stored = connections.map(({ source: _, ...rest }) => rest)
  // Written beside the file and moved over it, so a crash part way leaves the old file whole.
  const temporary = `${file()}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify({ connections: stored }, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file())
}

/**
 * The connection Drivine's own environment variables describe (DATABASE_TYPE, DATABASE_HOST and the rest), as an
 * application using Drivine reads them, when DATABASE_TYPE is set: so a container needs no file.
 */
export function fromEnvironment(env: Env = process.env): Connection | undefined {
  const type = env.DATABASE_TYPE
  if (!type) return undefined
  const port = env.DATABASE_PORT ? Number(env.DATABASE_PORT) : undefined
  return {
    id: 'environment',
    name: env.DRIVINE_STUDIO_CONNECTION_NAME ?? 'From the environment',
    type: type as DatabaseType,
    host: env.DATABASE_HOST ?? '',
    ...(port !== undefined ? { port } : {}),
    ...(env.DATABASE_USER ? { user: env.DATABASE_USER } : {}),
    ...(env.DATABASE_PASSWORD ? { password: env.DATABASE_PASSWORD } : {}),
    ...(env.DATABASE_NAME ? { database: env.DATABASE_NAME } : {}),
    ...(env.DATABASE_DEFAULT_GRAPH_PATH ? { graph: env.DATABASE_DEFAULT_GRAPH_PATH } : {}),
    source: 'environment',
  }
}

/** Every connection: the environment's first, when there is one, then the studio's own by name. */
export async function listConnections(): Promise<Connection[]> {
  const environment = fromEnvironment()
  const stored = (await readStored()).sort((a, b) => a.name.localeCompare(b.name))
  return environment ? [environment, ...stored] : stored
}

/** The connection with this id, the environment's included, or a ConnectionError. */
export async function findConnection(id: string): Promise<Connection> {
  const found = (await listConnections()).find(c => c.id === id)
  if (!found) throw new ConnectionError(`There is no connection ${id}.`)
  return found
}

/** The input checked and trimmed, or a ConnectionError saying what to fix. */
export function validate(input: unknown): ConnectionInput {
  if (typeof input !== 'object' || input === null) throw new ConnectionError('A connection is an object.')
  const raw = input as Record<string, unknown>
  const text = (key: string): string | undefined => {
    const value = raw[key]
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value !== 'string') throw new ConnectionError(`${key} must be text.`)
    return value.trim() === '' ? undefined : key === 'password' ? value : value.trim()
  }
  const name = text('name')
  if (!name) throw new ConnectionError('Give the connection a name.')
  const type = text('type')
  if (!type || !(DATABASE_TYPES as readonly string[]).includes(type)) {
    throw new ConnectionError(`The type must be one of ${DATABASE_TYPES.join(', ')}.`)
  }
  const host = text('host')
  if (!host) throw new ConnectionError('Give the host the database runs on.')
  let port: number | undefined
  if (raw.port !== undefined && raw.port !== null && raw.port !== '') {
    port = Number(raw.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConnectionError('The port must be a whole number from 1 to 65535.')
  }
  const database = text('database')
  if ((type === 'POSTGRES' || type === 'ORACLE') && !database) {
    throw new ConnectionError(type === 'ORACLE' ? 'Give the Oracle service name.' : 'Give the Postgres database name.')
  }
  const user = text('user')
  const password = text('password')
  const graph = text('graph')
  return {
    name,
    type: type as DatabaseType,
    host,
    ...(port !== undefined ? { port } : {}),
    ...(user ? { user } : {}),
    ...(password ? { password } : {}),
    ...(database ? { database } : {}),
    ...(graph ? { graph } : {}),
    ...(raw.clearPassword === true ? { clearPassword: true } : {}),
  }
}

// One change at a time, so two at once cannot each write the file over the other's. On globalThis, as the providers
// are, since Next may give each route its own copy of this module, and the routes change the one file.
const queue = globalThis as typeof globalThis & { drivineStudioChanges?: Promise<unknown> }
function serially<T>(change: () => Promise<T>): Promise<T> {
  const next = (queue.drivineStudioChanges ?? Promise.resolve()).then(change, change)
  queue.drivineStudioChanges = next.catch(() => undefined)
  return next
}

const settled = ({ clearPassword: _, ...input }: ConnectionInput): Omit<Connection, 'id' | 'source'> => input

/** Adds a connection to the file, under an id of its own. */
export const addConnection = (input: ConnectionInput): Promise<Connection> => serially(async () => {
  const stored = await readStored()
  const added: Connection = { ...settled(input), id: randomUUID(), source: 'studio' }
  await writeStored([...stored, added])
  return added
})

/** Changes a connection. One sent without a password keeps the password it had, unless clearPassword says not to. */
export const updateConnection = (id: string, input: ConnectionInput): Promise<Connection> => serially(async () => {
  if (id === 'environment') throw new ConnectionError('The environment\'s connection is changed in the environment.')
  const stored = await readStored()
  const current = stored.find(c => c.id === id)
  if (!current) throw new ConnectionError(`There is no connection ${id}.`)
  const password = input.password ?? (input.clearPassword ? undefined : current.password)
  const updated: Connection = { ...settled(input), ...(password ? { password } : {}), id, source: 'studio' }
  if (!password) delete updated.password
  await writeStored(stored.map(c => (c.id === id ? updated : c)))
  return updated
})

/** Removes a connection from the file. The environment's is not in it, so it is refused. */
export const removeConnection = (id: string): Promise<void> => serially(async () => {
  if (id === 'environment') throw new ConnectionError('The environment\'s connection is removed from the environment.')
  const stored = await readStored()
  if (!stored.some(c => c.id === id)) throw new ConnectionError(`There is no connection ${id}.`)
  await writeStored(stored.filter(c => c.id !== id))
})
