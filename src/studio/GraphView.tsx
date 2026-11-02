import { Toggle } from '@liberation-data/desk/react'
import cytoscape from 'cytoscape'
import type { Core, Layouts, LayoutOptions, NodeSingular } from 'cytoscape'
import cola from 'cytoscape-cola'
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

/**
 * The label a fragment's icon is: its nodes' first label, the one it is told by, the same in every window. Nodes with
 * no label have none, and are drawn plain.
 */
export const iconLabelOf = (nodes: readonly GraphNode[], fragment: string): string | undefined =>
  nodes.find(n => n.fragment === fragment)?.labels[0]

cytoscape.use(cola)

export interface Part { readonly width: number; readonly height: number }
export interface Place { readonly x: number; readonly y: number }

/**
 * Where to put each part of a graph that shares no relationship with the rest: the top left corner of each, in rows of
 * about the shape of the window (`aspect`, its width over its height), the tallest first, each row centred and each
 * part centred in its row. A layout lays the parts out apart from one another, and would otherwise draw them over each
 * other.
 */
export function pack(parts: readonly Part[], aspect: number, gap: number): Place[] {
  const order = parts.map((_, i) => i).sort((a, b) => parts[b]!.height - parts[a]!.height)
  const area = parts.reduce((sum, p) => sum + (p.width + gap) * (p.height + gap), 0)
  const widest = Math.max(0, ...parts.map(p => p.width))
  const across = Math.max(widest, Math.sqrt(area * (aspect > 0 ? aspect : 1)))
  const rows: number[][] = []
  let used = Infinity
  for (const i of order) {
    const width = parts[i]!.width
    if (used + gap + width > across) {
      rows.push([i])
      used = width
    } else {
      rows[rows.length - 1]!.push(i)
      used += gap + width
    }
  }
  const places: Place[] = new Array(parts.length)
  let y = 0
  for (const row of rows) {
    const width = row.reduce((sum, i) => sum + parts[i]!.width, 0) + gap * (row.length - 1)
    const height = Math.max(...row.map(i => parts[i]!.height))
    let x = (across - width) / 2
    for (const i of row) {
      places[i] = { x, y: y + (height - parts[i]!.height) / 2 }
      x += parts[i]!.width + gap
    }
    y += height + gap
  }
  return places
}

/** Moves the graph's parts that share no relationship apart, so none is drawn over another. */
function separate(core: Core) {
  const parts = core.elements().components()
  if (parts.length < 2) return
  const boxes = parts.map(part => part.boundingBox({ includeLabels: true }))
  const places = pack(boxes.map(b => ({ width: b.w, height: b.h })), core.width() / Math.max(1, core.height()), 60)
  parts.forEach((part, i) => {
    const dx = places[i]!.x - boxes[i]!.x1
    const dy = places[i]!.y - boxes[i]!.y1
    part.nodes().positions(node => ({ x: node.position('x') + dx, y: node.position('y') + dy }))
  })
}

/*
 * A live layout, as Neo4j Browser's: drag a node and its neighbours follow and the rest make room, then it all settles
 * and stops, so nothing moves while it is read. A node let go of stays where it was put; a double-click lets it go.
 * Past this many nodes it starts off, as the motion is noise and the simulation costs more than it shows.
 */
const LIVE_UP_TO = 300
/** How far out the view zooms past the zoom that frames the graph: to where it fills half as much. */
const ZOOM_OUT = 0.5
/** The furthest out any graph is drawn, however large. */
const FURTHEST = 0.02
/** How long the graph keeps moving after a node is let go of. */
const SETTLE_MS = 1500

/** Cola, which runs a force simulation that a dragged node takes part in; its options are not in cytoscape's types. */
const colaOptions = (more: Record<string, unknown>): LayoutOptions =>
  ({
    name: 'cola', animate: true, fit: false, nodeDimensionsIncludeLabels: true, nodeSpacing: 14,
    // The length cose laid the graph out at, so a drag carries on from that layout rather than pulling it to another.
    edgeLength: 150,
    // Carry on from where the nodes are: no layout from scratch first, and no repacking of the parts not joined up.
    unconstrIter: 0, userConstIter: 0, allConstIter: 0, handleDisconnected: false,
    ...more,
  }) as unknown as LayoutOptions

/** The node cola simulates for this one: setting bit 1 of `fixed` holds it, and a drag clears only bits 2 and 4. */
const simulated = (node: NodeSingular) => node.scratch('cola') as { fixed?: number } | undefined

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
  const [live, setLive] = useState(graph.nodes.length <= LIVE_UP_TO)
  const liveNow = useRef(live)
  liveNow.current = live
  // The simulation running now, if any; the nodes put down by hand, which it holds where they are.
  const running = useRef<Layouts | null>(null)
  const pinned = useRef(new Set<string>())
  const settling = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const element = container.current
    if (!element) return
    const core = cytoscape({ container: element, wheelSensitivity: 0.3, minZoom: FURTHEST, maxZoom: 3 })
    cy.current = core
    core.on('tap', event => {
      if (event.target === core) select.current(null)
    })
    core.on('tap', 'node', event => select.current({ kind: 'node', node: event.target.data('node') as GraphNode }))
    core.on('tap', 'edge', event => select.current({ kind: 'edge', edge: event.target.data('edge') as GraphEdge }))

    const stop = () => {
      clearTimeout(settling.current)
      running.current?.stop()
      running.current = null
    }
    // Every run starts from where the nodes are, holding the pinned ones, and runs until it is stopped.
    const simulate = () => {
      clearTimeout(settling.current)
      if (running.current) return
      const layout = core.layout(colaOptions({ infinite: true, randomize: false }))
      layout.run()
      core.nodes().forEach(node => {
        const held = simulated(node)
        if (held && pinned.current.has(node.id())) held.fixed = (held.fixed ?? 0) | 1
      })
      running.current = layout
    }
    const settle = () => {
      clearTimeout(settling.current)
      settling.current = setTimeout(stop, SETTLE_MS)
    }
    /*
     * Only a node that actually moves wakes the graph: a click is a grab and a free with no drag between, and shakes
     * nothing. Cola takes part in a drag from its grab, so the grab it missed is given to it once it is running.
     */
    let dragging: NodeSingular | null = null
    core.on('drag', 'node', event => {
      const node = event.target as NodeSingular
      if (!liveNow.current || dragging === node) return
      dragging = node
      const started = !running.current
      simulate()
      if (started) node.emit('grab')
    })
    // After cola's own handler on the node has let the drag go: put down by hand, it stays.
    core.on('free', 'node', event => {
      const node = event.target as NodeSingular
      if (dragging !== node) return
      dragging = null
      pinned.current.add(node.id())
      const held = simulated(node)
      if (held) held.fixed = (held.fixed ?? 0) | 1
      node.addClass('pinned')
      settle()
    })
    core.on('dbltap', 'node', event => {
      const node = event.target as NodeSingular
      if (!pinned.current.delete(node.id())) return
      node.removeClass('pinned')
      const held = simulated(node)
      if (held) held.fixed = (held.fixed ?? 0) & ~1
      // Let go of, it finds its own place again.
      if (liveNow.current) {
        simulate()
        settle()
      }
    })

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
        // Put down by hand, and held there while the rest move: a dashed ring says so.
        { selector: 'node.pinned', style: { 'border-width': 2, 'border-style': 'dashed', 'border-color': muted } },
        // Chosen: a ring of the accent outside a gap of the ground, so it never sits against the node's own colour.
        {
          selector: 'node:selected',
          style: { 'border-width': 2, 'border-style': 'solid', 'border-color': surface, 'outline-width': 3, 'outline-color': accent, 'outline-offset': 0 },
        },
        { selector: 'edge:selected', style: { width: 3, 'line-color': accent, 'target-arrow-color': accent, color: ink } },
      ])
    }
    paint()
    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    scheme.addEventListener('change', paint)
    const resized = new ResizeObserver(() => core.resize())
    resized.observe(element)
    return () => {
      stop()
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
    clearTimeout(settling.current)
    running.current?.stop()
    running.current = null
    pinned.current.clear()
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
    const frame = () => {
      // However large the graph, it can be framed whole: the limit is set again from the zoom that frames it.
      core.minZoom(FURTHEST)
      core.fit(undefined, 40)
      // A handful of nodes would otherwise be blown up to fill the window, names and all.
      if (core.zoom() > 1) {
        core.zoom(1)
        core.center()
      }
      // Out to where the whole graph fills a fraction of the view and no further, rather than to a speck.
      core.minZoom(Math.max(FURTHEST, core.zoom() * ZOOM_OUT))
    }
    const cose = () =>
      core.layout({ name: 'cose', animate: false, randomize: true, nodeDimensionsIncludeLabels: true, padding: 40, nodeRepulsion: () => 12000, idealEdgeLength: () => 150 }).run()
    // Randomised: new nodes all start at the origin, and no layout can pull apart what begins stacked.
    if (graph.nodes.length > LIVE_UP_TO) {
      cose()
      frame()
      return
    }
    /*
     * A graph small enough to drag live is laid out by the simulation a drag runs, so a drag carries on from where the
     * nodes are rather than pulling them toward another layout's idea of them. It settles out of sight and is framed
     * once, then shown: the view never zooms while anything moves.
     */
    const element = container.current
    if (element) element.style.opacity = '0'
    const layout = core.layout(colaOptions({ animate: false, randomize: true, maxSimulationTime: 3000, unconstrIter: 10, allConstIter: 10 }))
    layout.one('layoutstop', () => {
      // Stopped for a new graph: that one shows itself.
      if (running.current !== layout || core.destroyed()) return
      running.current = null
      // Cola lays out each part that shares no relationship on its own; set side by side, none is drawn over another.
      separate(core)
      frame()
      if (element) element.style.opacity = ''
    })
    running.current = layout
    layout.run()
  }, [graph, fragments])

  const present = fragments.filter(f => graph.nodes.some(n => n.fragment === f))
  const labelOf = (fragment: string) => iconLabelOf(graph.nodes, fragment)
  const { images, icons } = useLabelIcons(present.flatMap(fragment => labelOf(fragment) ?? []))
  const [choosing, setChoosing] = useState<string | null>(null)

  // Turned off, nothing moves but what is dragged.
  useEffect(() => {
    if (live) return
    clearTimeout(settling.current)
    running.current?.stop()
    running.current = null
  }, [live])

  // Icons arrive after the graph is drawn, and change when one is chosen: set on the nodes, with no new layout.
  useEffect(() => {
    const core = cy.current
    if (!core) return
    core.nodes().forEach(node => {
      const label = (node.data('node') as GraphNode).labels[0]
      const image = label === undefined ? undefined : images[label]
      if (image) node.data('icon', image)
      else node.removeData('icon')
    })
  }, [images, graph, fragments])

  return (
    <div className="studio-graph">
      <div ref={container} className="studio-graph-canvas" role="img" aria-label={`Graph of ${graph.nodes.length} nodes and ${graph.edges.length} relationships`} />
      <div className="studio-graph-controls desk-text-small">
        <Toggle
          label="Live layout"
          checked={live}
          onChange={setLive}
        />
      </div>
      <ul className="studio-legend" aria-label="Fragments">
        {present.map(fragment => {
          const label = labelOf(fragment)
          return (
            <li key={fragment}>
              {label === undefined ? (
                <>
                  <Swatch colour={colourOf(fragments, fragment)} icon={null} />
                  {fragment}
                </>
              ) : (
                <button type="button" className="studio-legend-entry" title={`Choose the icon of ${label}`} onClick={() => setChoosing(label)}>
                  <Swatch colour={colourOf(fragments, fragment)} icon={icons[label]?.icon ?? null} />
                  {fragment}
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {choosing && <IconPicker label={choosing} current={icons[choosing]} onDone={() => setChoosing(null)} />}
    </div>
  )
}
