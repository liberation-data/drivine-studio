import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GET as catalog } from '../catalog/route'
import { DELETE, GET, POST } from './route'

let home: string
const saved = { ...process.env }

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'studio-model-paths-'))
  process.env.DRIVINE_STUDIO_HOME = home
  delete process.env.DRIVINE_STUDIO_MODELS
  delete process.env.DRIVINE_STUDIO_ALLOWED_HOSTS
})

afterEach(async () => {
  process.env = { ...saved }
  await rm(home, { recursive: true, force: true })
})

const request = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost:5187/api/models', {
    method,
    headers: { host: 'localhost:5187', origin: 'http://localhost:5187', 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

describe('/api/models', () => {
  it('adds a folder to look in, lists it, and removes it', async () => {
    await mkdir(join(home, 'project'))
    expect(await (await POST(request('POST', { path: join(home, 'project') }))).json()).toEqual([{ path: join(home, 'project'), source: 'studio' }])
    expect(await (await GET(request('GET'))).json()).toHaveLength(1)
    expect(await (await DELETE(request('DELETE', { path: join(home, 'project') }))).json()).toEqual([])
  })

  it('answers a path it cannot take with a 400, and another site with a 403', async () => {
    const response = await POST(request('POST', { path: 'relative' }))
    expect(response.status).toBe(400)
    expect((await POST(request('POST', { path: home }, { origin: 'https://example.com' }))).status).toBe(403)
    expect((await GET(request('GET', undefined, { host: 'example.com' }))).status).toBe(403)
  })
})

describe('/api/catalog', () => {
  it('answers an empty catalogue when there is nowhere to look', async () => {
    expect(await (await catalog(request('GET'))).json()).toEqual({ models: [], fragments: [], relationshipFragments: [], views: [], problems: [] })
  })

  it('refuses another site', async () => {
    expect((await catalog(request('GET', undefined, { origin: 'https://example.com' }))).status).toBe(403)
  })
})
