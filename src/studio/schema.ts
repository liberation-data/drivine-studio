// What each connection's graph is made of, for the Cypher editor to complete: fetched in the background from
// src/app/api/schema, and kept per connection, in memory and in this browser, so the editor has it at once and the
// fresh one when it lands.

import { useEffect, useState } from 'react'
import { read } from './fetching'

/** A graph's labels, relationship types and property keys, each sorted, each once. */
export interface GraphSchema {
  labels: string[]
  relationshipTypes: string[]
  propertyKeys: string[]
}

export const EMPTY_SCHEMA: GraphSchema = { labels: [], relationshipTypes: [], propertyKeys: [] }

/** A schema as kept: what it was, and when it was read. */
export interface Kept {
  schema: GraphSchema
  at: number
}

/** On window focus, fetched again only if it is older than this. */
export const FRESH_MS = 60_000

const KEY = 'drivine-studio.schema.'

/** Where kept schemas live: this browser's localStorage, or a test's own. */
export interface Store {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const browserStore = (): Store | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

/** Kept schemas, by connection: in memory first, then from the store, as left there by an earlier visit. */
export class SchemaCache {
  private readonly held = new Map<string, Kept>()
  constructor(private readonly store: Store | undefined = browserStore()) {}

  get(connection: string): Kept | undefined {
    const held = this.held.get(connection)
    if (held) return held
    const kept = parseKept(this.store?.getItem(KEY + connection) ?? null)
    if (kept) this.held.set(connection, kept)
    return kept
  }

  put(connection: string, schema: GraphSchema, at: number): Kept {
    const kept = { schema, at }
    this.held.set(connection, kept)
    try {
      this.store?.setItem(KEY + connection, JSON.stringify(kept))
    } catch {
      // Storage may be full, or not allowed: held in memory for this visit, then.
    }
    return kept
  }
}

/** A kept schema read back, or nothing where it isn't one: storage is the browser's, and anything may be in it. */
export function parseKept(text: string | null): Kept | undefined {
  if (!text) return undefined
  try {
    const kept = JSON.parse(text) as Partial<Kept>
    const schema = schemaOf(kept.schema)
    return schema && typeof kept.at === 'number' ? { schema, at: kept.at } : undefined
  } catch {
    return undefined
  }
}

/** A schema from what the server gave back, or nothing where it isn't one. */
export function schemaOf(value: unknown): GraphSchema | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  const names = (list: unknown) => (Array.isArray(list) ? list.filter((it): it is string => typeof it === 'string') : undefined)
  const labels = names(v.labels)
  const relationshipTypes = names(v.relationshipTypes)
  const propertyKeys = names(v.propertyKeys)
  return labels && relationshipTypes && propertyKeys ? { labels, relationshipTypes, propertyKeys } : undefined
}

/** Whether a schema kept since `at` is read again: when there is none, or, on focus, once it is a minute old. */
export const stale = (kept: Kept | undefined, now: number): boolean => !kept || now - kept.at >= FRESH_MS

export async function fetchSchema(connection: string, signal?: AbortSignal): Promise<GraphSchema> {
  const answered = await read<unknown>(await fetch(`/api/schema?connection=${encodeURIComponent(connection)}`, { signal }))
  const schema = schemaOf(answered)
  if (!schema) throw new Error('The studio gave back no schema.')
  return schema
}

const cache = new SchemaCache()

/**
 * The connection's schema for the editor: the one kept at once, then the fresh one, fetched when the connection is
 * chosen, when `changed` changes (after a statement that wrote), and on the window's focus once the kept one is a
 * minute old. A schema that can't be read leaves the kept one, or none: completion is a help, never in the way.
 */
export function useSchema(connection: string | undefined, changed: unknown): GraphSchema {
  const [schema, setSchema] = useState<GraphSchema>(() => (connection && cache.get(connection)?.schema) || EMPTY_SCHEMA)
  useEffect(() => {
    if (!connection) return setSchema(EMPTY_SCHEMA)
    setSchema(cache.get(connection)?.schema ?? EMPTY_SCHEMA)
    let controller: AbortController | undefined
    const refresh = () => {
      controller?.abort()
      const mine = (controller = new AbortController())
      fetchSchema(connection, mine.signal).then(
        fresh => {
          if (mine.signal.aborted) return
          cache.put(connection, fresh, Date.now())
          setSchema(fresh)
        },
        () => undefined,
      )
    }
    refresh()
    const focused = () => {
      if (stale(cache.get(connection), Date.now())) refresh()
    }
    window.addEventListener('focus', focused)
    return () => {
      controller?.abort()
      window.removeEventListener('focus', focused)
    }
  }, [connection, changed])
  return schema
}
