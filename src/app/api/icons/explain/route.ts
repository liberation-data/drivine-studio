import { body, failure, foreign, refuse } from '../../../../server/http'
import { explain, PICKS } from '../../../../server/icons/labels'

/** Each label's icon and why, with the model's nearest icons beside it: for Settings, and for trying a label there. */
export async function POST(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  const asked = (await body(request)) as { labels?: unknown; picks?: unknown } | undefined
  const labels = asked?.labels
  if (!Array.isArray(labels) || !labels.every(it => typeof it === 'string') || labels.length > 500) {
    return refuse(400, 'Give the labels, a list of at most 500.')
  }
  const picks = asked?.picks ?? PICKS
  if (typeof picks !== 'number' || !Number.isInteger(picks) || picks < 1 || picks > 20) return refuse(400, 'Ask for 1 to 20 picks.')
  try {
    return Response.json(await explain(labels, picks))
  } catch (e) {
    return failure(e)
  }
}
