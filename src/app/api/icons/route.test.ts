import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GET as catalog } from './catalog/route'
import { POST, PUT } from './route'
import { GET as svg } from './svg/[name]/route'

let home: string
const saved = { ...process.env }

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'studio-icon-routes-'))
  process.env.DRIVINE_STUDIO_HOME = home
  delete process.env.DRIVINE_STUDIO_ALLOWED_HOSTS
})

afterEach(async () => {
  process.env = { ...saved }
  await rm(home, { recursive: true, force: true })
})

const request = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost:5187/api/icons', {
    method,
    headers: { host: 'localhost:5187', origin: 'http://localhost:5187', 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const error = async (response: Response) => ({ status: response.status, error: ((await response.json()) as { error: string }).error })

describe('/api/icons', () => {
  it('gives the icon of each label a common word names, without a model', async () => {
    const answer = await POST(request('POST', { labels: ['Person', 'Organization'] }))
    expect(await answer.json()).toEqual({
      Person: { icon: 'user', source: 'common' },
      Organization: { icon: 'building', source: 'common' },
    })
  })

  it('chooses a label\'s icon, then none, then forgets the choice', async () => {
    expect(await (await PUT(request('PUT', { label: 'Person', icon: 'bug' }))).json()).toEqual({ icon: 'bug', source: 'chosen' })
    expect(await (await PUT(request('PUT', { label: 'Person', icon: null }))).json()).toEqual({ icon: null, source: 'chosen' })
    expect(await (await PUT(request('PUT', { label: 'Person', forget: true }))).json()).toEqual({ icon: 'user', source: 'common' })
  })

  it.each([
    [{ labels: 'Person' }, 'Give the labels, a list of at most 500.'],
    [{ labels: [1] }, 'Give the labels, a list of at most 500.'],
  ])('refuses to find %j', async (body, message) => {
    expect(await error(await POST(request('POST', body)))).toEqual({ status: 400, error: message })
  })

  it.each([
    [{ icon: 'user' }, 'Name the label.'],
    [{ label: 'Person', icon: 'no-such-icon' }, "Name one of Lucide's icons, or null for none."],
    [{ label: 'Person', icon: '../../etc/passwd' }, "Name one of Lucide's icons, or null for none."],
  ])('refuses to choose %j', async (body, message) => {
    expect(await error(await PUT(request('PUT', body)))).toEqual({ status: 400, error: message })
  })

  it('refuses another site', async () => {
    expect((await POST(request('POST', { labels: [] }, { origin: 'https://example.com' }))).status).toBe(403)
    expect((await PUT(request('PUT', { label: 'A', icon: null }, { origin: 'https://example.com' }))).status).toBe(403)
  })
})

describe('/api/icons/svg and /api/icons/catalog', () => {
  const name = (value: string) => ({ params: Promise.resolve({ name: value }) })

  it('gives an icon\'s SVG, and none for a name that is not an icon\'s', async () => {
    const drawn = await svg(request('GET'), name('user'))
    expect(drawn.headers.get('content-type')).toBe('image/svg+xml')
    expect(await drawn.text()).toContain('<svg')
    expect((await svg(request('GET'), name('../package'))).status).toBe(404)
  })

  it('lists every icon with its tags', async () => {
    const icons = (await (await catalog(request('GET'))).json()) as Record<string, string[]>
    expect(icons.user).toContain('person')
  })
})
