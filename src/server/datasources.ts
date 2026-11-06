import {
  CursorSpecification, DatabaseRegistry, DatabaseType, DEFAULT_BUSY_TIMEOUT_MILLIS, DrivineError, FalkorDbParameterCoercer,
  OracleConnection, OracleResultMapper, PostgresResultMapper, QuerySpecification, SqliteConnection, SqliteFunctions,
} from '@liberation-data/drivine'
import type { Connection as DrivineConnection, ConnectionProvider, SqliteConnectionProvider } from '@liberation-data/drivine'
import { JSON_ROWS } from '@liberation-data/drivine/backend/sqlite/SqliteGraph.js'
import neo4j from 'neo4j-driver'
import { statSync } from 'node:fs'
import type { Driver } from 'neo4j-driver'
import { CHANGES, DATABASE_NAMES, DEFAULT_LIMIT, READS_ONLY, RUNS_CYPHER } from '../studio/database'
import type { Change, CypherResult } from '../studio/database'
import { ConnectionError, sqlitePath } from './connections'
import type { Connection } from './connections'
import { compilerFor, compileWhole, readCypher, returnedNames, statementWrites } from './sqlCypher'
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

export async function providerFor(connection: Connection): Promise<ConnectionProvider> {
  // Whether it allows writes is the studio's, not the provider's: a change to it keeps the provider.
  const { allowWrites: _, ...connects } = connection
  const settings = JSON.stringify(connects)
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
  // A SQLite file's path as it is checked when saved: the environment's is not, and is checked here.
  if (connection.database) builder.databaseName(connection.type === 'SQLITE' ? sqlitePath(connection.database) : connection.database)
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
 * The graph the statement is for is not there yet: no tables on Postgres, Oracle or SQLite, nothing written on
 * FalkorDB.
 */
export class NoGraphError extends StatementError {}

/** How a statement is run. */
export interface RunOptions {
  /**
   * The statement may write, and what it does is committed: only the Cypher window asks for this, and only on a
   * connection that allows writes. Off, it runs where it cannot write.
   */
  writes?: boolean
}

/**
 * Runs a statement and reads at most `limit` rows of what it gives back. Unless told it `writes`, the studio reads and
 * never writes, so the statement runs where what it does cannot last. Over Bolt, in a read session, whose transaction
 * the database will not let write, and which is rolled back all the same. On FalkorDB, which has no transactions, as
 * a read-only query, which FalkorDB will not let write. A procedure that opens transactions of its own, as some of
 * APOC's do, is beyond either: a user that may only read is the whole guarantee. On Postgres, Oracle and SQLite,
 * Drivine compiles the Cypher to SQL: a statement that writes is refused before it is compiled, and the SQL runs in a
 * read-only transaction, which is rolled back all the same, or on SQLite on the file opened read-only.
 *
 * Told it `writes`, it runs in a transaction that may write, which is committed: a write session over Bolt,
 * FalkorDB's query that may write, and on Postgres, Oracle and SQLite a statement that writes as Drivine compiles and
 * runs it. What it changed is `written`.
 */
export async function run(
  connection: Connection,
  statement: string,
  parameters: Record<string, unknown> = {},
  limit: number = DEFAULT_LIMIT,
  options: RunOptions = {},
): Promise<CypherResult> {
  const cells = new Cells(connection.type === 'FALKORDB' ? 'falkordb' : SQL_STORES.includes(connection.type) ? 'sql' : 'bolt')
  const started = performance.now()
  const read = await readRows(connection, statement, parameters, limit, value => cells.cell(value), options)
  return { ...read, graph: cells.graph(), limit, milliseconds: Math.round(performance.now() - started) }
}

/** What a statement run where it may write changed: see CypherResult. */
export type Written = NonNullable<CypherResult['written']>

/** The stores Drivine compiles Cypher to SQL on. */
export const SQL_STORES: readonly string[] = ['POSTGRES', 'ORACLE', 'SQLITE']

/** A store Drivine compiles Cypher to SQL on: see SQL_STORES. */
export type SqlStore = 'POSTGRES' | 'ORACLE' | 'SQLITE'

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
  /** Given only where the statement ran where it may write, and was committed: what it changed. */
  written?: Written
}

/** Runs a statement as `run` does, and gives each value to `read` as the database's client gave it back. */
export async function readRows<T>(
  connection: Connection,
  statement: string,
  parameters: Record<string, unknown>,
  limit: number,
  read: (value: unknown) => T,
  { writes = false }: RunOptions = {},
): Promise<Rows<T>> {
  runsCypher(connection)
  if (statement.trim() === '') throw new StatementError('There is no statement to run.')
  if (connection.type === 'POSTGRES' || connection.type === 'ORACLE' || connection.type === 'SQLITE') {
    // Read, and refused if it writes where it may not, before anything is connected to.
    const query = sqlStatement(connection.type, statement, writes)
    const provider = await providerFor(connection)
    // A statement that only reads is compiled whole and run read-only, as ever: there is nothing of it to commit.
    return writes && statementWrites(query)
      ? sqlWrite(connection.type, provider, query, statement, parameters, limit, read)
      : sql(connection.type, provider, query, parameters, limit, read)
  }
  const provider = await providerFor(connection)
  return connection.type === 'FALKORDB'
    ? falkor(provider, statement, parameters, limit, read, writes)
    : bolt(provider, statement, parameters, limit, read, writes)
}

/** The statement, read as Cypher, and refused if it writes where it may not. */
function sqlStatement(type: SqlStore, statement: string, writes: boolean): ReturnType<typeof readCypher> {
  let query: ReturnType<typeof readCypher>
  try {
    query = readCypher(statement)
  } catch (e) {
    throw new StatementError(e instanceof Error ? e.message : String(e))
  }
  if (!writes && statementWrites(query)) {
    throw new StatementError(
      `${READS_ONLY} On ${DATABASE_NAMES[type]}, a statement that writes (CREATE, MERGE, SET, REMOVE, DELETE or FOREACH) is not sent.`,
    )
  }
  return query
}

/**
 * Postgres, Oracle and SQLite: the Cypher compiled to SQL over the graph's tables by Drivine's own compiler, as a
 * PersistenceManager compiles it, but with each node and relationship whole (see sqlCypher). It runs on one of
 * Drivine's connections, in a transaction made read-only before anything else runs in it, which is rolled back all the
 * same, or on SQLite on the file opened read-only (see readOnly), and only as many rows as are wanted are read,
 * through a cursor.
 */
async function sql<T>(
  type: SqlStore,
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
  const session = await sqlSession(type, provider)
  try {
    await readOnly(type, session)
    const cursor = await session.openCursor(
      new CursorSpecification<unknown>()
        // SQLite gives a JSON value as its text, which Drivine's connection reads as JSON where the statement says so.
        .withStatement({ text: type === 'SQLITE' ? `${JSON_ROWS}\n${compiled.sql}` : compiled.sql, language: 'SQL' })
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
    // Postgres and SQLite give the row, of its one column; Oracle's mapper gives that column's value.
    const values = got.map(row => (type === 'ORACLE' ? row : (row as { result: unknown }).result) as unknown[])
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
 * Postgres, Oracle and SQLite, on a connection that allows writes: a statement that writes runs as Drivine compiles and
 * runs it, as a PersistenceManager does, in a transaction that is committed. What it returns is as Drivine gives it
 * back, a node as its properties alone, and each row's values are named by its `RETURN`'s items. Drivine gives back
 * every row, with no cursor, so all of them are held before the rows past `limit` are left out. Drivine says nothing
 * of what was changed, so `written` has no counts.
 */
async function sqlWrite<T>(
  type: SqlStore,
  provider: ConnectionProvider,
  query: ReturnType<typeof readCypher>,
  statement: string,
  parameters: Record<string, unknown>,
  limit: number,
  read: (value: unknown) => T,
): Promise<Rows<T>> {
  const graph = provider.graphName ?? 'drivine'
  try {
    // Compiled first, so Cypher the compiler does not take is said to be, before anything is connected to.
    compilerFor(type, graph).compileQuery(query, parameters)
  } catch (e) {
    if (e instanceof DrivineError) throw new StatementError(e.message)
    throw e
  }
  const columns = returnedNames(query)
  const session = await sqlSession(type, provider, true)
  let committed = false
  try {
    await session.startTransaction()
    const got = await session.query<unknown>(
      new QuerySpecification<unknown>().withStatement({ text: statement, language: 'CYPHER' }).bind(parameters),
    )
    await session.commitTransaction()
    committed = true
    // Drivine gives a row of one item as its value, and of more as a list of them.
    const rows = got.slice(0, limit).map(value => (columns.length > 1 && Array.isArray(value) ? value : [value]).map(item => read(item)))
    return { columns, rows, truncated: got.length > limit, written: { counts: null } }
  } catch (e) {
    throw sqlRefused(e, type, graph, true)
  } finally {
    if (!committed) await session.rollbackTransaction().catch(() => undefined)
    await session.release().catch(() => undefined)
  }
}

/**
 * Postgres, Oracle and SQLite: SQL of the studio's own, not Cypher, run as `sql` runs a compiled statement, read-only
 * (see readOnly) and rolled back all the same. For reading what a graph's tables hold, as the editor's completion does
 * (see schema). Each row as Drivine's result mapper gives it back.
 */
export async function readSql(connection: Connection, text: string): Promise<unknown[]> {
  const type = connection.type
  if (type !== 'POSTGRES' && type !== 'ORACLE' && type !== 'SQLITE') throw new StatementError(`${DATABASE_NAMES[type] ?? type} doesn't take SQL.`)
  const provider = await providerFor(connection)
  const session = await sqlSession(type, provider)
  try {
    await readOnly(type, session)
    return await session.query<unknown>(new QuerySpecification<unknown>().withStatement({ text, language: 'SQL' }))
  } catch (e) {
    throw sqlRefused(e, type, provider.graphName ?? 'drivine')
  } finally {
    await session.rollbackTransaction().catch(() => undefined)
    await session.release().catch(() => undefined)
  }
}

/**
 * One of Drivine's connections for Postgres, one on the Oracle provider's own pool (see oracleSession), or one to the
 * SQLite file, opened to write only where the statement `writes` (see sqliteSession).
 */
const sqlSession = (type: SqlStore, provider: ConnectionProvider, writes = false): Promise<DrivineConnection> =>
  type === 'ORACLE' ? oracleSession(provider) : type === 'SQLITE' ? sqliteSession(provider, writes) : provider.connect()

/**
 * Makes what runs next on the session read-only. On Postgres and Oracle, a transaction made read-only before anything
 * else runs in it, which the caller rolls back. On SQLite the file is opened read-only, which SQLite holds to whatever
 * the statement does; a transaction there would take the file's write lock as it began (`BEGIN IMMEDIATE`), and so
 * hold up the application writing to it, for a read.
 */
async function readOnly(type: SqlStore, session: DrivineConnection): Promise<void> {
  if (type === 'SQLITE') return
  await session.startTransaction()
  await session.query(new QuerySpecification().withStatement({ text: 'SET TRANSACTION READ ONLY', language: 'SQL' }))
}

/**
 * A connection from the Oracle provider's own pool. Drivine's provider makes the graph's tables on its first
 * connection, where they are not there, and the studio never makes them, even on a connection that allows writes: so
 * it takes the pool's connection itself.
 */
async function oracleSession(provider: ConnectionProvider): Promise<DrivineConnection> {
  const pool = (provider as unknown as { poolOf?: () => Promise<{ getConnection(): Promise<unknown> }> }).poolOf
  if (!pool) throw new StatementError('This version of Drivine keeps its Oracle pool where the studio cannot find it.')
  const connection = await (await pool.call(provider)).getConnection()
  return new OracleConnection(connection as never, new OracleResultMapper(), 'drivine-studio', provider.graphName)
}

/**
 * A connection to the SQLite file, opened by the studio rather than Drivine's provider. Drivine makes the file where
 * it is not there, and the graph's tables on its first connection, and the studio makes neither, even on a connection
 * that allows writes: so a path with no file is refused, and a file without the graph's node table is said not to hold
 * the graph, before anything is opened that could write. That is asked of the file opened read-only, and a statement
 * that only reads runs there too: SQLite refuses it any write. One that `writes` gets the file opened as Drivine's
 * provider opens it, with foreign keys enforced, so a node's relationships go with it, and with Drivine's functions,
 * which its statements call, registered on either.
 */
async function sqliteSession(provider: ConnectionProvider, writes: boolean): Promise<DrivineConnection> {
  const path = sqliteFile(provider)
  const graph = provider.graphName ?? 'drivine'
  // Loaded only here, as Drivine loads it, so a studio that reads no SQLite file never loads it, nor is warned of it.
  const { DatabaseSync } = await import('node:sqlite')
  let db = new DatabaseSync(path, { readOnly: true })
  try {
    const nodes = `${graph}_node`
    const there = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND lower(name) = lower(?)").get(nodes)
    if (!there) {
      throw new NoGraphError(`SQLite has no graph ${graph} in ${path}: the table ${nodes} is not there. The studio never makes it.`)
    }
    if (writes) {
      db.close()
      db = new DatabaseSync(path)
      db.exec('PRAGMA foreign_keys = ON')
    }
    // Drivine's connection waits for a locked file itself, by trying again, so that the process is not held up.
    db.exec('PRAGMA busy_timeout = 0')
    // node:sqlite's own types are stricter than Drivine's account of them, of a function's result.
    SqliteFunctions.register(db as never)
  } catch (e) {
    if (db.isOpen) db.close()
    throw sqlRefused(e, 'SQLITE', graph, writes)
  }
  return new SqliteConnection(db as never, new PostgresResultMapper(), DEFAULT_BUSY_TIMEOUT_MILLIS, it => it.close(), graph)
}

/**
 * The path of the SQLite provider's file, refused where there is no file there: Drivine would make one, and the
 * studio never does.
 */
export function sqliteFile(provider: ConnectionProvider): string {
  const { path } = provider as SqliteConnectionProvider
  let file: boolean
  try {
    file = statSync(path).isFile()
  } catch {
    throw new ConnectionError(`There is no SQLite file at ${path}. The studio reads a file an application using Drivine made, and never makes one.`)
  }
  if (!file) throw new ConnectionError(`${path} is not a file. Give the path of the SQLite file the graph is kept in.`)
  return path
}

/** Oracle's errors of a value the statement could not take: ORA-01476, ORA-01722, and the regular expression's. */
const ORACLE_DATA_ERRORS = [1476, 1722, 12722, 12725, 12726, 12727, 12728, 12729, 12730, 12731, 12732, 12733]

/**
 * What Postgres, Oracle or SQLite said, as a StatementError where it is the person's to fix: a refusal to write, a
 * graph whose tables are not there, or a value the statement could not take. Anything else is as it came. Where the
 * statement `writes`, a refusal to write is the database's, as a standby's or a read-only user's is, so it is not said
 * to be the studio's.
 */
function sqlRefused(e: unknown, type: SqlStore, graph: string, writes = false): unknown {
  if (e instanceof StatementError || !(e instanceof Error)) return e
  const code = String((e as { code?: unknown }).code ?? '')
  const oracle = (e as { errorNum?: unknown }).errorNum
  // SQLite's own result code, which node:sqlite gives with its ERR_SQLITE_ERROR.
  const sqlite = type === 'SQLITE' ? (e as { errcode?: unknown }).errcode : undefined
  // Postgres's read_only_sql_transaction; Oracle's ORA-01456, a write in a READ ONLY transaction; SQLite's
  // SQLITE_READONLY, a write to a file opened read-only.
  if (code === '25006' || oracle === 1456 || sqlite === 8) return new StatementError(writes ? e.message : `${READS_ONLY} ${e.message}`)
  // Postgres's undefined_table; Oracle's ORA-00942, a table or view that does not exist; SQLite's, said in words alone.
  if (code === '42P01' || oracle === 942 || (sqlite === 1 && /^no such table/.test(e.message))) {
    return new NoGraphError(`${DATABASE_NAMES[type]} has no graph ${graph} here: the tables ${graph}_node and ${graph}_edge are not there. (${e.message})`)
  }
  // Postgres's data exceptions: a value the statement could not take, as a regular expression that is not one.
  if (type === 'POSTGRES' && code.startsWith('22')) return new StatementError(e.message)
  // Oracle's, as it numbers them: a division by zero, a text that is not a number, a regular expression that is not one.
  if (typeof oracle === 'number' && ORACLE_DATA_ERRORS.includes(oracle)) return new StatementError(e.message)
  // SQLite's SQLITE_NOTADB: the file is something else.
  if (sqlite === 26) return new StatementError(`That file is not a SQLite database. (${e.message})`)
  // What one of Drivine's functions on SQLite threw for a value it could not take, as a regular expression that is
  // not one: node:sqlite gives it as it was thrown, with no code of SQLite's.
  if (type === 'SQLITE' && code !== 'ERR_SQLITE_ERROR') return new StatementError(e.message)
  return e
}

/**
 * Neo4j, Memgraph and Neptune: a session of the provider's own driver, rather than one of Drivine's connections,
 * which opens it to write and gives nodes back as their properties alone. Where the statement may write, a write
 * session, whose transaction is committed, and what the database counts it changed.
 */
async function bolt<T>(
  provider: ConnectionProvider,
  statement: string,
  parameters: Record<string, unknown>,
  limit: number,
  read: (value: unknown) => T,
  writes: boolean,
): Promise<Rows<T>> {
  const { driver, database } = provider as unknown as { driver?: Driver; database?: string }
  if (!driver) throw new StatementError('This version of Drivine keeps its Bolt driver where the studio cannot find it.')
  const mode = writes ? neo4j.session.WRITE : neo4j.session.READ
  const session = driver.session({ defaultAccessMode: mode, ...(database ? { database } : {}) })
  const transaction = session.beginTransaction()
  let committed = false
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
    if (!writes) return { columns, rows, truncated }
    // The statement runs to its end, past the rows not read, before it is committed.
    const { counters } = await result.summary()
    await transaction.commit()
    committed = true
    const updates = counters.updates() as Partial<Record<Change, number>>
    const counts = Object.fromEntries(CHANGES.map(change => [change, Number(updates[change] ?? 0)]))
    return { columns, rows, truncated, written: { counts } }
  } finally {
    if (!committed) await transaction.rollback().catch(() => undefined)
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

type FalkorQuery = (query: string, options?: { params?: Record<string, unknown> }) => Promise<FalkorReply>
interface FalkorReply {
  data?: Record<string, unknown>[]
  /** What FalkorDB says of the query, each a line: `Nodes created: 1`, and its time. */
  metadata?: string[]
}
interface FalkorGraph {
  query: FalkorQuery
  roQuery: FalkorQuery
}

/** FalkorDB's names for what a query changed, in the lines it says them in. It leaves out what is none. */
const FALKOR_CHANGES: Record<string, Change> = {
  'Nodes created': 'nodesCreated',
  'Nodes deleted': 'nodesDeleted',
  'Relationships created': 'relationshipsCreated',
  'Relationships deleted': 'relationshipsDeleted',
  'Properties set': 'propertiesSet',
  'Labels added': 'labelsAdded',
  'Labels removed': 'labelsRemoved',
}

/** What FalkorDB's lines of a query say it changed. */
export function falkorCounts(metadata: readonly string[]): Partial<Record<Change, number>> {
  const counts: Partial<Record<Change, number>> = {}
  for (const line of metadata) {
    const [, name, count] = /^([^:]+):\s*(\d+)/.exec(line) ?? []
    const change = name ? FALKOR_CHANGES[name.trim()] : undefined
    if (change) counts[change] = Number(count)
  }
  return counts
}

/**
 * FalkorDB: its client's read-only query, which keeps the nodes it gives back, or, where the statement may write, its
 * query that may, and what FalkorDB says it changed. FalkorDB has no transactions: what a write does, it has done.
 * The client writes the parameters into the statement as text, so they go as Drivine prepares them, which refuses a
 * name that would change the statement.
 */
async function falkor<T>(
  provider: ConnectionProvider,
  statement: string,
  parameters: Record<string, unknown>,
  limit: number,
  read: (value: unknown) => T,
  writes: boolean,
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
    const options = Object.keys(params).length ? { params } : undefined
    const reply = await (writes ? graph.query(statement, options) : graph.roQuery(statement, options)).catch((e: unknown) => {
      throw refused(e, provider.graphName)
    })
    const data = reply.data ?? []
    const columns = data.length ? Object.keys(data[0]!) : []
    const rows = data.slice(0, limit).map(row => columns.map(column => read(row[column])))
    const got = { columns, rows, truncated: data.length > limit }
    return writes ? { ...got, written: { counts: falkorCounts(reply.metadata ?? []) } } : got
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
  if (/empty key/.test(message)) return new NoGraphError(`FalkorDB has no graph ${graphName ?? ''}, or nothing in it yet.`)
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

/** How many relationships connecting a result's nodes are drawn at most, as Neo4j Browser caps its own. */
export const CONNECT_UP_TO = 1000

/**
 * The relationships among a result's nodes, as Neo4j Browser draws them beside what a query gave back ("Connect result
 * nodes"): one more read, never a write. Each store knows its nodes by its own id: Neo4j by elementId, the others by
 * id(), as a number but on Neptune.
 */
export function connecting(type: Connection['type'], ids: readonly string[]): { statement: string; parameters: Record<string, unknown> } {
  const byElement = type === 'NEO4J'
  const numeric = !byElement && type !== 'NEPTUNE'
  const of = (v: string) => (byElement ? `elementId(${v})` : `id(${v})`)
  const given = numeric ? ids.map(Number).filter(Number.isFinite) : [...ids]
  return {
    statement: `MATCH (a)-[r]->(b) WHERE ${of('a')} IN $ids AND ${of('b')} IN $ids RETURN r`,
    parameters: { ids: given },
  }
}

export async function connect(connection: Connection, ids: readonly string[]): Promise<{ relationships: CypherResult['graph']['relationships']; truncated: boolean }> {
  if (ids.length < 2) return { relationships: [], truncated: false }
  const { statement, parameters } = connecting(connection.type, ids)
  const result = await run(connection, statement, parameters, CONNECT_UP_TO)
  return { relationships: result.graph.relationships, truncated: result.truncated }
}
