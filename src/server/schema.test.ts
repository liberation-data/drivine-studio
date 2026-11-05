import { describe, expect, it } from 'vitest'
import { MOST, namesOf, oracleKeys, schemaSql } from './schema'

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

  it('refuses a graph name that would change the SQL', () => {
    expect(() => schemaSql('POSTGRES', 'x; DROP TABLE y')).toThrow()
    expect(() => schemaSql('ORACLE', 'x_node--')).toThrow()
  })
})
