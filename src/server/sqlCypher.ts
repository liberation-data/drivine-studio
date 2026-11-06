import { CypherReader } from '@liberation-data/drivine/cypher/CypherReader.js'
import type { Clause, Projection, Query } from '@liberation-data/drivine/cypher/ast/Query.js'
import { writes } from '@liberation-data/drivine/cypher/sql/CypherSyntax.js'
import { CypherWriter } from '@liberation-data/drivine/cypher/sql/CypherWriter.js'
import { OracleCypherCompiler } from '@liberation-data/drivine/cypher/sql/OracleCypherCompiler.js'
import type { Parameters } from '@liberation-data/drivine/cypher/sql/Parameters.js'
import { PostgresCypherCompiler } from '@liberation-data/drivine/cypher/sql/PostgresCypherCompiler.js'
import { SqliteCypherCompiler } from '@liberation-data/drivine/cypher/sql/SqliteCypherCompiler.js'
import type { SqlCypherCompiler } from '@liberation-data/drivine/cypher/sql/SqlCypherCompiler.js'
import { json, nodeOf, relationshipOf } from '@liberation-data/drivine/cypher/sql/Value.js'
import type { Value } from '@liberation-data/drivine/cypher/sql/Value.js'
import { columnsOf } from '@liberation-data/drivine/cypher/sql/ValueColumns.js'
import type { SqlStore } from './datasources'

/**
 * Cypher on Postgres, Oracle and SQLite, compiled to SQL over the graph's tables by Drivine (TypeScript)'s own
 * compiler, the one a PersistenceManager compiles a Cypher statement with there.
 *
 * As Drivine gives them, a row is one value, and a node or a relationship in it is its properties alone: what an
 * application reads, but too little to draw. So the studio compiles the statement as Drivine does, and gives each
 * item its `RETURN` holds as a value of a row of its own, a node with its id and labels, a relationship with its id,
 * type and ends, and a path with its nodes and relationships so. The rest is as Drivine compiles it.
 *
 * That reaches into the compiler's own workings, which are not Drivine's API: the tests against Postgres, and those on
 * SQLite, which need no database to be running, say whether a new version of Drivine still takes it.
 */

/** Marks a node, a relationship or a path the studio compiled whole, apart from a map the statement builds. */
export const WHOLE = '@drivineStudio'

/** The statement, read: Drivine's own reader, which says where a statement is not Cypher. */
export const readCypher = (statement: string): Query => CypherReader.read(statement)

/** Whether the statement writes anywhere: in a clause of its own, a `CALL { … }`, or a query of a `UNION`. */
export const statementWrites = (query: Query): boolean =>
  [...query.clauses, ...query.unions.flatMap(u => u.clauses)].some((clause: Clause) => writes(clause))

export interface StudioSql {
  sql: string
  parameters: Record<string, unknown>
  /** The names of what the statement returns, in order: each row is a JSON list of their values. */
  columns: string[]
}

/** The statement, which only reads, as SQL over the graph's tables on Postgres, Oracle or SQLite. */
export function compileWhole(type: SqlStore, graph: string, query: Query, parameters: Record<string, unknown>): StudioSql {
  const compiler = compilerFor(type, graph)
  if (query.unions.length > 0) {
    // Drivine's own compiler says what is wrong with a UNION first, as two queries of it naming different columns.
    compilerFor(type, graph).compileQuery(query, parameters)
    return union(compiler, query, parameters)
  }
  const writer = new WholeWriter(compiler, internals(compiler).readParameters(parameters))
  const sql = writer.query(query)
  return { ...internals(compiler).withFunctions({ sql, parameters: writer.parameters.values, setup: [] }), columns: writer.columns }
}

/** Drivine's own compiler for the store, as a PersistenceManager compiles a Cypher statement with there. */
export const compilerFor = (type: SqlStore, graph: string): SqlCypherCompiler =>
  type === 'ORACLE' ? new OracleCypherCompiler(graph) : type === 'SQLITE' ? new SqliteCypherCompiler(graph) : new PostgresCypherCompiler(graph)

/**
 * The names of what a statement's `RETURN` gives back, as Drivine gives it: none without one. A star's variables are
 * not named here, so a `RETURN *` is one value, `*`, the row as Drivine gives it.
 */
export function returnedNames(query: Query): string[] {
  const last = query.clauses.at(-1)
  if (last?.kind !== 'Return') return []
  return last.projection.star ? ['*'] : last.projection.items.map(item => item.name)
}

/** What the studio reads of the compiler that is not its API. */
interface CompilerInternals {
  readParameters(parameters: Record<string, unknown>): Parameters
  withFunctions(compiled: { sql: string; parameters: Record<string, unknown>; setup: string[] }): {
    sql: string
    parameters: Record<string, unknown>
  }
}

const internals = (compiler: SqlCypherCompiler): CompilerInternals => compiler as unknown as CompilerInternals

/** A `UNION`, as Drivine's compiler writes one, of queries the studio compiles whole. */
function union(compiler: SqlCypherCompiler, query: Query, parameters: Record<string, unknown>): StudioSql {
  const writer = new WholeWriter(compiler, internals(compiler).readParameters(parameters))
  const rows = [query.clauses, ...query.unions.map(u => u.clauses)]
    .map((clauses, i) => `SELECT ${i + 1} AS part, ${compiler.rowNumber} AS n, q.result FROM (\n${writer.query({ clauses, unions: [] })}\n) q`)
    .join('\nUNION ALL\n')
  let sql: string
  if (query.unions[0]!.all) {
    sql = `SELECT u.result FROM (\n${rows}\n) u\nORDER BY u.part, u.n`
  } else {
    // A row is given once, where it is first given; a node in it is told apart by its id, as a graph engine tells it.
    const key = compiler.comparable(json('u.result', { ordered: true }))
    sql = `SELECT d.result FROM (\nSELECT ${key} AS result, MIN(u.part * 1000000000.0 + u.n) AS k FROM (\n${rows}\n) u\nGROUP BY ${key}\n) d\nORDER BY d.k`
  }
  return { ...internals(compiler).withFunctions({ sql, parameters: writer.parameters.values, setup: [] }), columns: writer.columns }
}

/** What the studio reads and changes of Drivine's CypherWriter that is not its API. */
interface WriterInternals {
  readonly sql: SqlCypherCompiler
  readonly parameters: Parameters
  logger: { warn(message: string): void }
  query(query: Query): string
  project(select: { bound: Map<string, Value> }, projection: Projection, final: boolean): unknown
  correlatedUnion(query: Query, scope: unknown): string
  outerColumns(
    final: boolean,
    itemColumns: [string, Value][],
    name: string,
    sorts: [string, boolean][],
    sortedBy: (column: string) => string,
  ): string
  asJson(value: Value): { sql: string }
  /** The store's list of ids, as a path holds them, as a JSON list of them. */
  idList(list: string): string
}

const Writer = CypherWriter as unknown as new (sql: SqlCypherCompiler, parameters: Parameters) => WriterInternals

/**
 * Drivine's writer, but for the statement's own `RETURN`: each item is a value of the row's list, and a node, a
 * relationship, a list of either, or a path is given whole. A `RETURN` of a subquery's `UNION` is compiled as Drivine
 * compiles it, as what the statement reads, not what it gives back.
 */
class WholeWriter extends Writer {
  /** The names of what the statement returns, once its `RETURN` is compiled. */
  columns: string[] = []
  /** In the statement's own `RETURN`. */
  private returning = false
  /** In a subquery's `UNION`, however deep. */
  private nested = 0
  private aliases = 0

  constructor(sql: SqlCypherCompiler, parameters: Parameters) {
    super(sql, parameters)
    // Drivine warns of a RETURN of several items, which a row of its gives as a list: the studio names each.
    const logger = this.logger
    this.logger = Object.assign(Object.create(logger), {
      warn: (message: string) => (message.startsWith('The statement returns') ? undefined : logger.warn(message)),
    })
  }

  override project(select: { bound: Map<string, Value> }, projection: Projection, final: boolean): unknown {
    if (!final || this.returning || this.nested > 0) return super.project(select, projection, final)
    // As Drivine's writer names them: a star gives the variables in the order of their names, before the items.
    this.columns = [...(projection.star ? [...select.bound.keys()].sort() : []), ...projection.items.map(i => i.name)]
    this.returning = true
    try {
      return super.project(select, projection, final)
    } finally {
      this.returning = false
    }
  }

  override correlatedUnion(query: Query, scope: unknown): string {
    this.nested++
    try {
      return super.correlatedUnion(query, scope)
    } finally {
      this.nested--
    }
  }

  override outerColumns(
    final: boolean,
    itemColumns: [string, Value][],
    name: string,
    sorts: [string, boolean][],
    sortedBy: (column: string) => string,
  ): string {
    if (!final || !this.returning || this.nested > 0) return super.outerColumns(final, itemColumns, name, sorts, sortedBy)
    const values = itemColumns.map(([column, value]) => this.whole(columnsOf(value, name, column)))
    return `${this.sql.jsonArray(values)} AS result`
  }

  /** A value as JSON, a node, a relationship, a list of either or a path with all the studio draws it by. */
  private whole(value: Value): string {
    const sql = this.sql
    const mark = (kind: string): [string, string] => [WHOLE, sql.literalJson(kind)]
    switch (value.kind) {
      case 'Node':
        return `CASE WHEN ${value.nid} IS NOT NULL THEN ${sql.jsonObject([
          mark('node'),
          ['id', sql.scalar(value.nid)],
          ['labels', value.labels],
          ['properties', value.props],
        ])} END`
      case 'Relationship':
        return `CASE WHEN ${value.eid} IS NOT NULL THEN ${sql.jsonObject([
          mark('relationship'),
          ['id', sql.scalar(value.eid)],
          ['type', sql.scalar(value.type)],
          ['start', sql.scalar(value.src)],
          ['end', sql.scalar(value.dst)],
          ['properties', value.props],
        ])} END`
      case 'Entities':
        return this.entities(value.ids, value.relationships)
      case 'Path':
        return `CASE WHEN ${value.nids} IS NOT NULL THEN ${sql.jsonObject([
          mark('path'),
          ['nodes', this.entities(this.idList(value.nids), false)],
          ['relationships', this.entities(this.idList(value.eids), true)],
        ])} END`
      default:
        return this.asJson(value).sql
    }
  }

  /** The nodes or relationships of a list of their ids, whole, in its order: as Drivine reads them for their properties. */
  private entities(ids: string, relationships: boolean): string {
    const sql = this.sql
    return sql.shared([ids], ([list]) => {
      const item = `studio_e${++this.aliases}`
      const row = `studio_r${++this.aliases}`
      const [table, value, id] = relationships
        ? [sql.edges, this.whole(relationshipOf(row)), 'eid']
        : [sql.nodes, this.whole(nodeOf(row)), 'nid']
      return (
        // Each element and its place as the store's compiler names them: SQLite's json_each calls them value and key.
        `CASE WHEN ${list} IS NOT NULL THEN (SELECT ${sql.aggregateList(value, sql.itemNo(item))} ` +
        `FROM ${sql.elements(list!, item)} LEFT JOIN ${table} ${row} ON ${row}.${id} = ${sql.idOf(sql.item(item))}) END`
      )
    })
  }
}
