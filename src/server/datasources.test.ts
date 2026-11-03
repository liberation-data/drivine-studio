import { DatabaseRegistry, DatabaseType } from '@liberation-data/drivine'
import neo4j from 'neo4j-driver'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionError } from './connections'
import type { Connection } from './connections'
import { boltParameters, falkorCounts, forget, run, StatementError } from './datasources'

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

describe('run, where it may write', () => {
  /** A Postgres connection whose provider gives the session asked for, and Drivine's provider of it to end after. */
  async function onPostgres(id: string, session: Record<string, unknown>) {
    const connection: Connection = { id, name: id, type: 'POSTGRES', host: 'nowhere.invalid', database: 'db', source: 'studio' }
    const probe = DatabaseRegistry.getInstance().builder().withType(DatabaseType.POSTGRES).host('nowhere.invalid').databaseName('db')
      .register(`${id}-probe`)
    const Provider = Object.getPrototypeOf(probe) as { connect: () => Promise<unknown> }
    const spy = vi.spyOn(Provider, 'connect').mockResolvedValue({
      startTransaction: async () => undefined,
      release: async () => undefined,
      ...session,
    })
    return {
      connection,
      done: async () => {
        spy.mockRestore()
        await forget(id)
        await probe.end()
      },
    }
  }

  it('runs a statement that writes on Postgres as Drivine compiles it, commits it, and names what it returns', async () => {
    const query = vi.fn(async () => [[{ name: 'Ada' }, 1]])
    const commit = vi.fn(async () => undefined)
    const rollback = vi.fn(async () => undefined)
    const { connection, done } = await onPostgres('postgres-writes', { query, commitTransaction: commit, rollbackTransaction: rollback })
    try {
      const result = await run(connection, "CREATE (n:Person {name: $name}) RETURN n, 1 AS one", { name: 'Ada' }, 10, { writes: true })
      expect(query).toHaveBeenCalledOnce()
      const [spec] = query.mock.calls[0] as unknown as [{ statement: { text: string; language: string }; parameters: unknown }]
      expect(spec.statement).toEqual({ text: 'CREATE (n:Person {name: $name}) RETURN n, 1 AS one', language: 'CYPHER' })
      expect(spec.parameters).toEqual({ name: 'Ada' })
      expect(commit).toHaveBeenCalledOnce()
      expect(rollback).not.toHaveBeenCalled()
      expect(result.columns).toEqual(['n', 'one'])
      expect(result.rows).toEqual([[{ kind: 'map', entries: [{ key: 'name', value: { kind: 'value', value: 'Ada' } }] }, { kind: 'value', value: 1 }]])
      expect(result.written).toEqual({ counts: null })
    } finally {
      await done()
    }
  })

  it('gives a write\'s rows of one item each as a row of its own, a list among them, and stops at the limit', async () => {
    const query = vi.fn(async () => [{ name: 'Ada' }, [1, 2], { name: 'Cy' }])
    const commit = vi.fn(async () => undefined)
    const { connection, done } = await onPostgres('postgres-writes-limit', { query, commitTransaction: commit, rollbackTransaction: async () => undefined })
    try {
      const result = await run(connection, 'UNWIND [1, 2, 3] AS i CREATE (n:Person) RETURN n', {}, 2, { writes: true })
      expect(commit).toHaveBeenCalledOnce()
      expect(result.columns).toEqual(['n'])
      expect(result.rows).toEqual([
        [{ kind: 'map', entries: [{ key: 'name', value: { kind: 'value', value: 'Ada' } }] }],
        [{ kind: 'list', items: [{ kind: 'value', value: 1 }, { kind: 'value', value: 2 }] }],
      ])
      expect(result.truncated).toBe(true)
    } finally {
      await done()
    }
  })

  it('rolls back a write that fails, and commits nothing', async () => {
    const commit = vi.fn(async () => undefined)
    const rollback = vi.fn(async () => undefined)
    const query = vi.fn(async () => Promise.reject(Object.assign(new Error('division by zero'), { code: '22012' })))
    const { connection, done } = await onPostgres('postgres-write-fails', { query, commitTransaction: commit, rollbackTransaction: rollback })
    try {
      await expect(run(connection, 'CREATE (n {x: 1 / 0})', {}, 10, { writes: true })).rejects.toThrow(StatementError)
      expect(commit).not.toHaveBeenCalled()
      expect(rollback).toHaveBeenCalledOnce()
    } finally {
      await done()
    }
  })

  it('says a refusal to write is the database\'s, not the studio\'s, where the statement may write', async () => {
    const refusal = Object.assign(new Error('cannot execute INSERT in a read-only transaction'), { code: '25006' })
    const query = vi.fn(async () => Promise.reject(refusal))
    const { connection, done } = await onPostgres('postgres-write-refused', {
      query, commitTransaction: async () => undefined, rollbackTransaction: async () => undefined,
    })
    try {
      const failed = run(connection, 'CREATE (n:Person)', {}, 10, { writes: true })
      await expect(failed).rejects.toThrow(StatementError)
      await expect(failed).rejects.toThrow(/^cannot execute INSERT in a read-only transaction$/)
    } finally {
      await done()
    }
  })

  it('gives a write\'s RETURN * as one value, named *', async () => {
    const query = vi.fn(async () => [{ n: { name: 'Ada' } }])
    const { connection, done } = await onPostgres('postgres-writes-star', {
      query, commitTransaction: async () => undefined, rollbackTransaction: async () => undefined,
    })
    try {
      const result = await run(connection, "CREATE (n:Person {name: 'Ada'}) RETURN *", {}, 10, { writes: true })
      expect(result.columns).toEqual(['*'])
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0]).toHaveLength(1)
    } finally {
      await done()
    }
  })

  it('still runs a statement that only reads read-only, and rolls it back, with nothing said to be written', async () => {
    const query = vi.fn(async (_spec: { statement: { text: string } }) => [])
    const commit = vi.fn(async () => undefined)
    const rollback = vi.fn(async () => undefined)
    const cursor = { close: async () => undefined, async *[Symbol.asyncIterator]() { yield { result: [1] } } }
    const { connection, done } = await onPostgres('postgres-writes-reads', {
      query, openCursor: async () => cursor, commitTransaction: commit, rollbackTransaction: rollback,
    })
    try {
      const result = await run(connection, 'RETURN 1 AS one', {}, 10, { writes: true })
      expect(result.rows).toEqual([[{ kind: 'value', value: 1 }]])
      expect(result).not.toHaveProperty('written')
      expect(query.mock.calls.map(([spec]) => spec.statement.text)).toEqual(['SET TRANSACTION READ ONLY'])
      expect(commit).not.toHaveBeenCalled()
      expect(rollback).toHaveBeenCalledOnce()
    } finally {
      await done()
    }
  })

  it('runs over Bolt in a write session, commits, and counts every change, where it may write; in a read session, rolled back, where not', async () => {
    const connection: Connection = { id: 'bolt-writes', name: 'Neo4j', type: 'NEO4J', host: 'nowhere.invalid', user: 'neo4j', password: 'x', source: 'studio' }
    const probe = neo4j.driver('bolt://nowhere.invalid')
    const commit = vi.fn(async () => undefined)
    const rollback = vi.fn(async () => undefined)
    const modes: unknown[] = []
    const spy = vi.spyOn(Object.getPrototypeOf(probe) as { session: (config: unknown) => unknown }, 'session').mockImplementation(config => {
      modes.push((config as { defaultAccessMode: unknown }).defaultAccessMode)
      return {
        close: async () => undefined,
        beginTransaction: () => ({
          commit,
          rollback,
          run: () => ({
            keys: async () => ['one'],
            async *[Symbol.asyncIterator]() { yield { get: () => 1 } },
            summary: async () => ({ counters: { updates: () => ({ nodesCreated: 2, propertiesSet: 1, indexesAdded: 0 }) } }),
          }),
        }),
      }
    })
    try {
      const written = await run(connection, 'CREATE (n), (m) SET n.x = 1 RETURN 1 AS one', {}, 10, { writes: true })
      expect(written.rows).toEqual([[{ kind: 'value', value: 1 }]])
      expect(written.written).toEqual({
        counts: { nodesCreated: 2, nodesDeleted: 0, relationshipsCreated: 0, relationshipsDeleted: 0, propertiesSet: 1, labelsAdded: 0, labelsRemoved: 0 },
      })
      expect(commit).toHaveBeenCalledOnce()
      expect(rollback).not.toHaveBeenCalled()
      const read = await run(connection, 'RETURN 1 AS one')
      expect(read).not.toHaveProperty('written')
      expect(commit).toHaveBeenCalledOnce()
      expect(rollback).toHaveBeenCalledOnce()
      expect(modes).toEqual([neo4j.session.WRITE, neo4j.session.READ])
    } finally {
      spy.mockRestore()
      await probe.close()
      await forget(connection.id)
    }
  })

  it('runs FalkorDB\'s query that may write, and says what it changed, where it may write; its read-only query where not', async () => {
    const connection: Connection = { id: 'falkor-writes', name: 'FalkorDB', type: 'FALKORDB', host: 'nowhere.invalid', source: 'studio' }
    const probe = DatabaseRegistry.getInstance().builder().withType(DatabaseType.FALKORDB).host('nowhere.invalid').register('falkor-writes-probe')
    const reply = { data: [{ one: 1 }], metadata: ['Nodes created: 1', 'Query internal execution time: 0.1 milliseconds'] }
    const query = vi.fn(async () => reply)
    const roQuery = vi.fn(async () => reply)
    const spy = vi.spyOn(Object.getPrototypeOf(probe) as { connect: () => Promise<unknown> }, 'connect')
      .mockResolvedValue({ graph: { query, roQuery }, release: async () => undefined })
    const built = () => (globalThis as { drivineStudioProviders?: { built: number } }).drivineStudioProviders?.built
    try {
      const written = await run({ ...connection, allowWrites: true }, 'CREATE (n) RETURN 1 AS one', {}, 10, { writes: true })
      expect(query).toHaveBeenCalledOnce()
      expect(roQuery).not.toHaveBeenCalled()
      expect(written.rows).toEqual([[{ kind: 'value', value: 1 }]])
      expect(written.written).toEqual({ counts: { nodesCreated: 1 } })
      // The setting alone does not let a statement write, as a connection's test and the Canvas's loads run it.
      const read = await run({ ...connection, allowWrites: true }, 'RETURN 1 AS one')
      expect(roQuery).toHaveBeenCalledOnce()
      expect(query).toHaveBeenCalledOnce()
      expect(read).not.toHaveProperty('written')
      const before = built()
      await run(connection, 'RETURN 1 AS one')
      // Whether a connection allows writes is not the provider's: turning it off keeps the provider.
      expect(built()).toBe(before)
    } finally {
      spy.mockRestore()
      await forget(connection.id)
      await probe.end()
    }
  })

  it('says, before connecting, where Drivine does not compile a statement that writes', async () => {
    const connection: Connection = { id: 'pg-no-compile', name: 'Postgres', type: 'POSTGRES', host: 'nowhere.invalid', database: 'db', source: 'studio' }
    await expect(run(connection, 'CREATE (n) RETURN apoc.x(n)', {}, 10, { writes: true })).rejects.toThrow(StatementError)
    await forget(connection.id)
  })
})

describe('falkorCounts', () => {
  it('reads what FalkorDB says it changed, and leaves out its other lines', () => {
    expect(falkorCounts([
      'Labels added: 1', 'Nodes created: 2', 'Properties set: 3', 'Relationships created: 1', 'Nodes deleted: 4',
      'Relationships deleted: 5', 'Labels removed: 6', 'Cached execution: 0', 'Query internal execution time: 0.31 milliseconds',
    ])).toEqual({
      labelsAdded: 1, nodesCreated: 2, propertiesSet: 3, relationshipsCreated: 1, nodesDeleted: 4, relationshipsDeleted: 5, labelsRemoved: 6,
    })
    expect(falkorCounts(['Query internal execution time: 0.1 milliseconds'])).toEqual({})
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

describe('connecting a result’s nodes', () => {
  it('asks each store by its own ids: elementId on Neo4j, id() as a number elsewhere, as text on Neptune', async () => {
    const { connecting } = await import('./datasources')
    expect(connecting('NEO4J', ['4:a:1', '4:a:2'])).toEqual({
      statement: 'MATCH (a)-[r]->(b) WHERE elementId(a) IN $ids AND elementId(b) IN $ids RETURN r',
      parameters: { ids: ['4:a:1', '4:a:2'] },
    })
    expect(connecting('POSTGRES', ['14', '15', 'x'])).toEqual({
      statement: 'MATCH (a)-[r]->(b) WHERE id(a) IN $ids AND id(b) IN $ids RETURN r',
      parameters: { ids: [14, 15] },
    })
    expect(connecting('NEPTUNE', ['a', 'b']).parameters).toEqual({ ids: ['a', 'b'] })
  })
})
