import { findConnection } from '../../../../server/connections'
import { connect, runsCypher } from '../../../../server/datasources'
import { body, failure, foreign, refuse } from '../../../../server/http'

export const dynamic = 'force-dynamic'

/** The relationships among a result's nodes: `{ connection, ids }`. A read, as the Cypher window's own reads are. */
export async function POST(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    const given = (await body(request)) as { connection?: unknown; ids?: unknown } | undefined
    if (typeof given?.connection !== 'string' || !Array.isArray(given.ids) || !given.ids.every(id => typeof id === 'string')) {
      return refuse(400, 'Give a connection and the ids of the nodes to connect.')
    }
    if (given.ids.length > 5000) return refuse(400, 'Too many nodes to connect: at most 5,000.')
    const connection = await findConnection(given.connection)
    runsCypher(connection)
    return Response.json(await connect(connection, given.ids as string[]))
  } catch (e) {
    return failure(e)
  }
}
