import { describe, expect, it, vi } from 'vitest'
import { start } from '../../../server/docker'
import { POST } from './route'

vi.mock('../../../server/docker', async original => ({
  ...(await original<typeof import('../../../server/docker')>()),
  start: vi.fn(async () => ({ state: 'starting', detail: '', started: 0 })),
}))

const post = (body: unknown, headers: Record<string, string>) =>
  POST(new Request('http://localhost:5187/api/docker', {
    method: 'POST',
    headers: { host: 'localhost:5187', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }))

const draft = { type: 'POSTGRES', host: 'localhost', port: '55432' }

describe('POST /api/docker', () => {
  it('starts a container only for the studio’s own pages', async () => {
    expect((await post({ action: 'start', draft }, {})).status).toBe(403)
    expect((await post({ action: 'start', draft }, { origin: 'http://evil.example' })).status).toBe(403)
    expect(start).not.toHaveBeenCalled()
    expect((await post({ action: 'start', draft }, { origin: 'http://localhost:5187' })).status).toBe(200)
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ type: 'POSTGRES', port: '55432' }))
  })

  it('asks what to do', async () => {
    expect((await post({ action: 'explode', draft }, { origin: 'http://localhost:5187' })).status).toBe(400)
  })
})
