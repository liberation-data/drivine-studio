import { startRun, validateRun } from '../../../../server/benchRun'
import { body, failure, foreign, refuse } from '../../../../server/http'

export const dynamic = 'force-dynamic'

/** Starts a bench of saved queries on connections: `{ name, connections, queries, warmup, runs }`. Only reads. */
export async function POST(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  // It keeps the databases busy for as long as it runs: only the studio's own pages may start one.
  if (request.headers.get('origin') === null) return refuse(403, 'The studio runs benches only for its own pages.')
  try {
    return Response.json(await startRun(validateRun(await body(request))))
  } catch (e) {
    return failure(e)
  }
}
