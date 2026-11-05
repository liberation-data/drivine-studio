import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Connection } from './connections'
import { readRows, readSql, StatementError } from './datasources'
import { MOST, namesOf, oracleKeys, readSchema, schemaSql } from './schema'

// Nothing is connected to here: what readSchema asks of the database, and makes of what it says, is what is tested.
vi.mock('./datasources', async original => ({
  ...(await original<typeof import('./datasources')>()),
  readRows: vi.fn(),
  readSql: vi.fn(),
}))

describe('namesOf', () => {
  it('takes each name once, sorted, from values or rows of one column, whatever its name’s case', () => {
    expect(namesOf(['Person', 'Movie', 'Person'])).toEqual(['Movie', 'Person'])
    expect(namesOf([{ v: 'b' }, { V: 'a' }, { label: 'c' }])).toEqual(['a', 'b', 'c'])
    expect(namesOf([null, 3, {}, { v: 4 }, ''])).toEqual([])
  })

  it('stops at the most it keeps', () => {
    expect(namesOf(Array.from({ length: MOST + 50 }, (_, i) => `k${i}`))).toHaveLength(MOST)
  })
})

describe('oracleKeys', () => {
  it('reads the top-level keys from flat data guides, of nodes and of relationships', () => {
    const nodes = JSON.stringify([
      { 'o:path': '$', type: 'object' },
      { 'o:path': '$.name', type: 'string' },
      { 'o:path': '$.address', type: 'object' },
      { 'o:path': '$.address.city', type: 'string' },
      { 'o:path': '$."odd key"', type: 'string' },
      { 'o:path': '$.tags[*]', type: 'string' },
    ])
    const edges = JSON.stringify([{ 'o:path': '$.roles', type: 'array' }])
    expect(oracleKeys([nodes, edges])).toEqual(['address', 'name', 'odd key', 'roles', 'tags'])
  })

  it('leaves out what isn’t a data guide', () => {
    expect(oracleKeys([null, '', 'not json', '{}', JSON.stringify([{ path: '$.x' }])])).toEqual([])
  })
})

describe('schemaSql', () => {
  it('reads every label and type from the graph\u2019s own tables, and property keys from a sample', () => {
    const pg = schemaSql('POSTGRES', 'movies')
    expect(pg.labels).toContain('SELECT DISTINCT labels AS l FROM movies_node)')
    expect(pg.labels).not.toContain('TABLESAMPLE')
    expect(pg.relationshipTypes).toBe('SELECT DISTINCT type AS v FROM movies_edge LIMIT 2000')
    expect(pg.propertyKeys).toContain('FROM movies_node TABLESAMPLE SYSTEM (1)')
    expect(pg.propertyKeys).toContain('WHERE labels @> s.l LIMIT 200')
    const oracle = schemaSql('ORACLE', 'movies')
    expect(oracle.labels).not.toContain('SAMPLE')
    expect(oracle.propertyKeys).toContain('SAMPLE BLOCK (1)')
    expect(oracle.propertyKeys).toContain('JSON_DATAGUIDE')
  })

  it('refuses a graph name that would change the SQL, or that Drivine would not name tables with, as the person’s to fix', () => {
    expect(() => schemaSql('POSTGRES', 'x; DROP TABLE y')).toThrow(StatementError)
    expect(() => schemaSql('ORACLE', 'x_node--')).toThrow(StatementError)
    // Postgres names at most 63 characters: Drivine keeps room in them for its own indexes' names.
    expect(() => schemaSql('POSTGRES', 'g'.repeat(60))).toThrow(StatementError)
    expect(schemaSql('ORACLE', 'g'.repeat(60)).relationshipTypes).toContain(`FROM ${'g'.repeat(60)}_edge`)
  })
})

describe('readSchema', () => {
  const connection = (type: string, graph?: string) =>
    ({ id: 'c', name: 'C', type, host: 'localhost', source: 'studio', ...(graph ? { graph } : {}) }) as Connection
  const rowsOf = (...values: string[]) => ({ columns: ['v'], rows: values.map(v => [v]), truncated: false })
  const asked = () => vi.mocked(readRows).mock.calls.map(call => call[1])

  afterEach(() => {
    vi.mocked(readRows).mockReset()
    vi.mocked(readSql).mockReset()
  })

  it('asks Neo4j for what it keeps, and a sample where it won’t say', async () => {
    vi.mocked(readRows).mockResolvedValue(rowsOf('B', 'A', 'B'))
    expect(await readSchema(connection('NEO4J'))).toEqual({ labels: ['A', 'B'], relationshipTypes: ['A', 'B'], propertyKeys: ['A', 'B'] })
    expect(asked()).toEqual(expect.arrayContaining([expect.stringContaining('db.labels()'), expect.stringContaining('db.propertyKeys()')]))
    vi.mocked(readRows).mockReset()
    vi.mocked(readRows).mockImplementation(async (_c, statement) => {
      if (statement.startsWith('CALL db.')) throw new Error('There is no procedure with the name `db.labels` registered')
      return rowsOf('Person')
    })
    expect((await readSchema(connection('FALKORDB'))).labels).toEqual(['Person'])
    expect(asked().filter(s => !s.startsWith('CALL db.'))).toHaveLength(3)
  })

  it('reads Memgraph and Neptune from a sample at once', async () => {
    vi.mocked(readRows).mockResolvedValue(rowsOf('Person'))
    await readSchema(connection('MEMGRAPH'))
    expect(asked()).toHaveLength(3)
    expect(asked().every(s => !s.includes('db.'))).toBe(true)
  })

  it('reads Postgres and Oracle from the graph’s own tables, with Oracle’s keys from its data guides', async () => {
    vi.mocked(readSql).mockImplementation(async (_c, text) =>
      text.includes('JSON_DATAGUIDE') ? [{ V: JSON.stringify([{ 'o:path': '$.name' }]) }, { V: JSON.stringify([{ 'o:path': '$.roles' }]) }] : [{ V: 'Person' }],
    )
    expect(await readSchema(connection('ORACLE', 'movies'))).toEqual({ labels: ['Person'], relationshipTypes: ['Person'], propertyKeys: ['name', 'roles'] })
    expect(vi.mocked(readSql).mock.calls.every(([, text]) => text.includes('movies_'))).toBe(true)
    vi.mocked(readSql).mockReset()
    vi.mocked(readSql).mockResolvedValue([{ v: 'born' }])
    expect(await readSchema(connection('POSTGRES'))).toEqual({ labels: ['born'], relationshipTypes: ['born'], propertyKeys: ['born'] })
    expect(vi.mocked(readSql).mock.calls.every(([, text]) => text.includes('drivine_node') || text.includes('drivine_edge'))).toBe(true)
    expect(vi.mocked(readRows)).not.toHaveBeenCalled()
  })
})
