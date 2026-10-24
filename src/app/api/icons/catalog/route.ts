import { failure, foreign } from '../../../../server/http'
import { catalog } from '../../../../server/icons/lucide'

export async function GET(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    return Response.json(catalog(), { headers: { 'cache-control': 'max-age=86400' } })
  } catch (e) {
    return failure(e)
  }
}
