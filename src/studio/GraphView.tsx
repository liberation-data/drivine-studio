import cytoscape from 'cytoscape'
import type { Core } from 'cytoscape'
import { useEffect, useRef, useState } from 'react'
import type { GraphEdge, GraphNode, Result } from './api'
import { IconPicker, Swatch } from './IconPicker'
import { useLabelIcons } from './icons'

// One colour per fragment, in the order the catalogue lists them. Every node is also named, and the
// legend says which is which, so colour is never the only thing telling two apart.
const PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#b07aa1', '#e15759', '#76b7b2', '#d4a72c', '#9c755f']

export const colourOf = (fragments: readonly string[], fragment: string): string =>
  PALETTE[Math.max(0, fragments.indexOf(fragment)) % PALETTE.length] ?? '#888888'

/** What to call a node: its name or title when it has one, else its first text, else its fragment. */
export function captionOf(node: GraphNode): string {
  const { name, title } = node.properties
  const text = [name, title, ...Object.values(node.properties)].find(v => typeof v === 'string' && v !== '' && !isUuid(v))
  return typeof text === 'string' ? text : node.fragment
}

const isUuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value)
const short = (text: string) => (text.length > 26 ? `${text.slice(0, 25)}…` : text)

export type Selection = { kind: 'node'; node: GraphNode } | { kind: 'edge'; edge: GraphEdge } | null

interface Props {
  graph: Result['graph']
  /** Every fragment name in the catalogue, which fixes each one's colour across queries. */
  fragments: readonly string[]
  onSelect: (selection: Selection) => void
}

export function GraphView({ graph, fragments, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const cy = useRef<Core | null>(null)
  const select = useRef(onSelect)
  select.current = onSelect

  useEffect(() => {
    const element = container.current
    if (!element) return
    const core = cytoscape({ container: element, wheelSensitivity: 0.3, minZoom: 0.2, maxZoom: 3 })
    cy.current = core
    core.on('tap', event => {
      if (event.target === core) select.current(null)
    })
    core.on('tap', 'node', event => select.current({ kind: 'node', node: event.target.data('node') as GraphNode }))
    core.on('tap', 'edge', event => select.current({ kind: 'edge', edge: event.target.data('edge') as GraphEdge }))

    // A canvas cannot read CSS variables, so the desk's colours are read once and again when the scheme changes.
    const paint = () => {
      const tokens = getComputedStyle(element)
      const token = (name: string, fallback: string) => tokens.getPropertyValue(name).trim() || fallback
      const ink = token('--desk-ink', '#1c1c1e')
      const muted = token('--desk-muted', '#8a8a8e')
      const surface = token('--desk-surface', '#ffffff')
      const accent = token('--desk-accent', '#0a84ff')
      core.style([
        {
          selector: 'node',
          style: {
            'background-color': 'data(colour)', label: 'data(caption)', color: ink, 'font-size': 11,
            'text-valign': 'bottom', 'text-margin-y': 5, 'text-background-color': surface,
            'text-background-opacity': 0.85, 'text-background-padding': '2px', 'text-background-shape': 'roundrectangle',
            width: 30, height: 30, 'border-width': 0, 'border-color': ink,
          },
        },
        // The label's icon, drawn white on its colour, where it has one.
        {
          selector: 'node[icon]',
          style: { 'background-image': 'data(icon)', 'background-width': '58%', 'background-height': '58%', 'background-clip': 'none' },
        },
        // The roots are what loadAll returned; everything else was reached from one of them.
        { selector: 'node[?root]', style: { width: 38, height: 38, 'border-width': 3 } },
        {
          selector: 'edge',
          style: {
            width: 1.5, 'line-color': muted, 'target-arrow-color': muted, 'curve-style': 'bezier',
            label: 'data(type)', 'font-size': 9, color: muted, 'text-rotation': 'autorotate',
            'text-background-color': surface, 'text-background-opacity': 0.85, 'text-background-padding': '1px',
          },
        },
        { selector: 'edge[?directed]', style: { 'target-arrow-shape': 'triangle' } },
        { selector: 'node:selected', style: { 'border-width': 4, 'border-color': accent } },
        { selector: 'edge:selected', style: { width: 3, 'line-color': accent, 'target-arrow-color': accent, color: ink } },
      ])
    }
    paint()
    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    scheme.addEventListener('change', paint)
    const resized = new ResizeObserver(() => core.resize())
    resized.observe(element)
    return () => {
      scheme.removeEventListener('change', paint)
      resized.disconnect()
      core.destroy()
      cy.current = null
    }
  }, [])

  useEffect(() => {
    const core = cy.current
    if (!core) return
    const roots = new Set(graph.roots)
    core.elements().remove()
    core.add([
      ...graph.nodes.map(node => ({
        group: 'nodes' as const,
        data: { id: node.id, caption: short(captionOf(node)), colour: colourOf(fragments, node.fragment), root: roots.has(node.id), node },
      })),
      ...graph.edges.map(edge => ({
        group: 'edges' as const,
        data: { id: edge.id, source: edge.from, target: edge.to, type: edge.type, directed: edge.directed, edge },
      })),
    ])
    // Randomised: new nodes all start at the origin, and the layout cannot pull apart what begins stacked.
    core.layout({ name: 'cose', animate: false, randomize: true, nodeDimensionsIncludeLabels: true, padding: 40, nodeRepulsion: () => 12000, idealEdgeLength: () => 150 }).run()
    core.fit(undefined, 40)
    // A handful of nodes would otherwise be blown up to fill the window, names and all.
    if (core.zoom() > 1) {
      core.zoom(1)
      core.center()
    }
  }, [graph, fragments])

  const present = fragments.filter(f => graph.nodes.some(n => n.fragment === f))
  const { images, icons } = useLabelIcons(present)
  const [choosing, setChoosing] = useState<string | null>(null)

  // Icons arrive after the graph is drawn, and change when one is chosen: set on the nodes, with no new layout.
  useEffect(() => {
    const core = cy.current
    if (!core) return
    core.nodes().forEach(node => {
      const image = images[(node.data('node') as GraphNode).fragment]
      if (image) node.data('icon', image)
      else node.removeData('icon')
    })
  }, [images, graph])

  return (
    <div className="studio-graph">
      <div ref={container} className="studio-graph-canvas" role="img" aria-label={`Graph of ${graph.nodes.length} nodes and ${graph.edges.length} relationships`} />
      <ul className="studio-legend desk-text-caption" aria-label="Fragments">
        {present.map(fragment => (
          <li key={fragment}>
            <button type="button" className="studio-legend-entry" title={`Choose the icon of ${fragment}`} onClick={() => setChoosing(fragment)}>
              <Swatch colour={colourOf(fragments, fragment)} icon={icons[fragment]?.icon ?? null} />
              {fragment}
            </button>
          </li>
        ))}
      </ul>
      {choosing && <IconPicker label={choosing} current={icons[choosing]} onDone={() => setChoosing(null)} />}
    </div>
  )
}
