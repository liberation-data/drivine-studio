import { useEffect, useState } from 'react'
import { testConnection } from './database'

/** How often each connection is tried again while it's shown. */
const EVERY_MS = 5000

/**
 * Whether each connection is up: tried when first shown and every few seconds after, so a database started or
 * stopped meanwhile shows it. Undefined while it is first being tried.
 */
export function useOnline(ids: readonly string[]): Record<string, boolean> {
  const [up, setUp] = useState<Record<string, boolean>>({})
  const key = ids.join('|')
  useEffect(() => {
    if (!key) return
    let live = true
    const probe = () => {
      for (const id of key.split('|')) {
        testConnection(id).then(() => true, () => false).then(ok => live && setUp(was => (was[id] === ok ? was : { ...was, [id]: ok })))
      }
    }
    probe()
    const timer = setInterval(probe, EVERY_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [key])
  return up
}
