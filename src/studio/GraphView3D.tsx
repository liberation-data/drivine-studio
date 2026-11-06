import { Button, Checkbox } from '@liberation-data/desk/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ForceGraph3DInstance } from '3d-force-graph'
import type * as Three from 'three'
import type { GraphEdge, GraphNode, Result } from './api'
import { captionOf, colourOf, iconLabelOf } from './GraphView'
import type { Selection } from './GraphView'
import { clip, degrees, edgeLit, hubOf, keyAction, legendOf, litOf, namePriority, shownOf, toggled, uncrowded } from './graph3d'
import type { NameBox } from './graph3d'
import { redrawOf } from './connect'
import { Swatch } from './IconPicker'
import { useLabelIcons } from './icons'

/*
 * The same graph as GraphView, in three dimensions, for a small result (see MAX_3D_NODES): every node is a lit shape in
 * its fragment's colour, its label's icon on the side that faces the view, and fog lets what is near read first. Names
 * are given room in order (the node chosen, the one under the pointer, the focus node's neighbours, then hubs), and a
 * name that would overlap one shown already fades out until there is room for it.
 *
 * It opens close on the node with most relationships, turning slowly until it is touched, and again a few seconds
 * after. A click focuses a node: it and its neighbours stay solid, the rest fade; Esc or a click on empty space brings
 * them all back. The legend's checkboxes fade a fragment's nodes the same way.
 *
 * Moving about, as most 3D viewers do:
 *   rotate  drag on empty space (one finger on a trackpad), or the arrow keys
 *   pan     right-drag, ⇧-drag or ⌘-drag, two fingers on a trackpad, or ⇧ and the arrows
 *   zoom    the scroll wheel, a pinch, or + and −
 *   fit     double-click empty space, Reset view, or 0
 *   fly to  double-click a node, or Enter: the view flies to it and turns about it
 * A node dragged stays where it is put, until it is double-clicked.
 */

/** The shapes a node may be drawn as. One for now; a label could be given its own here, and in `shapes` below. */
type Shape = 'sphere'
const shapeOf = (_node: GraphNode): Shape => 'sphere'

interface Node3D {
  id: string
  node: GraphNode
  colour: string
  size: number
  /** The opacity it is drawn at now, eased toward the one it should have. */
  o: number
  /** How shown its name is now, and whether it has room to be. */
  nameO: number
  named: boolean
  x?: number; y?: number; z?: number; fx?: number; fy?: number; fz?: number
  group?: Three.Group
  body?: Three.MeshStandardMaterial
  rim?: { value: Three.Color }
  icon?: Three.Mesh<Three.PlaneGeometry, Three.MeshBasicMaterial>
  text?: Three.Sprite
  /** The name's width over its height, for its box on screen. */
  aspect?: number
  canvas?: HTMLCanvasElement
}
interface Link3D { source: string | Node3D; target: string | Node3D; edge: GraphEdge; o: number; line?: Three.LineBasicMaterial; cone?: Three.MeshBasicMaterial }

/** The parts of three's OrbitControls this uses. */
interface Orbit {
  target: { x: number; y: number; z: number; set(x: number, y: number, z: number): void }
  enableZoom: boolean
  screenSpacePanning: boolean
  autoRotate: boolean
  autoRotateSpeed: number
  update(): void
  addEventListener(type: 'start' | 'end', listener: () => void): void
  _onPointerUp: (event: PointerEvent) => void
}

/** How long a second click may follow the first and count as a double-click. */
const DOUBLE_MS = 300
/** How far one press of an arrow turns the view, in radians, and how far ⇧ and an arrow pans, as a share of the distance. */
const TURN = Math.PI / 24
const PAN = 0.08
const FLY_MS = 700
/** How long the view rests after it is touched before it turns again. */
const IDLE_MS = 4000
/** How fast it turns: three's units, where 2 is once round a minute. Slower about a node in focus. */
const SPIN = 0.5
const SPIN_FOCUSED = 0.3
/** How solid a faded node is, and how solid a relationship is, and a faded one. */
const FADED = 0.12
const LINK = 0.55
const LINK_FADED = 0.05
/** How much of the way to its new opacity a node goes each frame. */
const EASE = 0.12
/** An icon's canvas, in pixels: big enough to stay sharp close up. */
const ICON_PX = 128
/** How tall a name is, in the scene's units; how small on screen before it is not worth room; how often room is shared out. */
const NAME_HIGH = 3.4
const NAME_MIN_PX = 10
const ROOM_MS = 33
/** How far a name eases toward shown or hidden each frame. */
const NAME_EASE = 0.18
/** The simulation's ticks before a new graph is shown, and after, while it settles. */
const WARMUP = 160
const COOLDOWN = 40

const escape = (text: string) => text.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)
const ends = (l: Link3D) => [typeof l.source === 'string' ? l.source : l.source.id, typeof l.target === 'string' ? l.target : l.target.id] as const

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
  const latest = useRef({ graph, fragments })
  latest.current = { graph, fragments }

  const [focus, setFocus] = useState<string | null>(null)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const lit = useMemo(() => litOf(graph.nodes, graph.edges, focus, hidden), [graph, focus, hidden])
  const litNow = useRef(lit)
  litNow.current = lit
  const focusNow = useRef(focus)
  focusNow.current = focus

  const entries = useMemo(() => legendOf(graph.nodes, fragments), [graph, fragments])
  const labels = useMemo(() => [...new Set(graph.nodes.flatMap(n => n.labels.slice(0, 1)))], [graph])
  const { images, icons } = useLabelIcons(labels)
  const imagesNow = useRef(images)
  imagesNow.current = images
  // Set once three is here: draws the discs again, as when an icon arrives.
  const repaint = useRef<() => void>(() => {})
  // Set once three is here: draws the graph given.
  const draw = useRef<() => void>(() => {})
  // Set once three is here: gives the nodes drawn the relationships of the graph given, each node left where it is.
  const relink = useRef<() => void>(() => {})
  const drawnNow = useRef<{ graph: Result['graph']; fragments: readonly string[] } | null>(null)

  useEffect(() => {
    const element = container.current
    if (!element) return
    let gone = false
    let teardown = () => {}
    // three wants a window: loaded on the client, once the view is on screen.
    void Promise.all([import('3d-force-graph'), import('three')]).then(([{ default: ForceGraph3D }, THREE]) => {
      if (gone) return
      const tokens = getComputedStyle(element)
      const token = (name: string, fallback: string) => tokens.getPropertyValue(name).trim() || fallback
      const surface = token('--desk-surface', '#ffffff')
      const ink = token('--desk-ink', '#1d1d1f')
      const muted = token('--desk-muted', '#8a8a8e')
      const accent = token('--desk-accent', '#0a84ff')
      const font = token('--desk-font', 'system-ui, sans-serif')

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
      const camera = () => g.camera() as unknown as Three.PerspectiveCamera
      // Fog in the stage's own colour: what is past what the view looks at fades into it.
      const fog = new THREE.Fog(surface, 100, 1000)
      g.scene().fog = fog
      // Light from the sky and the ground, and a key light that goes with the view, so each shape is lit from the front.
      g.lights([new THREE.HemisphereLight(0xffffff, 0x8a9aa0, 1.4), new THREE.AmbientLight(0xffffff, 0.35)])
      const keyLight = new THREE.DirectionalLight(0xffffff, 1.5)
      keyLight.position.set(-0.6, 1, 0.8)
      camera().add(keyLight)
      g.scene().add(camera())

      // ── Turning by itself ──
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches
      let spinning = !still
      let idle: ReturnType<typeof setTimeout> | undefined
      let flyingUntil = 0
      const hold = () => {
        spinning = false
        clearTimeout(idle)
      }
      const rest = () => {
        clearTimeout(idle)
        if (!still) idle = setTimeout(() => (spinning = true), IDLE_MS)
      }
      const touched = () => {
        hold()
        rest()
      }
      controls.addEventListener('start', hold)
      controls.addEventListener('end', rest)

      // ── Nodes: a lit shape, its icon on the near side, and its name beneath ──
      const images = new Map<string, HTMLImageElement>()
      const imageOf = (url: string) => {
        let image = images.get(url)
        if (!image) {
          image = new Image()
          image.onload = () => repaint.current()
          image.src = url
          images.set(url, image)
        }
        return image.complete && image.naturalWidth > 0 ? image : undefined
      }
      const shapes: Record<Shape, Three.BufferGeometry> = { sphere: new THREE.SphereGeometry(0.5, 32, 20) }
      const iconPlane = new THREE.PlaneGeometry(1, 1)
      const accentColour = new THREE.Color(accent)
      const rimOf = (n: Node3D) => (n.id === chosen ? accentColour.clone() : new THREE.Color(n.colour).lerp(new THREE.Color(0xffffff), 0.55))
      /*
       * A soft rim, brighter at the edge than in the middle, as a bubble is: added to the light the material gives,
       * before fog, so a far shape's rim fades with it.
       */
      const withRim = (material: Three.MeshStandardMaterial, rim: { value: Three.Color }) => {
        material.onBeforeCompile = shader => {
          shader.uniforms.rimColour = rim
          shader.fragmentShader = shader.fragmentShader
            .replace('void main() {', 'uniform vec3 rimColour;\nvoid main() {')
            .replace(
              '#include <opaque_fragment>',
              'float rimAmount = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 2.4);\n' +
                'outgoingLight += rimColour * rimAmount * 0.85;\n#include <opaque_fragment>',
            )
        }
        return material
      }
      let chosen: string | null = null
      let hovered: string | null = null
      // The icon, white, on a clear canvas: the shape behind it gives the colour.
      const paint = (n: Node3D) => {
        const canvas = n.canvas
        const material = n.icon?.material
        if (!canvas || !material) return
        const c = canvas.getContext('2d')!
        c.clearRect(0, 0, ICON_PX, ICON_PX)
        const label = n.node.labels[0]
        const url = label === undefined ? undefined : imagesNow.current[label]
        const image = url ? imageOf(url) : undefined
        if (image) c.drawImage(image, ICON_PX * 0.18, ICON_PX * 0.18, ICON_PX * 0.64, ICON_PX * 0.64)
        n.icon!.visible = Boolean(image)
        if (material.map) material.map.needsUpdate = true
      }
      const mark = (n: Node3D) => {
        n.rim?.value.copy(rimOf(n))
        n.body?.emissive.set(n.id === chosen ? accent : 0x000000)
        if (n.body) n.body.emissiveIntensity = n.id === chosen ? 0.35 : 0
      }
      repaint.current = () => (g.graphData().nodes as Node3D[]).forEach(paint)
      const nameOf = (n: Node3D) => {
        const text = clip(captionOf(n.node))
        const px = 40
        const canvas = document.createElement('canvas')
        const c = canvas.getContext('2d')!
        c.font = `500 ${px}px ${font}`
        canvas.width = Math.ceil(c.measureText(text).width) + 16
        canvas.height = px + 16
        c.font = `500 ${px}px ${font}`
        c.textBaseline = 'middle'
        c.lineJoin = 'round'
        // A halo of the stage's colour, so a name reads over a relationship drawn behind it.
        c.lineWidth = 8
        c.strokeStyle = surface
        c.strokeText(text, 8, canvas.height / 2)
        c.fillStyle = ink
        c.fillText(text, 8, canvas.height / 2)
        const texture = new THREE.CanvasTexture(canvas)
        texture.colorSpace = THREE.SRGBColorSpace
        // Drawn over the shapes, its halo keeping it apart: a name half behind a nearer node can't be read.
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false, opacity: 0 })
        const sprite = new THREE.Sprite(material)
        sprite.renderOrder = 10
        n.aspect = canvas.width / canvas.height
        sprite.scale.set(NAME_HIGH * n.aspect, NAME_HIGH, 1)
        sprite.visible = false
        n.text = sprite
        return sprite
      }
      const makeNode = (o: object) => {
        const n = o as Node3D
        const group = new THREE.Group()
        n.group = group
        n.rim = { value: rimOf(n) }
        n.body = withRim(
          new THREE.MeshStandardMaterial({ color: n.colour, roughness: 0.5, metalness: 0, transparent: true, opacity: n.o }),
          n.rim,
        )
        const body = new THREE.Mesh(shapes[shapeOf(n.node)], n.body)
        body.scale.setScalar(n.size)
        n.canvas = document.createElement('canvas')
        n.canvas.width = n.canvas.height = ICON_PX
        const texture = new THREE.CanvasTexture(n.canvas)
        texture.colorSpace = THREE.SRGBColorSpace
        /*
         * A plane turned to face the view's eye, not a sprite: a sprite faces the screen, so on a node off to the side,
         * seen at a slant, it tilted into its own shape and the shape hid part of it.
         */
        n.icon = new THREE.Mesh(iconPlane, new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, opacity: n.o }))
        // After every shape: shapes and icons are both see-through, so three sorts them by distance each frame, and a shape
        // sorted after its own icon painted over part of it. The depth test stays, so a nearer shape still hides it.
        n.icon.renderOrder = 1
        n.icon.scale.set(n.size * 0.62, n.size * 0.62, 1)
        group.add(body, n.icon, nameOf(n))
        mark(n)
        paint(n)
        return group
      }

      // ── Relationships: a line, and a cone at the end it points to ──
      const coneShape = new THREE.ConeGeometry(0.9, 2.6, 10)
      coneShape.translate(0, -1.3, 0)
      const along = new THREE.Vector3(0, 1, 0)
      const makeLink = (o: object) => {
        const l = o as Link3D
        const group = new THREE.Group()
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3))
        l.line = new THREE.LineBasicMaterial({ color: l.edge.id === chosen ? accent : muted, transparent: true, opacity: l.o, depthWrite: false })
        group.add(new THREE.Line(geometry, l.line))
        if (l.edge.directed) {
          l.cone = new THREE.MeshBasicMaterial({ color: muted, transparent: true, opacity: l.o, depthWrite: false })
          group.add(new THREE.Mesh(coneShape, l.cone))
        }
        return group
      }
      type Point = Record<'x' | 'y' | 'z', number>
      const placeLink = (o: object, { start, end }: { start: Point; end: Point }, link: object) => {
        const group = o as Three.Group
        const line = group.children[0] as Three.Line
        const { source, target } = link as Link3D
        const direction = new THREE.Vector3(end.x - start.x, end.y - start.y, end.z - start.z)
        const length = direction.length()
        direction.normalize()
        // From disc's edge to disc's edge: a line across a disc's middle would take the click meant for the node.
        const off = Math.min(length / 2, ((source as Node3D).size ?? 0) / 2)
        const back = Math.min(length / 2, ((target as Node3D).size ?? 0) / 2)
        const position = line.geometry.getAttribute('position') as Three.BufferAttribute
        position.setXYZ(0, start.x + direction.x * off, start.y + direction.y * off, start.z + direction.z * off)
        position.setXYZ(1, end.x - direction.x * back, end.y - direction.y * back, end.z - direction.z * back)
        position.needsUpdate = true
        line.geometry.computeBoundingSphere()
        const cone = group.children[1]
        if (cone) {
          cone.position.set(end.x - direction.x * back, end.y - direction.y * back, end.z - direction.z * back)
          cone.quaternion.setFromUnitVectors(along, direction)
        }
        return true
      }
      const choose = (id: string | null) => {
        const before = chosen
        chosen = id
        for (const n of g.graphData().nodes as Node3D[]) if (n.id === before || n.id === id) mark(n)
        for (const l of g.graphData().links as Link3D[]) l.line?.color.set(l.edge.id === chosen ? accent : muted)
      }

      g.backgroundColor(surface)
        .showNavInfo(false)
        .nodeId('id')
        .nodeLabel((n: object) => {
          const node = (n as Node3D).node
          return `<div class="studio-graph3d-tip"><b>${escape(captionOf(node))}</b> <span>${escape(node.labels.join(':'))}</span></div>`
        })
        .nodeThreeObject(makeNode)
        .linkThreeObject(makeLink)
        .linkPositionUpdate(placeLink)
        .onNodeHover((n: object | null) => (hovered = n ? (n as Node3D).id : null))
        .linkLabel((l: object) => escape((l as Link3D).edge.type))
        // How near a line the pointer must be to pick it, in the scene's units: near, so a node beside one wins.
        .linkHoverPrecision(0.4)
        // Settled before it is shown: no nodes flying in from the middle.
        .warmupTicks(WARMUP)
        .cooldownTicks(COOLDOWN)

      // With no height yet there is nothing to fit to: three-forcegraph would put the camera at NaN.
      const fit = () => {
        if (element.clientHeight === 0) return
        flyingUntil = performance.now() + FLY_MS
        touched()
        g.zoomToFit(FLY_MS, 40)
      }
      const flyTo = (n: Node3D) => {
        const { x = 0, y = 0, z = 0 } = n
        const at = camera().position
        const distance = Math.hypot(at.x - x, at.y - y, at.z - z)
        const keep = Math.min(distance, 90) / Math.max(distance, 1e-6)
        flyingUntil = performance.now() + FLY_MS
        touched()
        g.cameraPosition({ x: x + (at.x - x) * keep, y: y + (at.y - y) * keep, z: z + (at.z - z) * keep }, { x, y, z }, FLY_MS)
      }
      // Close on the node with most relationships, from outside the graph looking in, with its neighbours in view.
      const open = () => {
        const nodes = g.graphData().nodes as Node3D[]
        const links = g.graphData().links as Link3D[]
        if (!nodes.length) return
        const pairs = links.map(l => ({ from: ends(l)[0], to: ends(l)[1] }))
        const hub = nodes.find(n => n.id === hubOf(nodes, pairs)) ?? nodes[0]!
        const at = (n: Node3D) => new THREE.Vector3(n.x ?? 0, n.y ?? 0, n.z ?? 0)
        const centre = nodes.reduce((sum, n) => sum.add(at(n)), new THREE.Vector3()).divideScalar(nodes.length)
        const outward = at(hub).sub(centre)
        // Level with the hub and a little above, whichever way it lies from the centre: a hub at the top had the view look
        // straight down, where the spin only turns the picture in place.
        outward.y = 0
        if (outward.lengthSq() < 1) outward.set(0, 0, 1)
        outward.normalize().add(new THREE.Vector3(0, 0.35, 0)).normalize()
        const near = new Set(pairs.flatMap(p => (p.from === hub.id ? [p.to] : p.to === hub.id ? [p.from] : [])))
        // The middle neighbour's distance, not the furthest: a hub's few far neighbours would push the view out of reading.
        const reaches = nodes.filter(n => near.has(n.id)).map(n => at(n).distanceTo(at(hub))).sort((x, y) => x - y)
        const reach = reaches[Math.floor(reaches.length / 2)] ?? 30
        const distance = Math.min(220, Math.max(60, reach * 2.6))
        g.cameraPosition(at(hub).add(outward.multiplyScalar(distance)), { x: hub.x ?? 0, y: hub.y ?? 0, z: hub.z ?? 0 }, 0)
      }
      let opened = false
      g.onEngineStop(() => {
        // After relinking, which moves nothing: a drag or a new graph moves and settles as before.
        g.warmupTicks(WARMUP).cooldownTicks(COOLDOWN)
        if (opened) return
        opened = true
        open()
        element.dataset.shown = 'true'
      })

      // Clicks: one focuses; a second soon after on the same thing is a double-click.
      let last: { what: string | null; at: number } = { what: null, at: 0 }
      const doubled = (what: string | null) => {
        const now = performance.now()
        const twice = last.what === what && now - last.at < DOUBLE_MS
        last = twice ? { what: null, at: 0 } : { what, at: now }
        return twice
      }
      g.onNodeClick((n: object) => {
        const node = n as Node3D
        touched()
        if (doubled(node.id)) {
          // Let go of where it was put, and flown to.
          node.fx = node.fy = node.fz = undefined
          flyTo(node)
          return
        }
        choose(node.id)
        setFocus(node.id)
        select.current({ kind: 'node', node: node.node })
      })
      g.onLinkClick((l: object) => {
        touched()
        choose((l as Link3D).edge.id)
        select.current({ kind: 'edge', edge: (l as Link3D).edge })
      })
      const all = () => {
        choose(null)
        setFocus(null)
        select.current(null)
      }
      g.onBackgroundClick(() => {
        touched()
        if (doubled(null)) return fit()
        all()
      })
      // Put down by hand, it stays.
      g.onNodeDragEnd((n: object) => {
        const node = n as Node3D
        node.fx = node.x
        node.fy = node.y
        node.fz = node.z
      })

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
        const e = camera().matrix.elements
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
        touched()
        const trackpad = !event.ctrlKey && event.deltaMode === 0 && (event.deltaX !== 0 || !Number.isInteger(event.deltaY) || Math.abs(event.deltaY) < 40)
        if (trackpad) pan(event.deltaX, event.deltaY)
        else dolly(Math.exp(event.deltaY * (event.ctrlKey ? 0.01 : 0.002)))
      }
      element.addEventListener('wheel', wheel, { passive: false })

      const key = (event: KeyboardEvent) => {
        const action = keyAction(event)
        if (!action) return
        if (action.kind === 'turn') turn(action.h * TURN, action.v * TURN)
        else if (action.kind === 'pan') pan(action.h * PAN * element.clientHeight, action.v * PAN * element.clientHeight)
        else if (action.kind === 'zoom') dolly(action.factor)
        else if (action.kind === 'fit') fit()
        else if (action.kind === 'all') all()
        else {
          const n = (g.graphData().nodes as Node3D[]).find(it => it.id === chosen)
          if (!n) return
          flyTo(n)
        }
        touched()
        event.preventDefault()
      }
      element.addEventListener('keydown', key)

      // Each frame: ease every node and relationship toward how solid it should be, keep the fog about what the view
      // looks at, and turn when nothing has touched the view for a while.
      /*
       * Room for names, shared out a few dozen times a second: in order of attention, each name whose box on screen
       * would overlap one already given room is hidden. A name too small to read takes none, and a faded node's name
       * none, unless it is chosen or under the pointer.
       */
      const toward = new THREE.Vector3()
      const screenUp = new THREE.Vector3(0, 1, 0)
      const spot = new THREE.Vector3()
      let roomAt = 0
      let order: string[] = []
      let orderKey = ''
      const share = () => {
        const nodes = g.graphData().nodes as Node3D[]
        const links = g.graphData().links as Link3D[]
        const asked = `${nodes.length}|${chosen}|${hovered}|${focusNow.current}`
        if (asked !== orderKey) {
          orderKey = asked
          order = namePriority(nodes.map(n => n.id), links.map(l => ({ from: ends(l)[0], to: ends(l)[1] })), { chosen, hovered, focus: focusNow.current })
        }
        const byId = new Map(nodes.map(n => [n.id, n]))
        const view = camera()
        view.updateMatrixWorld()
        const wide = element.clientWidth
        const high = element.clientHeight
        const perUnit = high / (2 * Math.tan((view.fov * Math.PI) / 360))
        const solid = litNow.current
        const boxes: NameBox[] = []
        for (const id of order) {
          const n = byId.get(id)
          if (!n?.text || !n.group) continue
          const must = id === chosen || id === hovered
          if (!must && !solid.has(id)) continue
          // Its shape first: no later node's name may cover it.
          spot.copy(n.group.position).applyMatrix4(view.matrixWorldInverse)
          const near = -spot.z
          if (near <= 0) continue
          spot.applyMatrix4(view.projectionMatrix)
          const across = (n.size * perUnit) / near
          boxes.push({ id, x: ((spot.x + 1) / 2) * wide, y: ((1 - spot.y) / 2) * high, width: across * 0.9, height: across * 0.9, obstacle: true })
          spot.copy(n.group.position).add(n.text.position)
          spot.applyMatrix4(view.matrixWorldInverse)
          const depth = -spot.z
          if (depth <= 0) continue
          const tall = (NAME_HIGH * perUnit) / depth
          if (!must && tall < NAME_MIN_PX) continue
          spot.applyMatrix4(view.projectionMatrix)
          const x = ((spot.x + 1) / 2) * wide
          const y = ((1 - spot.y) / 2) * high
          const width = tall * (n.aspect ?? 4)
          if (x + width / 2 < 0 || x - width / 2 > wide || y + tall / 2 < 0 || y - tall / 2 > high) continue
          // The name's ink is a little inside its canvas: the box is drawn in to it.
          boxes.push({ id, x, y, width: width * 0.94, height: tall * 0.72 })
        }
        const room = uncrowded(boxes, 3, 64, { width: wide, height: high })
        for (const n of nodes) n.named = room.has(n.id)
      }

      let frame = 0
      const tick = () => {
        frame = requestAnimationFrame(tick)
        const now = performance.now()
        const solid = litNow.current
        for (const n of g.graphData().nodes as Node3D[]) {
          const to = solid.has(n.id) ? 1 : FADED
          if (Math.abs(n.o - to) < 0.002) continue
          n.o += (to - n.o) * EASE
          if (n.body) {
            n.body.opacity = n.o
            // A faded shape doesn't hide what is behind it.
            n.body.depthWrite = n.o > 0.5
          }
          if (n.icon) n.icon.material.opacity = n.o
        }
        const at = camera().position
        // The screen's up, in the scene: a name hangs below its node as the view sees it, from above or below alike.
        const e = camera().matrixWorld.elements
        screenUp.set(e[4]!, e[5]!, e[6]!).normalize()
        if (now - roomAt > ROOM_MS) {
          roomAt = now
          share()
        }
        for (const n of g.graphData().nodes as Node3D[]) {
          // The icon on the side of the shape that faces the view.
          if (n.icon && n.group) {
            toward.set(at.x - n.group.position.x, at.y - n.group.position.y, at.z - n.group.position.z).normalize()
            n.icon.position.copy(toward).multiplyScalar(n.size * 0.52)
            n.icon.lookAt(at)
          }
          n.text?.position.copy(screenUp).multiplyScalar(-(n.size / 2 + NAME_HIGH * 0.8))
          const to = n.named ? 1 : 0
          if (n.text && Math.abs(n.nameO - to) > 0.002) {
            n.nameO += (to - n.nameO) * NAME_EASE
            n.text.material.opacity = n.nameO
            n.text.visible = n.nameO > 0.01
          }
        }
        for (const l of g.graphData().links as Link3D[]) {
          const [from, to] = ends(l)
          const target = edgeLit({ from, to }, solid) ? LINK : LINK_FADED
          if (Math.abs(l.o - target) < 0.002) continue
          l.o += (target - l.o) * EASE
          if (l.line) l.line.opacity = l.o
          if (l.cone) l.cone.opacity = l.o
        }
        const t = controls.target
        const distance = Math.hypot(at.x - t.x, at.y - t.y, at.z - t.z)
        fog.near = distance * 0.8
        fog.far = distance * 2.6
        controls.autoRotate = spinning && performance.now() > flyingUntil
        controls.autoRotateSpeed = focusNow.current ? SPIN_FOCUSED : SPIN
      }
      frame = requestAnimationFrame(tick)

      const resized = new ResizeObserver(() => g.width(element.clientWidth).height(element.clientHeight))
      resized.observe(element)
      g.width(element.clientWidth).height(element.clientHeight)
      draw.current = () => {
        const { graph, fragments } = latest.current
        const roots = new Set(graph.roots)
        const ids = new Set(graph.nodes.map(n => n.id))
        const counts = degrees(graph.edges)
        chosen = null
        hovered = null
        // A new graph of as many nodes, with nothing chosen, asks the same question: the old graph's order would name none.
        orderKey = ''
        opened = false
        element.dataset.shown = 'false'
        g.warmupTicks(WARMUP).cooldownTicks(COOLDOWN)
        g.graphData({
          nodes: graph.nodes.map((node): Node3D => ({
            id: node.id,
            node,
            colour: colourOf(fragments, node.fragment),
            size: (5 + 1.6 * Math.sqrt(counts.get(node.id) ?? 0)) * (roots.has(node.id) ? 1.2 : 1),
            o: 1,
            nameO: 0,
            named: false,
          })),
          links: graph.edges.filter(e => ids.has(e.from) && ids.has(e.to)).map((edge): Link3D => ({ source: edge.from, target: edge.to, edge, o: LINK })),
        })
      }
      relink.current = () => {
        const { graph } = latest.current
        const nodes = g.graphData().nodes as Node3D[]
        const ids = new Set(nodes.map(n => n.id))
        const was = new Map((g.graphData().links as Link3D[]).map(l => [l.edge.id, l]))
        const links = graph.edges
          .filter(e => ids.has(e.from) && ids.has(e.to))
          .map((edge): Link3D => {
            const kept = was.get(edge.id)
            return kept && kept.edge === edge ? kept : { source: edge.from, target: edge.to, edge, o: LINK }
          })
        // The focus node's neighbours may be others now.
        orderKey = ''
        /*
         * The same node objects keep their places and their shapes. Given new data, the simulation is heated again and
         * warmed up before it is drawn: with no ticks either way it stops at once, the relationships put between the
         * nodes where they are, and the view and focus as they were.
         */
        g.warmupTicks(0).cooldownTicks(0).graphData({ nodes, links })
      }
      // The graph that was there before three arrived.
      draw.current()
      element.dataset.ready = 'true'
      // For the Reset view button, and for a test to reach the view.
      Object.assign(element, { _fit: fit, _graph: g })

      teardown = () => {
        cancelAnimationFrame(frame)
        clearTimeout(idle)
        resized.disconnect()
        element.removeEventListener('wheel', wheel)
        element.removeEventListener('keydown', key)
        g._destructor()
        element.replaceChildren()
        repaint.current = () => {}
        draw.current = () => {}
        relink.current = () => {}
      }
    })
    return () => {
      gone = true
      teardown()
      view.current = null
    }
  }, [])

  // A new graph is drawn and opened afresh; the same nodes with relationships come or gone keep the view and its focus.
  useEffect(() => {
    const redraw = redrawOf(drawnNow.current, { graph, fragments })
    drawnNow.current = { graph, fragments }
    if (redraw.kind === 'edges') return relink.current()
    setFocus(null)
    draw.current()
  }, [graph, fragments])
  // Icons arrive after the graph is drawn, and change when one is chosen.
  useEffect(() => repaint.current(), [images])

  const shown = shownOf(entries, hidden)
  const [legendOpen, setLegendOpen] = useState(true)
  return (
    <div className="studio-graph">
      <div
        ref={container}
        className="studio-graph-canvas studio-graph3d"
        tabIndex={0}
        role="img"
        aria-label={`Graph of ${graph.nodes.length} nodes and ${graph.edges.length} relationships, in 3D. Arrows turn it, shift and the arrows pan, plus and minus zoom, 0 fits it, Escape shows every node.`}
      />
      <div className="studio-legend studio-legend3d">
        <button type="button" className="studio-legend-head desk-text-small desk-text-muted" aria-expanded={legendOpen} onClick={() => setLegendOpen(!legendOpen)}>
          <span className="studio-legend-chevron" aria-hidden="true">{legendOpen ? '▾' : '▸'}</span>
          {entries.length} {entries.length === 1 ? 'label' : 'labels'}
        </button>
        {legendOpen && (
          <>
            {entries.length > 1 && (
              <Checkbox
                label="All"
                checked={shown === 'all'}
                indeterminate={shown === 'some'}
                onChange={on => setHidden(on || shown === 'some' ? new Set() : new Set(entries.map(e => e.fragment)))}
              />
            )}
            <ul className="studio-legend-list" aria-label="Fragments shown">
              {entries.map(({ fragment, count }) => {
                const label = iconLabelOf(graph.nodes, fragment)
                return (
                  <li key={fragment}>
                    <Checkbox
                      checked={!hidden.has(fragment)}
                      onChange={on => setHidden(h => toggled(h, fragment, on))}
                      label={
                        <span className="studio-legend3d-entry">
                          <Swatch colour={colourOf(fragments, fragment)} icon={(label !== undefined && icons[label]?.icon) || null} />
                          {fragment}
                          <span className="desk-text-muted">{count}</span>
                        </span>
                      }
                    />
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
      <span className="studio-graph3d-reset">
        <Button size="small" onClick={() => (container.current as unknown as { _fit?: () => void } | null)?._fit?.()}>Reset view</Button>
      </span>
      <p className="studio-graph3d-hint desk-text-small desk-text-muted">
        {focus ? 'Esc or click empty space to see every node · double-click a node to fly to it' : 'Click a node to focus it · drag to turn · ⇧-drag or two fingers to pan · scroll or pinch to zoom'}
      </p>
    </div>
  )
}
