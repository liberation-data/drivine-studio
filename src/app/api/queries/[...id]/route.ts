import { body, failure, foreign } from '../../../../server/http'
import { removeQuery, updateQuery, validateQuery } from '../../../../server/queries'

// A query in a folder is at its path: /api/queries/Films/Keanu.cypher.
type Context = { params: Promise<{ id: string[] }> }

// Next gives each part decoded already.
const idOf = async ({ params }: Context) => (await params).id.join('/')

export async function PUT(request: Request, context: Context) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    const id = await idOf(context)
    return Response.json(await updateQuery(id, validateQuery(await body(request))))
  } catch (e) {
    return failure(e)
  }
}

export async function DELETE(request: Request, context: Context) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    const id = await idOf(context)
    await removeQuery(id)
    return Response.json(null)
  } catch (e) {
    return failure(e)
  }
}
