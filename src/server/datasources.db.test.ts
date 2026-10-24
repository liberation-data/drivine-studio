import { GenericContainer, Wait } from 'testcontainers'
import type { StartedTestContainer } from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

  it('writes nothing', async () => {
    await expect(run(connection, "CREATE (:Intruder {name: 'x'})")).rejects.toThrow()
    expect((await run(connection, 'MATCH (n:Intruder) RETURN count(n) AS n')).rows).toEqual([[{ kind: 'value', value: 0 }]])
  })
})
