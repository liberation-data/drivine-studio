import { readFileSync } from 'node:fs'
import neo4j from 'neo4j-driver'
import { describe, expect, it } from 'vitest'
import type { Catalog, Property, Query } from '../studio/api'
import type { Connection } from './connections'
import { StatementError } from './datasources'
import { ModelError } from './drivineModels'
import { catalog as shapes } from './fixtures/shapes'
import { GraphBuilder, loadCypher, typed } from './loads'
import type { ViewRow } from './loads'
import { parseModel } from './models'

const sample = parseModel(readFileSync(new URL('./fixtures/sample.json', import.meta.url), 'utf8'))
const inModule = <T>(entries: T[]) => entries.map(e => ({ ...e, module: sample.module }))
const catalog: Catalog = {
  models: [],
  fragments: inModule(sample.fragments),
  relationshipFragments: inModule(sample.relationshipFragments),
  views: inModule(sample.views),
  problems: [],
}
const neo: Connection = { id: 'n', name: 'Neo4j', type: 'NEO4J', host: 'h', source: 'studio' }
const falkor: Connection = { ...neo, type: 'FALKORDB' }

const ISSUE = 'org.drivine.sample.view.RaisedAndAssignedIssue'
const CAREER = 'org.drivine.sample.view.PersonCareer'
const PERSON = 'org.drivine.sample.fragment.Person'
const query = (patch: Partial<Query>): Query => ({ type: ISSUE, where: [], orderBy: [], ...patch })

describe('loadCypher', () => {
  it('writes the Cypher loadAll runs for a view: its root\'s labels, its requirements and its projection', () => {
    const { statement } = loadCypher(neo, catalog, query({ limit: 10 }))
    expect(statement).toMatch(/^MATCH \(n:Issue\)/)
    // raisedBy is required, so a root without one is left out.
    expect(statement).toContain('EXISTS { MATCH (n)-[:RAISED_BY]->(:Person:Mapped) }')
    // raisedBy is a view, PersonContext, projected with its own worksFor.
    expect(statement).toContain('rels: {worksFor:')
    expect(statement).toMatch(/LIMIT 10$/)
  })

  it('compares a root property by its stored name, with its value bound and typed', () => {
    const { statement, parameters } = loadCypher(neo, catalog, query({
      where: [{ kind: 'property', property: 'id', op: 'GTE', value: '2' }],
      orderBy: [{ property: 'title', direction: 'DESC' }],
    }))
    expect(statement).toContain('n.id >= $_q0')
    expect(statement).toContain('ORDER BY n.title DESC')
    expect(parameters).toEqual({ _q0: 2 })
  })

  it('looks along a relationship for one node that meets the conditions, or for none', () => {
    const any = loadCypher(neo, catalog, query({
      where: [{ kind: 'related', relationship: 'assignedTo', conditions: [{ kind: 'property', property: 'name', op: 'STARTS_WITH', value: 'A' }] }],
    }))
    expect(any.statement).toContain('EXISTS { MATCH (n)-[:ASSIGNED_TO]->(_x0:Person:Mapped) WHERE _x0.name STARTS WITH $_q0 }')
    const none = loadCypher(neo, catalog, query({
      where: [{ kind: 'related', relationship: 'assignedTo', none: true, conditions: [{ kind: 'property', property: 'name', op: 'EQ', value: 'Ada' }] }],
    }))
    expect(none.statement).toContain('NOT EXISTS { MATCH (n)-[:ASSIGNED_TO]->')
  })

  it('looks along a relationship fragment to the node it leads to', () => {
    const { statement } = loadCypher(neo, catalog, query({
      type: CAREER,
      where: [{ kind: 'related', relationship: 'employmentHistory', conditions: [{ kind: 'property', property: 'name', op: 'EQ', value: 'Acme' }] }],
    }))
    expect(statement).toContain('[_r1:WORKS_FOR]->(_x0:Organization) WHERE _x0.name = $_q0')
    expect(statement).toContain('{rel: properties(r1), target: {props: properties(t1), labels: labels(t1)}}')
  })

  it('loads a fragment as its properties and labels', () => {
    const { statement } = loadCypher(neo, catalog, query({ type: PERSON, limit: 5 }))
    expect(statement).toMatch(/^MATCH \(n:Person:Mapped\)/)
    expect(statement).toContain('RETURN {props: properties(n), labels: labels(n)} AS result')
  })

  it('writes for the connection\'s engine: on FalkorDB, a list of a view\'s nodes in a CALL', () => {
    expect(loadCypher(falkor, catalog, query({})).statement).toContain('CALL {')
  })

  it.each([
    [query({ type: 'org.drivine.sample.fragment.WorkHistory' }), 'is a relationship fragment, which is loaded as part of a view'],
    [query({ type: 'nowhere.Missing' }), 'No model file the studio read declares nowhere.Missing.'],
    [query({ where: [{ kind: 'property', property: 'colour', op: 'EQ', value: 'x' }] }), 'IssueCore has no property colour.'],
    [query({ where: [{ kind: 'related', relationship: 'nothing', conditions: [] }] }), 'RaisedAndAssignedIssue has no relationship nothing.'],
    [query({ type: PERSON, where: [{ kind: 'related', relationship: 'x', conditions: [] }] }), 'Person is a fragment'],
    [query({ where: [{ kind: 'property', property: 'id', op: 'EQ', value: 'one' }] }), 'id is a whole number, and "one" is not one.'],
  ])('says what is wrong with a query it cannot write: %#', (asked, message) => {
    expect(() => loadCypher(neo, catalog, asked)).toThrow(ModelError)
    expect(() => loadCypher(neo, catalog, asked)).toThrow(message)
  })

  it.each([
    [query({ type: 'Manager', where: [{ kind: 'related', relationship: 'teams', conditions: [] }] }), 'Manager.teams is a path, which a query cannot look along yet.'],
    [
      query({ type: 'Member', where: [{ kind: 'related', relationship: 'memberships', conditions: [{ kind: 'related', relationship: 'lead', conditions: [] }] }] }),
      'A condition on a related node is on one of its properties.',
    ],
    [query({ type: 'Manager', orderBy: [{ property: 'age', direction: 'ASC' }] }), 'Person has no property age.'],
  ])('says what is wrong with a condition or an order it cannot write: %#', (asked, message) => {
    expect(() => loadCypher(neo, shapes, asked)).toThrow(ModelError)
    expect(() => loadCypher(neo, shapes, asked)).toThrow(message)
  })

  it('refuses a connection that runs SQL, as the Cypher window does, before Drivine writes anything for it', () => {
    expect(() => loadCypher({ ...neo, type: 'POSTGRES' }, catalog, query({}))).toThrow(StatementError)
    expect(() => loadCypher({ ...neo, type: 'POSTGRES' }, catalog, query({}))).toThrow('On Postgres, Drivine (TypeScript) runs SQL')
  })
})

describe('typed', () => {
  const property = (type: Property['type']): Property => ({ name: 'p', stored: 'p', type, nullable: true })

  it('reads numbers and booleans', () => {
    expect(typed(property('int'), ' 42 ', true)).toBe(42)
    expect(typed(property('float'), '1.5', true)).toBe(1.5)
    expect(typed(property('boolean'), 'false', true)).toBe(false)
    expect(() => typed(property('float'), '', true)).toThrow('p is a number')
    expect(() => typed(property('boolean'), 'yes', true)).toThrow('p is true or false')
  })

  it('sends a temporal value over Bolt as the driver\'s own type, and to FalkorDB as its text', () => {
    expect(neo4j.isDateTime(typed(property('datetime'), '2024-05-01T09:30:00Z', true) as never)).toBe(true)
    expect(String(typed(property('date'), '2024-05-01', true))).toBe('2024-05-01')
    expect(neo4j.isLocalDateTime(typed(property('localDatetime'), '2024-05-01T09:30', true) as never)).toBe(true)
    expect(typed(property('date'), '2024-05-01', false)).toBe('2024-05-01')
    expect(() => typed(property('date'), 'May 1', true)).toThrow('p is a date, such as 2024-05-01')
    expect(neo4j.isLocalTime(typed(property('localTime'), '09:30', true) as never)).toBe(true)
    expect((typed(property('time'), '09:30:15-02:00', true) as { timeZoneOffsetSeconds: unknown }).timeZoneOffsetSeconds).toBe(-7200)
    expect(typed(property('time'), '09:30Z', false)).toBe('09:30Z')
    expect(() => typed(property('localTime'), '09:30Z', true)).toThrow('p is a local time')
    expect(() => typed(property('time'), '09:30', true)).toThrow('p is a time with its offset')
    // The pattern lets these through; the driver refuses them, and so does the studio, as the person's to fix.
    expect(() => typed(property('date'), '2024-13-01', true)).toThrow(ModelError)
    expect(() => typed(property('localDatetime'), '2024-05-01T25:00', true)).toThrow('p is a local date and time')
    expect(() => typed(property('localTime'), '24:00', true)).toThrow('p is a local time')
  })

  it('leaves text, and what is not text, as it is', () => {
    expect(typed(property('string'), ' Ada ', true)).toBe(' Ada ')
    expect(typed(property('int'), 7, true)).toBe(7)
  })
})

describe('GraphBuilder', () => {
  const issue = catalog.views.find(v => v.id === ISSUE)!
  const ada = { props: { uuid: 'p1', name: 'Ada' }, labels: ['Person', 'Mapped'] }
  const acme = { props: { uuid: 'o1', name: 'Acme' }, labels: ['Organization'] }
  const row = (id: number, assigned: unknown[]) => ({
    root: { props: { uuid: `i${id}`, id, title: 'T', '__drivine.stamp': 3 }, labels: ['Issue'] },
    rels: { assignedTo: assigned, raisedBy: { root: ada, rels: { worksFor: [acme] } } },
  })

  it('draws each node once, by its id, and each relationship the way it runs', () => {
    const graph = new GraphBuilder(catalog)
    const roots = [graph.view(issue, row(1, [ada])), graph.view(issue, row(2, []))]
    expect(roots).toEqual(['Issue#i1', 'Issue#i2'])
    expect(graph.nodes().map(n => [n.id, n.fragment])).toEqual([
      ['Issue#i1', 'IssueCore'], ['Mapped:Person#p1', 'Person'], ['Organization#o1', 'Organization'], ['Issue#i2', 'IssueCore'],
    ])
    expect(graph.edges().map(e => `${e.from} ${e.type} ${e.to}`).sort()).toEqual([
      'Issue#i1 ASSIGNED_TO Mapped:Person#p1',
      'Issue#i1 RAISED_BY Mapped:Person#p1',
      'Issue#i2 RAISED_BY Mapped:Person#p1',
      'Mapped:Person#p1 WORKS_FOR Organization#o1',
    ])
  })

  it('shows none of Drivine\'s own properties', () => {
    const graph = new GraphBuilder(catalog)
    graph.view(issue, row(1, []))
    expect(graph.nodes()[0]?.properties).not.toHaveProperty('__drivine.stamp')
  })

  it('names a node for the most particular subtype whose labels it carries', () => {
    const graph = new GraphBuilder(catalog)
    const webUser = catalog.fragments.find(f => f.id === 'org.drivine.sample.fragment.WebUser')!
    graph.node({ props: { uuid: 'w1' }, labels: ['WebUser', 'Anonymous'] }, webUser)
    expect(graph.nodes()[0]?.fragment).toBe('AnonymousWebUser')
  })

  it('tells apart nodes with no id by all they hold', () => {
    const graph = new GraphBuilder(catalog)
    const organization = catalog.fragments.find(f => f.id === 'org.drivine.sample.fragment.Organization')!
    const a = graph.node({ props: { name: 'A' }, labels: ['Organization'] }, organization)
    const b = graph.node({ props: { name: 'B' }, labels: ['Organization'] }, organization)
    expect(a).not.toEqual(b)
    expect(graph.node({ props: { name: 'A' }, labels: ['Organization'] }, organization)).toEqual(a)
  })
})

describe('GraphBuilder, on every shape a view projects', () => {
  const view = (id: string) => shapes.views.find(v => v.id === id)!
  const person = (uuid: string) => ({ props: { person_id: uuid, name: uuid }, labels: ['Person'] })
  const team = (name: string) => ({ props: { name }, labels: ['Team'] })
  const edges = (graph: GraphBuilder) => graph.edges().map(e => `${e.from} ${e.type} ${e.to}`).sort()

  it('draws a view that holds itself to its depth, a multi-hop list, a path, and the root\'s aggregates', () => {
    const graph = new GraphBuilder(shapes)
    const leaf = (uuid: string) => ({ root: person(uuid), rels: { manages: [], mentor: null, reports: [], teams: [], reportCount: 0, teamSize: 0 } })
    const root = graph.view(view('Manager'), {
      root: person('a'),
      rels: {
        manages: [person('b'), person('c')],
        mentor: { ...leaf('m'), rels: { ...leaf('m').rels, mentor: null } },
        reports: [leaf('b')],
        teams: [team('Core')],
        reportCount: 1,
        teamSize: 7,
      },
    } as ViewRow)
    expect(root).toBe('Person#a')
    expect(edges(graph)).toEqual([
      'Person#a MANAGES ×1..3 Person#b',
      'Person#a MANAGES ×1..3 Person#c',
      'Person#a MEMBER_OF · PART_OF Team#[["name","Core"]]',
      'Person#b REPORTS_TO Person#a',
      'Person#m MENTORS Person#a',
    ])
    expect(graph.nodes().find(n => n.id === 'Person#a')?.aggregates).toEqual({ reportCount: 1, teamSize: 7 })
  })

  it('draws a relationship fragment that leads to a view, with the relationship\'s properties, once for each', () => {
    const graph = new GraphBuilder(shapes)
    const core = { root: team('Core'), rels: { lead: person('l') } }
    graph.view(view('Member'), {
      root: person('a'),
      rels: { memberships: [{ rel: { since: '2020' }, target: core }, { rel: { since: '2024' }, target: core }] },
    } as ViewRow)
    expect(edges(graph)).toEqual([
      'Person#a MEMBER_OF Team#[["name","Core"]]',
      'Person#a MEMBER_OF Team#[["name","Core"]]',
      'Person#l LEADS Team#[["name","Core"]]',
    ])
    expect(graph.edges().filter(e => e.type === 'MEMBER_OF').map(e => e.properties)).toEqual([{ since: '2020' }, { since: '2024' }])
  })

  it('draws an undirected relationship once, from whichever end it is reached', () => {
    const friends: Catalog = {
      ...shapes,
      views: [{
        module: 'm', id: 'Friend', name: 'Friend', root: { field: 'person', fragment: 'Person' },
        relationships: [{ field: 'friends', type: 'KNOWS', direction: 'UNDIRECTED', target: 'Friend', many: true, required: false, maxDepth: 2 }],
      }],
    }
    const graph = new GraphBuilder(friends)
    graph.view(friends.views[0]!, {
      root: person('a'),
      rels: { friends: [{ root: person('b'), rels: { friends: [{ root: person('a'), rels: { friends: [] } }] } }] },
    } as ViewRow)
    expect(graph.edges()).toHaveLength(1)
    expect(graph.edges()[0]?.directed).toBe(false)
  })
})
