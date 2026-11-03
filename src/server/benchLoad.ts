import {
  DatabaseRegistry, GraphObjectManagerFactory, PersistenceManagerFactory, PostgresGraph, QuerySpecification, rangeIndex,
  uniquenessConstraint,
} from '@liberation-data/drivine'

import { BenchError } from './bench'
import type { EngineResults } from './bench'
import { Dataset, LABELS, Scale } from './benchData'
import type { EdgeSet, Label } from './benchData'
import { findConnection } from './connections'
import type { Connection } from './connections'
import { NoGraphError, providerFor, readRows, run } from './datasources'
import { readHomeFile, serially, writeHomeFile } from './home'

/*
 * Graph Bench's dataset, loaded into a connection, so its own workloads and anyone's saved queries can be timed on the
 * same graph in each store. Made here as Graph Bench makes it (see benchData), it is written as an application would
 * write it, by Drivine: each label's id indexed, as unique where the store can afford it, then the nodes and the
 * relationships in batches of rows, with UNWIND. Graph Bench itself loads Postgres and Oracle with their bulk paths,
 * which are quicker: these load times say what Cypher through Drivine costs, not what the store can do at best.
 *
 * It writes, so only on a connection that allows writes, and only into a graph without Graph Bench's data already.
 */

export type Load = NonNullable<EngineResults['load']>

/** What was loaded into a connection, kept so that a bench run there can say so. */
export interface Loaded {
  scale: number
  load: Load
  at: string
}

export interface LoadJob {
  id: string
  connection: string
  scale: number
  state: 'running' | 'done' | 'failed'
  /** Nodes and relationships written so far, and about how many there will be. */
  done: number
  total: number
  now: string
  error?: string
  loaded?: Loaded
}

/** The scales a load takes: from about 1,100 nodes to about 11 million. Past SLOW, a load is long. */
export const SMALLEST = 0.001
export const LARGEST = 10
export const SLOW = 0.1
/** Graph Bench's dataset has about four relationships a node: an estimate, for the progress bar. */
const EDGES_A_NODE = 4

const LOADS = 'bench-loads.json'

const jobs: Map<string, LoadJob> = ((globalThis as { __studioBenchLoads?: Map<string, LoadJob> }).__studioBenchLoads ??= new Map())

export function validateLoad(input: unknown): { connection: string; scale: number } {
  const given = (input ?? {}) as Record<string, unknown>
  if (typeof given.connection !== 'string' || !given.connection) throw new BenchError('Choose a connection to load.')
  const scale = Number(given.scale)
  if (!Number.isFinite(scale) || scale < SMALLEST || scale > LARGEST) throw new BenchError(`A scale is from ${SMALLEST} to ${LARGEST}.`)
  return { connection: given.connection, scale }
}

/** What has been loaded into each connection, by its id. */
export async function loadedInto(): Promise<Record<string, Loaded>> {
  return (await readHomeFile<Record<string, Loaded>>(LOADS)) ?? {}
}

const remember = (id: string, loaded: Loaded) => serially(async () => {
  await writeHomeFile(LOADS, { ...(await loadedInto()), [id]: loaded })
})

export function loadJob(id: string): LoadJob | undefined {
  return jobs.get(id)
}

/** Starts a load; it goes on in the background, and its job says how far it has got. */
export async function startLoad(input: { connection: string; scale: number }): Promise<LoadJob> {
  return beginLoad(await findConnection(input.connection), input.scale)
}

/** Starts a load into the connection given. */
export async function beginLoad(connection: Connection, scale: number): Promise<LoadJob> {
  if (!connection.allowWrites) throw new BenchError(`${connection.name} doesn't allow writes. Allow them in its settings to load Graph Bench's data there.`)
  if ([...jobs.values()].some(j => j.connection === connection.id && j.state === 'running')) throw new BenchError(`${connection.name} is being loaded already.`)
  // A graph not there yet is empty: the load makes it.
  const there = await readRows(connection, 'MATCH (n:Comment) RETURN count(n) AS c', {}, 1, value => Number(value)).catch((e: unknown) => {
    if (e instanceof NoGraphError) return { rows: [[0]] }
    throw e
  })
  if (Number(there.rows[0]?.[0] ?? 0) > 0) throw new BenchError(`${connection.name} has Graph Bench's data already, or nodes labelled Comment. Load into an empty graph.`)
  const data = new Dataset(new Scale(scale))
  const nodes = data.scale.nodes
  const job: LoadJob = {
    id: `${Date.now().toString(36)}-${connection.id}`, connection: connection.id, scale,
    state: 'running', done: 0, total: nodes * (1 + EDGES_A_NODE), now: 'Making the indexes',
  }
  jobs.set(job.id, job)
  void loadIn(job, connection, data).catch((e: unknown) => {
    job.state = 'failed'
    job.error = e instanceof Error ? e.message : String(e)
  })
  return job
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
    for (const rows of batches(data.nodes(label), batchSize(connection))) {
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
    for (const pairs of batches(set.pairs(), batchSize(connection))) {
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

/** FalkorDB is sent its parameters as text in the query, and Postgres and Oracle a batch as one JSON value: smaller. */
const batchSize = (connection: Connection) => (connection.type === 'NEO4J' || connection.type === 'MEMGRAPH' ? 20_000 : 5_000)

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
