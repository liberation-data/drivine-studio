import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { check } from './datasources'
import { containerOf, dockerHere, draftOf, portHere, start, stop } from './docker'

// What `docker` answers, by its arguments: the test sets it, and every call is recorded.
type Answer = { code: number; out?: string; err?: string; enoent?: boolean }
let answer: (args: string[]) => Answer
const calls: string[][] = []

vi.mock('node:child_process', () => ({
  spawn: (_command: string, args: string[]) => {
    calls.push(args)
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() })
    const given = answer(args)
    setTimeout(() => {
      if (given.enoent) {
        child.emit('error', Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }))
        return
      }
      if (given.out) child.stdout.emit('data', Buffer.from(given.out))
      if (given.err) child.stderr.emit('data', Buffer.from(given.err))
      child.emit('close', given.code)
    }, 0)
    return child
  },
}))

// The database is not there to answer: what the start asks of `check` is what is tested.
vi.mock('./datasources', async original => ({
  ...(await original<typeof import('./datasources')>()),
  check: vi.fn(async () => ({ milliseconds: 1 })),
  forget: vi.fn(async () => undefined),
}))

const inspected = (running: boolean, labels: Record<string, string> | null, port: string) =>
  JSON.stringify([{ State: { Running: running }, Config: { Labels: labels }, HostConfig: { PortBindings: { '5432/tcp': [{ HostPort: port }] } } }])

// On a port nothing here listens on: the start looks before it runs anything.
const postgres = { type: 'POSTGRES' as const, host: 'localhost', port: '', user: 'studio', password: 'secret', database: 'studio' }

beforeAll(async () => {
  const server = createServer().listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  postgres.port = String((server.address() as AddressInfo).port)
  await new Promise(resolve => server.close(resolve))
})

/** Docker up, with these containers and images; anything else it is asked succeeds. */
const dockerWith = ({ container, image = true, run }: { container?: string; image?: boolean; run?: Answer }) => (args: string[]): Answer => {
  if (args[0] === 'version') return { code: 0, out: '27.0.0' }
  if (args[0] === 'container' && args[1] === 'inspect') return container ? { code: 0, out: container } : { code: 1, err: 'No such container' }
  if (args[0] === 'image' && args[1] === 'inspect') return { code: image ? 0 : 1 }
  if (args[0] === 'run' && run) return run
  return { code: 0 }
}

beforeEach(() => {
  calls.length = 0
  vi.mocked(check).mockClear()
  answer = dockerWith({})
})

describe('whether Docker is here', () => {
  it('says how to install it, or start it', async () => {
    answer = () => ({ code: -1, enoent: true })
    expect(await dockerHere()).toMatchObject({ kind: 'absent', why: expect.stringMatching(/not installed/) })
    answer = () => ({ code: 1, err: 'Cannot connect to the Docker daemon' })
    expect(await dockerHere()).toMatchObject({ kind: 'absent', why: expect.stringMatching(/not running/) })
  })
})

describe('a container, as docker inspect gives it', () => {
  it('is running or stopped, the studio’s or not, on the port it was made for', () => {
    expect(containerOf(JSON.parse(inspected(true, { 'org.drivine.studio': '1' }, '55432')), { inside: 5432 })).toEqual({ kind: 'running', ours: true, port: 55432 })
    expect(containerOf(JSON.parse(inspected(false, null, '5432')), { inside: 5432 })).toEqual({ kind: 'stopped', ours: false, port: 5432 })
    expect(containerOf([], { inside: 5432 })).toEqual({ kind: 'missing' })
  })
})

describe('starting one', () => {
  it('downloads the image when it is not here, runs the container, and waits until the database answers', async () => {
    answer = dockerWith({ image: false })
    const job = await start(postgres)
    await vi.waitFor(() => expect(job.state).toBe('ready'))
    expect(calls).toContainEqual(['pull', 'pgvector/pgvector:pg16'])
    const run = calls.find(args => args[0] === 'run')
    expect(run).toEqual(expect.arrayContaining(['--name', 'drivine-postgres', '--label', 'org.drivine.studio=1', '-p', `${postgres.port}:5432`, 'POSTGRES_PASSWORD=secret']))
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ type: 'POSTGRES', host: 'localhost', port: Number(postgres.port), user: 'studio', password: 'secret', database: 'studio' }))
  })

  it('starts the studio’s stopped container again, as it is', async () => {
    answer = dockerWith({ container: inspected(false, { 'org.drivine.studio': '1' }, postgres.port) })
    const job = await start({ ...postgres, user: 'ada' })
    await vi.waitFor(() => expect(job.state).toBe('ready'))
    expect(calls).toContainEqual(['start', 'drivine-postgres'])
    expect(calls.some(args => args[0] === 'run')).toBe(false)
  })

  it('leaves alone a container it did not make, and one made for another port', async () => {
    answer = dockerWith({ container: inspected(true, null, postgres.port) })
    await expect(start(postgres)).rejects.toThrow(/did not make/)
    answer = dockerWith({ container: inspected(false, { 'org.drivine.studio': '1' }, '5432') })
    await expect(start(postgres)).rejects.toThrow(/made for port 5432/)
  })

  it('says when the port is taken', async () => {
    answer = dockerWith({ run: { code: 125, err: 'Bind for 0.0.0.0:55432 failed: port is already allocated' } })
    // Taken between the look and the start: Docker's own refusal says the same.
    const job = await start(postgres)
    await vi.waitFor(() => expect(job.state).toBe('failed'))
    expect(job.error).toMatch(`Port ${postgres.port} is in use by something else on this machine`)
  })

  it('takes no type it does not know', () => {
    expect(() => draftOf({ type: 'MYSQL' })).toThrow(/no database of type MYSQL/)
  })
})

describe('stopping and removing', () => {
  it('stops or removes only the studio’s own', async () => {
    answer = dockerWith({ container: inspected(true, { 'org.drivine.studio': '1' }, '55432') })
    await stop(postgres, false)
    expect(calls).toContainEqual(['stop', 'drivine-postgres'])
    await stop(postgres, true)
    expect(calls).toContainEqual(['rm', '-f', 'drivine-postgres'])
    calls.length = 0
    answer = dockerWith({ container: inspected(true, null, '55432') })
    await expect(stop(postgres, true)).rejects.toThrow(/did not make/)
    expect(calls.some(args => args[0] === 'rm')).toBe(false)
  })
})

describe('a port something else holds', () => {
  const held = async () => {
    const server = createServer().listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    return { server, port: (server.address() as AddressInfo).port }
  }

  it('is said to be taken, by the container that publishes it when there is one', async () => {
    const { server, port } = await held()
    try {
      answer = args => (args[0] === 'ps' ? { code: 0, out: 'drivine-studio-pg\n' } : { code: 0 })
      expect(await portHere(port, true)).toEqual({ kind: 'taken', by: 'the container drivine-studio-pg' })
      answer = args => (args[0] === 'ps' ? { code: 0, out: '' } : { code: 0 })
      expect(await portHere(port, true)).toEqual({ kind: 'taken', by: null })
    } finally {
      server.close()
    }
    expect(await portHere(port, true)).toEqual({ kind: 'free' })
  })

  it('stops a start before anything is downloaded', async () => {
    const { server, port } = await held()
    try {
      answer = dockerWith({ image: false })
      await expect(start({ ...postgres, port: String(port) })).rejects.toThrow(`Port ${port} is in use by something else on this machine`)
      expect(calls.some(args => args[0] === 'pull' || args[0] === 'run')).toBe(false)
    } finally {
      server.close()
    }
  })
})
