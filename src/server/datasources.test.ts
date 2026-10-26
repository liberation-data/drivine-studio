import { DatabaseRegistry, DatabaseType } from '@liberation-data/drivine'
import neo4j from 'neo4j-driver'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionError } from './connections'
import type { Connection } from './connections'
import { boltParameters, forget, run, StatementError } from './datasources'

describe('run', () => {
  it.each([
    ['POSTGRES', "CREATE (:Intruder {name: 'x'})"],
    ['POSTGRES', "MATCH (p:Person) SET p.name = 'x' RETURN p"],
    ['POSTGRES', 'MATCH (p) DETACH DELETE p'],
    ['ORACLE', "MERGE (:Intruder {name: 'x'})"],
    ['ORACLE', 'MATCH (p) CALL { WITH p REMOVE p:Person } RETURN p'],
    ['ORACLE', "MATCH (p) RETURN p.name AS n UNION MATCH (q) FOREACH (x IN [1] | SET q.x = x) RETURN q.name AS n"],
  ] as const)('refuses a statement that writes on %s, before connecting: %s', async (type, statement) => {
    const connection: Connection = { id: type, name: type, type, host: 'nowhere.invalid', database: 'db', source: 'studio' }
    await expect(run(connection, statement)).rejects.toThrow(StatementError)
    await expect(run(connection, statement)).rejects.toThrow(/^The studio reads and never writes.* a statement that writes .* is not sent\.$/)
  })

  it.each(['POSTGRES', 'ORACLE'] as const)('says where a statement is not Cypher, or is Cypher Drivine does not compile, on %s, before connecting', async type => {
    const connection: Connection = { id: type, name: type, type, host: 'nowhere.invalid', database: 'db', source: 'studio' }
    await expect(run(connection, 'MATCH (n RETURN n')).rejects.toThrow(StatementError)
    await expect(run(connection, 'MATCH (n RETURN n')).rejects.toThrow(/not Cypher, at line 1/)
    await expect(run(connection, 'CALL apoc.help("x") YIELD name RETURN name')).rejects.toThrow(StatementError)
    // A UNION is compiled whole by the studio, but what is wrong with one is said as Drivine's compiler says it.
    await expect(run(connection, 'MATCH (n) RETURN n UNION MATCH (m) RETURN m')).rejects.toThrow(StatementError)
    await expect(run(connection, 'MATCH (n) RETURN n UNION MATCH (m) RETURN m')).rejects.toThrow(/Each query of a UNION returns the same names/)
  })

  it('never connects on Oracle as Drivine\'s provider does, which makes the graph\'s tables, if it cannot find the pool', async () => {
    const connection: Connection = { id: 'oracle-no-pool', name: 'Oracle', type: 'ORACLE', host: 'nowhere.invalid', database: 'db', source: 'studio' }
    const probe = DatabaseRegistry.getInstance().builder().withType(DatabaseType.ORACLE).host('nowhere.invalid').databaseName('db')
      .register('oracle-no-pool-probe')
    const Provider = Object.getPrototypeOf(probe) as { poolOf?: unknown; connect: () => Promise<unknown> }
    const poolOf = Provider.poolOf
    const connect = vi.spyOn(Provider, 'connect')
    delete Provider.poolOf
    try {
      await expect(run(connection, 'MATCH (n) RETURN n')).rejects.toThrow(/keeps its Oracle pool where the studio cannot find it/)
      expect(connect).not.toHaveBeenCalled()
    } finally {
      Provider.poolOf = poolOf
      connect.mockRestore()
      await forget(connection.id)
      await probe.end()
    }
  })

  it.each([
    ['POSTGRES', { code: '25006' }],
    ['ORACLE', { errorNum: 1456 }],
  ] as const)('says a write the read-only transaction turned down on %s is the studio\'s doing, and rolls back', async (type, refusal) => {
    const connection: Connection = { id: `${type}-refuses`, name: type, type, host: 'nowhere.invalid', database: 'db', source: 'studio' }
    const probe = DatabaseRegistry.getInstance().builder().withType(type as DatabaseType).host('nowhere.invalid').databaseName('db')
      .register(`${type}-refuses-probe`)
    const Provider = Object.getPrototypeOf(probe) as Record<string, unknown>
    const write = Object.assign(new Error('cannot execute INSERT in a read-only transaction'), refusal)
    const rollback = vi.fn(async () => undefined)
    // Postgres's session is Drivine's connection; Oracle's is oracledb's own, from the pool, which the studio wraps.
    const spy = type === 'POSTGRES'
      ? vi.spyOn(Provider as { connect: () => Promise<unknown> }, 'connect').mockResolvedValue({
        startTransaction: async () => undefined,
        query: async () => [],
        openCursor: async () => Promise.reject(write),
        rollbackTransaction: rollback,
        release: async () => undefined,
      })
      : vi.spyOn(Provider as { poolOf: () => Promise<unknown> }, 'poolOf').mockResolvedValue({
        getConnection: async () => ({
          execute: vi.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(write),
          rollback,
          close: async () => undefined,
        }),
      })
    try {
      await expect(run(connection, 'MATCH (n) RETURN n')).rejects.toThrow(StatementError)
      await expect(run(connection, 'MATCH (n) RETURN n')).rejects.toThrow(/^The studio reads and never writes.* read-only transaction$/)
      expect(rollback).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
      await forget(connection.id)
      await probe.end()
    }
  })

  it('says it does not know a type the environment names wrongly, rather than calling it Postgres', async () => {
    const connection = { id: 'environment', name: 'Env', type: 'neo4j', host: 'nowhere.invalid', source: 'environment' } as unknown as Connection
    await expect(run(connection, 'RETURN 1')).rejects.toThrow(StatementError)
    await expect(run(connection, 'RETURN 1')).rejects.toThrow(/neo4j/)
    await expect(run(connection, 'RETURN 1')).rejects.not.toThrow(/Postgres/)
  })
})

describe('run, with nothing to run', () => {
  it('says so, before connecting', async () => {
    const connection: Connection = { id: 'blank', name: 'Blank', type: 'NEO4J', host: 'nowhere.invalid', source: 'studio' }
    await expect(run(connection, ' \n ')).rejects.toThrow(new StatementError('There is no statement to run.'))
  })
})

describe('run, on a connection Drivine will not build', () => {
  it('says what to fix, as the person\'s to fix, before connecting', async () => {
    const connection: Connection = { id: 'no-user', name: 'No user', type: 'NEO4J', host: 'nowhere.invalid', source: 'studio' }
    await expect(run(connection, 'RETURN 1')).rejects.toThrow(ConnectionError)
    await expect(run(connection, 'RETURN 1')).rejects.toThrow(/username/)
  })
})

describe('boltParameters', () => {
  it('sends a whole number as an integer, everywhere in the parameters, and anything else as it is', () => {
    const sent = boltParameters({ born: 1815, ratio: 1.5, names: ['Ada'], nested: { ids: [1, 2] }, none: null })
    expect(neo4j.isInt(sent.born)).toBe(true)
    expect(sent.ratio).toBe(1.5)
    expect(sent.names).toEqual(['Ada'])
    expect(sent.nested.ids.every((id: unknown) => neo4j.isInt(id))).toBe(true)
    expect(sent.none).toBeNull()
  })
})
