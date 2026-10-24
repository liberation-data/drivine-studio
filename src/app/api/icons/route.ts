import { body, failure, foreign, refuse } from '../../../server/http'
import { choose, iconsOf } from '../../../server/icons/labels'
import { isIcon } from '../../../server/icons/lucide'

/** The icon of each label asked for, and how it was found. */
export async function POST(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  const asked = (await body(request)) as { labels?: unknown } | undefined
  const labels = asked?.labels
  if (!Array.isArray(labels) || !labels.every(it => typeof it === 'string') || labels.length > 500) {
    return refuse(400, 'Give the labels, a list of at most 500.')
  }
  try {
    return Response.json(await iconsOf(labels))
  } catch (e) {
    return failure(e)
  }
}

/** Chooses a label's icon: a Lucide icon's name, null for none, or `forget` to have it found again. */
export async function PUT(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  const asked = (await body(request)) as { label?: unknown; icon?: unknown; forget?: unknown } | undefined
  if (!asked || typeof asked.label !== 'string' || asked.label === '') return refuse(400, 'Name the label.')
  const forget = asked.forget === true
  if (!forget && asked.icon !== null && !(typeof asked.icon === 'string' && isIcon(asked.icon))) {
    return refuse(400, 'Name one of Lucide\'s icons, or null for none.')
  }
  try {
    await choose(asked.label, forget ? undefined : (asked.icon as string | null))
    return Response.json((await iconsOf([asked.label]))[asked.label])
  } catch (e) {
    return failure(e)
  }
}
