import { readFileSync } from 'node:fs'
import { GenericContainer, Wait } from 'testcontainers'
import type { StartedTestContainer } from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Catalog, Query } from '../studio/api'
import type { Connection } from './connections'
import { forget } from './datasources'
import { load } from './loads'
import { parseModel } from './models'

// Loads of the sample domain's model file against real databases, in Docker: `npm run test:db`.

const sample = parseModel(readFileSync(new URL('./fixtures/sample.json', import.meta.url), 'utf8'))
const inModule = <T>(entries: T[]) => entries.map(e => ({ ...e, module: sample.module }))
const catalog: Catalog = {
  models: [],
  fragments: inModule(sample.fragments),
  relationshipFragments: inModule(sample.relationshipFragments),
  views: inModule(sample.views),
  problems: [],
}

const SEED = `
  CREATE (ada:Person:Mapped {uuid: 'p1', name: 'Ada'}), (grace:Person:Mapped {uuid: 'p2', name: 'Grace'}),
         (acme:Organization {uuid: 'o1', name: 'Acme'}),
         (ada)-[:WORKS_FOR {role: 'Engineer'}]->(acme),
         (i1:Issue {uuid: 'i1', id: 1, title: 'Engine stalls', state: 'open'}),
         (i2:Issue {uuid: 'i2', id: 2, title: 'Docs', state: 'closed'}),
         (i3:Issue {uuid: 'i3', id: 3, title: 'Nobody raised this', state: 'open'}),
         (i1)-[:ASSIGNED_TO]->(grace), (i1)-[:RAISED_BY]->(ada), (i2)-[:RAISED_BY]->(grace)`

const ISSUE = 'org.drivine.sample.view.RaisedAndAssignedIssue'
const query = (patch: Partial<Query>): Query => ({ type: ISSUE, where: [], orderBy: [{ property: 'id', direction: 'ASC' }], ...patch })

/** The same loads, whichever database holds the sample. */
function loads(connection: () => Connection) {
  it('loads a view, leaving out a root without the relationship it requires', async () => {
    const result = await load(connection(), catalog, query({}))
    expect(result.count).toBe(2)
    expect(result.graph.roots).toEqual(['Issue#i1', 'Issue#i2'])
    const edges = result.graph.edges.map(e => `${e.from} ${e.type} ${e.to}`).sort()
    expect(edges).toEqual([
      'Issue#i1 ASSIGNED_TO Mapped:Person#p2',
      'Issue#i1 RAISED_BY Mapped:Person#p1',
      'Issue#i2 RAISED_BY Mapped:Person#p2',
      'Mapped:Person#p1 WORKS_FOR Organization#o1',
    ])
    expect(result.cypher.statement).toMatch(/^MATCH \(n:Issue\)/)
  })

  it('filters on the root and along a relationship, as the query asks', async () => {
    const result = await load(connection(), catalog, query({
      where: [
        { kind: 'property', property: 'id', op: 'LTE', value: '2' },
        { kind: 'related', relationship: 'assignedTo', conditions: [{ kind: 'property', property: 'name', op: 'EQ', value: 'Grace' }] },
      ],
    }))
    expect(result.graph.roots).toEqual(['Issue#i1'])
  })

  it('finds the roots none of whose related nodes meet the conditions', async () => {
    const result = await load(connection(), catalog, query({
      where: [{ kind: 'related', relationship: 'assignedTo', none: true, conditions: [{ kind: 'property', property: 'name', op: 'EQ', value: 'Grace' }] }],
    }))
    expect(result.graph.roots).toEqual(['Issue#i2'])
  })

  it('orders and limits the roots, and says when the limit may have stopped it', async () => {
    const result = await load(connection(), catalog, query({ orderBy: [{ property: 'id', direction: 'DESC' }], limit: 1 }))
    expect(result.graph.roots).toEqual(['Issue#i2'])
    expect(result.truncated).toBe(true)
  })

  it('loads a fragment', async () => {
    const result = await load(connection(), catalog, { type: 'org.drivine.sample.fragment.Person', where: [], orderBy: [{ property: 'name', direction: 'ASC' }] })
    expect(result.graph.nodes.map(n => n.properties.name)).toEqual(['Ada', 'Grace'])
    expect(result.graph.edges).toEqual([])
  })
}

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
      id: 'loads-neo4j', name: 'Neo4j', type: 'NEO4J', host: container.getHost(), port: container.getMappedPort(7687),
      user: 'neo4j', password: 'studio-test-pass', source: 'studio',
    }
    await container.exec(['cypher-shell', '-u', 'neo4j', '-p', 'studio-test-pass', SEED])
  }, 180_000)

  afterAll(async () => {
    await forget('loads-neo4j')
    await container?.stop()
  })

  loads(() => connection)
})

describe('on FalkorDB', () => {
  let container: StartedTestContainer
  let connection: Connection

  beforeAll(async () => {
    container = await new GenericContainer('falkordb/falkordb:latest').withExposedPorts(6379).withWaitStrategy(Wait.forListeningPorts()).start()
    connection = { id: 'loads-falkor', name: 'FalkorDB', type: 'FALKORDB', host: container.getHost(), port: container.getMappedPort(6379), database: 'sample', source: 'studio' }
    await container.exec(['redis-cli', 'GRAPH.QUERY', 'sample', SEED.replace(/\s+/g, ' ')])
  }, 180_000)

  afterAll(async () => {
    await forget('loads-falkor')
    await container?.stop()
  })

  loads(() => connection)
})
