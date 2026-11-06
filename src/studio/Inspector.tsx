import type { GraphNode } from './api'
import { captionOf, colourOf } from './GraphView'
import type { Selection } from './GraphView'

/** What is known of the node or relationship selected in a graph. */
export function Inspector({ selection, nodes, fragments }: { selection: NonNullable<Selection>; nodes: readonly GraphNode[]; fragments: readonly string[] }) {
  if (selection.kind === 'edge') {
    const { edge } = selection
    const end = (id: string) => {
      const node = nodes.find(n => n.id === id)
      return node ? captionOf(node) : id
    }
    return (
      <aside className="studio-inspector" aria-label="Selected relationship">
        <h3>{edge.type}</h3>
        <p className="desk-text-small desk-text-muted">{end(edge.from)} {edge.directed ? '→' : '—'} {end(edge.to)}</p>
        {edge.added && <p className="desk-text-small studio-added-note">Not in the result: drawn because it connects two nodes that are.</p>}
        <Properties values={edge.properties} empty="This relationship carries no properties in this view." />
      </aside>
    )
  }
  const { node } = selection
  return (
    <aside className="studio-inspector" aria-label="Selected node">
      <h3>
        <span className="studio-swatch" style={{ background: colourOf(fragments, node.fragment) }} />
        {captionOf(node)}
      </h3>
      <p className="desk-text-small desk-text-muted">{kindOf(node)}</p>
      <Properties values={node.properties} empty="No properties." />
      {Object.keys(node.aggregates).length > 0 && (
        <>
          <h4 className="desk-text-small desk-text-muted">Aggregates</h4>
          <Properties values={node.aggregates} empty="" />
        </>
      )}
    </aside>
  )
}

function Properties({ values, empty }: { values: Record<string, unknown>; empty: string }) {
  const entries = Object.entries(values)
  if (entries.length === 0) return empty ? <p className="desk-text-small desk-text-muted">{empty}</p> : null
  return (
    <dl className="studio-properties">
      {entries.map(([name, value]) => (
        <div key={name}>
          <dt className="desk-text-caption desk-text-muted">{name}</dt>
          <dd className={value === null ? 'desk-text-muted' : undefined}>
            {value === null ? 'absent' : typeof value === 'object' ? JSON.stringify(value) : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * What a node is, under its name: the fragment it was loaded as, then its labels. A node from Cypher has no fragment
 * of its own, so it is told by its first label, and that label is not said twice.
 */
export function kindOf(node: Pick<GraphNode, 'fragment' | 'labels'>): string {
  const labels = node.labels.map(l => `:${l}`).join('')
  return node.fragment === node.labels[0] || !node.fragment ? labels : `${node.fragment} ${labels}`.trim()
}
