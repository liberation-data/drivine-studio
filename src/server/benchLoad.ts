import {
  DatabaseRegistry, GraphObjectManagerFactory, PersistenceManagerFactory, PostgresGraph, QuerySpecification, rangeIndex,
  uniquenessConstraint,
} from '@liberation-data/drivine'

import { BenchError } from './bench'
import type { EngineResults } from './bench'
import { Dataset, LABELS, Scale, SCALES } from './benchData'
import type { EdgeSet, Label } from './benchData'
import { findConnection } from './connections'
import type { Connection } from './connections'
import { NoGraphError, providerFor, readRows, run, SQL_STORES } from './datasources'
import { readHomeFile, serially, writeHomeFile } from './home'

/*
 * Graph Bench's dataset, loaded into a connection, so its own workloads and anyone's saved queries can be timed on the
 * same graph in each store. Made here as Graph Bench makes it (see benchData), it is written as an application would
 * write it, by Drivine: each label's id indexed, as unique where the store can afford it, then the nodes and the
 * relationships in batches of rows, with UNWIND. Graph Bench itself loads Postgres and Oracle with their bulk paths,
 * which are quicker: these load times say what Cypher through Drivine costs, not what the store can do at best.
 *
 * On Postgres and Oracle the relationships take time in nodes × relationships for now: a node matched by `{id: row.s}`
 * doesn't use the id's index there, so each row reads its label (liberation-data/drivine#636). Past a small scale, a
 * load there is long.
 *
 * It writes, so only on a connection that allows writes, and only into a graph without Graph Bench's data already.
 *
 * Not into SQLite yet: there, Drivine 3.5.1 matches a relationship's two ends in time that grows faster than the square
 * of the nodes, and holds gigabytes doing it, so at the smallest scale the relationships would take hours.
 */

export type Load = NonNullable<EngineResults['load']>

/** What was loaded into a connection, kept so that a bench run there can say so. */
export interface Loaded {
  scale: number
  load: Load
  at: string
}

/** A load into one connection: waiting its turn, going, or over. */
export interface LoadJob {
  connection: string
  name: string
  type: string
  state: 'waiting' | 'running' | 'done' | 'failed'
  /** Nodes and relationships written so far, and about how many there will be. */
  done: number
  total: number
  now: string
  error?: string
  loaded?: Loaded
}

/** One scale loaded into each of the connections chosen, one after another, so that no load's time is another's. */
export interface LoadBatch {
  id: string
  scale: number
  state: 'running' | 'done'
  loads: LoadJob[]
}

/** The scales a load takes: any from the smallest offered to the largest. */
export const SMALLEST = SCALES[0]
export const LARGEST = SCALES[SCALES.length - 1]!

const LOADS = 'bench-loads.json'

const batches_: Map<string, LoadBatch> = ((globalThis as { __studioBenchLoads?: Map<string, LoadBatch> }).__studioBenchLoads ??= new Map())

export function validateLoad(input: unknown): { connections: string[]; scale: number } {
  const given = (input ?? {}) as Record<string, unknown>
  const connections = Array.isArray(given.connections) ? [...new Set(given.connections.filter((c): c is string => typeof c === 'string' && !!c))] : []
  if (!connections.length) throw new BenchError('Choose a connection to load.')
  const scale = Number(given.scale)
  if (!Number.isFinite(scale) || scale < SMALLEST || scale > LARGEST) throw new BenchError(`A scale is from ${SMALLEST} to ${LARGEST}.`)
  return { connections, scale }
}

/** What has been loaded into each connection, by its id. */
export async function loadedInto(): Promise<Record<string, Loaded>> {
  return (await readHomeFile<Record<string, Loaded>>(LOADS)) ?? {}
}

const remember = (id: string, loaded: Loaded) => serially(async () => {
  await writeHomeFile(LOADS, { ...(await loadedInto()), [id]: loaded })
})

export function loadBatch(id: string): LoadBatch | undefined {
  return batches_.get(id)
}

/** Starts a load; it goes on in the background, and its batch says how far each connection has got. */
export async function startLoad(input: { connections: string[]; scale: number }): Promise<LoadBatch> {
  return beginLoad(await Promise.all(input.connections.map(findConnection)), input.scale)
}

const loading = (id: string) => [...batches_.values()].some(b => b.loads.some(l => l.connection === id && (l.state === 'running' || l.state === 'waiting')))

const refuseWrites = (connection: Connection) =>
  new BenchError(`${connection.name} doesn't allow writes. Allow them in its settings to load Graph Bench's data there.`)
const refuseLoading = (connection: Connection) => new BenchError(`${connection.name} is being loaded already.`)
const refuseSqlite = (connection: Connection) =>
  new BenchError(`${connection.name} is a SQLite file, which Graph Bench's data isn't loaded into yet: its relationships would take hours.`)

/**
 * Starts a load into each connection given, once each is found able to take it: else none is started. Each is read
 * again by `latest` when its turn comes, since a batch can wait hours: one taken off writes, or removed, meanwhile is
 * not written to.
 */
export async function beginLoad(
  connections: Connection[],
  scale: number,
  latest: (connection: Connection) => Promise<Connection> = c => findConnection(c.id),
): Promise<LoadBatch> {
  for (const connection of connections) {
    if (connection.type === 'SQLITE') throw refuseSqlite(connection)
    if (!connection.allowWrites) throw refuseWrites(connection)
    if (loading(connection.id)) throw refuseLoading(connection)
    // A graph not there yet is empty: the load makes it. The label written first is looked for, so that a load that
    // stopped partway is not loaded again on top: FalkorDB's ids are not unique, so nothing else would stop it.
    const there = await readRows(connection, `MATCH (n:${LABELS[0]}) RETURN count(n) AS c`, {}, 1, value => Number(value)).catch((e: unknown) => {
      if (e instanceof NoGraphError) return { rows: [[0]] }
      throw e
    })
    if (Number(there.rows[0]?.[0] ?? 0) > 0) throw new BenchError(`${connection.name} has Graph Bench's data already, or some of it, or nodes labelled ${LABELS[0]}. Load into an empty graph.`)
  }
  // Another load may have started on one of them while the graphs were read: checked again, with nothing awaited after.
  const taken = connections.find(c => loading(c.id))
  if (taken) throw refuseLoading(taken)
  const data = new Dataset(new Scale(scale))
  const batch: LoadBatch = {
    id: `${Date.now().toString(36)}-load`, scale, state: 'running',
    loads: connections.map(c => ({
      connection: c.id, name: c.name, type: c.type.toLowerCase(), state: 'waiting', done: 0,
      total: data.scale.nodes + data.scale.relationships, now: 'Waiting its turn',
    })),
  }
  batches_.set(batch.id, batch)
  void (async () => {
    for (const [i, given] of connections.entries()) {
      const job = batch.loads[i]!
      job.state = 'running'
      await (async () => {
        const connection = await latest(given)
        if (connection.type === 'SQLITE') throw refuseSqlite(connection)
        if (!connection.allowWrites) throw refuseWrites(connection)
        job.now = 'Making the indexes'
        await loadIn(job, connection, data)
      })().catch((e: unknown) => {
        job.state = 'failed'
        job.error = e instanceof Error ? e.message : String(e)
      })
    }
    batch.state = 'done'
  })()
  return batch
}

const seconds = (started: number) => (performance.now() - started) / 1000

async function loadIn(job: LoadJob, connection: Connection, data: Dataset): Promise<void> {
  let started = performance.now()
  await schema(connection)
  const schemaSeconds = seconds(started)

  started = performance.now()
  let nodes = 0
  for (const label of LABELS) {
    job.now = `${data.count(label).toLocaleString()} ${label} nodes`
    for (const rows of batches(data.nodes(label), batchSize(connection, 'nodes'))) {
      await write(connection, nodeStatement(label), { rows })
      nodes += rows.length
      job.done += rows.length
    }
  }
  const nodeSeconds = seconds(started)

  started = performance.now()
  let edges = 0
  for (const set of data.edges) {
    job.now = `${set.type} relationships`
    for (const pairs of batches(set.pairs(), batchSize(connection, 'relationships'))) {
      await write(connection, edgeStatement(set), { rows: pairs.map(([s, d]) => ({ s, d })) })
      edges += pairs.length
      job.done += pairs.length
    }
  }
  const edgeSeconds = seconds(started)

  const loaded: Loaded = { scale: data.scale.factor, load: { nodes, edges, schemaSeconds, nodeSeconds, edgeSeconds }, at: new Date().toISOString() }
  await remember(connection.id, loaded)
  job.loaded = loaded
  job.done = job.total = nodes + edges
  job.now = ''
  job.state = 'done'
}

/** Each label's id indexed, unique where the store can afford it, and an issue's repo: as Graph Bench makes them. */
async function schema(connection: Connection): Promise<void> {
  const provider = await providerFor(connection)
  if (connection.type === 'POSTGRES') {
    // The graph's tables, as an application's object manager makes them where they are not there yet.
    const session = await provider.connect()
    try {
      await session.query(new QuerySpecification(new PostgresGraph(provider.graphName ?? 'drivine').ensuring))
    } finally {
      await session.release()
    }
  }
  const objects = new GraphObjectManagerFactory(new PersistenceManagerFactory(DatabaseRegistry.getInstance())).get(provider.name)
  if (connection.type === 'FALKORDB') {
    // FalkorDB makes a graph when it is first written to, and its schema commands need it there.
    await write(connection, 'CREATE (:_Init)', {})
    await write(connection, 'MATCH (n:_Init) DELETE n', {})
  }
  for (const label of LABELS) {
    // FalkorDB checks a unique constraint in time that grows with the label, so it gets a plain index over the id.
    if (connection.type === 'FALKORDB') await objects.indexes.ensure(rangeIndex(label, 'id'))
    else await objects.constraints.ensure(uniquenessConstraint(label, 'id'))
  }
  await objects.indexes.ensure(rangeIndex('Issue', 'repoKey'))
  if (connection.type === 'NEO4J') await write(connection, 'CALL db.awaitIndexes(300)', {})
}

export const nodeStatement = (label: Label) => `UNWIND $rows AS row CREATE (n:${label}) SET n = row`

export const edgeStatement = (set: Pick<EdgeSet, 'type' | 'from' | 'to'>) =>
  `UNWIND $rows AS row MATCH (a:${set.from} {id: row.s}) MATCH (b:${set.to} {id: row.d}) CREATE (a)-[:${set.type}]->(b)`

/**
 * How many rows a statement writes. FalkorDB is sent its parameters as text in the query: smaller than over Bolt.
 * Postgres and Oracle are sent a batch as one JSON value. Drivine 3.4's compiled write copies the rows it has written
 * once per row, so a batch of nodes takes time in the square of its size: on Postgres 4,000 nodes took 5.3 s in one
 * batch and 0.55 s in batches of 250, on Oracle 2,000 took 3.0 s and 0.9 s (liberation-data/drivine#624 fixes it after
 * 3.4.1). Relationships keep large batches: their time is in matching the ends (drivine#636), and Oracle matches them a
 * statement at a time, so at scale 0.001 its relationships took 12 s in batches of 5,000 and 269 s in batches of 250.
 */
export const batchSize = (connection: Pick<Connection, 'type'>, rows: 'nodes' | 'relationships') =>
  connection.type === 'NEO4J' || connection.type === 'MEMGRAPH' ? 20_000 : rows === 'nodes' && SQL_STORES.includes(connection.type) ? 250 : 5_000

const write = (connection: Connection, statement: string, parameters: Record<string, unknown>) =>
  run(connection, statement, parameters, 1, { writes: true })

export function* batches<T>(rows: Iterable<T>, size: number): Generator<T[]> {
  let batch: T[] = []
  for (const row of rows) {
    batch.push(row)
    if (batch.length === size) {
      yield batch
      batch = []
    }
  }
  if (batch.length) yield batch
}
