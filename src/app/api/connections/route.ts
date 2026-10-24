import { addConnection, listConnections, toPublic, validate } from '../../../server/connections'
import { body, failure, foreign } from '../../../server/http'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    return Response.json((await listConnections()).map(toPublic))
  } catch (e) {
    return failure(e)
  }
}

export async function POST(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    return Response.json(toPublic(await addConnection(validate(await body(request)))), { status: 201 })
  } catch (e) {
    return failure(e)
  }
}
