import { describe, expect, it } from 'vitest'
import { connectionChoices, notNow } from './connectionMenu'
import type { StudioConnection } from './database'

const connection = (id: string, type: StudioConnection['type'] = 'NEO4J'): StudioConnection =>
  ({ id, name: id.toUpperCase(), type, host: 'localhost', port: 7687 }) as StudioConnection

describe('connectionChoices', () => {
  const all = [connection('a'), connection('matrix', 'POSTGRES'), connection('d')]

  it('lists those that are up first, then those that are down, each in the order kept', () => {
    expect(connectionChoices(all, { a: false, matrix: true, d: false }, undefined).map(c => c.connection.id)).toEqual(['matrix', 'a', 'd'])
  })

  it('greys out one that is down, and says it is not running', () => {
    const [up, down] = connectionChoices([connection('matrix', 'POSTGRES'), connection('a')], { matrix: true, a: false }, undefined)
    expect(up).toMatchObject({ detail: 'Postgres', disabled: false })
    expect(down).toMatchObject({ detail: 'Neo4j · not running', disabled: true })
  })

  it('keeps one still being tried among those up, greyed out until it answers', () => {
    expect(connectionChoices(all, { a: false }, undefined).map(c => [c.connection.id, c.detail, c.disabled])).toEqual([
      ['matrix', 'Postgres · checking…', true],
      ['d', 'Neo4j · checking…', true],
      ['a', 'Neo4j · not running', true],
    ])
  })

  it('keeps the one in use checked when it is down, and shows it down', () => {
    const inUse = connectionChoices(all, { a: false, matrix: true, d: true }, 'a').find(c => c.connection.id === 'a')
    expect(inUse).toMatchObject({ checked: true, disabled: true, detail: 'Neo4j · not running' })
  })
})

describe('notNow', () => {
  it('says why a connection cannot be chosen, as Bench does', () => {
    expect([notNow(undefined, 'NEO4J'), notNow(false, 'NEO4J'), notNow(true, 'NEO4J')]).toEqual(['checking…', 'not running', undefined])
  })

  it('says a SQLite file that fails its test can’t be read, since a file is not a server that runs', () => {
    expect([notNow(undefined, 'SQLITE'), notNow(false, 'SQLITE'), notNow(true, 'SQLITE')]).toEqual(['checking…', 'can’t be read', undefined])
    const [file] = connectionChoices([{ ...connection('file', 'SQLITE'), host: '', database: '/data/graph.db' }], { file: false }, undefined)
    expect(file).toMatchObject({ detail: 'SQLite · can’t be read', disabled: true })
  })
})
