import { ConnectionError } from './connections'
import type { Env } from './connections'
import { READS_ONLY, StatementError } from './datasources'

/**
 * Refuses a request that does not come from the studio's own pages. The studio holds connections and their
 * passwords, and runs Cypher on them, on a port any page in the browser can reach. A page of another site names its
 * origin, which is not the studio's. A page that has had its own name pointed at this machine, to read what the studio answers as though it
 * were the studio, names its own host: the studio answers only to the hosts it is served on, localhost unless
 * DRIVINE_STUDIO_ALLOWED_HOSTS names others, as a container behind a name of its own needs. Every call comes here first.
 */
export function foreign(request: Request, env: Env = process.env): Response | undefined {
  const host = request.headers.get('host') ?? ''
  if (!allowedHosts(env).includes(hostname(host))) {
    return refuse(403, `The studio answers to ${allowedHosts(env).join(', ')}, not ${host || 'no host'}. DRIVINE_STUDIO_ALLOWED_HOSTS names others.`)
  }
  const origin = request.headers.get('origin')
  // A browser names the origin of every cross-site call that could change something; what names none is not a page.
  if (origin === null) return undefined
  let from: string
  try {
    from = new URL(origin).host
  } catch {
    return refuse(403, 'The studio answers only its own pages.')
  }
  return from === host ? undefined : refuse(403, 'The studio answers only its own pages.')
}

const allowedHosts = (env: Env): string[] =>
  env.DRIVINE_STUDIO_ALLOWED_HOSTS
    ? env.DRIVINE_STUDIO_ALLOWED_HOSTS.split(',').map(h => h.trim().toLowerCase()).filter(h => h !== '')
    : ['localhost', '127.0.0.1', '[::1]']

/** A Host header without its port. */
const hostname = (host: string): string => {
  const lower = host.toLowerCase()
  if (lower.startsWith('[')) return lower.slice(0, lower.indexOf(']') + 1)
  return lower.split(':')[0] ?? ''
}

export const refuse = (status: number, error: string): Response => Response.json({ error }, { status })

/** The request's JSON body, or undefined when it has none or it is not JSON. */
export async function body(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

/**
 * A failure as the browser app shows it. What the person can fix is a 400: a connection's settings, or a statement
 * the database turned down, as Neo4j's and Memgraph's client errors say. Anything else is the database or the
 * network, as a 502, with what it said.
 */
export function failure(e: unknown): Response {
  if (e instanceof ConnectionError || e instanceof StatementError) return refuse(400, e.message)
  const code = (e as { code?: unknown } | null)?.code
  const reason = e instanceof Error ? e.message || (typeof code === 'string' ? code : '') || e.name : String(e)
  // Memgraph gives every client error one code, so its refusal to write is known by what it says.
  if (code === 'Neo.ClientError.Statement.AccessMode' || (code === MEMGRAPH_CLIENT_ERROR && /^Accessor type READ /.test(reason))) {
    return refuse(400, `${READS_ONLY} ${reason}`)
  }
  if (typeof code === 'string' && /^(Neo|Memgraph)\.ClientError\./.test(code)) return refuse(400, reason)
  return refuse(502, reason)
}

const MEMGRAPH_CLIENT_ERROR = 'Memgraph.ClientError.MemgraphError.MemgraphError'
