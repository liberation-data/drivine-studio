// The model the studio reads from model files, and how the canvas loads it. The model types follow the model file's
// format, drivine-model/1: https://github.com/liberation-data/drivine-cypher-spec/tree/main/model

import { json, read } from './fetching'

export type PropertyType =
  | 'string' | 'int' | 'float' | 'boolean' | 'uuid' | 'date' | 'time' | 'localTime' | 'datetime' | 'localDatetime'
  | 'duration' | 'enum' | 'list' | 'map' | 'json' | 'any'

export type Direction = 'OUTGOING' | 'INCOMING' | 'UNDIRECTED'

export interface Property {
  name: string
  stored: string
  type: PropertyType
  of?: PropertyType
  values?: string[]
  nullable: boolean | 'unknown'
  whenAbsent?: 'default' | 'empty'
  packed?: 'json'
  readOnly?: boolean
  index?: 'unique' | 'range' | 'text' | 'fullText'
  vector?: { similarity: string; dimensions?: number }
  source?: string
}

/** What every entry has: the module whose file declared it, and whether the code still does. */
interface Entry {
  id: string
  name: string
  removed?: boolean
  module: string
}

export interface Fragment extends Entry {
  labels: string[]
  nodeId?: string
  stamp?: boolean
  subtypes?: string[]
  subtypesComplete?: boolean
  labelSet?: { field: string; values?: string[] }
  bags?: { field: string; prefix: string; type: PropertyType }[]
  properties: Property[]
  indexes?: { kind: 'unique' | 'range' | 'fullText'; properties: string[] }[]
}

export interface RelationshipFragment extends Entry {
  target: { field: string; fragment: string }
  properties: Property[]
}

export interface Hop {
  type: string
  direction: Direction
  label?: string
  orderBy?: string
  ascending?: boolean
}

export interface Relationship {
  field: string
  type?: string
  direction?: Direction
  target: string
  many: boolean
  required: boolean
  maxDepth?: number
  sortedBy?: { property: string; ascending: boolean }
  readOnly?: boolean
  path?: Hop[]
}

export interface Aggregate {
  field: string
  function: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX'
  type: string
  direction: Direction
  property?: string
}

export interface View extends Entry {
  root: { field: string; fragment: string }
  relationships: Relationship[]
  aggregates?: Aggregate[]
}

/** A model file the studio read. */
export interface ModelSource {
  module: string
  /** Where the file is. */
  file: string
  generator: { library: string; version: string; language: string }
}

/** Every model file the studio read, their entries merged by id, and what could not be read. */
export interface Catalog {
  models: ModelSource[]
  fragments: Fragment[]
  relationshipFragments: RelationshipFragment[]
  views: View[]
  problems: { file: string; message: string }[]
}

/** The query DSL's operators, as Drivine names them. */
export type Operator =
  | 'EQ' | 'NEQ' | 'GT' | 'GTE' | 'LT' | 'LTE' | 'IN' | 'NOT_IN' | 'CONTAINS' | 'CONTAINS_IGNORE_CASE'
  | 'STARTS_WITH' | 'ENDS_WITH' | 'IS_NULL' | 'IS_NOT_NULL'

/**
 * A condition: on a property of the root, by the name the code calls it; or, on a view, that one of the nodes a
 * relationship leads to meets the conditions, or that none does.
 */
export type Condition =
  | { kind: 'property'; property: string; op: Operator; value?: unknown }
  | { kind: 'related'; relationship: string; none?: boolean; conditions: Condition[] }

export interface Query {
  /** The id of a view or a fragment. */
  type: string
  where: Condition[]
  orderBy: { property: string; direction: 'ASC' | 'DESC' }[]
  limit?: number
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
  /** How many roots came back. */
  count: number
  limit: number
  /** As many roots came back as the limit lets: there may be more. */
  truncated: boolean
  /** The Cypher `loadAll` runs for the query, and its parameters, as the studio ran them. */
  cypher: { statement: string; parameters: Record<string, unknown> }
}

const API = '/api'

export const loadCatalog = (): Promise<Catalog> => fetch(`${API}/catalog`, { cache: 'no-store' }).then(r => read<Catalog>(r))

export const runQuery = (connection: string, query: Query, signal?: AbortSignal): Promise<Result> =>
  fetch(`${API}/query`, json('POST', { connection, query }, signal)).then(r => read<Result>(r))

/** Where the studio looks for model files: a folder, searched for .drivine/model.json, or a file. */
export interface ModelPath {
  path: string
  /** 'environment' for one DRIVINE_STUDIO_MODELS names, which the studio cannot remove. */
  source: 'studio' | 'environment'
}

export const listModelPaths = (): Promise<ModelPath[]> =>
  fetch(`${API}/models`, { cache: 'no-store' }).then(r => read<ModelPath[]>(r))

export const addModelPath = (path: string): Promise<ModelPath[]> =>
  fetch(`${API}/models`, json('POST', { path })).then(r => read<ModelPath[]>(r))

export const removeModelPath = (path: string): Promise<ModelPath[]> =>
  fetch(`${API}/models`, json('DELETE', { path })).then(r => read<ModelPath[]>(r))
