import { loadedInto, startLoad, validateLoad } from '../../../../server/benchLoad'
import { body, failure, foreign, refuse } from '../../../../server/http'

export const dynamic = 'force-dynamic'

/** What Graph Bench's data has been loaded into, by connection id: its scale, its load times, and when. */
export async function GET(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    return Response.json(await loadedInto())
  } catch (e) {
    return failure(e)
  }
}

/** Loads Graph Bench's dataset into connections that allow writes, one after another: `{ connections, scale }`. */
export async function POST(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  // It writes, and for a long while: only the studio's own pages may start one.
  if (request.headers.get('origin') === null) return refuse(403, 'The studio loads data only for its own pages.')
  try {
    return Response.json(await startLoad(validateLoad(await body(request))))
  } catch (e) {
    return failure(e)
  }
}
