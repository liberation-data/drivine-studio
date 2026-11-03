import { body, failure, foreign } from '../../../server/http'
import { addQuery, listQueries, validateQuery } from '../../../server/queries'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    return Response.json(await listQueries())
  } catch (e) {
    return failure(e)
  }
}

export async function POST(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    return Response.json(await addQuery(validateQuery(await body(request))), { status: 201 })
  } catch (e) {
    return failure(e)
  }
}
