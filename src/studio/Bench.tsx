import { Button, Loading, PopUpButton, Sheet, Split, TextField } from '@liberation-data/desk/react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import type { BenchSet, EngineResults, Outcome } from '../server/bench'
import { json, read } from './fetching'
import { folderPicker } from './nativeMenu'

/*
 * Graph Bench's results, read and compared: the ones it publishes, and a linked checkout's own runs. A report gives,
 * for each workload, each engine's middle and slow times, the best of them picked out, and whether every engine gave
 * the same answer; compared with another set, each figure says how much faster or slower it is than the other's, so a
 * release that made something slower shows.
 */

const API = '/api/bench'
const listSets = (): Promise<{ sets: BenchSet[]; links: string[] }> => fetch(API, { cache: 'no-store' }).then(r => read(r))
const resultsOf = (s: BenchSet, scale: number): Promise<EngineResults[]> =>
  fetch(`${API}/results?${new URLSearchParams({ source: s.source, set: s.set, scale: String(scale) })}`, { cache: 'no-store' }).then(r => read(r))
const linkBench = (path: string): Promise<string[]> => fetch(`${API}/links`, json('POST', { path })).then(r => read(r))

const keyOf = (s: BenchSet) => `${s.source}|${s.set}`
const nameOf = (s: BenchSet, all: BenchSet[]) => {
  if (s.source === 'published') return 'Published'
  const many = new Set(all.filter(x => x.source !== 'published').map(x => x.source)).size > 1
  const where = many ? `${s.source.split('/').pop()}: ` : ''
  return `${where}${s.set || 'results'}`
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** How much slower (above 1) or faster (below 1) one is than the other, beyond which the change is said: 10%. */
const NOTICE = 0.1

export function Bench() {
  const [sets, setSets] = useState<BenchSet[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const [scale, setScale] = useState<number | null>(null)
  const [against, setAgainst] = useState<string>('')
  const [results, setResults] = useState<EngineResults[] | null>(null)
  const [base, setBase] = useState<EngineResults[] | null>(null)
  const [linking, setLinking] = useState(false)
  const pick = useMemo(folderPicker, [])

  const reload = () => listSets().then(got => setSets(got.sets), (e: unknown) => setProblem(message(e)))
  useEffect(() => void reload(), [])

  const set = sets?.find(s => keyOf(s) === chosen) ?? sets?.[0] ?? null
  const at = scale !== null && set?.scales.includes(scale) ? scale : (set?.scales[0] ?? null)
  const other = sets?.find(s => keyOf(s) === against) ?? null

  useEffect(() => {
    setResults(null)
    if (!set || at === null) return
    resultsOf(set, at).then(setResults, (e: unknown) => setProblem(message(e)))
  }, [set?.source, set?.set, at])
  useEffect(() => {
    setBase(null)
    if (!other || at === null) return
    resultsOf(other, at).then(setBase, () => setBase([]))
  }, [other?.source, other?.set, at])

  const link = () => {
    if (!pick) return setLinking(true)
    pick().then(path => (path ? linkBench(path).then(reload) : undefined)).catch((e: unknown) => setProblem(message(e)))
  }

  if (!sets) return problem ? <div className="studio-hint" role="alert"><p>{problem}</p></div> : <Loading label="Reading the results" />

  const list = (
    <div className="studio-bench-sets">
      <p className="desk-text-small desk-text-muted studio-bench-heading">RESULTS</p>
      <ul className="studio-entries" aria-label="Sets of results">
        {sets.map(s => (
          <li key={keyOf(s)}>
            <button type="button" className="studio-entry studio-connection-entry" aria-current={set && keyOf(s) === keyOf(set) ? 'true' : undefined} onClick={() => setChosen(keyOf(s))}>
              <span className="studio-entry-name">{nameOf(s, sets)}</span>
              <span className="studio-entry-detail desk-text-caption desk-text-muted">
                {s.engines.length} {s.engines.length === 1 ? 'engine' : 'engines'} · scale {s.scales.join(', ')}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <Button size="small" onClick={link}>Link Graph Bench…</Button>
    </div>
  )

  return (
    <>
      <Split side={list} size={240} min={200} remember="drivine-studio.bench" label="Resize the list of results">
        <div className="studio-finder">
          <div className="studio-finder-bar">
            <strong className="desk-text-small">{set ? nameOf(set, sets) : 'No results'}</strong>
            <span className="desk-grow" />
            {set && set.scales.length > 1 && (
              <PopUpButton label="Scale" size="small" value={String(at)} onChange={v => setScale(Number(v))} options={set.scales.map(s => ({ value: String(s), label: `scale ${s}` }))} />
            )}
            <PopUpButton
              label="Compare with" size="small"
              value={against}
              onChange={setAgainst}
              options={[{ value: '', label: 'Compare with nothing' }, ...sets.filter(s => !set || keyOf(s) !== keyOf(set)).map(s => ({ value: keyOf(s), label: `Compare with ${nameOf(s, sets)}` }))]}
            />
          </div>
          <div className="studio-bench-body">
            {!results ? <Loading label="Reading them" /> : <Report results={results} base={other ? base : null} baseName={other ? nameOf(other, sets) : null} />}
          </div>
          {problem && <p className="studio-bad desk-text-small studio-finder-problem" role="alert">{problem}</p>}
        </div>
      </Split>
      {linking && <LinkBench onDone={linked => { setLinking(false); if (linked) void reload() }} />}
    </>
  )
}

/** An engine's colour: its slot in the bench's fixed order, so a colour always means the same engine. */
const SLOT: Record<string, number> = { neo4j: 1, falkordb: 2, oracle: 3, postgres: 4 }
const colourOf = (engine: string) => `var(--bench-${SLOT[engine] ?? 1})`

/** Lucide's trophy, in the colour around it: the winner of a row, and the scoreboard's leader. */
function Trophy({ size, label }: { size: number; label?: string }) {
  return (
    <svg
      className="studio-bench-trophy" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}
    >
      <path d="M10 14.66V17a1 1 0 0 1-1 1 2 2 0 0 0-2 2v2" />
      <path d="M14 14.66V17a1 1 0 0 0 1 1 2 2 0 0 1 2 2v2" />
      <path d="M17.916 10H19.5A2.5 2.5 0 0 0 22 7.5V5a1 1 0 0 0-1-1h-3" />
      <path d="M4 22h16" />
      <path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z" />
      <path d="M6.084 10H4.5A2.5 2.5 0 0 1 2 7.5V5a1 1 0 0 1 1-1h3" />
    </svg>
  )
}

function EngineName({ engine }: { engine: string }) {
  return (
    <span className="studio-bench-engine">
      <span className="studio-bench-chip" style={{ background: colourOf(engine) }} aria-hidden="true" />
      {engine}
    </span>
  )
}

function Report({ results, base, baseName }: { results: EngineResults[]; base: EngineResults[] | null; baseName: string | null }) {
  if (!results.length) return <p className="desk-text-small desk-text-muted">No results at this scale.</p>
  const engines = results.map(r => r.engine)
  // Compared, a run's figures say as much about its machine as its Drivine: both sets' runs are shown, and the machines counted across them.
  const machines = [...new Set([...results, ...(base ?? [])].map(r => r.run?.machine).filter(Boolean))]
  const runRows = [...results.map(r => ({ r, from: null as string | null })), ...(base ?? []).map(r => ({ r, from: baseName }))]
  const keys = [...new Map(results.flatMap(r => r.outcomes.map(o => [`${o.group}|${o.name}`, o] as const))).values()]
  const groups = [...new Set(keys.map(o => o.group))]
  const find = (rs: EngineResults[] | null, engine: string, o: Outcome) =>
    rs?.find(r => r.engine === engine)?.outcomes.find(x => x.group === o.group && x.name === o.name)

  return (
    <div className="studio-bench-report">
      <Scoreboard results={results} keys={keys} find={find} />
      {base && baseName && <p className="desk-text-small">Each figure beside the one in <strong>{baseName}</strong>: green faster, red slower, by more than 10%.</p>}
      <h3>Runs</h3>
      <table className="studio-bench-table">
        <thead><tr><th>engine</th><th>ended</th><th>machine</th><th>image</th><th>Drivine</th><th>bench</th></tr></thead>
        <tbody>
          {runRows.map(({ r, from }) => (
            <tr key={`${from ?? ''}|${r.engine}`}>
              <th><EngineName engine={r.engine} />{from && <span className="desk-text-muted"> · {from}</span>}</th>
              <td>{r.run?.at ? new Date(r.run.at).toLocaleString() : '—'}</td>
              <td>{r.run?.machine ?? '—'}</td>
              <td className="studio-bench-mono">{r.run?.image ?? '—'}</td>
              <td>{r.run?.drivine ?? '—'}</td>
              <td className="studio-bench-mono">{r.run?.bench ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {machines.length > 1 && <p className="desk-text-small studio-warn">These were run on {machines.length} machines: their numbers don’t compare as they would on one.</p>}
      {[...results, ...(base ?? [])].some(r => !r.run) && <p className="desk-text-small desk-text-muted">Some were written before runs kept their details, so what they ran on isn’t known.</p>}

      <h3>Load</h3>
      <table className="studio-bench-table">
        <thead><tr><th />{engines.map(e => <th key={e} className="studio-bench-number"><EngineName engine={e} /></th>)}</tr></thead>
        <tbody>
          <tr><th>nodes</th>{results.map(r => <td key={r.engine} className="studio-bench-number">{r.load ? r.load.nodes.toLocaleString() : '—'}</td>)}</tr>
          <tr><th>relationships</th>{results.map(r => <td key={r.engine} className="studio-bench-number">{r.load ? r.load.edges.toLocaleString() : '—'}</td>)}</tr>
          <tr><th>loading nodes, s</th>{results.map(r => <td key={r.engine} className="studio-bench-number">{r.load ? r.load.nodeSeconds.toFixed(1) : '—'}</td>)}</tr>
          <tr><th>loading relationships, s</th>{results.map(r => <td key={r.engine} className="studio-bench-number">{r.load ? r.load.edgeSeconds.toFixed(1) : '—'}</td>)}</tr>
        </tbody>
      </table>

      {groups.map(group => {
        const concurrent = group.endsWith('threads')
        const rows = keys.filter(o => o.group === group)
        return (
          <Fragment key={group}>
            <h3>{group} <span className="desk-text-small desk-text-muted">{concurrent ? 'calls a second' : 'ms, middle and (slowest 5%)'}</span></h3>
            <table className="studio-bench-table">
              <thead><tr><th>workload</th>{engines.map(e => <th key={e} className="studio-bench-number"><EngineName engine={e} /></th>)}<th>same answer</th></tr></thead>
              <tbody>
                {rows.map(o => {
                  const found = engines.map(e => find(results, e, o))
                  const values = found.map(f => (f ? (concurrent ? f.throughput ?? 0 : f.p50) : null))
                  const present = values.filter((v): v is number => v !== null)
                  const best = present.length > 1 ? (concurrent ? Math.max(...present) : Math.min(...present)) : null
                  // Bars within the row: the longest is the row's most, so the spread between engines shows at a glance.
                  const most = present.length ? Math.max(...present) : 0
                  const digests = found.map(f => f?.digest).filter(Boolean)
                  // One engine has nothing to agree with.
                  const same = digests.length === 0 || found.length < 2 ? '' : digests.length === found.length && new Set(digests).size === 1 ? '✓' : '⚠ differ'
                  return (
                    <tr key={o.name}>
                      <th className="studio-bench-workload">{o.name}</th>
                      {engines.map((e, i) => {
                        const f = found[i]
                        if (!f) return <td key={e} className="studio-bench-number studio-bad">failed</td>
                        const value = values[i]!
                        const was = find(base, e, o)
                        const then = was ? (concurrent ? was.throughput ?? 0 : was.p50) : null
                        // Slower is more time, or fewer calls a second.
                        const ratio = then ? (concurrent ? then / value : value / then) : null
                        const change = ratio !== null && Math.abs(ratio - 1) > NOTICE ? ratio : null
                        return (
                          <td
                            key={e}
                            className="studio-bench-number"
                            data-best={value === best ? '' : undefined}
                            style={{ '--bench-colour': colourOf(e) } as React.CSSProperties}
                            title={concurrent
                              ? `${e}: ${Math.round(value).toLocaleString()} calls a second, middle ${f.p50.toFixed(2)} ms`
                              : `${e}: middle ${f.p50.toFixed(2)} ms, slowest 5% ${f.p95.toFixed(2)} ms, fastest ${f.min.toFixed(2)} ms, over ${f.calls} calls`}
                          >
                            {value === best && <span className="studio-bench-crown"><Trophy size={11} label="best" /> </span>}
                            {concurrent ? `${Math.round(value).toLocaleString()}/s` : <>{value.toFixed(2)} <span className="desk-text-muted">({f.p95.toFixed(2)})</span></>}
                            <span className="studio-bench-bar" aria-hidden="true"><span style={{ width: `${most ? Math.max(4, (value / most) * 100) : 0}%` }} /></span>
                            {change !== null && (
                              <span className={change > 1 ? 'studio-bench-pill studio-bench-pill-bad' : 'studio-bench-pill studio-bench-pill-good'}>
                                {change > 1 ? `▲ ${Math.round((change - 1) * 100)}% slower` : `▼ ${Math.round((1 - change) * 100)}% faster`}
                              </span>
                            )}
                          </td>
                        )
                      })}
                      <td>{same && <span className={same.startsWith('⚠') ? 'studio-bench-pill studio-bench-pill-bad' : 'studio-bench-pill studio-bench-pill-good'}>{same}</span>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Fragment>
        )
      })}
    </div>
  )
}

/** In a browser, which can't say where a folder lives: a Graph Bench checkout's path, pasted, to read its results. */
function LinkBench({ onDone }: { onDone: (linked: boolean) => void }) {
  const [path, setPath] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const link = () => linkBench(path.trim()).then(() => onDone(true), (e: unknown) => setProblem(message(e)))
  return (
    <Sheet
      open
      onDismiss={() => onDone(false)}
      title="Link Graph Bench"
      description="A checkout of Graph Bench on this machine: the studio reads the results its runs write. In the desktop app, Link Graph Bench… opens a folder picker instead."
      actions={<><Button onClick={() => onDone(false)}>Cancel</Button><Button intent="default" onClick={link} disabled={!path.trim()}>Link</Button></>}
    >
      <form onSubmit={event => { event.preventDefault(); link() }}>
        <TextField label="Folder" placeholder="/Users/you/graph-bench" value={path} onChange={e => setPath(e.target.value)} autoFocus />
        {problem && <p className="studio-bad desk-text-small" role="alert">{problem}</p>}
      </form>
    </Sheet>
  )
}

/**
 * The headline: for each engine, how many workloads it was the fastest on, in its colour, and how many answers every
 * engine agreed on. What's under it says how far apart they were.
 */
function Scoreboard({ results, keys, find }: {
  results: EngineResults[]
  keys: Outcome[]
  find: (rs: EngineResults[] | null, engine: string, o: Outcome) => Outcome | undefined
}) {
  if (results.length < 2) return null
  const wins = new Map<string, number>(results.map(r => [r.engine, 0]))
  let agreed = 0
  let compared = 0
  for (const o of keys) {
    const concurrent = o.group.endsWith('threads')
    const values = results.map(r => {
      const f = find(results, r.engine, o)
      return f ? { engine: r.engine, value: concurrent ? f.throughput ?? 0 : f.p50, digest: f.digest } : null
    }).filter((v): v is { engine: string; value: number; digest: string | null } => v !== null)
    if (values.length < 2) continue
    const best = values.reduce((a, b) => (concurrent ? (b.value > a.value ? b : a) : (b.value < a.value ? b : a)))
    wins.set(best.engine, (wins.get(best.engine) ?? 0) + 1)
    const digests = values.map(v => v.digest).filter(Boolean)
    if (digests.length === results.length) {
      compared += 1
      if (new Set(digests).size === 1) agreed += 1
    }
  }
  const leader = Math.max(...wins.values())
  return (
    <div className="studio-bench-scores" role="list" aria-label="Fastest, by engine">
      {results.map(r => (
        <div key={r.engine} className="studio-bench-score" role="listitem" style={{ '--bench-colour': colourOf(r.engine) } as React.CSSProperties} data-leader={wins.get(r.engine) === leader ? '' : undefined}>
          {wins.get(r.engine) === leader && <span className="studio-bench-score-trophy"><Trophy size={28} label="leads" /></span>}
          <span className="studio-bench-score-number">{wins.get(r.engine)}</span>
          <EngineName engine={r.engine} />
          <span className="desk-text-caption desk-text-muted">fastest of {keys.length} workloads</span>
        </div>
      ))}
      {compared > 0 && (
        <div className="studio-bench-score studio-bench-score-agree" role="listitem">
          <span className="studio-bench-score-number">{agreed}<span className="studio-bench-score-of">/{compared}</span></span>
          <span className="studio-bench-engine">{agreed === compared ? '✓ same answers' : '⚠ answers differ'}</span>
          <span className="desk-text-caption desk-text-muted">every engine agreed</span>
        </div>
      )}
    </div>
  )
}
