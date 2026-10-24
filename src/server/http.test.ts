import { describe, expect, it } from 'vitest'
import { ConnectionError } from './connections'
import { StatementError } from './datasources'
import { failure, foreign } from './http'

const request = (headers: Record<string, string>) => new Request('http://localhost:5187/api/cypher', { method: 'POST', headers })

describe('foreign', () => {
  it('answers the studio\'s own pages, and calls that name no origin', () => {
    expect(foreign(request({ host: 'localhost:5187', origin: 'http://localhost:5187' }), {})).toBeUndefined()
    expect(foreign(request({ host: '127.0.0.1:5187' }), {})).toBeUndefined()
    expect(foreign(request({ host: '[::1]:5187', origin: 'http://[::1]:5187' }), {})).toBeUndefined()
  })

  it('refuses a page of another site', async () => {
    const refused = foreign(request({ host: 'localhost:5187', origin: 'https://example.com' }), {})
    expect(refused?.status).toBe(403)
    expect(foreign(request({ host: 'localhost:5187', origin: 'http://localhost:9999' }), {})?.status).toBe(403)
    expect(foreign(request({ host: 'localhost:5187', origin: 'null' }), {})?.status).toBe(403)
  })

  it('refuses a host it is not served on, as a name pointed at this machine is', async () => {
    const refused = foreign(request({ host: 'attacker.example:5187', origin: 'http://attacker.example:5187' }), {})
    expect(refused?.status).toBe(403)
    expect(((await refused?.json()) as { error: string }).error).toContain('DRIVINE_STUDIO_ALLOWED_HOSTS')
  })

  it('answers the hosts DRIVINE_STUDIO_ALLOWED_HOSTS names, in place of localhost', () => {
    const env = { DRIVINE_STUDIO_ALLOWED_HOSTS: 'studio.internal, Other' }
    expect(foreign(request({ host: 'studio.internal', origin: 'https://studio.internal' }), env)).toBeUndefined()
    expect(foreign(request({ host: 'other:80' }), env)).toBeUndefined()
    expect(foreign(request({ host: 'localhost:5187' }), env)?.status).toBe(403)
  })
})

describe('failure', () => {
  const answer = async (e: unknown) => {
    const response = failure(e)
    return { status: response.status, error: ((await response.json()) as { error: string }).error }
  }

  it('answers what the person can fix as a 400', async () => {
    expect(await answer(new ConnectionError('Give the host.'))).toEqual({ status: 400, error: 'Give the host.' })
    expect(await answer(new StatementError('No statement.'))).toEqual({ status: 400, error: 'No statement.' })
    const syntax = Object.assign(new Error('Invalid input'), { code: 'Neo.ClientError.Statement.SyntaxError' })
    expect(await answer(syntax)).toEqual({ status: 400, error: 'Invalid input' })
  })

  it('says why a write was refused', async () => {
    const write = Object.assign(new Error('Writing in read access mode not allowed.'), { code: 'Neo.ClientError.Statement.AccessMode' })
    const { status, error } = await answer(write)
    expect(status).toBe(400)
    expect(error).toMatch(/^The studio reads and never writes.*Writing in read access mode not allowed\.$/)
  })

  it('answers the database or the network failing as a 502, with what it said', async () => {
    expect(await answer(Object.assign(new Error(''), { code: 'ECONNREFUSED' }))).toEqual({ status: 502, error: 'ECONNREFUSED' })
    expect(await answer(new Error('Service unavailable'))).toEqual({ status: 502, error: 'Service unavailable' })
  })
})
