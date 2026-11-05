import { describe, expect, it, vi } from 'vitest'
import { Dataset, Scale } from './benchData'
import { batches, batchSize, beginLoad, edgeStatement, LARGEST, loadBatch, nodeStatement, SMALLEST, validateLoad } from './benchLoad'
import type { LoadBatch } from './benchLoad'
import type { Connection } from './connections'
import { providerFor, readRows } from './datasources'
import { compilerFor, readCypher } from './sqlCypher'

// Nothing is connected to: each graph reads as empty, and a load's first step, reaching its database, fails.
vi.mock('./datasources', async original => ({
  ...(await original<typeof import('./datasources')>()),
  readRows: vi.fn(async () => ({ columns: ['c'], rows: [[0]], truncated: false })),
  run: vi.fn(async () => ({ columns: [], rows: [], truncated: false })),
  providerFor: vi.fn(async () => {
    throw new Error('Not connected to, in this test.')
  }),
}))

const connection = (id: string, allowWrites = true): Connection =>
  ({ id, name: id, type: 'NEO4J', host: 'localhost', port: 7687, source: 'studio', allowWrites })

async function finished(started: LoadBatch): Promise<LoadBatch> {
  while (loadBatch(started.id)!.state === 'running') await new Promise(resolve => setTimeout(resolve, 5))
  return loadBatch(started.id)!
}

describe('Loading Graph Bench’s data', () => {
  it('takes a connection and a scale within bounds', () => {
    expect(validateLoad({ connections: ['pg', 'neo', 'pg'], scale: 0.01 })).toEqual({ connections: ['pg', 'neo'], scale: 0.01 })
    expect(() => validateLoad({ connections: [], scale: 1 })).toThrow(/connection/)
    expect(() => validateLoad({ connections: ['pg'], scale: SMALLEST / 2 })).toThrow(/scale/)
    expect(() => validateLoad({ connections: ['pg'], scale: LARGEST * 2 })).toThrow(/scale/)
    expect(() => validateLoad({ connections: ['pg'], scale: 'big' })).toThrow(/scale/)
  })

  it('writes in batches, the last one what is left', () => {
    expect([...batches([1, 2, 3, 4, 5], 2)]).toEqual([[1, 2], [3, 4], [5]])
    expect([...batches([], 2)]).toEqual([])
  })

  // A compiled write's time grows with the square of its batch on Postgres and Oracle, so nodes go in small ones there;
  // Oracle matches relationships' ends a statement at a time, so they go in large ones.
  it('sends Postgres and Oracle nodes in small batches, and the rest in large ones', () => {
    expect(batchSize({ type: 'POSTGRES' }, 'nodes')).toBe(250)
    expect(batchSize({ type: 'ORACLE' }, 'nodes')).toBe(250)
    expect(batchSize({ type: 'ORACLE' }, 'relationships')).toBe(5_000)
    expect(batchSize({ type: 'NEO4J' }, 'nodes')).toBeGreaterThan(batchSize({ type: 'FALKORDB' }, 'nodes'))
  })

  it('starts none where one of the connections doesn’t allow writes', async () => {
    vi.mocked(readRows).mockClear()
    await expect(beginLoad([connection('ok'), connection('read-only', false)], SMALLEST)).rejects.toThrow(/read-only doesn't allow writes/)
  })

  it('refuses a graph that a load stopped in partway, with orgs and no comments yet', async () => {
    vi.mocked(readRows).mockImplementationOnce(async (_connection, statement) => ({ columns: ['c'], rows: [[/:Org\b/.test(statement) ? 12 : 0]], truncated: false }))
    await expect(beginLoad([connection('half')], SMALLEST, async c => c)).rejects.toThrow(/half has Graph Bench's data already, or some of it/)
  })

  it('doesn’t write to a connection taken off writes while it waited its turn', async () => {
    vi.mocked(providerFor).mockClear()
    const now = { first: connection('first'), second: connection('second', false) }
    const batch = await finished(await beginLoad([connection('first'), connection('second')], SMALLEST, async c => now[c.id as keyof typeof now]))
    expect(batch.loads[1]).toMatchObject({ state: 'failed', error: expect.stringMatching(/second doesn't allow writes/) })
    expect(vi.mocked(providerFor).mock.calls.map(([c]) => c.id)).toEqual(['first'])
  })

  it('refuses a load into a connection that another started while its graph was being read', async () => {
    let release = () => {}
    const reading = new Promise<void>(resolve => (release = resolve))
    vi.mocked(readRows).mockImplementation(async () => {
      await reading
      return { columns: ['c'], rows: [[0]], truncated: false }
    })
    const latest = async (c: Connection) => c
    const both = Promise.allSettled([beginLoad([connection('raced')], SMALLEST, latest), beginLoad([connection('raced')], SMALLEST, latest)])
    release()
    const [one, other] = await both
    expect([one.status, other.status].sort()).toEqual(['fulfilled', 'rejected'])
    expect(((one.status === 'rejected' ? one : other) as PromiseRejectedResult).reason.message).toMatch(/raced is being loaded already/)
    await finished((one.status === 'fulfilled' ? one : other as PromiseFulfilledResult<LoadBatch>).value)
  })

  // What Postgres and Oracle are sent is Drivine's SQL for these: the compiler must take each.
  it.each(['POSTGRES', 'ORACLE'] as const)('loads with statements Drivine compiles for %s', type => {
    const data = new Dataset(new Scale(SMALLEST))
    const compiler = compilerFor(type, 'drivine')
    const rows = [...data.nodes('Person')].slice(0, 2)
    expect(() => compiler.compileQuery(readCypher(nodeStatement('Person')), { rows })).not.toThrow()
    for (const set of data.edges) {
      expect(() => compiler.compileQuery(readCypher(edgeStatement(set)), { rows: [{ s: 'p0', d: 'o0' }] })).not.toThrow()
    }
  })
})
