import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addConnection, ConnectionError, findConnection, fromEnvironment, listConnections, removeConnection, toPublic,
  updateConnection, validate,
} from './connections'

let home: string
const saved = { ...process.env }

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'studio-connections-'))
  process.env.DRIVINE_STUDIO_HOME = join(home, 'studio')
  delete process.env.DATABASE_TYPE
})

afterEach(async () => {
  process.env = { ...saved }
  await rm(home, { recursive: true, force: true })
})

const neo4j = { name: 'Local', type: 'NEO4J', host: 'localhost', port: 7687, user: 'neo4j', password: 'secret' }

describe('validate', () => {
  it('trims what it keeps, and leaves out what is empty', () => {
    expect(validate({ ...neo4j, name: ' Local ', host: ' db ', user: '', database: '  ' })).toEqual({
      name: 'Local', type: 'NEO4J', host: 'db', port: 7687, password: 'secret',
    })
  })

  it('keeps a password as typed, spaces and all', () => {
    expect(validate({ ...neo4j, password: ' pass ' }).password).toBe(' pass ')
  })

  it.each([
    [{ ...neo4j, name: '' }, 'Give the connection a name.'],
    [{ ...neo4j, type: 'MYSQL' }, 'The type must be one of'],
    [{ ...neo4j, host: ' ' }, 'Give the host'],
    [{ ...neo4j, port: 0 }, 'The port must be a whole number'],
    [{ ...neo4j, port: 7687.5 }, 'The port must be a whole number'],
    [{ ...neo4j, type: 'POSTGRES' }, 'Give the Postgres database name.'],
    [{ ...neo4j, type: 'ORACLE' }, 'Give the Oracle service name.'],
    [{ ...neo4j, user: 7 }, 'user must be text.'],
    [null, 'A connection is an object.'],
  ])('refuses %j', (input, message) => {
    expect(() => validate(input)).toThrow(ConnectionError)
    expect(() => validate(input)).toThrow(message)
  })
})

describe('the connections file', () => {
  it('starts empty, and keeps what is added, readable by its owner alone', async () => {
    expect(await listConnections()).toEqual([])
    const added = await addConnection(validate(neo4j))
    expect(await listConnections()).toEqual([added])
    const file = join(home, 'studio', 'connections.json')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(file, 'utf8')).connections[0]).not.toHaveProperty('source')
  })

  it('never shows the password, only that there is one', async () => {
    const shown = toPublic(await addConnection(validate(neo4j)))
    expect(shown).not.toHaveProperty('password')
    expect(shown.hasPassword).toBe(true)
  })

  it('keeps the password through a change that sends none, and forgets it when asked', async () => {
    const { id } = await addConnection(validate(neo4j))
    const { password: _, ...withoutPassword } = neo4j
    await updateConnection(id, validate({ ...withoutPassword, name: 'Renamed' }))
    expect(await findConnection(id)).toMatchObject({ name: 'Renamed', password: 'secret' })
    await updateConnection(id, validate({ ...withoutPassword, clearPassword: true }))
    expect((await findConnection(id)).password).toBeUndefined()
  })

  it('takes a new password over the one there, and refuses to change a connection it does not have', async () => {
    const { id } = await addConnection(validate(neo4j))
    await updateConnection(id, validate({ ...neo4j, password: 'newer' }))
    expect((await findConnection(id)).password).toBe('newer')
    await expect(updateConnection('missing', validate(neo4j))).rejects.toThrow(ConnectionError)
  })

  it('lists by name, and removes', async () => {
    const b = await addConnection(validate({ ...neo4j, name: 'B' }))
    const a = await addConnection(validate({ ...neo4j, name: 'A' }))
    expect((await listConnections()).map(c => c.name)).toEqual(['A', 'B'])
    await removeConnection(b.id)
    expect(await listConnections()).toEqual([a])
    await expect(removeConnection(b.id)).rejects.toThrow(ConnectionError)
  })

  it('makes changes one at a time, so none is lost', async () => {
    await Promise.all(['A', 'B', 'C', 'D'].map(name => addConnection(validate({ ...neo4j, name }))))
    expect((await listConnections()).map(c => c.name)).toEqual(['A', 'B', 'C', 'D'])
  })
})

describe('the environment\'s connection', () => {
  it('is read from Drivine\'s own variables, first in the list, and cannot be changed or removed', async () => {
    Object.assign(process.env, { DATABASE_TYPE: 'NEO4J', DATABASE_HOST: 'graph', DATABASE_PORT: '7688', DATABASE_PASSWORD: 'p' })
    await addConnection(validate(neo4j))
    const [first] = await listConnections()
    expect(first).toMatchObject({ id: 'environment', type: 'NEO4J', host: 'graph', port: 7688, password: 'p', source: 'environment' })
    await expect(updateConnection('environment', validate(neo4j))).rejects.toThrow(ConnectionError)
    await expect(removeConnection('environment')).rejects.toThrow(ConnectionError)
  })

  it('is absent when DATABASE_TYPE is not set', () => {
    expect(fromEnvironment({ DATABASE_HOST: 'graph' })).toBeUndefined()
  })
})
