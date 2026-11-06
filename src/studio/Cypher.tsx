import { addCommandHandler, windowElement } from '@liberation-data/desk'
import { Button, PopUpButton, SegmentedControl, Sheet, Spinner, Split, Table, Tabs, TextField, Toggle, useDropTarget, useWindowId } from '@liberation-data/desk/react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { StudioCommands, useStudio } from './App'
import type { SavedAs } from './App'
import { addQuery, firstLine, listQueries, QUERY_DRAG, updateQuery } from './savedQueries'
import type { QueryDrag, SavedQuery } from './savedQueries'
import { connectResults, DEFAULT_LIMIT, MAX_LIMIT, runCypher } from './database'
import type { Cell, CypherResult } from './database'
import { GraphView, LiveLayoutToggle, useLiveLayout } from './GraphView'
import type { Selection } from './GraphView'
import { GraphView3D } from './GraphView3D'
import { MAX_3D_NODES, fits3D, shownDepth } from './graph3d'
import type { Depth } from './graph3d'
import { Inspector } from './Inspector'
import { cellText, graphOf, parametersOf, withConnections, writtenText } from './results'
import { connectionsOf, toConnect, waitsToConnect } from './connect'
import type { Connected } from './connect'
import { useSchema } from './schema'

// CodeMirror, on its own, so the window draws first: until it lands, the plain field it replaces.
const CypherEditor = lazy(() => import('./CypherEditor'))

type Run = { state: 'idle' } | { state: 'running' } | { state: 'failed'; message: string }
type View = 'graph' | 'rows'
const DEPTH_KEY = 'drivine-studio.graph-depth'
/** What the editor shows: the statement, or the parameters it is run with. */
type Pane = 'statement' | 'parameters'
/**
 * How much of the window the editor takes: a line, to see the results whole; its share above the edge; or all of it,
 * for a long statement. Running from all of it brings the results back.
 */
type Size = 'line' | 'split' | 'full'

// What was typed last, kept in this browser only: a convenience, and lost without harm.
const remembered = (key: string, fallback: string): string => {
  try {
    return window.localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}
const remember = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage may be full, or not allowed; the text is still in the window.
  }
}

const STATEMENT = 'drivine-studio.cypher.statement'
const PARAMETERS = 'drivine-studio.cypher.parameters'
const CONNECT = 'drivine-studio.cypher.connect'

export function Cypher() {
  const { connection, pendingCypher, takeCypher, savedQuery } = useStudio()
  // The saved query the editor holds, when it was opened from one or saved as one: Save saves over it.
  const [savedAs, setSavedAs] = useState<SavedAs | null>(null)
  // The name sheet, open to save under a name, or to save a copy under a new one.
  const [saving, setSaving] = useState<'save' | 'copy' | null>(null)
  const [savedNote, setSavedNote] = useState<string | null>(null)
  const [statement, setStatement] = useState(() => remembered(STATEMENT, 'MATCH (n) RETURN n LIMIT 25'))
  const [parameters, setParameters] = useState(() => remembered(PARAMETERS, ''))
  const [pane, setPane] = useState<Pane>('statement')
  const [limit, setLimit] = useState(String(DEFAULT_LIMIT))
  const [result, setResult] = useState<CypherResult | null>(null)
  const [run, setRun] = useState<Run>({ state: 'idle' })
  const [view, setView] = useState<View>('graph')
  const [selection, setSelection] = useState<Selection>(null)
  const [size, setSize] = useState<Size>('split')
  const inFlight = useRef<AbortController | null>(null)
  // Counted up after each statement that wrote, so the editor's completion reads the graph again.
  const [wrote, setWrote] = useState(0)
  const schema = useSchema(connection?.id, wrote)

  useEffect(() => remember(STATEMENT, statement), [statement])
  useEffect(() => remember(PARAMETERS, parameters), [parameters])
  useEffect(() => () => inFlight.current?.abort(), [])

  // A statement sent from the canvas replaces what is in the editor.
  useEffect(() => {
    if (!pendingCypher) return
    setStatement(pendingCypher.statement)
    const given = pendingCypher.parameters
    const parameters = typeof given === 'string' ? given : Object.keys(given).length ? JSON.stringify(given, null, 2) : ''
    setParameters(parameters)
    setSavedAs(pendingCypher.saved ?? null)
    setPane('statement')
    takeCypher()
  }, [pendingCypher, takeCypher])

  // The editor gives its text as it holds it now, which React may not have drawn yet: see CypherEditor's runCommand.
  const execute = useCallback((given: { statement?: string; parameters?: string } = {}) => {
    if (!connection) return
    const text = given.statement ?? statement
    const parsed = parametersOf(given.parameters ?? parameters)
    if ('problem' in parsed) {
      setPane('parameters')
      setRun({ state: 'failed', message: parsed.problem })
      return
    }
    // Run from the whole window, and the results come back; from a line, they were in sight already.
    setSize(current => (current === 'full' ? 'split' : current))
    const rows = Number.parseInt(limit, 10)
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setRun({ state: 'running' })
    runCypher(
      { connection: connection.id, statement: text, parameters: parsed.parameters, ...(Number.isFinite(rows) ? { limit: rows } : {}) },
      controller.signal,
    ).then(
      answered => {
        setResult(answered)
        setHolding(connectNow.current ? answered : null)
        if (answered.written) setWrote(n => n + 1)
        setSelection(null)
        // A result with nodes in it is drawn; one of values alone is a table.
        setView(answered.graph.nodes.length > 0 ? 'graph' : 'rows')
        setRun({ state: 'idle' })
      },
      (e: unknown) => {
        if (controller.signal.aborted) return
        setRun({ state: 'failed', message: e instanceof Error ? e.message : String(e) })
      },
    )
  }, [connection, statement, parameters, limit])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    execute()
  }
  // ⌘↵ or Ctrl+↵ runs it from the editor, where Enter is a new line.
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      execute()
    }
  }

  const kept = useCallback((saved: SavedQuery) => {
    setSavedAs({ id: saved.id, name: saved.name, folder: saved.folder })
    savedQuery()
    setSavedNote('Saved')
  }, [savedQuery])
  useEffect(() => {
    if (!savedNote) return
    const timer = setTimeout(() => setSavedNote(null), 2000)
    return () => clearTimeout(timer)
  }, [savedNote])

  /*
   * File ▸ Save and Save As…, answered by this window while it is the one in front. A query already saved is saved
   * over at once, as a document is; one not saved yet, or a copy, asks for its name first.
   */
  const windowId = useWindowId()
  const now = useRef({ statement, parameters, savedAs })
  now.current = { statement, parameters, savedAs }
  useEffect(() => {
    const element = windowId ? windowElement(document, windowId) : null
    if (!element) return
    const something = () => now.current.statement.trim() !== ''
    const save = () => {
      const { statement, parameters, savedAs } = now.current
      if (!savedAs) return setSaving('save')
      updateQuery(savedAs.id, { name: savedAs.name, folder: savedAs.folder, statement, parameters }).then(kept, () => setSaving('save'))
    }
    const removers = [
      addCommandHandler(element, StudioCommands.save, save, { enabled: something }),
      addCommandHandler(element, StudioCommands.saveAs, () => setSaving('copy'), { enabled: something }),
    ]
    return () => removers.forEach(remove => remove())
  }, [windowId, kept])

  // A saved query carried here from Files opens here, as a double-click on it does.
  const { dropProps } = useDropTarget<QueryDrag>({
    accepts: QUERY_DRAG,
    onDrop: ({ payload: q }) => {
      setStatement(q.statement)
      setParameters(q.parameters)
      setSavedAs({ id: q.id, name: q.name, folder: q.folder })
      setPane('statement')
      setSize(current => (current === 'line' ? 'split' : current))
    },
  })

  /*
   * The relationships among the result's nodes, drawn beside what the query gave back, as Neo4j Browser's "Connect
   * result nodes" does: one more read, on by default, and remembered. They are read once for each result and kept, so
   * the toggle draws them or takes them away where the graph stands, with no new layout. A new result run with it on
   * waits for them, so it is laid out once; one connected after it is drawn has them added to it.
   */
  const [connectOn, setConnectOnNow] = useState(() => remembered(CONNECT, 'on') === 'on')
  useEffect(() => remember(CONNECT, connectOn ? 'on' : 'off'), [connectOn])
  const connectNow = useRef(connectOn)
  connectNow.current = connectOn
  // The new result that waits for its connections before it is first drawn.
  const [holding, setHolding] = useState<CypherResult | null>(null)
  const [connected, setConnected] = useState<Connected | null>(null)
  const setConnectOn = (on: boolean) => {
    // Turned off or on, the graph shown stays shown; and a read that failed is tried again.
    setHolding(null)
    setConnected(known => (known?.failed ? null : known))
    setConnectOnNow(on)
  }
  const known = connectionsOf(connected, result, connection?.id)
  const reading = toConnect(connectOn, result, connection?.id, connected)
  useEffect(() => {
    if (!reading || !result || !connection) return
    const settled = (got: Omit<Connected, 'for' | 'connection'>) => {
      setConnected({ for: result, connection: connection.id, ...got })
      setHolding(held => (held === result ? null : held))
    }
    const ids = result.graph.nodes.filter(n => !n.partial).map(n => n.id)
    if (ids.length < 2) return settled({ relationships: [], truncated: false })
    const controller = new AbortController()
    connectResults(connection.id, ids, controller.signal).then(
      got => settled(got),
      () => {
        // Not connected is still a graph: what the query gave back, as it gave it.
        if (!controller.signal.aborted) settled({ relationships: [], truncated: false, failed: true })
      },
    )
    return () => controller.abort()
  }, [reading, result, connection])
  const waiting = waitsToConnect(connectOn, result, connection?.id, holding, connected)
  // What the query gave back, made once for each result: its nodes are the same nodes with the connections or without.
  const base = useMemo(() => (result ? graphOf(result.graph) : null), [result])
  const drawn = useMemo(
    () => (!result || !base || waiting ? null : connectOn && known ? withConnections(base, result.graph, known.relationships) : base),
    [result, base, waiting, connectOn, known],
  )
  // A relationship that is chosen and taken away with the connections leaves nothing to show.
  useEffect(() => {
    if (selection?.kind === 'edge' && drawn && !drawn.graph.edges.some(e => e.id === selection.edge.id)) setSelection(null)
  }, [drawn, selection])
  const added = drawn ? drawn.graph.edges.filter(e => e.added).length : 0
  const [live, setLive] = useLiveLayout(drawn?.graph)
  // 2D or 3D, remembered. 3D is for a small graph: a bigger one is drawn in 2D, and the choice kept for the next.
  const [depth, setDepthNow] = useState<Depth>(() => (remembered(DEPTH_KEY, '2d') === '3d' ? '3d' : '2d'))
  const nodeCount = drawn?.graph.nodes.length ?? 0
  const shown = shownDepth(depth, nodeCount)
  const setDepth = (next: Depth) => {
    setDepthNow(next)
    remember(DEPTH_KEY, next)
  }

  const given = parameters.trim() !== ''
  const firstLine = statement.split('\n').find(line => line.trim() !== '')?.trim() ?? ''

  const editor = (
    <form className="studio-query studio-query-fill" onSubmit={submit} aria-label="Cypher">
      <div className="studio-query-row">
        <SegmentedControl
          label="Edit" size="small"
          value={pane}
          onChange={next => {
            setPane(next)
            if (size === 'line') setSize('split')
          }}
          // A dot says there are parameters when the statement is what is shown.
          options={[{ value: 'statement', label: 'Statement' }, { value: 'parameters', label: given ? 'Parameters •' : 'Parameters' }]}
        />
        <SegmentedControl
          label="Editor size" size="small"
          value={size}
          onChange={setSize}
          options={[{ value: 'line', label: 'Line' }, { value: 'split', label: 'Split' }, { value: 'full', label: 'Full' }]}
        />
        {savedAs && <span className="studio-saved-as desk-text-small desk-text-muted" title="The saved query this is">{savedAs.name}</span>}
        {savedNote && <span className="desk-text-small studio-ok" role="status">{savedNote}</span>}
        <span className="desk-grow" />
        {run.state === 'running' && <Spinner label="Running" size="small" />}
        <span className="studio-query-word desk-text-small desk-text-muted">at most</span>
        <span className="studio-limit">
          <TextField label="Rows to read, at most" labelHidden type="number" min={1} max={MAX_LIMIT} value={limit} onChange={e => setLimit(e.target.value)} />
        </span>
        <span className="desk-text-small desk-text-muted">rows</span>
        <Button type="submit" intent="default" disabled={!connection || run.state === 'running'} title="⌘↵">Run</Button>
      </div>
      {size === 'line' ? (
        // Folded to a line: the statement's start, which opens the editor again.
        <button type="button" className="studio-statement-line desk-text-small" onClick={() => setSize('split')} title="Show the editor">
          {firstLine || 'No statement yet'}
        </button>
      ) : pane === 'statement' ? (
        <>
          {/* The editor fills what the edge below leaves it, so it is sized by dragging the edge, not by a corner of its own. */}
          <Suspense
            fallback={
              <textarea id="studio-statement" aria-label="Statement" className="desk-input studio-editor studio-statement" spellCheck={false} value={statement} onChange={e => setStatement(e.target.value)} onKeyDown={keys} />
            }
          >
            <CypherEditor key="statement" id="studio-statement" label="Statement" language="cypher" value={statement} onChange={setStatement} onRun={text => execute({ statement: text })} schema={schema} />
          </Suspense>
        </>
      ) : (
        <>
          <Suspense
            fallback={
              <textarea id="studio-parameters" aria-label="Parameters, as a JSON object" className="desk-input studio-editor studio-statement" spellCheck={false} placeholder={'Parameters, as a JSON object:\n{"name": "Ada"}'} value={parameters} onChange={e => setParameters(e.target.value)} onKeyDown={keys} />
            }
          >
            <CypherEditor key="parameters" id="studio-parameters" label="Parameters, as a JSON object" language="json" value={parameters} onChange={setParameters} onRun={text => execute({ parameters: text })} placeholder={'Parameters, as a JSON object:\n{"name": "Ada"}'} />
          </Suspense>
        </>
      )}
    </form>
  )

  const results = (
    <div className="studio-canvas">
      {run.state === 'failed' && <p className="studio-failure" role="alert">{run.message}</p>}
      {!connection ? (
        <div className="studio-hint">
          <h2>No connection in use</h2>
          <p>Choose one from the connection menu at the end of the menu bar, or add one in Connections.</p>
        </div>
      ) : result && waiting ? (
        <div className="studio-hint"><Spinner label="Connecting the results" size="small" /></div>
      ) : result && drawn ? (
        <Tabs
          label="Result"
          value={view}
          onChange={setView}
          className="studio-tabs"
          // What came back, and how long it took, heads what came back rather than the controls that asked.
          actions={
            <span className="studio-tabs-actions">
              {/* Up here, it stays put when a node's details open beside the graph. */}
              {view === 'graph' && (
                <span className="studio-live desk-text-small" title="Draw the relationships among the nodes that came back, as Neo4j Browser does">
                  <Toggle label={added ? `Connect results (${added})` : 'Connect results'} checked={connectOn} onChange={setConnectOn} />
                  {reading && <Spinner label="Connecting the results" size="small" />}
                </span>
              )}
              {view === 'graph' && shown === '2d' && <LiveLayoutToggle live={live} onChange={setLive} />}
              {view === 'graph' && (
                <span title={fits3D(nodeCount) ? undefined : `3D draws up to ${MAX_3D_NODES} nodes; this result has ${nodeCount.toLocaleString()}`}>
                  <SegmentedControl
                    label="Draw the graph in"
                    size="small"
                    value={shown}
                    onChange={setDepth}
                    options={[{ value: '2d', label: '2D' }, { value: '3d', label: '3D', disabled: !fits3D(nodeCount) }]}
                  />
                </span>
              )}
              <Summary result={result} />
            </span>
          }
          tabs={[
            { value: 'graph', label: 'Graph', badge: drawn.graph.nodes.length || undefined, disabled: drawn.graph.nodes.length === 0 },
            { value: 'rows', label: 'Rows', badge: result.rows.length },
          ]}
        >
          {view === 'graph' ? (
            <div className="studio-result">
              {shown === '3d' ? (
                <GraphView3D graph={drawn.graph} fragments={drawn.labels} onSelect={setSelection} />
              ) : (
                <GraphView graph={drawn.graph} live={live} fragments={drawn.labels} onSelect={setSelection} />
              )}
              {selection && <Inspector selection={selection} nodes={drawn.graph.nodes} fragments={drawn.labels} />}
            </div>
          ) : (
            <Rows result={result} />
          )}
        </Tabs>
      ) : (
        run.state !== 'failed' && <div className="studio-hint"><p>Run a statement to see what it gives.</p></div>
      )}
    </div>
  )

  return (
    <div className="studio-canvas" {...dropProps}>
      {/*
        The editor above, what it gave below, and the edge between them remembered. Expanded, the results are
        hidden rather than taken away, so the editor keeps its place and the results come back as they were.
      */}
      <Split
        orientation="vertical"
        side={editor}
        size={220}
        min={120}
        max="80%"
        remember="drivine-studio.cypher"
        label="Resize the editor"
        className={`studio-cypher-split${size === 'full' ? ' studio-expanded' : size === 'line' ? ' studio-line' : ''}`}
      >
        {results}
      </Split>
      {saving && (
        <SaveQuery
          statement={statement}
          parameters={parameters}
          savedAs={saving === 'copy' ? null : savedAs}
          onDone={saved => {
            setSaving(null)
            if (saved) kept(saved)
          }}
        />
      )}
    </div>
  )
}

function Summary({ result }: { result: CypherResult }) {
  const rows = result.rows.length
  return (
    <span className="desk-text-small desk-text-muted" role="status">
      {rows} {rows === 1 ? 'row' : 'rows'} in {result.milliseconds} ms
      {result.truncated && ` · stopped at ${result.limit}`}
      {result.written && ` · ${writtenText(result.written)}`}
    </span>
  )
}

type Row = { index: number; cells: Cell[] }

function Rows({ result }: { result: CypherResult }) {
  const rows = useMemo<Row[]>(() => result.rows.map((cells, index) => ({ index, cells })), [result])
  if (result.columns.length === 0) {
    return <div className="studio-hint"><h2>No rows</h2><p>The statement ran and gave nothing back.</p></div>
  }
  return (
    <div className="studio-rows">
      <Table
        label="Rows"
        rows={rows}
        rowId={row => String(row.index)}
        empty="No rows came back."
        columns={result.columns.map((column, i) => ({
          key: `c${i}`,
          header: column,
          render: (row: Row) => {
            const cell = row.cells[i]
            const text = cell ? cellText(cell) : ''
            return <span className={cell?.kind === 'null' ? 'studio-cell desk-text-muted' : 'studio-cell'} title={text}>{text}</span>
          },
        }))}
      />
    </div>
  )
}

/**
 * Asks for a name to keep the statement under, its parameters with it: the simple question a sheet is for. A query
 * opened from Queries is saved over, under the name given; Save as New keeps it and makes another.
 */
function SaveQuery({ statement, parameters, savedAs, onDone }: {
  statement: string
  parameters: string
  savedAs: SavedAs | null
  onDone: (saved: SavedQuery | null) => void
}) {
  const { browsing } = useStudio()
  const [name, setName] = useState(() => savedAs?.name ?? firstLine(statement).slice(0, 60))
  // The folder it is in, or for a new one the folder Files is showing.
  const [folder, setFolder] = useState(() => savedAs?.folder ?? browsing)
  const [folders, setFolders] = useState<string[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    listQueries().then(shelf => setFolders(shelf.folders.map(f => f.path)), () => setFolders([]))
  }, [])
  const save = (asNew: boolean) => {
    setBusy(true)
    setProblem(null)
    const input = { name, folder, statement, parameters }
    const saved = savedAs && !asNew ? updateQuery(savedAs.id, input) : addQuery(input)
    saved.then(onDone, (e: unknown) => {
      setBusy(false)
      setProblem(e instanceof Error ? e.message : String(e))
    })
  }
  return (
    <Sheet
      open
      onDismiss={() => onDone(null)}
      title={savedAs ? `Save ${savedAs.name}` : 'Save Query'}
      description="Kept as a .cypher file in the studio's home, with its parameters, to open again from Files."
      actions={
        <>
          <Button onClick={() => onDone(null)}>Cancel</Button>
          {savedAs && <Button onClick={() => save(true)} disabled={busy || !name.trim()}>Save as New</Button>}
          <Button intent="default" onClick={() => save(false)} disabled={busy || !name.trim()}>Save</Button>
        </>
      }
    >
      <form
        onSubmit={event => {
          event.preventDefault()
          save(false)
        }}
      >
        <div className="studio-form">
          <TextField label="Name" value={name} onChange={e => setName(e.target.value)} autoFocus />
          {folders.length > 0 && (
            <PopUpButton
              label="Folder"
              value={folder}
              onChange={setFolder}
              options={[{ value: '', label: 'Queries' }, ...folders.map(path => ({ value: path, label: `Queries / ${path.split('/').join(' / ')}` }))]}
            />
          )}
        </div>
        {problem && <p className="studio-bad desk-text-small" role="alert">{problem}</p>}
      </form>
    </Sheet>
  )
}
