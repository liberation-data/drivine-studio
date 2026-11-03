import { perform } from '@liberation-data/desk'
import { Button, Checkbox, Loading, PopUpButton, SegmentedControl, Sheet, Slider, Spinner, Split, TextField } from '@liberation-data/desk/react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import type { BenchSet, EngineResults, Outcome } from '../server/bench'
import type { RunJob } from '../server/benchRun'
import type { Loaded, LoadBatch, LoadJob } from '../server/benchLoad'
import { Scale } from '../server/benchData'
import { listConnections, DATABASE_NAMES } from './database'
import type { StudioConnection } from './database'
import { listQueries } from './savedQueries'
import type { SavedQuery } from './savedQueries'
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
  if (s.source === 'studio') return s.label
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
  const [view, setView] = useState<'report' | 'scaling'>('report')
  const [against, setAgainst] = useState<string>('')
  const [results, setResults] = useState<EngineResults[] | null>(null)
  const [base, setBase] = useState<EngineResults[] | null>(null)
  const [linking, setLinking] = useState(false)
  const [running, setRunning] = useState(false)
  const [job, setJob] = useState<RunJob | null>(null)
  const [loading, setLoading] = useState(false)
  const [load, setLoad] = useState<LoadBatch | null>(null)
  // A load going on: read how it's getting on every second.
  useEffect(() => {
    if (!load || load.state !== 'running') return
    const timer = setInterval(() => {
      fetch(`${API}/loads/${encodeURIComponent(load.id)}`, { cache: 'no-store' }).then(r => read<LoadBatch>(r)).then(setLoad, () => undefined)
    }, 1000)
    return () => clearInterval(timer)
  }, [load])
  // A run going on: read how it's getting on every second, and show its results when it's done.
  useEffect(() => {
    if (!job || job.state !== 'running') return
    const timer = setInterval(() => {
      fetch(`${API}/runs/${encodeURIComponent(job.id)}`, { cache: 'no-store' }).then(r => read<RunJob>(r)).then(now => {
        setJob(now)
        if (now.state === 'done' && now.set) {
          void reload()
          setChosen(`studio|${now.set}`)
          setView('report')
        }
      }, () => undefined)
    }, 1000)
    return () => clearInterval(timer)
  }, [job])
  const pick = useMemo(folderPicker, [])

  const reload = () => listSets().then(got => setSets(got.sets), (e: unknown) => setProblem(message(e)))
  useEffect(() => void reload(), [])

  const set = sets?.find(s => keyOf(s) === chosen) ?? sets?.[0] ?? null
  const at = scale !== null && set?.scales.includes(scale) ? scale : (set?.scales[0] ?? null)
  const other = sets?.find(s => keyOf(s) === against) ?? null
  const scaling = view === 'scaling' && (set?.scales.length ?? 0) > 1
  // A load or a run going on takes the report's place until it's over.
  const busy = !!load || (!!job && job.state !== 'done')

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
      <Button size="small" intent="default" onClick={() => setRunning(true)}>New Run…</Button>
      <Button size="small" onClick={() => setLoading(true)}>Load Graph Bench Data…</Button>
      <Button size="small" onClick={link}>Link Graph Bench…</Button>
    </div>
  )

  return (
    <>
      <Split side={list} size={240} min={200} remember="drivine-studio.bench" label="Resize the list of results">
        <div className="studio-finder">
          <div className="studio-finder-bar">
            <strong className="desk-text-small">{load ? 'Loading Graph Bench data' : busy && job ? job.name : set ? nameOf(set, sets) : 'No results'}</strong>
            <span className="desk-grow" />
            {/* Run at more than one size, a set can be read across them: how each engine's time grows with the graph. */}
            {!busy && set && set.scales.length > 1 && (
              <SegmentedControl label="View" size="small" value={scaling ? 'scaling' : 'report'} onChange={setView} options={[{ value: 'report', label: 'Report' }, { value: 'scaling', label: 'Scaling' }]} />
            )}
            {!busy && set && set.scales.length > 1 && !scaling && (
              <PopUpButton label="Scale" size="small" value={String(at)} onChange={v => setScale(Number(v))} options={set.scales.map(s => ({ value: String(s), label: `scale ${s}` }))} />
            )}
            {!busy && !scaling && <PopUpButton
              label="Compare with" size="small"
              value={against}
              onChange={setAgainst}
              options={[{ value: '', label: 'Compare with nothing' }, ...sets.filter(s => !set || keyOf(s) !== keyOf(set)).map(s => ({ value: keyOf(s), label: `Compare with ${nameOf(s, sets)}` }))]}
            />}
          </div>
          <div className="studio-bench-body">
            {load ? (
              <LoadProgress batch={load} onClose={() => setLoad(null)} />
            ) : job && job.state !== 'done' ? (
              <RunProgress job={job} onClose={() => setJob(null)} />
            ) : scaling && set ? (
              <Scaling set={set} />
            ) : !results ? <Loading label="Reading them" /> : <Report results={results} base={other ? base : null} baseName={other ? nameOf(other, sets) : null} />}
          </div>
          {problem && <p className="studio-bad desk-text-small studio-finder-problem" role="alert">{problem}</p>}
        </div>
      </Split>
      {running && (
        <NewRun
          onCancel={() => setRunning(false)}
          onStarted={started => {
            setRunning(false)
            setJob(started)
          }}
        />
      )}
      {loading && (
        <LoadData
          onCancel={() => setLoading(false)}
          onStarted={started => {
            setLoading(false)
            setLoad(started)
          }}
        />
      )}
      {linking && <LinkBench onDone={linked => { setLinking(false); if (linked) void reload() }} />}
    </>
  )
}

/** An engine's colour: its slot in the bench's fixed order, so a colour always means the same engine. */
const SLOT: Record<string, number> = { neo4j: 1, falkordb: 2, oracle: 3, postgres: 4, memgraph: 5, neptune: 6 }
/**
 * A run of the studio's own names its engines after its connections; each takes its kind of database's colour, so
 * a Postgres connection is Postgres's yellow as Graph Bench's is. Learnt as results are read.
 */
const typeOf = new Map<string, string>()
const learn = (results: EngineResults[]) => results.forEach(r => r.type && typeOf.set(r.engine, r.type))
const colourOf = (engine: string) => `var(--bench-${SLOT[typeOf.get(engine) ?? engine] ?? 1})`

/** Lucide's trophy, in the colour around it: the scoreboard's leader, and only it. */
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
  learn(results)
  if (base) learn(base)
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

      {results.some(r => r.load) && <>
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
      </>}

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
                            {value === best && <span className="studio-bench-crown" aria-label="best">★ </span>}
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
          <span className="studio-bench-score-number">{wins.get(r.engine)}<span className="studio-bench-score-of">/{keys.length}</span></span>
          <EngineName engine={r.engine} />
          <span className="desk-text-caption desk-text-muted">workloads it was fastest at</span>
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

/** A point of a workload's line: how many nodes the graph had, and the middle time there. */
interface Point { nodes: number; ms: number; p95: number }

/** Where one engine's line drops below another's, between two sizes: estimated on the log–log lines between them. */
export interface Crossover { workload: string; group: string; ahead: string; behind: string; from: number; to: number; at: number }

/** The size of a set's graph at a scale: the load's own count, or Graph Bench's 1,121,500 a scale when it wasn't kept. */
const nodesOf = (r: EngineResults) => r.load?.nodes ?? Math.round(1_121_500 * r.scale)

/**
 * For each workload, where the fastest engine changes as the graph grows: the engine that leads at the larger size,
 * the one it overtakes, the two sizes it happened between, and about where, on straight lines in log–log between them.
 */
export function crossovers(lines: Map<string, Map<string, Point[]>>, workloads: Outcome[]): Crossover[] {
  const found: Crossover[] = []
  for (const w of workloads) {
    const byEngine = lines.get(`${w.group}|${w.name}`)
    if (!byEngine || byEngine.size < 2) continue
    const sizes = [...new Set([...byEngine.values()].flatMap(ps => ps.map(p => p.nodes)))].sort((a, b) => a - b)
    const at = (engine: string, n: number) => byEngine.get(engine)?.find(p => p.nodes === n)?.ms
    const leaderAt = (n: number) =>
      [...byEngine.keys()].map(e => ({ e, ms: at(e, n) })).filter((x): x is { e: string; ms: number } => x.ms !== undefined).sort((a, b) => a.ms - b.ms)[0]?.e
    for (let i = 1; i < sizes.length; i++) {
      const before = leaderAt(sizes[i - 1]!)
      const after = leaderAt(sizes[i]!)
      if (!before || !after || before === after) continue
      const [n0, n1] = [sizes[i - 1]!, sizes[i]!]
      // Where the two lines meet, in log space: the difference of their logs goes from positive to negative.
      const d0 = Math.log(at(after, n0) ?? 1) - Math.log(at(before, n0) ?? 1)
      const d1 = Math.log(at(after, n1) ?? 1) - Math.log(at(before, n1) ?? 1)
      const t = d0 === d1 ? 0.5 : d0 / (d0 - d1)
      const meet = Math.exp(Math.log(n0) + Math.min(1, Math.max(0, t)) * (Math.log(n1) - Math.log(n0)))
      found.push({ workload: w.name, group: w.group, ahead: after, behind: before, from: n0, to: n1, at: meet })
    }
  }
  return found
}

const count = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))

/** A set read across its sizes: a small chart for each workload, its time against the graph's size, and the crossovers. */
function Scaling({ set }: { set: BenchSet }) {
  const [all, setAll] = useState<EngineResults[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    setAll(null)
    Promise.all(set.scales.map(scale => resultsOf(set, scale))).then(got => setAll(got.flat()), (e: unknown) => setProblem(message(e)))
  }, [set])
  const shaped = useMemo(() => {
    if (!all) return null
    const lines = new Map<string, Map<string, Point[]>>()
    const workloads = new Map<string, Outcome>()
    for (const r of all) {
      for (const o of r.outcomes) {
        const key = `${o.group}|${o.name}`
        workloads.set(key, o)
        const byEngine = lines.get(key) ?? new Map<string, Point[]>()
        byEngine.set(r.engine, [...(byEngine.get(r.engine) ?? []), { nodes: nodesOf(r), ms: o.p50, p95: o.p95 }].sort((a, b) => a.nodes - b.nodes))
        lines.set(key, byEngine)
      }
    }
    learn(all)
    const engines = [...new Set(all.map(r => r.engine))].sort((a, b) => (SLOT[typeOf.get(a) ?? a] ?? 9) - (SLOT[typeOf.get(b) ?? b] ?? 9))
    const sizes = [...new Set(all.map(nodesOf))].sort((a, b) => a - b)
    return { lines, workloads: [...workloads.values()], engines, sizes, crossings: crossovers(lines, [...workloads.values()]) }
  }, [all])

  if (problem) return <p className="studio-bad desk-text-small" role="alert">{problem}</p>
  if (!shaped) return <Loading label="Reading every size" />
  const groups = [...new Set(shaped.workloads.map(w => w.group))]
  return (
    <div className="studio-bench-report">
      <div className="studio-bench-legend" aria-label="Engines">
        {shaped.engines.map(e => <EngineName key={e} engine={e} />)}
        <span className="desk-text-small desk-text-muted">· middle time against the graph’s nodes, both on log scales: {shaped.sizes.map(count).join(', ')}</span>
      </div>
      <h3>Crossovers</h3>
      {shaped.crossings.length === 0 ? (
        <p className="desk-text-small desk-text-muted">No engine overtakes another at these sizes: each workload’s fastest stays the fastest.</p>
      ) : (
        <ul className="studio-bench-crossings">
          {shaped.crossings.map(c => (
            <li key={`${c.group}|${c.workload}|${c.from}`}>
              <EngineName engine={c.ahead} /> overtakes <EngineName engine={c.behind} /> at about <strong>{count(c.at)} nodes</strong>
              <span className="desk-text-muted"> (between {count(c.from)} and {count(c.to)})</span> on <em>{c.workload}</em>
            </li>
          ))}
        </ul>
      )}
      {groups.map(group => (
        <Fragment key={group}>
          <h3>{group}</h3>
          <div className="studio-bench-charts">
            {shaped.workloads.filter(w => w.group === group).map(w => (
              <ScalingChart
                key={w.name}
                title={w.name}
                lines={shaped.lines.get(`${w.group}|${w.name}`) ?? new Map()}
                sizes={shaped.sizes}
                crossings={shaped.crossings.filter(c => c.group === w.group && c.workload === w.name)}
              />
            ))}
          </div>
        </Fragment>
      ))}
    </div>
  )
}

/** One workload: a 2px line an engine, markers at each size with the figures on hover, and where the lead changed. */
function ScalingChart({ title, lines, sizes, crossings }: { title: string; lines: Map<string, Point[]>; sizes: number[]; crossings: Crossover[] }) {
  const W = 300
  const H = 160
  const pad = { l: 40, r: 10, t: 8, b: 22 }
  const values = [...lines.values()].flat().map(p => p.ms).filter(v => v > 0)
  if (!values.length || sizes.length < 2) return null
  const lo = Math.log10(Math.min(...values)) - 0.1
  const hi = Math.log10(Math.max(...values)) + 0.1
  const x = (n: number) => pad.l + ((Math.log10(n) - Math.log10(sizes[0]!)) / (Math.log10(sizes[sizes.length - 1]!) - Math.log10(sizes[0]!) || 1)) * (W - pad.l - pad.r)
  const y = (ms: number) => pad.t + (1 - (Math.log10(Math.max(ms, 1e-6)) - lo) / (hi - lo || 1)) * (H - pad.t - pad.b)
  // A gridline at each power of ten in range, labelled.
  const decades: number[] = []
  for (let d = Math.ceil(lo); d <= Math.floor(hi); d++) decades.push(10 ** d)
  return (
    <figure className="studio-bench-chart">
      <figcaption>{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: middle time by graph size`}>
        {decades.map(d => (
          <g key={d}>
            <line x1={pad.l} x2={W - pad.r} y1={y(d)} y2={y(d)} className="studio-bench-grid" />
            <text x={pad.l - 4} y={y(d) + 3} textAnchor="end" className="studio-bench-tick">{d >= 1000 ? `${d / 1000}s` : `${d}ms`}</text>
          </g>
        ))}
        {sizes.map(n => <text key={n} x={x(n)} y={H - 6} textAnchor="middle" className="studio-bench-tick">{count(n)}</text>)}
        {crossings.map(c => <line key={c.from} x1={x(c.at)} x2={x(c.at)} y1={pad.t} y2={H - pad.b} className="studio-bench-cross" style={{ stroke: colourOf(c.ahead) }} />)}
        {[...lines.entries()].map(([engine, points]) => (
          <g key={engine} style={{ color: colourOf(engine) }}>
            <polyline points={points.map(p => `${x(p.nodes)},${y(p.ms)}`).join(' ')} className="studio-bench-line" />
            {points.map(p => (
              <circle key={p.nodes} cx={x(p.nodes)} cy={y(p.ms)} r={4} className="studio-bench-point">
                <title>{`${engine} at ${count(p.nodes)} nodes: middle ${p.ms.toFixed(2)} ms, slowest 5% ${p.p95.toFixed(2)} ms`}</title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
    </figure>
  )
}

/**
 * A bench of your own: saved queries, chosen by folder or one by one, run on the connections chosen, warmed up and
 * then timed. It only reads; the report it makes is kept, to read and compare in Bench beside Graph Bench's.
 */
function NewRun({ onStarted, onCancel }: { onStarted: (job: RunJob) => void; onCancel: () => void }) {
  const [queries, setQueries] = useState<SavedQuery[] | null>(null)
  const [connections, setConnections] = useState<StudioConnection[] | null>(null)
  const [pickedQueries, setPickedQueries] = useState<Set<string>>(new Set())
  const [pickedConnections, setPickedConnections] = useState<Set<string>>(new Set())
  const [name, setName] = useState('')
  const [warmup, setWarmup] = useState('3')
  const [runs, setRuns] = useState('20')
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    listQueries().then(shelf => setQueries(shelf.queries), (e: unknown) => setProblem(message(e)))
    listConnections().then(setConnections, (e: unknown) => setProblem(message(e)))
  }, [])
  const toggle = (set: Set<string>, id: string, on: boolean) => {
    const next = new Set(set)
    if (on) next.add(id)
    else next.delete(id)
    return next
  }
  const folders = [...new Set((queries ?? []).map(q => q.folder))].sort()
  const start = () =>
    fetch(`${API}/runs`, json('POST', { name, connections: [...pickedConnections], queries: [...pickedQueries], warmup: Number(warmup), runs: Number(runs) }))
      .then(r => read<RunJob>(r))
      .then(onStarted, (e: unknown) => setProblem(message(e)))
  return (
    <Sheet
      open
      onDismiss={onCancel}
      title="New Bench Run"
      description="Times saved queries on the connections you choose: a few runs to warm up, then the runs that count. It only reads."
      actions={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button intent="default" onClick={start} disabled={!pickedQueries.size || !pickedConnections.size}>
            Run {pickedQueries.size * pickedConnections.size || ''}
          </Button>
        </>
      }
    >
      <div className="studio-form">
        <TextField label="Name" placeholder="As it's started: the date and time" value={name} onChange={e => setName(e.target.value)} />
        <fieldset className="studio-bench-pick">
          <legend className="desk-text-small">Queries</legend>
          {!queries ? <Loading label="Reading the queries" /> : queries.length === 0 ? (
            <p className="desk-text-small desk-text-muted">No saved queries yet. Save some from Cypher, in a folder such as Bench, and they can be run here.</p>
          ) : folders.map(folder => {
            const inFolder = queries.filter(q => q.folder === folder)
            const all = inFolder.every(q => pickedQueries.has(q.id))
            return (
              <div key={folder || 'top'} className="studio-bench-folder">
                <Checkbox
                  label={folder ? `${folder} (${inFolder.length})` : `Queries (${inFolder.length})`}
                  checked={all}
                  indeterminate={!all && inFolder.some(q => pickedQueries.has(q.id))}
                  onChange={on => setPickedQueries(inFolder.reduce((set, q) => toggle(set, q.id, on), pickedQueries))}
                />
                <div className="studio-bench-folder-items">
                  {inFolder.map(q => (
                    <Checkbox key={q.id} label={q.name} checked={pickedQueries.has(q.id)} onChange={on => setPickedQueries(toggle(pickedQueries, q.id, on))} />
                  ))}
                </div>
              </div>
            )
          })}
        </fieldset>
        <fieldset className="studio-bench-pick">
          <legend className="desk-text-small">Connections</legend>
          {!connections ? <Loading label="Reading the connections" /> : connections.map(c => (
            <Checkbox key={c.id} label={`${c.name} · ${DATABASE_NAMES[c.type]}`} checked={pickedConnections.has(c.id)} onChange={on => setPickedConnections(toggle(pickedConnections, c.id, on))} />
          ))}
        </fieldset>
        <div className="studio-bench-counts">
          <TextField label="Warm-up runs" type="number" min={0} max={100} value={warmup} onChange={e => setWarmup(e.target.value)} />
          <TextField label="Timed runs" type="number" min={1} max={1000} value={runs} onChange={e => setRuns(e.target.value)} />
        </div>
        {problem && <p className="studio-bad desk-text-small" role="alert">{problem}</p>}
      </div>
    </Sheet>
  )
}

/** The scales offered, from a quick look to a graph of millions. */
const SCALES = [0.001, 0.01, 0.1, 1, 3, 10]
const SLOW_SCALE = 0.1

/**
 * Graph Bench's dataset, loaded into a connection that allows writes: the same graph Graph Bench makes, so its
 * workloads and saved queries are timed on the same data in each store, and bench runs there say what scale it was.
 */
function LoadData({ onStarted, onCancel }: { onStarted: (batch: LoadBatch) => void; onCancel: () => void }) {
  const [connections, setConnections] = useState<StudioConnection[] | null>(null)
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({})
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [step, setStep] = useState(SCALES.indexOf(0.01))
  const [problem, setProblem] = useState<string | null>(null)
  // Read again every few seconds while open: a connection set up in Connections meanwhile shows up here.
  useEffect(() => {
    const read = () => listConnections().then(setConnections, (e: unknown) => setProblem(message(e)))
    void read()
    const timer = setInterval(read, 2000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    fetch(`${API}/loads`, { cache: 'no-store' }).then(r => read<Record<string, Loaded>>(r)).then(setLoaded, () => undefined)
  }, [])
  const scale = SCALES[step]!
  const size = new Scale(scale)
  const chosen = [...picked].filter(id => connections?.some(c => c.id === id && c.allowWrites))
  const start = () =>
    fetch(`${API}/loads`, json('POST', { connections: chosen, scale }))
      .then(r => read<LoadBatch>(r))
      .then(onStarted, (e: unknown) => setProblem(message(e)))
  return (
    <Sheet
      open
      onDismiss={onCancel}
      title="Load Graph Bench Data"
      description="The graph Graph Bench makes, node for node: orgs, people, repos, topics, issues and comments. Loaded with Cypher through Drivine into each database you choose, one after another."
      actions={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button intent="default" onClick={start} disabled={!chosen.length}>
            {chosen.length > 1 ? `Load into ${chosen.length}` : 'Load'}
          </Button>
        </>
      }
    >
      <div className="studio-form">
        <section className="studio-bench-size">
          <h4>How big</h4>
          <p className="desk-text-small desk-text-muted">Graph Bench’s scale: 1 is about a million nodes. Start small to try it; go big to see where the stores part ways.</p>
          <Slider label="Scale" min={0} max={SCALES.length - 1} step={1} value={step} onChange={setStep} format={i => String(SCALES[i])} />
          <div className="studio-bench-size-stops desk-text-caption desk-text-muted" aria-hidden="true">
            {SCALES.map((s, i) => <span key={s} data-on={i === step ? '' : undefined}>{s}</span>)}
          </div>
          <p className="studio-bench-size-says">
            <strong>{size.nodes.toLocaleString()}</strong> nodes and about <strong>{(size.nodes * 4).toLocaleString()}</strong> relationships
          </p>
          {scale > SLOW_SCALE && (
            <p className="desk-text-small studio-warn" role="note">
              A big load. Through Cypher it can take hours{scale >= 3 ? ', and several gigabytes of disk' : ''}; Graph Bench’s own bulk loader is quicker for Postgres and Oracle. Bench runs on these databases meanwhile would time a graph half made.
            </p>
          )}
        </section>
        <fieldset className="studio-bench-pick">
          <legend className="desk-text-small">Into</legend>
          {!connections ? <Loading label="Reading the connections" /> : connections.map(c => {
            const there = loaded[c.id]
            return (
              <div key={c.id} className="studio-bench-target">
                <Checkbox
                  label={`${c.name} · ${DATABASE_NAMES[c.type]}`}
                  checked={picked.has(c.id) && !!c.allowWrites}
                  disabled={!c.allowWrites}
                  onChange={on => {
                    const next = new Set(picked)
                    if (on) next.add(c.id)
                    else next.delete(c.id)
                    setPicked(next)
                  }}
                />
                <span className="desk-text-caption desk-text-muted">
                  {!c.allowWrites ? 'doesn’t allow writes' : there ? `has scale ${there.scale}: load again into an empty graph` : ''}
                </span>
              </div>
            )
          })}
          <div className="studio-bench-target-new">
            <Button size="small" onClick={() => perform(null, 'studio.connections')}>Set Up a Database…</Button>
            <span className="desk-text-caption desk-text-muted">A fresh one in Docker is best: loading changes the database. Tick “Allows writes”, and it shows up here.</span>
          </div>
        </fieldset>
        {problem && <p className="studio-bad desk-text-small" role="alert">{problem}</p>}
      </div>
    </Sheet>
  )
}

const percent = (done: number, total: number) => `${Math.min(100, (done / Math.max(1, total)) * 100)}%`

/** A load going on, in place of the report: each database's turn, how far it has got, and what it took. */
function LoadProgress({ batch, onClose }: { batch: LoadBatch; onClose: () => void }) {
  const over = batch.state === 'done'
  return (
    <section className="studio-bench-busy" aria-live="polite">
      <h3>{over ? `Loaded scale ${batch.scale}` : `Loading scale ${batch.scale}`}</h3>
      <p className="desk-text-small desk-text-muted">
        {over ? 'Bench runs on these databases now say what they ran on.' : `Graph Bench’s data, into ${batch.loads.length === 1 ? 'one database' : `${batch.loads.length} databases, one after another`}.`}
      </p>
      <ul className="studio-bench-busy-rows">
        {batch.loads.map(l => <LoadRow key={l.connection} load={l} />)}
      </ul>
      {over && <Button onClick={onClose}>Done</Button>}
    </section>
  )
}

function LoadRow({ load }: { load: LoadJob }) {
  learn([{ engine: load.name, type: load.type } as EngineResults])
  const took = load.loaded ? Math.round(load.loaded.load.schemaSeconds + load.loaded.load.nodeSeconds + load.loaded.load.edgeSeconds) : 0
  return (
    <li className="studio-bench-busy-row" data-state={load.state} style={{ '--bench-colour': colourOf(load.name) } as React.CSSProperties}>
      <span className="studio-bench-busy-name"><EngineName engine={load.name} /></span>
      <span className="studio-bench-progress"><span style={{ width: load.state === 'done' ? '100%' : percent(load.done, load.total) }} /></span>
      <span className="desk-text-small studio-bench-busy-says">
        {load.state === 'waiting' && 'Waiting its turn'}
        {load.state === 'running' && <><Spinner label="Loading" size="small" /> {load.now}</>}
        {load.state === 'done' && load.loaded && `✓ ${load.loaded.load.nodes.toLocaleString()} nodes, ${load.loaded.load.edges.toLocaleString()} relationships in ${took} s`}
        {load.state === 'failed' && <span className="studio-bad">Stopped: {load.error}</span>}
      </span>
    </li>
  )
}

/** A bench run going on, in place of the last report, until its own report opens. */
function RunProgress({ job, onClose }: { job: RunJob; onClose: () => void }) {
  return (
    <section className="studio-bench-busy" aria-live="polite">
      <h3>{job.state === 'failed' ? `${job.name} stopped` : job.done === 0 ? `Preparing ${job.name}` : `Running ${job.name}`}</h3>
      <p className="desk-text-small desk-text-muted">Each query is warmed up, then timed, on each database in turn. Its report opens here when it’s done.</p>
      <div className="studio-bench-busy-row" data-state={job.state}>
        <span className="studio-bench-busy-name desk-text-small">{job.done} of {job.total}</span>
        <span className="studio-bench-progress"><span style={{ width: percent(job.done, job.total) }} /></span>
        <span className="desk-text-small studio-bench-busy-says">
          {job.state === 'running' && <><Spinner label="Running" size="small" /> {job.now || 'Connecting'}</>}
          {job.state === 'failed' && <span className="studio-bad">{job.error}</span>}
        </span>
      </div>
      {job.state === 'failed' && <Button onClick={onClose}>Done</Button>}
    </section>
  )
}
