import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GET as catalog } from './catalog/route'
import { POST as explain } from './explain/route'
import { GET as lists, PUT as change } from './lists/route'
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

describe('/api/icons/lists', () => {
  it('gives the choices and the lists, the built-in ones beside their own', async () => {
    await PUT(request('PUT', { label: 'Person', icon: 'bug' }))
    const answer = (await (await lists(request('GET'))).json()) as Record<string, unknown> & { builtIn: { words: Record<string, string>; onlyByName: string[] } }
    expect(answer).toMatchObject({ chosen: { Person: 'bug' }, words: {}, onlyByName: [], nearest: 0.45 })
    expect(answer.builtIn.words.person).toBe('user')
    expect(answer.builtIn.onlyByName).toContain('cigarette')
  })

  it("adds a word of their own, as a label's words are looked up, which then gives labels their icon", async () => {
    const answer = await (await change(request('PUT', { word: 'Space Probe', icon: 'radar' }))).json()
    expect(answer).toMatchObject({ words: { spaceprobe: 'radar' } })
    expect(await (await POST(request('POST', { labels: ['SpaceProbe'] }))).json()).toEqual({ SpaceProbe: { icon: 'radar', source: 'common' } })
    expect(await (await change(request('PUT', { word: 'spaceprobe', forget: true }))).json()).toMatchObject({ words: {} })
  })

  it('lists an icon to take only by name, and takes it off', async () => {
    expect(await (await change(request('PUT', { onlyByName: 'tablets', listed: true }))).json()).toMatchObject({ onlyByName: ['tablets'] })
    expect(await (await change(request('PUT', { onlyByName: 'tablets', listed: false }))).json()).toMatchObject({ onlyByName: [] })
  })

  it.each([
    [{ word: '', icon: 'radar' }, 'Name a word.'],
    [{ word: '--', icon: 'radar' }, 'Name a word.'],
    [{ word: 7, icon: 'radar' }, 'Name a word.'],
    [{ word: 'probe', icon: 'no-such-icon' }, "Name one of Lucide's icons for the word."],
    [{ word: 'probe', icon: null }, "Name one of Lucide's icons for the word."],
    [{ onlyByName: '../package', listed: true }, "Name one of Lucide's icons."],
    [{ onlyByName: 'tablets' }, 'Say whether the icon is listed.'],
    [{}, 'Give a word and its icon, or an icon to take only by name.'],
  ])('refuses to change the lists with %j', async (body, message) => {
    expect(await error(await change(request('PUT', body)))).toEqual({ status: 400, error: message })
  })

  it('refuses another site', async () => {
    expect((await lists(request('GET', undefined, { origin: 'https://example.com' }))).status).toBe(403)
    expect((await change(request('PUT', { onlyByName: 'cat', listed: true }, { origin: 'https://example.com' }))).status).toBe(403)
  })
})

describe('/api/icons/explain', () => {
  // A model that finds nothing like any icon, in place of the studio's, which would be downloaded.
  const shared = globalThis as { drivineStudioEmbed?: unknown }
  beforeEach(() => {
    shared.drivineStudioEmbed = { model: Promise.resolve(async () => new Array<number>(384).fill(0)) }
  })
  afterEach(() => {
    delete shared.drivineStudioEmbed
  })

  it("gives each label's icon, why, and the model's nearest few", async () => {
    const answer = (await (await explain(request('POST', { labels: ['GithubPerson', 'Probe'], picks: 2 }))).json()) as Record<string, { picks: unknown[] }>
    expect(answer.GithubPerson).toMatchObject({ icon: 'user', source: 'common', word: 'person', own: false })
    expect(answer.Probe).toMatchObject({ icon: null, source: 'none' })
    expect(answer.Probe?.picks).toHaveLength(2)
  })

  it.each([
    [{ labels: 'Person' }, 'Give the labels, a list of at most 500.'],
    [{ labels: ['Person'], picks: 0 }, 'Ask for 1 to 20 picks.'],
    [{ labels: ['Person'], picks: 2.5 }, 'Ask for 1 to 20 picks.'],
  ])('refuses to explain %j', async (body, message) => {
    expect(await error(await explain(request('POST', body)))).toEqual({ status: 400, error: message })
  })

  it('refuses another site', async () => {
    expect((await explain(request('POST', { labels: [] }, { origin: 'https://example.com' }))).status).toBe(403)
  })
})
