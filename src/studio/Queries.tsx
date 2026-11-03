import { Alert, Button, CodeBlock, Loading, menuAction, menuSeparator, Pane, PaneHeader, Split, TextField, useContextMenu } from '@liberation-data/desk/react'
import { useEffect, useMemo, useState } from 'react'
import { useStudio } from './App'
import { firstLine, listQueries, removeQuery } from './savedQueries'
import type { SavedQuery } from './savedQueries'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/*
 * The statements saved from the Cypher window, as a Finder shows files: the list beside the one chosen. A click shows
 * a query, a double-click opens it in Cypher, and its menu holds the rest. Each is a .cypher file in the studio's
 * home, so what is here can be opened in an editor too.
 */
export function Queries() {
  const { openInCypher, queriesChanged, savedQuery } = useStudio()
  const [queries, setQueries] = useState<SavedQuery[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [removing, setRemoving] = useState<SavedQuery | null>(null)

  useEffect(() => {
    listQueries().then(setQueries, (e: unknown) => setProblem(message(e)))
  }, [queriesChanged])

  const shown = useMemo(() => {
    const words = filter.trim().toLowerCase()
    return (queries ?? []).filter(q => !words || q.name.toLowerCase().includes(words) || q.statement.toLowerCase().includes(words))
  }, [queries, filter])
  const query = queries?.find(q => q.id === chosen) ?? shown[0] ?? null

  const open = (q: SavedQuery) => openInCypher(q.statement, q.parameters, { id: q.id, name: q.name })
  const remove = (q: SavedQuery) => {
    setRemoving(null)
    removeQuery(q.id).then(savedQuery, (e: unknown) => setProblem(message(e)))
  }

  if (!queries) return problem ? <div className="studio-hint" role="alert"><p>{problem}</p></div> : <Loading label="Reading the saved queries" />

  const list = (
    <Pane label="Saved queries" padded>
      <TextField label="Find" labelHidden placeholder="Find a query" value={filter} onChange={e => setFilter(e.target.value)} />
      <ul className="studio-entries studio-queries" aria-label="Saved queries">
        {shown.map(q => (
          <QueryEntry key={q.id} query={q} chosen={q.id === query?.id} onChoose={() => setChosen(q.id)} onOpen={() => open(q)} onRemove={() => setRemoving(q)} />
        ))}
      </ul>
      {queries.length > 0 && shown.length === 0 && <p className="desk-text-small desk-text-muted">No query matches.</p>}
      {problem && <p className="studio-bad desk-text-small" role="alert">{problem}</p>}
    </Pane>
  )

  return (
    <>
      <Split side={list} size={260} min={200} remember="drivine-studio.queries" label="Resize the list of queries">
        {query ? (
          <Pane
            padded
            label={query.name}
            header={
              <PaneHeader
                title={query.name}
                actions={
                  <>
                    <Button size="small" intent="quiet" onClick={() => setRemoving(query)}>Delete…</Button>
                    <Button size="small" intent="default" onClick={() => open(query)}>Open in Cypher</Button>
                  </>
                }
              />
            }
          >
            <p className="desk-text-small desk-text-muted">Saved {new Date(query.saved).toLocaleString()}</p>
            <CodeBlock code={query.statement} language="text" />
            {query.parameters.trim() && (
              <>
                <h4 className="studio-queries-heading desk-text-small">Parameters</h4>
                <CodeBlock code={query.parameters} language="json" />
              </>
            )}
          </Pane>
        ) : (
          <div className="studio-hint">
            <h2>No saved queries</h2>
            <p>Save a statement from the Cypher window, with Save or ⌘S, and it is kept here to open again.</p>
          </div>
        )}
      </Split>
      <Alert
        open={removing !== null}
        title={`Delete ${removing?.name ?? 'the query'}?`}
        message="Its file is deleted from the studio's home. A statement already open in Cypher stays there."
        confirmLabel="Delete"
        destructive
        onConfirm={() => removing && remove(removing)}
        onCancel={() => setRemoving(null)}
      />
    </>
  )
}

function QueryEntry({ query, chosen, onChoose, onOpen, onRemove }: {
  query: SavedQuery
  chosen: boolean
  onChoose: () => void
  onOpen: () => void
  onRemove: () => void
}) {
  const { target, menu } = useContextMenu({
    label: `Actions for ${query.name}`,
    items: () => [menuAction('Open in Cypher', onOpen), menuSeparator(), menuAction('Delete…', onRemove)],
  })
  return (
    <li>
      <button
        type="button"
        className="studio-entry studio-connection-entry"
        aria-current={chosen ? 'true' : undefined}
        onClick={onChoose}
        onDoubleClick={onOpen}
        {...target}
      >
        <span className="studio-entry-name">{query.name}</span>
        <span className="studio-entry-detail studio-query-line desk-text-caption desk-text-muted">{firstLine(query.statement)}</span>
      </button>
      {menu}
    </li>
  )
}
