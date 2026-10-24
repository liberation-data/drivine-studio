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
import type { Subject } from './model'

const desk = createDesk()

const TITLES: Record<string, string> = { catalogue: 'Catalogue', canvas: 'Canvas' }
const title = (id: string) => TITLES[id] ?? id

interface Studio {
  catalog: Catalog | null
  /** Why the catalogue could not be read, when it could not. */
  problem: string | null
  reload: () => void
  subject: Subject | null
  /** Puts a view or fragment on the canvas and brings the canvas forward. */
  show: (subject: Subject | null) => void
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
  return null
}

const icon = (path: string) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={path} />
  </svg>
)
const DOCK = [
  dockItem({ id: 'catalogue', label: 'Catalogue', description: 'Views and fragments', icon: icon('M4 6h16M4 12h16M4 18h10') }),
  dockItem({ id: 'canvas', label: 'Canvas', description: 'Load and see the graph', icon: icon('M6 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM7.7 7l8.5 2.4M16.6 11.5l-7.2 5.3M6.4 8l1.2 8') }),
]

export function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [subject, setSubject] = useState<Subject | null>(null)

  const reload = useCallback(() => {
    setProblem(null)
    loadCatalog().then(setCatalog, (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
  }, [])
  useEffect(reload, [reload])

  const show = useCallback((next: Subject | null) => {
    setSubject(next)
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

  const studio = useMemo(() => ({ catalog, problem, reload, subject, show }), [catalog, problem, reload, subject, show])

  const menus = useMemo(() => [
    { id: 'studio', label: 'Drivine Studio', emphasis: true, items: [menuAction('Reload Catalogue', reload)] },
    {
      id: 'window',
      label: 'Window',
      items: () => [
        menuCommand('Arrange', DeskCommands.arrange, { shortcut: 'mod+alt+a' }),
        menuSeparator(),
        ...windowMenuItems(desk.getState(), id => desk.focus(id), title),
      ],
    },
  ], [reload])

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
