import { describe, expect, it } from 'vitest'
import { crossovers } from './Bench'

const workload = { group: 'traversal', name: '3 hops', calls: 1, p50: 0, p95: 0, mean: 0, min: 0, max: 0, throughput: null, digest: null }
const line = (...points: [number, number][]) => points.map(([nodes, ms]) => ({ nodes, ms, p95: ms }))

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
})
