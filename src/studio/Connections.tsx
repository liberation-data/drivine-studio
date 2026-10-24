import { Alert, Button, Checkbox, Loading, Pane, PopUpButton, Section, Sheet, TextField } from '@liberation-data/desk/react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { useStudio } from './App'
import { addConnection, DATABASE_NAMES, DATABASE_TYPES, removeConnection, testConnection, updateConnection } from './database'
import type { ConnectionInput, DatabaseType, StudioConnection } from './database'

type Test = { state: 'testing' } | { state: 'passed'; milliseconds: number } | { state: 'failed'; message: string }

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function Connections() {
  const { connections, connectionProblem, reloadConnections, connection: active, chooseConnection } = useStudio()
  const [editing, setEditing] = useState<StudioConnection | 'new' | null>(null)
  const [removing, setRemoving] = useState<StudioConnection | null>(null)
  const [tests, setTests] = useState<Record<string, Test>>({})
  const [problem, setProblem] = useState<string | null>(null)

  const test = (connection: StudioConnection) => {
    setTests(t => ({ ...t, [connection.id]: { state: 'testing' } }))
    testConnection(connection.id).then(
      ({ milliseconds }) => setTests(t => ({ ...t, [connection.id]: { state: 'passed', milliseconds } })),
      (e: unknown) => setTests(t => ({ ...t, [connection.id]: { state: 'failed', message: message(e) } })),
    )
  }

  const remove = (connection: StudioConnection) => {
    setRemoving(null)
    removeConnection(connection.id).then(reloadConnections, (e: unknown) => setProblem(message(e)))
  }

  if (connectionProblem) {
    return (
      <div className="studio-hint" role="alert">
        <h2>The connections could not be read</h2>
        <p>{connectionProblem}</p>
        <Button onClick={reloadConnections}>Try again</Button>
      </div>
    )
  }
  if (!connections) return <Loading label="Reading the connections" />

  return (
    <Pane label="Connections" padded>
      <Section title={`Connections (${connections.length})`}>
        {connections.length === 0 && (
          <p className="desk-text-small desk-text-muted">
            None yet. Add one, or start the studio with Drivine&apos;s DATABASE_TYPE, DATABASE_HOST and the rest set.
          </p>
        )}
        <ul className="studio-entries">
          {connections.map(c => {
            const result = tests[c.id]
            return (
              <li key={c.id} className="studio-connection" aria-current={active?.id === c.id ? 'true' : undefined}>
                <div className="studio-connection-text">
                  <span className="studio-entry-name">{c.name}</span>
                  <span className="desk-text-caption desk-text-muted">
                    {DATABASE_NAMES[c.type]} · {c.host}{c.port ? `:${c.port}` : ''}{c.database ? ` · ${c.database}` : ''}
                    {c.source === 'environment' && ' · from the environment'}
                  </span>
                  {result && (
                    <span className={`desk-text-caption ${result.state === 'failed' ? 'studio-bad' : 'desk-text-muted'}`} role="status">
                      {result.state === 'testing' && 'Testing…'}
                      {result.state === 'passed' && `Connected in ${result.milliseconds} ms`}
                      {result.state === 'failed' && result.message}
                    </span>
                  )}
                </div>
                <div className="studio-connection-actions">
                  {active?.id === c.id
                    ? <span className="desk-text-caption desk-text-muted">In use</span>
                    : <Button size="small" onClick={() => chooseConnection(c.id)}>Use</Button>}
                  <Button size="small" intent="quiet" onClick={() => test(c)} disabled={result?.state === 'testing'}>Test</Button>
                  {c.source === 'studio' && (
                    <>
                      <Button size="small" intent="quiet" onClick={() => setEditing(c)}>Edit</Button>
                      <Button size="small" intent="quiet" onClick={() => setRemoving(c)}>Remove</Button>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
        <div className="studio-query-row">
          <Button size="small" onClick={() => setEditing('new')}>Add Connection</Button>
        </div>
        {problem && <p className="studio-bad desk-text-small" role="alert">{problem}</p>}
      </Section>
      {editing && (
        <ConnectionSheet
          editing={editing}
          onDone={saved => {
            setEditing(null)
            // A test of the settings it had says nothing of the ones it has now.
            if (saved) setTests(({ [saved.id]: _, ...rest }) => rest)
            reloadConnections()
            // The first connection there is, is the one to use.
            if (saved && !active) chooseConnection(saved.id)
          }}
        />
      )}
      <Alert
        open={removing !== null}
        title={`Remove ${removing?.name ?? 'the connection'}?`}
        message="The studio forgets the connection and its password. The database is not touched."
        confirmLabel="Remove"
        destructive
        onConfirm={() => removing && remove(removing)}
        onCancel={() => setRemoving(null)}
      />
    </Pane>
  )
}

/** What the database field is, for each kind of database. */
const DATABASE_FIELD: Record<DatabaseType, { label: string; help: string } | null> = {
  NEO4J: { label: 'Database', help: 'The server\'s default database when empty.' },
  MEMGRAPH: null,
  NEPTUNE: null,
  FALKORDB: { label: 'Graph', help: 'The graph to query: graph when empty.' },
  POSTGRES: { label: 'Database', help: 'Required.' },
  ORACLE: { label: 'Service name', help: 'Required, such as FREEPDB1.' },
}

const DEFAULT_PORTS: Record<DatabaseType, string> = {
  NEO4J: '7687', MEMGRAPH: '7687', NEPTUNE: '8182', FALKORDB: '6379', POSTGRES: '5432', ORACLE: '1521',
}

interface Draft {
  name: string
  type: DatabaseType
  host: string
  port: string
  user: string
  password: string
  clearPassword: boolean
  database: string
  graph: string
}

const draftOf = (editing: StudioConnection | 'new'): Draft =>
  editing === 'new'
    ? { name: '', type: 'NEO4J', host: 'localhost', port: '', user: '', password: '', clearPassword: false, database: '', graph: '' }
    : {
        name: editing.name, type: editing.type, host: editing.host, port: editing.port ? String(editing.port) : '',
        user: editing.user ?? '', password: '', clearPassword: false, database: editing.database ?? '', graph: editing.graph ?? '',
      }

/** The draft as the server takes it. An empty field is left out, so the server's defaults apply. */
export function inputOf(draft: Draft): ConnectionInput {
  const port = Number.parseInt(draft.port, 10)
  return {
    name: draft.name,
    type: draft.type,
    host: draft.host,
    ...(Number.isFinite(port) ? { port } : {}),
    ...(draft.user ? { user: draft.user } : {}),
    ...(draft.password ? { password: draft.password } : {}),
    ...(draft.clearPassword && !draft.password ? { clearPassword: true } : {}),
    ...(draft.database && DATABASE_FIELD[draft.type] ? { database: draft.database } : {}),
    ...(draft.graph && draft.type === 'ORACLE' ? { graph: draft.graph } : {}),
  }
}

function ConnectionSheet({ editing, onDone }: { editing: StudioConnection | 'new'; onDone: (saved: StudioConnection | null) => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(editing))
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const set = (patch: Partial<Draft>) => setDraft(d => ({ ...d, ...patch }))
  const field = DATABASE_FIELD[draft.type]
  const hadPassword = editing !== 'new' && editing.hasPassword

  const save = (event?: FormEvent) => {
    event?.preventDefault()
    setSaving(true)
    setProblem(null)
    const input = inputOf(draft)
    const saved = editing === 'new' ? addConnection(input) : updateConnection(editing.id, input)
    saved.then(onDone, (e: unknown) => {
      setSaving(false)
      setProblem(message(e))
    })
  }

  return (
    <Sheet
      open
      onDismiss={() => onDone(null)}
      title={editing === 'new' ? 'Add Connection' : `Edit ${editing.name}`}
      description="The studio keeps connections in connections.json in its home directory, passwords too, readable by you alone."
      actions={
        <>
          <Button onClick={() => onDone(null)}>Cancel</Button>
          <Button intent="default" onClick={() => save()} disabled={saving}>{editing === 'new' ? 'Add' : 'Save'}</Button>
        </>
      }
    >
      <form className="studio-form" onSubmit={save} aria-label="Connection">
        <TextField label="Name" value={draft.name} onChange={e => set({ name: e.target.value })} autoFocus />
        <PopUpButton
          label="Type"
          value={draft.type}
          onChange={type => set({ type })}
          options={DATABASE_TYPES.map(t => ({ value: t, label: DATABASE_NAMES[t] }))}
        />
        <TextField label="Host" value={draft.host} onChange={e => set({ host: e.target.value })} />
        <TextField label="Port" type="number" min={1} max={65535} value={draft.port} placeholder={DEFAULT_PORTS[draft.type]} onChange={e => set({ port: e.target.value })} />
        {draft.type !== 'NEPTUNE' && <TextField label="User" value={draft.user} autoComplete="off" onChange={e => set({ user: e.target.value })} />}
        {draft.type !== 'NEPTUNE' && (
          <TextField
            label="Password" type="password" autoComplete="new-password"
            value={draft.password}
            placeholder={hadPassword && !draft.clearPassword ? 'Unchanged' : ''}
            onChange={e => set({ password: e.target.value })}
          />
        )}
        {hadPassword && !draft.password && (
          <Checkbox label="Forget the password" checked={draft.clearPassword} onChange={clearPassword => set({ clearPassword })} />
        )}
        {field && <TextField label={field.label} help={field.help} value={draft.database} onChange={e => set({ database: e.target.value })} />}
        {draft.type === 'ORACLE' && (
          <TextField label="Property graph" help="drivine when empty." value={draft.graph} onChange={e => set({ graph: e.target.value })} />
        )}
        {(draft.type === 'ORACLE' || draft.type === 'POSTGRES') && (
          <p className="desk-text-small desk-text-muted">
            The Cypher window runs on Neo4j, Memgraph, Neptune and FalkorDB. Drivine (TypeScript) runs SQL on {DATABASE_NAMES[draft.type]}, not Cypher.
          </p>
        )}
        {problem && <p className="studio-bad desk-text-small" role="alert">{problem}</p>}
        {/* Enter submits from any field. */}
        <button type="submit" hidden />
      </form>
    </Sheet>
  )
}
