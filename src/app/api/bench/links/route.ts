import { linkBench, unlinkBench } from '../../../../server/bench'
import { body, failure, foreign } from '../../../../server/http'

export const dynamic = 'force-dynamic'

/** Links a Graph Bench checkout: `{ path }`. */
export async function POST(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    return Response.json(await linkBench(((await body(request)) as { path?: unknown } | undefined)?.path))
  } catch (e) {
    return failure(e)
  }
}

/** Unlinks one: `{ path }`. Nothing on disk is touched. */
export async function DELETE(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    return Response.json(await unlinkBench(((await body(request)) as { path?: unknown } | undefined)?.path))
  } catch (e) {
    return failure(e)
  }
}
