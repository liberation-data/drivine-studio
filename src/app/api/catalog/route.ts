import { failure, foreign } from '../../../server/http'
import { listModelPaths, readCatalog } from '../../../server/models'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    return Response.json(await readCatalog((await listModelPaths()).map(p => p.path)))
  } catch (e) {
    return failure(e)
  }
}
