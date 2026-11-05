// What the 3D graph decides without drawing: when it is offered, where it opens, and what stays solid.
import type { GraphEdge, GraphNode } from './api'

/**
 * The most nodes 3D draws. It reads well on a small graph, where every node can carry its label; past a few hundred it
 * is a hairball seen from more sides, and the 2D layout reads better.
 */
export const MAX_3D_NODES = 300

export type Depth = '2d' | '3d'

/** Whether a graph is small enough to draw in 3D. */
export const fits3D = (nodes: number): boolean => nodes <= MAX_3D_NODES

/** What is drawn: 3D only when it is chosen and the graph fits. The choice itself is kept, for the next small graph. */
export const shownDepth = (chosen: Depth, nodes: number): Depth => (chosen === '3d' && fits3D(nodes) ? '3d' : '2d')

type Ends = Pick<GraphEdge, 'from' | 'to'>

/** How many relationships each node has, a loop counted once. */
export function degrees(edges: readonly Ends[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const { from, to } of edges) {
    counts.set(from, (counts.get(from) ?? 0) + 1)
    if (to !== from) counts.set(to, (counts.get(to) ?? 0) + 1)
  }
  return counts
}

/** The node the view opens on: the one with most relationships, the first such in the graph's order. */
export function hubOf(nodes: readonly Pick<GraphNode, 'id'>[], edges: readonly Ends[]): string | undefined {
  const counts = degrees(edges)
  let best: string | undefined
  let most = -1
  for (const { id } of nodes) {
    const count = counts.get(id) ?? 0
    if (count > most) {
      best = id
      most = count
    }
  }
  return best
}

/** A node and those it shares a relationship with, either way. */
export function focusSetOf(id: string, edges: readonly Ends[]): Set<string> {
  const near = new Set([id])
  for (const { from, to } of edges) {
    if (from === id) near.add(to)
    if (to === id) near.add(from)
  }
  return near
}

/**
 * The nodes drawn solid; the rest fade. A node is solid when its fragment is shown in the legend and, with a node in
 * focus, it is that node or one of its neighbours.
 */
export function litOf(nodes: readonly Pick<GraphNode, 'id' | 'fragment'>[], edges: readonly Ends[], focus: string | null, hidden: ReadonlySet<string>): Set<string> {
  const near = focus === null ? null : focusSetOf(focus, edges)
  return new Set(nodes.filter(n => !hidden.has(n.fragment) && (!near || near.has(n.id))).map(n => n.id))
}

/** A relationship is solid when both its ends are. */
export const edgeLit = (edge: Ends, lit: ReadonlySet<string>): boolean => lit.has(edge.from) && lit.has(edge.to)

export interface LegendEntry {
  readonly fragment: string
  readonly count: number
}

/** Each fragment the graph has nodes of, in the catalogue's order, with how many. */
export function legendOf(nodes: readonly Pick<GraphNode, 'fragment'>[], fragments: readonly string[]): LegendEntry[] {
  const counts = new Map<string, number>()
  for (const { fragment } of nodes) counts.set(fragment, (counts.get(fragment) ?? 0) + 1)
  const ordered = [...fragments.filter(f => counts.has(f)), ...[...counts.keys()].filter(f => !fragments.includes(f))]
  return ordered.map(fragment => ({ fragment, count: counts.get(fragment)! }))
}

/** The legend's own checkbox: every fragment shown, none, or some. */
export function shownOf(entries: readonly LegendEntry[], hidden: ReadonlySet<string>): 'all' | 'none' | 'some' {
  const off = entries.filter(e => hidden.has(e.fragment)).length
  return off === 0 ? 'all' : off === entries.length ? 'none' : 'some'
}

/** One fragment shown or hidden. */
export function toggled(hidden: ReadonlySet<string>, fragment: string, shown: boolean): Set<string> {
  const next = new Set(hidden)
  if (shown) next.delete(fragment)
  else next.add(fragment)
  return next
}

/** A caption short enough to sit under a node. */
export const clip = (text: string, most = 24): string => (text.length > most ? `${text.slice(0, most - 1).trimEnd()}…` : text)
