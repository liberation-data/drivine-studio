import {
  Aggregate, AggregateFunction, backendFor, DatabaseType, Direction, FalkorDbSpecCompiler, GraphPath, GraphProperty, GraphRelationship, GraphView, hop,
  ModelRegistry, Neo4jSpecCompiler, NodeFragment, NodeId, RelationshipFragment, Root, TargetNode,
} from '@liberation-data/drivine'
import type { TargetModel } from '@liberation-data/drivine'
import { describe, expect, it } from 'vitest'
import { DrivineModels } from './drivineModels'
import { catalog } from './fixtures/shapes'

// The domain of fixtures/shapes, declared with Drivine's decorators: the Cypher Drivine writes for each class must be
// the same as for the studio's models of the file's entries.

/** Applies decorators to a field, with the type TypeScript would record for it. */
function field(type: Function, name: string, designType: Function, ...decorators: PropertyDecorator[]) {
  Reflect.defineMetadata('design:type', designType, type.prototype, name)
  for (const decorate of decorators) decorate(type.prototype, name)
}

class Person {}
NodeFragment({ labels: ['Person'] })(Person)
field(Person, 'name', String)
field(Person, 'uuid', String, NodeId(), GraphProperty('person_id'))

class Team {}
NodeFragment({ labels: ['Team'] })(Team)
field(Team, 'name', String)

class Manager {}
GraphView()(Manager)
field(Manager, 'manages', Array, GraphRelationship({ type: 'MANAGES', target: () => Person, maxDepth: 3 }))
field(Manager, 'mentor', Object, GraphRelationship({ type: 'MENTORS', direction: Direction.INCOMING, target: () => Manager, maxDepth: 2 }))
field(Manager, 'person', Person, Root())
field(Manager, 'reports', Array, GraphRelationship({ type: 'REPORTS_TO', direction: Direction.INCOMING, target: () => Manager, maxDepth: 2, required: true }))
field(Manager, 'teams', Array, GraphPath([hop('MEMBER_OF'), hop('PART_OF', Direction.OUTGOING, 'Team', 'name', false)], { target: () => Team }))
field(Manager, 'reportCount', Number, Aggregate({ function: AggregateFunction.COUNT, type: 'REPORTS_TO', direction: Direction.INCOMING }))
field(Manager, 'teamSize', Number, Aggregate({ function: AggregateFunction.SUM, type: 'MEMBER_OF', property: 'size' }))

class Membership {}
RelationshipFragment()(Membership)
field(Membership, 'since', String)
field(Membership, 'team', Object, TargetNode(() => TeamView))

class TeamView {}
GraphView()(TeamView)
field(TeamView, 'lead', Object, GraphRelationship({ type: 'LEADS', direction: Direction.INCOMING, target: () => Person }))
field(TeamView, 'team', Team, Root())

class Member {}
GraphView()(Member)
field(Member, 'memberships', Array, GraphRelationship({ type: 'MEMBER_OF', target: () => Membership }))
field(Member, 'person', Person, Root())

const statement = (type: DatabaseType, target: TargetModel) => {
  const backend = backendFor(type)
  const built = target.kind === 'GRAPH_VIEW' ? backend.loadAllViews(target.model) : backend.loadAllFragments(target.model)
  const spec = built.spec({}).finalizedCopy('CYPHER')
  return (type === DatabaseType.FALKORDB ? new FalkorDbSpecCompiler(spec) : new Neo4jSpecCompiler(spec)).compile().statement
}

describe('DrivineModels', () => {
  const registry = new ModelRegistry()

  it.each([
    ['Manager', Manager],
    ['Member', Member],
    ['TeamView', TeamView],
  ] as const)('builds %s as ModelRegistry does, so that Drivine writes the same Cypher for it', (id, type) => {
    for (const engine of [DatabaseType.NEO4J, DatabaseType.FALKORDB, DatabaseType.MEMGRAPH]) {
      expect(statement(engine, new DrivineModels(catalog).target(id))).toBe(
        statement(engine, { kind: 'GRAPH_VIEW', model: registry.view(type) }),
      )
    }
  })

  it('builds a fragment as ModelRegistry does', () => {
    const built = new DrivineModels(catalog).target('Person')
    expect(statement(DatabaseType.NEO4J, built)).toBe(statement(DatabaseType.NEO4J, { kind: 'NODE_FRAGMENT', model: registry.fragment(Person) }))
    expect(built.kind === 'NODE_FRAGMENT' && built.model.nodeIdProperty).toBe('person_id')
  })

  it('marks a list of fragments read over several hops read-only, as ModelRegistry does', () => {
    const built = new DrivineModels(catalog).target('Manager')
    const ours = built.kind === 'GRAPH_VIEW' ? built.model.relationships.map(r => [r.field, r.readOnly]) : []
    expect(ours).toEqual(registry.view(Manager).relationships.map(r => [r.field, r.readOnly]))
    // And the shapes the comparison above is of are in the Cypher.
    const cypher = statement(DatabaseType.NEO4J, built)
    for (const shape of ['[:MANAGES*1..3]', 'REPORTS_TO', '-[:PART_OF]->', 'size(', 'reduce(s = 0']) expect(cypher).toContain(shape)
  })
})
