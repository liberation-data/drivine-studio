import type { Query } from '../../../studio/api'
import { findConnection } from '../../../server/connections'
import { body, failure, foreign, refuse } from '../../../server/http'
import { load, MAX_ROOTS } from '../../../server/loads'
import { listModelPaths, readCatalog } from '../../../server/models'

export async function POST(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  const asked = (await body(request)) as { connection?: unknown; query?: Partial<Query> } | undefined
  const query = asked?.query
  if (!asked || typeof asked.connection !== 'string' || !query || typeof query.type !== 'string') {
    return refuse(400, 'Name a connection, and the view or fragment to load.')
  }
  if (!Array.isArray(query.where ?? []) || !Array.isArray(query.orderBy ?? [])) {
    return refuse(400, 'The conditions and the order are lists.')
  }
  const limit = query.limit
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_ROOTS)) {
    return refuse(400, `The limit is a whole number from 1 to ${MAX_ROOTS}.`)
  }
  try {
    const connection = await findConnection(asked.connection)
    // Read afresh for each load, so a model file the build has just written is the one loaded.
    const catalog = await readCatalog((await listModelPaths()).map(p => p.path))
    return Response.json(
      await load(connection, catalog, { type: query.type, where: query.where ?? [], orderBy: query.orderBy ?? [], ...(limit ? { limit } : {}) }),
    )
  } catch (e) {
    return failure(e)
  }
}
