import { Button, SegmentedControl, Sheet, Spinner, Split, Table, Tabs, TextField } from '@liberation-data/desk/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { useStudio } from './App'
import type { SavedAs } from './App'
import { addQuery, firstLine, updateQuery } from './savedQueries'
import type { SavedQuery } from './savedQueries'
import { DEFAULT_LIMIT, MAX_LIMIT, runCypher } from './database'
import type { Cell, CypherResult } from './database'
import { GraphView, LiveLayoutToggle, useLiveLayout } from './GraphView'
import type { Selection } from './GraphView'
import { Inspector } from './Inspector'
import { cellText, graphOf, parametersOf, writtenText } from './results'

type Run = { state: 'idle' } | { state: 'running' } | { state: 'failed'; message: string }
type View = 'graph' | 'rows'
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

export function Cypher() {
  const { connection, pendingCypher, takeCypher, savedQuery } = useStudio()
  // The saved query the editor holds, when it was opened from one or saved as one: Save saves over it.
  const [savedAs, setSavedAs] = useState<SavedAs | null>(null)
  const [saving, setSaving] = useState(false)
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

  const execute = useCallback(() => {
    if (!connection) return
    const parsed = parametersOf(parameters)
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
      { connection: connection.id, statement, parameters: parsed.parameters, ...(Number.isFinite(rows) ? { limit: rows } : {}) },
      controller.signal,
    ).then(
      answered => {
        setResult(answered)
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
  // ⌘↵ or Ctrl+↵ runs it from the editor, where Enter is a new line; ⌘S saves it.
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      execute()
    }
    if (event.key === 's' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      if (statement.trim()) setSaving(true)
    }
  }

  const drawn = useMemo(() => (result ? graphOf(result.graph) : null), [result])
  const [live, setLive] = useLiveLayout(drawn?.graph)

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
        <span className="desk-grow" />
        {run.state === 'running' && <Spinner label="Running" size="small" />}
        <span className="studio-query-word desk-text-small desk-text-muted">at most</span>
        <span className="studio-limit">
          <TextField label="Rows to read, at most" labelHidden type="number" min={1} max={MAX_LIMIT} value={limit} onChange={e => setLimit(e.target.value)} />
        </span>
        <span className="desk-text-small desk-text-muted">rows</span>
        <Button type="button" onClick={() => setSaving(true)} disabled={!statement.trim()} title="⌘S">Save</Button>
        <Button type="submit" intent="default" disabled={!connection || run.state === 'running'} title="⌘↵">Run</Button>
      </div>
      {size === 'line' ? (
        // Folded to a line: the statement's start, which opens the editor again.
        <button type="button" className="studio-statement-line desk-text-small" onClick={() => setSize('split')} title="Show the editor">
          {firstLine || 'No statement yet'}
        </button>
      ) : pane === 'statement' ? (
        <>
          <label className="desk-label" htmlFor="studio-statement" data-hidden>Statement</label>
          {/* The editor fills what the edge below leaves it, so it is sized by dragging the edge, not by a corner of its own. */}
          <textarea
            id="studio-statement"
            className="desk-input studio-editor studio-statement"
            spellCheck={false}
            value={statement}
            onChange={e => setStatement(e.target.value)}
            onKeyDown={keys}
          />
        </>
      ) : (
        <>
          <label className="desk-label" htmlFor="studio-parameters" data-hidden>Parameters, as a JSON object</label>
          <textarea
            id="studio-parameters"
            className="desk-input studio-editor studio-statement"
            spellCheck={false}
            placeholder={'Parameters, as a JSON object:\n{"name": "Ada"}'}
            value={parameters}
            onChange={e => setParameters(e.target.value)}
            onKeyDown={keys}
          />
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
              {view === 'graph' && <LiveLayoutToggle live={live} onChange={setLive} />}
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
              <GraphView graph={drawn.graph} live={live} fragments={drawn.labels} onSelect={setSelection} />
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
    <div className="studio-canvas">
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
          savedAs={savedAs}
          onDone={saved => {
            setSaving(false)
            if (!saved) return
            setSavedAs({ id: saved.id, name: saved.name })
            savedQuery()
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
  const [name, setName] = useState(() => savedAs?.name ?? firstLine(statement).slice(0, 60))
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = (asNew: boolean) => {
    setBusy(true)
    setProblem(null)
    const input = { name, statement, parameters }
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
      description="Kept as a .cypher file in the studio's home, with its parameters, to open again from Queries."
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
        <TextField label="Name" value={name} onChange={e => setName(e.target.value)} autoFocus />
        {problem && <p className="studio-bad desk-text-small" role="alert">{problem}</p>}
      </form>
    </Sheet>
  )
}
