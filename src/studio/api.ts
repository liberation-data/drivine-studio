// The studio's endpoints, as drivine4j-studio serves them and this app's server passes them on. Keep these
// types in step with StudioCatalog.kt, StudioQuery.kt and StudioGraph.kt.

export interface Catalog {
  views: ViewDescriptor[]
  fragments: FragmentDescriptor[]
  problems: { className: string; message: string }[]
}

export interface ViewDescriptor {
  name: string
  className: string
  root: { field: string; fragment: string }
  relationships: RelationshipDescriptor[]
  aggregates: string[]
}

export interface RelationshipDescriptor {
  field: string
  type: string
  direction: 'OUTGOING' | 'INCOMING' | 'UNDIRECTED'
  target: string
  targetIsView: boolean
  /** The fragment whose properties a condition on this relationship may name; null when it takes none. */
  filterOn: string | null
  collection: boolean
  nullable: boolean
  edgeProperties: string[]
  recursive: boolean
}

export interface FragmentDescriptor {
  name: string
  className: string
  labels: string[]
  idProperty: string | null
  properties: PropertyDescriptor[]
}

export interface PropertyDescriptor {
  name: string
  type: string
  javaType: string
  nullable: boolean
  vector: boolean
}

export type Operator =
  | 'EQUALS' | 'NOT_EQUALS' | 'GREATER_THAN' | 'GREATER_THAN_OR_EQUAL' | 'LESS_THAN' | 'LESS_THAN_OR_EQUAL'
  | 'IN' | 'NOT_IN' | 'CONTAINS' | 'CONTAINS_IGNORE_CASE' | 'STARTS_WITH' | 'ENDS_WITH'
  | 'IS_NULL' | 'IS_NOT_NULL'

export type Condition =
  | { kind: 'property'; property: string; op: Operator; value?: unknown }
  | { kind: 'anyOf'; conditions: Condition[] }
  | { kind: 'not'; conditions: Condition[] }
  | { kind: 'related'; relationship: string; none?: boolean; conditions: Condition[] }

export interface Query {
  type: string
  where: Condition[]
  orderBy: { property: string; direction: 'ASC' | 'DESC' }[]
  limit?: number
  skip?: number
}

export interface GraphNode {
  id: string
  fragment: string
  labels: string[]
  properties: Record<string, unknown>
  aggregates: Record<string, unknown>
}

export interface GraphEdge {
  id: string
  from: string
  to: string
  type: string
  directed: boolean
  properties: Record<string, unknown>
}

export interface Result {
  graph: { nodes: GraphNode[]; edges: GraphEdge[]; roots: string[] }
  count: number
  limit: number
  truncated: boolean
}

const API = '/api'

async function read<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T
  // The endpoints answer a refusal as { error }; anything else is the server or the network.
  const problem = (await response.json().catch(() => null)) as { error?: string } | null
  throw new Error(problem?.error ?? `The studio answered ${response.status}`)
}

export const loadCatalog = (): Promise<Catalog> => fetch(`${API}/catalog`).then(r => read<Catalog>(r))

export const runQuery = (query: Query, signal?: AbortSignal): Promise<Result> =>
  fetch(`${API}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(query),
    ...(signal ? { signal } : {}),
  }).then(r => read<Result>(r))
