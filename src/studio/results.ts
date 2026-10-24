import type { GraphNode, Result } from './api'
import type { Cell, CypherGraph, CypherNode } from './database'
import { captionOf } from './GraphView'

/** What a node with no labels is coloured and listed as. */
export const NO_LABEL = 'No label'

/**
 * A Cypher result's nodes and relationships as the graph view draws them, and the labels it colours them by: each node
 * by its first label, the labels sorted, so a label keeps its colour from one run to the next.
 */
export function graphOf(graph: CypherGraph): { graph: Result['graph']; labels: string[] } {
  const nodes: GraphNode[] = graph.nodes.map(node => ({
    id: node.id,
    fragment: node.labels[0] ?? NO_LABEL,
    labels: node.labels,
    properties: node.properties,
    aggregates: {},
  }))
  const edges = graph.relationships.map(r => ({ id: r.id, from: r.from, to: r.to, type: r.type, directed: true, properties: r.properties }))
  const labels = [...new Set(nodes.map(n => n.fragment))].sort((a, b) => a.localeCompare(b))
  return { graph: { nodes, edges, roots: [] }, labels }
}

const nodeText = (node: CypherNode): string => {
  const labels = node.labels.map(l => `:${l}`).join('')
  const caption = captionOf({ id: node.id, fragment: '', labels: node.labels, properties: node.properties, aggregates: {} })
  return caption ? `(${labels} ${caption})` : `(${labels || node.id})`
}

/** A cell as one line of text, for a table. */
export function cellText(cell: Cell): string {
  switch (cell.kind) {
    case 'null':
      return 'null'
    case 'value':
      return typeof cell.value === 'string' && !cell.type ? cell.value : String(cell.value)
    case 'node':
      return nodeText(cell.node)
    case 'relationship':
      return `[:${cell.relationship.type}]`
    case 'path': {
      const hops = cell.relationships.length
      const [first] = cell.nodes
      const last = cell.nodes[cell.nodes.length - 1]
      return `${first ? nodeText(first) : '()'} → ${hops} ${hops === 1 ? 'hop' : 'hops'} → ${last ? nodeText(last) : '()'}`
    }
    case 'list':
      return `[${cell.items.map(cellText).join(', ')}]`
    case 'map':
      return `{${cell.entries.map(e => `${e.key}: ${cellText(e.value)}`).join(', ')}}`
  }
}

/**
 * The parameters as typed, or why they are not a JSON object. Empty is none.
 */
export function parametersOf(text: string): { parameters: Record<string, unknown> } | { problem: string } {
  if (text.trim() === '') return { parameters: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { problem: `The parameters are not JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { problem: 'The parameters are a JSON object, of each name and its value: {"name": "Ada"}.' }
  }
  return { parameters: parsed as Record<string, unknown> }
}
