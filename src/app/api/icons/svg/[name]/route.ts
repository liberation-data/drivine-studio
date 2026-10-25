import { foreign, refuse } from '../../../../../server/http'
import { svg } from '../../../../../server/icons/lucide'

/** An icon's SVG, by its name alone: a name that is not one of Lucide's icons is never read as a path. */
export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const refused = foreign(request)
  if (refused) return refused
  const drawn = svg((await params).name)
  if (!drawn) return refuse(404, 'There is no such icon.')
  // An icon never changes under its name in one version of the studio.
  return new Response(drawn, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' } })
}
