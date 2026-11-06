import { DATABASE_NAMES } from './database'
import type { DatabaseType, StudioConnection } from './database'

/** A connection as the menu bar's connection menu lists it. */
export interface ConnectionChoice {
  readonly connection: StudioConnection
  /** The database, and why it can't be chosen when it can't. */
  readonly detail: string
  readonly disabled: boolean
  readonly checked: boolean
}

/**
 * What a connection that doesn't answer is. A SQLite file is not a server, so it isn't "not running": its test fails
 * where there is no file at the path, no graph in it, or it is not SQLite's, which the lamp, knowing only up or down,
 * says at once.
 */
export const down = (type: DatabaseType): string => (type === 'SQLITE' ? 'can’t be read' : 'not running')

/** Why a connection can't be chosen now, as Bench's pickers say it, or undefined when it can. */
export const notNow = (up: boolean | undefined, type: DatabaseType): string | undefined =>
  up === undefined ? 'checking…' : up ? undefined : down(type)

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
      const why = notNow(up[connection.id], connection.type)
      return {
        connection,
        detail: why ? `${DATABASE_NAMES[connection.type]} · ${why}` : DATABASE_NAMES[connection.type],
        disabled: why !== undefined,
        checked: connection.id === inUse,
      }
    })
}
