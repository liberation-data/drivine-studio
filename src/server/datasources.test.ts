import neo4j from 'neo4j-driver'
import { describe, expect, it } from 'vitest'
import type { Connection } from './connections'
import { boltParameters, run, StatementError } from './datasources'

describe('run', () => {
  it.each(['ORACLE', 'POSTGRES'] as const)('says the studio runs no Cypher on %s, before connecting', async type => {
    const connection: Connection = { id: type, name: type, type, host: 'nowhere.invalid', database: 'db', source: 'studio' }
    await expect(run(connection, 'RETURN 1')).rejects.toThrow(StatementError)
    await expect(run(connection, 'RETURN 1')).rejects.toThrow(/Drivine \(TypeScript\) runs SQL, not Cypher/)
  })
})

describe('boltParameters', () => {
  it('sends a whole number as an integer, everywhere in the parameters, and anything else as it is', () => {
    const sent = boltParameters({ born: 1815, ratio: 1.5, names: ['Ada'], nested: { ids: [1, 2] }, none: null })
    expect(neo4j.isInt(sent.born)).toBe(true)
    expect(sent.ratio).toBe(1.5)
    expect(sent.names).toEqual(['Ada'])
    expect(sent.nested.ids.every((id: unknown) => neo4j.isInt(id))).toBe(true)
    expect(sent.none).toBeNull()
  })
})
