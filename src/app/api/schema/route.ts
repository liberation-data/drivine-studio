import { findConnection } from '../../../server/connections'
import { failure, foreign, refuse } from '../../../server/http'
import { readSchema } from '../../../server/schema'

export const dynamic = 'force-dynamic'

/** What a connection's graph is made of, for the Cypher editor to complete: read only, and from a sample on a big one. */
export async function GET(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  const id = new URL(request.url).searchParams.get('connection')
  if (!id) return refuse(400, 'Name a connection.')
  try {
    const started = performance.now()
    const schema = await readSchema(await findConnection(id))
    return Response.json({ ...schema, milliseconds: Math.round(performance.now() - started) })
  } catch (e) {
    return failure(e)
  }
}
