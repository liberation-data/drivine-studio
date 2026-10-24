import { Button, PopUpButton, Spinner, Table, Tabs, TextField } from '@liberation-data/desk/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { useStudio } from './App'
import { DATABASE_NAMES, DEFAULT_LIMIT, MAX_LIMIT, runCypher } from './database'
import type { Cell, CypherResult } from './database'
import { GraphView } from './GraphView'
import type { Selection } from './GraphView'
import { Inspector } from './Inspector'
import { cellText, graphOf, parametersOf } from './results'

type Run = { state: 'idle' } | { state: 'running' } | { state: 'failed'; message: string }
type View = 'graph' | 'rows'

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
  const { connections, connection, chooseConnection, pendingCypher, takeCypher } = useStudio()
  const [statement, setStatement] = useState(() => remembered(STATEMENT, 'MATCH (n) RETURN n LIMIT 25'))
  const [parameters, setParameters] = useState(() => remembered(PARAMETERS, ''))
  const [showParameters, setShowParameters] = useState(() => parameters.trim() !== '')
  const [limit, setLimit] = useState(String(DEFAULT_LIMIT))
  const [result, setResult] = useState<CypherResult | null>(null)
  const [run, setRun] = useState<Run>({ state: 'idle' })
  const [view, setView] = useState<View>('graph')
  const [selection, setSelection] = useState<Selection>(null)
  const inFlight = useRef<AbortController | null>(null)

  useEffect(() => remember(STATEMENT, statement), [statement])
  useEffect(() => remember(PARAMETERS, parameters), [parameters])
  useEffect(() => () => inFlight.current?.abort(), [])

  // A statement sent from the canvas replaces what is in the editor.
  useEffect(() => {
    if (!pendingCypher) return
    setStatement(pendingCypher.statement)
    const parameters = Object.keys(pendingCypher.parameters).length ? JSON.stringify(pendingCypher.parameters, null, 2) : ''
    setParameters(parameters)
    setShowParameters(parameters !== '')
    takeCypher()
  }, [pendingCypher, takeCypher])

  const execute = useCallback(() => {
    if (!connection) return
    const parsed = parametersOf(parameters)
    if ('problem' in parsed) {
      setShowParameters(true)
      setRun({ state: 'failed', message: parsed.problem })
      return
    }
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
  // ⌘↵ or Ctrl+↵ runs it from the editor, where Enter is a new line.
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      execute()
    }
  }

  const drawn = useMemo(() => (result ? graphOf(result.graph) : null), [result])

  return (
    <div className="studio-canvas">
      <form className="studio-query" onSubmit={submit} aria-label="Cypher">
        <div className="studio-query-row">
          <PopUpButton
            label="Connection" labelHidden size="small"
            value={connection?.id ?? null}
            placeholder={connections?.length ? 'Choose a connection' : 'No connections yet'}
            disabled={!connections?.length}
            onChange={chooseConnection}
            options={(connections ?? []).map(c => ({ value: c.id, label: `${c.name} · ${DATABASE_NAMES[c.type]}` }))}
          />
          <span className="desk-grow" />
          <Status run={run} result={result} />
          <Button type="button" size="small" intent="quiet" onClick={() => setShowParameters(!showParameters)} aria-expanded={showParameters}>
            Parameters
          </Button>
          <span className="studio-query-word desk-text-small desk-text-muted">at most</span>
          <span className="studio-limit">
            <TextField label="Rows to read, at most" labelHidden type="number" min={1} max={MAX_LIMIT} value={limit} onChange={e => setLimit(e.target.value)} />
          </span>
          <span className="desk-text-small desk-text-muted">rows</span>
          <Button type="submit" intent="default" disabled={!connection || run.state === 'running'} title="⌘↵">Run</Button>
        </div>
        <label className="desk-label" htmlFor="studio-statement" data-hidden>Statement</label>
        <textarea
          id="studio-statement"
          className="desk-input studio-editor"
          spellCheck={false}
          value={statement}
          onChange={e => setStatement(e.target.value)}
          onKeyDown={keys}
          rows={5}
        />
        {showParameters && (
          <>
            <label className="desk-label desk-text-small" htmlFor="studio-parameters">Parameters, as a JSON object</label>
            <textarea
              id="studio-parameters"
              className="desk-input studio-editor"
              spellCheck={false}
              placeholder='{"name": "Ada"}'
              value={parameters}
              onChange={e => setParameters(e.target.value)}
              onKeyDown={keys}
              rows={3}
            />
          </>
        )}
      </form>
      {run.state === 'failed' && <p className="studio-failure" role="alert">{run.message}</p>}
      {!connection && (
        <div className="studio-hint">
          <h2>No connection in use</h2>
          <p>Add one in Connections, or choose one above. The studio runs each statement where it cannot write.</p>
        </div>
      )}
      {connection && result && drawn && (
        <Tabs
          label="Result"
          value={view}
          onChange={setView}
          className="studio-tabs"
          tabs={[
            { value: 'graph', label: 'Graph', badge: drawn.graph.nodes.length || undefined, disabled: drawn.graph.nodes.length === 0 },
            { value: 'rows', label: 'Rows', badge: result.rows.length },
          ]}
        >
          {view === 'graph' ? (
            <div className="studio-result">
              <GraphView graph={drawn.graph} fragments={drawn.labels} onSelect={setSelection} />
              {selection && <Inspector selection={selection} nodes={drawn.graph.nodes} fragments={drawn.labels} />}
            </div>
          ) : (
            <Rows result={result} />
          )}
        </Tabs>
      )}
    </div>
  )
}

function Status({ run, result }: { run: Run; result: CypherResult | null }) {
  if (run.state === 'running') return <Spinner label="Running" size="small" />
  if (!result) return null
  const rows = result.rows.length
  return (
    <span className="desk-text-small desk-text-muted" role="status">
      {rows} {rows === 1 ? 'row' : 'rows'} in {result.milliseconds} ms
      {result.truncated && ` · stopped at ${result.limit}`}
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
