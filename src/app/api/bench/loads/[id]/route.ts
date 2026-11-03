import { loadJob } from '../../../../../server/benchLoad'
import { failure, foreign, refuse } from '../../../../../server/http'

export const dynamic = 'force-dynamic'

/** How a load of Graph Bench's data is going. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    const found = loadJob((await params).id)
    return found ? Response.json(found) : refuse(404, 'There is no such load.')
  } catch (e) {
    return failure(e)
  }
}
