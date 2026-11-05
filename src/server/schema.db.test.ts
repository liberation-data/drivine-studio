import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error pg comes without its types here; the test needs only a client.
import pg from 'pg'
import { GenericContainer, Wait } from 'testcontainers'
import type { StartedTestContainer } from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Connection } from './connections'
import { forget, providerFor, run } from './datasources'
import { readSchema } from './schema'

/** Nodes in the big graph: about Graph Bench's scale 1, with four relationships each. */
const NODES = Number(process.env.DRIVINE_SCHEMA_NODES ?? 1_100_000)

describe('the schema of a graph on Postgres', () => {
  let container: StartedTestContainer
  let connection: Connection
  const sql = async (text: string) => {
    const client = new pg.Client({ host: connection.host, port: connection.port, user: 'studio', password: 'studio-test-pass', database: 'studio' })
    await client.connect()
    try {
      return (await client.query(text)).rows
    } finally {
      await client.end()
    }
  }

  beforeAll(async () => {
    process.env.DRIVINE_STUDIO_HOME = await mkdtemp(join(tmpdir(), 'studio-schema-'))
    container = await new GenericContainer('postgres:latest')
      .withEnvironment({ POSTGRES_USER: 'studio', POSTGRES_PASSWORD: 'studio-test-pass', POSTGRES_DB: 'studio' }).withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2)).start()
    connection = {
      id: 'schema-postgres', name: 'Postgres', type: 'POSTGRES', host: container.getHost(), port: container.getMappedPort(5432),
      user: 'studio', password: 'studio-test-pass', database: 'studio', source: 'studio', allowWrites: true,
    }
    // A small graph, written as the Cypher window writes, which also has Drivine make the tables.
    await run(connection, "CREATE (:Person {name: 'Keanu', born: 1964})-[:ACTED_IN {roles: ['Neo']}]->(:Movie {title: 'The Matrix'})", {}, 10, { writes: true })
  }, 400_000)

  afterAll(async () => {
    await forget(connection.id)
    await container?.stop()
  })

  it('names its labels, relationship types and property keys', async () => {
    expect(await readSchema(connection)).toEqual({
      labels: ['Movie', 'Person'], relationshipTypes: ['ACTED_IN'], propertyKeys: ['born', 'name', 'roles', 'title'],
    })
  })

  it(`answers in well under a second on ${NODES.toLocaleString()} nodes`, async () => {
    const started = performance.now()
    await sql(`INSERT INTO drivine_node (labels, props)
      SELECT jsonb_build_array((ARRAY['Issue','Comment','Person','Repo','Org','Topic'])[1 + i % 6]),
             jsonb_build_object('id', 'n' || i, 'title', 'thing ' || i, 'createdAt', i)
      FROM generate_series(1, ${NODES}) i`)
    await sql(`INSERT INTO drivine_edge (src, dst, type, props)
      SELECT n.nid, 1 + (n.nid * 7919 + k) % ${NODES}, (ARRAY['FOLLOWS','AUTHORED','OPENED','TAGGED'])[1 + k], '{}'::jsonb
      FROM drivine_node n, generate_series(0, 3) k`)
    await sql('ANALYZE drivine_node; ANALYZE drivine_edge')
    console.log(`loaded in ${Math.round(performance.now() - started)} ms`)
    const times: number[] = []
    let schema = await readSchema(connection)
    for (let i = 0; i < 5; i++) {
      const at = performance.now()
      schema = await readSchema(connection)
      times.push(Math.round(performance.now() - at))
    }
    console.log(`schema on ${NODES} nodes: ${times.join(', ')} ms`, JSON.stringify(schema))
    expect(schema.labels).toEqual(expect.arrayContaining(['Issue', 'Comment', 'Person', 'Repo', 'Org', 'Topic', 'Movie']))
    expect(schema.relationshipTypes).toEqual(expect.arrayContaining(['FOLLOWS', 'AUTHORED', 'OPENED', 'TAGGED', 'ACTED_IN']))
    expect(schema.propertyKeys).toEqual(expect.arrayContaining(['id', 'title', 'createdAt', 'name']))
    expect(Math.min(...times)).toBeLessThan(1000)
  }, 900_000)
})

describe('the schema of a graph on Oracle', () => {
  let container: StartedTestContainer
  let connection: Connection

  beforeAll(async () => {
    process.env.DRIVINE_STUDIO_HOME ??= await mkdtemp(join(tmpdir(), 'studio-schema-'))
    container = await new GenericContainer('gvenzl/oracle-free:latest-faststart')
      .withEnvironment({ ORACLE_PASSWORD: 'studio-test-pass', APP_USER: 'studio', APP_USER_PASSWORD: 'studio-test-pass' })
      .withExposedPorts(1521)
      .withWaitStrategy(Wait.forLogMessage(/DATABASE IS READY TO USE!/))
      .withStartupTimeout(300_000)
      .start()
    connection = {
      id: 'schema-oracle', name: 'Oracle', type: 'ORACLE', host: container.getHost(), port: container.getMappedPort(1521),
      user: 'studio', password: 'studio-test-pass', database: 'FREEPDB1', source: 'studio', allowWrites: true,
    }
    // Oracle's provider makes the graph's tables on its first connection, which the studio's own sessions never do.
    const first = await (await providerFor(connection)).connect()
    await first.release()
    await run(connection, "CREATE (:Person {name: 'Keanu', born: 1964})-[:ACTED_IN {roles: ['Neo']}]->(:Movie {title: 'The Matrix', `odd key`: 1})", {}, 10, { writes: true })
    // A read-only transaction begun within seconds of a table's making can't read it (ORA-01466): a graph's tables are
    // older than that, but these were just made.
    await new Promise(resolve => setTimeout(resolve, 8000))
  }, 600_000)

  afterAll(async () => {
    await forget(connection.id)
    await container?.stop()
  })

  it('names its labels, relationship types and property keys', async () => {
    const started = performance.now()
    const schema = await readSchema(connection)
    console.log(`oracle schema: ${Math.round(performance.now() - started)} ms`, JSON.stringify(schema))
    expect(schema).toEqual({
      labels: ['Movie', 'Person'], relationshipTypes: ['ACTED_IN'], propertyKeys: ['born', 'name', 'odd key', 'roles', 'title'],
    })
  }, 120_000)
})
