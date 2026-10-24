import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DELETE, PUT } from './[id]/route'
import { POST as TEST } from './[id]/test/route'
import { GET, POST } from './route'

let home: string
const saved = { ...process.env }

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'studio-routes-'))
  process.env.DRIVINE_STUDIO_HOME = home
  delete process.env.DATABASE_TYPE
  delete process.env.DRIVINE_STUDIO_ALLOWED_HOSTS
})

afterEach(async () => {
  process.env = { ...saved }
  await rm(home, { recursive: true, force: true })
})

const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost:5187/api/connections${path}`, {
    method,
    headers: { host: 'localhost:5187', 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const context = (id: string) => ({ params: Promise.resolve({ id }) })
const neo4j = { name: 'Local', type: 'NEO4J', host: 'localhost', user: 'neo4j', password: 'secret' }

describe('the connections endpoints', () => {
  it('never answer with a password, the environment\'s either', async () => {
    Object.assign(process.env, { DATABASE_TYPE: 'NEO4J', DATABASE_HOST: 'graph', DATABASE_PASSWORD: 'from-env' })
    const added = await POST(request('POST', '', neo4j))
    expect(added.status).toBe(201)
    const text = await added.text()
    expect(text).not.toContain('secret')
    const { id } = JSON.parse(text) as { id: string }
    const changed = await PUT(request('PUT', `/${id}`, { ...neo4j, password: 'newer' }), context(id))
    expect(await changed.text()).not.toMatch(/newer|secret/)
    const listed = await (await GET(request('GET', ''))).text()
    expect(listed).not.toMatch(/newer|secret|from-env/)
    expect(JSON.parse(listed)).toMatchObject([{ id: 'environment', hasPassword: true }, { id, hasPassword: true }])
  })

  it('remove a connection, which is then not listed', async () => {
    const { id } = (await (await POST(request('POST', '', neo4j))).json()) as { id: string }
    const removed = await DELETE(request('DELETE', `/${id}`), context(id))
    expect(removed.status).toBe(200)
    expect(await (await GET(request('GET', ''))).json()).toEqual([])
  })

  it('answer what is wrong with a connection as a 400', async () => {
    expect((await POST(request('POST', '', { ...neo4j, host: '' }))).status).toBe(400)
    expect((await PUT(request('PUT', '/missing', neo4j), context('missing'))).status).toBe(400)
    expect((await DELETE(request('DELETE', '/environment'), context('environment'))).status).toBe(400)
  })

  it('answer a test of a connection that is not there, or one Cypher does not run on, as a 400', async () => {
    const missing = await TEST(request('POST', '/missing/test'), context('missing'))
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ error: 'There is no connection missing.' })
    const { id } = (await (await POST(request('POST', '', { ...neo4j, type: 'POSTGRES', database: 'app' }))).json()) as { id: string }
    const postgres = await TEST(request('POST', `/${id}/test`), context(id))
    expect(postgres.status).toBe(400)
    expect(((await postgres.json()) as { error: string }).error).toContain('runs SQL, not Cypher')
  })

  it('refuse a page of another site', async () => {
    const foreign = { origin: 'https://example.com' }
    expect((await GET(request('GET', '', undefined, foreign))).status).toBe(403)
    expect((await POST(request('POST', '', neo4j, foreign))).status).toBe(403)
    expect((await DELETE(request('DELETE', '/x', undefined, foreign), context('x'))).status).toBe(403)
    expect((await TEST(request('POST', '/x/test', undefined, foreign), context('x'))).status).toBe(403)
  })
})
