// The studio's own endpoints for connections, for running Cypher on them, and for a database in Docker: what this
// app's server answers, in src/app/api/connections, src/app/api/cypher and src/app/api/docker.

import type { DockerDraft, DockerStatus } from './docker'
import { json, read } from './fetching'

export const DATABASE_TYPES = ['NEO4J', 'MEMGRAPH', 'FALKORDB', 'NEPTUNE', 'POSTGRES', 'ORACLE', 'SQLITE'] as const
export type DatabaseType = (typeof DATABASE_TYPES)[number]

export const DATABASE_NAMES: Record<DatabaseType, string> = {
  NEO4J: 'Neo4j',
  MEMGRAPH: 'Memgraph',
  FALKORDB: 'FalkorDB',
  NEPTUNE: 'Neptune',
  POSTGRES: 'Postgres',
  ORACLE: 'Oracle',
  SQLITE: 'SQLite',
}

/** The databases the studio runs Cypher on: on Postgres, Oracle and SQLite, Drivine (TypeScript) compiles it to SQL. */
export const RUNS_CYPHER: readonly DatabaseType[] = ['NEO4J', 'MEMGRAPH', 'NEPTUNE', 'FALKORDB', 'POSTGRES', 'ORACLE', 'SQLITE']

/** Said before a database's refusal to write, so the person knows the refusal is the studio's doing. */
export const READS_ONLY = 'The studio reads and never writes, and runs each statement where it cannot.'

/** Said where a connection allows writes, as the Cypher window says before each statement is run. */
export const ALLOWS_WRITES = 'This connection allows writes: a statement run in the Cypher window changes the database, and is committed.'

/** What a statement that may write changed, as the databases count it, in the order the studio shows them. */
export const CHANGES = [
  'nodesCreated', 'nodesDeleted', 'relationshipsCreated', 'relationshipsDeleted', 'propertiesSet', 'labelsAdded', 'labelsRemoved',
] as const
export type Change = (typeof CHANGES)[number]

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
  /** A statement run in the Cypher window may write, and is committed. Off unless set; the Canvas only ever reads. */
  allowWrites?: boolean
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
  allowWrites?: boolean
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
  /**
   * Given only where the statement ran where it may write, and was committed: what it changed, each count as its
   * database gave it, or null where the database gives none, as Postgres, Oracle and SQLite do.
   */
  written?: { counts: Partial<Record<Change, number>> | null }
}

export interface CypherRequest {
  connection: string
  statement: string
  parameters?: Record<string, unknown>
  limit?: number
}

const API = '/api'

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

/** How Docker and the container for these settings stand. Never the password: the status needs only type and port. */
export const dockerStatus = (draft: Pick<DockerDraft, 'type' | 'host' | 'port'>): Promise<DockerStatus> =>
  fetch(`${API}/docker?${new URLSearchParams({ type: draft.type, host: draft.host, port: draft.port })}`, { cache: 'no-store' })
    .then(r => read<DockerStatus>(r))

/** A port to start a new database of this kind on in Docker: its usual one, or the next free. */
export const freeDockerPort = (type: DatabaseType): Promise<number> =>
  fetch(`${API}/docker?${new URLSearchParams({ type, free: '' })}`, { cache: 'no-store' }).then(r => read<{ port: number }>(r)).then(r => r.port)

/** Starts, stops or removes the container for these settings; a saved connection's id lends it the kept password. */
export const dockerAction = (action: 'start' | 'stop' | 'remove', draft: DockerDraft, id?: string): Promise<unknown> =>
  fetch(`${API}/docker`, json('POST', { action, draft, ...(id ? { id } : {}) })).then(r => read<unknown>(r))

/** The relationships among a result's nodes, to draw beside it as Neo4j Browser does. A read. */
export const connectResults = (connection: string, ids: string[], signal?: AbortSignal): Promise<{ relationships: CypherRelationship[]; truncated: boolean }> =>
  fetch(`${API}/cypher/connect`, json('POST', { connection, ids }, signal)).then(r => read<{ relationships: CypherRelationship[]; truncated: boolean }>(r))

export const runCypher = (request: CypherRequest, signal?: AbortSignal): Promise<CypherResult> =>
  fetch(`${API}/cypher`, json('POST', request, signal)).then(r => read<CypherResult>(r))
