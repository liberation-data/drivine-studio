import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Dataset, LABELS, Scale, SplittableRandom } from './benchData'

/** The dataset as JSON Lines, as graph-bench's dump of it writes them: each node, then each relationship. */
function digest(factor: number): { lines: number; sha1: string } {
  const data = new Dataset(new Scale(factor))
  const hash = createHash('sha1')
  let lines = 0
  for (const label of LABELS) for (const props of data.nodes(label)) (hash.update(JSON.stringify({ label, props }) + '\n'), lines++)
  for (const set of data.edges) for (const [s, d] of set.pairs()) (hash.update(JSON.stringify({ type: set.type, s, d }) + '\n'), lines++)
  return { lines, sha1: hash.digest('hex') }
}

describe('Graph Bench’s dataset', () => {
  // Written by graph-bench 7eb4360's Dataset (Data.kt), every node and relationship as JSON, with Jackson.
  it('is the graph Graph Bench makes, row for row', () => {
    expect(digest(0.001)).toEqual({ lines: 5294, sha1: '013f6636df262ccd0ac706dd67f3ca05d55985b6' })
    expect(digest(0.01)).toEqual({ lines: 54993, sha1: '671b392158674304536e8aab86e6587447e1df56' })
  })

  it('reads the same each time it is asked for', () => {
    const data = new Dataset(new Scale(0.001))
    const once = [...data.edges[1]!.pairs()]
    expect([...data.edges[1]!.pairs()]).toEqual(once)
  })

  it('counts nodes as Graph Bench does: at least ten of each, and at most 500 topics', () => {
    expect(new Scale(0.00001).nodes).toBe(60)
    expect(new Scale(1).nodes).toBe(1_121_500)
    expect(new Scale(10).topics).toBe(500)
  })
})

const JAVA = [31, 5, 24231381929, 0.34419071652363753]

describe('SplittableRandom', () => {
  // As java.util.SplittableRandom(42) gives them, on JDK 25.
  it('gives what Java’s does', () => {
    const r = new SplittableRandom(42n)
    expect([r.nextInt(100), r.nextInt(7), r.nextLong(50_000_000_000), r.nextDouble()]).toEqual(JAVA)
  })
})
