import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GenericContainer, Wait } from 'testcontainers'
import type { StartedTestContainer } from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Dataset, Scale } from './benchData'
import { beginLoad, loadBatch, loadedInto, SMALLEST } from './benchLoad'
import type { LoadBatch, LoadJob } from './benchLoad'
import type { Connection } from './connections'
import { forget, readRows } from './datasources'

// Graph Bench's dataset, loaded through Drivine into real databases, in Docker: `npm run test:db`.

const data = new Dataset(new Scale(SMALLEST))
const edgesOf = (type: string) => [...data.edges.find(e => e.type === type)!.pairs()].length
const EDGES = data.edges.reduce((n, set) => n + [...set.pairs()].length, 0)

let home: string
const saved = process.env.DRIVINE_STUDIO_HOME
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'studio-bench-load-'))
  process.env.DRIVINE_STUDIO_HOME = home
})
afterAll(async () => {
  if (saved === undefined) delete process.env.DRIVINE_STUDIO_HOME
  else process.env.DRIVINE_STUDIO_HOME = saved
  await rm(home, { recursive: true, force: true })
})

async function finished(started: LoadBatch): Promise<LoadJob> {
  for (;;) {
    const now = loadBatch(started.id)!
    if (now.state !== 'running') return now.loads[0]!
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

const count = async (connection: Connection, statement: string) => Number((await readRows(connection, statement, {}, 1, v => v)).rows[0]![0])

function loads(connection: () => Connection) {
  it('loads every node and relationship Graph Bench makes, and remembers it', async () => {
    const done = await finished(await beginLoad([connection()], SMALLEST))
    expect(done.error).toBeUndefined()
    expect(done.state).toBe('done')
    expect(done.loaded!.load).toMatchObject({ nodes: data.scale.nodes, edges: EDGES })
    expect((await loadedInto())[connection().id]).toMatchObject({ scale: SMALLEST })
  }, 600_000)

  it('reads back the graph that was loaded', async () => {
    expect(await count(connection(), 'MATCH (n:Comment) RETURN count(n)')).toBe(data.scale.comments)
    expect(await count(connection(), 'MATCH (:Person)-[:FOLLOWS]->(p:Person) RETURN count(p)')).toBe(edgesOf('FOLLOWS'))
    expect(await count(connection(), 'MATCH (i:Issue)-[:IN_REPO]->(r:Repo) WHERE i.repoKey = r.id RETURN count(i)')).toBe(data.scale.issues)
    expect(await count(connection(), "MATCH (p:Person {id: 'p0'}) RETURN p.karma")).toBe([...data.nodes('Person')][0]!.karma)
  })

  it('refuses to load twice into the same graph', async () => {
    await expect(beginLoad([connection()], SMALLEST)).rejects.toThrow(/already/)
  })
}

function onStore(name: string, start: () => Promise<{ container: StartedTestContainer; connection: Connection }>) {
  describe(`on ${name}`, () => {
    let container: StartedTestContainer
    let connection: Connection
    beforeAll(async () => {
      ;({ container, connection } = await start())
    }, 400_000)
    afterAll(async () => {
      await forget(connection.id)
      await container?.stop()
    })
    loads(() => connection)
  })
}

onStore('Neo4j', async () => {
  const container = await new GenericContainer('neo4j:latest')
    .withEnvironment({ NEO4J_AUTH: 'neo4j/studio-test-pass' }).withExposedPorts(7687)
    .withWaitStrategy(Wait.forLogMessage(/Started\./)).start()
  return {
    container,
    connection: {
      id: 'bench-neo4j', name: 'Neo4j', type: 'NEO4J', host: container.getHost(), port: container.getMappedPort(7687),
      user: 'neo4j', password: 'studio-test-pass', source: 'studio', allowWrites: true,
    },
  }
})

onStore('FalkorDB', async () => {
  const container = await new GenericContainer('falkordb/falkordb:latest').withExposedPorts(6379).withWaitStrategy(Wait.forListeningPorts()).start()
  return {
    container,
    connection: { id: 'bench-falkor', name: 'FalkorDB', type: 'FALKORDB', host: container.getHost(), port: container.getMappedPort(6379), database: 'bench', source: 'studio', allowWrites: true },
  }
})

onStore('Postgres', async () => {
  const container = await new GenericContainer('postgres:latest')
    .withEnvironment({ POSTGRES_USER: 'studio', POSTGRES_PASSWORD: 'studio-test-pass', POSTGRES_DB: 'studio' }).withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2)).start()
  return {
    container,
    connection: {
      id: 'bench-postgres', name: 'Postgres', type: 'POSTGRES', host: container.getHost(), port: container.getMappedPort(5432),
      user: 'studio', password: 'studio-test-pass', database: 'studio', source: 'studio', allowWrites: true,
    },
  }
})

onStore('Oracle', async () => {
  const container = await new GenericContainer('gvenzl/oracle-free:latest-faststart')
    .withEnvironment({ ORACLE_PASSWORD: 'studio-test-pass', APP_USER: 'studio', APP_USER_PASSWORD: 'studio-test-pass' }).withExposedPorts(1521)
    .withWaitStrategy(Wait.forLogMessage(/DATABASE IS READY TO USE!/)).withStartupTimeout(300_000).start()
  return {
    container,
    connection: {
      id: 'bench-oracle', name: 'Oracle', type: 'ORACLE', host: container.getHost(), port: container.getMappedPort(1521),
      user: 'studio', password: 'studio-test-pass', database: 'FREEPDB1', source: 'studio', allowWrites: true,
    },
  }
})
