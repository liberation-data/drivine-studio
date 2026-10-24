import { findConnection } from '../../../../../server/connections'
import { check } from '../../../../../server/datasources'
import { failure, foreign } from '../../../../../server/http'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    const { id } = await params
    return Response.json(await check(await findConnection(id)))
  } catch (e) {
    return failure(e)
  }
}
