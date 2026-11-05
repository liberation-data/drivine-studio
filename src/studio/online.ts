import { useEffect, useSyncExternalStore } from 'react'
import { testConnection } from './database'

/** How long after each try a connection is tried again, while something shows it. */
const EVERY_MS = 5000

/** Whether each watched connection is up, and the means to watch more or stop. */
export interface OnlineStore {
  /** Watches these ids until the returned function is called. Each is tried at once unless something watches it already. */
  watch(ids: readonly string[]): () => void
  subscribe(listener: () => void): () => void
  /** Whether each watched id is up; the same object until one changes. Absent while first being tried. */
  snapshot(): Readonly<Record<string, boolean>>
}

/**
 * Tries each watched connection with `probe`, then again `every` ms after that try settles, never at an interval: a
 * down host can take longer than `every` to time out, and tries begun on a clock would pile up behind it. One loop per
 * id however many watch it, so the menu bar, Connections and a bench picker showing the same database try it once. An
 * id no longer watched is dropped with its state, and a try that settles after that is ignored.
 */
export function onlineStore(probe: (id: string) => Promise<unknown>, every = EVERY_MS): OnlineStore {
  const watchers = new Map<string, number>()
  const trying = new Set<string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const listeners = new Set<() => void>()
  let up: Readonly<Record<string, boolean>> = {}
  const publish = (next: Record<string, boolean>) => {
    up = next
    for (const listener of listeners) listener()
  }
  const attempt = (id: string) => {
    timers.delete(id)
    trying.add(id)
    // A probe that throws rather than rejects is down too, and mustn't leave the id tried for ever.
    void new Promise(resolve => resolve(probe(id))).then(() => true, () => false).then(ok => {
      trying.delete(id)
      if (!watchers.has(id)) return
      if (up[id] !== ok) publish({ ...up, [id]: ok })
      timers.set(id, setTimeout(() => attempt(id), every))
    })
  }
  const release = (id: string) => {
    const left = (watchers.get(id) ?? 0) - 1
    if (left > 0) return void watchers.set(id, left)
    watchers.delete(id)
    clearTimeout(timers.get(id))
    timers.delete(id)
    // Forgotten only once the change that let it go is done: a component whose list of ids changes lets go of them all
    // and watches the new list straight after, and its lamps shouldn't go dark meanwhile.
    queueMicrotask(() => {
      if (watchers.has(id) || !(id in up)) return
      const { [id]: _gone, ...rest } = up
      publish(rest)
    })
  }
  return {
    watch(ids) {
      const mine = [...new Set(ids)]
      for (const id of mine) {
        const was = watchers.get(id) ?? 0
        watchers.set(id, was + 1)
        // A try still out from before it was let go of answers for it, and goes on from there: no second beside it.
        if (!was && !trying.has(id)) attempt(id)
      }
      let done = false
      // Once only: a second call mustn't let go of what another watcher still watches.
      return () => {
        if (done) return
        done = true
        mine.forEach(release)
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    snapshot: () => up,
  }
}

const shared = onlineStore(testConnection)

/**
 * Whether each connection is up: tried when first shown and every few seconds after, so a database started or
 * stopped meanwhile shows it. Undefined while it is first being tried. Every component asks the one shared store, so
 * the same connection shown in several places is tried once.
 */
export function useOnline(ids: readonly string[]): Readonly<Record<string, boolean>> {
  const key = ids.join('|')
  useEffect(() => (key ? shared.watch(key.split('|')) : undefined), [key])
  return useSyncExternalStore(shared.subscribe, shared.snapshot, shared.snapshot)
}
