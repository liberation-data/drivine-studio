import { createDesk, DeskCommands } from '@liberation-data/desk'
import {
  DeskShell, Desktop, Dock, MenuBar, dockItem, menuAction, menuCommand, menuSeparator, windowMenuItems,
} from '@liberation-data/desk/react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { loadCatalog } from './api'
import type { Catalog } from './api'
import { Canvas } from './Canvas'
import { Catalogue } from './Catalogue'
import { Connections } from './Connections'
import { Cypher } from './Cypher'
import { listConnections } from './database'
import type { StudioConnection } from './database'
import { nextSubject } from './model'
import type { Subject } from './model'

const desk = createDesk()

const TITLES: Record<string, string> = { catalogue: 'Catalogue', canvas: 'Canvas', cypher: 'Cypher', connections: 'Connections' }
const title = (id: string) => TITLES[id] ?? id

interface Studio {
  catalog: Catalog | null
  /** Why the catalogue could not be read, when it could not. */
  problem: string | null
  reload: () => void
  subject: Subject | null
  /** Puts a view or fragment on the canvas, unless it is there already, and brings the canvas forward. */
  show: (subject: Subject | null) => void
  connections: StudioConnection[] | null
  /** Why the connections could not be read, when they could not. */
  connectionProblem: string | null
  reloadConnections: () => void
  /** The connection the Cypher window runs on. */
  connection: StudioConnection | null
  chooseConnection: (id: string) => void
  /** A statement the Cypher window is to take up, with its parameters, once it is open. */
  pendingCypher: { statement: string; parameters: Record<string, unknown> } | null
  /** Opens the Cypher window on a statement. */
  openInCypher: (statement: string, parameters: Record<string, unknown>) => void
  /** The Cypher window has taken up the statement. */
  takeCypher: () => void
}

const StudioContext = createContext<Studio | null>(null)

export function useStudio(): Studio {
  const studio = useContext(StudioContext)
  if (!studio) throw new Error('useStudio outside the studio')
  return studio
}

// Module scope, so the desk's memoisation of window content holds.
function renderWindow(id: string): ReactNode {
  if (id === 'catalogue') return <Catalogue />
  if (id === 'canvas') return <Canvas />
  if (id === 'cypher') return <Cypher />
  if (id === 'connections') return <Connections />
  return null
}

const icon = (path: string) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={path} />
  </svg>
)
// The connection in use, kept in this browser only: a convenience, and lost without harm.
const CONNECTION = 'drivine-studio.connection'
const rememberedConnection = (): string | null => {
  try {
    return window.localStorage.getItem(CONNECTION)
  } catch {
    return null
  }
}

const DOCK = [
  dockItem({ id: 'catalogue', label: 'Catalogue', description: 'Views and fragments', icon: icon('M4 6h16M4 12h16M4 18h10') }),
  dockItem({ id: 'cypher', label: 'Cypher', description: 'Run Cypher, see a graph or rows', icon: icon('M8 6l-5 6 5 6M16 6l5 6-5 6M14 4l-4 16') }),
  dockItem({ id: 'connections', label: 'Connections', description: 'The databases to read', icon: icon('M4 6c0-1.1 3.6-2 8-2s8 .9 8 2-3.6 2-8 2-8-.9-8-2zM4 6v12c0 1.1 3.6 2 8 2s8-.9 8-2V6M4 12c0 1.1 3.6 2 8 2s8-.9 8-2') }),
  dockItem({ id: 'canvas', label: 'Canvas', description: 'Load and see the graph', icon: icon('M6 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM7.7 7l8.5 2.4M16.6 11.5l-7.2 5.3M6.4 8l1.2 8') }),
]

export function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [subject, setSubject] = useState<Subject | null>(null)
  const [connections, setConnections] = useState<StudioConnection[] | null>(null)
  const [connectionProblem, setConnectionProblem] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [pendingCypher, setPendingCypher] = useState<Studio['pendingCypher']>(null)
  const openInCypher = useCallback((statement: string, parameters: Record<string, unknown>) => {
    setPendingCypher({ statement, parameters })
    desk.open('cypher')
  }, [])
  const takeCypher = useCallback(() => setPendingCypher(null), [])

  const reload = useCallback(() => {
    setProblem(null)
    loadCatalog().then(setCatalog, (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
  }, [])
  useEffect(reload, [reload])

  const reloadConnections = useCallback(() => {
    setConnectionProblem(null)
    listConnections().then(setConnections, (e: unknown) => setConnectionProblem(e instanceof Error ? e.message : String(e)))
  }, [])
  useEffect(reloadConnections, [reloadConnections])
  useEffect(() => setChosen(rememberedConnection()), [])

  const chooseConnection = useCallback((id: string) => {
    setChosen(id)
    try {
      window.localStorage.setItem(CONNECTION, id)
    } catch {
      // Not remembered; still in use.
    }
  }, [])
  // The one chosen while it is still there; otherwise the first, so a single connection needs no choosing.
  const connection = useMemo(
    () => connections?.find(c => c.id === chosen) ?? connections?.[0] ?? null,
    [connections, chosen],
  )

  const show = useCallback((next: Subject | null) => {
    setSubject(current => nextSubject(current, next))
    if (next) desk.open('canvas')
  }, [])

  // The catalogue beside the canvas; on a narrow screen, the desk shows one window at a time anyway.
  useEffect(() => {
    if (desk.getState().windows.length > 0) return
    const stage = document.querySelector('[data-desk-stage]')?.getBoundingClientRect()
    if (!stage || stage.width < 760) {
      desk.open('catalogue')
      desk.open('canvas')
      return
    }
    const gap = 12
    const side = 300
    const height = stage.height - gap * 2
    desk.open('catalogue', { frame: { x: gap, y: gap, width: side, height } })
    desk.open('canvas', { frame: { x: side + gap * 2, y: gap, width: stage.width - side - gap * 3, height } })
  }, [])

  const studio = useMemo(
    () => ({
      catalog, problem, reload, subject, show, connections, connectionProblem, reloadConnections, connection, chooseConnection,
      pendingCypher, openInCypher, takeCypher,
    }),
    [
      catalog, problem, reload, subject, show, connections, connectionProblem, reloadConnections, connection, chooseConnection,
      pendingCypher, openInCypher, takeCypher,
    ],
  )

  const menus = useMemo(() => [
    { id: 'studio', label: 'Drivine Studio', emphasis: true, items: [
        menuAction('Reload Catalogue', reload),
        menuAction('Reload Connections', reloadConnections),
        menuSeparator(),
        menuAction('Cypher', () => desk.open('cypher')),
        menuAction('Connections', () => desk.open('connections')),
      ] },
    {
      id: 'window',
      label: 'Window',
      items: () => [
        menuCommand('Arrange', DeskCommands.arrange, { shortcut: 'mod+alt+a' }),
        menuSeparator(),
        ...windowMenuItems(desk.getState(), id => desk.focus(id), title),
      ],
    },
  ], [reload, reloadConnections])

  return (
    <DeskShell desk={desk}>
      <StudioContext.Provider value={studio}>
        <div className="studio">
          <MenuBar menus={menus} />
          <main className="studio-screen">
            <Desktop
              title={title}
              renderWindow={renderWindow}
              note={id => (id === 'canvas' ? 'read-only' : null)}
              empty={<div className="studio-hint"><h2>Nothing open</h2><p>Open the Catalogue from the dock.</p></div>}
            />
            <Dock entries={DOCK} label="Studio dock" />
          </main>
        </div>
      </StudioContext.Provider>
    </DeskShell>
  )
}
