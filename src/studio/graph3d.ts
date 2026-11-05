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

/** What the view knows of the reader's attention: the node chosen, the one under the pointer, the one in focus. */
export interface Attention {
  readonly chosen: string | null
  readonly hovered: string | null
  readonly focus: string | null
}

/**
 * The order names are given room in: the node chosen, then the one under the pointer, then the focus node's
 * neighbours, then every other node, those with most relationships first. Ties keep the graph's order.
 */
export function namePriority(ids: readonly string[], edges: readonly Ends[], attention: Attention): string[] {
  const counts = degrees(edges)
  const near = attention.focus === null ? new Set<string>() : focusSetOf(attention.focus, edges)
  const rank = (id: string) => (id === attention.chosen ? 0 : id === attention.hovered ? 1 : near.has(id) ? 2 : 3)
  return ids
    .map((id, i) => ({ id, i, rank: rank(id), degree: counts.get(id) ?? 0 }))
    .sort((a, b) => a.rank - b.rank || b.degree - a.degree || a.i - b.i)
    .map(({ id }) => id)
}

/**
 * A box on screen, in pixels, from its middle: a name's, or an obstacle's, such as a node's shape, which a name must
 * not cover but which is drawn whatever happens. A box never clashes with another of the same node's.
 */
export interface NameBox {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly obstacle?: boolean
}

/** Whether two boxes overlap, with `gap` pixels kept clear between them. */
export const overlaps = (a: NameBox, b: NameBox, gap = 0): boolean =>
  Math.abs(a.x - b.x) * 2 < a.width + b.width + gap * 2 && Math.abs(a.y - b.y) * 2 < a.height + b.height + gap * 2

/**
 * The names shown: taken in the order given, each kept unless its box would overlap one kept before it, or an obstacle
 * given before it, of another node. A box is checked only against those in the cells of a coarse grid it touches, so a
 * frame stays cheap.
 */
export function uncrowded(boxes: readonly NameBox[], gap = 2, cell = 64): Set<string> {
  const kept = new Set<string>()
  const grid = new Map<string, NameBox[]>()
  const cellsOf = (b: NameBox) => {
    const keys: string[] = []
    const x0 = Math.floor((b.x - b.width / 2 - gap) / cell)
    const x1 = Math.floor((b.x + b.width / 2 + gap) / cell)
    const y0 = Math.floor((b.y - b.height / 2 - gap) / cell)
    const y1 = Math.floor((b.y + b.height / 2 + gap) / cell)
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.push(`${x},${y}`)
    return keys
  }
  for (const box of boxes) {
    const keys = cellsOf(box)
    if (!box.obstacle) {
      if (keys.some(k => grid.get(k)?.some(other => other.id !== box.id && overlaps(box, other, gap)))) continue
      kept.add(box.id)
    }
    for (const k of keys) {
      const list = grid.get(k)
      if (list) list.push(box)
      else grid.set(k, [box])
    }
  }
  return kept
}
