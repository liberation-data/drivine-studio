import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addConnection, validate } from '../../../server/connections'
import { run } from '../../../server/datasources'
import { POST } from './route'

// The statement is not run here: what the route asks of `run` is what is tested.
vi.mock('../../../server/datasources', async original => ({
  ...(await original<typeof import('../../../server/datasources')>()),
  run: vi.fn(async (_connection: unknown, _statement: string, _parameters: unknown, limit: number) => ({
    columns: [], rows: [], graph: { nodes: [], relationships: [] }, truncated: false, limit, milliseconds: 0,
  })),
}))

let home: string
const saved = { ...process.env }

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'studio-cypher-'))
  process.env.DRIVINE_STUDIO_HOME = home
  delete process.env.DATABASE_TYPE
  delete process.env.DRIVINE_STUDIO_ALLOWED_HOSTS
})

afterEach(async () => {
  process.env = { ...saved }
  await rm(home, { recursive: true, force: true })
})

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request('http://localhost:5187/api/cypher', {
    method: 'POST',
    headers: { host: 'localhost:5187', origin: 'http://localhost:5187', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }))

const answer = async (response: Response) => ({ status: response.status, error: ((await response.json()) as { error: string }).error })

describe('POST /api/cypher', () => {
  it('refuses a page of another site before reading what it sent', async () => {
    expect((await post({ connection: 'x', statement: 'RETURN 1' }, { origin: 'https://example.com' })).status).toBe(403)
  })

  it.each([
    [{ statement: 'RETURN 1' }, 'Name a connection and give a statement.'],
    [{ connection: 'x' }, 'Name a connection and give a statement.'],
    [{ connection: 'x', statement: 'RETURN 1', parameters: [1] }, 'The parameters are a JSON object'],
    [{ connection: 'x', statement: 'RETURN 1', parameters: 'born' }, 'The parameters are a JSON object'],
    [{ connection: 'x', statement: 'RETURN 1', limit: 0 }, 'The limit is a whole number from 1 to 10000.'],
    [{ connection: 'x', statement: 'RETURN 1', limit: 10001 }, 'The limit is a whole number'],
    [{ connection: 'x', statement: 'RETURN 1', limit: 2.5 }, 'The limit is a whole number'],
    [{ connection: 'x', statement: 'RETURN 1', limit: '10' }, 'The limit is a whole number'],
  ])('refuses %j as a 400', async (body, error) => {
    const refused = await answer(await post(body))
    expect(refused.status).toBe(400)
    expect(refused.error).toContain(error)
  })

  it('lets a statement write only on a connection that allows writes', async () => {
    const neo4j = { name: 'Local', type: 'NEO4J', host: 'localhost', user: 'neo4j', password: 'secret' }
    const reads = await addConnection(validate(neo4j))
    const writes = await addConnection(validate({ ...neo4j, name: 'Writes', allowWrites: true }))
    vi.mocked(run).mockClear()
    expect((await post({ connection: reads.id, statement: 'CREATE (n)' })).status).toBe(200)
    expect((await post({ connection: writes.id, statement: 'CREATE (n)', limit: 5 })).status).toBe(200)
    // What the browser sends cannot ask for writes: only the connection's own setting can.
    expect((await post({ connection: reads.id, statement: 'CREATE (n)', writes: true, allowWrites: true })).status).toBe(200)
    expect(vi.mocked(run).mock.calls.map(([connection, , , limit, options]) => [connection.id, limit, options])).toEqual([
      [reads.id, 1000, { writes: false }],
      [writes.id, 5, { writes: true }],
      [reads.id, 1000, { writes: false }],
    ])
  })

  it('says there is no such connection', async () => {
    expect(await answer(await post({ connection: 'missing', statement: 'RETURN 1' }))).toEqual({ status: 400, error: 'There is no connection missing.' })
  })
})
