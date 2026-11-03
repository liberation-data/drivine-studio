import { Alert, Button, Checkbox, CodeBlock, Disclosure, Loading, Pane, PaneHeader, PopUpButton, Split, TextField, Toolbar } from '@liberation-data/desk/react'
import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useStudio } from './App'
import { dockerCommand } from './docker'
import { addConnection, DATABASE_NAMES, DATABASE_TYPES, removeConnection, RUNS_CYPHER, testConnection, updateConnection } from './database'
import type { ConnectionInput, DatabaseType, StudioConnection } from './database'

type Test = { state: 'testing' } | { state: 'passed'; milliseconds: number } | { state: 'failed'; message: string }
/** What the editor shows: a connection, a new one not yet added, or nothing. */
type Chosen = string | 'new' | null

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/*
 * The connections beside the one chosen, in one window: a click on one shows it to edit, with what acts on it (Test,
 * Use) beside it. Long enough to want room of its own, the editor is not a sheet over the list it was chosen from.
 */
export function Connections() {
  const { connections, connectionProblem, reloadConnections, connection: active, chooseConnection } = useStudio()
  const [chosen, setChosen] = useState<Chosen>(() => active?.id ?? null)
  // Where to go once unsaved changes are let go of, while that is being asked.
  const [leaving, setLeaving] = useState<{ to: Chosen } | null>(null)
  const [dirty, setDirty] = useState(false)
  const [removing, setRemoving] = useState<StudioConnection | null>(null)
  const [tests, setTests] = useState<Record<string, Test>>({})
  const [problem, setProblem] = useState<string | null>(null)

  // Something is always shown once there is something to show: the one in use, else the first.
  const shown = chosen === 'new' ? 'new' : (connections?.find(c => c.id === chosen) ?? connections?.find(c => c.id === active?.id) ?? connections?.[0] ?? null)

  const choose = (to: Chosen) => {
    const current = shown === 'new' ? 'new' : (shown?.id ?? null)
    if (to === current) return
    if (dirty) setLeaving({ to })
    else setChosen(to)
  }

  const test = (connection: StudioConnection) => {
    setTests(t => ({ ...t, [connection.id]: { state: 'testing' } }))
    testConnection(connection.id).then(
      ({ milliseconds }) => setTests(t => ({ ...t, [connection.id]: { state: 'passed', milliseconds } })),
      (e: unknown) => setTests(t => ({ ...t, [connection.id]: { state: 'failed', message: message(e) } })),
    )
  }

  const remove = (connection: StudioConnection) => {
    setRemoving(null)
    removeConnection(connection.id).then(() => {
      setDirty(false)
      setChosen(null)
      reloadConnections()
    }, (e: unknown) => setProblem(message(e)))
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

  const list = (
    <Pane
      label="Connections"
      padded
      footer={
        <Toolbar label="Connection controls">
          <Button size="small" onClick={() => choose('new')} title="Add a connection">+</Button>
          <Button
            size="small"
            onClick={() => shown && shown !== 'new' && setRemoving(shown)}
            disabled={!shown || shown === 'new' || shown.source !== 'studio'}
            title="Remove the connection"
          >
            −
          </Button>
        </Toolbar>
      }
    >
      {connections.length === 0 && shown !== 'new' && (
        <p className="desk-text-small desk-text-muted">
          None yet. Add one, or start the studio with Drivine&apos;s DATABASE_TYPE, DATABASE_HOST and the rest set.
        </p>
      )}
      <ul className="studio-entries" aria-label="Connections">
        {connections.map(c => (
          <li key={c.id}>
            <button
              type="button"
              className="studio-entry studio-connection-entry"
              aria-current={shown !== 'new' && shown?.id === c.id ? 'true' : undefined}
              onClick={() => choose(c.id)}
            >
              <span className="studio-entry-name">
                {c.name}
                {active?.id === c.id && <span className="studio-tag">In use</span>}
              </span>
              <span className="studio-entry-detail desk-text-caption desk-text-muted">
                {DATABASE_NAMES[c.type]} · {c.host}{c.port ? `:${c.port}` : ''}
              </span>
              {c.allowWrites && <span className="desk-text-caption studio-warn">Allows writes</span>}
            </button>
          </li>
        ))}
        {shown === 'new' && (
          <li>
            <button type="button" className="studio-entry" aria-current="true">
              <span className="studio-entry-name">New Connection</span>
            </button>
          </li>
        )}
      </ul>
      {problem && <p className="studio-bad desk-text-small" role="alert">{problem}</p>}
    </Pane>
  )

  return (
    <>
      <Split side={list} size={260} min={200} remember="drivine-studio.connections" label="Resize the list of connections">
        {shown ? (
          <ConnectionEditor
            // A different connection is a fresh draft.
            key={shown === 'new' ? 'new' : shown.id}
            editing={shown}
            inUse={shown !== 'new' && active?.id === shown.id}
            test={shown === 'new' ? undefined : tests[shown.id]}
            onTest={test}
            onUse={id => chooseConnection(id)}
            onDirty={setDirty}
            onSaved={saved => {
              setDirty(false)
              // A test of the settings it had says nothing of the ones it has now.
              setTests(({ [saved.id]: _, ...rest }) => rest)
              setChosen(saved.id)
              reloadConnections()
              // The first connection there is, is the one to use.
              if (!active) chooseConnection(saved.id)
            }}
            onCancelNew={() => {
              setDirty(false)
              setChosen(null)
            }}
          />
        ) : (
          <div className="studio-hint">
            <h2>No connections</h2>
            <p>Add the database the studio is to read: Neo4j, Memgraph, FalkorDB, Neptune, Postgres or Oracle.</p>
            <Button onClick={() => choose('new')}>Add Connection</Button>
          </div>
        )}
      </Split>
      <Alert
        open={leaving !== null}
        title="Discard your changes?"
        message="The changes to this connection have not been saved."
        confirmLabel="Discard Changes"
        destructive
        onConfirm={() => {
          setDirty(false)
          setChosen(leaving?.to ?? null)
          setLeaving(null)
        }}
        onCancel={() => setLeaving(null)}
      />
      <Alert
        open={removing !== null}
        title={`Remove ${removing?.name ?? 'the connection'}?`}
        message="The studio forgets the connection and its password. The database is not touched."
        confirmLabel="Remove"
        destructive
        onConfirm={() => removing && remove(removing)}
        onCancel={() => setRemoving(null)}
      />
    </>
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
  allowWrites: boolean
}

const draftOf = (editing: StudioConnection | 'new'): Draft =>
  editing === 'new'
    ? { name: '', type: 'NEO4J', host: 'localhost', port: '', user: '', password: '', clearPassword: false, database: '', graph: '', allowWrites: false }
    : {
        name: editing.name, type: editing.type, host: editing.host, port: editing.port ? String(editing.port) : '',
        user: editing.user ?? '', password: '', clearPassword: false, database: editing.database ?? '', graph: editing.graph ?? '',
        allowWrites: editing.allowWrites === true,
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
    ...(draft.graph && (draft.type === 'ORACLE' || draft.type === 'POSTGRES') ? { graph: draft.graph } : {}),
    ...(draft.allowWrites ? { allowWrites: true } : {}),
  }
}

interface EditorProps {
  readonly editing: StudioConnection | 'new'
  readonly inUse: boolean
  readonly test: Test | undefined
  readonly onTest: (connection: StudioConnection) => void
  readonly onUse: (id: string) => void
  readonly onDirty: (dirty: boolean) => void
  readonly onSaved: (saved: StudioConnection) => void
  readonly onCancelNew: () => void
}

function ConnectionEditor({ editing, inUse, test, onTest, onUse, onDirty, onSaved, onCancelNew }: EditorProps) {
  const initial = useMemo(() => draftOf(editing), [editing])
  const [draft, setDraft] = useState<Draft>(initial)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const set = (patch: Partial<Draft>) => setDraft(d => ({ ...d, ...patch }))
  const field = DATABASE_FIELD[draft.type]
  const isNew = editing === 'new'
  const hadPassword = !isNew && editing.hasPassword
  // One from the environment is the studio's to read, not to change: it is set where the studio was started.
  const fixed = !isNew && editing.source === 'environment'
  const changed = JSON.stringify(draft) !== JSON.stringify(initial)

  useEffect(() => onDirty(changed), [changed, onDirty])

  const save = (event?: FormEvent) => {
    event?.preventDefault()
    if (fixed) return
    setSaving(true)
    setProblem(null)
    const input = inputOf(draft)
    const saved = isNew ? addConnection(input) : updateConnection(editing.id, input)
    saved.then(onSaved, (e: unknown) => {
      setSaving(false)
      setProblem(message(e))
    })
  }

  const revert = () => {
    if (isNew) return onCancelNew()
    setDraft(initial)
    setProblem(null)
  }

  const header = (
    <PaneHeader
      title={isNew ? 'New Connection' : editing.name}
      actions={
        isNew ? undefined : (
          <>
            {RUNS_CYPHER.includes(editing.type) && (
              <Button
                size="small"
                onClick={() => onTest(editing)}
                disabled={test?.state === 'testing' || changed}
                title={changed ? 'Save first: a test tries the saved settings' : undefined}
              >
                Test
              </Button>
            )}
            <Button size="small" onClick={() => onUse(editing.id)} disabled={inUse}>{inUse ? 'In Use' : 'Use'}</Button>
          </>
        )
      }
    />
  )

  const footer = fixed ? undefined : (
    <Toolbar
      label="Save or revert"
      trailing={
        <>
          <Button onClick={revert} disabled={!isNew && !changed}>{isNew ? 'Cancel' : 'Revert'}</Button>
          <Button intent="default" onClick={() => save()} disabled={saving || (!isNew && !changed)}>{isNew ? 'Add' : 'Save'}</Button>
        </>
      }
    >
      <span className="desk-text-caption desk-text-muted desk-grow">Kept in connections.json in the studio&apos;s home, readable by you alone.</span>
    </Toolbar>
  )

  return (
    <Pane header={header} footer={footer} padded label={isNew ? 'New Connection' : editing.name}>
      {test && (
        <p className={`desk-text-small ${test.state === 'failed' ? 'studio-bad' : 'desk-text-muted'}`} role="status">
          {test.state === 'testing' && 'Testing…'}
          {test.state === 'passed' && `Connected in ${test.milliseconds} ms.`}
          {test.state === 'failed' && test.message}
        </p>
      )}
      {fixed && (
        <p className="desk-text-small desk-text-muted">
          From the environment the studio was started in, by Drivine&apos;s DATABASE_TYPE, DATABASE_HOST and the rest. Change
          those, and start the studio again, to change it.
        </p>
      )}
      <form className="studio-fields" onSubmit={save} aria-label="Connection">
        <fieldset disabled={fixed}>
          <TextField label="Name" value={draft.name} onChange={e => set({ name: e.target.value })} autoFocus={isNew} />
          <PopUpButton
            label="Type"
            value={draft.type}
            onChange={type => set({ type })}
            disabled={fixed}
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
          {hadPassword && !draft.password && !fixed && (
            <div className="studio-wide">
              <Checkbox label="Forget the password" checked={draft.clearPassword} onChange={clearPassword => set({ clearPassword })} />
            </div>
          )}
          {field && <TextField label={field.label} help={field.help} value={draft.database} onChange={e => set({ database: e.target.value })} />}
          {(draft.type === 'ORACLE' || draft.type === 'POSTGRES') && (
            <TextField label="Graph" help="Its tables are graph_node and graph_edge: drivine when empty." value={draft.graph} onChange={e => set({ graph: e.target.value })} />
          )}
          <div className="studio-wide">
            <Checkbox
              label="Allow writes"
              description={
                draft.type === 'ORACLE' || draft.type === 'POSTGRES'
                  ? 'From the Cypher window only, compiled to SQL by Drivine. Off, each statement runs read-only and is rolled back.'
                  : 'From the Cypher window only. Off, each statement runs where it cannot write. The Canvas only ever reads.'
              }
              checked={draft.allowWrites}
              onChange={allowWrites => set({ allowWrites })}
            />
          </div>
          {draft.allowWrites && (
            <p className="studio-wide studio-warn desk-text-small" role="note">
              Statements run in the Cypher window on this connection will change the database. Each is committed as it runs, and
              there is no undo.
            </p>
          )}
        </fieldset>
        {problem && <p className="studio-bad desk-text-small" role="alert">{problem}</p>}
        {/* Enter submits from any field. */}
        <button type="submit" hidden />
      </form>
      {!fixed && (
        <RunInDocker draft={draft} onFill={fill => set(Object.fromEntries(Object.entries(fill).filter(([key]) => !draft[key as keyof Draft])))} />
      )}
    </Pane>
  )
}

/**
 * No database yet: the command that runs one of this kind here, in Docker, as Drivine's own tests do, to copy into a
 * terminal. The studio does not run it; what it starts is the person's to see first.
 */
function RunInDocker({ draft, onFill }: { draft: Draft; onFill: (fill: Partial<Draft>) => void }) {
  const [open, setOpen] = useState(false)
  const made = dockerCommand(draft)
  return (
    <Disclosure label="Run it in Docker" open={open} onOpenChange={setOpen}>
      {made.kind === 'none' ? (
        <p className="desk-text-small desk-text-muted">{made.why}</p>
      ) : (
        <div className="studio-form">
          <p className="desk-text-small desk-text-muted">
            No {DATABASE_NAMES[draft.type]} to connect to? This runs one here, as Drivine&apos;s own tests do. Paste it into a terminal.
          </p>
          <CodeBlock code={made.command} language="shell" />
          {made.note && <p className="desk-text-small desk-text-muted">{made.note}</p>}
          <div>
            <Button size="small" onClick={() => onFill(made.fill)}>Use These Settings</Button>
          </div>
        </div>
      )}
    </Disclosure>
  )
}
