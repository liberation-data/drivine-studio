import { Button, Loading, Pane, Section, useDragSource } from '@liberation-data/desk/react'
import { useStudio } from './App'
import type { Subject } from './model'
import { subjectName } from './model'

/** The drag type of a view or fragment picked up from the catalogue. */
export const SUBJECT = 'drivine-subject'

export function Catalogue() {
  const { catalog, problem, reload, subject, show } = useStudio()
  const source = useDragSource<Subject>({ type: SUBJECT })

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

  const entry = (item: Subject, detail: string) => {
    const name = subjectName(item)
    const current = subject !== null && subjectName(subject) === name && subject.kind === item.kind
    return (
      <li key={`${item.kind}:${name}`}>
        <button
          type="button"
          className="studio-entry"
          aria-current={current ? 'true' : undefined}
          title="Drag to the canvas, or press to open it there"
          {...source.dragProps(item, name)}
          onClick={() => show(item)}
        >
          <span className="studio-entry-name">{name}</span>
          <span className="studio-entry-detail desk-text-caption desk-text-muted">{detail}</span>
        </button>
      </li>
    )
  }

  return (
    <Pane label="Catalogue" padded>
      <Section title={`Views (${catalog.views.length})`}>
        <ul className="studio-entries">
          {catalog.views.map(view =>
            entry(
              { kind: 'view', view },
              [view.root.field, ...view.relationships.map(r => r.field)].join(' · '),
            ),
          )}
        </ul>
      </Section>
      <Section title={`Fragments (${catalog.fragments.length})`}>
        <ul className="studio-entries">
          {catalog.fragments.map(fragment => entry({ kind: 'fragment', fragment }, fragment.labels.map(l => `:${l}`).join('')))}
        </ul>
      </Section>
      {catalog.problems.length > 0 && (
        <Section title={`Could not be read (${catalog.problems.length})`}>
          <ul className="studio-entries">
            {catalog.problems.map(p => (
              <li key={p.className} className="studio-problem">
                <span className="studio-entry-name">{p.className.split('.').pop()}</span>
                <span className="desk-text-caption desk-text-muted">{p.message}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </Pane>
  )
}
