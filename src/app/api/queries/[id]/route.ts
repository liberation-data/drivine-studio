import { body, failure, foreign } from '../../../../server/http'
import { removeQuery, updateQuery, validateQuery } from '../../../../server/queries'

type Context = { params: Promise<{ id: string }> }

export async function PUT(request: Request, { params }: Context) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    const { id } = await params
    return Response.json(await updateQuery(id, validateQuery(await body(request))))
  } catch (e) {
    return failure(e)
  }
}

export async function DELETE(request: Request, { params }: Context) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    const { id } = await params
    await removeQuery(id)
    return Response.json(null)
  } catch (e) {
    return failure(e)
  }
}
