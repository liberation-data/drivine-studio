import { benchSets, linkedBenches } from '../../../server/bench'
import { failure, foreign } from '../../../server/http'

export const dynamic = 'force-dynamic'

/** The sets of Graph Bench results there are, and the checkouts linked. */
export async function GET(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    return Response.json({ sets: await benchSets(), links: await linkedBenches() })
  } catch (e) {
    return failure(e)
  }
}
