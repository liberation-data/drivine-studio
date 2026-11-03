import { describe, expect, it } from 'vitest'
import { Dataset, Scale } from './benchData'
import { batches, edgeStatement, LARGEST, nodeStatement, SMALLEST, validateLoad } from './benchLoad'
import { compilerFor, readCypher } from './sqlCypher'

describe('Loading Graph Bench’s data', () => {
  it('takes a connection and a scale within bounds', () => {
    expect(validateLoad({ connection: 'pg', scale: 0.01 })).toEqual({ connection: 'pg', scale: 0.01 })
    expect(() => validateLoad({ scale: 1 })).toThrow(/connection/)
    expect(() => validateLoad({ connection: 'pg', scale: SMALLEST / 2 })).toThrow(/scale/)
    expect(() => validateLoad({ connection: 'pg', scale: LARGEST * 2 })).toThrow(/scale/)
    expect(() => validateLoad({ connection: 'pg', scale: 'big' })).toThrow(/scale/)
  })

  it('writes in batches, the last one what is left', () => {
    expect([...batches([1, 2, 3, 4, 5], 2)]).toEqual([[1, 2], [3, 4], [5]])
    expect([...batches([], 2)]).toEqual([])
  })

  // What Postgres and Oracle are sent is Drivine's SQL for these: the compiler must take each.
  it.each(['POSTGRES', 'ORACLE'] as const)('loads with statements Drivine compiles for %s', type => {
    const data = new Dataset(new Scale(SMALLEST))
    const compiler = compilerFor(type, 'drivine')
    const rows = [...data.nodes('Person')].slice(0, 2)
    expect(() => compiler.compileQuery(readCypher(nodeStatement('Person')), { rows })).not.toThrow()
    for (const set of data.edges) {
      expect(() => compiler.compileQuery(readCypher(edgeStatement(set)), { rows: [{ s: 'p0', d: 'o0' }] })).not.toThrow()
    }
  })
})
