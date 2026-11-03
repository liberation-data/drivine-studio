import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { benchResults, benchSets, linkBench, PUBLISHED } from './bench'

let dir: string
const saved = { ...process.env }
const engine = (name: string, scale: number, p50: number) => JSON.stringify({ engine: name, scale, load: null, outcomes: [{ group: 'g', name: 'w', calls: 1, p50, p95: p50, mean: p50, min: p50, max: p50, throughput: null, digest: 'd' }] })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'studio-bench-'))
  process.env.DRIVINE_STUDIO_HOME = join(dir, 'home')
})

afterEach(async () => {
  process.env = { ...saved }
  await rm(dir, { recursive: true, force: true })
})

/** GitHub as the published results come from it: a listing of results/, and each file. */
const github = (files: Record<string, string>) => async (url: string) => {
  if (url.endsWith('/contents/results')) return JSON.stringify(Object.keys(files).map(name => ({ name })))
  const name = url.split('/').pop()!
  if (name in files) return files[name]!
  throw new Error(`404 ${url}`)
}

describe('Graph Bench results', () => {
  it('lists the published set, and a linked checkout’s results/ and each folder of its own', async () => {
    const bench = join(dir, 'graph-bench')
    await mkdir(join(bench, 'results', 'm1-0.4.1'), { recursive: true })
    await writeFile(join(bench, 'run.sh'), '#!/bin/bash\n')
    await writeFile(join(bench, 'results', 'neo4j-sf1.0.json'), engine('neo4j', 1, 2))
    await writeFile(join(bench, 'results', 'm1-0.4.1', 'postgres-sf0.05.json'), engine('postgres', 0.05, 1))
    await linkBench(bench)
    const sets = await benchSets(github({ 'postgres-sf1.0.json': engine('postgres', 1, 1) }))
    expect(sets).toEqual([
      { source: PUBLISHED, set: '', label: 'Published', scales: [1], engines: ['postgres'] },
      { source: bench, set: '', label: 'results', scales: [1], engines: ['neo4j'] },
      { source: bench, set: 'm1-0.4.1', label: 'm1-0.4.1', scales: [0.05], engines: ['postgres'] },
    ])
    expect((await benchResults(bench, 'm1-0.4.1', 0.05)).map(r => r.engine)).toEqual(['postgres'])
    expect((await benchResults(PUBLISHED, '', 1, github({ 'postgres-sf1.0.json': engine('postgres', 1, 1) }))).map(r => r.engine)).toEqual(['postgres'])
  })

  it('reads only a linked checkout, and only a folder in its results/', async () => {
    const bench = join(dir, 'graph-bench')
    await mkdir(join(bench, 'results'), { recursive: true })
    await writeFile(join(bench, 'run.sh'), '')
    await expect(benchResults(bench, '', 1)).rejects.toThrow(/not a linked/)
    await linkBench(bench)
    await expect(benchResults(bench, '../..', 1)).rejects.toThrow(/no set/)
    await expect(linkBench(join(dir, 'nowhere'))).rejects.toThrow(/no run.sh/)
    await expect(linkBench('relative/path')).rejects.toThrow(/full path/)
  })
})
