import { findConnection } from '../../../server/connections'
import { draftOf, freePort, start, status, stop } from '../../../server/docker'
import { body, failure, foreign, refuse } from '../../../server/http'

export const dynamic = 'force-dynamic'

/** How Docker and the container for a connection's type stand: `?type=POSTGRES&port=55432`. */
export async function GET(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    const query = new URL(request.url).searchParams
    // ?type=NEO4J&free: a port to start a new one on.
    if (query.has('free')) return Response.json({ port: await freePort(draftOf(Object.fromEntries(query)).type) })
    return Response.json(await status(draftOf(Object.fromEntries(query))))
  } catch (e) {
    return failure(e)
  }
}

/**
 * Starts, stops or removes the container for a connection's settings: `{ action, draft, id? }`. A saved connection's
 * id lets a start use the password the studio keeps, which the browser never has. Only the studio's own pages may ask:
 * a call that names no origin, as every page's does, is turned away here, though other routes take it.
 */
export async function POST(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  if (request.headers.get('origin') === null) return refuse(403, 'The studio starts containers only for its own pages.')
  try {
    const given = (await body(request)) as { action?: unknown; draft?: unknown; id?: unknown } | undefined
    const draft = draftOf(given?.draft)
    if (given?.action === 'start') {
      if (!draft.password && typeof given.id === 'string') {
        const kept = await findConnection(given.id)
        if (kept.password) draft.password = kept.password
      }
      return Response.json(await start(draft))
    }
    if (given?.action === 'stop' || given?.action === 'remove') return Response.json(await stop(draft, given.action === 'remove'))
    return refuse(400, 'Say whether to start, stop or remove the container.')
  } catch (e) {
    return failure(e)
  }
}
