import { Button, Loading, Pane, Section, Sheet, TextField, useDragSource } from '@liberation-data/desk/react'
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { addModelPath, listModelPaths, removeModelPath } from './api'
import type { ModelPath } from './api'
import { useStudio } from './App'
import type { Subject } from './model'
import { subjectKey, subjectName } from './model'

/** The drag type of a view or fragment picked up from the catalogue. */
export const SUBJECT = 'drivine-subject'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function Catalogue() {
  const { catalog, problem, reload, subject, show } = useStudio()
  const source = useDragSource<Subject>({ type: SUBJECT })
  const [choosing, setChoosing] = useState(false)

  const paths = choosing && <ModelPaths onDone={() => { setChoosing(false); reload() }} />

  if (problem) {
    return (
      <div className="studio-hint" role="alert">
        <h2>The catalogue could not be read</h2>
        <p>{problem}</p>
        <Button onClick={reload}>Try again</Button>
      </div>
    )
  }
  if (!catalog) return <Loading label="Reading the catalogue" />

  if (catalog.models.length === 0 && catalog.problems.length === 0) {
    return (
      <div className="studio-hint">
        <h2>No model files yet</h2>
        <p>
          Each Drivine library writes <code>.drivine/model.json</code> beside a module&apos;s build file. Tell the studio
          which folders to look in.
        </p>
        <Button onClick={() => setChoosing(true)}>Choose Folders</Button>
        {paths}
      </div>
    )
  }

  const entry = (item: Subject, detail: string, removed: boolean) => {
    const name = subjectName(item)
    const key = subjectKey(item)
    const current = subject !== null && subjectKey(subject) === key
    return (
      <li key={key}>
        <button
          type="button"
          className="studio-entry"
          data-removed={removed || undefined}
          aria-current={current ? 'true' : undefined}
          title={removed
            ? 'The code no longer declares this, but the store may still hold it. Drag to the canvas, or press to open it there.'
            : 'Drag to the canvas, or press to open it there'}
          {...source.dragProps(item, name)}
          onClick={() => show(item)}
        >
          <span className="studio-entry-name">{name}{removed && <span className="desk-text-caption"> · removed</span>}</span>
          <span className="studio-entry-detail desk-text-caption desk-text-muted">{detail}</span>
        </button>
      </li>
    )
  }

  const modules = [...new Set(catalog.models.map(m => m.module))]
  return (
    <Pane label="Catalogue" padded>
      <div className="studio-query-row">
        <span className="desk-text-small desk-text-muted desk-grow">
          {modules.length === 1 ? modules[0] : `${modules.length} modules`}
        </span>
        <Button size="small" intent="quiet" onClick={() => setChoosing(true)}>Folders</Button>
      </div>
      <Section title={`Views (${catalog.views.length})`}>
        <ul className="studio-entries">
          {catalog.views.map(view =>
            entry({ kind: 'view', view }, [view.root.field, ...view.relationships.map(r => r.field)].join(' · '), !!view.removed),
          )}
        </ul>
      </Section>
      <Section title={`Fragments (${catalog.fragments.length})`}>
        <ul className="studio-entries">
          {catalog.fragments.map(fragment =>
            entry({ kind: 'fragment', fragment }, fragment.labels.map(l => `:${l}`).join(''), !!fragment.removed),
          )}
        </ul>
      </Section>
      {catalog.problems.length > 0 && (
        <Section title={`Could not be read (${catalog.problems.length})`}>
          <ul className="studio-entries">
            {catalog.problems.map((p, i) => (
              <li key={`${p.file}:${i}`} className="studio-problem">
                <span className="studio-entry-name">{p.file}</span>
                <span className="desk-text-caption desk-text-muted">{p.message}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {paths}
    </Pane>
  )
}

/** The folders, or files, the studio looks in for model files. */
function ModelPaths({ onDone }: { onDone: () => void }) {
  const [paths, setPaths] = useState<ModelPath[] | null>(null)
  const [adding, setAdding] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    listModelPaths().then(setPaths, (e: unknown) => setProblem(message(e)))
  }, [])

  const change = (changed: Promise<ModelPath[]>) => {
    setProblem(null)
    changed.then(
      next => {
        setPaths(next)
        setAdding('')
      },
      (e: unknown) => setProblem(message(e)),
    )
  }
  const add = (event?: FormEvent) => {
    event?.preventDefault()
    if (adding.trim() !== '') change(addModelPath(adding))
  }

  return (
    <Sheet
      open
      onDismiss={onDone}
      title="Folders"
      description="The studio looks in each folder, and the folders in it, for .drivine/model.json. A model file may be named itself."
      actions={<Button intent="default" onClick={onDone}>Done</Button>}
    >
      <div className="studio-form">
        {!paths && !problem && <Loading label="Reading the folders" />}
        {paths && paths.length === 0 && <p className="desk-text-small desk-text-muted">None yet.</p>}
        {paths && paths.length > 0 && (
          <ul className="studio-entries">
            {paths.map(p => (
              <li key={p.path} className="studio-connection">
                <span className="studio-connection-text">
                  <span className="studio-entry-name">{p.path}</span>
                  {p.source === 'environment' && <span className="desk-text-caption desk-text-muted">from DRIVINE_STUDIO_MODELS</span>}
                </span>
                {p.source === 'studio' && (
                  <Button size="small" intent="quiet" onClick={() => change(removeModelPath(p.path))}>Remove</Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <form className="studio-query-row" onSubmit={add} aria-label="Add a folder">
          <span className="desk-grow">
            <TextField label="Folder or model file" labelHidden placeholder="/path/to/project" value={adding} onChange={e => setAdding(e.target.value)} />
          </span>
          <Button type="submit" size="small" disabled={adding.trim() === ''}>Add</Button>
        </form>
        {problem && <p className="studio-bad desk-text-small" role="alert">{problem}</p>}
      </div>
    </Sheet>
  )
}
