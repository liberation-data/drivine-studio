import { describe, expect, it } from 'vitest'
import { graphHelp, inputOf } from './Connections'

const draft = {
  name: 'Local', type: 'NEO4J' as const, host: 'localhost', port: '', user: '', password: '', clearPassword: false, database: '', graph: '',
  allowWrites: false,
}

describe('inputOf', () => {
  it('leaves out what is empty, so the server\'s defaults apply', () => {
    expect(inputOf(draft)).toEqual({ name: 'Local', type: 'NEO4J', host: 'localhost' })
    expect(inputOf({ ...draft, port: '7688', user: 'neo4j', password: 'secret', database: 'movies' }))
      .toEqual({ name: 'Local', type: 'NEO4J', host: 'localhost', port: 7688, user: 'neo4j', password: 'secret', database: 'movies' })
  })

  it('sends a database and a property graph only to the types that have them', () => {
    expect(inputOf({ ...draft, type: 'MEMGRAPH', database: 'left-from-neo4j', graph: 'g' })).not.toHaveProperty('database')
    expect(inputOf({ ...draft, type: 'FALKORDB', database: 'social', graph: 'g' })).toMatchObject({ database: 'social' })
    expect(inputOf({ ...draft, type: 'FALKORDB', graph: 'g' })).not.toHaveProperty('graph')
    expect(inputOf({ ...draft, type: 'ORACLE', database: 'FREEPDB1', graph: 'g' })).toMatchObject({ database: 'FREEPDB1', graph: 'g' })
    expect(inputOf({ ...draft, type: 'POSTGRES', database: 'studio', graph: 'g' })).toMatchObject({ database: 'studio', graph: 'g' })
  })

  it('forgets the password only when no new one is typed', () => {
    expect(inputOf({ ...draft, clearPassword: true })).toMatchObject({ clearPassword: true })
    expect(inputOf({ ...draft, clearPassword: true, password: 'new' })).not.toHaveProperty('clearPassword')
  })

  it('allows writes only when the box is ticked, and says nothing of it otherwise', () => {
    expect(inputOf(draft)).not.toHaveProperty('allowWrites')
    expect(inputOf({ ...draft, allowWrites: true })).toMatchObject({ allowWrites: true })
  })
})

describe('graphHelp', () => {
  it("names the tables of the graph typed, and drivine's when none is", () => {
    expect(graphHelp('guide')).toContain('guide_node and guide_edge')
    expect(graphHelp('')).toContain('drivine_node and drivine_edge')
  })

  it('names the tables the server will use, which trims the name', () => {
    expect(graphHelp(' guide ')).toContain('here guide_node and guide_edge')
    expect(graphHelp('   ')).toContain('drivine_node and drivine_edge')
  })

  it("doesn't say the graph has only two tables: Drivine keeps its schema in a third", () => {
    expect(graphHelp('guide')).not.toContain('two tables')
  })
})
