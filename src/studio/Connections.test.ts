import { describe, expect, it } from 'vitest'
import { inputOf } from './Connections'

const draft = {
  name: 'Local', type: 'NEO4J' as const, host: 'localhost', port: '', user: '', password: '', clearPassword: false, database: '', graph: '',
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
  })

  it('forgets the password only when no new one is typed', () => {
    expect(inputOf({ ...draft, clearPassword: true })).toMatchObject({ clearPassword: true })
    expect(inputOf({ ...draft, clearPassword: true, password: 'new' })).not.toHaveProperty('clearPassword')
  })
})
