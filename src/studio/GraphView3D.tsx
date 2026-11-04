import { Button } from '@liberation-data/desk/react'
import { useEffect, useRef } from 'react'
import type { ForceGraph3DInstance } from '3d-force-graph'
import type { GraphEdge, GraphNode, Result } from './api'
import { captionOf, colourOf } from './GraphView'
import type { Selection } from './GraphView'

/*
 * The same graph as GraphView, in three dimensions: depth pulls apart what a flat layout piles up, at the cost of
 * reading. A prototype, behind the 2D / 3D switch.
 *
 * Moving about, as most 3D viewers do:
 *   rotate  drag on empty space (one finger on a trackpad), or the arrow keys
 *   pan     right-drag, ⇧-drag or ⌘-drag, two fingers on a trackpad, or ⇧ and the arrows
 *   zoom    the scroll wheel, a pinch, or + and −
 *   fit     double-click empty space, or 0
 *   focus   double-click a node: the view flies to it and turns about it
 * A click selects, as in 2D. A node dragged stays where it is put, until it is double-clicked.
 */

interface Node3D { id: string; node: GraphNode; colour: string; root: boolean; x?: number; y?: number; z?: number; fx?: number; fy?: number; fz?: number }
interface Link3D { source: string | Node3D; target: string | Node3D; edge: GraphEdge }

/** The parts of three's OrbitControls this uses. */
interface Orbit {
  target: { x: number; y: number; z: number; set(x: number, y: number, z: number): void }
  enableZoom: boolean
  screenSpacePanning: boolean
  update(): void
  mouseButtons: Record<string, number>
  _onPointerUp: (event: PointerEvent) => void
}

/** How long a second click may follow the first and count as a double-click. */
const DOUBLE_MS = 300
/** How far one press of an arrow turns the view, in radians, and how far ⇧ and an arrow pans, as a share of the distance. */
const TURN = Math.PI / 24
const PAN = 0.08
const FLY_MS = 700

const escape = (text: string) => text.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)

interface Props {
  graph: Result['graph']
  fragments: readonly string[]
  onSelect: (selection: Selection) => void
}

export function GraphView3D({ graph, fragments, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const view = useRef<ForceGraph3DInstance | null>(null)
  const select = useRef(onSelect)
  select.current = onSelect
  const chosen = useRef<string | null>(null)
  const latest = useRef({ graph, fragments })
  latest.current = { graph, fragments }

  useEffect(() => {
    const element = container.current
    if (!element) return
    let gone = false
    let teardown = () => {}
    // three wants a window: loaded on the client, once the view is on screen.
    void import('3d-force-graph').then(({ default: ForceGraph3D }) => {
      if (gone) return
      const tokens = getComputedStyle(element)
      const token = (name: string, fallback: string) => tokens.getPropertyValue(name).trim() || fallback
      const surface = token('--desk-surface', '#ffffff')
      const muted = token('--desk-muted', '#8a8a8e')
      const accent = token('--desk-accent', '#0a84ff')

      const g = new ForceGraph3D(element, { controlType: 'orbit' })
      view.current = g
      const controls = g.controls() as Orbit
      // Pan moves the view across the screen, not along the ground; the wheel is ours, below.
      controls.screenSpacePanning = true
      controls.enableZoom = false
      /*
       * After a drag (and a click is a drag that went nowhere), 3d-force-graph sends a made-up pointerup to end any
       * gesture of the controls'. three 0.187's OrbitControls looks up where that pointer was, finds nothing and
       * throws. The listener is taken from this property each time a press begins, so wrapped here, before any.
       */
      const up = controls._onPointerUp
      controls._onPointerUp = (event: PointerEvent) => {
        try {
          up(event)
        } catch (error) {
          if (event.isTrusted) throw error
        }
      }
      const camera = () => g.camera() as unknown as { position: { x: number; y: number; z: number; set(x: number, y: number, z: number): void } }

      g.backgroundColor(surface)
        .showNavInfo(false)
        .nodeId('id')
        .nodeLabel((n: object) => {
          const node = (n as Node3D).node
          return `<div class="studio-graph3d-tip"><b>${escape(captionOf(node))}</b> <span>${escape(node.labels.join(':'))}</span></div>`
        })
        .nodeColor((n: object) => ((n as Node3D).id === chosen.current ? accent : (n as Node3D).colour))
        .nodeVal((n: object) => ((n as Node3D).root ? 3 : 1.5))
        .nodeOpacity(0.95)
        .nodeResolution(16)
        .linkColor((l: object) => ((l as Link3D).edge.id === chosen.current ? accent : muted))
        .linkOpacity(0.45)
        .linkWidth((l: object) => ((l as Link3D).edge.id === chosen.current ? 1.2 : 0))
        .linkLabel((l: object) => escape((l as Link3D).edge.type))
        .linkDirectionalArrowLength((l: object) => ((l as Link3D).edge.directed ? 3 : 0))
        .linkDirectionalArrowRelPos(1)
        .linkDirectionalArrowColor(() => muted)

      const recolour = () => g.nodeColor(g.nodeColor()).linkColor(g.linkColor()).linkWidth(g.linkWidth())
      // With no height yet there is nothing to fit to: three-forcegraph would put the camera at NaN.
      const fit = () => {
        if (element.clientHeight > 0) g.zoomToFit(FLY_MS, 40)
      }
      const focus = (n: Node3D) => {
        const { x = 0, y = 0, z = 0 } = n
        const at = camera().position
        const distance = Math.hypot(at.x - x, at.y - y, at.z - z)
        const keep = Math.min(distance, 120) / Math.max(distance, 1e-6)
        g.cameraPosition({ x: x + (at.x - x) * keep, y: y + (at.y - y) * keep, z: z + (at.z - z) * keep }, { x, y, z }, FLY_MS)
      }

      // Clicks: one selects; a second soon after on the same thing is a double-click.
      let last: { what: string | null; at: number } = { what: null, at: 0 }
      const doubled = (what: string | null) => {
        const now = performance.now()
        const twice = last.what === what && now - last.at < DOUBLE_MS
        last = twice ? { what: null, at: 0 } : { what, at: now }
        return twice
      }
      g.onNodeClick((n: object) => {
        const node = n as Node3D
        if (doubled(node.id)) {
          // Let go of where it was put, and flown to.
          node.fx = node.fy = node.fz = undefined
          focus(node)
          return
        }
        chosen.current = node.id
        recolour()
        select.current({ kind: 'node', node: node.node })
      })
      g.onLinkClick((l: object) => {
        chosen.current = (l as Link3D).edge.id
        recolour()
        select.current({ kind: 'edge', edge: (l as Link3D).edge })
      })
      g.onBackgroundClick(() => {
        if (doubled(null)) return fit()
        chosen.current = null
        recolour()
        select.current(null)
      })
      // Put down by hand, it stays.
      g.onNodeDragEnd((n: object) => {
        const node = n as Node3D
        node.fx = node.x
        node.fy = node.y
        node.fz = node.z
      })
      g.onEngineStop(() => {
        if (!framed) {
          framed = true
          fit()
        }
      })
      let framed = false

      /*
       * The wheel: a pinch (which a browser reports as a wheel with ctrl) or a mouse's wheel zooms; two fingers on a
       * trackpad pan. A trackpad scrolls in pixels and sideways too; a mouse wheel in whole steps, straight up and down.
       */
      const dolly = (factor: number) => {
        const at = camera().position
        const t = controls.target
        at.set(t.x + (at.x - t.x) * factor, t.y + (at.y - t.y) * factor, t.z + (at.z - t.z) * factor)
        controls.update()
      }
      const pan = (dx: number, dy: number) => {
        // Along the screen's own right and up, as far as the view is from what it looks at.
        const cam = g.camera() as unknown as { matrix: { elements: number[] }; position: { x: number; y: number; z: number } }
        const e = cam.matrix.elements
        const right = [e[0]!, e[1]!, e[2]!]
        const up = [e[4]!, e[5]!, e[6]!]
        const t = controls.target
        const at = camera().position
        const scale = Math.hypot(at.x - t.x, at.y - t.y, at.z - t.z) / Math.max(1, element.clientHeight)
        const mx = (-dx * right[0]! + dy * up[0]!) * scale
        const my = (-dx * right[1]! + dy * up[1]!) * scale
        const mz = (-dx * right[2]! + dy * up[2]!) * scale
        at.set(at.x + mx, at.y + my, at.z + mz)
        t.set(t.x + mx, t.y + my, t.z + mz)
        controls.update()
      }
      const turn = (horizontal: number, vertical: number) => {
        const at = camera().position
        const t = controls.target
        const [x, y, z] = [at.x - t.x, at.y - t.y, at.z - t.z]
        const r = Math.hypot(x, y, z)
        const theta = Math.atan2(x, z) - horizontal
        const phi = Math.min(Math.PI - 0.05, Math.max(0.05, Math.acos(y / r) - vertical))
        at.set(t.x + r * Math.sin(phi) * Math.sin(theta), t.y + r * Math.cos(phi), t.z + r * Math.sin(phi) * Math.cos(theta))
        controls.update()
      }
      const wheel = (event: WheelEvent) => {
        event.preventDefault()
        const trackpad = !event.ctrlKey && event.deltaMode === 0 && (event.deltaX !== 0 || !Number.isInteger(event.deltaY) || Math.abs(event.deltaY) < 40)
        if (trackpad) pan(event.deltaX, event.deltaY)
        else dolly(Math.exp(event.deltaY * (event.ctrlKey ? 0.01 : 0.002)))
      }
      element.addEventListener('wheel', wheel, { passive: false })

      const key = (event: KeyboardEvent) => {
        const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]
        if (step) {
          const [h, v] = step as [number, number]
          if (event.shiftKey) pan(h * PAN * element.clientHeight, v * PAN * element.clientHeight)
          else turn(h * TURN, v * TURN)
        } else if (event.key === '+' || event.key === '=') dolly(0.85)
        else if (event.key === '-' || event.key === '_') dolly(1 / 0.85)
        else if (event.key === '0') fit()
        else if (event.key === 'Enter' && chosen.current) {
          const n = (g.graphData().nodes as Node3D[]).find(it => it.id === chosen.current)
          if (n) focus(n)
        } else return
        event.preventDefault()
      }
      element.addEventListener('keydown', key)

      const resized = new ResizeObserver(() => g.width(element.clientWidth).height(element.clientHeight))
      resized.observe(element)
      g.width(element.clientWidth).height(element.clientHeight)
      // The graph that was there before three arrived.
      draw(g)
      element.dataset.ready = 'true'
      // For the Reset view button, and for a test to reach the view.
      Object.assign(element, { _fit: fit, _graph: g })

      teardown = () => {
        resized.disconnect()
        element.removeEventListener('wheel', wheel)
        element.removeEventListener('keydown', key)
        g._destructor()
        element.replaceChildren()
      }
    })
    return () => {
      gone = true
      teardown()
      view.current = null
    }
  }, [])

  const draw = (g: ForceGraph3DInstance) => {
    const { graph, fragments } = latest.current
    const roots = new Set(graph.roots)
    const ids = new Set(graph.nodes.map(n => n.id))
    chosen.current = null
    g.graphData({
      nodes: graph.nodes.map((node): Node3D => ({ id: node.id, node, colour: colourOf(fragments, node.fragment), root: roots.has(node.id) })),
      links: graph.edges.filter(e => ids.has(e.from) && ids.has(e.to)).map((edge): Link3D => ({ source: edge.from, target: edge.to, edge })),
    })
  }

  useEffect(() => {
    if (view.current) draw(view.current)
  }, [graph, fragments])

  return (
    <div className="studio-graph">
      <div
        ref={container}
        className="studio-graph-canvas studio-graph3d"
        tabIndex={0}
        role="img"
        aria-label={`Graph of ${graph.nodes.length} nodes and ${graph.edges.length} relationships, in 3D. Arrows turn it, shift and the arrows pan, plus and minus zoom, 0 fits it.`}
      />
      <span className="studio-graph3d-reset">
        <Button size="small" onClick={() => (container.current as unknown as { _fit?: () => void } | null)?._fit?.()}>Reset view</Button>
      </span>
      <p className="studio-graph3d-hint desk-text-small desk-text-muted">Drag to turn · ⇧-drag or two fingers to pan · pinch or scroll to zoom · double-click to focus</p>
    </div>
  )
}
