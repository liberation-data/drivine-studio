import { DATABASE_NAMES } from './database'
import type { StudioConnection } from './database'

/** A connection as the menu bar's connection menu lists it. */
export interface ConnectionChoice {
  readonly connection: StudioConnection
  /** The database, and why it can't be chosen when it can't. */
  readonly detail: string
  readonly disabled: boolean
  readonly checked: boolean
}

/** Why a connection can't be chosen now, as Bench's pickers say it, or undefined when it can. */
export const notNow = (up: boolean | undefined): string | undefined =>
  up === undefined ? 'checking…' : up ? undefined : 'not running'

/**
 * The connections the menu lists: those that are up, or still being tried, first, then those that are down, greyed
 * out with why, each group in the order kept. The one in use stays checked when it's down, and says so.
 */
export function connectionChoices(
  connections: readonly StudioConnection[],
  up: Readonly<Record<string, boolean>>,
  inUse: string | undefined,
): ConnectionChoice[] {
  const rank = (c: StudioConnection) => (up[c.id] === false ? 1 : 0)
  return [...connections]
    .sort((a, b) => rank(a) - rank(b))
    .map(connection => {
      const why = notNow(up[connection.id])
      return {
        connection,
        detail: why ? `${DATABASE_NAMES[connection.type]} · ${why}` : DATABASE_NAMES[connection.type],
        disabled: why !== undefined,
        checked: connection.id === inUse,
      }
    })
}
