import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addConnection, validate } from '../../../server/connections'
import { POST } from './route'

let home: string
const saved = { ...process.env }

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'studio-query-'))
  process.env.DRIVINE_STUDIO_HOME = home
  delete process.env.DATABASE_TYPE
  delete process.env.DRIVINE_STUDIO_ALLOWED_HOSTS
  await mkdir(join(home, 'repo', '.drivine'), { recursive: true })
  await writeFile(join(home, 'repo', '.drivine', 'model.json'), await readFile(new URL('../../../server/fixtures/sample.json', import.meta.url)))
  process.env.DRIVINE_STUDIO_MODELS = join(home, 'repo')
})

afterEach(async () => {
  process.env = { ...saved }
  await rm(home, { recursive: true, force: true })
})

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request('http://localhost:5187/api/query', {
    method: 'POST',
    headers: { host: 'localhost:5187', origin: 'http://localhost:5187', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }))

const answer = async (response: Response) => ({ status: response.status, error: ((await response.json()) as { error: string }).error })
const ISSUE = 'org.drivine.sample.view.RaisedAndAssignedIssue'

describe('POST /api/query', () => {
  it('refuses a page of another site', async () => {
    expect((await post({}, { origin: 'https://example.com' })).status).toBe(403)
  })

  it.each([
    [{}, 'Name a connection, and the view or fragment to load.'],
    [{ connection: 'c' }, 'Name a connection, and the view or fragment to load.'],
    [{ connection: 'c', query: { type: ISSUE, where: 'x' } }, 'The conditions and the order are lists.'],
    [{ connection: 'c', query: { type: ISSUE, limit: 0 } }, 'The limit is a whole number from 1 to 1000.'],
    [{ connection: 'c', query: { type: ISSUE, limit: 1001 } }, 'The limit is a whole number from 1 to 1000.'],
    [{ connection: 'c', query: { type: ISSUE } }, 'There is no connection c.'],
  ])('answers %j with a 400', async (body, error) => {
    expect(await answer(await post(body))).toEqual({ status: 400, error })
  })

  it('says what the model files lack, as a 400, before connecting', async () => {
    const { id } = await addConnection(validate({ name: 'Nowhere', type: 'NEO4J', host: 'nowhere.invalid', user: 'neo4j' }))
    expect(await answer(await post({ connection: id, query: { type: 'nowhere.Missing' } }))).toEqual({
      status: 400, error: 'No model file the studio read declares nowhere.Missing.',
    })
    expect(await answer(await post({ connection: id, query: { type: ISSUE, where: [{ kind: 'property', property: 'id', op: 'EQ', value: 'x' }] } })))
      .toEqual({ status: 400, error: 'id is a whole number, and "x" is not one.' })
  })
})
