import { Button, Chip, Loading, SegmentedControl, Table, Tabs, TextField } from '@liberation-data/desk/react'
import type { Column } from '@liberation-data/desk/react'
import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useStudio } from './App'
import { RUNS_CYPHER } from './database'
import type { StudioConnection } from './database'
import { byLabel, changeOnlyByName, changeWord, chooseIcon, explainIcons, iconLists, onIconsChanged, refound, refoundAll } from './icons'
import type { Explained, IconLists } from './icons'
import { Icon, IconPicker, IconSheet } from './IconPicker'
import { useOnline } from './online'
import { useSchemas } from './schema'
import type { GraphSchema } from './schema'

/*
 * The labels' icons, in Settings: every label the studio can see, with its icon and why it has it, to change one with
 * a click; the person's own common words and icons taken only by name, beside the built-in ones; and a field to try a
 * label in, to see what it would get. Icons are the studio's, by label, never a connection's.
 */

type View = 'labels' | 'words' | 'onlyByName' | 'try'
const VIEW = 'drivine-studio.settings.icons'
const VIEWS: readonly View[] = ['labels', 'words', 'onlyByName', 'try']
const rememberedView = (): View => {
  try {
    const kept = window.localStorage.getItem(VIEW) as View | null
    return kept && VIEWS.includes(kept) ? kept : 'labels'
  } catch {
    return 'labels'
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** How many labels are explained at once: as many as the server takes. */
const MOST = 500

/** A label the studio can see, and the connections whose graphs have it: none for one known only by its chosen icon. */
export interface SeenLabel {
  label: string
  connections: string[]
}

/**
 * The labels to show: those in the graphs of the connections that are up, and those with a chosen icon, each once,
 * in order of name, with the names of the connections that have it.
 */
export function labelsOf(
  connections: readonly StudioConnection[],
  schemas: Readonly<Record<string, GraphSchema>>,
  chosen: Readonly<Record<string, unknown>>,
): SeenLabel[] {
  const seen = new Map<string, string[]>()
  for (const c of connections) for (const label of schemas[c.id]?.labels ?? []) seen.set(label, [...(seen.get(label) ?? []), c.name])
  for (const label of Object.keys(chosen)) if (!seen.has(label)) seen.set(label, [])
  return [...seen].map(([label, names]) => ({ label, connections: names })).sort((a, b) => a.label.localeCompare(b.label))
}

/** Why a label has the icon it has, in a few words: as LabelIcon's sources say, with the word or score behind it. */
export function reason(found: Explained, nearest: number): string {
  if (found.source === 'chosen') return found.icon ? 'Chosen' : 'Chosen to have none'
  if (found.source === 'common') return found.own ? `Your word “${found.word}”` : `Common word “${found.word}”`
  if (found.source === 'nearest') return `Model, ${score(found.score)}`
  if (found.score !== undefined) return `None: nearest ${score(found.score)}, under ${score(nearest)}`
  return found.picks.length ? 'None' : 'None: no model yet, or no word in the label'
}

const score = (n: number | undefined) => (n === undefined ? '' : n.toFixed(2))

/** Settings' Icons section: the labels' icons, the person's own lists, and a label to try, each a tab. */
export function IconSettings() {
  const [view, setView] = useState<View>(rememberedView)
  const [lists, setLists] = useState<IconLists | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  // Counts the changes, so what is shown is found again after one.
  const [changes, setChanges] = useState(0)

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW, view)
    } catch {
      // Labels each time, then.
    }
  }, [view])

  useEffect(() => {
    // A read that works clears what one that failed before it said.
    iconLists().then(now => {
      setLists(now)
      setProblem(null)
    }, (e: unknown) => setProblem(message(e)))
  }, [changes])

  // An icon chosen anywhere else, as in a graph's legend while Settings is open, is shown here too.
  useEffect(() => onIconsChanged(() => setChanges(n => n + 1)), [])

  // A change of a list changes the icons of labels anywhere in the studio, so every one shown is found again.
  const changedLists = (now: IconLists) => {
    setProblem(null)
    setLists(now)
    refoundAll()
    setChanges(n => n + 1)
  }
  const failed = (e: unknown) => setProblem(message(e))

  if (!lists) return problem ? <div className="studio-hint" role="alert"><p>{problem}</p></div> : <Loading label="Reading the icons" />

  return (
    <div className="studio-icon-settings">
      <Tabs
        label="Icons"
        value={view}
        onChange={setView}
        className="studio-tabs"
        tabs={[
          { value: 'labels', label: 'Labels' },
          { value: 'words', label: 'Common Words', badge: Object.keys(lists.words).length || undefined },
          { value: 'onlyByName', label: 'Only by Name', badge: lists.onlyByName.length || undefined },
          { value: 'try', label: 'Try a Label' },
        ]}
      >
        {view === 'labels' && <Labels lists={lists} changes={changes} onChanged={() => setChanges(n => n + 1)} />}
        {view === 'words' && <Words lists={lists} onChanged={changedLists} onFailed={failed} />}
        {view === 'onlyByName' && <OnlyByName lists={lists} onChanged={changedLists} onFailed={failed} />}
        {view === 'try' && <TryLabel lists={lists} changes={changes} onChanged={() => setChanges(n => n + 1)} onWords={() => setView('words')} />}
      </Tabs>
      {problem && <p className="studio-bad desk-text-small studio-finder-problem" role="alert">{problem}</p>}
    </div>
  )
}

interface Row extends SeenLabel {
  found: Explained | undefined
}

/** The labels the search finds, of all the studio sees: every one when there is no search. */
export function matchesOf(seen: readonly SeenLabel[], find: string): readonly SeenLabel[] {
  const words = find.trim().toLowerCase()
  return words ? seen.filter(it => it.label.toLowerCase().includes(words)) : seen
}

/** The first MOST of the labels the search finds: the ones shown and explained. */
export const shownOf = (seen: readonly SeenLabel[], find: string): SeenLabel[] => matchesOf(seen, find).slice(0, MOST)

/** The labels explained, and since which change. */
export interface ExplainedSince {
  changes: number
  found: Record<string, Explained>
}

/**
 * What is explained once an answer asked for at a change arrives: added to what was explained since the same change,
 * in place of what was explained before it, and dropped when what is explained is newer, as an answer that arrives
 * late from before a change is out of date.
 */
export function explainedWith(was: ExplainedSince | null, changes: number, answer: Readonly<Record<string, Explained>>): ExplainedSince {
  if (was && was.changes > changes) return was
  return { changes, found: byLabel([...Object.entries(was?.changes === changes ? was.found : {}), ...Object.entries(answer)]) }
}

/** The labels shown that aren't explained since the last change, to ask for: every one shown after a change. */
export function askingOf(shown: readonly SeenLabel[], explained: ExplainedSince | null, changes: number): string[] {
  const current = explained?.changes === changes ? explained.found : null
  return shown.map(it => it.label).filter(it => !current || !Object.hasOwn(current, it))
}

/**
 * The rows of the Labels table: the labels shown, as `shownOf` gives them, so a search finds a label past the first
 * MOST too, each with its icon found, and only those without an icon when `only` is `none`.
 */
export function rowsOf(seen: readonly SeenLabel[], found: Readonly<Record<string, Explained>> | null, find: string, only: 'all' | 'none'): Row[] {
  return shownOf(seen, find)
    .map(it => ({ ...it, found: found?.[it.label] }))
    .filter(it => only === 'all' || it.found?.icon === null)
}

/** Every label the studio can see, with its icon and why; a label with none has the model's nearest beside it. */
function Labels({ lists, changes, onChanged }: { lists: IconLists; changes: number; onChanged: () => void }) {
  const { connections } = useStudio()
  const graphs = useMemo(() => (connections ?? []).filter(c => RUNS_CYPHER.includes(c.type)), [connections])
  const up = useOnline(graphs.map(c => c.id))
  const running = useMemo(() => graphs.filter(c => up[c.id] === true), [graphs, up])
  const schemas = useSchemas(running.map(c => c.id))
  const seen = useMemo(() => labelsOf(running, schemas, lists.chosen), [running, schemas, lists.chosen])
  const [problem, setProblem] = useState<string | null>(null)
  const [find, setFind] = useState('')
  const [only, setOnly] = useState<'all' | 'none'>('all')
  const [choosing, setChoosing] = useState<string | null>(null)

  // Only the labels shown and not explained since the last change are asked for: a search asks for a few at most.
  // What was explained before the change is shown until the answer comes, so the table stays where it was.
  const [explained, setExplained] = useState<ExplainedSince | null>(null)
  const shown = shownOf(seen, find)
  const key = askingOf(shown, explained, changes).join('\n')
  useEffect(() => {
    if (!key) return
    const controller = new AbortController()
    explainIcons(key.split('\n'), undefined, controller.signal).then(
      answer => {
        setExplained(was => explainedWith(was, changes, answer))
        setProblem(null)
      },
      (e: unknown) => controller.signal.aborted || setProblem(message(e)),
    )
    return () => controller.abort()
  }, [key, changes])
  const found = explained?.found ?? null

  const choose = (label: string, icon: string) => {
    chooseIcon(label, icon).then(now => {
      refound(label, now)
      onChanged()
    }, (e: unknown) => setProblem(message(e)))
  }

  const rows = rowsOf(seen, found, find, only)
  // Of the labels shown, as those are the ones explained.
  const without = shown.filter(it => found?.[it.label]?.icon === null).length
  const matches = matchesOf(seen, find).length

  const columns: Column<Row>[] = [
    { key: 'icon', header: '', width: '44px', render: row => (row.found?.icon ? <Icon name={row.found.icon} size="small" /> : <span className="desk-text-muted">–</span>) },
    {
      key: 'label', header: 'Label', render: row => (
        <span className="studio-label-cell">
          <span>{row.label}</span>
          <span className="desk-text-caption desk-text-muted">{row.connections.length ? row.connections.join(', ') : 'In no graph up now'}</span>
        </span>
      ),
    },
    { key: 'name', header: 'Icon', render: row => <span className={row.found?.icon ? 'desk-text-small' : 'desk-text-small desk-text-muted'}>{row.found?.icon ?? (row.found ? 'none' : '')}</span> },
    { key: 'why', header: 'Why', render: row => <span className="desk-text-small desk-text-muted">{row.found ? reason(row.found, lists.nearest) : ''}</span> },
    {
      key: 'picks', header: 'Nearest', render: row => (row.found?.icon === null && row.found.picks.length ? (
        <span className="studio-picks">
          {row.found.picks.map(pick => (
            <button
              key={pick.icon}
              type="button"
              className="studio-icon-choice studio-pick"
              title={`Choose ${pick.icon} (${score(pick.score)}) for ${row.label}`}
              aria-label={`Choose ${pick.icon} for ${row.label}`}
              onClick={event => {
                event.stopPropagation()
                choose(row.label, pick.icon)
              }}
            >
              <Icon name={pick.icon} size="small" />
            </button>
          ))}
        </span>
      ) : null),
    },
    {
      key: 'change', header: '', align: 'end', render: row => (
        <Button size="small" onClick={() => setChoosing(row.label)}>Choose…</Button>
      ),
    },
  ]

  return (
    <div className="studio-finder">
      <div className="studio-finder-bar">
        <span className="desk-text-small desk-text-muted">
          {seen.length} {seen.length === 1 ? 'label' : 'labels'}
          {found ? ` · ${without} without an icon` : ''}
          {running.length < graphs.length ? ` · ${running.length} of ${graphs.length} connections up` : ''}
        </span>
        <span className="desk-grow" />
        <span className="studio-find">
          <TextField label="Find" labelHidden placeholder="Find a label" value={find} onChange={e => setFind(e.target.value)} />
        </span>
        <SegmentedControl label="Show" size="small" value={only} onChange={setOnly} options={[{ value: 'all', label: 'All' }, { value: 'none', label: 'No Icon' }]} />
      </div>
      <div className="studio-rows">
        {/* Nothing is asked for when no label is shown, so the table says so rather than waiting. */}
        {!found && key && !problem ? <Loading label="Finding the icons" /> : (
          <Table
            label="Labels"
            rows={rows}
            rowId={row => row.label}
            columns={columns}
            onActivate={id => setChoosing(id)}
            empty={
              seen.length === 0
                ? 'No labels yet: none of the connections up has any, and no icon has been chosen.'
                : 'No label matches.'
            }
          />
        )}
      </div>
      {matches > MOST && <p className="desk-text-small desk-text-muted studio-finder-problem">The first {MOST} labels, of {matches}, by name: search to find the others.</p>}
      {problem && <p className="studio-bad desk-text-small studio-finder-problem" role="alert">{problem}</p>}
      {choosing && (
        <IconPicker
          label={choosing}
          current={found?.[choosing]}
          onDone={() => {
            setChoosing(null)
            onChanged()
          }}
        />
      )}
    </div>
  )
}

/** The person's own common words, to add to and take from, beside the built-in ones, which are shown only. */
function Words({ lists, onChanged, onFailed }: { lists: IconLists; onChanged: (now: IconLists) => void; onFailed: (e: unknown) => void }) {
  const [word, setWord] = useState('')
  const [icon, setIcon] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const own = Object.entries(lists.words).sort(([a], [b]) => a.localeCompare(b))
  const builtIn = Object.entries(lists.builtIn.words).sort(([a], [b]) => a.localeCompare(b))

  const add = (event: FormEvent) => {
    event.preventDefault()
    if (!word.trim() || !icon) return
    changeWord(word, icon).then(now => {
      setWord('')
      setIcon(null)
      onChanged(now)
    }, onFailed)
  }

  return (
    <div className="studio-settings-page">
      <p className="desk-text-small desk-text-muted studio-settings-lead">
        A label gets the icon of a word in its name: <code>GithubPerson</code> gets the icon for <code>person</code>. The
        whole name is tried first, then each word from the end. Your words come before the built-in ones, so one of yours
        can change the icon a built-in word gives.
      </p>
      <section className="studio-settings-group" aria-label="Your words">
        <h3 className="desk-text-small studio-settings-heading">Your words</h3>
        <form className="studio-word-add" onSubmit={add} aria-label="Add a word">
          <TextField label="Word" labelHidden placeholder="A word, such as Probe" value={word} onChange={e => setWord(e.target.value)} />
          <Button onClick={() => setPicking(true)} title="Choose the word's icon">
            {icon ? <span className="studio-file-name"><Icon name={icon} size="small" />{icon}</span> : 'Icon…'}
          </Button>
          <Button type="submit" intent="default" disabled={!word.trim() || !icon}>Add</Button>
        </form>
        {own.length === 0 ? (
          <p className="desk-text-small desk-text-muted">None yet.</p>
        ) : (
          <ul className="studio-word-list" aria-label="Your words">
            {own.map(([w, i]) => (
              <li key={w}>
                <Chip onRemove={() => changeWord(w, undefined).then(onChanged, onFailed)} removeLabel={`Take ${w} off your words`}>
                  <span className="studio-file-name"><Icon name={i} size="small" />{w}</span>
                </Chip>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="studio-settings-group" aria-label="Built-in words">
        <h3 className="desk-text-small studio-settings-heading">Built-in words</h3>
        <ul className="studio-word-list" aria-label="Built-in words">
          {builtIn.map(([w, i]) => (
            <li key={w} className="studio-word" data-overridden={Object.hasOwn(lists.words, w) || undefined} title={Object.hasOwn(lists.words, w) ? 'Yours is taken instead' : i}>
              <Icon name={i} size="small" />
              <span className="desk-text-small">{w}</span>
            </li>
          ))}
        </ul>
      </section>
      {picking && (
        <IconSheet
          title={word.trim() ? `Icon of ${word.trim()}` : 'Icon of the word'}
          current={icon}
          onChoose={chosen => {
            setIcon(chosen)
            setPicking(false)
          }}
          onDone={() => setPicking(false)}
        />
      )}
    </div>
  )
}

/** The person's own icons taken only by name, to add to and take from, beside the built-in ones, which are shown only. */
function OnlyByName({ lists, onChanged, onFailed }: { lists: IconLists; onChanged: (now: IconLists) => void; onFailed: (e: unknown) => void }) {
  const [picking, setPicking] = useState(false)
  return (
    <div className="studio-settings-page">
      <p className="desk-text-small desk-text-muted studio-settings-lead">
        The model sometimes gives a label an icon of something it&apos;s only related to, such as a cigarette for Patient or
        a rat for Disease. An icon on this list is only used when the label names it, as <code>Cigarette</code> does.
        Other labels get the next nearest icon instead. Add an icon here when a label gets it wrongly.
      </p>
      <section className="studio-settings-group" aria-label="Your icons">
        <h3 className="desk-text-small studio-settings-heading">Your icons</h3>
        <div>
          <Button onClick={() => setPicking(true)}>Add Icon…</Button>
        </div>
        {lists.onlyByName.length === 0 ? (
          <p className="desk-text-small desk-text-muted">None yet.</p>
        ) : (
          <ul className="studio-word-list" aria-label="Your icons taken only by name">
            {lists.onlyByName.map(name => (
              <li key={name}>
                <Chip onRemove={() => changeOnlyByName(name, false).then(onChanged, onFailed)} removeLabel={`Take ${name} off the list`}>
                  <span className="studio-file-name"><Icon name={name} size="small" />{name}</span>
                </Chip>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="studio-settings-group" aria-label="Built-in icons">
        <h3 className="desk-text-small studio-settings-heading">Built-in icons</h3>
        <ul className="studio-word-list" aria-label="Built-in icons taken only by name">
          {lists.builtIn.onlyByName.map(name => (
            <li key={name} className="studio-word">
              <Icon name={name} size="small" />
              <span className="desk-text-small">{name}</span>
            </li>
          ))}
        </ul>
      </section>
      {picking && (
        <IconSheet
          title="Take an icon only by name"
          description="The model gives it only to a label that names it."
          current={null}
          onChoose={name => {
            setPicking(false)
            changeOnlyByName(name, true).then(onChanged, onFailed)
          }}
          onDone={() => setPicking(false)}
        />
      )}
    </div>
  )
}

/** How long typing rests before the label typed is tried: a model is asked for each try. */
const REST_MS = 250

/** A label typed, and the icon it would get and why, with the model's nearest icons and how near each is. */
function TryLabel({ lists, changes, onChanged, onWords }: { lists: IconLists; changes: number; onChanged: () => void; onWords: () => void }) {
  const [label, setLabel] = useState('')
  const [found, setFound] = useState<{ label: string; found: Explained } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [choosing, setChoosing] = useState(false)
  const typed = label.trim()

  useEffect(() => {
    if (!typed) return setFound(null)
    const controller = new AbortController()
    const timer = setTimeout(() => {
      explainIcons([typed], undefined, controller.signal).then(
        answer => {
          setFound(answer[typed] ? { label: typed, found: answer[typed] } : null)
          setProblem(null)
        },
        (e: unknown) => controller.signal.aborted || setProblem(message(e)),
      )
    }, REST_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [typed, changes])

  const shown = found && found.label === typed ? found.found : null

  return (
    <div className="studio-settings-page">
      <p className="desk-text-small desk-text-muted studio-settings-lead">
        Type a label to see the icon it would get, and why: the one you chose,{' '}
        <button type="button" className="studio-inline-link" onClick={onWords}>a common word</button>, or the model&apos;s
        nearest match, if it scores {score(lists.nearest)} or more.
      </p>
      <div className="studio-try-field">
        <TextField label="Label" placeholder="A label, such as SpaceProbe" value={label} autoFocus onChange={e => setLabel(e.target.value)} />
      </div>
      {shown && (
        <div className="studio-try">
          <div className="studio-try-result">
            <span className="studio-try-icon">{shown.icon ? <Icon name={shown.icon} size="large" /> : <span className="desk-text-muted">–</span>}</span>
            <span className="studio-label-cell">
              <strong>{shown.icon ?? 'No icon'}</strong>
              <span className="desk-text-small desk-text-muted">{reason(shown, lists.nearest)}</span>
            </span>
            <span className="desk-grow" />
            <Button size="small" onClick={() => setChoosing(true)}>Choose…</Button>
          </div>
          {shown.picks.length > 0 && (
            <>
              <h3 className="desk-text-small studio-settings-heading">The model&apos;s nearest</h3>
              <ol className="studio-try-picks" aria-label="The model's nearest icons">
                {shown.picks.map(pick => (
                  <li key={pick.icon}>
                    <Icon name={pick.icon} size="small" />
                    <span className="desk-text-small">{pick.icon}</span>
                    <span className="studio-try-bar" aria-hidden="true">
                      <span style={{ width: `${Math.max(0, Math.min(1, pick.score)) * 100}%` }} data-near={pick.score >= lists.nearest || undefined} />
                    </span>
                    <span className="desk-text-small desk-text-muted studio-try-score">{score(pick.score)}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
      {problem && <p className="studio-bad desk-text-small" role="alert">{problem}</p>}
      {choosing && shown && (
        <IconPicker
          label={typed}
          current={shown}
          onDone={() => {
            setChoosing(false)
            onChanged()
          }}
        />
      )}
    </div>
  )
}
