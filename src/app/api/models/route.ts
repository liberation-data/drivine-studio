import { body, failure, foreign } from '../../../server/http'
import { addModelPath, listModelPaths, removeModelPath } from '../../../server/models'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    return Response.json(await listModelPaths())
  } catch (e) {
    return failure(e)
  }
}

export async function POST(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    return Response.json(await addModelPath(((await body(request)) as { path?: unknown } | undefined)?.path))
  } catch (e) {
    return failure(e)
  }
}

export async function DELETE(request: Request) {
  const refused = foreign(request)
  if (refused) return refused
  try {
    return Response.json(await removeModelPath(((await body(request)) as { path?: unknown } | undefined)?.path))
  } catch (e) {
    return failure(e)
  }
}
