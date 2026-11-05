import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const run = vi.fn()
vi.mock('./datasources', () => ({ run: (...args: unknown[]) => run(...args) }))
let loaded: Record<string, unknown> = {}
vi.mock('./benchLoad', () => ({ loadedInto: async () => loaded }))
const connections: Record<string, { id: string; name: string; type: string; host: string; allowWrites?: boolean }> = {
  pg: { id: 'pg', name: 'Local PG', type: 'POSTGRES', host: 'localhost', allowWrites: true },
  pg2: { id: 'pg2', name: 'local-pg', type: 'POSTGRES', host: 'localhost' },
  neo: { id: 'neo', name: 'Local PG', type: 'NEO4J', host: 'localhost' },
}
vi.mock('./connections', () => ({
  findConnection: async (id: string) => {
    if (!connections[id]) throw new Error(`There is no connection ${id}.`)
    return connections[id]
  },
}))
const query = (id: string, parameters = '') => ({ id, name: id, folder: 'Bench', statement: `MATCH (n) RETURN n // ${id}`, parameters, saved: '' })
vi.mock('./queries', () => ({ listQueries: async () => ({ queries: [query('ok'), query('bad', '{"half":'), query('two')] }) }))

const { job, startRun, stopRun } = await import('./benchRun')
type Job = NonNullable<ReturnType<typeof job>>

let dir: string
const saved = { ...process.env }
const settings = { name: 'Mine', warmup: 1, runs: 2 }
const over = (started: Job) => vi.waitFor(() => expect(job(started.id)!.state).not.toBe('running'), { timeout: 2000 })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'studio-bench-run-'))
  process.env.DRIVINE_STUDIO_HOME = dir
  loaded = {}
  run.mockReset()
  run.mockResolvedValue({ columns: ['n'], rows: [[1]], truncated: false })
})

afterEach(async () => {
  process.env = { ...saved }
  await rm(dir, { recursive: true, force: true })
})

describe('A bench run', () => {
  it('only reads, even on a connection that allows writes', async () => {
    const started = await startRun({ ...settings, connections: ['pg'], queries: ['ok'] })
    await over(started)
    expect(job(started.id)!.state).toBe('done')
    expect(run).toHaveBeenCalledTimes(3)
    // Never given the options that let a statement write.
    for (const call of run.mock.calls) expect(call[4]).toBeUndefined()
  })

  it('leaves out a query whose parameters are half-written, and times the rest', async () => {
    const started = await startRun({ ...settings, connections: ['pg'], queries: ['bad', 'two'] })
    await over(started)
    const done = job(started.id)!
    expect(done).toMatchObject({ state: 'done', done: 2, total: 2 })
    const kept = JSON.parse(await readFile(join(dir, 'bench', done.set!, 'local-pg-sf1.0.json'), 'utf8')) as { outcomes: { name: string }[] }
    expect(kept.outcomes.map(o => o.name)).toEqual(['two'])
  })

  it('keeps each connection, where their names make the same file or are the same', async () => {
    const started = await startRun({ ...settings, connections: ['pg', 'pg2', 'neo'], queries: ['ok'] })
    await over(started)
    const folder = join(dir, 'bench', job(started.id)!.set!)
    expect((await readdir(folder)).sort()).toEqual(['local-pg-2-2-sf1.0.json', 'local-pg-2-sf1.0.json', 'local-pg-sf1.0.json', 'run.json'])
    const engines = await Promise.all((await readdir(folder)).filter(f => f !== 'run.json').map(async f => (JSON.parse(await readFile(join(folder, f), 'utf8')) as { engine: string }).engine))
    expect(engines.sort()).toEqual(['Local PG', 'Local PG (2)', 'local-pg'])
  })

  it('stops before its next call when asked, and keeps nothing', async () => {
    let calls = 0
    run.mockImplementation(async () => {
      calls += 1
      await new Promise(resolve => setTimeout(resolve, 5))
      return { columns: [], rows: [], truncated: false }
    })
    const started = await startRun({ ...settings, runs: 1000, connections: ['pg', 'neo'], queries: ['ok', 'two'] })
    await vi.waitFor(() => expect(calls).toBeGreaterThan(0))
    expect(stopRun(started.id)).toBe(true)
    await over(started)
    const stopped = job(started.id)!
    expect(stopped.state).toBe('failed')
    expect(stopped.error).toMatch(/Stopped/)
    const made = calls
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(calls).toBe(made)
    expect(await readdir(join(dir, 'bench')).catch(() => [])).toEqual([])
    expect(stopRun(started.id)).toBe(false)
    expect(stopRun('no-such-run')).toBe(false)
  })

  it('refuses a second run while one is going on', async () => {
    run.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ columns: [], rows: [], truncated: false }), 5)))
    const first = await startRun({ ...settings, runs: 1000, connections: ['pg'], queries: ['ok'] })
    await expect(startRun({ ...settings, connections: ['pg'], queries: ['ok'] })).rejects.toThrow(/going on already/)
    stopRun(first.id)
    await over(first)
  })

  it('refuses the second of two runs asked for at once', async () => {
    run.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ columns: [], rows: [], truncated: false }), 5)))
    const asked = await Promise.allSettled([1, 2].map(() => startRun({ ...settings, runs: 1000, connections: ['pg'], queries: ['ok'] })))
    expect(asked.map(a => a.status).sort()).toEqual(['fulfilled', 'rejected'])
    const first = (asked.find(a => a.status === 'fulfilled') as PromiseFulfilledResult<Job>).value
    stopRun(first.id)
    await over(first)
  })

  it('keeps nothing when asked to stop during its last call', async () => {
    let started: Job | undefined
    run.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      stopRun(started!.id)
      return { columns: [], rows: [], truncated: false }
    })
    started = await startRun({ ...settings, warmup: 0, runs: 1, connections: ['pg'], queries: ['ok'] })
    await over(started)
    expect(job(started.id)).toMatchObject({ state: 'failed', error: expect.stringMatching(/Stopped/) })
    expect(await readdir(join(dir, 'bench')).catch(() => [])).toEqual([])
  })

  it('gives no digest for an answer longer than the rows read, as each store may have read different ones', async () => {
    run.mockResolvedValue({ columns: ['n'], rows: [[1]], truncated: true })
    const started = await startRun({ ...settings, connections: ['pg'], queries: ['ok'] })
    await over(started)
    const kept = JSON.parse(await readFile(join(dir, 'bench', job(started.id)!.set!, 'local-pg-sf1.0.json'), 'utf8')) as { outcomes: { digest: string | null }[] }
    expect(kept.outcomes[0]!.digest).toBeNull()
  })

  it('keeps the scale and load of Graph Bench data loaded into a connection, and 1 where there is none', async () => {
    const load = { nodes: 1000, edges: 4000, schemaSeconds: 0, nodeSeconds: 1, edgeSeconds: 2 }
    loaded = { pg: { scale: 0.001, load, at: '' } }
    const started = await startRun({ ...settings, connections: ['pg', 'neo'], queries: ['ok'] })
    await over(started)
    const folder = join(dir, 'bench', job(started.id)!.set!)
    expect((await readdir(folder)).sort()).toEqual(['local-pg-2-sf1.0.json', 'local-pg-sf0.001.json', 'run.json'])
    expect(JSON.parse(await readFile(join(folder, 'local-pg-sf0.001.json'), 'utf8'))).toMatchObject({ scale: 0.001, load })
    expect(JSON.parse(await readFile(join(folder, 'local-pg-2-sf1.0.json'), 'utf8'))).toMatchObject({ scale: 1, load: null })
  })

  it('digests the same answer alike, whatever order each store gave its rows in', async () => {
    run.mockImplementation(async (connection: { id: string }) => ({ columns: ['n'], rows: connection.id === 'pg' ? [[1], [2]] : [[2], [1]], truncated: false }))
    const started = await startRun({ ...settings, connections: ['pg', 'pg2'], queries: ['ok'] })
    await over(started)
    const folder = join(dir, 'bench', job(started.id)!.set!)
    const digests = await Promise.all(['local-pg-sf1.0.json', 'local-pg-2-sf1.0.json'].map(async f => (JSON.parse(await readFile(join(folder, f), 'utf8')) as { outcomes: { digest: string }[] }).outcomes[0]!.digest))
    expect(digests[0]).toMatch(/^[0-9a-f]{8}$/)
    expect(digests[1]).toBe(digests[0])
  })

  it('leaves out a query a store refuses, there only, and keeps the rest of the run', async () => {
    run.mockImplementation(async (connection: { id: string }, statement: string) => {
      if (connection.id === 'neo' && statement.includes('two')) throw new Error('refused')
      return { columns: ['n'], rows: [[1]], truncated: false }
    })
    const started = await startRun({ ...settings, connections: ['pg', 'neo'], queries: ['ok', 'two'] })
    await over(started)
    expect(job(started.id)).toMatchObject({ state: 'done', done: 4, total: 4 })
    const folder = join(dir, 'bench', job(started.id)!.set!)
    const names = async (file: string) => (JSON.parse(await readFile(join(folder, file), 'utf8')) as { outcomes: { name: string }[] }).outcomes.map(o => o.name)
    expect(await names('local-pg-sf1.0.json')).toEqual(['ok', 'two'])
    expect(await names('local-pg-2-sf1.0.json')).toEqual(['ok'])
  })

  it('fails, saying why, when its results cannot be kept', async () => {
    // Where its folder should be, a file: nothing can be written under it.
    await writeFile(join(dir, 'bench'), '')
    const started = await startRun({ ...settings, connections: ['pg'], queries: ['ok'] })
    await over(started)
    expect(job(started.id)).toMatchObject({ state: 'failed', error: expect.stringMatching(/EEXIST|ENOTDIR/) })
    expect(job(started.id)!.set).toBeUndefined()
  })

  it('refuses a saved query that is not there', async () => {
    await expect(startRun({ ...settings, connections: ['pg'], queries: ['gone'] })).rejects.toThrow(/no saved query gone/)
  })
})
