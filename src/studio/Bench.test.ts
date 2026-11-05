import { describe, expect, it } from 'vitest'
import type { EngineResults, Outcome } from '../server/bench'
import { crossovers, scores, sizesOf } from './Bench'

const workload = { group: 'traversal', name: '3 hops', calls: 1, p50: 0, p95: 0, mean: 0, min: 0, max: 0, throughput: null, digest: null }
const line = (...points: [number, number][]) => points.map(([nodes, ms]) => ({ nodes, ms, p95: ms }))
const one = (byEngine: [string, ReturnType<typeof line>][]) => new Map([['traversal|3 hops', new Map(byEngine)]])

describe('crossovers', () => {
  it('finds where one engine overtakes another, about where their log–log lines meet', () => {
    // Postgres leads at 1M, Neo4j at 100M; the lines meet at 10M.
    const lines = new Map([['traversal|3 hops', new Map([
      ['postgres', line([1e6, 1], [1e8, 100])],
      ['neo4j', line([1e6, 10], [1e8, 10])],
    ])]])
    const [found] = crossovers(lines, [workload])
    expect(found).toMatchObject({ ahead: 'neo4j', behind: 'postgres', from: 1e6, to: 1e8 })
    expect(found!.at).toBeCloseTo(1e7, -3)
  })

  it('finds none where the fastest stays the fastest, or there is one engine', () => {
    const steady = new Map([['traversal|3 hops', new Map([['postgres', line([1e6, 1], [1e8, 2])], ['neo4j', line([1e6, 3], [1e8, 4])]])]])
    expect(crossovers(steady, [workload])).toEqual([])
    const alone = new Map([['traversal|3 hops', new Map([['postgres', line([1e6, 1], [1e8, 2])]])]])
    expect(crossovers(alone, [workload])).toEqual([])
  })

  it('finds none at a single size', () => {
    expect(crossovers(one([['postgres', line([1e6, 1])], ['neo4j', line([1e6, 2])]]), [workload])).toEqual([])
  })

  it('compares only the engines measured at both sizes: one missing at a size neither overtakes nor is overtaken there', () => {
    // Neo4j wasn't run at 1M; where both were run, it is ahead at both.
    const lines = one([['postgres', line([1e6, 1], [1e7, 20], [1e8, 200])], ['neo4j', line([1e7, 10], [1e8, 100])]])
    expect(crossovers(lines, [workload])).toEqual([])
  })

  it('finds the overtaking across a size one engine is missing at, between the sizes both were measured at', () => {
    const lines = one([['postgres', line([1e6, 1], [1e7, 5], [1e8, 100])], ['neo4j', line([1e6, 10], [1e8, 10])]])
    expect(crossovers(lines, [workload])).toMatchObject([{ ahead: 'neo4j', behind: 'postgres', from: 1e6, to: 1e8 }])
  })

  it('says only where the fastest changes: of three, an overtaking behind the leader is not one', () => {
    // Oracle leads at both sizes, while Neo4j passes Postgres behind it.
    const behind = one([['oracle', line([1e6, 1], [1e8, 1])], ['postgres', line([1e6, 2], [1e8, 50])], ['neo4j', line([1e6, 5], [1e8, 10])]])
    expect(crossovers(behind, [workload])).toEqual([])
    // Neo4j passes both to lead at 100M: it overtakes the one that led, not the one that was second.
    const ahead = one([['oracle', line([1e6, 1], [1e8, 20])], ['postgres', line([1e6, 2], [1e8, 50])], ['neo4j', line([1e6, 5], [1e8, 10])]])
    expect(crossovers(ahead, [workload])).toMatchObject([{ ahead: 'neo4j', behind: 'oracle', from: 1e6, to: 1e8 }])
  })

  it('counts a tie for the lead as no overtaking, at either end', () => {
    expect(crossovers(one([['postgres', line([1e6, 5], [1e8, 9])], ['neo4j', line([1e6, 5], [1e8, 2])]]), [workload])).toEqual([])
    expect(crossovers(one([['postgres', line([1e6, 1], [1e8, 5])], ['neo4j', line([1e6, 3], [1e8, 5])]]), [workload])).toEqual([])
  })

  it('ranks a workload on threads by calls a second, the most ahead, as the report does', () => {
    const threads = { ...workload, group: 'reads, 8 threads', name: 'lookups' }
    const at = (nodes: number, ms: number, throughput: number) => ({ nodes, ms, p95: ms, throughput })
    // By middle time Postgres stays ahead; by calls a second Neo4j overtakes it.
    const lines = new Map([['reads, 8 threads|lookups', new Map([
      ['postgres', [at(1e6, 1, 1000), at(1e8, 1, 100)]],
      ['neo4j', [at(1e6, 2, 500), at(1e8, 2, 500)]],
    ])]])
    expect(crossovers(lines, [threads])).toMatchObject([{ ahead: 'neo4j', behind: 'postgres' }])
  })

  it('places the meeting within its sizes when a store gave a time of 0', () => {
    const [found] = crossovers(one([['postgres', line([1e6, 0], [1e8, 100])], ['neo4j', line([1e6, 10], [1e8, 10])]]), [workload])
    expect(found!.at).toBeGreaterThanOrEqual(1e6)
    expect(found!.at).toBeLessThanOrEqual(1e8)
  })
})

describe('the scoreboard', () => {
  const outcome = (group: string, name: string, p50: number, throughput: number | null = null): Outcome =>
    ({ group, name, calls: 1, p50, p95: p50, mean: p50, min: p50, max: p50, throughput, digest: null })
  const engine = (name: string, outcomes: Outcome[]) => ({ engine: name, scale: 1, load: null, outcomes }) as EngineResults
  const find = (rs: EngineResults[] | null, name: string, o: Outcome) =>
    rs?.find(r => r.engine === name)?.outcomes.find(x => x.group === o.group && x.name === o.name)

  it('wins a workload on threads by the most calls a second, the others by the least middle time', () => {
    const results = [
      engine('neo4j', [outcome('reads', 'a', 1), outcome('8 threads', 'b', 1, 100)]),
      engine('postgres', [outcome('reads', 'a', 2), outcome('8 threads', 'b', 9, 900)]),
    ]
    const { wins } = scores(results, results[0]!.outcomes, find)
    expect(Object.fromEntries(wins)).toEqual({ neo4j: 1, postgres: 1 })
  })

  it('gives a tie to each engine in it, whichever comes first', () => {
    const results = [engine('neo4j', [outcome('reads', 'a', 3)]), engine('postgres', [outcome('reads', 'a', 3)]), engine('oracle', [outcome('reads', 'a', 4)])]
    expect(Object.fromEntries(scores(results, results[0]!.outcomes, find).wins)).toEqual({ neo4j: 1, postgres: 1, oracle: 0 })
  })

  it('counts the answers every engine gave a digest for, and those they agreed on', () => {
    const digested = (name: string, digest: string | null) => ({ ...outcome('reads', name, 1), digest })
    const results = [
      engine('neo4j', [digested('same', 'a'), digested('differ', 'a'), digested('one missing', 'a'), digested('alone', 'a')]),
      engine('postgres', [digested('same', 'a'), digested('differ', 'b'), digested('one missing', null)]),
    ]
    const { agreed, compared } = scores(results, results[0]!.outcomes, find)
    expect({ agreed, compared }).toEqual({ agreed: 1, compared: 2 })
  })

  it('counts no win where a throughput was not kept, or only one engine ran it', () => {
    const results = [
      engine('neo4j', [outcome('8 threads', 'b', 1, null), outcome('reads', 'alone', 1)]),
      engine('postgres', [outcome('8 threads', 'b', 1, null)]),
    ]
    expect(Object.fromEntries(scores(results, results[0]!.outcomes, find).wins)).toEqual({ neo4j: 0, postgres: 0 })
  })
})

describe('the sizes of a set', () => {
  const at = (scale: number, nodes?: number) =>
    ({ engine: 'e', scale, load: nodes === undefined ? null : { nodes, edges: 0, schemaSeconds: 0, nodeSeconds: 0, edgeSeconds: 0 }, outcomes: [] }) as EngineResults

  it('puts engines run at one scale at one size, whether or not each kept its load', () => {
    const all = [at(0.001, 1140), at(0.001), at(10)]
    const nodesOf = sizesOf(all)
    expect(all.map(nodesOf)).toEqual([1140, 1140, 11_210_500])
  })
})
