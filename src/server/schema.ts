import type { Connection } from './connections'
import { readRows, readSql, SQL_STORES } from './datasources'
import type { GraphSchema } from '../studio/schema'

/**
 * What a connection's graph is made of, for the Cypher editor to complete: its labels, relationship types and property
 * keys. Read only, and cheap enough to ask for in the background: on a big graph, from a sample.
 *
 * Neo4j and FalkorDB keep these and say them at once (`db.labels()` and the rest). Memgraph and Neptune don't without
 * a setting, so they are read from a sample of nodes and relationships. Postgres and Oracle are read straight from
 * Drivine's node and edge tables: every label and relationship type, since a label on one node is as likely to be
 * typed as any (on 1.1M nodes and 4.4M relationships, about 100 and 250 ms on Postgres), and property keys from the
 * first rows and a sample of blocks spread through the tables, so a key on a handful of rows only may be missed.
 */
export async function readSchema(connection: Connection): Promise<GraphSchema> {
  if (SQL_STORES.includes(connection.type)) return sqlSchema(connection)
  if (connection.type === 'NEO4J' || connection.type === 'FALKORDB') {
    try {
      return await listed(connection, KEPT)
    } catch {
      // A user without the procedures, or an older engine: a sample still answers.
    }
  }
  return listed(connection, SAMPLED)
}

/** Rows read for a sample on an engine that doesn't keep its labels: enough to see a graph's shape, quickly. */
export const SAMPLE_ROWS = 10_000
/** Nodes read for their keys from each set of labels, on Postgres. */
export const PER_LABELS = 200
/** Each list is cut at this many, so a graph of free-form keys doesn't send thousands. */
export const MOST = 2_000

const KEPT = {
  labels: 'CALL db.labels() YIELD label RETURN label',
  relationshipTypes: 'CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType',
  propertyKeys: 'CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey',
}

const SAMPLED = {
  labels: `MATCH (n) WITH n LIMIT ${SAMPLE_ROWS} UNWIND labels(n) AS label RETURN DISTINCT label`,
  relationshipTypes: `MATCH ()-[r]->() WITH r LIMIT ${SAMPLE_ROWS} RETURN DISTINCT type(r) AS relationshipType`,
  propertyKeys:
    `CALL { MATCH (n) WITH n LIMIT ${SAMPLE_ROWS} UNWIND keys(n) AS key RETURN key ` +
    `UNION MATCH ()-[r]->() WITH r LIMIT ${SAMPLE_ROWS} UNWIND keys(r) AS key RETURN key } RETURN DISTINCT key`,
}

async function listed(connection: Connection, statements: typeof KEPT): Promise<GraphSchema> {
  const column = async (statement: string) =>
    namesOf((await readRows(connection, statement, {}, MOST, value => value)).rows.map(row => row[0]))
  const [labels, relationshipTypes, propertyKeys] = await Promise.all([
    column(statements.labels),
    column(statements.relationshipTypes),
    column(statements.propertyKeys),
  ])
  return { labels, relationshipTypes, propertyKeys }
}

/** The names in what came back, each once, in order, with anything not a name left out. */
export function namesOf(values: readonly unknown[]): string[] {
  const seen = new Set<string>()
  for (const value of values) {
    const name = typeof value === 'string' ? value : typeof value === 'object' && value !== null ? firstString(value) : undefined
    if (name && seen.size < MOST) seen.add(name)
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

// A row as a driver gives it back: an object of one column, whatever case the database names it in.
function firstString(row: object): string | undefined {
  const value = Object.values(row)[0]
  return typeof value === 'string' ? value : undefined
}

/** A graph name as Drivine takes one: it names tables, so it goes into the SQL as it is, and only one of these may. */
const GRAPH_NAME = /^[A-Za-z][A-Za-z0-9_]{0,100}$/

/** The SQL that reads a graph's labels and relationship types from its tables, and its property keys from a sample. */
export function schemaSql(type: 'POSTGRES' | 'ORACLE', graph: string): { labels: string; relationshipTypes: string; propertyKeys: string } {
  if (!GRAPH_NAME.test(graph)) throw new Error(`'${graph}' can't name a graph: it names tables.`)
  const nodes = `${graph}_node`
  const edges = `${graph}_edge`
  const first = SAMPLE_ROWS
  if (type === 'POSTGRES') {
    // The first rows, and about one block in a hundred from the rest: a big table's spread, cheaply.
    const sample = (table: string, columns: string) =>
      `(SELECT ${columns} FROM ${table} LIMIT ${first}) UNION ALL (SELECT ${columns} FROM ${table} TABLESAMPLE SYSTEM (1))`
    return {
      // Each set of labels once, then its labels: far fewer sets than nodes, so it is quick, and none is missed.
      labels: `SELECT DISTINCT jsonb_array_elements_text(l) AS v FROM (SELECT DISTINCT labels AS l FROM ${nodes}) s LIMIT ${MOST}`,
      relationshipTypes: `SELECT DISTINCT type AS v FROM ${edges} LIMIT ${MOST}`,
      // A node's keys from the sample, and from the first rows of each set of labels, found through the labels' index:
      // so a label on a few nodes gives its keys too. A relationship's from the sample.
      propertyKeys:
        `SELECT DISTINCT v FROM (SELECT jsonb_object_keys(props) AS v FROM (${sample(nodes, 'props')}) n ` +
        `UNION ALL SELECT jsonb_object_keys(p.props) AS v FROM (SELECT DISTINCT labels AS l FROM ${nodes}) s, ` +
        `LATERAL (SELECT props FROM ${nodes} WHERE labels @> s.l LIMIT ${PER_LABELS}) p ` +
        `UNION ALL SELECT jsonb_object_keys(props) AS v FROM (${sample(edges, 'props')}) e) k LIMIT ${MOST}`,
    }
  }
  const sample = (table: string, columns: string) =>
    `(SELECT ${columns} FROM ${table} FETCH FIRST ${first} ROWS ONLY) UNION ALL (SELECT ${columns} FROM ${table} SAMPLE BLOCK (1))`
  // Oracle's JSON_DATAGUIDE names each path in the sample, as "$.name"; the keys are read from those (see oracleKeys).
  return {
    labels:
      `SELECT DISTINCT jt.v AS v FROM ${nodes} n, ` +
      `JSON_TABLE(n.labels, '$[*]' COLUMNS (v VARCHAR2(400) PATH '$')) jt FETCH FIRST ${MOST} ROWS ONLY`,
    relationshipTypes: `SELECT DISTINCT type AS v FROM ${edges} FETCH FIRST ${MOST} ROWS ONLY`,
    propertyKeys:
      `SELECT JSON_SERIALIZE(JSON_DATAGUIDE(props) RETURNING CLOB) AS v FROM (${sample(nodes, 'props')}) n ` +
      `UNION ALL SELECT JSON_SERIALIZE(JSON_DATAGUIDE(props) RETURNING CLOB) AS v FROM (${sample(edges, 'props')}) e`,
  }
}

/** The top-level keys in Oracle's flat data guides, each a JSON array of `{"o:path": "$.name", …}`. */
export function oracleKeys(guides: readonly unknown[]): string[] {
  const keys: string[] = []
  for (const guide of guides) {
    if (typeof guide !== 'string' || guide.trim() === '') continue
    let entries: unknown
    try {
      entries = JSON.parse(guide)
    } catch {
      continue
    }
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const path = (entry as Record<string, unknown> | null)?.['o:path']
      const key = typeof path === 'string' ? topKey(path) : undefined
      if (key) keys.push(key)
    }
  }
  return namesOf(keys)
}

// "$.name" is name; "$.address.city" is address; "$.\"odd key\"" is odd key; "$" and "$[*]" are none.
function topKey(path: string): string | undefined {
  const quoted = /^\$\."((?:[^"\\]|\\.)*)"/.exec(path)
  if (quoted) return quoted[1]!.replace(/\\(.)/g, '$1')
  const plain = /^\$\.([^.[]+)/.exec(path)
  return plain?.[1]
}

async function sqlSchema(connection: Connection): Promise<GraphSchema> {
  const type = connection.type as 'POSTGRES' | 'ORACLE'
  const sql = schemaSql(type, connection.graph || 'drivine')
  const [labels, relationshipTypes, keys] = await Promise.all([
    readSql(connection, sql.labels),
    readSql(connection, sql.relationshipTypes),
    readSql(connection, sql.propertyKeys),
  ])
  return {
    labels: namesOf(labels),
    relationshipTypes: namesOf(relationshipTypes),
    propertyKeys: type === 'ORACLE' ? oracleKeys(keys.map(row => (typeof row === 'object' && row !== null ? Object.values(row)[0] : row))) : namesOf(keys),
  }
}
