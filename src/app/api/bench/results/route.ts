import { benchResults } from '../../../../server/bench'
import { failure, foreign } from '../../../../server/http'

export const dynamic = 'force-dynamic'

/** One set's results at a scale: `?source=published&set=&scale=1`. */
export async function GET(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    const query = new URL(request.url).searchParams
    return Response.json(await benchResults(query.get('source') ?? '', query.get('set') ?? '', Number(query.get('scale') ?? '1')))
  } catch (e) {
    return failure(e)
  }
}
