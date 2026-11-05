import { describe, expect, it } from 'vitest'
import { FRESH_MS, parseKept, SchemaCache, schemaOf, stale } from './schema'
import type { Store } from './schema'

const schema = { labels: ['Person'], relationshipTypes: ['ACTED_IN'], propertyKeys: ['name'] }

const memoryStore = (): Store & { items: Map<string, string> } => {
  const items = new Map<string, string>()
  return { items, getItem: key => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) }
}

describe('SchemaCache', () => {
  it('keeps a schema per connection, in memory and in the store', () => {
    const store = memoryStore()
    const cache = new SchemaCache(store)
    expect(cache.get('a')).toBeUndefined()
    cache.put('a', schema, 100)
    expect(cache.get('a')).toEqual({ schema, at: 100 })
    expect(cache.get('b')).toBeUndefined()
    expect([...store.items.keys()]).toEqual(['drivine-studio.schema.a'])
  })

  it('finds one left in the store by an earlier visit', () => {
    const store = memoryStore()
    new SchemaCache(store).put('a', schema, 100)
    expect(new SchemaCache(store).get('a')).toEqual({ schema, at: 100 })
  })

  it('still keeps one in memory where the store refuses it', () => {
    const cache = new SchemaCache({ getItem: () => null, setItem: () => { throw new Error('full') } })
    cache.put('a', schema, 1)
    expect(cache.get('a')?.schema).toEqual(schema)
  })
})

describe('parseKept and schemaOf', () => {
  it('reads back what was kept, and nothing from what wasn’t', () => {
    expect(parseKept(JSON.stringify({ schema, at: 5 }))).toEqual({ schema, at: 5 })
    expect(parseKept(null)).toBeUndefined()
    expect(parseKept('not json')).toBeUndefined()
    expect(parseKept(JSON.stringify({ schema: { labels: [] }, at: 5 }))).toBeUndefined()
    expect(parseKept(JSON.stringify({ schema }))).toBeUndefined()
  })

  it('leaves out anything in a list that is not a name', () => {
    expect(schemaOf({ labels: ['A', 3, null], relationshipTypes: [], propertyKeys: ['k'] })).toEqual({ labels: ['A'], relationshipTypes: [], propertyKeys: ['k'] })
    expect(schemaOf('nope')).toBeUndefined()
  })
})

describe('stale', () => {
  it('is read again when there is none, or once it is a minute old', () => {
    expect(stale(undefined, 0)).toBe(true)
    expect(stale({ schema, at: 1000 }, 1000 + FRESH_MS - 1)).toBe(false)
    expect(stale({ schema, at: 1000 }, 1000 + FRESH_MS)).toBe(true)
  })
})
