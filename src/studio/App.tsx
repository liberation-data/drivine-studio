import { createDesk, DeskCommands } from '@liberation-data/desk'
import type { WindowLimits } from '@liberation-data/desk'
import {
  Button, DeskShell, Desktop, Dock, MenuBar, Split, dockItem, menuAction, menuCommand, menuHeader, menuSeparator, windowMenuItems,
} from '@liberation-data/desk/react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { loadCatalog } from './api'
import type { Catalog } from './api'
import { Canvas } from './Canvas'
import { Catalogue } from './Catalogue'
import { Connections } from './Connections'
import { Cypher } from './Cypher'
import { Queries } from './Queries'
import { ALLOWS_WRITES, DATABASE_NAMES, listConnections } from './database'
import type { StudioConnection } from './database'
import { inCatalog, nextSubject } from './model'
import { nativeMenus, useNativeMenus } from './nativeMenu'
import type { Subject } from './model'

const desk = createDesk()
// In the desktop app on a Mac, the menus are the Mac's own, at the top of the screen.
const native = nativeMenus()

/*
 * How small each window may be made: room for its side panel at its narrowest and for what it shows beside or below
 * it, so a control is never squeezed past reading.
 */
const LIMITS: Record<string, WindowLimits> = {
  explore: { minWidth: 640, minHeight: 360 },
  cypher: { minWidth: 520, minHeight: 360 },
  connections: { minWidth: 560, minHeight: 360 },
  queries: { minWidth: 520, minHeight: 320 },
}

/**
 * What each window is looking at, in its title bar: the connection it runs on, and whether that only reads (Explore
 * always) or may write (Cypher, on a connection that allows it).
 */
function noteOf(id: string, connection: StudioConnection | null): ReactNode {
  if (id !== 'explore' && id !== 'cypher') return null
  const name = connection?.name ?? 'no connection'
  if (id === 'explore') return `${name} · read-only`
  return connection?.allowWrites ? <>{name} · <span className="studio-warn">writes allowed</span></> : name
}

/** What each window is, behind the (i) in its title bar. */
function infoOf(id: string, connection: StudioConnection | null): ReactNode {
  if (id === 'explore') {
    return 'The views and fragments your code declares, read from its model files. Drag one onto the canvas, or choose it, to load it as Drivine would. Loading only ever reads.'
  }
  if (id === 'cypher') {
    return (
      <>
        <p>Cypher run on the connection chosen: as it is on Neo4j, Memgraph and FalkorDB, and compiled to SQL by Drivine on Postgres and Oracle.</p>
        <p>
          {connection?.allowWrites
            ? `${ALLOWS_WRITES} There is no undo.`
            : 'Each statement runs where it cannot write. To change the database, turn on Allow writes for the connection in Connections.'}
        </p>
      </>
    )
  }
  if (id === 'queries') {
    return 'The statements saved from Cypher, each a .cypher file in the queries folder of the studio’s home, so an editor opens them too. Double-click one to open it in Cypher.'
  }
  if (id === 'connections') {
    return 'The databases the studio reads, kept in connections.json in its home, passwords too, readable by you alone. One from the environment is set where the studio was started.'
  }
  return null
}

const TITLES: Record<string, string> = { explore: 'Explore', cypher: 'Cypher', queries: 'Queries', connections: 'Connections' }
const title = (id: string) => TITLES[id] ?? id

/** A saved query as the Cypher window knows the one it holds. */
export interface SavedAs {
  id: string
  name: string
}

export interface PendingCypher {
  statement: string
  parameters: Record<string, unknown> | string
  saved?: SavedAs
}

interface Studio {
  catalog: Catalog | null
  /** Why the catalogue could not be read, when it could not. */
  problem: string | null
  reload: () => void
  subject: Subject | null
  /** Puts a view or fragment on the canvas, unless it is there already, and brings Explore forward. */
  show: (subject: Subject | null) => void
  connections: StudioConnection[] | null
  /** Why the connections could not be read, when they could not. */
  connectionProblem: string | null
  reloadConnections: () => void
  /** The connection the Cypher window runs on. */
  connection: StudioConnection | null
  chooseConnection: (id: string) => void
  /**
   * A statement the Cypher window is to take up, with its parameters (as given, or as typed), once it is open: and the
   * saved query it is, when it is one, so saving it again saves over it.
   */
  pendingCypher: PendingCypher | null
  /** Opens the Cypher window on a statement. */
  openInCypher: (statement: string, parameters: Record<string, unknown> | string, saved?: SavedAs) => void
  /** Counts the saves, so a list of saved queries reads them again after one. */
  queriesChanged: number
  savedQuery: () => void
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
  // The catalogue and the canvas it fills are one app, so one window: only the edge between them moves.
  if (id === 'explore') {
    return (
      <Split side={<Catalogue />} size={300} remember="drivine-studio.explore" label="Resize the catalogue">
        <Canvas />
      </Split>
    )
  }
  if (id === 'cypher') return <Cypher />
  if (id === 'connections') return <Connections />
  if (id === 'queries') return <Queries />
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
  dockItem({ id: 'explore', label: 'Explore', description: 'Views and fragments, loaded and seen as a graph', icon: icon('M6 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM7.7 7l8.5 2.4M16.6 11.5l-7.2 5.3M6.4 8l1.2 8') }),
  dockItem({ id: 'cypher', label: 'Cypher', description: 'Run Cypher, see a graph or rows', icon: icon('M8 6l-5 6 5 6M16 6l5 6-5 6M14 4l-4 16') }),
  dockItem({ id: 'queries', label: 'Queries', description: 'The statements saved from Cypher, to open again', icon: icon('M4 5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM8 11l-2 2 2 2M16 11l2 2-2 2M13 10l-2 6') }),
  dockItem({ id: 'connections', label: 'Connections', description: 'The databases to read', icon: icon('M4 6c0-1.1 3.6-2 8-2s8 .9 8 2-3.6 2-8 2-8-.9-8-2zM4 6v12c0 1.1 3.6 2 8 2s8-.9 8-2V6M4 12c0 1.1 3.6 2 8 2s8-.9 8-2') }),
]

export function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [subject, setSubject] = useState<Subject | null>(null)
  const [connections, setConnections] = useState<StudioConnection[] | null>(null)
  const [connectionProblem, setConnectionProblem] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [pendingCypher, setPendingCypher] = useState<Studio['pendingCypher']>(null)
  const openInCypher = useCallback((statement: string, parameters: Record<string, unknown> | string, saved?: SavedAs) => {
    setPendingCypher({ statement, parameters, ...(saved ? { saved } : {}) })
    desk.open('cypher')
  }, [])
  const [queriesChanged, setQueriesChanged] = useState(0)
  const savedQuery = useCallback(() => setQueriesChanged(n => n + 1), [])
  const takeCypher = useCallback(() => setPendingCypher(null), [])

  const reload = useCallback(() => {
    setProblem(null)
    loadCatalog().then(
      read => {
        setCatalog(read)
        // What is on the canvas is loaded as the files now declare it, and leaves once none does.
        setSubject(current => inCatalog(current, read))
      },
      (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)),
    )
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
    if (next) desk.open('explore')
  }, [])

  const studio = useMemo(
    () => ({
      catalog, problem, reload, subject, show, connections, connectionProblem, reloadConnections, connection, chooseConnection,
      pendingCypher, openInCypher, takeCypher, queriesChanged, savedQuery,
    }),
    [
      catalog, problem, reload, subject, show, connections, connectionProblem, reloadConnections, connection, chooseConnection,
      pendingCypher, openInCypher, takeCypher, queriesChanged, savedQuery,
    ],
  )

  const menus = useMemo(() => [
    { id: 'studio', label: 'Drivine Studio', emphasis: true, items: [
        menuAction('Reload Catalogue', reload),
        menuAction('Reload Connections', reloadConnections),
        menuSeparator(),
        menuAction('Explore', () => desk.open('explore')),
        menuAction('Cypher', () => desk.open('cypher')),
        menuAction('Queries', () => desk.open('queries')),
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

  /*
   * The connection in use, at the trailing end of the menu bar: one for the whole studio, so chosen where the whole
   * studio is, not in a window. Each window's title bar names it too.
   */
  const status = useMemo(() => [{
    id: 'connection',
    label: connection?.name ?? 'No Connection',
    title: (
      <span className="studio-connection-menu">
        <span className="studio-connection-icon" aria-hidden="true" />
        {connection?.name ?? 'No Connection'}
      </span>
    ),
    items: () => [
      menuHeader('Use'),
      ...(connections ?? []).map(c =>
        menuAction(c.name, () => chooseConnection(c.id), { checked: c.id === connection?.id, detail: DATABASE_NAMES[c.type] }),
      ),
      ...(connections?.length ? [menuSeparator()] : []),
      menuAction('Connections…', () => desk.open('connections')),
    ],
  }], [connections, connection, chooseConnection])
  const nativeAll = useMemo(() => [...menus, ...status], [menus, status])
  useNativeMenus(native, nativeAll, desk)

  return (
    <DeskShell desk={desk}>
      <StudioContext.Provider value={studio}>
        <div className="studio">
          {!native && <MenuBar menus={menus} status={status} leading={<span className="studio-mark" role="img" aria-label="Drivine" />} />}
          <main className="studio-screen">
            <Desktop
              title={title}
              renderWindow={renderWindow}
              // What each window is looking at: Explore only reads; Cypher on a connection that allows writes changes it.
              note={id => noteOf(id, connection)}
              info={id => infoOf(id, connection)}
              limits={id => LIMITS[id] ?? null}
              // The studio opens on nothing: one person came to explore the model, another to run a statement.
              empty={
                <div className="studio-hint">
                  <h2>Drivine Studio</h2>
                  <p>Explore the views and fragments your code declares, or write Cypher of your own.</p>
                  <div className="studio-hint-actions">
                    <Button onClick={() => desk.open('explore')}>Explore</Button>
                    <Button onClick={() => desk.open('cypher')}>Cypher</Button>
                  </div>
                </div>
              }
            />
            <Dock entries={DOCK} label="Studio dock" />
          </main>
        </div>
      </StudioContext.Provider>
    </DeskShell>
  )
}
