import type { Core } from 'cytoscape'
import type { GraphEdge, Result } from './api'
import type { CypherRelationship, CypherResult } from './database'

/*
 * "Connect results": the relationships among a result's nodes that the query didn't give back, read once for each
 * result and connection and kept, so the toggle only draws them or takes them away. Turned on or off, the graph keeps
 * its nodes where they are: only those relationships come and go.
 */

/** The relationships read for a result, on a connection; or that the read failed, which isn't kept past a toggle. */
export interface Connected {
  readonly for: CypherResult
  readonly connection: string
  readonly relationships: readonly CypherRelationship[]
  readonly truncated: boolean
  readonly failed?: boolean
}

/** What was read for this result on this connection, if it was. */
export const connectionsOf = (known: Connected | null, result: CypherResult | null, connection: string | undefined): Connected | undefined =>
  known !== null && result !== null && known.for === result && known.connection === connection ? known : undefined

/** Whether the connections of this result must be read now: wanted, and not read for it yet. */
export const toConnect = (on: boolean, result: CypherResult | null, connection: string | undefined, known: Connected | null): boolean =>
  on && result !== null && connection !== undefined && connectionsOf(known, result, connection) === undefined

/**
 * Whether a result waits for its connections before it is drawn at all: only a new one, run with the toggle on, so it
 * is laid out once with them. A result drawn already that is connected later has them added where it stands.
 */
export const waitsToConnect = (
  on: boolean, result: CypherResult | null, connection: string | undefined, holding: CypherResult | null, known: Connected | null,
): boolean => on && result !== null && holding === result && connectionsOf(known, result, connection) === undefined

type Graph = Result['graph']
interface Drawn { readonly graph: Graph; readonly fragments: readonly string[] }

/**
 * What drawing `next` after `before` takes: a new layout, for another graph; or, for the same nodes (the same array
 * of them: `withConnections` keeps it) in the same colours, only the relationships to add and the ids of those to take
 * away, the nodes left where they are. A first layout still `arranging`, out of sight, with the relationships it began
 * with is begun again with these: cola keeps pulling on those it began with, and the parts it sets apart at the end
 * are the parts as they are then, so relationships joining two of them would be drawn across a jumble.
 */
export type Redraw = { kind: 'layout' } | { kind: 'edges'; add: GraphEdge[]; remove: string[] }

export function redrawOf(before: Drawn | null, next: Drawn, arranging = false): Redraw {
  if (arranging || !before || before.graph.nodes !== next.graph.nodes || before.fragments !== next.fragments) return { kind: 'layout' }
  const now = new Map(next.graph.edges.map(e => [e.id, e]))
  const was = new Map(before.graph.edges.map(e => [e.id, e]))
  // An edge given again under its id but as another edge is taken away and added again, so its data is the new one's.
  const remove = before.graph.edges.filter(e => now.get(e.id) !== e).map(e => e.id)
  const add = next.graph.edges.filter(e => was.get(e.id) !== e)
  return { kind: 'edges', add, remove }
}

/** A relationship as the 2D view keeps it on its core, marked `added` when the query didn't give it back. */
export const edgeElement = (edge: GraphEdge) => ({
  group: 'edges' as const,
  data: { id: edge.id, source: edge.from, target: edge.to, type: edge.type, directed: edge.directed, added: edge.added === true, edge },
})

/** Takes away and adds the relationships of an edges-only redraw, in one batch, touching no node. */
export function applyEdges(core: Core, redraw: Extract<Redraw, { kind: 'edges' }>) {
  if (redraw.add.length === 0 && redraw.remove.length === 0) return
  core.batch(() => {
    for (const id of redraw.remove) core.getElementById(id).remove()
    // Both ends must be drawn: a relationship to a node not in the graph has nowhere to go.
    core.add(redraw.add.filter(e => core.getElementById(e.from).nonempty() && core.getElementById(e.to).nonempty()).map(edgeElement))
  })
}
