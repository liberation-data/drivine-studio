import {
  CursorSpecification, DatabaseRegistry, DatabaseType, DrivineError, FalkorDbParameterCoercer, OracleConnection,
  OracleResultMapper, QuerySpecification,
} from '@liberation-data/drivine'
import type { Connection as DrivineConnection, ConnectionProvider } from '@liberation-data/drivine'
import neo4j from 'neo4j-driver'
import type { Driver } from 'neo4j-driver'
import { DATABASE_NAMES, DEFAULT_LIMIT, READS_ONLY, RUNS_CYPHER } from '../studio/database'
import type { CypherResult } from '../studio/database'
import { ConnectionError } from './connections'
import type { Connection } from './connections'
import { compileWhole, readCypher, statementWrites } from './sqlCypher'
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

/**
 * Runs a statement and reads at most `limit` rows of what it gives back. The studio reads and never writes, so the
 * statement runs where what it does cannot last. Over Bolt, in a read session, whose transaction the database will
 * not let write, and which is rolled back all the same. On FalkorDB, which has no transactions, as a read-only query,
 * which FalkorDB will not let write. A procedure that opens transactions of its own, as some of APOC's do, is beyond
 * either: a user that may only read is the whole guarantee. On Postgres and Oracle, Drivine compiles the Cypher to
 * SQL: a statement that writes is refused before it is compiled, and the SQL runs in a read-only transaction, which
 * is rolled back all the same.
 */
export async function run(
  connection: Connection,
  statement: string,
  parameters: Record<string, unknown> = {},
  limit: number = DEFAULT_LIMIT,
): Promise<CypherResult> {
  const cells = new Cells(connection.type === 'FALKORDB' ? 'falkordb' : SQL_STORES.includes(connection.type) ? 'sql' : 'bolt')
  const started = performance.now()
  const read = await readRows(connection, statement, parameters, limit, value => cells.cell(value))
  return { ...read, graph: cells.graph(), limit, milliseconds: Math.round(performance.now() - started) }
}

/** The stores Drivine compiles Cypher to SQL on. */
export const SQL_STORES: readonly string[] = ['POSTGRES', 'ORACLE']

/** Refuses a connection the studio cannot run Cypher on, before anything is written for it. */
export function runsCypher(connection: Connection): void {
  if (RUNS_CYPHER.includes(connection.type)) return
  // The environment's DATABASE_TYPE is taken as it is, so it may name no type at all.
  throw new StatementError(
    `The studio does not know the database type ${connection.type}.`,
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
  if (connection.type === 'POSTGRES' || connection.type === 'ORACLE') {
    // Read, and refused if it writes, before anything is connected to.
    const query = sqlStatement(connection.type, statement)
    return sql(connection.type, await providerFor(connection), query, parameters, limit, read)
  }
  const provider = await providerFor(connection)
  return connection.type === 'FALKORDB'
    ? falkor(provider, statement, parameters, limit, read)
    : bolt(provider, statement, parameters, limit, read)
}

/** The statement, read as Cypher, and refused if it writes. */
function sqlStatement(type: 'POSTGRES' | 'ORACLE', statement: string): ReturnType<typeof readCypher> {
  let query: ReturnType<typeof readCypher>
  try {
    query = readCypher(statement)
  } catch (e) {
    throw new StatementError(e instanceof Error ? e.message : String(e))
  }
  if (statementWrites(query)) {
    throw new StatementError(
      `${READS_ONLY} On ${DATABASE_NAMES[type]}, a statement that writes (CREATE, MERGE, SET, REMOVE, DELETE or FOREACH) is not sent.`,
    )
  }
  return query
}

/**
 * Postgres and Oracle: the Cypher compiled to SQL over the graph's tables by Drivine's own compiler, as a
 * PersistenceManager compiles it, but with each node and relationship whole (see sqlCypher). It runs on one of Drivine's
 * connections, in a transaction made read-only before anything else runs in it, which is rolled back all the same,
 * and only as many rows as are wanted are read, through a cursor.
 */
async function sql<T>(
  type: 'POSTGRES' | 'ORACLE',
  provider: ConnectionProvider,
  query: ReturnType<typeof readCypher>,
  parameters: Record<string, unknown>,
  limit: number,
  read: (value: unknown) => T,
): Promise<Rows<T>> {
  const graph = provider.graphName ?? 'drivine'
  let compiled: ReturnType<typeof compileWhole>
  try {
    compiled = compileWhole(type, graph, query, parameters)
  } catch (e) {
    // Cypher the compiler does not take, which it names.
    if (e instanceof DrivineError) throw new StatementError(e.message)
    throw e
  }
  const session = type === 'ORACLE' ? await oracleSession(provider) : await provider.connect()
  try {
    await session.startTransaction()
    await session.query(new QuerySpecification().withStatement({ text: 'SET TRANSACTION READ ONLY', language: 'SQL' }))
    const cursor = await session.openCursor(
      new CursorSpecification<unknown>()
        .withStatement({ text: compiled.sql, language: 'SQL' })
        .bind(compiled.parameters)
        .batchSize(limit + 1),
    )
    const got: unknown[] = []
    try {
      // One more than the limit, in one batch, to know whether there were more.
      for await (const row of cursor) {
        got.push(row)
        if (got.length > limit) break
      }
    } finally {
      await cursor.close().catch(() => undefined)
    }
    // Postgres gives the row, of its one column; Oracle's mapper gives that column's value.
    const values = got.map(row => (type === 'POSTGRES' ? (row as { result: unknown }).result : row) as unknown[])
    const rows = values.slice(0, limit).map(items => items.map(item => read(item)))
    return { columns: compiled.columns, rows, truncated: got.length > limit }
  } catch (e) {
    throw sqlRefused(e, type, graph)
  } finally {
    await session.rollbackTransaction().catch(() => undefined)
    await session.release().catch(() => undefined)
  }
}

/**
 * A connection from the Oracle provider's own pool. Drivine's provider makes the graph's tables on its first
 * connection, where they are not there, and the studio never writes: so it takes the pool's connection itself.
 */
async function oracleSession(provider: ConnectionProvider): Promise<DrivineConnection> {
  const pool = (provider as unknown as { poolOf?: () => Promise<{ getConnection(): Promise<unknown> }> }).poolOf
  if (!pool) throw new StatementError('This version of Drivine keeps its Oracle pool where the studio cannot find it.')
  const connection = await (await pool.call(provider)).getConnection()
  return new OracleConnection(connection as never, new OracleResultMapper(), 'drivine-studio', provider.graphName)
}

/** Oracle's errors of a value the statement could not take: ORA-01476, ORA-01722, and the regular expression's. */
const ORACLE_DATA_ERRORS = [1476, 1722, 12722, 12725, 12726, 12727, 12728, 12729, 12730, 12731, 12732, 12733]

/**
 * What Postgres or Oracle said, as a StatementError where it is the person's to fix: a refusal to write, a graph whose
 * tables are not there, or a value the statement could not take. Anything else is as it came.
 */
function sqlRefused(e: unknown, type: 'POSTGRES' | 'ORACLE', graph: string): unknown {
  if (e instanceof StatementError || !(e instanceof Error)) return e
  const code = String((e as { code?: unknown }).code ?? '')
  const oracle = (e as { errorNum?: unknown }).errorNum
  // Postgres's read_only_sql_transaction; Oracle's ORA-01456, a write in a READ ONLY transaction.
  if (code === '25006' || oracle === 1456) return new StatementError(`${READS_ONLY} ${e.message}`)
  // Postgres's undefined_table; Oracle's ORA-00942, a table or view that does not exist.
  if (code === '42P01' || oracle === 942) {
    return new StatementError(`${DATABASE_NAMES[type]} has no graph ${graph} here: the tables ${graph}_node and ${graph}_edge are not there. (${e.message})`)
  }
  // Postgres's data exceptions: a value the statement could not take, as a regular expression that is not one.
  if (type === 'POSTGRES' && code.startsWith('22')) return new StatementError(e.message)
  // Oracle's, as it numbers them: a division by zero, a text that is not a number, a regular expression that is not one.
  if (typeof oracle === 'number' && ORACLE_DATA_ERRORS.includes(oracle)) return new StatementError(e.message)
  return e
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

/**
 * Connects and runs the smallest read there is, to say whether the connection works. On Postgres and Oracle, one that
 * reads the graph's nodes, so a graph whose tables are not there is said not to be.
 */
export async function check(connection: Connection): Promise<{ milliseconds: number }> {
  const statement = SQL_STORES.includes(connection.type) ? 'MATCH (n) RETURN 1 AS one LIMIT 1' : 'RETURN 1 AS one'
  const result = await run(connection, statement, {}, 1)
  return { milliseconds: result.milliseconds }
}
