import {
  DatabaseRegistry, DatabaseType, OracleConnection, PostgresConnection, PostgresGraph, QuerySpecification,
} from '@liberation-data/drivine'
import type { Connection as DrivineConnection } from '@liberation-data/drivine'
import { GenericContainer, Wait } from 'testcontainers'
import type { StartedTestContainer } from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Connection } from './connections'
import { check, forget, run, StatementError } from './datasources'

// Against real databases, in Docker: `npm run test:db`. Each on :latest, so a change in one shows here first.

describe('on Neo4j', () => {
  let container: StartedTestContainer
  let connection: Connection

  beforeAll(async () => {
    container = await new GenericContainer('neo4j:latest')
      .withEnvironment({ NEO4J_AUTH: 'neo4j/studio-test-pass' })
      .withExposedPorts(7687)
      .withWaitStrategy(Wait.forLogMessage(/Started\./))
      .start()
    connection = {
      id: 'neo4j-test', name: 'Neo4j', type: 'NEO4J', host: container.getHost(), port: container.getMappedPort(7687),
      user: 'neo4j', password: 'studio-test-pass', source: 'studio',
    }
    await container.exec(['cypher-shell', '-u', 'neo4j', '-p', 'studio-test-pass',
      "CREATE (a:Person {name: 'Ada', born: 1815})-[:KNOWS {since: 1833}]->(:Person {name: 'Charles'}), (a)-[:WROTE]->(:Note {title: 'Notes'})"])
  }, 180_000)

  afterAll(async () => {
    await forget('neo4j-test')
    await container?.stop()
  })

  it('answers a test', async () => {
    expect((await check(connection)).milliseconds).toBeGreaterThanOrEqual(0)
  })

  it('gives rows, and the graph in them', async () => {
    const result = await run(connection, 'MATCH p = (a:Person)-[:KNOWS]->(b) RETURN p, a.name AS name ORDER BY name')
    expect(result.columns).toEqual(['p', 'name'])
    expect(result.rows[0]?.[1]).toEqual({ kind: 'value', value: 'Ada' })
    expect(result.graph.nodes.map(n => n.properties.name).sort()).toEqual(['Ada', 'Charles'])
    expect(result.graph.relationships).toMatchObject([{ type: 'KNOWS', properties: { since: 1833 } }])
    expect(result.truncated).toBe(false)
  })

  it('binds a whole number as an integer, which an integer property equals', async () => {
    const result = await run(connection, 'MATCH (p:Person {born: $born}) RETURN p.name', { born: 1815 })
    expect(result.rows).toEqual([[{ kind: 'value', value: 'Ada' }]])
  })

  it('reads no more than the limit, and says so', async () => {
    const result = await run(connection, 'UNWIND range(1, 10) AS i RETURN i', {}, 3)
    expect(result.rows).toHaveLength(3)
    expect(result.truncated).toBe(true)
  })

  it('writes nothing, whatever the statement', async () => {
    await expect(run(connection, "CREATE (:Intruder {name: 'x'})")).rejects.toMatchObject({ code: 'Neo.ClientError.Statement.AccessMode' })
    await expect(run(connection, "MATCH (p:Person {name: 'Ada'}) SET p.name = 'Changed'")).rejects.toThrow()
    const after = await run(connection, "MATCH (n) WHERE n:Intruder OR n.name = 'Changed' RETURN count(n)")
    expect(after.rows).toEqual([[{ kind: 'value', value: 0 }]])
  })

  it('says what is wrong with a statement', async () => {
    await expect(run(connection, 'MATCH (n RETURN n')).rejects.toMatchObject({ code: 'Neo.ClientError.Statement.SyntaxError' })
    await expect(run(connection, '  ')).rejects.toThrow(StatementError)
  })

  it('builds a new provider when the connection changes', async () => {
    await expect(run({ ...connection, password: 'wrong-password' }, 'RETURN 1')).rejects.toThrow()
    expect((await run(connection, 'RETURN 1')).rows).toEqual([[{ kind: 'value', value: 1 }]])
  })
})

describe('on FalkorDB', () => {
  let container: StartedTestContainer
  let connection: Connection

  beforeAll(async () => {
    container = await new GenericContainer('falkordb/falkordb:latest').withExposedPorts(6379).withWaitStrategy(Wait.forListeningPorts()).start()
    connection = { id: 'falkor-test', name: 'FalkorDB', type: 'FALKORDB', host: container.getHost(), port: container.getMappedPort(6379), database: 'studio', source: 'studio' }
    await container.exec(['redis-cli', 'GRAPH.QUERY', 'studio', "CREATE (:Person {name: 'Ada'})-[:KNOWS]->(:Person {name: 'Charles'})"])
  }, 180_000)

  afterAll(async () => {
    await forget('falkor-test')
    await container?.stop()
  })

  it('gives rows, and the graph in them', async () => {
    const result = await run(connection, 'MATCH (a)-[r:KNOWS]->(b) RETURN a, r, b.name AS name')
    expect(result.columns).toEqual(['a', 'r', 'name'])
    expect(result.graph.nodes.find(n => !n.partial)?.properties).toEqual({ name: 'Ada' })
    expect(result.graph.relationships).toMatchObject([{ type: 'KNOWS' }])
  })

  it('writes nothing, and says why', async () => {
    await expect(run(connection, "CREATE (:Intruder {name: 'x'})")).rejects.toThrow(StatementError)
    await expect(run(connection, "CREATE (:Intruder {name: 'x'})")).rejects.toThrow(/^The studio reads and never writes/)
    expect((await run(connection, 'MATCH (n:Intruder) RETURN count(n) AS n')).rows).toEqual([[{ kind: 'value', value: 0 }]])
  })

  it('reads no more than the limit, and says so', async () => {
    const result = await run(connection, 'UNWIND range(1, 10) AS i RETURN i', {}, 3)
    expect(result.rows).toHaveLength(3)
    expect(result.truncated).toBe(true)
  })

  it('binds parameters, and refuses a name FalkorDB would read as part of the statement', async () => {
    expect((await run(connection, 'MATCH (p:Person {name: $name}) RETURN p.name AS name', { name: 'Ada' })).rows).toEqual([[{ kind: 'value', value: 'Ada' }]])
    // FalkorDB's client writes each name into the statement as it is: this one would make it return 99.
    const changes = run(connection, 'RETURN $one AS one', { one: 1, 'x=1 RETURN 99 AS one //': 2 })
    await expect(changes).rejects.toThrow(StatementError)
    await expect(changes).rejects.toThrow(/letters, digits and underscores/)
    await expect(run(connection, 'RETURN $one AS one', { one: { 'not a name': 1 } })).rejects.toThrow(/letters, digits and underscores/)
  })

  it('says what is wrong with a statement, and that a graph is not there', async () => {
    await expect(run(connection, 'MATCH (n RETURN n')).rejects.toThrow(StatementError)
    const missing = { ...connection, id: 'falkor-missing', database: 'nothing-here' }
    await expect(check(missing)).rejects.toThrow(StatementError)
    await expect(check(missing)).rejects.toThrow(/no graph nothing-here/)
    await forget('falkor-missing')
  })
})

/**
 * Postgres and Oracle, where Drivine compiles the Cypher to SQL. The graph is written with Drivine's own compiled
 * Cypher, as an application writes it, on a provider of the test's own, since the studio never writes.
 */
function onSqlStore(
  type: 'POSTGRES' | 'ORACLE',
  start: () => Promise<{ container: StartedTestContainer; connection: Connection }>,
  prepare: (session: DrivineConnection) => Promise<void>,
  Session: typeof PostgresConnection | typeof OracleConnection,
) {
  describe(`on ${type === 'POSTGRES' ? 'Postgres' : 'Oracle'}`, () => {
    let container: StartedTestContainer
    let connection: Connection
    const counts = async () =>
      (await run(connection, 'MATCH (n) OPTIONAL MATCH (n)-[r]->() RETURN count(DISTINCT n) AS nodes, count(r) AS relationships')).rows

    beforeAll(async () => {
      ;({ container, connection } = await start())
      const builder = DatabaseRegistry.getInstance().builder().withType(type as DatabaseType).host(connection.host)
        .port(connection.port!).userName(connection.user!).password(connection.password!).databaseName(connection.database!)
      const provider = builder.register(`seed-${type}`)
      const session = await provider.connect()
      try {
        await prepare(session)
        await session.query(new QuerySpecification().withStatement({
          text: "CREATE (k:Person {name: 'Keanu', born: 1964})-[:ACTED_IN {role: 'Neo'}]->(m:Movie {title: 'The Matrix'}), " +
            "(c:Person {name: 'Carrie', born: 1967})-[:ACTED_IN {role: 'Trinity'}]->(m), (k)-[:KNOWS]->(c)-[:KNOWS]->(:Person {name: 'Hugo'})",
          language: 'CYPHER',
        }))
      } finally {
        await session.release()
        await provider.end()
      }
      // A read-only transaction on Oracle refuses a table made a moment before it (ORA-01466), as the graph's just were.
      if (type === 'ORACLE') await new Promise(resolve => setTimeout(resolve, 5_000))
    }, 600_000)

    afterAll(async () => {
      await forget(connection.id)
      await container?.stop()
    })

    it('answers a test', async () => {
      expect((await check(connection)).milliseconds).toBeGreaterThanOrEqual(0)
    })

    it('gives the nodes and relationships a statement returns, with their ids, labels and ends, as a graph', async () => {
      const result = await run(connection, 'MATCH (p:Person)-[r:ACTED_IN]->(m:Movie) RETURN p, r, m ORDER BY p.name')
      expect(result.columns).toEqual(['p', 'r', 'm'])
      expect(result.rows).toHaveLength(2)
      const [p, r, m] = result.rows[0]!
      expect(p).toMatchObject({ kind: 'node', node: { labels: ['Person'], properties: { name: 'Carrie', born: 1967 } } })
      expect(m).toMatchObject({ kind: 'node', node: { labels: ['Movie'], properties: { title: 'The Matrix' } } })
      expect(r).toMatchObject({ kind: 'relationship', relationship: { type: 'ACTED_IN', properties: { role: 'Trinity' } } })
      if (p?.kind !== 'node' || m?.kind !== 'node' || r?.kind !== 'relationship') throw new Error('Not a graph.')
      expect([r.relationship.from, r.relationship.to]).toEqual([p.node.id, m.node.id])
      expect(result.graph.nodes.map(n => n.properties.name ?? n.properties.title).sort()).toEqual(['Carrie', 'Keanu', 'The Matrix'])
      expect(result.graph.nodes.some(n => n.partial)).toBe(false)
      expect(result.graph.relationships).toHaveLength(2)
    })

    it('names a star\'s variables as Drivine orders them, by name before the items, each with its own value', async () => {
      const result = await run(connection, "MATCH (m:Movie)<-[r:ACTED_IN]-(p:Person {name: 'Keanu'}) RETURN *, m.title AS title")
      expect(result.columns).toEqual(['m', 'p', 'r', 'title'])
      expect(result.rows[0]).toMatchObject([
        { kind: 'node', node: { labels: ['Movie'] } },
        { kind: 'node', node: { labels: ['Person'] } },
        { kind: 'relationship', relationship: { type: 'ACTED_IN' } },
        { kind: 'value', value: 'The Matrix' },
      ])
    })

    it('gives values as rows, and no graph', async () => {
      const result = await run(connection, 'MATCH (a:Person)-[:KNOWS*1..2]->(b) RETURN a.name, b.name ORDER BY a.name, b.name')
      expect(result.columns).toEqual(['a.name', 'b.name'])
      expect(result.rows.map(row => row.map(c => (c.kind === 'value' ? c.value : c.kind)))).toEqual([
        ['Carrie', 'Hugo'], ['Keanu', 'Carrie'], ['Keanu', 'Hugo'],
      ])
      expect(result.graph).toEqual({ nodes: [], relationships: [] })
    })

    it('gives a path whole, and a list of nodes', async () => {
      const result = await run(connection, "MATCH p = (:Person {name: 'Keanu'})-[:KNOWS*2]->(b) RETURN p, nodes(p) AS ns")
      const [path, nodes] = result.rows[0]!
      expect(path).toMatchObject({
        kind: 'path',
        nodes: [{ properties: { name: 'Keanu' } }, { properties: { name: 'Carrie' } }, { properties: { name: 'Hugo' } }],
        relationships: [{ type: 'KNOWS' }, { type: 'KNOWS' }],
      })
      expect(nodes).toMatchObject({ kind: 'list', items: [{ kind: 'node' }, { kind: 'node' }, { kind: 'node' }] })
      expect(result.graph.relationships).toHaveLength(2)
    })

    it('gives a UNION whole, a row given twice once, and every row of a UNION ALL', async () => {
      const keanu = "MATCH (p:Person {name: 'Keanu'}) RETURN p"
      const union = await run(connection, `${keanu} UNION ${keanu}`)
      expect(union.columns).toEqual(['p'])
      expect(union.rows).toMatchObject([[{ kind: 'node', node: { labels: ['Person'], properties: { name: 'Keanu' } } }]])
      expect((await run(connection, `${keanu} UNION ALL ${keanu}`)).rows).toHaveLength(2)
    })

    it('says a value the statement could not take is the statement\'s to fix', async () => {
      await expect(run(connection, 'RETURN 1 / 0 AS x')).rejects.toThrow(StatementError)
    })

    it('gives a node grouped by and counted, or one OPTIONAL MATCH did not find, whole or as null', async () => {
      const counted = await run(connection, 'MATCH (p:Person)-[:ACTED_IN]->(m) RETURN m, count(p) AS actors')
      expect(counted.columns).toEqual(['m', 'actors'])
      expect(counted.rows).toMatchObject([[{ kind: 'node', node: { labels: ['Movie'] } }, { kind: 'value', value: 2 }]])
      const missing = await run(connection, "MATCH (h:Person {name: 'Hugo'}) OPTIONAL MATCH (h)-[r:KNOWS]->(x) RETURN h, r, x")
      expect(missing.rows).toMatchObject([[{ kind: 'node' }, { kind: 'null' }, { kind: 'null' }]])
    })

    it('binds parameters', async () => {
      expect((await run(connection, 'MATCH (p:Person {born: $born}) RETURN p.name AS name', { born: 1964 })).rows).toEqual([[{ kind: 'value', value: 'Keanu' }]])
    })

    it('reads no more than the limit, and says so', async () => {
      const result = await run(connection, 'UNWIND range(1, 10) AS i RETURN i', {}, 3)
      expect(result.rows).toEqual([[{ kind: 'value', value: 1 }], [{ kind: 'value', value: 2 }], [{ kind: 'value', value: 3 }]])
      expect(result.truncated).toBe(true)
    })

    it('writes nothing: a statement that writes is not sent, and what is sent runs read-only and is rolled back', async () => {
      const before = await counts()
      for (const statement of ["CREATE (:Intruder {name: 'x'})", "MATCH (p:Person) SET p.name = 'Changed'", 'MATCH (n) DETACH DELETE n']) {
        await expect(run(connection, statement)).rejects.toThrow(StatementError)
        await expect(run(connection, statement)).rejects.toThrow(/^The studio reads and never writes/)
      }
      expect(await counts()).toEqual(before)
      const query = vi.spyOn(Session.prototype, 'query')
      const rollback = vi.spyOn(Session.prototype, 'rollbackTransaction')
      const commit = vi.spyOn(Session.prototype, 'commitTransaction')
      try {
        await run(connection, 'MATCH (n) RETURN n')
        expect(query.mock.calls.map(([spec]) => spec.statement.text)).toEqual(['SET TRANSACTION READ ONLY'])
        expect(rollback).toHaveBeenCalledOnce()
        expect(commit).not.toHaveBeenCalled()
      } finally {
        vi.restoreAllMocks()
      }
    })

    it('says what is wrong with a statement, and that a graph is not there, without making it', async () => {
      await expect(run(connection, 'MATCH (n RETURN n')).rejects.toThrow(StatementError)
      const missing = { ...connection, id: `${type}-missing`, graph: 'nothing_here' }
      try {
        await expect(check(missing)).rejects.toThrow(StatementError)
        // Asked again, it is still not there: the studio made no tables for it.
        await expect(check(missing)).rejects.toThrow(/no graph nothing_here/)
      } finally {
        await forget(missing.id)
      }
    })
  })
}

onSqlStore(
  'POSTGRES',
  async () => {
    const container = await new GenericContainer('postgres:latest')
      .withEnvironment({ POSTGRES_USER: 'studio', POSTGRES_PASSWORD: 'studio-test-pass', POSTGRES_DB: 'studio' })
      .withExposedPorts(5432)
      // Ready once for the init scripts, then again for good.
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start()
    return {
      container,
      connection: {
        id: 'postgres-test', name: 'Postgres', type: 'POSTGRES', host: container.getHost(), port: container.getMappedPort(5432),
        user: 'studio', password: 'studio-test-pass', database: 'studio', source: 'studio',
      },
    }
  },
  // On Postgres an object manager makes the graph's tables, as an application's would.
  async session => void (await session.query(new QuerySpecification(new PostgresGraph('drivine').ensuring))),
  PostgresConnection,
)

onSqlStore(
  'ORACLE',
  async () => {
    const container = await new GenericContainer('gvenzl/oracle-free:latest-faststart')
      .withEnvironment({ ORACLE_PASSWORD: 'studio-test-pass', APP_USER: 'studio', APP_USER_PASSWORD: 'studio-test-pass' })
      .withExposedPorts(1521)
      .withWaitStrategy(Wait.forLogMessage(/DATABASE IS READY TO USE!/))
      .withStartupTimeout(300_000)
      .start()
    return {
      container,
      connection: {
        id: 'oracle-test', name: 'Oracle', type: 'ORACLE', host: container.getHost(), port: container.getMappedPort(1521),
        user: 'studio', password: 'studio-test-pass', database: 'FREEPDB1', source: 'studio',
      },
    }
  },
  // Oracle's provider makes the graph's tables on its first connection.
  async () => undefined,
  OracleConnection,
)
