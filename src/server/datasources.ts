import { DatabaseRegistry, DatabaseType } from '@liberation-data/drivine'
import type { ConnectionProvider } from '@liberation-data/drivine'
import neo4j from 'neo4j-driver'
import type { Driver } from 'neo4j-driver'
import type { CypherResult } from '../studio/database'
import type { Connection } from './connections'
import { Cells } from './values'

/**
 * Drivine's connection provider for each of the studio's connections, built when first used. A connection that has
 * changed since gets a new one, and the old one is closed. Each is registered under its own name in Drivine's
 * registry, since a name, once there, keeps the provider it was first given.
 */
const providers = new Map<string, { settings: string; provider: ConnectionProvider }>()
let built = 0

async function providerFor(connection: Connection): Promise<ConnectionProvider> {
  const settings = JSON.stringify(connection)
  const known = providers.get(connection.id)
  if (known?.settings === settings) return known.provider
  if (known) {
    providers.delete(connection.id)
    await known.provider.end().catch(() => undefined)
  }
  const builder = DatabaseRegistry.getInstance().builder().withType(connection.type as DatabaseType).host(connection.host)
  if (connection.port) builder.port(connection.port)
  if (connection.user) builder.userName(connection.user)
  if (connection.password) builder.password(connection.password)
  if (connection.database) builder.databaseName(connection.database)
  if (connection.graph) builder.defaultGraphPath(connection.graph)
  const provider = builder.register(`studio-${connection.id}-${++built}`)
  providers.set(connection.id, { settings, provider })
  return provider
}

/** Closes the provider of a connection that was removed. */
export async function forget(id: string): Promise<void> {
  const known = providers.get(id)
  providers.delete(id)
  await known?.provider.end().catch(() => undefined)
}

export class StatementError extends Error {}

export const DEFAULT_LIMIT = 1000
export const MAX_LIMIT = 10000

/** The databases the studio runs Cypher on. Drivine (TypeScript) runs SQL on Oracle and Postgres, not Cypher. */
const RUNS_CYPHER: readonly string[] = ['NEO4J', 'MEMGRAPH', 'NEPTUNE', 'FALKORDB']

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
  if (!RUNS_CYPHER.includes(connection.type)) {
    throw new StatementError(
      `The studio runs Cypher on Neo4j, Memgraph, Neptune and FalkorDB. On ${connection.type === 'ORACLE' ? 'Oracle' : 'Postgres'}, Drivine (TypeScript) runs SQL, not Cypher.`,
    )
  }
  if (statement.trim() === '') throw new StatementError('There is no statement to run.')
  const provider = await providerFor(connection)
  const started = performance.now()
  const read = connection.type === 'FALKORDB' ? await falkor(provider, statement, parameters, limit) : await bolt(provider, statement, parameters, limit)
  return { ...read, limit, milliseconds: Math.round(performance.now() - started) }
}

type Rows = Pick<CypherResult, 'columns' | 'rows' | 'graph' | 'truncated'>

/**
 * Neo4j, Memgraph and Neptune: a session of the provider's own driver, rather than one of Drivine's connections,
 * which opens it to write and gives nodes back as their properties alone.
 */
async function bolt(provider: ConnectionProvider, statement: string, parameters: Record<string, unknown>, limit: number): Promise<Rows> {
  const { driver, database } = provider as unknown as { driver?: Driver; database?: string }
  if (!driver) throw new StatementError('This version of Drivine keeps its Bolt driver where the studio cannot find it.')
  const session = driver.session({ defaultAccessMode: neo4j.session.READ, ...(database ? { database } : {}) })
  const transaction = session.beginTransaction()
  try {
    const result = transaction.run(statement, boltParameters(parameters))
    const columns = [...(await result.keys())]
    const cells = new Cells('bolt')
    const rows = []
    let truncated = false
    for await (const record of result) {
      if (rows.length === limit) {
        truncated = true
        break
      }
      rows.push(columns.map((_, i) => cells.cell(record.get(i))))
    }
    return { columns, rows, graph: cells.graph(), truncated }
  } finally {
    await transaction.rollback().catch(() => undefined)
    await session.close().catch(() => undefined)
  }
}

/**
 * Parameters as Bolt takes them. JSON has one kind of number, and the driver sends every JavaScript number as a float,
 * which an integer property never equals: so a whole number goes as an integer.
 */
export function boltParameters(value: unknown): any {
  if (typeof value === 'number' && Number.isInteger(value)) return neo4j.int(value)
  if (Array.isArray(value)) return value.map(boltParameters)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, boltParameters(v)]))
  }
  return value
}

interface FalkorGraph {
  roQuery(query: string, options?: { params?: Record<string, unknown> }): Promise<{ data?: Record<string, unknown>[] }>
}

/** FalkorDB: its client's read-only query, which keeps the nodes it gives back. */
async function falkor(provider: ConnectionProvider, statement: string, parameters: Record<string, unknown>, limit: number): Promise<Rows> {
  const session = await provider.connect()
  try {
    const graph = (session as unknown as { graph: FalkorGraph }).graph
    const reply = await graph.roQuery(statement, Object.keys(parameters).length ? { params: parameters } : undefined)
    const data = reply.data ?? []
    const columns = data.length ? Object.keys(data[0]!) : []
    const cells = new Cells('falkordb')
    const rows = data.slice(0, limit).map(row => columns.map(column => cells.cell(row[column])))
    return { columns, rows, graph: cells.graph(), truncated: data.length > limit }
  } finally {
    await session.release().catch(() => undefined)
  }
}

/** Connects and runs the smallest read there is, to say whether the connection works. */
export async function check(connection: Connection): Promise<{ milliseconds: number }> {
  const result = await run(connection, 'RETURN 1 AS one', {}, 1)
  return { milliseconds: result.milliseconds }
}
