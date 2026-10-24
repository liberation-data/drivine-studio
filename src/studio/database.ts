// The studio's own endpoints for connections and for running Cypher on them: what this app's server
// answers, in src/app/api/connections and src/app/api/cypher.

export const DATABASE_TYPES = ['NEO4J', 'MEMGRAPH', 'FALKORDB', 'NEPTUNE', 'POSTGRES', 'ORACLE'] as const
export type DatabaseType = (typeof DATABASE_TYPES)[number]

export const DATABASE_NAMES: Record<DatabaseType, string> = {
  NEO4J: 'Neo4j',
  MEMGRAPH: 'Memgraph',
  FALKORDB: 'FalkorDB',
  NEPTUNE: 'Neptune',
  POSTGRES: 'Postgres',
  ORACLE: 'Oracle',
}

/** The databases the studio runs Cypher on. Drivine (TypeScript) runs SQL on Oracle and Postgres, not Cypher. */
export const RUNS_CYPHER: readonly DatabaseType[] = ['NEO4J', 'MEMGRAPH', 'NEPTUNE', 'FALKORDB']

/** The rows a statement reads unless told otherwise, and the most it may read: the browser holds every one. */
export const DEFAULT_LIMIT = 1000
export const MAX_LIMIT = 10000

/** A connection, as the server shows it: whether it has a password, never the password. */
export interface StudioConnection {
  id: string
  name: string
  type: DatabaseType
  host: string
  port?: number
  user?: string
  hasPassword: boolean
  database?: string
  graph?: string
  /** 'environment' for the one Drivine's environment variables describe, which the studio cannot change. */
  source: 'studio' | 'environment'
}

/** A connection to add or change. Without a password, a change keeps the one there, unless clearPassword. */
export interface ConnectionInput {
  name: string
  type: DatabaseType
  host: string
  port?: number
  user?: string
  password?: string
  database?: string
  graph?: string
  clearPassword?: boolean
}

export interface CypherNode {
  id: string
  labels: string[]
  properties: Record<string, unknown>
  /** Known only as the end of a relationship the query gave back, not given back itself. */
  partial?: boolean
}

export interface CypherRelationship {
  id: string
  type: string
  from: string
  to: string
  properties: Record<string, unknown>
}

/** One value of a row. */
export type Cell =
  | { kind: 'null' }
  /** `type` names what the text stands for when it is not plain text: a temporal value, a large whole number. */
  | { kind: 'value'; value: string | number | boolean; type?: string }
  | { kind: 'node'; node: CypherNode }
  | { kind: 'relationship'; relationship: CypherRelationship }
  | { kind: 'path'; nodes: CypherNode[]; relationships: CypherRelationship[] }
  | { kind: 'list'; items: Cell[] }
  | { kind: 'map'; entries: { key: string; value: Cell }[] }

export interface CypherGraph {
  nodes: CypherNode[]
  relationships: CypherRelationship[]
}

export interface CypherResult {
  columns: string[]
  rows: Cell[][]
  /** Every node and relationship in the rows, each once. */
  graph: CypherGraph
  /** More rows came back than the limit, and the rest were not read. */
  truncated: boolean
  limit: number
  milliseconds: number
}

export interface CypherRequest {
  connection: string
  statement: string
  parameters?: Record<string, unknown>
  limit?: number
}

const API = '/api'

async function read<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T
  const problem = (await response.json().catch(() => null)) as { error?: string } | null
  throw new Error(problem?.error ?? `The studio answered ${response.status}`)
}

const json = (method: string, body?: unknown, signal?: AbortSignal): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  ...(signal ? { signal } : {}),
})

export const listConnections = (): Promise<StudioConnection[]> =>
  fetch(`${API}/connections`, { cache: 'no-store' }).then(r => read<StudioConnection[]>(r))

export const addConnection = (input: ConnectionInput): Promise<StudioConnection> =>
  fetch(`${API}/connections`, json('POST', input)).then(r => read<StudioConnection>(r))

export const updateConnection = (id: string, input: ConnectionInput): Promise<StudioConnection> =>
  fetch(`${API}/connections/${encodeURIComponent(id)}`, json('PUT', input)).then(r => read<StudioConnection>(r))

export const removeConnection = (id: string): Promise<void> =>
  fetch(`${API}/connections/${encodeURIComponent(id)}`, json('DELETE')).then(r => read<void>(r))

/** Connects and runs a trivial read. Answers how long it took, or throws why it could not. */
export const testConnection = (id: string): Promise<{ milliseconds: number }> =>
  fetch(`${API}/connections/${encodeURIComponent(id)}/test`, json('POST')).then(r => read<{ milliseconds: number }>(r))

export const runCypher = (request: CypherRequest, signal?: AbortSignal): Promise<CypherResult> =>
  fetch(`${API}/cypher`, json('POST', request, signal)).then(r => read<CypherResult>(r))
