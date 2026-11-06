import { addCommandHandler, createDesk, DeskCommands } from '@liberation-data/desk'
import type { WindowLimits } from '@liberation-data/desk'
import {
  Button, DeskShell, Desktop, Dock, MenuBar, Split, dockItem, dockSeparator, menuAction, menuCommand, menuHeader, menuSeparator, windowMenuItems,
} from '@liberation-data/desk/react'
import type { Drag } from '@liberation-data/desk/react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { loadCatalog } from './api'
import type { Catalog } from './api'
import { Canvas } from './Canvas'
import { Catalogue } from './Catalogue'
import { Connections } from './Connections'
import { Cypher } from './Cypher'
import { Bench } from './Bench'
import { Files, QueryIcon } from './Files'
import { Settings } from './Settings'
import { appearance, applyAppearance } from './appearance'
import { listQueries, QUERY_DRAG } from './savedQueries'
import type { QueryDrag } from './savedQueries'
import { connectionChoices } from './connectionMenu'
import { ALLOWS_WRITES, listConnections } from './database'
import type { StudioConnection } from './database'
import { inCatalog, nextSubject } from './model'
import { nativeMenus, useNativeMenus } from './nativeMenu'
import { useOnline } from './online'
import type { Subject } from './model'

const desk = createDesk()

/** What the menus ask of a window, which the window that can do it answers. */
export const StudioCommands = {
  save: 'studio.query.save',
  saveAs: 'studio.query.saveAs',
  open: 'studio.open',
  settings: 'studio.settings',
  /** The Connections window: where a window with no database to use sends the person. */
  connections: 'studio.connections',
} as const

// What the whole studio answers, wherever focus is: commands, so their shortcuts work as the menu bar shows them.
if (typeof document !== 'undefined') {
  addCommandHandler(document, StudioCommands.open, () => desk.open('files'))
  addCommandHandler(document, StudioCommands.settings, () => desk.open('settings'))
  addCommandHandler(document, StudioCommands.connections, () => desk.open('connections'))
}
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
  // Its sections, and Icons' table beside them.
  settings: { minWidth: 760, minHeight: 400 },
  files: { minWidth: 640, minHeight: 360 },
  bench: { minWidth: 720, minHeight: 360 },
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
  if (id === 'files') {
    return 'Queries saved from Cypher, each a .cypher file in the queries folder of the studio’s home, in folders of your own, so an editor opens them too; and the model files the studio reads, one for each module. Double-click a query to open it in Cypher.'
  }
  if (id === 'bench') {
    return 'Graph Bench’s results: the ones it publishes, and the runs of a checkout you link. Compare one set with another to see what a Drivine release made faster or slower, on the same machine.'
  }
  if (id === 'connections') {
    return 'The databases the studio reads, kept in connections.json in its home, passwords too, readable by you alone. One from the environment is set where the studio was started.'
  }
  if (id === 'settings') {
    return (
      <>
        <p>Appearance: light, dark, or as the system is, kept in this browser or the desktop app.</p>
        <p>Icons: each label&apos;s icon and why it has it, and your own common words and icons taken only by name, kept in icons.json in its home, for every connection alike.</p>
      </>
    )
  }
  return null
}

const TITLES: Record<string, string> = { files: 'Files', explore: 'Explore', cypher: 'Cypher', bench: 'Bench', connections: 'Connections', settings: 'Settings' }
const title = (id: string) => TITLES[id] ?? id

/** A saved query as the Cypher window knows the one it holds. */
export interface SavedAs {
  id: string
  name: string
  folder: string
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
  /** The folder the Files window is in, which a new query is saved to unless another is chosen. */
  browsing: string
  browse: (folder: string) => void
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
  if (id === 'settings') return <Settings />
  if (id === 'files') return <Files />
  if (id === 'bench') return <Bench />
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

const KEPT = 'drivine-studio.dock.queries'
const rememberedKept = (): QueryDrag[] => {
  try {
    const kept = JSON.parse(window.localStorage.getItem(KEPT) ?? '[]') as unknown
    return Array.isArray(kept) ? kept.filter((q): q is QueryDrag => typeof q?.id === 'string' && typeof q?.statement === 'string') : []
  } catch {
    return []
  }
}

const DOCK = [
  // First, as the Finder is in a Mac's dock: what has been kept, to open again.
  dockItem({ id: 'files', label: 'Files', description: 'Saved queries, in folders, and the model files the studio reads', icon: icon('M4 5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM8 11l-2 2 2 2M16 11l2 2-2 2M13 10l-2 6') }),
  dockItem({ id: 'explore', label: 'Explore', description: 'Views and fragments, loaded and seen as a graph', icon: icon('M6 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM7.7 7l8.5 2.4M16.6 11.5l-7.2 5.3M6.4 8l1.2 8') }),
  dockItem({ id: 'cypher', label: 'Cypher', description: 'Run Cypher, see a graph or rows', icon: icon('M8 6l-5 6 5 6M16 6l5 6-5 6M14 4l-4 16') }),
  dockItem({ id: 'bench', label: 'Bench', description: 'Graph Bench results, read and compared', icon: icon('M4 20V10M10 20V4M16 20v-7M22 20H2') }),
  dockItem({ id: 'connections', label: 'Connections', description: 'The databases to read', icon: icon('M4 6c0-1.1 3.6-2 8-2s8 .9 8 2-3.6 2-8 2-8-.9-8-2zM4 6v12c0 1.1 3.6 2 8 2s8-.9 8-2V6M4 12c0 1.1 3.6 2 8 2s8-.9 8-2') }),
  // Last, as a Mac's System Settings sits at the end of its dock.
  dockItem({ id: 'settings', label: 'Settings', description: 'How the studio looks, and the labels\' icons', icon: icon('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z') }),
]

export function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [subject, setSubject] = useState<Subject | null>(null)
  const [connections, setConnections] = useState<StudioConnection[] | null>(null)
  const [connectionProblem, setConnectionProblem] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  // The head's script set the page's appearance before React started; the desktop app's menus are told it here.
  useEffect(() => applyAppearance(appearance()), [])
  const [pendingCypher, setPendingCypher] = useState<Studio['pendingCypher']>(null)
  const openInCypher = useCallback((statement: string, parameters: Record<string, unknown> | string, saved?: SavedAs) => {
    setPendingCypher({ statement, parameters, ...(saved ? { saved } : {}) })
    desk.open('cypher')
  }, [])
  const [queriesChanged, setQueriesChanged] = useState(0)
  const savedQuery = useCallback(() => setQueriesChanged(n => n + 1), [])
  const [browsing, browse] = useState('')
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
      pendingCypher, openInCypher, takeCypher, queriesChanged, savedQuery, browsing, browse,
    }),
    [
      catalog, problem, reload, subject, show, connections, connectionProblem, reloadConnections, connection, chooseConnection,
      pendingCypher, openInCypher, takeCypher, queriesChanged, savedQuery, browsing,
    ],
  )

  const menus = useMemo(() => [
    // The app's own menu: what is about the studio and how it is set up, as a Mac app keeps its Settings there.
    { id: 'studio', label: 'Drivine Studio', emphasis: true, items: [
        menuCommand('Settings…', StudioCommands.settings, { shortcut: 'mod+,' }),
        menuCommand('Connections…', StudioCommands.connections),
        menuAction('Reload Connections', reloadConnections),
      ] },
    // The documents: queries to make, open and keep, and the model files the studio reads.
    {
      id: 'file',
      label: 'File',
      items: [
        menuAction('New Query', () => openInCypher('', '')),
        menuCommand('Open…', StudioCommands.open, { shortcut: 'mod+o' }),
        menuSeparator(),
        // The Cypher window answers these, when it is the one in front: dimmed otherwise, as a Mac's are.
        menuCommand('Save', StudioCommands.save, { shortcut: 'mod+s' }),
        menuCommand('Save As…', StudioCommands.saveAs, { shortcut: 'mod+shift+s' }),
        menuSeparator(),
        menuAction('Reload Model Files', reload),
        menuSeparator(),
        menuCommand('Close Window', DeskCommands.closeWindow),
      ],
    },
    {
      id: 'window',
      label: 'Window',
      // The studio's windows to open, as a Mac app lists its own tools here, then the ones open now.
      items: () => [
        ...['files', 'explore', 'cypher', 'bench', 'connections', 'settings'].map(id => menuAction(title(id), () => desk.open(id))),
        menuSeparator(),
        menuCommand('Arrange', DeskCommands.arrange, { shortcut: 'mod+alt+a' }),
        menuSeparator(),
        ...windowMenuItems(desk.getState(), id => desk.focus(id), title),
      ],
    },
  ], [reload, reloadConnections, openInCypher])

  // Whether each is up, tried every few seconds: a menu gives no word of opening or closing to try it then.
  const up = useOnline((connections ?? []).map(c => c.id))
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
      menuHeader('Connection'),
      // Those that are up first; one that isn't running greyed out, saying so, as Bench's pickers do.
      ...connectionChoices(connections ?? [], up, connection?.id).map(({ connection: c, detail, disabled, checked }) =>
        menuAction(c.name, () => chooseConnection(c.id), { checked, detail, disabled }),
      ),
      ...(connections?.length ? [menuSeparator()] : []),
      menuAction('Connections…', () => desk.open('connections')),
    ],
  }], [connections, connection, chooseConnection, up])
  useNativeMenus(native, menus, desk, status)

  /*
   * Queries kept in the dock: dragged there from Files, as a file is dragged to a Mac's Dock, after the studio's own
   * windows. A click opens it in Cypher, as it is saved now; kept in this browser, by the query's id.
   */
  const [kept, setKept] = useState<QueryDrag[]>(rememberedKept)
  useEffect(() => {
    try {
      window.localStorage.setItem(KEPT, JSON.stringify(kept))
    } catch {
      // Kept for this visit only, then.
    }
  }, [kept])
  const openKept = useCallback((q: QueryDrag) => {
    listQueries().then(
      shelf => {
        const now = shelf.queries.find(found => found.id === q.id)
        const at = now ?? q
        openInCypher(at.statement, at.parameters, { id: at.id, name: at.name, folder: at.folder })
      },
      () => openInCypher(q.statement, q.parameters, { id: q.id, name: q.name, folder: q.folder }),
    )
  }, [openInCypher])
  const dock = useMemo(() => [
    ...DOCK,
    ...(kept.length ? [dockSeparator('kept')] : []),
    ...kept.map(q => dockItem({
      id: `query:${q.id}`,
      label: q.name,
      description: q.folder ? `${q.folder} · saved query` : 'Saved query',
      icon: <QueryIcon />,
      onSelect: () => openKept(q),
      movable: true,
      contextMenu: () => [
        menuAction('Open in Cypher', () => openKept(q)),
        menuSeparator(),
        menuAction('Remove from Dock', () => setKept(all => all.filter(k => k.id !== q.id))),
      ],
    })),
  ], [kept, openKept])
  const pins = useMemo(() => ({
    accepts: QUERY_DRAG,
    onPin: (drag: Drag, before: string | null) => {
      const q = drag.payload as QueryDrag
      setKept(all => {
        const rest = all.filter(k => k.id !== q.id)
        const at = before ? rest.findIndex(k => `query:${k.id}` === before) : -1
        return at < 0 ? [...rest, q] : [...rest.slice(0, at), q, ...rest.slice(at)]
      })
    },
    onMove: (id: string, before: string | null) => {
      setKept(all => {
        const moving = all.find(k => `query:${k.id}` === id)
        if (!moving) return all
        const rest = all.filter(k => k !== moving)
        const at = before ? rest.findIndex(k => `query:${k.id}` === before) : -1
        return at < 0 ? [...rest, moving] : [...rest.slice(0, at), moving, ...rest.slice(at)]
      })
    },
  }), [])

  return (
    <DeskShell desk={desk}>
      <StudioContext.Provider value={studio}>
        <div className="studio">
          {!native && <MenuBar menus={menus} status={status} leading={<span className="studio-mark" role="img" aria-label="Drivine" />} />}
          {/* In the desktop app on a Mac, where the window has no title bar: room for its traffic lights, to drag it by. */}
          {native && <div className="studio-window-bar" aria-hidden="true" />}
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
            <Dock entries={dock} label="Studio dock" pins={pins} />
          </main>
        </div>
      </StudioContext.Provider>
    </DeskShell>
  )
}
