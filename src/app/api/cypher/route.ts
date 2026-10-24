import { findConnection } from '../../../server/connections'
import { DEFAULT_LIMIT, MAX_LIMIT, run } from '../../../server/datasources'
import { body, failure, foreign, refuse } from '../../../server/http'

export async function POST(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  const asked = (await body(request)) as Record<string, unknown> | undefined
  if (!asked || typeof asked.connection !== 'string' || typeof asked.statement !== 'string') {
    return refuse(400, 'Name a connection and give a statement.')
  }
  const parameters = asked.parameters ?? {}
  if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
    return refuse(400, 'The parameters are a JSON object, of each name and its value.')
  }
  const limit = asked.limit ?? DEFAULT_LIMIT
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return refuse(400, `The limit is a whole number from 1 to ${MAX_LIMIT}.`)
  }
  try {
    const connection = await findConnection(asked.connection)
    return Response.json(await run(connection, asked.statement, parameters as Record<string, unknown>, limit))
  } catch (e) {
    return failure(e)
  }
}
