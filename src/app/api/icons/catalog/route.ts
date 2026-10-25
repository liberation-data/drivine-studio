import { failure, foreign } from '../../../../server/http'
import { catalog } from '../../../../server/icons/lucide'

/** Every Lucide icon's name and tags, for the icon picker to search. */
export async function GET(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    return Response.json(catalog(), { headers: { 'cache-control': 'max-age=86400' } })
  } catch (e) {
    return failure(e)
  }
}
