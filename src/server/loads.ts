import { backendFor, FalkorDbSpecCompiler, Neo4jSpecCompiler } from '@liberation-data/drivine'
import type { Condition as DslCondition, DatabaseType, Page, RootRefs } from '@liberation-data/drivine'
import neo4j from 'neo4j-driver'
import type {
  Catalog, Condition, Fragment, GraphEdge, GraphNode, Property, Query, Relationship, Result, View,
} from '../studio/api'
import type { Connection } from './connections'
import { readRows } from './datasources'
import { DrivineModels, ModelError } from './drivineModels'
import { plain } from './values'

/** The most roots a load reads, past which a graph is too many to draw. */
export const MAX_ROOTS = 1000

/**
 * Loads a view or a fragment as `loadAll` would: Drivine (TypeScript) writes the Cypher, from Drivine's own models
 * of the model files' entries and its own query DSL, so the studio runs what an application's load runs. What comes
 * back is drawn as a graph.
 */
export async function load(connection: Connection, catalog: Catalog, query: Query): Promise<Result> {
  const cypher = loadCypher(connection, catalog, query)
  const limit = query.limit ?? MAX_ROOTS
  const read = await readRows(connection, cypher.statement, cypher.parameters, limit, plain)
  const rows = read.rows.map(row => row[0])
  const graph = new GraphBuilder(catalog)
  const view = catalog.views.find(v => v.id === query.type)
  const fragment = catalog.fragments.find(f => f.id === query.type)
  const roots = rows.map(row => (view ? graph.view(view, row as ViewRow) : graph.node(row as FragmentRow, fragment!)))
  return {
    graph: { nodes: graph.nodes(), edges: graph.edges(), roots: [...new Set(roots)] },
    count: rows.length,
    limit,
    truncated: rows.length >= limit,
    cypher: { statement: cypher.statement, parameters: plain(cypher.parameters) as Record<string, unknown> },
  }
}

/** The Cypher `loadAll` runs for the query on this connection's database, with its parameters as it binds them. */
export function loadCypher(connection: Connection, catalog: Catalog, query: Query): { statement: string; parameters: Record<string, unknown> } {
  const target = new DrivineModels(catalog).target(query.type)
  const backend = backendFor(connection.type as DatabaseType)
  const subject = describe(catalog, query.type)
  const bolt = connection.type !== 'FALKORDB'
  const rendered = backend.renderQuery((q: RootRefs<any>) => {
    const root = subject.view ? (q as any)[subject.view.root.field] : q
    return {
      where: query.where.map(c => condition(c, q, root, subject, catalog, bolt)) as DslCondition[],
      orderBy: query.orderBy.map(o => {
        const property = propertyOf(subject.root, o.property)
        const ref = root.property(property.stored)
        return o.direction === 'DESC' ? ref.desc() : ref.asc()
      }),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    }
  }, target)
  const page: Page = {
    ...(rendered.orderBy ? { orderBy: rendered.orderBy } : {}),
    ...(rendered.skip !== undefined ? { skip: rendered.skip } : {}),
    ...(rendered.limit !== undefined ? { limit: rendered.limit } : {}),
  }
  const statement =
    target.kind === 'GRAPH_VIEW'
      ? backend.loadAllViews(target.model, rendered.where, rendered.depth, page, rendered.labelsTested ?? [])
      : backend.loadAllFragments(target.model, rendered.where, page, rendered.labelsTested ?? [])
  const spec = statement.spec(rendered.bindings).finalizedCopy('CYPHER')
  return (connection.type === 'FALKORDB' ? new FalkorDbSpecCompiler(spec) : new Neo4jSpecCompiler(spec)).compile()
}

/** What a query is over: the view, if it is one, and the fragment of its root. */
interface Subject {
  view?: View
  root: Fragment
}

function describe(catalog: Catalog, id: string): Subject {
  const fragment = (fid: string) => {
    const found = catalog.fragments.find(f => f.id === fid)
    if (!found) throw new ModelError(`No model file the studio read declares the fragment ${fid}.`)
    return found
  }
  const view = catalog.views.find(v => v.id === id)
  if (view) return { view, root: fragment(view.root.fragment) }
  return { root: fragment(id) }
}

function propertyOf(fragment: Fragment, name: string): Property {
  const property = fragment.properties.find(p => p.name === name)
  if (!property) throw new ModelError(`${fragment.name} has no property ${name}.`)
  return property
}

/**
 * A condition as the DSL writes it, through the query's references `q`: on the root, `root`, by the property's
 * stored name; or, for a relationship of the view, that one of the nodes it leads to meets the conditions, or that
 * none does.
 */
function condition(c: Condition, q: any, root: any, subject: Subject, catalog: Catalog, bolt: boolean): unknown {
  if (c.kind === 'property') return predicate(root, subject.root, c, bolt)
  if (!subject.view) throw new ModelError(`${subject.root.name} is a fragment, which has no relationships to look along.`)
  const relationship = subject.view.relationships.find(r => r.field === c.relationship)
  if (!relationship) throw new ModelError(`${subject.view.name} has no relationship ${c.relationship}.`)
  if (relationship.path) throw new ModelError(`${subject.view.name}.${c.relationship} is a path, which a query cannot look along yet.`)
  const reached = reachedNode(catalog, relationship)
  const test = (node: any) =>
    c.conditions.map(inner => {
      if (inner.kind !== 'property') throw new ModelError('A condition on a related node is on one of its properties.')
      return predicate(reached.ref(node), reached.fragment, inner, bolt)
    })
  return c.none ? q[c.relationship].none(test) : q[c.relationship].any(test)
}

/** The fragment a relationship's far node is, and the reference to it from the node the DSL quantifies over. */
function reachedNode(catalog: Catalog, relationship: Relationship): { fragment: Fragment; ref: (node: any) => any } {
  const relationshipFragment = catalog.relationshipFragments.find(r => r.id === relationship.target)
  const nodeOf = (id: string, through: (node: any) => any) => {
    const view = catalog.views.find(v => v.id === id)
    const fragmentId = view ? view.root.fragment : id
    const fragment = catalog.fragments.find(f => f.id === fragmentId)
    if (!fragment) throw new ModelError(`No model file the studio read declares ${fragmentId}.`)
    return { fragment, ref: (node: any) => (view ? through(node)[view.root.field] : through(node)) }
  }
  return relationshipFragment
    ? nodeOf(relationshipFragment.target.fragment, node => node[relationshipFragment.target.field])
    : nodeOf(relationship.target, node => node)
}

function predicate(ref: any, fragment: Fragment, c: Extract<Condition, { kind: 'property' }>, bolt: boolean): unknown {
  const property = propertyOf(fragment, c.property)
  if (c.op === 'IS_NULL' || c.op === 'IS_NOT_NULL') return ref.predicate(property.stored, c.op)
  const value = Array.isArray(c.value)
    ? c.value.map(v => typed(property, v, bolt))
    : typed(property, c.value, bolt)
  return ref.predicate(property.stored, c.op, value)
}

/**
 * The browser's text as the property's own type, so that the comparison is of like with like. A temporal value goes
 * over Bolt as the driver's temporal type, which is how drivine4j stores one there; FalkorDB holds it as text.
 */
export function typed(property: Property, value: unknown, bolt: boolean): unknown {
  if (typeof value !== 'string') return value
  const text = value.trim()
  const refuse = (what: string) => new ModelError(`${property.name} is ${what}, and ${JSON.stringify(value)} is not one.`)
  switch (property.type) {
    case 'int': {
      if (!/^-?\d+$/.test(text)) throw refuse('a whole number')
      return Number(text)
    }
    case 'float': {
      const number = Number(text)
      if (text === '' || !Number.isFinite(number)) throw refuse('a number')
      return number
    }
    case 'boolean':
      if (text !== 'true' && text !== 'false') throw refuse('true or false')
      return text === 'true'
    case 'datetime': {
      const date = new Date(text)
      if (Number.isNaN(date.getTime())) throw refuse('a date and time, such as 2024-05-01T09:30:00Z')
      return bolt ? neo4j.types.DateTime.fromStandardDate(date) : text
    }
    case 'date': {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
      if (!match) throw refuse('a date, such as 2024-05-01')
      return bolt ? new neo4j.types.Date(Number(match[1]), Number(match[2]), Number(match[3])) : text
    }
    case 'localDatetime': {
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text)
      if (!match) throw refuse('a local date and time, such as 2024-05-01T09:30')
      const [, y, mo, d, h, mi, s] = match.map(part => (part === undefined ? 0 : Number(part)))
      return bolt ? new neo4j.types.LocalDateTime(y!, mo!, d!, h!, mi!, s!, 0) : text
    }
    default:
      return value
  }
}

export type FragmentRow = { props: Record<string, unknown>; labels: string[] }
export type ViewRow = { root: FragmentRow; rels: Record<string, unknown> }

/** The nodes and relationships a load's rows hold, each once. */
export class GraphBuilder {
  private readonly nodeMap = new Map<string, GraphNode>()
  private readonly edgeMap = new Map<string, GraphEdge>()

  constructor(private readonly catalog: Catalog) {}

  nodes = () => [...this.nodeMap.values()]
  edges = () => [...this.edgeMap.values()]

  /**
   * A node, named for the most particular fragment it is: the one expected where it was found, or a subtype of it
   * whose labels it carries. A node is told apart by its id, where its fragment has one; otherwise by all it holds.
   */
  node(row: FragmentRow, expected: Fragment): string {
    const fragment = this.particular(row.labels, expected)
    const properties = Object.fromEntries(Object.entries(row.props ?? {}).filter(([key]) => !key.startsWith('__drivine.')))
    const nodeId = fragment.nodeId ? fragment.properties.find(p => p.name === fragment.nodeId)?.stored : undefined
    const labels = [...row.labels].sort().join(':')
    const id = nodeId && properties[nodeId] != null
      ? `${labels}#${String(properties[nodeId])}`
      : `${labels}#${JSON.stringify(Object.entries(properties).sort(([a], [b]) => a.localeCompare(b)))}`
    if (!this.nodeMap.has(id)) this.nodeMap.set(id, { id, fragment: fragment.name, labels: row.labels, properties, aggregates: {} })
    return id
  }

  private particular(labels: string[], expected: Fragment): Fragment {
    const candidates = [expected, ...(expected.subtypes ?? []).flatMap(id => this.catalog.fragments.filter(f => f.id === id))]
    return candidates
      .filter(f => f.labels.every(l => labels.includes(l)))
      .reduce((best, f) => (f.labels.length > best.labels.length ? f : best), expected)
  }

  view(view: View, row: ViewRow): string {
    const rootFragment = this.fragment(view.root.fragment)
    const root = this.node(row.root, rootFragment)
    const rootNode = this.nodeMap.get(root)!
    for (const aggregate of view.aggregates ?? []) rootNode.aggregates[aggregate.field] = row.rels?.[aggregate.field] ?? null
    for (const relationship of view.relationships) {
      const value = row.rels?.[relationship.field]
      const items = Array.isArray(value) ? value : value == null ? [] : [value]
      for (const item of items) this.related(root, relationship, item)
    }
    return root
  }

  private related(root: string, relationship: Relationship, item: unknown): void {
    if (relationship.path) {
      const far = this.node(item as FragmentRow, this.fragment(relationship.target))
      this.edge(root, far, relationship.path.map(h => h.type).join(' · '), 'OUTGOING', {})
      return
    }
    const relationshipFragment = this.catalog.relationshipFragments.find(r => r.id === relationship.target)
    const reached = (id: string, value: unknown) => {
      const view = this.catalog.views.find(v => v.id === id)
      return view ? this.view(view, value as ViewRow) : this.node(value as FragmentRow, this.fragment(id))
    }
    const far = relationshipFragment
      ? reached(relationshipFragment.target.fragment, (item as { target: unknown }).target)
      : reached(relationship.target, item)
    const properties = relationshipFragment ? ((item as { rel?: Record<string, unknown> }).rel ?? {}) : {}
    // A list of fragments read over several hops: each is reached along one to maxDepth of them.
    const hops = (relationship.maxDepth ?? 1) > 1 && !relationshipFragment && !this.catalog.views.some(v => v.id === relationship.target)
    const type = hops ? `${relationship.type} ×1..${relationship.maxDepth}` : relationship.type!
    this.edge(root, far, type, relationship.direction ?? 'OUTGOING', properties)
  }

  private edge(root: string, far: string, type: string, direction: string, properties: Record<string, unknown>): void {
    const [from, to] = direction === 'INCOMING' ? [far, root] : [root, far]
    const id = `${from}-[${type}]->${to}`
    if (!this.edgeMap.has(id)) this.edgeMap.set(id, { id, from, to, type, directed: direction !== 'UNDIRECTED', properties })
  }

  private fragment(id: string): Fragment {
    const view = this.catalog.views.find(v => v.id === id)
    const fragmentId = view ? view.root.fragment : id
    const found = this.catalog.fragments.find(f => f.id === fragmentId)
    if (!found) throw new ModelError(`No model file the studio read declares ${fragmentId}.`)
    return found
  }
}
