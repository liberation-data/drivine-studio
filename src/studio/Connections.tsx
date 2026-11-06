import {
  Alert, Button, Checkbox, CodeBlock, Disclosure, Led, Loading, menuAction, menuSeparator, Pane, PaneHeader, PopUpButton, Sheet, Spinner, Split, TextField,
  Toolbar, useContextMenu,
} from '@liberation-data/desk/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useStudio } from './App'
import { dockerCommand, fillFor, foundName, listed, sameKind } from './docker'
import type { DockerStatus } from './docker'
import { addConnection, DATABASE_NAMES, DATABASE_TYPES, dockerAction, dockerStatus, freeDockerPort, removeConnection, RUNS_CYPHER, testConnection, updateConnection } from './database'
import type { ConnectionInput, DatabaseType, StudioConnection } from './database'
import { useOnline } from './online'

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
  // A lamp beside each that can be tried: up, or not running.
  const up = useOnline((connections ?? []).filter(c => RUNS_CYPHER.includes(c.type)).map(c => c.id))
  const [chosen, setChosen] = useState<Chosen>(() => active?.id ?? null)
  // Where to go once unsaved changes are let go of, while that is being asked.
  const [leaving, setLeaving] = useState<{ to: Chosen } | null>(null)
  const [dirty, setDirty] = useState(false)
  const [removing, setRemoving] = useState<StudioConnection | null>(null)
  // A database to make in Docker: asked for in a sheet, then the connection made for it, started as it opens.
  const [makingInDocker, setMakingInDocker] = useState(false)
  const [startFor, setStartFor] = useState<string | null>(null)
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
          <Button size="small" onClick={() => setMakingInDocker(true)} title="Run a new database in Docker, and connect to it">New in Docker…</Button>
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
          <ConnectionEntry
            key={c.id}
            connection={c}
            online={RUNS_CYPHER.includes(c.type) ? up[c.id] : undefined}
            chosen={shown !== 'new' && shown?.id === c.id}
            inUse={active?.id === c.id}
            test={tests[c.id]}
            onChoose={() => choose(c.id)}
            onUse={() => chooseConnection(c.id)}
            onTest={() => test(c)}
            onRemove={() => setRemoving(c)}
          />
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
      <Split side={list} size={260} min={230} remember="drivine-studio.connections" label="Resize the list of connections">
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
            startDocker={shown !== 'new' && shown.id === startFor}
            onDockerStarted={() => setStartFor(null)}
          />
        ) : (
          <div className="studio-hint">
            <h2>No connections</h2>
            <p>Add the database the studio is to read: Neo4j, Memgraph, FalkorDB, Neptune, Postgres, Oracle or a SQLite file.</p>
            <Button onClick={() => choose('new')}>Add Connection</Button>
          </div>
        )}
      </Split>
      {makingInDocker && (
        <NewInDocker
          taken={(connections ?? []).map(c => c.name)}
          onCancel={() => setMakingInDocker(false)}
          onMade={saved => {
            setMakingInDocker(false)
            setDirty(false)
            setChosen(saved.id)
            setStartFor(saved.id)
            reloadConnections()
            if (!active) chooseConnection(saved.id)
          }}
        />
      )}
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

/** What a driver says when nothing listens where a connection points: Neo4j's, Postgres's and Node's own words for it. */
const UNREACHABLE = /ECONNREFUSED|connection refused|Failed to connect to server|ServiceUnavailable|connect ECONN/i

/** What the database field is, for each kind of database. */
const DATABASE_FIELD: Record<DatabaseType, { label: string; help: string } | null> = {
  NEO4J: { label: 'Database', help: 'The server\'s default database when empty.' },
  MEMGRAPH: null,
  NEPTUNE: null,
  FALKORDB: { label: 'Graph', help: 'The graph to query: graph when empty.' },
  POSTGRES: { label: 'Database', help: 'The Postgres database to connect to, which can hold several graphs. Required.' },
  ORACLE: { label: 'Service name', help: 'Required, such as FREEPDB1.' },
  SQLITE: { label: 'File', help: 'The SQLite file an application using Drivine keeps its graph in. The studio never makes one.' },
}

/** The types whose graph names its tables, which the Graph field names: Drivine's SQL stores. */
const GRAPH_TYPES: readonly DatabaseType[] = ['POSTGRES', 'ORACLE', 'SQLITE']

/** What the Graph field of Postgres, Oracle and SQLite is, with the tables the graph named has: drivine's when it is empty, as the server trims it. */
export const graphHelp = (graph: string): string => {
  const name = graph.trim() || 'drivine'
  return `The graph within the database, kept in its own tables: here ${name}_node and ${name}_edge. drivine when empty.`
}

const DEFAULT_PORTS: Record<DatabaseType, string> = {
  NEO4J: '7687', MEMGRAPH: '7687', NEPTUNE: '8182', FALKORDB: '6379', POSTGRES: '5432', ORACLE: '1521', SQLITE: '',
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

/**
 * The draft as the server takes it. An empty field is left out, so the server's defaults apply. A SQLite file has no
 * host, port, user or password, so none is sent, even one typed while the draft was another type.
 */
export function inputOf(draft: Draft): ConnectionInput {
  const port = Number.parseInt(draft.port, 10)
  if (draft.type === 'SQLITE') {
    return {
      name: draft.name,
      type: draft.type,
      host: '',
      ...(draft.database ? { database: draft.database } : {}),
      ...(draft.graph ? { graph: draft.graph } : {}),
      ...(draft.allowWrites ? { allowWrites: true } : {}),
    }
  }
  return {
    name: draft.name,
    type: draft.type,
    host: draft.host,
    ...(Number.isFinite(port) ? { port } : {}),
    ...(draft.user ? { user: draft.user } : {}),
    ...(draft.password ? { password: draft.password } : {}),
    ...(draft.clearPassword && !draft.password ? { clearPassword: true } : {}),
    ...(draft.database && DATABASE_FIELD[draft.type] ? { database: draft.database } : {}),
    ...(draft.graph && GRAPH_TYPES.includes(draft.type) ? { graph: draft.graph } : {}),
    ...(draft.allowWrites ? { allowWrites: true } : {}),
  }
}

/** How the last test went, after a connection's name: a tick and how long it took, or a cross. */
function TestMark({ test }: { test: Test }) {
  if (test.state === 'testing') return <span className="studio-test desk-text-small desk-text-muted" role="status">Testing…</span>
  return test.state === 'passed' ? (
    <span className="studio-test desk-text-small" role="status" aria-label={`Connected in ${test.milliseconds} ms`}>
      <span className="studio-test-passed" aria-hidden="true">✓</span>
      <span className="desk-text-muted">({test.milliseconds} ms)</span>
    </span>
  ) : (
    // Why, in full, is under the title: a driver's reason runs to sentences.
    <span className="studio-test desk-text-small" role="status" aria-label="Failed to connect">
      <span className="studio-bad" aria-hidden="true">✕</span>
      <span className="desk-text-muted">(failed)</span>
    </span>
  )
}

interface EntryProps {
  readonly connection: StudioConnection
  readonly chosen: boolean
  readonly inUse: boolean
  readonly test: Test | undefined
  /** Whether it answers, tried every few seconds: undefined while first tried, or where it can't be. */
  readonly online: boolean | undefined
  readonly onChoose: () => void
  readonly onUse: () => void
  readonly onTest: () => void
  readonly onRemove: () => void
}

/** A connection in the list: a click shows it, a double-click uses it, and its menu holds what can be done to it. */
function ConnectionEntry({ connection: c, chosen, inUse, test, online, onChoose, onUse, onTest, onRemove }: EntryProps) {
  const { target, menu } = useContextMenu({
    label: `Actions for ${c.name}`,
    items: () => [
      menuAction('Use', onUse, { disabled: inUse }),
      ...(RUNS_CYPHER.includes(c.type) ? [menuAction('Test', onTest, { disabled: test?.state === 'testing' })] : []),
      ...(c.source === 'studio' ? [menuSeparator(), menuAction('Remove…', onRemove)] : []),
    ],
  })
  return (
    <li>
      <button
        type="button"
        className="studio-entry studio-connection-entry"
        aria-current={chosen ? 'true' : undefined}
        onClick={onChoose}
        onDoubleClick={onUse}
        {...target}
      >
        <span className="studio-entry-name">
          <Led color={online === undefined ? 'off' : online ? 'green' : 'red'} label={online === undefined ? undefined : online ? 'Up' : 'Not running'} />
          {c.name}
          {test && test.state !== 'testing' && (
            <span className={test.state === 'passed' ? 'studio-test-passed' : 'studio-bad'} aria-label={test.state === 'passed' ? 'Connected' : 'Failed'}>
              {test.state === 'passed' ? '✓' : '✕'}
            </span>
          )}
          {inUse && <span className="studio-tag">In use</span>}
          {c.allowWrites && <span className="studio-tag studio-tag-warn">Writes allowed</span>}
        </span>
        <span className="studio-entry-detail desk-text-caption desk-text-muted">
          {DATABASE_NAMES[c.type]} · {c.type === 'SQLITE' ? c.database : <>{c.host}{c.port ? `:${c.port}` : ''}</>}
        </span>
      </button>
      {menu}
    </li>
  )
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
  /** Made by New in Docker: its container is started as it opens. */
  readonly startDocker?: boolean
  readonly onDockerStarted?: () => void
}

function ConnectionEditor({ editing, inUse, test, onTest, onUse, onDirty, onSaved, onCancelNew, startDocker, onDockerStarted }: EditorProps) {
  const initial = useMemo(() => draftOf(editing), [editing])
  const [draft, setDraft] = useState<Draft>(initial)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const set = (patch: Partial<Draft>) => setDraft(d => ({ ...d, ...patch }))
  const field = DATABASE_FIELD[draft.type]
  // A file has no host, port, user or password.
  const file = draft.type === 'SQLITE'
  const isNew = editing === 'new'
  const hadPassword = !isNew && editing.hasPassword
  // One from the environment is the studio's to read, not to change: it is set where the studio was started.
  const fixed = !isNew && editing.source === 'environment'
  const changed = JSON.stringify(draft) !== JSON.stringify(initial)
  const [dockerAsk, setDockerAsk] = useState(0)
  useEffect(() => {
    if (!startDocker) return
    setDockerAsk(n => n + 1)
    onDockerStarted?.()
  }, [startDocker, onDockerStarted])

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
      title={isNew ? 'New Connection' : <>{editing.name}{test && <TestMark test={test} />}</>}
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
      {/* The mark by the title says how it went; why one failed is worth its own lines. */}
      {test?.state === 'failed' && (
        <div className="studio-test-failed">
          <p className="desk-text-small studio-bad" role="alert">{test.message}</p>
          {/* Nothing listening, on a host Docker can run it on: the moment to offer one. */}
          {UNREACHABLE.test(test.message) && dockerCommand(draft).kind === 'command' && (
            <Button size="small" onClick={() => setDockerAsk(n => n + 1)}>Start It in Docker</Button>
          )}
        </div>
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
          {!file && <TextField label="Host" value={draft.host} onChange={e => set({ host: e.target.value })} />}
          {!file && (
            <TextField label="Port" type="number" min={1} max={65535} value={draft.port} placeholder={DEFAULT_PORTS[draft.type]} onChange={e => set({ port: e.target.value })} />
          )}
          {draft.type !== 'NEPTUNE' && !file && <TextField label="User" value={draft.user} autoComplete="off" onChange={e => set({ user: e.target.value })} />}
          {draft.type !== 'NEPTUNE' && !file && (
            <TextField
              label="Password" type="password" autoComplete="new-password"
              value={draft.password}
              placeholder={hadPassword && !draft.clearPassword ? 'Unchanged' : ''}
              onChange={e => set({ password: e.target.value })}
            />
          )}
          {hadPassword && !draft.password && !fixed && !file && (
            <div className="studio-wide">
              <Checkbox label="Forget the password" checked={draft.clearPassword} onChange={clearPassword => set({ clearPassword })} />
            </div>
          )}
          {field && <TextField label={field.label} help={field.help} value={draft.database} onChange={e => set({ database: e.target.value })} />}
          {GRAPH_TYPES.includes(draft.type) && (
            <TextField label="Graph" help={graphHelp(draft.graph)} value={draft.graph} onChange={e => set({ graph: e.target.value })} />
          )}
          <div className="studio-wide">
            <Checkbox
              label="Allow writes"
              description={
                file
                  ? 'From the Cypher window only, compiled to SQL by Drivine. Off, each statement runs on the file opened read-only.'
                  : GRAPH_TYPES.includes(draft.type)
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
      {/* A file is not a server: there is nothing to run in Docker. */}
      {!fixed && !file && (
        <RunInDocker draft={draft} connectionId={isNew ? undefined : editing.id} passwordKept={hadPassword && !draft.clearPassword} onFill={set} ask={dockerAsk} />
      )}
    </Pane>
  )
}

/**
 * No database yet: one of this kind, run here in Docker as Drivine's own tests run it. The studio starts it, as Neo4j
 * Desktop does, and fills in the connection once it answers; or the command is there to paste into a terminal.
 */
function RunInDocker({ draft, connectionId, passwordKept, onFill, ask }: {
  draft: Draft
  connectionId: string | undefined
  passwordKept: boolean
  onFill: (fill: Partial<Draft>) => void
  /** Raised to open this and start the container: a test that found nothing listening offers it. */
  ask: number
}) {
  const [open, setOpen] = useState(false)
  const section = useRef<HTMLDivElement>(null)
  const [here, setHere] = useState<DockerStatus | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const made = dockerCommand(draft)
  const fill = made.kind === 'command' ? fillFor(made.fill, draft, passwordKept) : {}
  const names: Record<string, string> = { port: 'Port', user: 'User', password: 'Password', database: DATABASE_FIELD[draft.type]?.label ?? 'Database' }
  const filled = Object.keys(fill).map(key => names[key] ?? key)
  // The password the studio keeps is never in the page: Start uses it on the server, and the command says where it goes.
  const shown = passwordKept && !draft.password ? dockerCommand({ ...draft, password: 'YOUR-PASSWORD' }) : made
  const job = here?.job ?? null
  const busy = job !== null && job.state !== 'ready' && job.state !== 'failed'
  const name = made.kind === 'command' ? made.run.name : ''

  // Read while it is open, and again every second and a half while a start is under way.
  const refresh = useCallback(() => {
    dockerStatus(draft).then(setHere, (e: unknown) => setProblem(message(e)))
  }, [draft.type, draft.host, draft.port])
  useEffect(() => {
    if (open && made.kind === 'command') refresh()
  }, [open, made.kind, refresh])
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(refresh, 1500)
    return () => clearInterval(timer)
  }, [busy, refresh])

  // Once it answers, the connection is set to match it: only what is empty, as Fill In does.
  const filledFor = useRef<number | null>(null)
  useEffect(() => {
    if (job?.state === 'ready' && filledFor.current !== job.started) {
      filledFor.current = job.started
      onFill(fill)
    }
  }, [job, fill, onFill])

  const act = (action: 'start' | 'stop' | 'remove') => {
    setProblem(null)
    setRemoving(false)
    dockerAction(action, draft, connectionId).then(refresh, (e: unknown) => {
      setProblem(message(e))
      refresh()
    })
  }

  const asked = useRef(ask)
  useEffect(() => {
    if (ask === asked.current) return
    asked.current = ask
    setOpen(true)
    section.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    act('start')
  }, [ask]) // act reads the draft as it is when asked

  const container = here?.container
  const ours = container !== undefined && container.kind !== 'missing' && container.ours
  const taken = here?.port.kind === 'taken' ? here.port : null
  // What is on the port is this kind of database already: there is nothing to start.
  const already = taken !== null && sameKind(taken.runs, draft.type)
  const portNumber = draft.port || (made.kind === 'command' ? String(made.run.port) : '')
  const holder = taken?.by ? `, in ${taken.by}` : ''
  const startable = container !== undefined && (container.kind === 'missing' || (container.kind === 'stopped' && ours))
  return (
    <div ref={section}>
    <Disclosure label="Run it in Docker" open={open} onOpenChange={setOpen}>
      {made.kind === 'none' ? (
        <p className="desk-text-small desk-text-muted">{made.why}</p>
      ) : (
        <div className="studio-form">
          <p className="desk-text-small desk-text-muted">
            No {DATABASE_NAMES[draft.type]} to connect to? The studio can run one here in Docker, as Drivine&apos;s own tests do.
          </p>
          {here?.docker.kind === 'absent' && <p className="desk-text-small studio-warn" role="note">{here.docker.why}</p>}
          {here?.docker.kind === 'ready' && container && (
            <div className="studio-docker">
              <span className="desk-text-small" role="status">
                {container.kind === 'missing' && !already && <>{name} is not made yet.</>}
                {container.kind === 'running' && <>{name} is running{container.port ? ` on port ${container.port}` : ''}.</>}
                {container.kind === 'stopped' && <>{name} is stopped. Its data is kept.</>}
                {container.kind !== 'missing' && !container.ours && ' The studio did not make it, so leaves it alone.'}
              </span>
              <span className="desk-grow" />
              {startable && !already && (
                <Button intent="default" onClick={() => act('start')} disabled={busy || taken !== null}>
                  Start {DATABASE_NAMES[draft.type]} in Docker
                </Button>
              )}
              {container.kind === 'running' && ours && <Button size="small" onClick={() => act('stop')} disabled={busy}>Stop</Button>}
              {ours && <Button size="small" intent="quiet" onClick={() => setRemoving(true)} disabled={busy}>Remove…</Button>}
            </div>
          )}
          {taken && startable && !busy && (
            already ? (
              <p className="desk-text-small studio-ok" role="note">
                {foundName(taken.runs!)} is already running on port {portNumber}{holder}. There&apos;s nothing to start: Test the connection to use it.
              </p>
            ) : taken.runs ? (
              <p className="desk-text-small studio-warn" role="note">
                Port {portNumber} is in use by {foundName(taken.runs)}{holder}, not {DATABASE_NAMES[draft.type]}. Choose another port to start{' '}
                {DATABASE_NAMES[draft.type]} here.
              </p>
            ) : (
              <p className="desk-text-small studio-warn" role="note">
                Port {portNumber} is in use by {taken.by ?? 'something else on this machine'}. Choose another port to start one here, or Test
                the connection: a database may be there already.
              </p>
            )
          )}
          {job && (
            <p className={`desk-text-small ${job.state === 'failed' ? 'studio-bad' : 'desk-text-muted'} studio-docker-job`} role={job.state === 'failed' ? 'alert' : 'status'}>
              {busy && <Spinner label="Working" size="small" />}
              {job.state === 'failed' ? job.error : job.state === 'ready' ? `Ready: it answered in ${Math.round((job.milliseconds ?? 0) / 1000)} s.` : job.detail}
            </p>
          )}
          {problem && <p className="desk-text-small studio-bad" role="alert">{problem}</p>}
          {made.note && <p className="desk-text-small desk-text-muted">{made.note}</p>}
          <p className="desk-text-small desk-text-muted">
            Or run it yourself, in a terminal{shown !== made ? ', with the connection’s password for YOUR-PASSWORD' : ''}:
          </p>
          {shown.kind === 'command' && <CodeBlock code={shown.command} language="shell" />}
          {/* Only what is empty, and said: a button that changed fields it did not name would be a surprise. */}
          {filled.length > 0 && (
            <div>
              <Button size="small" onClick={() => onFill(fill)}>Fill In {listed(filled)}</Button>
            </div>
          )}
          <Alert
            open={removing}
            title={`Remove ${name}?`}
            message="Docker removes the container and the data in it. The connection stays."
            confirmLabel="Remove"
            destructive
            onConfirm={() => act('remove')}
            onCancel={() => setRemoving(false)}
          />
        </div>
      )}
    </Disclosure>
    </div>
  )
}

/** The kinds of database Docker runs here: all but Neptune, which runs on AWS only, and SQLite, a file. */
const IN_DOCKER = DATABASE_TYPES.filter(type => type !== 'NEPTUNE' && type !== 'SQLITE')

/**
 * A new database, run in Docker: which kind, under what name, on which port. The connection is made with the settings
 * the container is made with (Drivine's tests' own), and its container started as it opens, so the person picks a kind
 * and has a database to read.
 */
function NewInDocker({ taken, onMade, onCancel }: { taken: string[]; onMade: (saved: StudioConnection) => void; onCancel: () => void }) {
  const [type, setType] = useState<DatabaseType>('NEO4J')
  const named = (t: DatabaseType) => {
    const base = `${DATABASE_NAMES[t]} in Docker`
    let name = base
    for (let n = 2; taken.includes(name); n++) name = `${base} ${n}`
    return name
  }
  const [name, setName] = useState(() => named('NEO4J'))
  const [nameEdited, setNameEdited] = useState(false)
  const [port, setPort] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!nameEdited) setName(named(type))
    setPort('')
    freeDockerPort(type).then(p => setPort(String(p)), () => setPort(DEFAULT_PORTS[type]))
  }, [type])

  const made = dockerCommand({ type, host: 'localhost', port, user: '', password: '', database: '' })
  const fill = made.kind === 'command' ? made.fill : {}
  const settings = [fill.user && `user ${fill.user}`, fill.password && `password ${fill.password}`, fill.database && `database ${fill.database}`].filter(Boolean)

  const make = () => {
    if (made.kind !== 'command') return setProblem(made.why)
    setBusy(true)
    setProblem(null)
    const portNumber = Number(port)
    addConnection({
      name: name.trim(),
      type,
      host: 'localhost',
      ...(Number.isFinite(portNumber) && port ? { port: portNumber } : {}),
      ...(fill.user ? { user: fill.user } : {}),
      ...(fill.password ? { password: fill.password } : {}),
      ...(fill.database ? { database: fill.database } : {}),
    }).then(onMade, (e: unknown) => {
      setBusy(false)
      setProblem(message(e))
    })
  }

  return (
    <Sheet
      open
      onDismiss={onCancel}
      title="New Database in Docker"
      description="Runs one here in Docker, as Drivine’s own tests do, and makes a connection to it."
      actions={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button intent="default" onClick={make} disabled={busy || !name.trim() || !port}>Create and Start</Button>
        </>
      }
    >
      <form
        className="studio-form"
        onSubmit={event => {
          event.preventDefault()
          make()
        }}
      >
        <PopUpButton label="Database" value={type} onChange={setType} options={IN_DOCKER.map(t => ({ value: t, label: DATABASE_NAMES[t] }))} />
        <TextField label="Name" value={name} onChange={e => { setName(e.target.value); setNameEdited(true) }} />
        <TextField label="Port" type="number" min={1} max={65535} value={port} help="Its usual port, or the next free one here." onChange={e => setPort(e.target.value)} />
        {settings.length > 0 && <p className="desk-text-small desk-text-muted">The connection is made with Drivine’s test settings: {settings.join(', ')}.</p>}
        {/* Neo4j's note is its user, which the line above already gives. */}
        {made.kind === 'command' && made.note && type !== 'NEO4J' && <p className="desk-text-small desk-text-muted">{made.note}</p>}
        {problem && <p className="studio-bad desk-text-small" role="alert">{problem}</p>}
      </form>
    </Sheet>
  )
}
