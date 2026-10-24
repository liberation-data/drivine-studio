import { removeConnection, toPublic, updateConnection, validate } from '../../../../server/connections'
import { forget } from '../../../../server/datasources'
import { body, failure, foreign } from '../../../../server/http'

type Context = { params: Promise<{ id: string }> }

export async function PUT(request: Request, { params }: Context) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    const { id } = await params
    return Response.json(toPublic(await updateConnection(id, validate(await body(request)))))
  } catch (e) {
    return failure(e)
  }
}

export async function DELETE(request: Request, { params }: Context) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    const { id } = await params
    await removeConnection(id)
    await forget(id)
    return Response.json(null)
  } catch (e) {
    return failure(e)
  }
}
