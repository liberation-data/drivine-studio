import {
  Alert, Button, CodeBlock, IconView, Loading, menuAction, menuSeparator, SegmentedControl, Sheet, Sidebar, Split, Table, TextField,
  useContextMenu,
} from '@liberation-data/desk/react'
import type { IconViewItem, MenuItem } from '@liberation-data/desk/react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { addModelPath, listModelFiles, listModelPaths, readModelFile, removeModelPath } from './api'
import type { ModelFileEntry, ModelPath } from './api'
import { folderPicker } from './nativeMenu'
import { useStudio } from './App'
import { addFolder, firstLine, listQueries, removeFolder, removeQuery } from './savedQueries'
import type { QueryFolder, QueryShelf, SavedQuery } from './savedQueries'

/*
 * The studio's files, as a Finder shows them: places down the side, what is in the one chosen as icons or a list, and
 * what is chosen in a panel beside. Queries are .cypher files in folders of their own; the model files are the ones the
 * studio reads, one for each module, shown and never changed.
 */

type Place = 'queries' | 'models'
type Layout = 'icons' | 'list'

type Entry =
  | ({ kind: 'folder'; folder: QueryFolder } & IconViewItem)
  | ({ kind: 'query'; query: SavedQuery } & IconViewItem)
  | ({ kind: 'model'; model: ModelFileEntry } & IconViewItem)
  | ({ kind: 'linked'; linked: ModelPath; files: number } & IconViewItem)

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const LAYOUT = 'drivine-studio.files.layout'

const remembered = (): Layout => {
  try {
    return window.localStorage.getItem(LAYOUT) === 'list' ? 'list' : 'icons'
  } catch {
    return 'icons'
  }
}

export function Files() {
  const { openInCypher, queriesChanged, savedQuery, browsing, browse, catalog, reload } = useStudio()
  // The project folders linked, whose model files the studio reads; and the one open, in Model Files.
  const [paths, setPaths] = useState<ModelPath[] | null>(null)
  const [project, setProject] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)
  const pick = useMemo(folderPicker, [])
  const [place, setPlace] = useState<Place>('queries')
  const [layout, setLayout] = useState<Layout>(remembered)
  const [shelf, setShelf] = useState<QueryShelf | null>(null)
  const [models, setModels] = useState<ModelFileEntry[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [find, setFind] = useState('')
  const [naming, setNaming] = useState(false)
  const [removing, setRemoving] = useState<Entry | null>(null)

  useEffect(() => {
    listQueries().then(setShelf, (e: unknown) => setProblem(message(e)))
  }, [queriesChanged])
  useEffect(() => {
    if (place !== 'models') return
    listModelFiles().then(setModels, (e: unknown) => setProblem(message(e)))
    listModelPaths().then(setPaths, (e: unknown) => setProblem(message(e)))
  }, [place, catalog])

  /*
   * Links a project: the studio reads the model files under it where they are, so a rebuild is read again on
   * Reload Model Files, rather than a copy that goes stale. In the desktop app the system's folder picker chooses it;
   * a browser can't say where a folder it was given lives, so there the path is pasted.
   */
  const linkFolder = () => {
    if (!pick) return setLinking(true)
    pick()
      .then(path => (path ? link(path) : undefined))
      .catch((e: unknown) => setProblem(message(e)))
  }
  const link = (path: string): Promise<void> =>
    addModelPath(path).then(now => {
      setPaths(now)
      setProblem(null)
      setProject(null)
      reload()
    })
  const unlink = (path: string) =>
    removeModelPath(path).then(now => {
      setPaths(now)
      setSelected(null)
      setProject(current => (current === path ? null : current))
      reload()
    }, (e: unknown) => setProblem(message(e)))
  useEffect(() => {
    try {
      window.localStorage.setItem(LAYOUT, layout)
    } catch {
      // The layout is a convenience; without storage it is icons each time.
    }
  }, [layout])

  // A folder that is gone (removed, or renamed in an editor) leaves for the top.
  const folder = shelf && browsing && !shelf.folders.some(f => f.path === browsing) ? '' : browsing
  const go = (to: string) => {
    browse(to)
    setSelected(null)
    setFind('')
  }

  const entries = useMemo<Entry[]>(() => {
    const words = find.trim().toLowerCase()
    if (place === 'models') {
      const fileEntry = (m: ModelFileEntry): Entry => ({
        kind: 'model', model: m, id: `model:${m.path}`, label: m.module, subtitle: m.problem ? 'cannot be read' : `${m.views} views · ${m.fragments} fragments`, icon: <ModelIcon />,
      })
      // Finding looks in every linked project; otherwise the projects, or what is in the one open.
      if (words) return (models ?? []).filter(m => m.module.toLowerCase().includes(words)).map(fileEntry)
      if (project !== null) return (models ?? []).filter(m => m.under === project).map(fileEntry)
      return (paths ?? []).map(p => {
        const files = (models ?? []).filter(m => m.under === p.path).length
        return {
          kind: 'linked' as const, linked: p, files, id: `linked:${p.path}`, label: baseName(p.path),
          subtitle: `${files} ${files === 1 ? 'module' : 'modules'}`, icon: <LinkedFolderIcon />,
        }
      })
    }
    if (!shelf) return []
    // Finding looks in every folder; otherwise what is in this one.
    const folders = words ? [] : shelf.folders.filter(f => parentOf(f.path) === folder)
    const queries = shelf.queries.filter(q =>
      words ? q.name.toLowerCase().includes(words) || q.statement.toLowerCase().includes(words) : q.folder === folder,
    )
    return [
      ...folders.map(f => ({ kind: 'folder' as const, folder: f, id: `folder:${f.path}`, label: f.name, subtitle: held(f), icon: <FolderIcon /> })),
      ...queries.map(q => ({
        kind: 'query' as const, query: q, id: `query:${q.id}`, label: q.name, subtitle: words && q.folder ? q.folder : firstLine(q.statement), icon: <QueryIcon />,
      })),
    ]
  }, [place, models, paths, project, shelf, folder, find])

  const chosen = entries.find(e => e.id === selected) ?? null

  const open = (entry: Entry) => {
    if (entry.kind === 'folder') go(entry.folder.path)
    else if (entry.kind === 'linked') {
      setProject(entry.linked.path)
      setSelected(null)
    }
    else if (entry.kind === 'query') openInCypher(entry.query.statement, entry.query.parameters, { id: entry.query.id, name: entry.query.name, folder: entry.query.folder })
    else setSelected(entry.id)
  }

  const menuFor = (entry: Entry): MenuItem[] => {
    if (entry.kind === 'model') return [menuAction('Show Contents', () => setSelected(entry.id))]
    if (entry.kind === 'linked') {
      return [
        menuAction('Open', () => open(entry)),
        menuSeparator(),
        menuAction('Unlink', () => void unlink(entry.linked.path), { disabled: entry.linked.source === 'environment' }),
      ]
    }
    return [
      menuAction(entry.kind === 'folder' ? 'Open' : 'Open in Cypher', () => open(entry)),
      menuSeparator(),
      menuAction(entry.kind === 'folder' ? 'Delete Folder…' : 'Delete…', () => setRemoving(entry), {
        disabled: entry.kind === 'folder' && entry.folder.folders + entry.folder.queries > 0,
      }),
    ]
  }

  const remove = (entry: Entry) => {
    setRemoving(null)
    const done = entry.kind === 'folder' ? removeFolder(entry.folder.path) : entry.kind === 'query' ? removeQuery(entry.query.id) : Promise.resolve()
    done.then(() => {
      setSelected(null)
      savedQuery()
    }, (e: unknown) => setProblem(message(e)))
  }

  if (!shelf) return problem ? <div className="studio-hint" role="alert"><p>{problem}</p></div> : <Loading label="Reading the files" />

  const places = (
    <Sidebar
      label="Places"
      value={place}
      onChange={id => {
        setPlace(id as Place)
        setProject(null)
        setSelected(null)
        setFind('')
      }}
      sections={[{ id: 'places', label: 'Places', items: [
        { id: 'queries', label: 'Queries', icon: <QueryIcon small />, badge: shelf.queries.length || undefined },
        { id: 'models', label: 'Model Files', icon: <ModelIcon small /> },
      ] }]}
    />
  )

  const crumbs = place === 'queries' ? ['', ...folder.split('/').filter(Boolean).map((_, i, parts) => parts.slice(0, i + 1).join('/'))] : []

  return (
    <>
      <Split side={places} size={200} min={160} remember="drivine-studio.files" label="Resize the places">
        <div className="studio-finder">
          <div className="studio-finder-bar">
            {place === 'queries' ? (
              <>
                <Button size="small" intent="quiet" onClick={() => go(parentOf(folder))} disabled={!folder} title="Enclosing folder">‹</Button>
                <nav className="studio-crumbs desk-text-small" aria-label="Folder">
                  {crumbs.map((path, i) => (
                    <span key={path || 'top'}>
                      {i > 0 && <span className="desk-text-muted"> / </span>}
                      <button type="button" className="studio-crumb" aria-current={path === folder ? 'page' : undefined} onClick={() => go(path)}>
                        {path ? path.slice(path.lastIndexOf('/') + 1) : 'Queries'}
                      </button>
                    </span>
                  ))}
                </nav>
              </>
            ) : (
              <>
                <Button size="small" intent="quiet" onClick={() => setProject(null)} disabled={project === null} title="All linked projects">‹</Button>
                <nav className="studio-crumbs desk-text-small" aria-label="Project">
                  <button type="button" className="studio-crumb" aria-current={project === null ? 'page' : undefined} onClick={() => setProject(null)}>Model Files</button>
                  {project !== null && (
                    <span>
                      <span className="desk-text-muted"> / </span>
                      <span className="studio-crumb" aria-current="page" title={project}>{baseName(project)}</span>
                    </span>
                  )}
                </nav>
              </>
            )}
            <span className="desk-grow" />
            <span className="studio-find">
              <TextField label="Find" labelHidden placeholder={place === 'queries' ? 'Find a query' : 'Find a module'} value={find} onChange={e => setFind(e.target.value)} />
            </span>
            <SegmentedControl label="View as" size="small" value={layout} onChange={setLayout} options={[{ value: 'icons', label: 'Icons' }, { value: 'list', label: 'List' }]} />
            {place === 'queries' && <Button size="small" onClick={() => setNaming(true)}>New Folder</Button>}
            {place === 'models' && <Button size="small" onClick={linkFolder}>Link Folder…</Button>}
          </div>
          <div className="studio-finder-body">
            <div className="studio-finder-view">
              {layout === 'icons' ? (
                <IconView
                  items={entries}
                  label={place === 'queries' ? 'Queries' : 'Model files'}
                  selected={selected}
                  onSelectionChange={setSelected}
                  onOpen={open}
                  contextMenu={menuFor}
                  empty={<Empty place={place} finding={find.trim() !== ''} />}
                />
              ) : (
                <ListView entries={entries} selected={selected} onSelect={setSelected} onOpen={open} menuFor={menuFor} empty={<Empty place={place} finding={find.trim() !== ''} />} />
              )}
            </div>
            {chosen && (
              <Details
                entry={chosen}
                onOpen={() => open(chosen)}
                onRemove={() => (chosen.kind === 'linked' ? void unlink(chosen.linked.path) : setRemoving(chosen))}
              />
            )}
          </div>
          {problem && <p className="studio-bad desk-text-small studio-finder-problem" role="alert">{problem}</p>}
        </div>
      </Split>
      {linking && (
        <LinkFolder
          onLink={path => link(path).then(() => setLinking(false))}
          onCancel={() => setLinking(false)}
        />
      )}
      {naming && (
        <NewFolder
          inside={folder}
          onDone={made => {
            setNaming(false)
            if (made) savedQuery()
          }}
        />
      )}
      <Alert
        open={removing !== null}
        title={`Delete ${removing?.label ?? ''}?`}
        message={removing?.kind === 'folder' ? 'The empty folder is deleted.' : 'Its file is deleted from the studio’s home. A statement already open in Cypher stays there.'}
        confirmLabel="Delete"
        destructive
        onConfirm={() => removing && remove(removing)}
        onCancel={() => setRemoving(null)}
      />
    </>
  )
}

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const held = (f: QueryFolder) =>
  [f.folders && `${f.folders} ${f.folders === 1 ? 'folder' : 'folders'}`, `${f.queries} ${f.queries === 1 ? 'query' : 'queries'}`].filter(Boolean).join(', ')
const kindOf = (entry: Entry) =>
  entry.kind === 'folder' ? 'Folder' : entry.kind === 'query' ? 'Cypher query' : entry.kind === 'linked' ? 'Linked project' : 'Model file'
const baseName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
const modifiedOf = (entry: Entry) => (entry.kind === 'query' ? entry.query.saved : entry.kind === 'model' ? entry.model.modified : null)

function Empty({ place, finding }: { place: Place; finding: boolean }) {
  if (finding) return <p className="desk-text-small desk-text-muted">Nothing matches.</p>
  return place === 'queries'
    ? <p className="desk-text-small desk-text-muted">Nothing here yet. Save a statement from Cypher with ⌘S, or make a folder.</p>
    : <p className="desk-text-small desk-text-muted">No projects linked. Link Folder… a project that uses Drivine, and the studio reads the model files its builds write.</p>
}

/** The same entries as rows: name, kind and when it changed, as a Finder's list shows them. */
function ListView({ entries, selected, onSelect, onOpen, menuFor, empty }: {
  entries: Entry[]
  selected: string | null
  onSelect: (id: string) => void
  onOpen: (entry: Entry) => void
  menuFor: (entry: Entry) => MenuItem[]
  empty: ReactNode
}) {
  // One menu for the list, filled with the row it was asked over.
  const over = useRef<Entry | null>(null)
  const { target, menu } = useContextMenu({ label: 'Actions', items: () => (over.current ? menuFor(over.current) : []) })
  return (
    <>
      <Table
        label="Files"
        rows={entries}
        rowId={e => e.id}
        selected={selected}
        onSelect={id => onSelect(id)}
        onActivate={(_id, entry) => onOpen(entry)}
        empty={empty}
        rowProps={entry => ({
          onContextMenu: (event: MouseEvent<HTMLElement>) => {
            over.current = entry
            onSelect(entry.id)
            target.onContextMenu(event)
          },
        })}
        columns={[
          { key: 'name', header: 'Name', render: e => <span className="studio-file-name"><span className="studio-file-icon">{e.icon}</span>{e.label}</span> },
          { key: 'kind', header: 'Kind', width: '9rem', render: e => <span className="desk-text-muted">{kindOf(e)}</span> },
          { key: 'modified', header: 'Modified', width: '12rem', render: e => <span className="desk-text-muted">{modifiedOf(e) ? new Date(modifiedOf(e)!).toLocaleString() : '—'}</span> },
        ]}
      />
      {menu}
    </>
  )
}

/** What is chosen, beside the view: a query's statement, a folder's contents, a model file's text. */
function Details({ entry, onOpen, onRemove }: { entry: Entry; onOpen: () => void; onRemove: () => void }) {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    setText(null)
    if (entry.kind === 'model') readModelFile(entry.model.path).then(setText, (e: unknown) => setText(`Cannot be read: ${message(e)}`))
  }, [entry])
  return (
    <aside className="studio-details" aria-label={`About ${entry.label}`}>
      <div className="studio-details-icon">{entry.icon}</div>
      <h3>{entry.label}</h3>
      <p className="desk-text-small desk-text-muted">{kindOf(entry)}{modifiedOf(entry) ? ` · ${new Date(modifiedOf(entry)!).toLocaleString()}` : ''}</p>
      {entry.kind === 'folder' && <p className="desk-text-small">{held(entry.folder)}</p>}
      {entry.kind === 'linked' && (
        <>
          <p className="desk-text-small studio-details-path">{entry.linked.path}</p>
          <p className="desk-text-small">
            {entry.files} {entry.files === 1 ? 'module' : 'modules'} with model files.{' '}
            {entry.linked.source === 'environment' ? 'Linked by DRIVINE_STUDIO_MODELS, where the studio was started.' : 'Read where it is: Reload Model Files reads a rebuild.'}
          </p>
        </>
      )}
      {entry.kind === 'query' && (
        <>
          <CodeBlock code={entry.query.statement} language="text" />
          {entry.query.parameters.trim() && (
            <>
              <h4 className="desk-text-small">Parameters</h4>
              <CodeBlock code={entry.query.parameters} language="json" />
            </>
          )}
        </>
      )}
      {entry.kind === 'model' && (
        <>
          <p className="desk-text-small studio-details-path">{entry.model.path}</p>
          {entry.model.problem ? (
            <p className="desk-text-small studio-bad">{entry.model.problem}</p>
          ) : (
            <p className="desk-text-small">{entry.model.views} views · {entry.model.fragments} fragments</p>
          )}
          {text === null ? <Loading label="Reading it" /> : <CodeBlock code={text} language="json" />}
        </>
      )}
      <div className="studio-details-actions">
        {entry.kind === 'query' && <Button intent="default" onClick={onOpen}>Open in Cypher</Button>}
        {entry.kind === 'folder' && <Button onClick={onOpen}>Open</Button>}
        {entry.kind === 'linked' && <Button onClick={onOpen}>Open</Button>}
        {entry.kind === 'linked' && (
          <Button intent="quiet" onClick={onRemove} disabled={entry.linked.source === 'environment'}>Unlink</Button>
        )}
        {(entry.kind === 'folder' || entry.kind === 'query') && (
          <Button intent="quiet" onClick={onRemove} disabled={entry.kind === 'folder' && entry.folder.folders + entry.folder.queries > 0}>
            Delete…
          </Button>
        )}
      </div>
    </aside>
  )
}

/** In a browser, which can't say where a folder lives: the project's path, pasted, to link where it is. */
function LinkFolder({ onLink, onCancel }: { onLink: (path: string) => Promise<void>; onCancel: () => void }) {
  const [path, setPath] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const link = () => onLink(path.trim()).catch((e: unknown) => setProblem(message(e)))
  return (
    <Sheet
      open
      onDismiss={onCancel}
      title="Link a Project"
      description="The folder of a project that uses Drivine, where it is on this machine: the studio reads the model files its builds write under it. In the desktop app, Link Folder… opens a folder picker instead."
      actions={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button intent="default" onClick={link} disabled={!path.trim()}>Link</Button>
        </>
      }
    >
      <form
        onSubmit={event => {
          event.preventDefault()
          link()
        }}
      >
        <TextField label="Folder" placeholder="/Users/you/projects/my-app" value={path} onChange={e => setPath(e.target.value)} autoFocus />
        {problem && <p className="studio-bad desk-text-small" role="alert">{problem}</p>}
      </form>
    </Sheet>
  )
}

function NewFolder({ inside, onDone }: { inside: string; onDone: (made: boolean) => void }) {
  const [name, setName] = useState('untitled folder')
  const [problem, setProblem] = useState<string | null>(null)
  const make = () =>
    addFolder(inside ? `${inside}/${name.trim()}` : name.trim()).then(() => onDone(true), (e: unknown) => setProblem(message(e)))
  return (
    <Sheet
      open
      onDismiss={() => onDone(false)}
      title="New Folder"
      description={inside ? `In ${inside.split('/').join(' / ')}.` : 'In Queries.'}
      actions={
        <>
          <Button onClick={() => onDone(false)}>Cancel</Button>
          <Button intent="default" onClick={make} disabled={!name.trim()}>Create</Button>
        </>
      }
    >
      <form
        onSubmit={event => {
          event.preventDefault()
          make()
        }}
      >
        <TextField label="Name" value={name} onChange={e => setName(e.target.value)} autoFocus />
        {problem && <p className="studio-bad desk-text-small" role="alert">{problem}</p>}
      </form>
    </Sheet>
  )
}

// Drawn, not images, in the studio's colours: a Finder's filled, two-tone icons rather than outlines. Each takes ids of
// its own for its gradients, as two on a page would otherwise share the first's.
const SIZE = { small: 16, large: 44 }

function Folder({ small }: { small?: boolean }) {
  const id = useId()
  const size = small ? SIZE.small : SIZE.large
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-back`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2b8f9b" /><stop offset="1" stopColor="#0f6e7a" /></linearGradient>
        <linearGradient id={`${id}-front`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#6fc6d0" /><stop offset="1" stopColor="#2a95a2" /></linearGradient>
      </defs>
      <path d="M4 12a4 4 0 0 1 4-4h10.3a3 3 0 0 1 2.2 1l2.6 2.8a3 3 0 0 0 2.2 1H40a4 4 0 0 1 4 4V36a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill={`url(#${id}-back)`} />
      <path d="M4 19a3 3 0 0 1 3-3h34a3 3 0 0 1 3 3v17a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill={`url(#${id}-front)`} />
      <path d="M7 17.6h34" stroke="#ffffff" strokeOpacity="0.45" strokeWidth="1" />
    </svg>
  )
}

function Query({ small }: { small?: boolean }) {
  const id = useId()
  const size = small ? SIZE.small : SIZE.large
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-paper`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#dbe8eb" /></linearGradient>
      </defs>
      <path d="M11 4h18l10 10v28a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill={`url(#${id}-paper)`} stroke="#9fbcc3" strokeWidth="1" />
      <path d="M29 4v8a2 2 0 0 0 2 2h8" fill="#c9dde1" stroke="#9fbcc3" strokeWidth="1" />
      <path d="M20 23l-5 5 5 5M28 23l5 5-5 5M25.5 21l-3 14" fill="none" stroke="#f08a5d" strokeWidth={small ? 3.2 : 2.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Model({ small }: { small?: boolean }) {
  const size = small ? SIZE.small : SIZE.large
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <path d="M24 5l17 9.5L24 24 7 14.5z" fill="#6fc6d0" />
      <path d="M7 14.5L24 24v19L7 33.5z" fill="#0f6e7a" />
      <path d="M41 14.5L24 24v19l17-9.5z" fill="#f08a5d" />
      <path d="M24 24v19" stroke="#ffffff" strokeOpacity="0.35" strokeWidth="1" />
    </svg>
  )
}

/** A folder linked where it is: the folder, with a coral link on it. */
function LinkedFolder({ small }: { small?: boolean }) {
  return (
    <span className="studio-linked-icon" data-small={small ? '' : undefined}>
      <Folder small={small} />
      <svg viewBox="0 0 24 24" className="studio-link-badge" aria-hidden="true">
        <circle cx="12" cy="12" r="11" fill="#f08a5d" />
        <path d="M10.5 13.5l3-3M9.5 11.5l-1.3 1.3a2.5 2.5 0 0 0 3.5 3.5l1.3-1.3M14.5 12.5l1.3-1.3a2.5 2.5 0 0 0-3.5-3.5l-1.3 1.3" fill="none" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </span>
  )
}

const LinkedFolderIcon = LinkedFolder
const FolderIcon = Folder
const QueryIcon = Query
const ModelIcon = Model
