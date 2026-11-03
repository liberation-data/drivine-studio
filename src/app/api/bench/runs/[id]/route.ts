import { job } from '../../../../../server/benchRun'
import { failure, foreign, refuse } from '../../../../../server/http'

export const dynamic = 'force-dynamic'

/** How a bench run is going. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    const found = job((await params).id)
    return found ? Response.json(found) : refuse(404, 'There is no such bench run.')
  } catch (e) {
    return failure(e)
  }
}
