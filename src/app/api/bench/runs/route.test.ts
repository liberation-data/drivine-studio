import { describe, expect, it } from 'vitest'
import { POST } from './route'
import { DELETE, GET } from './[id]/route'

const request = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
  new Request(`http://localhost:5187${path}`, {
    method,
    headers: { host: 'localhost:5187', 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const own = { origin: 'http://localhost:5187' }
const id = (value: string) => ({ params: Promise.resolve({ id: value }) })
const answer = async (response: Response) => ({ status: response.status, error: ((await response.json()) as { error: string }).error })

describe('/api/bench/runs', () => {
  it('starts a run only for the studio’s own pages', async () => {
    expect((await POST(request('POST', '/api/bench/runs', {}, { connections: ['a'], queries: ['q'] }))).status).toBe(403)
    expect((await POST(request('POST', '/api/bench/runs', { origin: 'https://example.com' }, { connections: ['a'], queries: ['q'] }))).status).toBe(403)
  })

  it('says what is wrong with a run’s settings, as a 400', async () => {
    expect(await answer(await POST(request('POST', '/api/bench/runs', own, { connections: [], queries: ['q'] })))).toEqual({ status: 400, error: 'Choose a connection to run on.' })
  })

  it('knows of no run it didn’t start, to read or to stop', async () => {
    expect(await answer(await GET(request('GET', '/api/bench/runs/nope', own), id('nope')))).toEqual({ status: 404, error: 'There is no such bench run.' })
    expect(await answer(await DELETE(request('DELETE', '/api/bench/runs/nope', own), id('nope')))).toEqual({ status: 404, error: 'There is no bench run of that id going on.' })
  })
})
