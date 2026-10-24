import neo4j from 'neo4j-driver'
import type { Cell, CypherGraph, CypherNode, CypherRelationship } from '../studio/database'

/**
 * Turns what a database gives back into cells the browser can show, and gathers the nodes and relationships among
 * them into a graph. Neo4j, Memgraph and Neptune answer over Bolt, with the driver's own types; FalkorDB's client
 * gives plain objects of its own shapes.
 */
export class Cells {
  private readonly nodes = new Map<string, CypherNode>()
  private readonly relationships = new Map<string, CypherRelationship>()

  constructor(private readonly engine: 'bolt' | 'falkordb') {}

  cell(value: unknown): Cell {
    if (value === null || value === undefined) return { kind: 'null' }
    if (this.engine === 'bolt') {
      if (neo4j.isNode(value)) return { kind: 'node', node: this.node(value.elementId, value.labels, value.properties) }
      if (neo4j.isRelationship(value)) {
        return {
          kind: 'relationship',
          relationship: this.relationship(value.elementId, value.type, value.startNodeElementId, value.endNodeElementId, value.properties),
        }
      }
      if (neo4j.isPath(value)) {
        // A segment's relationship runs the way it is stored, which need not be the way the path walks it.
        const nodes = [this.node(value.start.elementId, value.start.labels, value.start.properties)]
        const relationships: CypherRelationship[] = []
        for (const segment of value.segments) {
          const r = segment.relationship
          relationships.push(this.relationship(r.elementId, r.type, r.startNodeElementId, r.endNodeElementId, r.properties))
          nodes.push(this.node(segment.end.elementId, segment.end.labels, segment.end.properties))
        }
        return { kind: 'path', nodes, relationships }
      }
    }
    if (this.engine === 'falkordb' && typeof value === 'object') {
      const shaped = value as Record<string, unknown>
      if (Array.isArray(shaped.labels) && 'properties' in shaped && 'id' in shaped) {
        return { kind: 'node', node: this.node(String(shaped.id), shaped.labels as string[], shaped.properties as Record<string, unknown>) }
      }
      if ('relationshipType' in shaped && 'sourceId' in shaped && 'destinationId' in shaped) {
        return {
          kind: 'relationship',
          relationship: this.relationship(
            String(shaped.id), String(shaped.relationshipType), String(shaped.sourceId), String(shaped.destinationId),
            shaped.properties as Record<string, unknown>,
          ),
        }
      }
      if (Array.isArray(shaped.nodes) && Array.isArray(shaped.edges)) {
        const nodes = shaped.nodes.map(n => this.cell(n)).flatMap(c => (c.kind === 'node' ? [c.node] : []))
        const relationships = shaped.edges.map(e => this.cell(e)).flatMap(c => (c.kind === 'relationship' ? [c.relationship] : []))
        return { kind: 'path', nodes, relationships }
      }
    }
    if (Array.isArray(value)) return { kind: 'list', items: value.map(v => this.cell(v)) }
    if (typeof value === 'object' && isPlainObject(value)) {
      return { kind: 'map', entries: Object.entries(value).map(([key, v]) => ({ key, value: this.cell(v) })) }
    }
    return scalar(value)
  }

  /** The nodes and relationships the cells held, each once. A relationship's ends are in it, if only by id. */
  graph(): CypherGraph {
    for (const r of this.relationships.values()) {
      for (const end of [r.from, r.to]) {
        if (!this.nodes.has(end)) this.nodes.set(end, { id: end, labels: [], properties: {}, partial: true })
      }
    }
    return { nodes: [...this.nodes.values()], relationships: [...this.relationships.values()] }
  }

  private node(id: string, labels: string[], properties: Record<string, unknown>): CypherNode {
    const node: CypherNode = { id, labels: [...labels], properties: plainProperties(properties) }
    // A node seen whole replaces one known only as a relationship's end.
    const known = this.nodes.get(id)
    if (!known || known.partial) this.nodes.set(id, node)
    return node
  }

  private relationship(id: string, type: string, from: string, to: string, properties: Record<string, unknown>): CypherRelationship {
    const relationship: CypherRelationship = { id, type, from, to, properties: plainProperties(properties) }
    this.relationships.set(id, relationship)
    return relationship
  }
}

const isPlainObject = (value: object) => {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** A value that is not a node, a relationship, a path, a list or a map, as the browser shows it. */
function scalar(value: unknown): Cell {
  if (typeof value === 'boolean' || typeof value === 'string') return { kind: 'value', value }
  if (typeof value === 'number') return Number.isFinite(value) ? { kind: 'value', value } : { kind: 'value', value: String(value), type: 'float' }
  if (typeof value === 'bigint') return whole(value.toString())
  if (neo4j.isInt(value)) {
    const integer = neo4j.int(value as never)
    return integer.inSafeRange() ? { kind: 'value', value: integer.toNumber() } : whole(integer.toString())
  }
  if (value instanceof Date) return { kind: 'value', value: value.toISOString(), type: 'datetime' }
  // Bolt gives bytes as an Int8Array, and a Node client may give a Buffer, which is a Uint8Array.
  if (value instanceof Int8Array || value instanceof Uint8Array) return { kind: 'value', value: `${value.length} bytes`, type: 'bytes' }
  const type = temporalType(value)
  // A temporal value, a point, or anything else with a meaningful text: shown as that text.
  return { kind: 'value', value: String(value), ...(type ? { type } : {}) }
}

/** A whole number too large for a JavaScript number, kept exact as its digits. */
const whole = (digits: string): Cell => ({ kind: 'value', value: digits, type: 'int' })

function temporalType(value: unknown): string | undefined {
  if (neo4j.isDateTime(value as never)) return 'datetime'
  if (neo4j.isLocalDateTime(value as never)) return 'localDatetime'
  if (neo4j.isDate(value as never)) return 'date'
  if (neo4j.isTime(value as never)) return 'time'
  if (neo4j.isLocalTime(value as never)) return 'localTime'
  if (neo4j.isDuration(value as never)) return 'duration'
  if (neo4j.isPoint(value as never)) return 'point'
  return undefined
}

/** A node's or a relationship's properties as plain JSON, for the inspector. */
function plainProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties ?? {}).map(([key, value]) => [key, plain(value)]))
}

/** A property's value as plain JSON: what has no JSON of its own, as a temporal value or a large integer, as its text. */
export function plain(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value.map(plain)
  if (typeof value === 'object' && isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, plain(v)]))
  }
  const cell = scalar(value)
  return cell.kind === 'value' ? cell.value : null
}
