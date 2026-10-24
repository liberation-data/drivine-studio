import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { answers, waitForServer } from './server-start.cjs'

let server = null

const listen = (handler = (_, response) => response.end()) =>
  new Promise(resolve => {
    server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })

// A port nothing listens on: one the system gave out and took back.
const freeUrl = async () => {
  const url = await listen()
  await new Promise(resolve => server.close(resolve))
  server = null
  return url
}

afterEach(async () => {
  server?.closeAllConnections()
  if (server) await new Promise(resolve => server.close(resolve))
  server = null
})

describe('answers', () => {
  it('is true when a server is listening', async () => {
    expect(await answers(await listen())).toBe(true)
  })

  it('is false when nothing is', async () => {
    expect(await answers(await freeUrl())).toBe(false)
  })

  it('is false, rather than waiting for ever, when a server takes the connection but never answers', async () => {
    const url = await listen(() => {})
    expect(await answers(url, 100)).toBe(false)
  })
})

describe('waitForServer', () => {
  it('resolves once the server answers', async () => {
    await expect(waitForServer(await listen(), { timeoutMs: 1000, intervalMs: 10 })).resolves.toBeUndefined()
  })

  it('fails at the timeout when nothing answers', async () => {
    await expect(waitForServer(await freeUrl(), { timeoutMs: 100, intervalMs: 10 })).rejects.toThrow(/did not answer/)
  })

  it('fails at the timeout when a server takes the connection but never answers', async () => {
    const started = Date.now()
    await expect(waitForServer(await listen(() => {}), { timeoutMs: 200, intervalMs: 10 })).rejects.toThrow(/did not answer/)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('fails as soon as the server has stopped, not at the timeout', async () => {
    const url = await freeUrl()
    const started = Date.now()
    await expect(
      waitForServer(url, { timeoutMs: 10000, intervalMs: 10, stopped: () => 'The studio server exited with code 1' }),
    ).rejects.toThrow('exited with code 1')
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
