import type { DatabaseType } from './database'

/*
 * A database to try the studio on, run in Docker on this machine: the command for one of each kind Drivine reads, from
 * the images and settings Drivine's own tests start (DrivineTestContainers), so one started this way is known to work.
 */

/** What Drivine's test containers are made with, used where the form leaves a field empty. */
export const TEST_USER = 'drivine'
export const TEST_PASSWORD = 'drivine-test'

/** What the command is built from: the connection's fields, as they stand in the form. */
export interface DockerDraft {
  type: DatabaseType
  host: string
  port: string
  user: string
  password: string
  database: string
}

export type DockerCommand =
  | {
      kind: 'command'
      command: string
      /** What to know before running it, or after. */
      note?: string
      /** The connection's fields the container answers to, for the ones the form leaves empty. */
      fill: Partial<Pick<DockerDraft, 'port' | 'user' | 'password' | 'database'>>
    }
  | { kind: 'none'; why: string }

const LOCAL = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]'])

const DEFAULT_PORTS: Record<DatabaseType, string> = {
  NEO4J: '7687', MEMGRAPH: '7687', NEPTUNE: '8182', FALKORDB: '6379', POSTGRES: '5432', ORACLE: '1521',
}

/** As the shell reads it: plain words as they are, anything else between single quotes. */
export const shellWord = (value: string) => (/^[\w.@:/=+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`)

const run = (name: string, port: string, inside: number, env: Record<string, string>, image: string) =>
  [
    // A short first line: the code block's Copy button sits at its end.
    `docker run -d --name ${name}`,
    `-p ${port}:${inside}`,
    ...Object.entries(env).map(([key, value]) => `-e ${shellWord(`${key}=${value}`)}`),
    image,
  ].join(' \\\n  ')

export function dockerCommand(draft: DockerDraft): DockerCommand {
  if (draft.type === 'NEPTUNE') return { kind: 'none', why: 'Neptune runs on AWS only: there is no image of it to run here.' }
  if (!LOCAL.has(draft.host.trim())) {
    return { kind: 'none', why: 'Docker runs a database on this machine. Set Host to localhost to run one here.' }
  }
  const port = draft.port.trim() || DEFAULT_PORTS[draft.type]
  const password = draft.password || TEST_PASSWORD
  const user = draft.user.trim() || TEST_USER
  switch (draft.type) {
    case 'NEO4J':
      return {
        kind: 'command',
        command: run('drivine-neo4j', port, 7687, { NEO4J_AUTH: `neo4j/${password}` }, 'neo4j:latest'),
        // Neo4j's first user is always neo4j, and it refuses a password shorter than eight characters.
        note: `Its user is neo4j${password.length < 8 ? ', and Neo4j refuses a password shorter than 8 characters' : ''}.`,
        fill: { port, user: 'neo4j', password },
      }
    case 'MEMGRAPH':
      return {
        kind: 'command',
        command: run('drivine-memgraph', port, 7687, {}, 'memgraph/memgraph:latest'),
        note: 'Memgraph starts with no users: leave User and Password empty.',
        fill: { port },
      }
    case 'FALKORDB':
      return {
        kind: 'command',
        // The release Drivine's tests pass on; Docker Hub's latest can be an older line's backport.
        command: run('drivine-falkordb', port, 6379, draft.password ? { REDIS_ARGS: `--requirepass ${draft.password}` } : {}, 'falkordb/falkordb:6.0.3'),
        fill: { port },
      }
    case 'POSTGRES': {
      const database = draft.database.trim() || 'drivine'
      return {
        kind: 'command',
        // pgvector's image: Postgres with the extension a vector search uses.
        command: run('drivine-postgres', port, 5432, { POSTGRES_USER: user, POSTGRES_PASSWORD: password, POSTGRES_DB: database }, 'pgvector/pgvector:pg16'),
        fill: { port, user, password, database },
      }
    }
    case 'ORACLE':
      return {
        kind: 'command',
        // An ordinary user of the pluggable database: the administrators' tablespace can't hold a graph's JSON column.
        command: run('drivine-oracle', port, 1521, { ORACLE_PASSWORD: password, APP_USER: user, APP_USER_PASSWORD: password }, 'gvenzl/oracle-free:23-faststart'),
        note: 'The image is a few GB, and the database takes a minute or two to open the first time.',
        fill: { port, user, password, database: 'FREEPDB1' },
      }
  }
}

type Fill = Extract<DockerCommand, { kind: 'command' }>['fill']

/**
 * What filling the form from the command would set: the container's settings for the fields still empty, and nothing
 * the form has. A password the studio already keeps (shown as Unchanged) is not empty, so the test password never
 * replaces it.
 */
export function fillFor(fill: Fill, draft: DockerDraft, passwordKept: boolean): Fill {
  return Object.fromEntries(
    Object.entries(fill).filter(([key, value]) => value && !draft[key as keyof Fill] && !(key === 'password' && passwordKept)),
  ) as Fill
}

/** The fields named as a person reads a list: "Port", "Port and User", "Port, User and Password". */
export const listed = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
