import { DatabaseRegistry, DatabaseType, FalkorDbParameterCoercer } from '@liberation-data/drivine'
import type { ConnectionProvider } from '@liberation-data/drivine'
import neo4j from 'neo4j-driver'
import type { Driver } from 'neo4j-driver'
import { DEFAULT_LIMIT, RUNS_CYPHER } from '../studio/database'
import type { CypherResult } from '../studio/database'
import { ConnectionError } from './connections'
import type { Connection } from './connections'
import { Cells } from './values'

/**
 * Drivine's connection provider for each of the studio's connections, built when first used. A connection that has
 * changed since gets a new one, and the old one is closed. Each is registered under its own name in Drivine's
 * registry, since a name, once there, keeps the provider it was first given.
 */
// On globalThis, since Next may give each route its own copy of this module, and the route that removes a connection
// must close the provider the route that ran Cypher on it built.
const shared = globalThis as typeof globalThis & {
  drivineStudioProviders?: { providers: Map<string, { settings: string; provider: ConnectionProvider }>; built: number }
}
const cache = (shared.drivineStudioProviders ??= { providers: new Map(), built: 0 })
const providers = cache.providers

async function providerFor(connection: Connection): Promise<ConnectionProvider> {
  const settings = JSON.stringify(connection)
  const known = providers.get(connection.id)
  if (known?.settings === settings) return known.provider
  // Closed without waiting for it, so that a second call meanwhile finds the new provider rather than building another.
  if (known) {
    providers.delete(connection.id)
    void known.provider.end().catch(() => undefined)
  }
  const builder = DatabaseRegistry.getInstance().builder().withType(connection.type as DatabaseType).host(connection.host)
  if (connection.port) builder.port(connection.port)
  if (connection.user) builder.userName(connection.user)
  if (connection.password) builder.password(connection.password)
  if (connection.database) builder.databaseName(connection.database)
  if (connection.graph) builder.defaultGraphPath(connection.graph)
  let provider: ConnectionProvider
  try {
    provider = builder.register(`studio-${connection.id}-${++cache.built}`)
  } catch (e) {
    // Drivine refuses settings it cannot build on, as Neo4j without a user: the person's to fix.
    throw new ConnectionError(e instanceof Error ? e.message : String(e))
  }
  providers.set(connection.id, { settings, provider })
  return provider
}

/** Closes the provider of a connection that was removed. */
export async function forget(id: string): Promise<void> {
  const known = providers.get(id)
  providers.delete(id)
  await known?.provider.end().catch(() => undefined)
}

/** A statement the studio will not run, or one the database turned down: the person can fix it, so it is a 400. */
export class StatementError extends Error {}

/** Said before a database's refusal to write, so the person knows the refusal is the studio's doing. */
export const READS_ONLY = 'The studio reads and never writes, and runs each statement where it cannot.'

/**
 * Runs a statement and reads at most `limit` rows of what it gives back. The studio reads and never writes, so the
 * statement runs where what it does cannot last. Over Bolt, in a read session, whose transaction the database will
 * not let write, and which is rolled back all the same. On FalkorDB, which has no transactions, as a read-only query,
 * which FalkorDB will not let write. A procedure that opens transactions of its own, as some of APOC's do, is beyond
 * either: a user that may only read is the whole guarantee.
 */
export async function run(
  connection: Connection,
  statement: string,
  parameters: Record<string, unknown> = {},
  limit: number = DEFAULT_LIMIT,
): Promise<CypherResult> {
  const cells = new Cells(connection.type === 'FALKORDB' ? 'falkordb' : 'bolt')
  const started = performance.now()
  const read = await readRows(connection, statement, parameters, limit, value => cells.cell(value))
  return { ...read, graph: cells.graph(), limit, milliseconds: Math.round(performance.now() - started) }
}

/** Refuses a connection the studio cannot run Cypher on, before anything is written for it. */
export function runsCypher(connection: Connection): void {
  if (RUNS_CYPHER.includes(connection.type)) return
  // The environment's DATABASE_TYPE is taken as it is, so it may name no type at all.
  const sql = connection.type === 'ORACLE' ? 'Oracle' : connection.type === 'POSTGRES' ? 'Postgres' : undefined
  throw new StatementError(
    `The studio runs Cypher on Neo4j, Memgraph, Neptune and FalkorDB. ${sql ? `On ${sql}, Drivine (TypeScript) runs SQL, not Cypher.` : `It does not know the database type ${connection.type}.`}`,
  )
}

/** Rows as a statement gave them back, each value as `read` takes it. */
export interface Rows<T> {
  columns: string[]
  rows: T[][]
  /** More rows came back than the limit, and the rest were not read. */
  truncated: boolean
}

/** Runs a statement as `run` does, and gives each value to `read` as the database's client gave it back. */
export async function readRows<T>(
  connection: Connection,
  statement: string,
  parameters: Record<string, unknown>,
  limit: number,
  read: (value: unknown) => T,
): Promise<Rows<T>> {
  runsCypher(connection)
  if (statement.trim() === '') throw new StatementError('There is no statement to run.')
  const provider = await providerFor(connection)
  return connection.type === 'FALKORDB'
    ? falkor(provider, statement, parameters, limit, read)
    : bolt(provider, statement, parameters, limit, read)
}

/**
 * Neo4j, Memgraph and Neptune: a session of the provider's own driver, rather than one of Drivine's connections,
 * which opens it to write and gives nodes back as their properties alone.
 */
async function bolt<T>(
  provider: ConnectionProvider,
  statement: string,
  parameters: Record<string, unknown>,
  limit: number,
  read: (value: unknown) => T,
): Promise<Rows<T>> {
  const { driver, database } = provider as unknown as { driver?: Driver; database?: string }
  if (!driver) throw new StatementError('This version of Drivine keeps its Bolt driver where the studio cannot find it.')
  const session = driver.session({ defaultAccessMode: neo4j.session.READ, ...(database ? { database } : {}) })
  const transaction = session.beginTransaction()
  try {
    const result = transaction.run(statement, boltParameters(parameters))
    const columns = [...(await result.keys())]
    const rows: T[][] = []
    let truncated = false
    for await (const record of result) {
      if (rows.length === limit) {
        truncated = true
        break
      }
      rows.push(columns.map((_, i) => read(record.get(i))))
    }
    return { columns, rows, truncated }
  } finally {
    await transaction.rollback().catch(() => undefined)
    await session.close().catch(() => undefined)
  }
}

/**
 * Parameters as Bolt takes them. JSON has one kind of number, and the driver sends every JavaScript number as a float,
 * which an integer property never equals: so a whole number goes as an integer. A value of the driver's own, a
 * temporal one, say, goes as it is.
 */
export function boltParameters(value: unknown): any {
  if (typeof value === 'number' && Number.isInteger(value)) return neo4j.int(value)
  if (Array.isArray(value)) return value.map(boltParameters)
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, boltParameters(v)]))
  }
  return value
}

interface FalkorGraph {
  roQuery(query: string, options?: { params?: Record<string, unknown> }): Promise<{ data?: Record<string, unknown>[] }>
}

/**
 * FalkorDB: its client's read-only query, which keeps the nodes it gives back. The client writes the parameters into
 * the statement as text, so they go as Drivine prepares them, which refuses a name that would change the statement.
 */
async function falkor<T>(
  provider: ConnectionProvider,
  statement: string,
  parameters: Record<string, unknown>,
  limit: number,
  read: (value: unknown) => T,
): Promise<Rows<T>> {
  let params: Record<string, unknown>
  try {
    params = new FalkorDbParameterCoercer().coerce(parameters)
  } catch (e) {
    throw new StatementError(e instanceof Error ? e.message : String(e))
  }
  const session = await provider.connect()
  try {
    const graph = (session as unknown as { graph: FalkorGraph }).graph
    const reply = await graph.roQuery(statement, Object.keys(params).length ? { params } : undefined).catch((e: unknown) => {
      throw refused(e, provider.graphName)
    })
    const data = reply.data ?? []
    const columns = data.length ? Object.keys(data[0]!) : []
    const rows = data.slice(0, limit).map(row => columns.map(column => read(row[column])))
    return { columns, rows, truncated: data.length > limit }
  } finally {
    await session.release().catch(() => undefined)
  }
}

/**
 * What FalkorDB said, as a StatementError when it turned the statement down: a refusal to write, a statement it
 * could not read, or a graph that is not there, which FalkorDB calls an empty key. Its client gives each as an
 * ErrorReply, which the studio does not import, so it is known by its class's name. Anything else is as it came.
 */
function refused(e: unknown, graphName: string | undefined): unknown {
  let reply = false
  for (let p = e instanceof Error ? Object.getPrototypeOf(e) : null; p && !reply; p = Object.getPrototypeOf(p)) {
    reply = p.constructor?.name === 'ErrorReply'
  }
  if (!reply) return e
  const { message } = e as Error
  if (/only on read-only queries/.test(message)) return new StatementError(`${READS_ONLY} ${message}`)
  if (/empty key/.test(message)) return new StatementError(`FalkorDB has no graph ${graphName ?? ''}, or nothing in it yet.`)
  return new StatementError(message)
}

/** Connects and runs the smallest read there is, to say whether the connection works. */
export async function check(connection: Connection): Promise<{ milliseconds: number }> {
  const result = await run(connection, 'RETURN 1 AS one', {}, 1)
  return { milliseconds: result.milliseconds }
}
