import { Button, Chip, PopUpButton, SegmentedControl, Spinner, TextField, useDropTarget } from '@liberation-data/desk/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { runQuery } from './api'
import type { Catalog, Result } from './api'
import { useStudio } from './App'
import { SUBJECT } from './Catalogue'
import { GraphView } from './GraphView'
import type { Selection } from './GraphView'
import { Inspector } from './Inspector'
import { emptyDraft, operatorsFor, scopesOf, subjectKey, subjectName, toQuery } from './model'
import type { ConditionDraft, QueryDraft, Scope, Subject } from './model'

type Run = { state: 'idle' } | { state: 'running' } | { state: 'failed'; message: string }

export function Canvas() {
  const { catalog, subject, show, connection } = useStudio()
  const { dropProps } = useDropTarget<Subject>({ accepts: SUBJECT, onDrop: drag => show(drag.payload) })

  return (
    <div className="studio-canvas" {...dropProps}>
      {subject && catalog && connection ? (
        // Keyed, so a new subject, or a load on another connection, starts with a clean query and nothing selected.
        <Loaded key={`${subjectKey(subject)}@${connection.id}`} subject={subject} catalog={catalog} connection={connection.id} onClear={() => show(null)} />
      ) : subject && catalog ? (
        <div className="studio-hint">
          <h2>No connection in use</h2>
          <p>Add one in Connections to load {subjectName(subject)} from it.</p>
        </div>
      ) : (
        <div className="studio-hint">
          <h2>Drag a view or fragment here</h2>
          <p>The studio loads it as <code>loadAll</code> does, with the Cypher Drivine writes for it, and draws what came back. It reads and never writes.</p>
        </div>
      )}
    </div>
  )
}

function Loaded({ subject, catalog, connection, onClear }: { subject: Subject; catalog: Catalog; connection: string; onClear: () => void }) {
  const { openInCypher } = useStudio()
  const [draft, setDraft] = useState<QueryDraft>(emptyDraft)
  const [result, setResult] = useState<Result | null>(null)
  const [run, setRun] = useState<Run>({ state: 'idle' })
  const [selection, setSelection] = useState<Selection>(null)
  const scopes = useMemo(() => scopesOf(subject, catalog), [subject, catalog])
  const fragments = useMemo(() => catalog.fragments.map(f => f.name), [catalog])
  const inFlight = useRef<AbortController | null>(null)

  const load = useCallback((from: QueryDraft) => {
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setRun({ state: 'running' })
    runQuery(connection, toQuery(subject, from, catalog), controller.signal).then(
      loaded => {
        setResult(loaded)
        setSelection(null)
        setRun({ state: 'idle' })
      },
      (e: unknown) => {
        if (controller.signal.aborted) return
        setRun({ state: 'failed', message: e instanceof Error ? e.message : String(e) })
      },
    )
  }, [subject, catalog, connection])

  // Dropping something loads it at once, unfiltered: the first thing wanted is to see it. Only then: a catalogue read
  // afresh is used by the next Load, so what is drawn stays the answer to the conditions the form shows.
  useEffect(() => {
    load(emptyDraft())
    return () => inFlight.current?.abort()
  }, [])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    load(draft)
  }

  return (
    <>
      <form className="studio-query" onSubmit={submit} aria-label="Query">
        <div className="studio-query-row">
          <Chip onRemove={onClear} removeLabel={`Take ${subjectName(subject)} off the canvas`}>
            {subject.kind === 'view' ? 'View' : 'Fragment'}: {subjectName(subject)}
          </Chip>
          <span className="desk-grow" />
          <Status run={run} result={result} />
          <Button type="submit" intent="default" disabled={run.state === 'running'}>Load</Button>
        </div>
        <Where scopes={scopes} draft={draft} onChange={setDraft} />
        <div className="studio-query-row">
          <span className="studio-query-word desk-text-small desk-text-muted">order by</span>
          <PopUpButton
            label="Order by" labelHidden size="small"
            value={draft.orderBy}
            onChange={orderBy => setDraft({ ...draft, orderBy })}
            options={[{ value: '', label: 'nothing' }, ...(scopes[0]?.properties ?? []).map(p => ({ value: p.name, label: p.name }))]}
          />
          {draft.orderBy !== '' && (
            <SegmentedControl
              label="Direction" size="small"
              value={draft.direction}
              onChange={direction => setDraft({ ...draft, direction })}
              options={[{ value: 'ASC', label: 'Ascending' }, { value: 'DESC', label: 'Descending' }]}
            />
          )}
          <span className="studio-query-word desk-text-small desk-text-muted">limit</span>
          <span className="studio-limit">
            <TextField label="Limit" labelHidden type="number" min={1} value={draft.limit} onChange={e => setDraft({ ...draft, limit: e.target.value })} />
          </span>
        </div>
      </form>
      {run.state === 'failed' && <p className="studio-failure" role="alert">{run.message}</p>}
      {result && (
        <details className="studio-cypher">
          <summary className="desk-text-small desk-text-muted">The Cypher loadAll runs</summary>
          <pre>{result.cypher.statement}</pre>
          {Object.keys(result.cypher.parameters).length > 0 && <pre>{JSON.stringify(result.cypher.parameters, null, 2)}</pre>}
          <Button size="small" onClick={() => openInCypher(result.cypher.statement, result.cypher.parameters)}>Open in Cypher</Button>
        </details>
      )}
      <div className="studio-result">
        {result && result.graph.nodes.length > 0 && <GraphView graph={result.graph} fragments={fragments} onSelect={setSelection} />}
        {result && result.graph.nodes.length === 0 && (
          <div className="studio-hint">
            <h2>Nothing matched</h2>
            <p>No {subjectName(subject)} satisfies these conditions.</p>
          </div>
        )}
        {selection && <Inspector selection={selection} nodes={result?.graph.nodes ?? []} fragments={fragments} />}
      </div>
    </>
  )
}

function Status({ run, result }: { run: Run; result: Result | null }) {
  if (run.state === 'running') return <Spinner label="Loading" size="small" />
  if (!result) return null
  const { nodes, edges } = result.graph
  return (
    <span className="desk-text-small desk-text-muted" role="status">
      {result.count} loaded · {nodes.length} {nodes.length === 1 ? 'node' : 'nodes'} · {edges.length} {edges.length === 1 ? 'relationship' : 'relationships'}
      {result.truncated && ` · stopped at the limit of ${result.limit}`}
    </span>
  )
}

let nextKey = 1

const firstProperty = (scope: Scope): string => scope.properties[0]?.name ?? ''

function Where({ scopes, draft, onChange }: { scopes: Scope[]; draft: QueryDraft; onChange: (draft: QueryDraft) => void }) {
  const root = scopes[0]
  if (!root) return null
  const change = (key: number, patch: Partial<ConditionDraft>) =>
    onChange({ ...draft, conditions: draft.conditions.map(c => (c.key === key ? { ...c, ...patch } : c)) })
  const add = () =>
    onChange({
      ...draft,
      conditions: [...draft.conditions, { key: nextKey++, scope: '', quantifier: 'any', property: firstProperty(root), op: 'EQ', value: '' }],
    })

  return (
    <>
      {draft.conditions.map((row, index) => {
        const scope = scopes.find(s => s.id === row.scope) ?? root
        const property = scope.properties.find(p => p.name === row.property)
        const operators = operatorsFor(property)
        const operator = operators.find(o => o.value === row.op) ?? operators[0]
        return (
          <div className="studio-query-row" key={row.key}>
            <span className="studio-query-word desk-text-small desk-text-muted">{index === 0 ? 'where' : 'and'}</span>
            {scopes.length > 1 && (
              <PopUpButton
                label="On" labelHidden size="small"
                value={row.scope}
                onChange={id => {
                  const next = scopes.find(s => s.id === id) ?? root
                  change(row.key, { scope: id, property: firstProperty(next), op: 'EQ', value: '' })
                }}
                options={scopes.map(s => ({ value: s.id, label: s.label }))}
              />
            )}
            {row.scope !== '' && (
              <PopUpButton
                label="How many" labelHidden size="small"
                value={row.quantifier}
                onChange={quantifier => change(row.key, { quantifier })}
                options={[{ value: 'any', label: 'has one whose' }, { value: 'none', label: 'has none whose' }]}
              />
            )}
            <PopUpButton
              label="Property" labelHidden size="small"
              value={row.property}
              onChange={name => change(row.key, { property: name, op: 'EQ' })}
              options={scope.properties.map(p => ({ value: p.name, label: p.name, description: p.type }))}
            />
            <PopUpButton
              label="Comparison" labelHidden size="small"
              value={operator?.value ?? 'EQ'}
              onChange={op => change(row.key, { op })}
              options={operators.map(o => ({ value: o.value, label: o.label }))}
            />
            {operator?.operand !== 'none' && (
              <span className="studio-value">
                <TextField
                  label="Value" labelHidden
                  placeholder={operator?.operand === 'list' ? 'one, two, three' : property?.type ?? ''}
                  value={row.value}
                  onChange={e => change(row.key, { value: e.target.value })}
                />
              </span>
            )}
            <Button
              type="button" intent="quiet" size="small"
              aria-label={`Remove the condition on ${row.property}`}
              onClick={() => onChange({ ...draft, conditions: draft.conditions.filter(c => c.key !== row.key) })}
            >
              Remove
            </Button>
          </div>
        )
      })}
      <div className="studio-query-row">
        <Button type="button" size="small" onClick={add}>Add Condition</Button>
      </div>
    </>
  )
}
