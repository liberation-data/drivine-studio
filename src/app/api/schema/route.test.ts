import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addConnection, validate } from '../../../server/connections'
import { readSchema } from '../../../server/schema'
import { GET } from './route'

// The graph is not read here: what the route asks of readSchema, and how it answers, is what is tested.
vi.mock('../../../server/schema', () => ({
  readSchema: vi.fn(async () => ({ labels: ['Person'], relationshipTypes: ['ACTED_IN'], propertyKeys: ['name'] })),
}))

let home: string
const saved = { ...process.env }

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'studio-schema-'))
  process.env.DRIVINE_STUDIO_HOME = home
  delete process.env.DATABASE_TYPE
  delete process.env.DRIVINE_STUDIO_ALLOWED_HOSTS
})

afterEach(async () => {
  process.env = { ...saved }
  await rm(home, { recursive: true, force: true })
})

const get = (query: string, headers: Record<string, string> = {}) =>
  GET(new Request(`http://localhost:5187/api/schema${query}`, { headers: { host: 'localhost:5187', ...headers } }))

describe('GET /api/schema', () => {
  it('refuses a page of another site', async () => {
    expect((await get('?connection=x', { origin: 'https://example.com' })).status).toBe(403)
  })

  it('refuses a call that names no connection, or one there is not', async () => {
    expect(await (await get('')).json()).toEqual({ error: 'Name a connection.' })
    const missing = await get('?connection=missing')
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ error: 'There is no connection missing.' })
  })

  it('gives the connection’s schema, and how long it took to read', async () => {
    const kept = await addConnection(validate({ name: 'Local', type: 'NEO4J', host: 'localhost', user: 'neo4j', password: 'secret' }))
    const answered = await get(`?connection=${kept.id}`)
    expect(answered.status).toBe(200)
    expect(await answered.json()).toEqual({ labels: ['Person'], relationshipTypes: ['ACTED_IN'], propertyKeys: ['name'], milliseconds: expect.any(Number) })
    expect(vi.mocked(readSchema).mock.calls.at(-1)?.[0].id).toBe(kept.id)
  })

  it('says what the database said when the graph can’t be read', async () => {
    const kept = await addConnection(validate({ name: 'Local', type: 'NEO4J', host: 'localhost', user: 'neo4j', password: 'secret' }))
    vi.mocked(readSchema).mockRejectedValueOnce(new Error('connection refused'))
    const failed = await get(`?connection=${kept.id}`)
    expect(failed.status).toBe(502)
    expect(await failed.json()).toEqual({ error: 'connection refused' })
  })
})
