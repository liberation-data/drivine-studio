import { createHash } from 'node:crypto'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { findConnection } from './connections'
import type { Connection } from './connections'
import { run as runCypher } from './datasources'
import { studioHome } from './home'
import { listQueries } from './queries'
import { BenchError, RUN_FILE } from './bench'
import type { EngineResults, Outcome } from './bench'

/*
 * A bench of the studio's own: saved queries, run on connections, timed. Each query is run a few times to warm up and
 * then timed over a number of runs, on each connection in turn; what it gave back is digested, so the connections can be
 * checked to agree. It only ever reads. The results are kept as Graph Bench keeps its own, a file a connection in a
 * folder of the run's own, `bench/<run>/<connection>-sf1.0.json` in the studio's home, so the Bench window reads,
 * compares and charts them as it does Graph Bench's.
 */

export interface RunInput {
  name: string
  connections: string[]
  /** Saved queries' ids, as Files has them. */
  queries: string[]
  warmup: number
  runs: number
}

export interface RunJob {
  id: string
  name: string
  state: 'running' | 'done' | 'failed'
  done: number
  total: number
  /** What is being timed now: the connection and the query. */
  now: string
  error?: string
  /** The run's folder, once it is written. */
  set?: string
}

export const benchFolder = (): string => join(studioHome(), 'bench')

const jobs: Map<string, RunJob> = ((globalThis as { __studioBenchJobs?: Map<string, RunJob> }).__studioBenchJobs ??= new Map())

/** A name as a folder or file can carry it. */
export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'run'

export function validateRun(input: unknown): RunInput {
  const given = (input ?? {}) as Record<string, unknown>
  const list = (key: string) => (Array.isArray(given[key]) ? (given[key] as unknown[]).filter((v): v is string => typeof v === 'string') : [])
  const number = (key: string, fallback: number, most: number) => {
    const value = Number(given[key] ?? fallback)
    if (!Number.isInteger(value) || value < 0 || value > most) throw new BenchError(`${key} is a whole number from 0 to ${most}.`)
    return value
  }
  const connections = list('connections')
  const queries = list('queries')
  if (!connections.length) throw new BenchError('Choose a connection to run on.')
  if (!queries.length) throw new BenchError('Choose a query to run.')
  const runs = number('runs', 20, 1000)
  if (runs < 1) throw new BenchError('Time each query at least once.')
  const name = typeof given.name === 'string' && given.name.trim() ? given.name.trim() : new Date().toISOString().slice(0, 16).replace('T', ' ')
  return { name, connections, queries, warmup: number('warmup', 3, 100), runs }
}

export function job(id: string): RunJob | undefined {
  return jobs.get(id)
}

/** Starts a run; it goes on in the background, and its job says how far it has got. */
export async function startRun(input: RunInput): Promise<RunJob> {
  const connections = await Promise.all(input.connections.map(findConnection))
  const shelf = await listQueries()
  const queries = input.queries.map(id => {
    const found = shelf.queries.find(q => q.id === id)
    if (!found) throw new BenchError(`There is no saved query ${id}.`)
    return found
  })
  const id = `${Date.now().toString(36)}-${slug(input.name)}`
  const running: RunJob = { id, name: input.name, state: 'running', done: 0, total: connections.length * queries.length, now: '' }
  jobs.set(id, running)
  void runIn(running, input, connections, queries).catch((e: unknown) => {
    running.state = 'failed'
    running.error = e instanceof Error ? e.message : String(e)
  })
  return running
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!

async function runIn(running: RunJob, input: RunInput, connections: Connection[], queries: Awaited<ReturnType<typeof listQueries>>['queries']) {
  const results: (EngineResults & { type: string })[] = []
  for (const connection of connections) {
    const outcomes: Outcome[] = []
    for (const query of queries) {
      running.now = `${query.name} on ${connection.name}`
      const parameters = query.parameters.trim() ? (JSON.parse(query.parameters) as Record<string, unknown>) : {}
      const once = () => runCypher(connection, query.statement, parameters)
      try {
        for (let i = 0; i < input.warmup; i++) await once()
        const times: number[] = []
        let digest = ''
        for (let i = 0; i < input.runs; i++) {
          const started = performance.now()
          const result = await once()
          times.push(performance.now() - started)
          // What came back, as text whose order doesn't depend on the store: the same answer digests the same.
          if (i === 0) digest = createHash('sha1').update(JSON.stringify(result.rows.map(row => JSON.stringify(row)).sort())).digest('hex').slice(0, 8)
        }
        const sorted = [...times].sort((a, b) => a - b)
        outcomes.push({
          group: query.folder || 'queries', name: query.name, calls: sorted.length,
          p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
          min: sorted[0]!, max: sorted[sorted.length - 1]!, throughput: null, digest,
        })
      } catch (e) {
        // A query a store can't run is left out of its column; the report says "failed" there.
        process.stderr.write(`Drivine Studio bench: ${query.name} on ${connection.name}: ${e instanceof Error ? e.message : String(e)}\n`)
      }
      running.done += 1
    }
    results.push({
      engine: connection.name, type: connection.type.toLowerCase(), scale: 1, load: null, outcomes,
      run: {
        at: new Date().toISOString().slice(0, 19) + 'Z',
        machine: machine(),
        jvm: `Node ${process.versions.node}`,
        drivine: `TypeScript ${drivineVersion()}`,
        bench: null,
        image: `${connection.type.charAt(0)}${connection.type.slice(1).toLowerCase()} · ${connection.host}${connection.port ? `:${connection.port}` : ''}`,
        imageId: null,
        limits: `${input.warmup} warm-up, ${input.runs} timed`,
      },
    })
  }
  const set = running.id
  const folder = join(benchFolder(), set)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  // The run's name as it was given; the folder's carries an id and only what a path can.
  await writeFile(join(folder, RUN_FILE), JSON.stringify({ name: input.name }, null, 2), { mode: 0o600 })
  for (const r of results) await writeFile(join(folder, `${slug(r.engine)}-sf1.0.json`), JSON.stringify(r, null, 2), { mode: 0o600 })
  running.set = set
  running.now = ''
  running.state = 'done'
}

function machine(): string {
  const model = cpus()[0]?.model?.trim() ?? arch()
  return `${model}, ${cpus().length} cores, ${Math.round(totalmem() / 1024 ** 3)} GB, ${platform()} ${release()} ${arch()}`
}

function drivineVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(process.cwd(), 'node_modules', '@liberation-data', 'drivine', 'package.json'), 'utf8')) as { version: string }).version
  } catch {
    return 'unknown'
  }
}
